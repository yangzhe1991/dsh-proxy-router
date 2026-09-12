/**
 * 宿主模块解析:插件的 node 半需要拿到**宿主自己那份** `@deepseek-ai/dsh-http-proxy`
 * 与 `undici` 实例,而不是自己打包一份副本。
 *
 * 为什么非要同一份实例:宿主启动时(dsh CLI 的 profile-boot)已经调用过
 * `installProxyFromEnvironment` 装好了全局代理策略,该模块内部持有模块级状态
 * (`active` 策略 + `installed` dispatcher)。web_fetch 走 `proxyRouteFor()`、
 * bash 子进程走 `proxyEnvironmentForChild()`,两者读的都是这份模块状态;
 * 插件若拿到副本,只能改到副本的状态,分流就会在新旧两个口径之间劈叉。
 * ESM 模块实例按 realpath 去重,所以只要解析到同一个文件路径就一定是同一实例。
 *
 * 解析顺序(先准后全):
 *   1. dsh CLI 的 bin 位置:`process.argv[1]` 的 realpath 通常就是
 *      `.../@deepseek-ai/dsh/lib/bin.js`,从它出发 require 到的就是 CLI 的
 *      node_modules —— 与启动时的 import 是同一个 realpath。
 *   2. `<DSH_HOME>/profiles/`:profile 的 node_modules 里通常有指向 CLI 包的软链,
 *      注册表安装形态(插件装在 profiles/web/node_modules 下)向上查找也会命中这里。
 *   3. 直接 import 裸标识符:开发态(link)下仓库里若建了同名软链,也能命中。
 * 三条都不成时返回 undefined,调用方降级(不接管策略,只记日志)。
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** DSH 家目录:优先跟随宿主进程的 DSH_HOME,否则 `~/.dsh`。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** require 的解析锚点,顺序即优先级。 */
function anchors(): string[] {
  const list: string[] = []
  const argv1 = process.argv[1]
  if (argv1 !== undefined && argv1 !== '') {
    try {
      list.push(realpathSync(argv1))
    } catch {
      /* 拿不到 realpath 就用原路径兜底 */
      list.push(argv1)
    }
  }
  // 一个不存在的占位文件即可作为锚点:require 只关心它所在的目录链
  list.push(join(dshHome(), 'profiles', '__proxy-router-anchor__.js'))
  return list
}

/** 解析宿主侧模块的绝对路径;全失败返回 undefined。 */
export function resolveHostModule(spec: string): string | undefined {
  for (const anchor of anchors()) {
    try {
      return createRequire(anchor).resolve(spec)
    } catch {
      /* 换下一个锚点 */
    }
  }
  return undefined
}

/** 动态 import 宿主模块;解析不到返回 undefined(调用方负责降级)。 */
export async function loadHostModule<T>(spec: string): Promise<{ mod: T; path: string } | undefined> {
  const resolved = resolveHostModule(spec)
  if (resolved === undefined) return undefined
  const mod = (await import(pathToFileURL(resolved).href)) as T
  return { mod, path: resolved }
}

/** `@deepseek-ai/dsh-http-proxy` 里插件用到的那部分形状(其余不依赖)。 */
export interface HostHttpProxyModule {
  installProxyFromEnvironment(
    env: { get(name: string): { value: string } | undefined },
    report: (message: string) => void,
  ): Promise<() => Promise<void> | void>
  proxyRouteFor(url: URL): { proxied: boolean; proxy?: string }
  proxyEnvironmentForChild(): Record<string, string | undefined>
}

/** `undici` 里用到的那部分形状。 */
export interface HostUndiciModule {
  Agent: new (options?: Record<string, unknown>) => { close(): Promise<void> }
  ProxyAgent: new (options: Record<string, unknown>) => { close(): Promise<void> }
  fetch: (input: string, init?: Record<string, unknown>) => Promise<{
    status: number
    headers: { get(name: string): string | null }
    text(): Promise<string>
  }>
  setGlobalDispatcher(dispatcher: unknown): void
  getGlobalDispatcher(): unknown
}
