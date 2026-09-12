/**
 * 清单下载器:负责把远程 rule-provider 文本取回来。
 *
 * 两个刻意的设计:
 * 1. **永远指定 dispatcher**,不裸用全局 fetch —— 此刻全局 dispatcher 正是本插件
 *    刚装上去的本地分流代理,用它去拉清单会先绕一圈自己的规则表(清单还没装完,
 *    规则未知),轻则多一跳,重则把「拉清单」误判进代理路径。
 * 2. **直连优先,失败再走上游代理** —— 清单多半托管在 jsDelivr / GitHub 这类
 *    境外 CDN 上:国内多数网络直连 jsDelivr 可用(实测 4MB 约 3.4s),真拉不动时
 *    再借上游代理这条已经配好的通道,保证首启即能用。
 */
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { loadHostModule, type HostUndiciModule } from './host-modules.js'

/** 最小日志接口(与 index.ts 的日志器一致,便于测试时替换)。 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

export interface TextFetcher {
  /** 取回文本;viaProxy=true 时强制走上游代理。 */
  fetchText(url: string, viaProxy: boolean): Promise<string>
  close(): Promise<void>
}

const USER_AGENT = 'dsh-proxy-router/0.1 (+https://github.com/yangzhe1991/dsh-proxy-router)'
/** 清单体积上限:防止配错 URL 把几百 MB 的东西读进内存。 */
const MAX_BYTES = 32 * 1024 * 1024

export interface TextFetcherOptions {
  /** 现读上游代理 URL(设置页改完立刻生效);返回 null 表示只能直连拉取。 */
  getUpstream: () => string | null
  timeoutMs: number
  log: Logger
}

/** 用 node 内置 http(s) 直连取文本(不经过任何代理),跟随最多 5 次跳转。 */
async function plainGet(url: string, timeoutMs: number, redirects = 0): Promise<string> {
  if (redirects > 5) throw new Error('too many redirects')
  return await new Promise<string>((resolve, reject) => {
    const isHttps = url.startsWith('https:')
    const request = (isHttps ? httpsGet : httpGet)(
      url,
      { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' } },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location !== undefined && redirects < 5) {
          res.resume()
          resolve(plainGet(new URL(location, url).href, timeoutMs, redirects + 1))
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            request.destroy(new Error(`response exceeds ${MAX_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

/**
 * 创建下载器。宿主 undici 可用时优先用它(能显式指定 dispatcher、支持走代理),
 * 否则退化成内置 https 直连。
 */
export async function createTextFetcher(options: TextFetcherOptions): Promise<TextFetcher> {
  const hostUndici = await loadHostModule<HostUndiciModule>('undici')
  const undici = hostUndici?.mod
  if (undici === undefined) {
    options.log.debug('未解析到宿主 undici,清单下载退化为 node:https 直连')
    return {
      fetchText: async (url, viaProxy) => {
        if (viaProxy) throw new Error('upstream fetch unavailable without undici')
        return await plainGet(url, options.timeoutMs)
      },
      close: async () => {},
    }
  }

  const direct = new undici.Agent({ connect: { timeout: options.timeoutMs } })
  // 上游可热变:URL 没变就复用同一个 ProxyAgent,变了才重建(并关掉旧的)
  let proxiedUrl: string | null = null
  let proxied: { close(): Promise<void> } | null = null
  const upstreamDispatcher = (): { close(): Promise<void> } | null => {
    const url = options.getUpstream()
    if (url === null) return null
    if (url !== proxiedUrl || proxied === null) {
      void proxied?.close().catch(() => {})
      proxied = new undici.ProxyAgent({ uri: url, connect: { timeout: options.timeoutMs } })
      proxiedUrl = url
    }
    return proxied
  }

  return {
    fetchText: async (url, viaProxy) => {
      const dispatcher = viaProxy ? upstreamDispatcher() : direct
      if (dispatcher === null) throw new Error('upstream fetch unavailable without upstream')
      const response = await undici.fetch(url, {
        dispatcher,
        redirect: 'follow',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' },
      })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MAX_BYTES) throw new Error(`response exceeds ${MAX_BYTES} bytes`)
      return text
    },
    close: async () => {
      await direct.close().catch(() => {})
      if (proxied !== null) await proxied.close().catch(() => {})
    },
  }
}
