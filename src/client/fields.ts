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

/** 宿主挂的只读状态路由(卡片读它显示运行态;同源,无 CORS)。 */
export const STATUS_PATH = '/dsh-proxy-router/status'

/** 状态接口返回的形状(只取卡片要显示的部分)。 */
export interface HostStatus {
  settingsRegistered?: boolean
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
 */
export function listenField(): SettingsFieldSpec {
  return {
    field: 'listen',
    format: textOf,
    parse: (text): SettingsFieldWrite | undefined => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const at = trimmed.lastIndexOf(':')
      if (at <= 0) return undefined
      const host = trimmed.slice(0, at).trim()
      const port = Number(trimmed.slice(at + 1))
      if (host === '' || !/^\d{1,5}$/.test(trimmed.slice(at + 1))) return undefined
      if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
      return { kind: 'set', value: `${host}:${port}` }
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
