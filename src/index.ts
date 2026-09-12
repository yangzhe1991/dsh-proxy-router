/**
 * @yangzhe1991/dsh-proxy-router 插件,node 半(宿主侧)。
 *
 * 装配顺序:
 *   1. 归一化组合配置,并注册设置命名空间 `proxy-router`(设置页可编辑,热生效)
 *   2. 建规则表:内置种子 → 本地规则文件(热加载)→ 远程被墙清单缓存(后台刷新)
 *   3. 起本地分流代理(127.0.0.1,规则命中 proxy 的目标转发给上游,其余直连)
 *   4. 把宿主代理策略指向本地分流代理(undici 全局 dispatcher + no_proxy)
 *   5. 在宿主的 Web 服务器上挂一个只读状态路由,供设置页那张卡片显示运行态
 *
 * 热应用:设置页每次保存都会回调 onChange → 重新解析运行时配置并核对差异。
 * 上游/默认走向/超时/回退/调试开关都是「现读」的(router、fetcher 拿的是 getter),
 * 所以改完立刻生效;只有监听地址与清单相关两项需要重建对应部件。
 *
 * 失败降级原则:任何一步抛错都只记日志,不向上抛 —— 插件最坏的结果是「不生效」,
 * 绝不能因为分流插件的配置问题把宿主启动搞挂。apply 本身不返回 promise,
 * 异步初始化在内部 catch,避免影响 Loader 对该插件行的状态判定。
 */
import { RuleStore, parseRules } from './rules.js'
import { SEED_BLOCKED_DOMAINS } from './seed.js'
import { RuleLoader } from './lists.js'
import { createRouterServer, type RouterServer } from './router.js'
import { createTextFetcher, type Logger, type TextFetcher } from './fetcher.js'
import { installRouterPolicy, type InstalledPolicy } from './host-policy.js'
import {
  compositionExtrasFrom,
  resolveRuntimeConfig,
  settingsValueFromComposition,
  type CompositionExtras,
  type ResolvedConfig,
  type SettingsValue,
} from './config.js'
import { installSettingsSection, PROXY_ROUTER_NAMESPACE, type SettingsInstallation } from './settings.js'

/** 插件 apply 收到的宿主上下文里,本插件用到的部分(cordis Context 结构兼容)。 */
export interface HostContextLike {
  /** 读取 cordis 服务(缺服务时返回 undefined,不抛错)。 */
  get?(name: string): unknown
  /** 注册作用域 effect;回调可返回 disposer,插件卸载时执行。 */
  effect?(fn: () => void | (() => void), name?: string): unknown
  /** 服务可用时执行回调(服务缺失时回调不执行,不阻塞插件)。 */
  inject?(deps: readonly string[], callback: (ctx: HostContextLike) => unknown): unknown
}

/** 控制接口前缀:只有目标指向本机代理自己的请求才走它,其余一律当代理请求处理。 */
const CONTROL_PREFIX = '/__proxy-router/'
/** Web 服务器上的只读状态路由(设置页那张卡片读它;同源,无需 CORS)。 */
export const STATUS_ROUTE_PATH = '/dsh-proxy-router/status'

interface ControlRequest {
  method?: string
  url?: string
  headers: { host?: string }
}

interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** 宿主 Web 服务器里本插件用到的那部分形状。 */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/** 统一日志器:写到 stderr(与宿主自身的诊断同一条流),带固定前缀。 */
function createLogger(debugEnabled: () => boolean): Logger {
  const write = (level: string, message: string): void => {
    process.stderr.write(`[proxy-router] ${level}${message}\n`)
  }
  return {
    info: (message) => write('', message),
    warn: (message) => write('警告: ', message),
    debug: (message) => {
      if (debugEnabled()) write('调试: ', message)
    },
  }
}

/**
 * 状态输出里隐藏上游 URL 的账号密码。
 * 状态路由是同源可读的(设置页那张卡片),没必要时时刻刻把凭据放在响应里。
 */
function redactUpstream(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username === '' && parsed.password === '') return parsed.href
    parsed.username = '***'
    parsed.password = ''
    return parsed.href
  } catch {
    return url
  }
}

/** 从宿主提供的启动环境快照读数;服务不在时退回调用方给的快照。 */
function lookupLaunchEnv(ctx: HostContextLike, name: string): string | undefined {
  const service = ctx.get?.('launchEnvironment') as { get?(key: string): { value: string } | undefined } | undefined
  return service?.get?.(name)?.value
}

export function apply(ctx: HostContextLike, config?: unknown): void {
  let debugEnabled = false
  const log = createLogger(() => debugEnabled)

  // 环境快照必须在改写 process.env 之前取:接管策略后 process.env.http_proxy 会变成
  // 指向本插件自己的本地代理,再拿它当上游就会形成回环。启动环境服务是不可变快照,优先用它。
  const envSnapshot: Record<string, string | undefined> = { ...process.env }
  const envLookup = (name: string): string | undefined => lookupLaunchEnv(ctx, name) ?? envSnapshot[name]

  /** 组合配置(路径类字段只在这里)+ 设置页形状的 base 值。 */
  const extras: CompositionExtras = compositionExtrasFrom(config, log)
  const entry: SettingsValue = settingsValueFromComposition(config, log)
  /** 用户原有的 no_proxy 语义要保留(它列出的域名本来就该直连)。 */
  const userNoProxy = envSnapshot.no_proxy ?? envSnapshot.NO_PROXY

  // —— 运行时状态 ——
  const store = new RuleStore()
  store.seed.addAll(parseRules(SEED_BLOCKED_DOMAINS.join('\n'), { defaultRoute: 'proxy', source: 'seed' }).rules)
  let runtime: ResolvedConfig = resolveRuntimeConfig(entry, extras, envLookup, log)
  debugEnabled = runtime.debug
  let installation: SettingsInstallation | null = null
  let loader: RuleLoader | null = null
  let fetcher: TextFetcher | null = null
  let server: RouterServer | null = null
  let policy: InstalledPolicy | null = null
  let bound: { host: string; port: number; ephemeral: boolean } | null = null
  let localProxyUrl: string | null = null
  let started = false
  let shuttingDown = false
  const routeDisposers: (() => void)[] = []

  /** 状态快照:本地代理的控制接口与 Web 设置页读的是同一份。 */
  const statusPayload = (): Record<string, unknown> => {
    const counts = store.counts()
    return {
      namespace: PROXY_ROUTER_NAMESPACE,
      settingsRegistered: installation?.isRegistered() ?? false,
      listening: bound,
      upstream:
        runtime.upstream === null ? null : { url: redactUpstream(runtime.upstream.url), source: runtime.upstream.source },
      defaultRoute: runtime.defaultRoute,
      refreshHours: runtime.refreshHours,
      fallbackDirect: runtime.fallbackDirect,
      debug: runtime.debug,
      connectTimeoutMs: runtime.connectTimeoutMs,
      rules: counts,
      rulesFile: runtime.rulesFile,
      lists:
        loader?.staleList().map(({ state, stale }) => ({
          name: state.name,
          url: state.url,
          count: state.count,
          fetchedAt: state.fetchedAt === null ? null : new Date(state.fetchedAt).toISOString(),
          stale,
          lastError: state.lastError,
        })) ?? [],
      stats: server?.stats() ?? null,
      policy:
        policy === null
          ? null
          : { verified: policy.verified, modulePath: policy.modulePath, childRouting: policy.childRouting },
    }
  }

  /** 建一个装载器(启动与「清单配置变了」时共用)。 */
  const createLoader = (next: ResolvedConfig): RuleLoader =>
    new RuleLoader({
      store,
      localFile: next.rulesFile,
      stateDir: next.stateDir,
      lists: next.lists,
      refreshHours: next.refreshHours,
      localDefaultRoute: 'proxy',
      fetcher: fetcher!,
      log,
    })

  /** 建一个本地分流代理;上游/超时/回退/调试都走 getter,所以配置改了不用重建。 */
  const createServer = (): RouterServer =>
    createRouterServer({
      decide: (host) => store.decide(host, runtime.defaultRoute),
      getUpstream: () => runtime.upstream,
      getConnectTimeoutMs: () => runtime.connectTimeoutMs,
      getFallbackDirect: () => runtime.fallbackDirect,
      getDebug: () => runtime.debug,
      log,
      handleControl: (req, res, local) => handleControl(req as ControlRequest, res as ResponseLike, local),
    })

  /** 重新绑定监听地址:关掉旧监听 → 起新的 → 把宿主策略重新指过去。 */
  const rebind = async (next: ResolvedConfig): Promise<void> => {
    await server?.close().catch(() => {})
    server = createServer()
    bound = await server.listen(next.listen.host, next.listen.port)
    localProxyUrl = `http://${bound.host}:${bound.port}`
    await policy?.dispose().catch(() => {})
    policy = await installRouterPolicy({ localProxyUrl, userNoProxy, log })
    log.info(
      `监听地址已切到 ${bound.host}:${bound.port}${bound.ephemeral ? '(端口被占用,已改用随机端口)' : ''},宿主策略已重新指向它`,
    )
  }

  /** 清单相关配置变了:重建装载器(先读缓存,再后台刷新)。 */
  const reloadRules = async (next: ResolvedConfig): Promise<void> => {
    loader?.close()
    loader = createLoader(next)
    await loader.start()
    void loader.refresh(false).catch((error: unknown) => log.warn(`远程清单刷新失败: ${String(error)}`))
    log.info(`清单配置已更新: ${loader.describe()}`)
  }

  /** 设置变化:重新解析运行时配置,并只重建真正受影响的部分。 */
  const applySettings = (next: SettingsValue): void => {
    const previous = runtime
    runtime = resolveRuntimeConfig(next, extras, envLookup, log)
    debugEnabled = runtime.debug
    if (!started || shuttingDown) return
    const listenChanged = previous.listen.host !== runtime.listen.host || previous.listen.port !== runtime.listen.port
    const listsChanged =
      previous.refreshHours !== runtime.refreshHours ||
      JSON.stringify(previous.lists) !== JSON.stringify(runtime.lists)
    void (async () => {
      try {
        if (listenChanged) await rebind(runtime)
        else if (listsChanged) await reloadRules(runtime)
        log.info(
          `设置已更新: 上游 ${runtime.upstream === null ? '(未配置)' : runtime.upstream.url};` +
            `未命中默认${runtime.defaultRoute === 'proxy' ? '走代理' : '直连'};调试${runtime.debug ? '开' : '关'}`,
        )
      } catch (error) {
        log.warn(`设置热应用失败: ${String(error)}`)
      }
    })()
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    for (const dispose of routeDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 路由注销失败不影响退出 */
      }
    }
    loader?.close()
    if (server !== null) await server.close().catch(() => {})
    if (policy !== null) await policy.dispose().catch(() => {})
    if (fetcher !== null) await fetcher.close().catch(() => {})
  }

  // 插件卸载(宿主退出或热重载)时收摊:关监听、卸载策略、还原环境变量
  ctx.effect?.(() => () => {
    void shutdown()
  })

  const start = async (): Promise<void> => {
    // 1) 设置命名空间:成功注册后,设置页保存会实时回调 applySettings
    installation = await installSettingsSection(ctx, { entry, log, onChange: applySettings })

    // 2) 清单装载(先用本地规则 + 缓存,网络刷新放后台)
    fetcher = await createTextFetcher({
      getUpstream: () => runtime.upstream?.url ?? null,
      timeoutMs: Math.max(30_000, runtime.connectTimeoutMs),
      log,
    })
    loader = createLoader(runtime)
    await loader.start()

    // 3) 本地分流代理
    server = createServer()
    bound = await server.listen(runtime.listen.host, runtime.listen.port)
    localProxyUrl = `http://${bound.host}:${bound.port}`

    // 4) 接管宿主代理策略(起得来本地代理才谈得上接管)
    policy = await installRouterPolicy({ localProxyUrl, userNoProxy, log })
    started = true

    log.info(
      `上游代理: ${runtime.upstream === null ? '(未配置,规则命中的目标将退化为直连)' : `${runtime.upstream.url} (来自 ${runtime.upstream.source})`}`,
    )
    log.info(
      `本地分流代理: ${bound.host}:${bound.port}${bound.ephemeral ? ' (端口被占用,已改用随机端口)' : ''};未命中规则的域名默认${runtime.defaultRoute === 'proxy' ? '走代理' : '直连'}`,
    )
    log.info(`规则: ${loader.describe()}`)
    log.info(`本地规则文件(改完即时生效): ${runtime.rulesFile}`)
    log.info(
      policy === null
        ? '宿主策略未接管:主进程与子进程仍按原环境变量走代理'
        : `宿主策略已接管: undici 全局 dispatcher + web_fetch + bash 子进程 → ${localProxyUrl}${policy.verified ? ' (自检通过)' : ' (自检未通过,见上方警告)'}`,
    )
    if (installation.isRegistered()) {
      log.info(`设置页: Web 设置 → 插件 → 插件配置 → proxy-router(写入 ~/.dsh/settings.yaml,改完热生效)`)
    }
    log.info(`调试接口: curl -s http://${bound.host}:${bound.port}${CONTROL_PREFIX}status`)

    // 5) Web 服务器上的状态路由(设置页卡片读它)
    registerStatusRoute(ctx)

    // 6) 远程清单刷新放后台:首启已经用缓存/种子把规则表建好了,不需要等网络
    void loader.refresh(false).catch((error: unknown) => log.warn(`远程清单刷新失败: ${String(error)}`))
  }

  /** 把只读状态挂到宿主 Web 服务器上;服务缺失(非 Web 组装)时静默跳过。 */
  const registerStatusRoute = (hostCtx: HostContextLike): void => {
    const register = (available: HostContextLike): void => {
      const webServer = available.get?.('webServer') as WebServerLike | undefined
      if (webServer === undefined || typeof webServer.register !== 'function') return
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE_PATH,
          handler: (req, res) => {
            const request = req as ControlRequest
            const response = res as ResponseLike
            if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
              response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
              response.end('{"error":"只支持 GET"}\n')
              return
            }
            writeJson(response, statusPayload())
          },
        })
        routeDisposers.push(dispose)
      } catch (error) {
        log.warn(`状态路由注册失败(${String(error)}),设置页将看不到运行状态`)
      }
    }
    if (typeof ctx.inject === 'function') {
      // 与 webServer 就绪解耦:服务稍后才可用时回调依然会执行
      try {
        ctx.inject(['webServer'], (available) => register(available))
      } catch (error) {
        log.debug(`等待 webServer 失败(${String(error)}),改为直接尝试`)
        register(hostCtx)
      }
    } else {
      register(hostCtx)
    }
  }

  void start().catch((error: unknown) => {
    log.warn(`初始化失败,插件不生效: ${String(error)}`)
    void shutdown()
  })

  /** 把 JSON 写成一个禁缓存的应答。 */
  function writeJson(res: ResponseLike, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${JSON.stringify(body, null, 2)}\n`)
  }

  /** 本机代理自带的调试接口:看状态、问某个域名为什么这么走、手动重载规则。 */
  function handleControl(
    req: ControlRequest,
    res: ResponseLike,
    local: { host: string; port: number },
  ): boolean {
    const host = req.headers.host ?? ''
    const selfHosts = [`${local.host}:${local.port}`, `localhost:${local.port}`, `127.0.0.1:${local.port}`]
    // 只接管「目标是本机代理自己」的控制路径;其余请求即便路径撞上也要按代理处理
    if (!selfHosts.includes(host)) return false
    const url = req.url ?? ''
    if (!url.startsWith(CONTROL_PREFIX)) return false
    const route = url.slice(CONTROL_PREFIX.length).split('?')[0] ?? ''
    if (route === 'status') {
      writeJson(res, statusPayload())
      return true
    }
    if (route === 'why') {
      const query = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : new URLSearchParams()
      const target = query.get('host') ?? ''
      if (target === '') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"error":"缺少 host 参数"}\n')
        return true
      }
      writeJson(res, { host: target, ...store.decide(target, runtime.defaultRoute) })
      return true
    }
    if (route === 'reload') {
      void (async () => {
        try {
          await loader?.reloadAll()
          writeJson(res, { ok: true, rules: store.counts() })
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(`${JSON.stringify({ ok: false, error: String(error) })}\n`)
        }
      })()
      return true
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(`${JSON.stringify({ error: `未知路径,可用: ${CONTROL_PREFIX}status|why?host=…|reload` })}\n`)
    return true
  }
}
