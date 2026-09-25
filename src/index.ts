/**
 * @yangzhe1991/dsh-proxy-router 插件,node 半(宿主侧)。
 *
 * 装配顺序:
 *   1. 归一化行配置(cordis 已按 `Config` schema 校验并补默认值;volatile 字段是引用)
 *   2. 建规则表:内置种子 → 本地规则文件(热加载)→ 远程被墙清单缓存(后台刷新)
 *   3. 起本地分流代理(127.0.0.1,规则命中 proxy 的目标转发给上游,其余直连)
 *   4. 把宿主代理策略指向本地分流代理(undici 全局 dispatcher + no_proxy)
 *   5. 在宿主的 Web 服务器上挂一个只读状态路由,供设置页的分区显示运行态
 *
 * 热应用(dsh 0.1.7 的 volatile 契约):设置页保存后,宿主把新值写进运行中 fiber 的引用
 * 并发 `loader/volatile-update`,本插件据此重新解析配置、只重建受影响的部分 ——
 * 上游/默认走向/超时/回退/调试都是「现读」的(router、fetcher 拿的是 getter),
 * 改完立刻生效;只有监听地址与清单相关两项需要重建对应部件。
 *
 * 失败降级原则:任何一步抛错都只记日志,不向上抛 —— 插件最坏的结果是「不生效」,
 * 绝不能因为分流插件的配置问题把宿主启动搞挂。apply 本身不返回 promise,
 * 异步初始化在内部 catch,避免影响 Loader 对该插件行的状态判定。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RuleStore, parseRules } from './rules.js'
import { SEED_BLOCKED_DOMAINS } from './seed.js'
import { LOCAL_RULES_TEMPLATE, RuleLoader } from './lists.js'
import { CONTROL_PREFIX, createRouterServer, isLoopbackName, type RouterServer } from './router.js'
import { createTextFetcher, type Logger, type TextFetcher } from './fetcher.js'
import { installRouterPolicy, type InstalledPolicy } from './host-policy.js'
import {
  Config,
  compositionExtrasFrom,
  normalizeSettingsValue,
  readConfigRaw,
  resolveRuntimeConfig,
  type CompositionExtras,
  type PluginConfigLike,
  type ResolvedConfig,
  type ResolvedUpstream,
  type SettingsValue,
} from './config.js'

/** 插件行配置 schema:宿主读这个导出来校验配置、生成设置页里的配置表单。 */
export { Config }

/** 设置命名空间 = 插件行 id(设置页按行 id 找 schema 与当前值)。 */
export const PROXY_ROUTER_NAMESPACE = 'proxy-router'

/** 插件 apply 收到的宿主上下文里,本插件用到的部分(cordis Context 结构兼容)。 */
export interface HostContextLike {
  /** 读取 cordis 服务(缺服务时返回 undefined,不抛错)。 */
  get?(name: string): unknown
  /** 订阅事件(volatile 配置热更新走 `loader/volatile-update`)。 */
  on?(name: string, listener: (...args: never[]) => void): unknown
  /** 注册作用域 effect;回调可返回 disposer,插件卸载时执行。 */
  effect?(fn: () => void | (() => void), name?: string): unknown
  /** 服务可用时执行回调(服务缺失时回调不执行,不阻塞插件)。 */
  inject?(deps: readonly string[], callback: (ctx: HostContextLike) => unknown): unknown
}

/** Web 服务器上的只读状态路由(设置页那张卡片读它;同源,无需 CORS)。 */
export const STATUS_ROUTE_PATH = '/dsh-proxy-router/status'

/** Web 服务器上的本地规则文件读写路由(设置页规则编辑区用;GET 读、PUT 写)。 */
export const RULES_ROUTE_PATH = '/dsh-proxy-router/rules'

/** 规则文件请求体上限:规则文件只该有几十 KB,超过这个量级一定是打错了。 */
const RULES_BODY_LIMIT = 256 * 1024

interface ControlRequest {
  method?: string
  url?: string
  headers: { host?: string; origin?: string; referer?: string }
  /** 请求体(node:http 的 IncomingMessage 本身就是 AsyncIterable<Buffer>)。 */
  [Symbol.asyncIterator]?(): AsyncIterator<Buffer | string>
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

/**
 * 是否是「浏览器从本页发起的请求」:Origin(或退化用 Referer)的 host 必须等于 Host。
 *
 * 宿主注册的路由不过会话认证,所以写入口只能靠这条判断挡跨站请求。
 * 两个头都没有时判 false —— 浏览器发 PUT 一定会带 Origin,没有就不是浏览器。
 */
function isSameOrigin(request: ControlRequest): boolean {
  const host = request.headers.host
  if (host === undefined || host === '') return false
  const source = request.headers.origin ?? request.headers.referer
  if (source === undefined || source === '') return false
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}

/**
 * 读请求体,超过上限返回 null。
 *
 * 注意:必须直接对请求对象本身 `for await`(IncomingMessage 自带 asyncIterator)。
 * 曾把它包成 `{ [Symbol.asyncIterator]: iterator }` 的壳,Node 的流机制会试图
 * `Readable.wrap()` 那个壳,报 `stream.on is not a function` —— 假对象骗不过内部实现。
 *
 * @param request - 请求对象(IncomingMessage 是 AsyncIterable)。
 * @param limit - 字节上限。
 * @returns 正文,或 null(超限/不可读)。
 */
async function readRequestBody(request: ControlRequest, limit: number): Promise<string | null> {
  if (typeof request[Symbol.asyncIterator] !== 'function') return null
  const stream = request as unknown as AsyncIterable<Buffer | string>
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    size += buffer.byteLength
    if (size > limit) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
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

  /** 行配置(cordis 已按 Config schema 校验;volatile 字段是引用,每次读都取最新值)。 */
  const configLike = (typeof config === 'object' && config !== null ? config : {}) as PluginConfigLike
  const extras: CompositionExtras = compositionExtrasFrom(readConfigRaw(configLike), log)
  /** 当前生效的设置值:volatile 热更新后这里读到的就是新值。 */
  const entry = (): SettingsValue => normalizeSettingsValue(readConfigRaw(configLike), log)
  /** 用户原有的 no_proxy 语义要保留(它列出的域名本来就该直连)。 */
  const userNoProxy = envSnapshot.no_proxy ?? envSnapshot.NO_PROXY

  // —— 运行时状态 ——
  const store = new RuleStore()
  store.seed.addAll(parseRules(SEED_BLOCKED_DOMAINS.join('\n'), { defaultRoute: 'proxy', source: 'seed' }).rules)
  let runtime: ResolvedConfig = resolveRuntimeConfig(entry(), extras, envLookup, log)
  debugEnabled = runtime.debug
  let loader: RuleLoader | null = null
  let fetcher: TextFetcher | null = null
  let server: RouterServer | null = null
  let policy: InstalledPolicy | null = null
  let bound: { host: string; port: number; ephemeral: boolean } | null = null
  let localProxyUrl: string | null = null
  let started = false
  let shuttingDown = false
  /** 在飞的热应用:卸载要先等它落地,否则可能留下没人管的监听/策略。 */
  let reconcileInFlight: Promise<void> | null = null
  const routeDisposers: (() => void)[] = []

  /** 状态快照:本地代理的控制接口与 Web 设置页读的是同一份。 */
  const statusPayload = (): Record<string, unknown> => {
    const counts = store.counts()
    return {
      namespace: PROXY_ROUTER_NAMESPACE,
      /** 0.1.7 里配置就是插件行自身的 schema,没有单独的「设置分节」注册动作,恒为 true。 */
      settingsRegistered: true,
      /** 总开关:假 = 插件完全不动作(不监听、不接管策略),面板据此显示「未启用」。 */
      enabled: runtime.enabled,
      listening: bound,
      upstream:
        runtime.upstream === null ? null : { url: redactUpstream(runtime.upstream.url), source: runtime.upstream.source },
      /** 配置了上游但被判定为指向自己(忽略)时为 true,设置页据此提示。 */
      upstreamIgnored: refusedUpstream !== null,
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

  /**
   * 生效的上游:指向本插件自己的监听地址时必须忽略。
   *
   * 那是必然的死循环:规则说走代理 → CONNECT 到自己 → 自己又按规则转发给自己。
   * 用户把本地代理地址误填进「上游代理」是最容易犯的错(状态页上就有这个地址)。
   */
  let refusedUpstream: string | null = null
  const effectiveUpstream = (): ResolvedUpstream | null => {
    const upstream = runtime.upstream
    if (upstream === null) {
      refusedUpstream = null
      return null
    }
    if (
      bound !== null &&
      upstream.port === bound.port &&
      (upstream.host === bound.host || (isLoopbackName(upstream.host) && isLoopbackName(bound.host)))
    ) {
      if (refusedUpstream !== upstream.url) {
        refusedUpstream = upstream.url
        log.warn(
          `上游代理指向了本插件自己的监听地址(${upstream.url}),已忽略以避免自我循环;` +
            '请在设置页把上游改成本机之外的真实代理地址',
        )
      }
      return null
    }
    refusedUpstream = null
    return upstream
  }

  /**
   * 主动跑一次上游判定:把「上游填成了自己」这件事在启动/改设置时就报出来,
   * 而不是等第一个被墙域名请求到达才告警 —— 那时用户已经在等结果了。
   */
  const noteUpstream = (): void => {
    void effectiveUpstream()
  }

  /** 建一个本地分流代理;上游/超时/回退/调试都走 getter,所以配置改了不用重建。 */
  const createServer = (): RouterServer =>
    createRouterServer({
      decide: (host) => store.decide(host, runtime.defaultRoute),
      getUpstream: effectiveUpstream,
      getConnectTimeoutMs: () => runtime.connectTimeoutMs,
      getFallbackDirect: () => runtime.fallbackDirect,
      getDebug: () => runtime.debug,
      log,
      handleControl: (req, res, local) => handleControl(req as ControlRequest, res as ResponseLike, local),
    })

  /** 重新绑定监听地址:关掉旧监听 → 起新的 → 把宿主策略重新指过去。 */
  const rebind = async (next: ResolvedConfig): Promise<void> => {
    if (shuttingDown) return
    await server?.close().catch(() => {})
    if (shuttingDown) return
    server = createServer()
    bound = await server.listen(next.listen.host, next.listen.port)
    localProxyUrl = `http://${bound.host}:${bound.port}`
    await policy?.dispose().catch(() => {})
    policy = await installRouterPolicy({ localProxyUrl, userNoProxy, log })
    log.info(
      `监听地址已切到 ${bound.host}:${bound.port}${bound.ephemeral ? '(端口被占用,已改用随机端口)' : ''},宿主策略已重新指向它`,
    )
    noteUpstream()
  }

  /** 清单相关配置变了:重建装载器(先读缓存,再后台刷新)。 */
  const reloadRules = async (next: ResolvedConfig): Promise<void> => {
    if (shuttingDown) return
    loader?.close()
    loader = createLoader(next)
    await loader.start()
    void loader.refresh(false).catch((error: unknown) => log.warn(`远程清单刷新失败: ${String(error)}`))
    log.info(`清单配置已更新: ${loader.describe()}`)
  }

  /**
   * 配置变化(volatile 热更新)后重新解析运行时配置,并只重建真正受影响的部分。
   *
   * 触发点:宿主把设置页保存的新值写进运行中 fiber 的引用后,会在本插件的 fiber 上
   * 发 `loader/volatile-update`(见 cordis-plugin-loader 的 `_commitVolatile`)。
   * 上游/默认走向/超时/回退/调试是现读的,所以只有监听地址与清单两项需要重建。
   */
  const reconcileFromConfig = (): void => {
    const previous = runtime
    runtime = resolveRuntimeConfig(entry(), extras, envLookup, log)
    debugEnabled = runtime.debug
    if (!started || shuttingDown) return
    const enabledChanged = previous.enabled !== runtime.enabled
    const listenChanged = previous.listen.host !== runtime.listen.host || previous.listen.port !== runtime.listen.port
    const listsChanged =
      previous.refreshHours !== runtime.refreshHours ||
      JSON.stringify(previous.lists) !== JSON.stringify(runtime.lists)
    reconcileInFlight = (async () => {
      try {
        // 总开关优先级最高:它一动就整段启/停,其余字段的差异都会在启停时按最新配置重新解析
        if (enabledChanged) {
          if (runtime.enabled) {
            await startRuntime()
            log.info('分流代理已启用(总开关打开)')
          } else {
            await stopRuntime()
            log.info('分流代理已停用(总开关关掉):监听已关闭、宿主代理策略已还原,一切按原有环境走')
          }
          return
        }
        // 关着的时候其余字段只落盘、不重建:它们会在下次打开开关时按最新值生效
        if (!runtime.enabled) {
          log.info('设置已保存(总开关关着,先不生效;打开开关后按新值运行)')
          return
        }
        if (listenChanged) await rebind(runtime)
        else if (listsChanged) await reloadRules(runtime)
        if (shuttingDown) return
        if (!listenChanged) noteUpstream()
        log.info(
          `设置已更新: 上游 ${runtime.upstream === null ? '(未配置)' : runtime.upstream.url};` +
            `未命中默认${runtime.defaultRoute === 'proxy' ? '走代理' : '直连'};调试${runtime.debug ? '开' : '关'}`,
        )
      } catch (error) {
        log.warn(`设置热应用失败: ${String(error)}`)
      } finally {
        reconcileInFlight = null
      }
    })()
  }

  // volatile 配置热更新:宿主已把新值写进引用,这里只管重新解析并做必要重建。
  ctx.on?.('loader/volatile-update', () => {
    try {
      reconcileFromConfig()
    } catch (error) {
      log.warn(`处理 volatile 配置更新失败: ${String(error)}`)
    }
  })

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // 等在飞的热应用落地:否则它可能在收摊之后又装回一套监听与策略
    if (reconcileInFlight !== null) await reconcileInFlight.catch(() => {})
    for (const dispose of routeDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 路由注销失败不影响退出 */
      }
    }
    await stopRuntime()
  }

  // 插件卸载(宿主退出或热重载)时收摊:关监听、卸载策略、还原环境变量
  ctx.effect?.(() => () => {
    void shutdown()
  })

  /**
   * 收运行时(总开关关掉、或插件卸载时):关监听 → 卸策略(模块自己会把进程里那几个
   * 代理变量还原成原值)→ 停清单刷新与抓取。
   *
   * 幂等:可以反复调用,也可以在从没起过的情况下调用 —— 总开关来回切换靠的就是它。
   */
  const stopRuntime = async (): Promise<void> => {
    loader?.close()
    loader = null
    if (fetcher !== null) {
      const closing = fetcher
      fetcher = null
      await closing.close().catch(() => {})
    }
    if (server !== null) {
      const closing = server
      server = null
      await closing.close().catch(() => {})
    }
    if (policy !== null) {
      const installed = policy
      policy = null
      await installed.dispose().catch(() => {})
    }
    bound = null
    localProxyUrl = null
  }

  /**
   * 起运行时:清单装载 → 本地监听 → 接管宿主代理策略。
   *
   * **总开关 `enabled` 为假时整段不做**:一个端口都不占、完全不碰宿主代理策略,主进程与
   * 子进程仍按原有环境变量走(没 export 就是全直连)。这样「装上一个插件就改变全局出网
   * 行为」不会在用户自己打开开关之前发生 —— 新装默认关就是这个意思。
   */
  const startRuntime = async (): Promise<void> => {
    if (!runtime.enabled) {
      started = true
      log.info('分流代理未启用(总开关关着):不监听本地端口、不接管宿主代理策略,一切按原有环境走')
      log.info('打开方式: Web 侧边栏 → 设置 → 分流代理 → 打开「启用分流代理」')
      return
    }

    // 1) 清单装载(先用本地规则 + 缓存,网络刷新放后台)
    fetcher = await createTextFetcher({
      getUpstream: () => effectiveUpstream()?.url ?? null,
      timeoutMs: Math.max(30_000, runtime.connectTimeoutMs),
      log,
    })
    loader = createLoader(runtime)
    await loader.start()

    // 2) 本地分流代理
    server = createServer()
    bound = await server.listen(runtime.listen.host, runtime.listen.port)
    localProxyUrl = `http://${bound.host}:${bound.port}`

    // 3) 接管宿主代理策略(起得来本地代理才谈得上接管)
    policy = await installRouterPolicy({ localProxyUrl, userNoProxy, log })
    started = true
    noteUpstream()

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
    log.info(
      `配置页: Web 侧边栏 → 设置 → 分流代理(改完热生效,不重启宿主)`,
    )
    log.info(`调试接口: curl -s http://${bound.host}:${bound.port}${CONTROL_PREFIX}status`)

    // 4) 远程清单刷新放后台:首启已经用缓存/种子把规则表建好了,不需要等网络
    void loader.refresh(false).catch((error: unknown) => log.warn(`远程清单刷新失败: ${String(error)}`))
  }

  /** 把只读状态挂到宿主 Web 服务器上;服务缺失(非 Web 组装)时静默跳过。 */
  const registerStatusRoute = (hostCtx: HostContextLike): void => {
    registerWebRoute(hostCtx, STATUS_ROUTE_PATH, (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
        response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"只支持 GET"}\n')
        return
      }
      writeJson(response, statusPayload())
    }, '状态')
  }

  /**
   * 本地规则文件的读写路由(设置页的规则编辑区)。
   *
   * 写操作有三道闸,原因是**宿主注册的路由不过会话认证**(实测:不带 cookie 直接
   * `GET /dsh-proxy-router/status` 也是 200),所以写入口必须自己挡:
   *   1) 只认 PUT,且必须同源(`Origin`/`Referer` 的 host 等于 `Host`)—— 挡掉跨站表单/脚本;
   *   2) 请求体上限 256KB;
   *   3) 写前把原文件复制成 `<rulesFile>.bak`,再「写临时文件 + rename」原子替换,
   *      不留下半个文件(宿主对规则文件有热加载,读到半截会解析出一堆废规则)。
   *
   * 解析刻意宽容,所以「跳过的行」不拦保存、只如实回报给编辑器(带行号):
   * 打错一个域名却毫无提示是最糟的体验,但把手写清单卡死在保存上同样是。
   */
  const registerRulesRoute = (hostCtx: HostContextLike): void => {
    registerWebRoute(hostCtx, RULES_ROUTE_PATH, async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        writeJson(response, await rulesSnapshot())
        return
      }
      if (method !== 'PUT') {
        response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"只支持 GET / PUT"}\n')
        return
      }
      if (!isSameOrigin(request)) {
        // 不是「浏览器从本页发起的写」:直接拒绝,并给出可读原因(便于用户自查代理/插件)
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"写规则要求同源请求(缺 Origin/Referer 或与 Host 不一致)"}\n')
        return
      }
      // 读体可能抛(连接中断、流内部错误):这里必须自己兜住,
      // 否则一个 rejected promise 会飘到宿主 Web 服务器的处理器里。
      let body: string | null = null
      try {
        body = await readRequestBody(request, RULES_BODY_LIMIT)
      } catch (error) {
        log.warn(`读规则请求体失败: ${String(error)}`)
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"请求体读取失败"}\n')
        return
      }
      if (body === null) {
        response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        response.end(`{"error":"请求体超过 ${RULES_BODY_LIMIT} 字节上限"}\n`)
        return
      }
      let content: unknown
      try {
        content = (JSON.parse(body) as { content?: unknown }).content
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"请求体不是合法 JSON"}\n')
        return
      }
      if (typeof content !== 'string') {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end('{"error":"缺少 content 字段(字符串)"}\n')
        return
      }
      try {
        const written = await writeRulesFile(content)
        writeJson(response, written)
      } catch (error) {
        log.warn(`写本地规则文件失败: ${String(error)}`)
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(`${JSON.stringify({ error: `写文件失败: ${String(error)}` })}\n`)
      }
    }, '规则')
  }

  /**
   * 规则文件的当前状态(编辑器初始化与保存后的回执共用一份口径)。
   * @returns 路径、是否存在、正文、解析摘要与逐行诊断。
   */
  const rulesSnapshot = async (): Promise<Record<string, unknown>> => {
    const file = runtime.rulesFile
    let content = ''
    let exists = false
    try {
      content = await readFile(file, 'utf8')
      exists = true
    } catch {
      // 文件还没生成(插件没启用过)时给编辑器一份模板,而不是空白页
      content = LOCAL_RULES_TEMPLATE
    }
    return {
      path: file,
      exists,
      content,
      ...rulesSummary(content),
      applied: runtime.enabled && loader !== null,
    }
  }

  /** 解析一份规则文本,给出条数与逐行诊断(编辑器与保存回执共用)。 */
  const rulesSummary = (content: string): Record<string, unknown> => {
    const outcome = parseRules(content, { defaultRoute: 'proxy', source: 'local' })
    let proxy = 0
    let direct = 0
    for (const rule of outcome.rules) {
      if (rule.route === 'direct') direct++
      else proxy++
    }
    return {
      summary: { total: outcome.rules.length, proxy, direct, skipped: outcome.skipped },
      issues: outcome.issues,
    }
  }

  /**
   * 备份 + 原子写入规则文件,然后让运行中的装载器立刻重读(开关关着时下次启动生效)。
   * @param content - 新正文。
   * @returns 回执(路径、备份路径、解析摘要、是否已生效)。
   */
  const writeRulesFile = async (content: string): Promise<Record<string, unknown>> => {
    const file = runtime.rulesFile
    const backup = `${file}.bak`
    await mkdir(dirname(file), { recursive: true })
    if (existsSync(file)) await copyFile(file, backup)
    // 同目录临时文件 + rename:同分区 rename 是原子的,热加载不会读到写了一半的文件
    const temp = `${file}.tmp-${String(process.pid)}`
    await writeFile(temp, content, 'utf8')
    await rename(temp, file)
    await loader?.reloadLocal().catch((error: unknown) => log.warn(`规则已写入但重载失败: ${String(error)}`))
    log.info(`本地规则已更新: ${file}(备份 ${existsSync(backup) ? backup : '无'})`)
    return { ok: true, path: file, backupPath: existsSync(backup) ? backup : null, ...rulesSummary(content), applied: runtime.enabled && loader !== null }
  }

  /** 把一条路由挂到宿主 Web 服务器上(webServer 服务可能晚到,所以走 inject 等它)。 */
  const registerWebRoute = (
    hostCtx: HostContextLike,
    path: string,
    handler: (req: ControlRequest, res: ResponseLike) => void | Promise<void>,
    label: string,
  ): void => {
    const register = (available: HostContextLike): void => {
      const webServer = available.get?.('webServer') as WebServerLike | undefined
      if (webServer === undefined || typeof webServer.register !== 'function') return
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => handler(req as ControlRequest, res as ResponseLike),
        })
        routeDisposers.push(dispose)
      } catch (error) {
        log.warn(`${label}路由注册失败(${String(error)}),设置页对应功能不可用`)
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

  // 两条路由只挂一次(总开关来回切换不应重复注册);关着开关时面板靠状态路由显示「未启用」。
  registerStatusRoute(ctx)
  registerRulesRoute(ctx)

  void startRuntime().catch((error: unknown) => {
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
