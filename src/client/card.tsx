/**
 * Plugins 页里的配置卡片(dsh 0.1.7 契约)。
 *
 * 数据面:
 *   - 配置值/保存走官方共享表单 —— `ctx.configForms.get('proxy-router')` 给出这一行的
 *     scope,`SettingsFormModel` 在其上做「暂存草稿、点保存才写」;写回的是 profile
 *     用户层(cordis.patch.yml),宿主按 Config schema 校验,volatile 字段热生效;
 *   - 运行态读宿主 Web 上的 `/dsh-proxy-router/status` 只读路由(同源)。
 *
 * 卡片自己只负责:字段顺序与文案、每个字段的校验规则(见 fields.ts)、以及状态面板。
 * 表单外壳(不可用提示、只读提示、保存/失败文案)由 `SettingsForm` 提供。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  booleanField,
  listenField,
  millisecondsField,
  nonNegativeNumberField,
  routeField,
  STATUS_PATH,
  upstreamField,
  type HostStatus,
} from './fields.js'

/** 设置命名空间 = 插件行 id(与宿主半、行 id 三处必须一致)。 */
export const NAMESPACE = 'proxy-router'

/** 卡片文案。 */
const TEXT = {
  summary: '本地分流代理:只有规则命中的被墙域名走上游,其余直连;上游、监听地址等在 Plugins 页里改,热生效',
  unavailable: '当前部署没有把这一行的配置暴露给浏览器(设置服务不可用)。',
  readOnly: '当前部署的配置是只读的,改动不会被保存。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '宿主没有接受这些值,已保留供你修改。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '格式不对',
  statusTitle: '运行状态',
  statusLoading: '正在读取运行状态…',
  statusFailed: '读不到运行状态:宿主插件可能没加载,或状态路由不可用。',
  refresh: '刷新',
  listening: '监听地址',
  upstream: '上游代理',
  upstreamNone: '(未配置)',
  upstreamIgnored: '(指向本插件自己的地址,已忽略)',
  policy: '宿主策略',
  policyNone: '未接管',
  rules: '规则条数',
  requests: '请求统计',
  lists: '远程清单',
}

/** 卡片状态:表单外壳状态 + 每个字段的草稿状态。 */
export interface ProxyRouterCardState extends SettingsFormShell {
  upstream: SettingsFieldState
  defaultRoute: SettingsFieldState
  listen: SettingsFieldState
  refreshHours: SettingsFieldState
  connectTimeoutMs: SettingsFieldState
  fallbackDirect: SettingsFieldState
  debug: SettingsFieldState
}

/** 卡片组件收到的 props:页面的 view/form + 注入的面 + 本卡的快照 hook。 */
export interface ProxyRouterCardProps extends PluginConfigViewProps, SettingsFormActions {
  useProxyRouterCard: SnapshotSelectorHook<ProxyRouterCardState>
}

/**
 * 卡片控制器:把共享表单模型包成「一个可注入的 hook + 一组动作」。
 * 与官方设置页(ui-settings-agent-loop 等)同构。
 */
export class ProxyRouterCardController {
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly store: SnapshotStore<ProxyRouterCardState>

  /** @param scope - 绑到 `proxy-router` 这一行的共享表单。 */
  constructor(scope: SettingsFormScope<Record<string, unknown>>) {
    this.form = new SettingsFormModel<Record<string, unknown>>(scope, [
      upstreamField(),
      routeField(),
      listenField(),
      nonNegativeNumberField('refreshHours'),
      millisecondsField('connectTimeoutMs', 1000),
      booleanField('fallbackDirect'),
      booleanField('debug'),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      upstream: this.form.field('upstream'),
      defaultRoute: this.form.field('defaultRoute'),
      listen: this.form.field('listen'),
      refreshHours: this.form.field('refreshHours'),
      connectTimeoutMs: this.form.field('connectTimeoutMs'),
      fallbackDirect: this.form.field('fallbackDirect'),
      debug: this.form.field('debug'),
    }))
  }

  /** 卡片注入进 slot 的面:快照 hook 的来源 + 编辑动作。 */
  inject(): { hooks: { proxyRouterCard: SnapshotStore<ProxyRouterCardState> } } & SettingsFormActions {
    return { hooks: { proxyRouterCard: this.store }, ...this.form.actions() }
  }

  /** 释放表单对宿主值的订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}

/** 拉一次运行状态;失败只标记错误,不抛。 */
function useHostStatus(active: boolean): { status: HostStatus | null; error: boolean; refresh: () => void } {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as HostStatus
        if (cancelled) return
        setStatus(payload)
        setError(false)
      } catch {
        if (cancelled) return
        setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, nonce])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])
  return { status, error, refresh }
}

/** 一行「名称:值」的状态展示。 */
function StatusRow(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="dsh-proxy-router-row">
      <span className="dsh-proxy-router-rowLabel">{props.label}</span>
      <span className="dsh-proxy-router-rowValue">{props.children}</span>
    </div>
  )
}

/** 运行状态面板:读宿主的状态路由,显示监听地址、上游、策略与计数。 */
function StatusPanel(): JSX.Element {
  const { status, error, refresh } = useHostStatus(true)
  return (
    <section className="dsh-proxy-router-status">
      <header className="dsh-proxy-router-statusHead">
        <h4 className="dsh-proxy-router-statusTitle">{TEXT.statusTitle}</h4>
        <button type="button" className="dsh-proxy-router-refresh" onClick={refresh}>
          {TEXT.refresh}
        </button>
      </header>
      {error ? <p className="dsh-proxy-router-warn">{TEXT.statusFailed}</p> : null}
      {status === null && !error ? <p className="dsh-proxy-router-muted">{TEXT.statusLoading}</p> : null}
      {status !== null ? (
        <div className="dsh-proxy-router-rows">
          <StatusRow label={TEXT.listening}>
            {status.listening === null || status.listening === undefined
              ? '—'
              : `${status.listening.host}:${status.listening.port}`}
          </StatusRow>
          <StatusRow label={TEXT.upstream}>
            {status.upstream === null || status.upstream === undefined ? TEXT.upstreamNone : status.upstream.url}
            {status.upstreamIgnored === true ? ` ${TEXT.upstreamIgnored}` : ''}
          </StatusRow>
          <StatusRow label={TEXT.policy}>
            {status.policy === null || status.policy === undefined
              ? TEXT.policyNone
              : `${status.policy.childRouting}${status.policy.verified ? ' (自检通过)' : ' (自检未通过)'}`}
          </StatusRow>
          <StatusRow label={TEXT.rules}>
            {status.rules === undefined
              ? '—'
              : `本地 ${status.rules.local} / 远程 ${status.rules.remote} / 内置 ${status.rules.seed}`}
          </StatusRow>
          <StatusRow label={TEXT.requests}>
            {status.stats === null || status.stats === undefined
              ? '—'
              : `合计 ${status.stats.total} · 直连 ${status.stats.direct} · 代理 ${status.stats.proxied} · 失败 ${status.stats.failed}`}
          </StatusRow>
          <StatusRow label={TEXT.lists}>
            {status.lists === undefined || status.lists.length === 0
              ? '—'
              : status.lists.map((list) => `${list.name} ${list.count}${list.stale ? '(过期)' : ''}`).join(' · ')}
          </StatusRow>
        </div>
      ) : null}
    </section>
  )
}

/** 卡片可编辑字段的键(表单模型里注册了 spec 的那几个)。 */
type FieldKey = 'upstream' | 'defaultRoute' | 'listen' | 'refreshHours' | 'connectTimeoutMs' | 'fallbackDirect' | 'debug'

/** 字段清单:顺序即渲染顺序(与 fields.ts 里的 spec 一一对应)。 */
const FIELDS: readonly {
  id: string
  label: string
  hint: string
  key: FieldKey
  numeric?: boolean
}[] = [
  {
    id: 'plugin-config-proxy-router-upstream',
    label: '上游代理',
    hint: '例如 http://192.168.3.47:12801;留空 = 沿用启动环境里的 https_proxy / http_proxy',
    key: 'upstream',
  },
  {
    id: 'plugin-config-proxy-router-default-route',
    label: '未命中规则时',
    hint: 'direct = 直连(推荐);proxy = 走上游代理',
    key: 'defaultRoute',
  },
  {
    id: 'plugin-config-proxy-router-listen',
    label: '监听地址',
    hint: '形如 127.0.0.1:17890;端口 0 = 让系统分配。改动会立即重新绑定并改宿主策略',
    key: 'listen',
  },
  {
    id: 'plugin-config-proxy-router-refresh-hours',
    label: '清单刷新周期(小时)',
    hint: '0 = 不自动刷新,只用手上已有的缓存',
    key: 'refreshHours',
    numeric: true,
  },
  {
    id: 'plugin-config-proxy-router-connect-timeout',
    label: '连接超时(毫秒)',
    hint: '建立 TCP/上游连接的上限,至少 1000',
    key: 'connectTimeoutMs',
    numeric: true,
  },
  {
    id: 'plugin-config-proxy-router-fallback-direct',
    label: '上游失败时回退直连',
    hint: 'true / false',
    key: 'fallbackDirect',
  },
  { id: 'plugin-config-proxy-router-debug', label: '打印分流日志', hint: 'true / false;排查时打开', key: 'debug' },
]

/**
 * 卡片组件:Plugins 页按 `view: 'summary' | 'page'` 调它。
 * summary 只给一句话(行的描述缺失时页面会用它),page 渲染状态面板 + 设置表单。
 */
export function ProxyRouterCard(props: ProxyRouterCardProps): JSX.Element {
  const state = props.useProxyRouterCard((snapshot) => snapshot)
  if (props.view === 'summary') return <>{TEXT.summary}</>

  return (
    <div className="dsh-proxy-router-card">
      <StatusPanel />
      <SettingsForm
        labels={{
          unavailable: TEXT.unavailable,
          readOnly: TEXT.readOnly,
          saveFailed: TEXT.saveFailed,
          save: TEXT.save,
          saving: TEXT.saving,
        }}
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <div className="dsh-proxy-router-fields">
          {FIELDS.map((entry) => (
            <SettingsValueField
              key={entry.id}
              id={entry.id}
              label={entry.label}
              hint={entry.hint}
              overriddenLabel={TEXT.overridden}
              resetLabel={TEXT.reset}
              invalidLabel={TEXT.invalid}
              numeric={entry.numeric === true}
              disabled={!state.writable}
              {...state[entry.key]}
              onEdit={(text) => props.edit(String(entry.key), text)}
              onReset={() => props.resetField(String(entry.key))}
            />
          ))}
        </div>
      </SettingsForm>
    </div>
  )
}

/** 卡片样式:沿用 DSW 的 css 变量,不引入额外依赖。 */
export const CARD_CSS = `
.dsh-proxy-router-card{display:flex;flex-direction:column;gap:16px}
.dsh-proxy-router-status{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px}
.dsh-proxy-router-statusHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-proxy-router-statusTitle{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-proxy-router-refresh{background:0 0;border:0;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;padding:0}
.dsh-proxy-router-refresh:hover{color:var(--dsw-alias-label-primary)}
.dsh-proxy-router-rows{display:flex;flex-direction:column;gap:4px}
.dsh-proxy-router-row{display:flex;gap:12px;font-size:12px;line-height:18px}
.dsh-proxy-router-rowLabel{color:var(--dsw-alias-label-tertiary);flex:none;min-width:72px}
.dsh-proxy-router-rowValue{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;min-width:0}
.dsh-proxy-router-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dsh-proxy-router-warn{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}
.dsh-proxy-router-fields{display:flex;flex-direction:column;gap:12px}
`
