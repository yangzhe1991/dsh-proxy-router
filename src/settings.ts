/**
 * 设置命名空间接入:把插件的可配置字段注册进宿主的用户设置文档
 * (`$DSH_HOME/settings.yaml`),从而出现在 Web 设置 →「插件」→「插件配置」页面里,
 * 由本插件的浏览器半渲染成一张卡片。
 *
 * 用的是官方提供的 `ctx.settings.installSection(owner, ns, schema, entry, hooks)`:
 *   - 宿主设置服务在 → namespace 注册成功,解析值 = schema 默认 + 组合配置 + 用户覆盖,
 *     并且每次提交都会回调 onChange,插件据此**热应用**新配置(不重启宿主);
 *   - 宿主设置服务不在(比如没挂 settings 提供方的组合)→ 直接退回组合配置,
 *     行为与没有这个功能时完全一致。
 *
 * schema 用 schemastery(宿主自带的版本,通过 host-modules 解析同一份实例):
 * 设置页要拿到序列化 schema 才能重建表单与做服务端校验,所以这里不能自己造 schema 对象。
 */
import { loadHostModule } from './host-modules.js'
import type { Logger } from './fetcher.js'
import { normalizeSettingsValue, parseUpstream, type SettingsValue } from './config.js'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_LISTEN,
  DEFAULT_LIST_URLS,
  DEFAULT_REFRESH_HOURS,
} from './config.js'

/** 设置命名空间名(= 卡片在 `settings.plugin.item` 槽位里的 key,两边必须一致)。 */
export const PROXY_ROUTER_NAMESPACE = 'proxy-router'

/** schemastery 节点的最小形状:只需要链式调用,不需要它的类型体操。 */
interface SchemaNode {
  default(value: unknown): SchemaNode
  description(text: string): SchemaNode
  min(value: number): SchemaNode
}

/** schemastery 入口的最小形状。 */
interface SchemasteryLike {
  object(dict: Record<string, unknown>): SchemaNode
  string(): SchemaNode
  number(): SchemaNode
  boolean(): SchemaNode
  array(inner: unknown): SchemaNode
  union(list: readonly unknown[]): SchemaNode
}

/** 宿主设置服务里本插件用到的那部分形状。 */
interface SettingsProviderLike {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: {
      setSource(current: () => unknown): void
      onChange(): void
      validate?(value: unknown): void
    },
  ): void
}

/** 插件 apply 收到的上下文里,本文件用到的部分。 */
export interface SettingsContextLike {
  get?(name: string): unknown
  /** 服务可用时执行回调(cordis 的 inject:不阻塞插件本身,服务晚到也能接上)。 */
  inject?(deps: readonly string[], callback: (ctx: SettingsContextLike) => unknown): unknown
}

/** 设置接入结果。 */
export interface SettingsInstallation {
  /** 当前生效的设置值(设置服务缺失时就是组合配置)。 */
  current(): SettingsValue
  /** 是否已经注册进宿主设置文档(没注册就不会出现在设置页里);随注入时机变化,所以是函数。 */
  isRegistered(): boolean
  /** 诊断用:schema 是否从宿主解析到。 */
  schemaLoaded: boolean
}

/**
 * 取宿主的 schemastery。
 *
 * 包的主入口在 `require` 条件下是 CJS(`lib/index.cjs`),ESM 下拿到的是
 * `{ default: Schema }`,所以这里做一次 interop 兜底。
 */
async function loadSchemaBuilder(log: Logger): Promise<SchemasteryLike | null> {
  const loaded = await loadHostModule<Record<string, unknown>>('@deepseek-ai/schemastery')
  if (loaded === undefined) {
    log.warn('解析不到宿主的 @deepseek-ai/schemastery,设置页不可用(其余功能不受影响)')
    return null
  }
  const candidate = (loaded.mod.default ?? loaded.mod) as Partial<SchemasteryLike>
  if (typeof candidate.object !== 'function') {
    log.warn(`宿主的 schemastery 形状不符(来自 ${loaded.path}),设置页不可用`)
    return null
  }
  return candidate as SchemasteryLike
}

/**
 * 构建命名空间 schema。
 *
 * 每个字段都带 default:设置文档里删掉一行就等于回到这里的默认值 ——
 * 「恢复默认」在设置页上就是把用户层那个 key 删掉。
 */
function buildSchema(z: SchemasteryLike): SchemaNode {
  return z.object({
    upstream: z
      .string()
      .default('')
      .description('上游代理地址,例如 http://192.168.3.47:12801;留空则沿用启动环境里的 https_proxy/http_proxy'),
    defaultRoute: z
      .union(['direct', 'proxy'])
      .default('direct')
      .description('未命中任何规则时的走向:direct 直连(推荐)、proxy 走上游'),
    lists: z
      .array(z.string())
      .default([...DEFAULT_LIST_URLS])
      .description('远程被墙清单 URL,一行一个;命中的域名走上游代理'),
    refreshHours: z
      .number()
      .min(0)
      .default(DEFAULT_REFRESH_HOURS)
      .description('远程清单刷新周期(小时),0 表示不自动刷新'),
    listen: z.string().default(DEFAULT_LISTEN).description('本地分流代理监听地址(改动会立即重新绑定)'),
    connectTimeoutMs: z
      .number()
      .min(1000)
      .default(DEFAULT_CONNECT_TIMEOUT_MS)
      .description('建立连接的超时时间(毫秒)'),
    fallbackDirect: z.boolean().default(true).description('走上游失败时自动回退直连'),
    debug: z.boolean().default(false).description('每次请求在宿主 stderr 打一行分流日志'),
  })
}

export interface InstallSettingsOptions {
  /** 组合配置归一化出来的设置值,作为 base 层与兜底值。 */
  entry: SettingsValue
  log: Logger
  /** 配置发生变化(或首次安装)时的回调,插件据此热应用。 */
  onChange(next: SettingsValue): void
}

/**
 * 注册设置命名空间。任何一步失败都只记日志并退回组合配置,不抛错。
 */
export async function installSettingsSection(
  ctx: SettingsContextLike,
  options: InstallSettingsOptions,
): Promise<SettingsInstallation> {
  const { log, entry } = options
  const schema = await loadSchemaBuilder(log)
  // setSource 给的是「当前权威值」的 thunk:设置服务在时是解析后的设置值,
  // 服务卸载/未安装时就是组合配置 —— 所以 current() 永远只读这一个来源。
  let source: () => unknown = () => entry
  let registered = false
  if (schema === null) return { current: () => normalizeSettingsValue(source(), log), isRegistered: () => registered, schemaLoaded: false }

  const install = (provider: SettingsProviderLike): void => {
    try {
      provider.installSection(ctx, PROXY_ROUTER_NAMESPACE, buildSchema(schema), entry, {
        setSource(current) {
          source = current
        },
        onChange() {
          options.onChange(normalizeSettingsValue(source(), log))
        },
        validate(value) {
          // 只拦下 schema 表达不了的约束:上游必须是 http(s) 代理
          const upstream = (value as SettingsValue | undefined)?.upstream?.trim() ?? ''
          if (upstream === '') return
          const parsed = parseUpstream(upstream, 'config')
          if (!parsed.ok) throw new Error(`上游代理不可用:${parsed.reason}`)
        },
      })
      registered = true
      log.debug(`设置命名空间 ${PROXY_ROUTER_NAMESPACE} 已注册`)
    } catch (error) {
      log.warn(`注册设置命名空间失败(${String(error)}),设置页不可用,配置沿用 profile 组合配置`)
    }
  }

  // 官方消费方(如 dsh-tool-subagent)用的就是这个形态:用 inject 等设置服务上线,
  // 而不是把 settings 声明成硬依赖 —— 没挂设置提供方的部署里,插件照常工作,
  // 只是没有设置页(回退到组合配置)。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        const provider = settingsCtx.get?.('settings') as SettingsProviderLike | undefined
        if (provider === undefined || typeof provider.installSection !== 'function') {
          log.debug('宿主未挂载设置提供方(ctx.settings),设置页不可用,配置沿用 profile 组合配置')
          return
        }
        install(provider)
      })
    } catch (error) {
      log.warn(`等待设置服务失败(${String(error)}),设置页不可用`)
    }
  } else {
    const provider = ctx.get?.('settings') as SettingsProviderLike | undefined
    if (provider !== undefined && typeof provider.installSection === 'function') install(provider)
    else log.debug('宿主未挂载设置提供方(ctx.settings),设置页不可用,配置沿用 profile 组合配置')
  }

  return {
    current: () => normalizeSettingsValue(source(), log),
    isRegistered: () => registered,
    schemaLoaded: true,
  }
}
