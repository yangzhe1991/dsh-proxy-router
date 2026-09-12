/**
 * 配置卡片用到的字段定义与纯函数(取值、格式化、校验、反解析)。
 *
 * 刻意把「怎么显示 / 怎么校验 / 怎么把文本变成设置值」放在这里而不是组件里:
 * 这些规则可以直接单测,组件只负责渲染与交互。
 */

/** 一个字段的渲染与解析规则。 */
export interface FieldSpec {
  /** 设置命名空间里的字段名。 */
  key: string
  label: string
  hint: string
  kind: 'text' | 'number' | 'switch' | 'choice' | 'lines'
  /** choice 类型的可选项。 */
  choices?: { value: string; label: string }[]
}

/** 卡片上的全部字段(顺序即渲染顺序)。 */
export const FIELDS: FieldSpec[] = [
  {
    key: 'upstream',
    label: '上游代理',
    hint: '例如 http://192.168.3.47:12801;留空则沿用启动环境里的 https_proxy / http_proxy',
    kind: 'text',
  },
  {
    key: 'defaultRoute',
    label: '未命中任何规则时',
    hint: '推荐「直连」:只有清单/本地规则命中的被墙域名才走上游代理',
    kind: 'choice',
    choices: [
      { value: 'direct', label: '直连' },
      { value: 'proxy', label: '走上游代理' },
    ],
  },
  {
    key: 'lists',
    label: '远程被墙清单',
    hint: '一行一个 URL;命中的域名走上游代理。清空即不加载任何远程清单',
    kind: 'lines',
  },
  {
    key: 'refreshHours',
    label: '清单刷新周期(小时)',
    hint: '0 表示不自动刷新,只用手上已有的缓存',
    kind: 'number',
  },
  {
    key: 'listen',
    label: '本地分流代理监听地址',
    hint: '形如 127.0.0.1:17890;改动会立即重新绑定,并把宿主策略指过去',
    kind: 'text',
  },
  {
    key: 'connectTimeoutMs',
    label: '连接超时(毫秒)',
    hint: '建立 TCP/上游连接的上限;不影响已建立的隧道与流式响应',
    kind: 'number',
  },
  {
    key: 'fallbackDirect',
    label: '上游失败时回退直连',
    hint: '走上游的连接失败时自动改用直连(客户端还没收到任何字节时才可能回退)',
    kind: 'switch',
  },
  {
    key: 'debug',
    label: '打印每次请求的分流日志',
    hint: '在宿主 stderr 输出一行 CONNECT/GET → direct|proxy,排查时打开',
    kind: 'switch',
  },
]

/** 把设置值渲染成控件里的文本。 */
export function toText(kind: FieldSpec['kind'], value: unknown): string {
  if (kind === 'lines') {
    if (!Array.isArray(value)) return ''
    return value.filter((entry) => typeof entry === 'string').join('\n')
  }
  if (kind === 'switch') return value === true ? 'true' : 'false'
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * 校验一段草稿文本。
 * @returns 错误文案;`undefined` 表示这段草稿可以保存。
 */
export function validate(kind: FieldSpec['kind'], key: string, text: string): string | undefined {
  switch (kind) {
    case 'text': {
      if (key === 'upstream') {
        const trimmed = text.trim()
        if (trimmed === '') return undefined
        if (!/^https?:\/\//i.test(trimmed)) return '只支持 http:// 或 https:// 的代理地址'
        return undefined
      }
      if (key === 'listen') {
        const trimmed = text.trim()
        if (!/^[^\s:]+:\d{1,5}$/.test(trimmed)) return '形如 127.0.0.1:17890'
        const port = Number(trimmed.slice(trimmed.lastIndexOf(':') + 1))
        if (!Number.isInteger(port) || port < 0 || port > 65535) return '端口需要在 0-65535 之间'
        return undefined
      }
      return undefined
    }
    case 'number': {
      const trimmed = text.trim()
      if (trimmed === '' || !/^\d+$/.test(trimmed)) return '需要一个非负整数'
      const value = Number(trimmed)
      if (key === 'connectTimeoutMs' && value < 1000) return '至少 1000 毫秒'
      return undefined
    }
    case 'lines': {
      const bad = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .find((line) => !/^https?:\/\//i.test(line))
      return bad === undefined ? undefined : `不是合法 URL:${bad}`
    }
    default:
      return undefined
  }
}

/** 把草稿文本变成要写进设置文档的值(调用前必须已通过 {@link validate})。 */
export function parseDraft(kind: FieldSpec['kind'], text: string): unknown {
  switch (kind) {
    case 'switch':
      return text === 'true'
    case 'number':
      return Number(text.trim())
    case 'lines':
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    default:
      return text.trim()
  }
}

/** 设置文档里的 user 层是否覆盖了这个字段(覆盖与值无关,只看 key 在不在)。 */
export function isOverridden(user: unknown, key: string): boolean {
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, key)
}

/** 状态接口返回的形状(只取卡片要显示的部分)。 */
export interface HostStatus {
  settingsRegistered?: boolean
  listening?: { host: string; port: number } | null
  upstream?: { url: string; source: string } | null
  defaultRoute?: string
  rules?: { local: number; remote: number; seed: number }
  rulesFile?: string
  lists?: { name: string; count: number; fetchedAt: string | null; stale: boolean; lastError: string | null }[]
  stats?: { total: number; direct: number; proxied: number; failed: number; fallback: number } | null
  policy?: { verified: boolean; childRouting: 'router' | 'upstream' | 'none'; modulePath: string } | null
}
