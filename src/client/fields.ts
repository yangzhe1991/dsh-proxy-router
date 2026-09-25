/**
 * 配置卡片用到的字段定义与纯函数。
 *
 * dsh 0.1.7 的设置表单契约(`@deepseek-ai/dsh-client-ui-primitives` 的
 * `SettingsFormModel`)把「字段怎么显示 / 怎么校验 / 文本怎么变回设置值」
 * 收进 `SettingsFieldSpec`;primitives 只自带 text/number 两个 spec,
 * 上游地址、监听地址、布尔开关这些本插件特有的规则写在下面,
 * 组件只负责渲染。
 */
import type { SettingsFieldSpec, SettingsFieldWrite } from '@deepseek-ai/dsh-client-ui-primitives'
import { isLoopbackHost, splitHostPort } from '../loopback.ts'

/** 宿主挂的只读状态路由(分区读它显示运行态;同源,无 CORS)。 */
export const STATUS_PATH = '/dsh-proxy-router/status'

/** 宿主挂的本地规则文件读写路由(分区里的规则编辑区用它)。 */
export const RULES_PATH = '/dsh-proxy-router/rules'

/** 状态接口返回的形状(只取分区要显示的部分)。 */
export interface HostStatus {
  settingsRegistered?: boolean
  /** 总开关:假 = 插件完全不动作(不监听、不接管策略、不刷清单)。 */
  enabled?: boolean
  listening?: { host: string; port: number } | null
  upstream?: { url: string; source: string } | null
  /** 配置了上游但被判定为指向插件自己(会被忽略)时由宿主置真。 */
  upstreamIgnored?: boolean
  defaultRoute?: string
  rules?: { local: number; remote: number; seed: number }
  rulesFile?: string
  lists?: { name: string; count: number; fetchedAt: string | null; stale: boolean; lastError: string | null }[]
  stats?: { total: number; direct: number; proxied: number; failed: number; fallback: number } | null
  policy?: { verified: boolean; childRouting: 'router' | 'upstream' | 'none'; modulePath: string } | null
}

/** 本地规则文件接口返回的形状(GET 与 PUT 回执同一份口径)。 */
export interface RulesSnapshot {
  path: string
  exists: boolean
  content: string
  /** 解析摘要:总条数与按动作拆开的条数,skipped = 无法识别的行数。 */
  summary?: { total: number; proxy: number; direct: number; skipped: number }
  /** 无法识别的行(带行号),编辑器直接显示出来。 */
  issues?: { line: number; text: string }[]
  /** 保存回执:是否已写盘、备份路径、当前是否已在运行中生效。 */
  ok?: boolean
  backupPath?: string | null
  applied?: boolean
  error?: string
}

/** 读一个设置值成草稿文本;缺省用空串表示「没有覆盖」。 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * 上游代理字段:空草稿 = 清除覆盖(回落到环境变量/默认)。
 * 非空时必须是 http(s) 代理:写错格式就标红并拦住保存,而不是静默写进配置。
 */
export function upstreamField(): SettingsFieldSpec {
  return {
    field: 'upstream',
    format: textOf,
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (!/^https?:\/\//i.test(trimmed)) return undefined
      try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
      } catch {
        return undefined
      }
      return { kind: 'set', value: trimmed }
    },
  }
}

/**
 * 监听地址字段:`host:port`,空草稿 = 清除覆盖(回到默认 127.0.0.1:17890)。
 * 端口 0 表示「让系统分配」(排查时有用),所以 0 是合法的。
 *
 * **只接受回环地址**:本插件内置的本地代理不鉴权(连调试接口都没有鉴权),
 * 绑非回环 = 在局域网里开一个开放代理。这里先拦一道给出「格式不对」,
 * 宿主侧 `parseListen` 还会再拦一道(防止有人直接改 profile 文件)。
 */
export function listenField(): SettingsFieldSpec {
  return {
    field: 'listen',
    format: textOf,
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = splitHostPort(trimmed)
      if (parsed === null || !isLoopbackHost(parsed.host)) return undefined
      // IPv6 用方括号形态回写,免得 `::1:17890` 这种歧义写法流进配置文件
      const host = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host
      return { kind: 'set', value: `${host}:${parsed.port}` }
    },
  }
}

/** 未命中规则时的走向:只认 direct / proxy(空草稿 = 清除覆盖)。 */
export function routeField(): SettingsFieldSpec {
  return {
    field: 'defaultRoute',
    format: (value) => (value === undefined || value === null ? '' : String(value)),
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed !== 'direct' && trimmed !== 'proxy') return undefined
      return { kind: 'set', value: trimmed }
    },
  }
}

/**
 * 布尔字段(direct / proxy 之外的那些开关)。
 * 接受 true/false/1/0/on/off(大小写不敏感);空草稿 = 清除覆盖。
 */
export function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? (value ? 'true' : 'false') : ''),
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === '') return { kind: 'clear' }
      if (['true', '1', 'on', 'yes'].includes(trimmed)) return { kind: 'set', value: true }
      if (['false', '0', 'off', 'no'].includes(trimmed)) return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** 非负整数字段(refreshHours:0 表示不自动刷新)。 */
export function nonNegativeNumberField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === undefined || value === null ? '' : String(value)),
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (!/^\d+$/.test(trimmed)) return undefined
      return { kind: 'set', value: Number(trimmed) }
    },
  }
}

/** 毫秒字段:至少 1000,避免把超时配成 0 变成「立刻失败」。 */
export function millisecondsField(field: string, minimum: number): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === undefined || value === null ? '' : String(value)),
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (!/^\d+$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      if (value < minimum) return undefined
      return { kind: 'set', value }
    },
  }
}
