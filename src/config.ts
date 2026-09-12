/**
 * 配置层:把两个来源的配置归一化成插件内部用的完整配置。
 *
 * 来源与优先级(高 → 低):
 *   1. 用户设置文档 `$DSH_HOME/settings.yaml` 的 `proxy-router:` 分节(设置页写的就是这里,热生效)
 *   2. profile 组合配置(`cordis.patch.yml` 里的行 config),作为 base/部署默认值
 *   3. 下面是 schema 默认值,再下面是环境变量兜底(仅上游代理)
 *
 * 只有路径类字段(stateDir / rulesFile)留在组合配置里、不进设置页:
 * 它们是部署事实,不是用户偏好。
 *
 * 归一化原则:每个字段都有默认值,配置写错类型只警告并回退默认值,**绝不抛错** ——
 * 插件装错配置最坏的结果应该是「不生效」,而不是把宿主启动搞挂。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * 设置页可编辑的那部分 —— 字段与 `settings.ts` 里的 schema 一一对应,
 * 也是写进 `settings.yaml` 的形状。
 */
export interface SettingsValue {
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

/** 解析 `127.0.0.1:17890` / `:17890` 形态的监听地址。 */
export function parseListen(value: string, log: Logger): { host: string; port: number } {
  const trimmed = value.trim()
  const at = trimmed.lastIndexOf(':')
  if (at === -1) {
    log.warn(`listen 配置 "${value}" 缺少端口,使用默认 ${DEFAULT_LISTEN}`)
    return { host: '127.0.0.1', port: 17890 }
  }
  const host = trimmed.slice(0, at).trim() === '' ? '127.0.0.1' : trimmed.slice(0, at).trim()
  const port = Number(trimmed.slice(at + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.warn(`listen 配置 "${value}" 端口非法,使用默认 ${DEFAULT_LISTEN}`)
    return { host: '127.0.0.1', port: 17890 }
  }
  return { host, port }
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
  const rulesFile = stringField(record.rulesFile, join(stateDir, 'rules.txt'), 'rulesFile', log)
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
