/**
 * 配置层:把插件行的配置(cordis 校验+补默认值之后的对象)归一化成插件内部用的完整配置。
 *
 * dsh 0.1.7 起,插件配置的来源统一成「插件行的 Config schema」:
 *   - 组合配置(profile 的 `cordis.patch.yml` 里那行 config)= 部署默认值;
 *   - 用户在设置页里填的值写回同一处(profile 用户层),由宿主合并后交给 apply;
 *   - 字段带 `.volatile()` 标记的可以**热生效**:宿主把新值直接写进运行中 fiber 的
 *     引用(ref),插件通过 `config.x.get()` 读到新值,并收到 `loader/volatile-update`;
 *     没有 volatile 的字段只在(重新)挂载时生效。
 *
 * 归一化原则:每个字段都有默认值,配置写错类型只警告并回退默认值,**绝不抛错** ——
 * 插件装错配置最坏的结果应该是「不生效」,而不是把宿主启动搞挂。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { isLoopbackHost, splitHostPort } from './loopback.ts'
import type { Route } from './rules.js'
import type { Logger } from './fetcher.js'
import type { UpstreamTarget } from './router.js'
import type { RemoteListSpec } from './lists.js'

/** 上游代理(含来源,便于启动日志说明「这条上游是哪来的」)。 */
export interface ResolvedUpstream extends UpstreamTarget {
  url: string
  source: 'config' | 'env:https_proxy' | 'env:http_proxy' | 'env:all_proxy'
}

/**
 * 设置页可编辑的那部分 —— 字段与上面的 `Config` schema 一一对应,
 * 也是归一化之后插件内部使用的形状。
 */
export interface SettingsValue {
  /** 总开关:假 = 插件完全不动作(不监听、不接管策略),一切按原有环境走。 */
  enabled: boolean
  /** 上游代理地址;空串表示沿用环境变量/未配置。 */
  upstream: string
  /** 未命中任何规则时的走向。 */
  defaultRoute: Route
  /** 远程清单 URL 列表(命中的走代理)。 */
  lists: string[]
  /** 远程清单刷新周期(小时),0 = 不自动刷新。 */
  refreshHours: number
  /** 本地分流代理监听地址。 */
  listen: string
  /** 连接超时(毫秒)。 */
  connectTimeoutMs: number
  /** 走上游失败时是否回退直连。 */
  fallbackDirect: boolean
  /** 每次请求打一行分流日志。 */
  debug: boolean
}

/** 只存在于组合配置里的部分(路径类,不进设置页)。 */
export interface CompositionExtras {
  stateDir: string
  rulesFile: string
}

/** 归一化之后的运行时配置。 */
export interface ResolvedConfig extends CompositionExtras {
  enabled: boolean
  upstream: ResolvedUpstream | null
  listen: { host: string; port: number }
  defaultRoute: Route
  lists: RemoteListSpec[]
  refreshHours: number
  debug: boolean
  connectTimeoutMs: number
  fallbackDirect: boolean
}

/** 默认远程清单:被墙域名清单,命中的走代理。 */
export const DEFAULT_LIST_URLS: readonly string[] = [
  'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt',
  'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/greatfire.txt',
]

/** 默认监听地址:固定端口便于排查(curl -x 直接指向它就能验证分流),被占用时自动退到随机端口。 */
export const DEFAULT_LISTEN = '127.0.0.1:17890'
/** 默认连接超时(毫秒)。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** 默认清单刷新周期(小时)。 */
export const DEFAULT_REFRESH_HOURS = 24

/** 设置页 schema 里出现、组合配置里也认的字段名(用于未知字段告警)。 */
const SETTINGS_KEYS = [
  'enabled',
  'upstream',
  'defaultRoute',
  'lists',
  'refreshHours',
  'listen',
  'connectTimeoutMs',
  'fallbackDirect',
  'debug',
] as const
/** 只有组合配置认的字段名。 */
const EXTRAS_KEYS = ['stateDir', 'rulesFile'] as const

/**
 * 插件行配置 schema(dsh 0.1.7 的插件配置契约:宿主读插件模块导出的 `Config`)。
 *
 * `.volatile()` 的含义:这个字段可以在设置页里改、并且**不重挂插件**就生效
 * (宿主把新值写进运行中 fiber 的引用,插件收到 `loader/volatile-update`)。
 * 只有 volatile 字段会出现在设置表单里 —— 因此运行期可调的旋钮全部标了 volatile。
 *
 * `lists` / `stateDir` / `rulesFile` 故意不标 volatile:它们是部署事实或长列表,
 * 不属于「随手改一下」的偏好项,留在 profile 的 cordis.patch.yml 里配置。
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(false)
    .volatile()
    .description('总开关:关(默认)= 插件完全不动作 —— 不监听本地端口、不接管宿主代理策略、不刷清单,一切按原有环境走;开 = 按规则分流'),
  upstream: z
    .string()
    .default('')
    .volatile()
    .description('上游代理地址,例如 http://192.168.3.47:12801;留空则沿用启动环境里的 https_proxy/http_proxy'),
  defaultRoute: z
    .union(['direct', 'proxy'])
    .default('direct')
    .volatile()
    .description('未命中任何规则时的走向:direct 直连(推荐)、proxy 走上游'),
  listen: z
    .string()
    .default(DEFAULT_LISTEN)
    .volatile()
    .description('本地分流代理监听地址(改动会立即重新绑定;端口被占用时自动改用随机端口)'),
  refreshHours: z
    .number()
    .min(0)
    .default(DEFAULT_REFRESH_HOURS)
    .volatile()
    .description('远程被墙清单刷新周期(小时),0 表示不自动刷新'),
  connectTimeoutMs: z
    .number()
    .min(1000)
    .default(DEFAULT_CONNECT_TIMEOUT_MS)
    .volatile()
    .description('建立连接的超时时间(毫秒)'),
  fallbackDirect: z
    .boolean()
    .default(true)
    .volatile()
    .description('走上游失败时自动回退直连'),
  debug: z.boolean().default(false).volatile().description('每次请求在宿主 stderr 打一行分流日志'),
  lists: z
    .array(z.string())
    .default([...DEFAULT_LIST_URLS])
    .description('远程被墙清单 URL;命中的域名走上游代理(只在 profile 配置里改)'),
  stateDir: z.string().default(join(dshHome(), 'proxy-router')).description('本地状态目录:规则文件与清单缓存(只在 profile 配置里改)'),
  rulesFile: z.string().default('').description('本地规则文件路径;留空 = <stateDir>/rules.txt(只在 profile 配置里改)'),
})

/** volatile 字段在运行中的样子:一个可读当前值的引用。 */
export interface VolatileRef<T> {
  get(): T
}

/** 配置对象里本插件用到的字段(宿主已按 schema 校验并补默认值)。 */
export interface PluginConfigLike {
  readonly enabled?: VolatileRef<boolean> | boolean
  readonly upstream?: VolatileRef<string> | string
  readonly defaultRoute?: VolatileRef<Route> | Route
  readonly listen?: VolatileRef<string> | string
  readonly refreshHours?: VolatileRef<number> | number
  readonly connectTimeoutMs?: VolatileRef<number> | number
  readonly fallbackDirect?: VolatileRef<boolean> | boolean
  readonly debug?: VolatileRef<boolean> | boolean
  readonly lists?: readonly string[]
  readonly stateDir?: string
  readonly rulesFile?: string
}

/**
 * 读一个配置字段的当前值。
 *
 * volatile 字段拿到的是引用(`{ get() }`),非 volatile 字段是普通值;两种形态都接受,
 * 这样插件在「宿主没把字段标成 volatile」或「配置来自测试的普通对象」时行为一致。
 */
export function refValue<T>(node: VolatileRef<T> | T | undefined, fallback: T): T {
  if (node === undefined || node === null) return fallback
  if (typeof node === 'object' && 'get' in node && typeof (node as VolatileRef<T>).get === 'function') {
    const value = (node as VolatileRef<T>).get()
    return value === undefined || value === null ? fallback : value
  }
  return node as T
}

/** 当前配置的原始值快照(每次读都取最新值 —— volatile 热更新后的值就在里面)。 */
export function readConfigRaw(config: PluginConfigLike): Record<string, unknown> {
  return {
    // 总开关字段必须在列:漏一个字段的后果不是报错,而是它永远走默认值(这里 = 永远关着)。
    enabled: refValue(config.enabled, false),
    upstream: refValue(config.upstream, ''),
    defaultRoute: refValue(config.defaultRoute, 'direct'),
    listen: refValue(config.listen, DEFAULT_LISTEN),
    refreshHours: refValue(config.refreshHours, DEFAULT_REFRESH_HOURS),
    connectTimeoutMs: refValue(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    fallbackDirect: refValue(config.fallbackDirect, true),
    debug: refValue(config.debug, false),
    lists: config.lists,
    stateDir: config.stateDir,
    rulesFile: config.rulesFile,
  }
}

/** DSH 家目录:优先跟随宿主进程的 DSH_HOME,否则 `~/.dsh`。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 读一个字符串字段,类型不符时告警并回退默认值。 */
function stringField(value: unknown, fallback: string, name: string, log: Logger): string {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') return value.trim()
  log.warn(`配置项 ${name} 不是字符串,已忽略并使用默认值`)
  return fallback
}

/** 读一个布尔字段。 */
function booleanField(value: unknown, fallback: boolean, name: string, log: Logger): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  log.warn(`配置项 ${name} 不是布尔值,已忽略并使用默认值`)
  return fallback
}

/** 读一个数字字段。 */
function numberField(value: unknown, fallback: number, name: string, log: Logger): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return value
  log.warn(`配置项 ${name} 不是数字,已忽略并使用默认值`)
  return fallback
}

/**
 * 解析 `127.0.0.1:17890` / `:17890` 形态的监听地址。
 *
 * **只接受回环地址**。本插件内置的是一个无认证的本地正向代理(调试接口也不鉴权),
 * 绑到 `0.0.0.0` 或内网地址等于给局域网开一个开放代理 —— 所以非回环地址在这里
 * 直接回退到回环并告警,而不是「照你说的绑」。端口保留用户填的值(合法时)。
 */
export function parseListen(value: string, log: Logger): { host: string; port: number } {
  const trimmed = value.trim()
  const parsed = splitHostPort(trimmed === '' ? DEFAULT_LISTEN : trimmed.startsWith(':') ? `127.0.0.1${trimmed}` : trimmed)
  if (parsed === null) {
    log.warn(`listen 配置 "${value}" 不是合法的 host:port,使用默认 ${DEFAULT_LISTEN}`)
    return { host: '127.0.0.1', port: 17890 }
  }
  if (!isLoopbackHost(parsed.host)) {
    log.warn(
      `listen 配置 "${value}" 不是回环地址,已改回 127.0.0.1:${parsed.port} —— ` +
        '本插件的本地代理解析不鉴权,绑非回环等于对局域网开放代理',
    )
    return { host: '127.0.0.1', port: parsed.port }
  }
  return { host: parsed.host, port: parsed.port }
}

/**
 * 把代理 URL 解析成上游连接信息。
 * 只接受 http/https 代理:本插件的上游转发走标准 HTTP 代理协议(CONNECT + 绝对形式),
 * SOCKS 上游需要另外实现握手,这里明确拒绝并给出可读的诊断,而不是静默直连。
 */
export function parseUpstream(
  url: string,
  source: ResolvedUpstream['source'],
): { ok: true; value: ResolvedUpstream } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `不是合法 URL: ${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http:// 或 https:// 的上游代理,收到 ${parsed.protocol}//` }
  }
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  const auth =
    parsed.username === '' && parsed.password === ''
      ? undefined
      : `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`
  return {
    ok: true,
    value: { url: parsed.href, host: parsed.hostname, port, authHeader: auth, source },
  }
}

/** 稳定的小哈希,只为给没起名字的清单生成一个稳定文件名。 */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return hash
}

/** 从清单 URL 里推一个可读的短名字(gfw / greatfire …),用于日志与缓存文件名。 */
export function listNameFromUrl(url: string): string {
  const tail = url.split('@').pop() ?? url
  const segment = tail.split('/').filter((part) => part !== '').pop() ?? tail
  const name = segment.replace(/\.(txt|list|yaml|yml|conf)$/i, '')
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe === '' ? `list${Math.abs(hashString(url)) % 100000}` : safe
}

/** 把一条清单 URL 变成装载层认识的结构。 */
export function listSpecFromUrl(url: string): RemoteListSpec {
  return { name: listNameFromUrl(url), url, route: 'proxy' }
}

/** 设置页字段的统一归一化(设置文档是用户手写的,任何一项都可能是错的)。 */
export function normalizeSettingsValue(raw: unknown, log: Logger): SettingsValue {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const route = record.defaultRoute === 'proxy' ? 'proxy' : 'direct'
  const listsRaw = record.lists
  let lists: string[] = [...DEFAULT_LIST_URLS]
  if (Array.isArray(listsRaw)) {
    lists = listsRaw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  } else if (listsRaw !== undefined) {
    log.warn('配置项 lists 不是字符串数组,已使用默认被墙清单')
  }
  return {
    // 总开关默认「关」:新装/新用户 = 全直连,想用分流得自己打开 —— 避免一个装了就改全局
    // 代理行为的插件在用户没同意的情况下生效。
    enabled: booleanField(record.enabled, false, 'enabled', log),
    upstream: stringField(record.upstream, '', 'upstream', log),
    defaultRoute: route,
    lists,
    refreshHours: Math.max(0, numberField(record.refreshHours, DEFAULT_REFRESH_HOURS, 'refreshHours', log)),
    listen: stringField(record.listen, DEFAULT_LISTEN, 'listen', log),
    connectTimeoutMs: Math.max(1000, numberField(record.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs', log)),
    fallbackDirect: booleanField(record.fallbackDirect, true, 'fallbackDirect', log),
    debug: booleanField(record.debug, false, 'debug', log),
  }
}

/**
 * 组合配置 → 设置页形状(同时也是 installSection 的 base 层)。
 *
 * 旧的组合配置允许 `lists: [{ name, url, route }]`,这里统一压平成 URL 列表:
 * settings 命名空间只认一种形态,免得「文档里是对象、页面里是行」两套语义打架。
 * 需要 route=direct 的清单,用本地规则文件里的 `direct:` 表达。
 */
export function settingsValueFromComposition(raw: unknown, log: Logger): SettingsValue {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const flattened = { ...record }
  if (Array.isArray(record.lists)) {
    flattened.lists = record.lists
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim()
        if (typeof entry === 'object' && entry !== null) {
          const url = (entry as Record<string, unknown>).url
          return typeof url === 'string' ? url.trim() : ''
        }
        return ''
      })
      .filter((url) => url !== '')
  }
  return normalizeSettingsValue(flattened, log)
}

/** 组合配置 → 只留在组合里的路径类字段。 */
export function compositionExtrasFrom(raw: unknown, log: Logger): CompositionExtras {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if ((SETTINGS_KEYS as readonly string[]).includes(key)) continue
    if ((EXTRAS_KEYS as readonly string[]).includes(key)) continue
    log.warn(`配置里有未知字段 "${key}",已忽略`)
  }
  const stateDir = stringField(record.stateDir, join(dshHome(), 'proxy-router'), 'stateDir', log)
  // 空串 = 没配:默认落在状态目录里,保证「改完即时生效」的那个文件总在同一个地方。
  const configuredRules = stringField(record.rulesFile, '', 'rulesFile', log)
  const rulesFile = configuredRules === '' ? join(stateDir, 'rules.txt') : configuredRules
  return { stateDir, rulesFile }
}

/**
 * 设置值 + 组合附加项 → 运行时配置。
 *
 * 上游代理的兜底顺序:设置里的非空值 → 环境变量 https_proxy / http_proxy / all_proxy。
 * 环境变量兜底是给「先 export 再启动」的老习惯留的后路,但它只影响主进程:
 * bash 子进程的口径由宿主启动时的快照决定(见 host-policy.ts 的告警)。
 */
export function resolveRuntimeConfig(
  value: SettingsValue,
  extras: CompositionExtras,
  envLookup: (name: string) => string | undefined,
  log: Logger,
): ResolvedConfig {
  let upstream: ResolvedUpstream | null = null
  const explicit = value.upstream.trim()
  if (explicit !== '') {
    const parsed = parseUpstream(explicit, 'config')
    if (parsed.ok) upstream = parsed.value
    else log.warn(`上游代理配置不可用(${parsed.reason}),将尝试环境变量里的代理`)
  }
  if (upstream === null) {
    const candidates: [ResolvedUpstream['source'], string][] = [
      ['env:https_proxy', 'https_proxy'],
      ['env:http_proxy', 'http_proxy'],
      ['env:all_proxy', 'all_proxy'],
    ]
    for (const [source, name] of candidates) {
      const envValue = envLookup(name) ?? envLookup(name.toUpperCase())
      if (envValue === undefined || envValue.trim() === '') continue
      const parsed = parseUpstream(envValue.trim(), source)
      if (parsed.ok) {
        upstream = parsed.value
        break
      }
      log.warn(`环境变量 ${name} 不可用(${parsed.reason}),继续找下一个`)
    }
  }

  return {
    ...extras,
    enabled: value.enabled,
    upstream,
    listen: parseListen(value.listen, log),
    defaultRoute: value.defaultRoute,
    lists: value.lists.map((url) => listSpecFromUrl(url)),
    refreshHours: value.refreshHours,
    debug: value.debug,
    connectTimeoutMs: value.connectTimeoutMs,
    fallbackDirect: value.fallbackDirect,
  }
}
