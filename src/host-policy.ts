/**
 * 宿主策略接管:让**宿主自己那份** `@deepseek-ai/dsh-http-proxy` 重新解析一次策略,
 * 把 http/https 代理指向本地分流代理,no_proxy 只留回环地址。
 *
 * 一次 install 同时解决三件事(这就是必须复用宿主模块实例的原因):
 *   1. undici 全局 dispatcher → 主进程所有 `fetch()`(LLM、搜索、MCP、插件)都先到本地代理;
 *   2. 模块级 `active` 策略 → web_fetch 的 `proxyRouteFor()` 与宿主看到同一个口径;
 *   3. `proxyEnvironmentForChild()` → bash 子进程(curl/git/npm)拿到同一个本地代理地址。
 *
 * 关于环境变量的一个坑:模块内部用「最外层 install 时的 process.env 快照」当作
 * 「用户自己 export 的值」,子进程环境优先用那份快照。宿主启动时就 export 过
 * 代理变量的话,快照里存的是**上游地址**,子进程会绕过本插件直接连上游。
 * 所以这里安装前先把 process.env 里的代理变量摘掉,让快照捕获不到它们;
 * 装完由模块自己写回解析后的值(也就是本地代理地址)。若宿主启动前就 export 过,
 * 快照早已在 boot 阶段定格,这一步救不回来 —— 那种情况会在启动日志里明确告警。
 */
import { loadHostModule, type HostHttpProxyModule } from './host-modules.js'
import type { Logger } from './fetcher.js'

/** 所有携带代理配置的环境变量名(含 all_proxy,模块自己也会读它做兜底)。 */
export const PROXY_ENV_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const

/** 子进程实际会走哪条路,启动日志里说清楚,免得用户以为子进程也被分流了。 */
export type ChildRouting = 'router' | 'upstream' | 'none'

export interface InstalledPolicy {
  /** 卸载:恢复安装前的全局 dispatcher、策略与环境变量。 */
  dispose(): Promise<void>
  /** 自检:宿主模块的 `proxyRouteFor` 确实把公网 URL 判给了本地分流代理。 */
  verified: boolean
  /** 宿主模块文件路径(日志用,便于确认拿到的是哪一份实例)。 */
  modulePath: string
  /** bash 子进程会用的代理地址(诊断用)。 */
  childRouting: ChildRouting
}

export interface InstallPolicyOptions {
  /** 本地分流代理 URL,例如 http://127.0.0.1:17890。 */
  localProxyUrl: string
  /** 用户自己 export 的 no_proxy(保留其语义:列进去的域名走直连)。 */
  userNoProxy: string | undefined
  log: Logger
}

/**
 * 安装代理策略。返回 null 表示宿主模块解析不到(插件降级为不接管,只留本地代理在跑)。
 */
export async function installRouterPolicy(options: InstallPolicyOptions): Promise<InstalledPolicy | null> {
  const { log } = options
  const loaded = await loadHostModule<HostHttpProxyModule>('@deepseek-ai/dsh-http-proxy')
  if (loaded === undefined) {
    log.warn('解析不到宿主的 @deepseek-ai/dsh-http-proxy,无法接管代理策略:分流不会生效')
    return null
  }

  // 安装前摘掉进程里的代理变量,让模块把「用户 export 的值」记为不存在,
  // 子进程于是拿到模块解析后的值(= 本地分流代理)。
  const snapshot: Record<string, string | undefined> = {}
  for (const name of PROXY_ENV_NAMES) {
    snapshot[name] = process.env[name]
    delete process.env[name]
  }

  // 只喂给模块它需要看到的两件事:代理指向本地、no_proxy 沿用用户原有的。
  // all_proxy 一律返回 undefined,避免用户 export 的 socks 上游把 http/https 顶掉。
  const env = {
    get(name: string): { value: string } | undefined {
      const lower = name.toLowerCase()
      if (lower === 'http_proxy' || lower === 'https_proxy') return { value: options.localProxyUrl }
      if (lower === 'no_proxy' && options.userNoProxy !== undefined && options.userNoProxy !== '') {
        return { value: options.userNoProxy }
      }
      return undefined
    },
  }

  let dispose: () => Promise<void> | void
  try {
    dispose = await loaded.mod.installProxyFromEnvironment(env, (message) => {
      log.warn(`宿主代理策略: ${message}`)
    })
  } catch (error) {
    // 安装失败就把环境变量还原,不留半截状态
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    log.warn(`安装宿主代理策略失败: ${String(error)}`)
    return null
  }

  // 自检:探针域名的决策必须落在本地分流代理上,否则说明拿到的是另一份模块实例
  let verified = false
  try {
    const route = loaded.mod.proxyRouteFor(new URL('http://proxy-router-probe.invalid/'))
    verified = route.proxied && route.proxy === options.localProxyUrl
  } catch (error) {
    log.debug(`策略自检异常: ${String(error)}`)
  }
  if (!verified) {
    log.warn(
      '策略自检未通过:web_fetch 与 bash 子进程可能仍按旧策略走。' +
        `(宿主模块: ${loaded.path})`,
    )
  }

  // 子进程诊断:拿模块算出的子进程环境,判断它到底指向谁
  let childRouting: ChildRouting = 'none'
  let childProxy: string | undefined
  try {
    const childEnv = loaded.mod.proxyEnvironmentForChild()
    childProxy = childEnv.http_proxy ?? childEnv.https_proxy ?? childEnv.HTTP_PROXY ?? childEnv.HTTPS_PROXY
    if (childProxy === undefined) childRouting = 'none'
    else if (childProxy === options.localProxyUrl) childRouting = 'router'
    else childRouting = 'upstream'
  } catch (error) {
    log.debug(`子进程环境自检异常: ${String(error)}`)
  }
  if (childRouting === 'upstream') {
    log.warn(
      `bash 子进程将直接使用 ${childProxy} 而不经过本插件分流:` +
        '原因是宿主启动时就已经 export 了代理变量(那份快照在宿主启动阶段就定格了)。' +
        '要让它也走分流,请去掉启动命令里的 export,改用插件配置 config.upstream。',
    )
  }

  return {
    modulePath: loaded.path,
    verified,
    childRouting,
    dispose: async () => {
      await dispose()
      // 模块的 disposer 只恢复到「安装前」(已被我们清空)的状态,这里把用户原有的变量补回去
      for (const [name, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}
