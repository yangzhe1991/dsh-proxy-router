/**
 * 本地分流代理:绑在 127.0.0.1 上的一个小 HTTP 代理,DSH 的所有出网都先到它,
 * 由它按规则决定「直连目标」还是「转发给上游代理」。
 *
 * 为什么不让宿主直接按 no_proxy 分流:no_proxy 是一张静态后缀表,只能塞进环境变量
 * (子进程单个环境变量上限 128KB,几万条清单根本放不下)。改成本地代理后,
 * 规则表住在进程内存里,清单随便大;而且宿主只需要把代理地址指向本机,
 * 主进程 fetch、web_fetch、bash 子进程(curl/git/npm)自动走同一条路,口径统一。
 *
 * 协议面(够用即止,不做 TLS 中间人):
 *   - https 走 CONNECT 隧道:只看 CONNECT 里的 host:port 就够做域名分流,
 *     隧道建好后纯字节转发,不解析、不解密。
 *   - http 走绝对形式请求行(标准代理协议),转发时按目标改写请求行。
 *   - 两者都可选「失败回退直连」:上游挂了不至于把规则命中的站点一起拖死。
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { Route } from './rules.js'
import type { Logger } from './fetcher.js'

/** 一次分流决策的结果(reason 只用于日志与调试接口)。 */
export interface RouteDecision {
  route: Route
  reason: string
}

/** 上游代理的连接信息。 */
export interface UpstreamTarget {
  host: string
  port: number
  /** 形如 `Basic xxx`,来自代理 URL 里的 user:pass(可选)。 */
  authHeader?: string
}

export interface RouterServerOptions {
  decide(host: string, port: string): RouteDecision
  /**
   * 上游代理与下面几个开关都走 getter 而不是快照:设置页改完要立刻生效,
   * 不能要求重启宿主。每次请求(每次建隧道)现读,天然就是热更新。
   */
  getUpstream(): UpstreamTarget | null
  getConnectTimeoutMs(): number
  getDebug(): boolean
  log: Logger
  /** 代理路径失败时是否回退直连(客户端还没收到任何字节时才可能回退)。 */
  getFallbackDirect(): boolean
  /** 插件自己的调试接口;返回 true 表示已应答,不再当作代理请求。 */
  handleControl?: (
    req: IncomingMessage,
    res: ServerResponse,
    local: { host: string; port: number },
  ) => boolean
}

export interface RouterStats {
  total: number
  direct: number
  proxied: number
  failed: number
  fallback: number
}

export interface RouterServer {
  listen(host: string, port: number): Promise<{ host: string; port: number; ephemeral: boolean }>
  close(): Promise<void>
  stats(): RouterStats
}

/** 目标主机端口。 */
interface Authority {
  host: string
  port: string
}

/** 解析 `host:port`(CONNECT 的目标),IPv6 字面量带方括号。 */
function parseAuthority(raw: string): Authority | null {
  const value = raw.trim()
  if (value === '') return null
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value)
  if (bracketed) return { host: bracketed[1]!, port: bracketed[2]! }
  const at = value.lastIndexOf(':')
  if (at === -1) return { host: value, port: '443' }
  const host = value.slice(0, at)
  const port = value.slice(at + 1)
  if (!/^\d+$/.test(port)) return { host: value, port: '443' }
  return { host, port }
}

/** 从普通请求里得到目标:绝对形式请求行优先,否则用 Host 头。 */
function resolveRequestTarget(req: IncomingMessage): { authority: Authority; absoluteUrl: URL | null; path: string } | null {
  const raw = req.url ?? ''
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      return {
        authority: { host: url.hostname, port: url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80' },
        absoluteUrl: url,
        path: `${url.pathname}${url.search}`,
      }
    } catch {
      return null
    }
  }
  const hostHeader = req.headers.host
  if (hostHeader === undefined || hostHeader === '') return null
  const authority = parseAuthority(hostHeader)
  if (authority === null) return null
  return { authority, absoluteUrl: null, path: raw === '' ? '/' : raw }
}

/** 去掉只对「本机这一段」有意义的逐跳头,避免原样转给目标服务器/上游代理。 */
function sanitizeHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'proxy-connection' || lower === 'proxy-authorization') continue
    if (lower === 'connection') continue
    headers[name] = value
  }
  return headers
}

/** 把响应头里逐跳的部分摘掉,其余原样带给客户端。 */
function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'connection' || lower === 'proxy-connection' || lower === 'keep-alive' || lower === 'upgrade') continue
    out[name] = value
  }
  return out
}

export function createRouterServer(options: RouterServerOptions): RouterServer {
  const stats: RouterStats = { total: 0, direct: 0, proxied: 0, failed: 0, fallback: 0 }
  const sockets = new Set<Socket>()
  let local: { host: string; port: number } = { host: '127.0.0.1', port: 0 }

  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  /** 两端对接:互推数据,任一端出错/关闭就一起收掉,避免半开连接堆积。 */
  const bridge = (client: Socket, target: Socket): void => {
    client.setNoDelay(true)
    target.setNoDelay(true)
    client.pipe(target)
    target.pipe(client)
    client.on('end', () => target.end())
    target.on('end', () => client.end())
    const cleanup = (): void => {
      client.destroy()
      target.destroy()
    }
    client.on('close', cleanup)
    target.on('close', cleanup)
    client.on('error', cleanup)
    target.on('error', cleanup)
  }

  const respondPlain = (socket: Socket, status: number, message: string): void => {
    if (socket.destroyed) return
    socket.end(`HTTP/1.1 ${status} ${message}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  }

  /**
   * 建立到目标的 TCP 连接并回调;超时/出错时回调失败。
   * 这里刻意用 `net.connect`,不经过任何 HTTP 栈:直连路径必须完全绕开代理环境。
   */
  const openTunnel = (
    host: string,
    port: number,
    onReady: (socket: Socket) => void,
    onError: (error: Error) => void,
  ): void => {
    const socket = track(netConnect({ host, port }))
    let settled = false
    const timeoutMs = options.getConnectTimeoutMs()
    socket.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      socket.destroy()
      onError(new Error(`连接 ${host}:${port} 超时(${timeoutMs}ms)`))
    })
    socket.once('connect', () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      onReady(socket)
    })
    socket.once('error', (error: Error) => {
      if (settled) return
      settled = true
      onError(error)
    })
  }

  /**
   * 经上游代理建立隧道:发 CONNECT 并等应答头。
   * 上游除了标准头之外的字节都属于隧道数据,必须原样转给客户端(否则会吞掉 TLS 首包)。
   */
  const openUpstreamTunnel = (
    authority: Authority,
    /** ready 回调带上「上游应答头之后残留的隧道字节」,必须转给客户端。 */
    onReady: (socket: Socket, rest: Buffer) => void,
    onError: (error: Error) => void,
  ): void => {
    const upstream = options.getUpstream()
    if (upstream === null) {
      onError(new Error('未配置上游代理'))
      return
    }
    openTunnel(
      upstream.host,
      upstream.port,
      (socket) => {
        const target = `${authority.host}:${authority.port}`
        const lines = [
          `CONNECT ${target} HTTP/1.1`,
          `Host: ${target}`,
          ...(upstream.authHeader === undefined ? [] : [`Proxy-Authorization: ${upstream.authHeader}`]),
          '',
          '',
        ]
        socket.write(lines.join('\r\n'))
        let buffer = Buffer.alloc(0)
        const onData = (chunk: Buffer): void => {
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.length > 16384 && buffer.indexOf('\r\n\r\n') === -1) {
            socket.off('data', onData)
            socket.destroy()
            onError(new Error('上游 CONNECT 应答过大'))
            return
          }
          const end = buffer.indexOf('\r\n\r\n')
          if (end === -1) return
          socket.off('data', onData)
          socket.pause()
          const headerText = buffer.subarray(0, end).toString('latin1')
          const rest = buffer.subarray(end + 4)
          const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(headerText)?.[1] ?? '0')
          if (status !== 200) {
            socket.destroy()
            onError(new Error(`上游 CONNECT 返回 ${status || '无效应答'}`))
            return
          }
          onReady(socket, rest)
        }
        socket.on('data', onData)
      },
      onError,
    )
  }

  /** CONNECT 处理:先决策,再选直连或上游隧道,成功后才给客户端回 200。 */
  const handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const authority = parseAuthority(req.url ?? '')
    if (authority === null) {
      respondPlain(clientSocket, 400, 'Bad Request')
      return
    }
    stats.total++
    const decision = options.decide(authority.host, authority.port)
    if (options.getDebug()) {
      options.log.debug(`CONNECT ${authority.host}:${authority.port} → ${decision.route} (${decision.reason})`)
    }

    const useUpstream = decision.route === 'proxy' && options.getUpstream() !== null
    const finishDirect = (): void => {
      stats.direct++
      openTunnel(
        authority.host,
        Number(authority.port),
        (target) => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) target.write(head)
          bridge(clientSocket, target)
        },
        (error) => {
          stats.failed++
          options.log.warn(`直连失败 ${authority.host}:${authority.port}: ${error.message}`)
          respondPlain(clientSocket, 502, 'Bad Gateway')
        },
      )
    }

    if (!useUpstream) {
      finishDirect()
      return
    }

    openUpstreamTunnel(
      authority,
      (upstreamSocket, rest) => {
        stats.proxied++
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (rest.length > 0) clientSocket.write(rest)
        if (head.length > 0) upstreamSocket.write(head)
        bridge(clientSocket, upstreamSocket)
      },
      (error) => {
        options.log.warn(`上游代理失败 ${authority.host}:${authority.port}: ${error.message}`)
        if (options.getFallbackDirect()) {
          stats.fallback++
          options.log.warn(`回退直连 ${authority.host}:${authority.port}`)
          finishDirect()
          return
        }
        stats.failed++
        respondPlain(clientSocket, 502, 'Bad Gateway')
      },
    )
  }

  /** 普通 http 请求:直连时把请求行改写成 origin-form,走上游时保持绝对形式。 */
  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (options.handleControl?.(req, res, local) === true) return
    const resolved = resolveRequestTarget(req)
    if (resolved === null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end('proxy-router: 无法从请求行或 Host 头确定目标\n')
      return
    }
    const { authority, absoluteUrl, path } = resolved
    stats.total++
    const decision = options.decide(authority.host, authority.port)
    if (options.getDebug()) {
      options.log.debug(`${req.method ?? 'GET'} ${authority.host}:${authority.port}${path} → ${decision.route} (${decision.reason})`)
    }

    const sendDirect = (): void => {
      stats.direct++
      const headers = sanitizeHeaders(req)
      const out = httpRequest({
        host: authority.host,
        port: Number(authority.port),
        method: req.method,
        path,
        headers,
        setHost: false,
      })
      guardConnectPhase(out)
      pipePlain(req, res, out, `直连 ${authority.host}:${authority.port}`)
    }

    if (decision.route !== 'proxy' || options.getUpstream() === null) {
      sendDirect()
      return
    }

    stats.proxied++
    const upstream = options.getUpstream()
    if (upstream === null) {
      // 规则说走代理但上游此刻没配(设置页刚清空):退回直连,比 502 更符合直觉
      sendDirect()
      return
    }
    const headers = sanitizeHeaders(req)
    if (upstream.authHeader !== undefined) headers['proxy-authorization'] = upstream.authHeader
    const out = httpRequest({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      // 上游同样按标准代理协议接收:请求行必须是绝对形式
      path: absoluteUrl !== null ? absoluteUrl.href : `http://${authority.host}:${authority.port}${path}`,
      headers,
      setHost: false,
    })
    guardConnectPhase(out)
    pipePlain(req, res, out, `上游 ${upstream.host}:${upstream.port}`)
  }

  /**
   * 只给「连接建立阶段」加超时,建立之后立刻撤掉。
   *
   * 不能用 http.request 的 `timeout` 选项:那是 socket 空闲超时,会覆盖整个响应周期,
   * 长连接/SSE(LLM 流式输出、事件流)只要中间安静一会儿就会被误杀 ——
   * 这是分流代理最容易踩的坑,所以这里用一次性定时器手动看门。
   */
  const guardConnectPhase = (out: ReturnType<typeof httpRequest>): void => {
    const timeoutMs = options.getConnectTimeoutMs()
    const guard = setTimeout(() => {
      out.destroy(new Error(`连接超时(${timeoutMs}ms)`))
    }, timeoutMs)
    const clear = (): void => clearTimeout(guard)
    out.on('response', clear)
    out.on('error', clear)
    out.on('close', clear)
  }

  /** 请求/响应的接线,以及错误时给客户端一个明确的 502。 */
  const pipePlain = (
    req: IncomingMessage,
    res: ServerResponse,
    out: ReturnType<typeof httpRequest>,
    label: string,
  ): void => {
    out.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, sanitizeResponseHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
    })
    out.on('error', (error: Error) => {
      stats.failed++
      options.log.warn(`${label} 失败: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        res.end(`proxy-router: ${label} 失败: ${error.message}\n`)
      } else {
        res.destroy()
      }
    })
    req.on('aborted', () => out.destroy())
    res.on('close', () => {
      if (!res.writableEnded) out.destroy()
    })
    req.pipe(out)
  }

  /**
   * 明文 WebSocket/Upgrade:代理语义下要把原始请求行与头原样转给目标,
   * 所以这里手工重新序列化(绝对形式给上游,origin-form 给目标)。
   */
  const handleUpgrade = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const resolved = resolveRequestTarget(req)
    if (resolved === null) {
      respondPlain(clientSocket, 400, 'Bad Request')
      return
    }
    const { authority, absoluteUrl, path } = resolved
    stats.total++
    const decision = options.decide(authority.host, authority.port)
    if (options.getDebug()) {
      options.log.debug(`UPGRADE ${authority.host}:${authority.port}${path} → ${decision.route} (${decision.reason})`)
    }
    const useUpstream = decision.route === 'proxy' && options.getUpstream() !== null
    const upstreamNow = options.getUpstream()
    const hop = useUpstream && upstreamNow !== null ? upstreamNow : { host: authority.host, port: Number(authority.port) }
    const requestTarget = useUpstream
      ? absoluteUrl !== null
        ? absoluteUrl.href
        : `http://${authority.host}:${authority.port}${path}`
      : path
    const lines = [`${req.method ?? 'GET'} ${requestTarget} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!
      const lower = name.toLowerCase()
      if (lower === 'proxy-connection' || lower === 'proxy-authorization') continue
      lines.push(`${name}: ${req.rawHeaders[i + 1]!}`)
    }
    if (useUpstream && upstreamNow !== null && upstreamNow.authHeader !== undefined) {
      lines.push(`Proxy-Authorization: ${upstreamNow.authHeader}`)
    }
    const payload = `${lines.join('\r\n')}\r\n\r\n`
    if (useUpstream) stats.proxied++
    else stats.direct++
    openTunnel(
      hop.host,
      hop.port,
      (target) => {
        target.write(payload)
        if (head.length > 0) target.write(head)
        bridge(clientSocket, target)
      },
      (error) => {
        stats.failed++
        options.log.warn(`Upgrade 失败 ${authority.host}:${authority.port}: ${error.message}`)
        respondPlain(clientSocket, 502, 'Bad Gateway')
      },
    )
  }

  const server: Server = createServer()
  server.on('connect', handleConnect)
  server.on('request', handleRequest)
  server.on('upgrade', handleUpgrade)
  server.on('connection', (socket) => {
    track(socket)
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  // 代理服务器不做请求体大小限制,超时交给各自的连接超时
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  return {
    async listen(host, port) {
      const attempt = (candidatePort: number): Promise<number> =>
        new Promise<number>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            const address = server.address()
            resolve(address !== null && typeof address === 'object' ? address.port : candidatePort)
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(candidatePort, host)
        })
      let ephemeral = false
      let bound: number
      try {
        bound = await attempt(port)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error
        // 配置端口被占用时退到随机端口:分流不能因为端口冲突就整个失效
        options.log.warn(`本地端口 ${port} 被占用,改用随机端口`)
        bound = await attempt(0)
        ephemeral = true
      }
      local = { host, port: bound }
      return { host, port: bound, ephemeral }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    stats() {
      return { ...stats }
    },
  }
}
