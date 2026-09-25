/**
 * 设置页里的「分流代理」分区(与 dsh-im 的「IM机器人」同款落点)。
 *
 * 数据面:
 *   - 配置值/保存走官方共享表单 —— `ctx.configForms.get('proxy-router')` 给出这一行的
 *     scope,`SettingsFormModel` 在其上做「暂存草稿、点保存才写」;写回的是 profile
 *     用户层(cordis.patch.yml),宿主按 Config schema 校验,volatile 字段热生效;
 *   - 运行态读宿主 Web 上的 `/dsh-proxy-router/status` 只读路由(同源)。
 *
 * 分区自己只负责:字段顺序与文案、每个字段的校验规则(见 fields.ts)、以及状态面板。
 * 表单外壳(不可用提示、只读提示、保存/失败文案)由 `SettingsForm` 提供。
 *
 * props 契约来自官方槽位表:`PropsRuntime<'settings.section'>`(分区 owner 面)+
 * `InjectFace`(注册时 `inject` 交出来的面:`hooks` 里的 store 会变成 `useXxx` 选择器
 * hook,其余成员原样透传 —— 所以下面的 `hooks.proxyRouterSection` 对应组件收到的
 * `useProxyRouterSection`)。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
// 触发 `settings.section` 槽位的类型声明合并(declare module '@deepseek-ai/dsh-client-ui-slots')。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  booleanField,
  listenField,
  millisecondsField,
  nonNegativeNumberField,
  routeField,
  RULES_PATH,
  STATUS_PATH,
  upstreamField,
  type HostStatus,
  type RulesSnapshot,
} from './fields.js'

/** 设置命名空间 = 插件行 id(与宿主半、行 id 三处必须一致)。 */
export const NAMESPACE = 'proxy-router'

/** 分区文案。 */
const TEXT = {
  unavailable: '当前部署没有把这一行的配置暴露给浏览器(设置服务不可用)。',
  readOnly: '当前部署的配置是只读的,改动不会被保存。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '宿主没有接受这些值,已保留供你修改。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '格式不对',
  enableLabel: '启用分流代理',
  enableHint: '关(默认)= 插件完全不动作:不监听本地端口、不接管宿主代理策略,一切按原有环境走;开 = 按规则分流',
  enableFailed: '开关没写进去,值仍是上一次生效的状态,请重试。',
  disabledStatus: '未启用:插件不监听、不接管宿主代理策略,一切按原有环境走(没 export 代理就是全直连)。',
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
  rulesTitle: '本地分流规则(即时生效)',
  rulesHint:
    '每行一条,自上而下先命中者生效:`proxy: 域名`(走上游)、`direct: 域名`(强制直连)、' +
    '裸域名等价于 proxy:;也认 `*.域名`、`DOMAIN-SUFFIX,域名`、`DOMAIN,域名`、`DOMAIN-KEYWORD,关键字` 与 IP 字面量。' +
    '# 开头是注释。保存即写盘并立刻重载,不用重启 dsh。',
  rulesReload: '重新载入',
  rulesSave: '保存规则',
  rulesSaved: '已保存并重载。',
  rulesSavedPending: '当前开关关着,规则会在打开开关后生效。',
  rulesNotApplied: '(未启用,保存后等开关打开再生效)',
  rulesLoadFailed: '读规则文件失败',
  rulesSaveFailed: '保存失败',
  rulesIssuesTitle: '下面这些行没看懂,已跳过(不影响其余规则):',
  rulesIssuesMore: (count: number) => `还有 ${count} 行未显示。`,
  rulesSkipped: (count: number) => `${count} 行未识别`,
}

/** 分区状态:总开关 + 表单外壳状态 + 每个字段的草稿状态。 */
export interface ProxyRouterSectionState extends SettingsFormShell {
  /** 总开关(直接读宿主值,不走草稿)。 */
  enabled: SettingsFieldState
  upstream: SettingsFieldState
  defaultRoute: SettingsFieldState
  listen: SettingsFieldState
  refreshHours: SettingsFieldState
  connectTimeoutMs: SettingsFieldState
  fallbackDirect: SettingsFieldState
  debug: SettingsFieldState
}

/** 注册时通过 `inject` 交给组件的面:快照 store + 编辑动作 + 总开关。 */
export interface ProxyRouterSectionFace extends SettingsFormActions {
  hooks: {
    /** `hooks` 里的成员会变成组件的 `useXxx` 选择器 hook。 */
    proxyRouterSection: SnapshotStore<ProxyRouterSectionState>
  }
  /**
   * 总开关:立即写回宿主(**不走草稿** —— 开关是「现在就要生效」的控件,
   * 与下面那些「暂存草稿、点保存才写」的文本框不同口径)。
   * @param value - 目标状态。
   * @returns 宿主是否接受(拒绝返回 false,传输失败才抛)。
   */
  setEnabled(value: boolean): Promise<boolean>
}

/** 分区组件收到的 props:槽位 owner 面(设置面板的关闭动作等)+ 注入面。 */
export type ProxyRouterSectionProps = PropsRuntime<'settings.section'> & InjectFace<ProxyRouterSectionFace>

/**
 * 分区控制器:把共享表单模型包成「一个可注入的 hook + 一组动作」。
 * 与官方设置页(ui-settings-agent-loop 等)同构。
 */
export class ProxyRouterSectionController {
  private readonly scope: SettingsFormScope<Record<string, unknown>>
  private readonly form: SettingsFormModel<Record<string, unknown>>
  private readonly store: SnapshotStore<ProxyRouterSectionState>

  /** @param scope - 绑到 `proxy-router` 这一行的共享表单。 */
  constructor(scope: SettingsFormScope<Record<string, unknown>>) {
    this.scope = scope
    this.form = new SettingsFormModel<Record<string, unknown>>(scope, [
      // 总开关也注册进来:只为让快照能读到宿主当前的开关值(它的写入口是 setEnabled,不过草稿)。
      booleanField('enabled'),
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
      enabled: this.form.field('enabled'),
      upstream: this.form.field('upstream'),
      defaultRoute: this.form.field('defaultRoute'),
      listen: this.form.field('listen'),
      refreshHours: this.form.field('refreshHours'),
      connectTimeoutMs: this.form.field('connectTimeoutMs'),
      fallbackDirect: this.form.field('fallbackDirect'),
      debug: this.form.field('debug'),
    }))
  }

  /**
   * 立刻写总开关:一次 revision 栅栏内的原子写。
   *
   * 不走 `form.actions().edit` 是有意的:草稿语义要求用户再点一次「保存」,
   * 而开关是「拨一下就生效」的控件(官方设置页的开关也是这个口径)。
   * 宿主接受后镜像会把新值带回快照,开关状态、状态面板、宿主行为三者一致。
   */
  async setEnabled(value: boolean): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    return await this.scope.mutate([{ op: 'set', path: ['enabled'], value }], snapshot.revision)
  }

  /** 注入进 slot 的面:快照 hook 的来源 + 编辑动作 + 总开关。 */
  inject(): ProxyRouterSectionFace {
    return {
      hooks: { proxyRouterSection: this.store },
      setEnabled: (value) => this.setEnabled(value),
      ...this.form.actions(),
    }
  }

  /** 释放表单对宿主值的订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}

/**
 * 拉一次运行状态;失败只标记错误,不抛。
 * @param active - 是否真的去拉(关着面板时不必发请求)。
 * @param token - 外部刷新令牌:变了就重拉(规则保存后计数要跟着更新)。
 */
function useHostStatus(active: boolean, token = 0): { status: HostStatus | null; error: boolean; refresh: () => void } {
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
  }, [active, nonce, token])

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
function StatusPanel(props: { refreshToken?: number }): JSX.Element {
  const { status, error, refresh } = useHostStatus(true, props.refreshToken ?? 0)
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
      {/* 总开关关着时,下面那些「监听地址/策略/计数」全是空的,与其显示一排「—」,
          不如直接说清「未启用 = 插件不动作」。 */}
      {status !== null && status.enabled === false ? (
        <p className="dsh-proxy-router-muted">{TEXT.disabledStatus}</p>
      ) : null}
      {status !== null && status.enabled !== false ? (
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
    label: '本地代理监听地址(一般不用改)',
    hint:
      '插件在本地起的那个小代理绑在哪:宿主把所有出网都指给它,由它按规则决定直连还是走上游。' +
      '只允许回环地址(如 127.0.0.1:17890);端口被占用时会自动改用随机端口,所以平时不用管它;端口填 0 = 让系统分配',
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
 * 总开关行:标题 + 说明在左、开关在右(与官方设置行的排版一致)。
 *
 * 开关是「拨一下就写」的:不经过草稿,所以在飞状态与失败提示由这里自己管 ——
 * 写失败立刻退回显示宿主当前值(不假装成功),并留一行可见的提示。
 */
function EnableRow(props: {
  enabled: boolean
  locked: boolean
  onToggle: (next: boolean) => Promise<boolean>
}): JSX.Element {
  const [pending, setPending] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = (next: boolean): void => {
    // 乐观显示目标值:宿主接受后镜像会带回新值,失败则退回宿主当前值。
    setPending(next)
    setFailed(false)
    void (async () => {
      try {
        const accepted = await props.onToggle(next)
        if (!accepted) setFailed(true)
      } catch {
        setFailed(true)
      } finally {
        setPending(null)
      }
    })()
  }

  return (
    <section className="dsh-proxy-router-enable">
      <div className="dsh-proxy-router-enableText">
        <span className="dsh-proxy-router-enableLabel">{TEXT.enableLabel}</span>
        <span className="dsh-proxy-router-enableHint">{TEXT.enableHint}</span>
        {failed ? <span className="dsh-proxy-router-warn">{TEXT.enableFailed}</span> : null}
      </div>
      <Switch
        checked={pending ?? props.enabled}
        disabled={props.locked || pending !== null}
        label={TEXT.enableLabel}
        onChange={toggle}
      />
    </section>
  )
}

/**
 * 本地规则编辑区:直接编辑宿主的 `rules.txt`(proxy:/direct:、域名后缀、IP 字面量)。
 *
 * 为什么单开一块而不是塞进上面那张表单:
 *   - 规则文件不是插件行的配置(schema)字段,它是宿主状态目录里的一个文件,走宿主新加的
 *     `GET/PUT /dsh-proxy-router/rules` 路由;
 *   - 规则的编辑体验需要「多行文本 + 逐行诊断」,与那套单行字段控件不是一回事;
 *   - 改完即时生效(宿主写完立刻重载),不必再点上面那个「保存」。
 *
 * 保存永远会写盘(解析刻意宽容),但会把无法识别的行按行号显示出来 ——
 * 打错一个域名却毫无提示,比拦住保存更糟。
 */
function RulesEditor(props: { onSaved?: () => void }): JSX.Element {
  const [remote, setRemote] = useState<RulesSnapshot | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(RULES_PATH, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const snapshot = (await response.json()) as RulesSnapshot
      setRemote(snapshot)
      setText(snapshot.content)
      setNotice(null)
    } catch (cause) {
      setError(`${TEXT.rulesLoadFailed}(${String((cause as Error).message ?? cause)})`)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = remote !== null && text !== remote.content
  const onSaved = props.onSaved

  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(RULES_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      const payload = (await response.json()) as RulesSnapshot
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setRemote(payload)
      // 保存回执里没有正文(GET 才有),用本地这份草稿当作新基线,免得「刚存完又显示脏」
      setText(text)
      setRemote({ ...payload, content: text })
      const skipped = payload.summary?.skipped ?? 0
      setNotice(
        `${TEXT.rulesSaved}${payload.applied === true ? '' : TEXT.rulesSavedPending}` +
          (skipped > 0 ? `;${TEXT.rulesSkipped(skipped)}` : ''),
      )
      onSaved?.()
    } catch (cause) {
      setError(`${TEXT.rulesSaveFailed}(${String((cause as Error).message ?? cause)})`)
    } finally {
      setBusy(false)
    }
  }, [text, onSaved])

  const summary = remote?.summary
  const issues = remote?.issues ?? []

  return (
    <section className="dsh-proxy-router-rules">
      <header className="dsh-proxy-router-statusHead">
        <h4 className="dsh-proxy-router-statusTitle">{TEXT.rulesTitle}</h4>
        <div className="dsh-proxy-router-rulesActions">
          <button type="button" className="dsh-proxy-router-refresh" onClick={() => void load()} disabled={busy}>
            {TEXT.rulesReload}
          </button>
          <button type="button" className="dsh-proxy-router-rulesSave" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? TEXT.saving : TEXT.rulesSave}
          </button>
        </div>
      </header>
      <p className="dsh-proxy-router-rulesHint">{TEXT.rulesHint}</p>
      {remote !== null ? <p className="dsh-proxy-router-muted">{remote.path}</p> : null}
      <textarea
        className="dsh-proxy-router-rulesText"
        value={text}
        spellCheck={false}
        rows={12}
        onChange={(event) => setText(event.target.value)}
        aria-label={TEXT.rulesTitle}
      />
      {summary !== undefined ? (
        <p className="dsh-proxy-router-muted">
          {`共 ${summary.total} 条(走上游 ${summary.proxy} · 强制直连 ${summary.direct})` +
            (summary.skipped > 0 ? `;${TEXT.rulesSkipped(summary.skipped)}` : '') +
            (remote?.applied === true ? '' : TEXT.rulesNotApplied)}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <div className="dsh-proxy-router-warn">
          <p>{TEXT.rulesIssuesTitle}</p>
          <ul className="dsh-proxy-router-issues">
            {issues.slice(0, 10).map((issue) => (
              <li key={`${String(issue.line)}-${issue.text}`}>{`第 ${issue.line} 行:${issue.text}`}</li>
            ))}
          </ul>
          {issues.length > 10 ? <p>{TEXT.rulesIssuesMore(issues.length - 10)}</p> : null}
        </div>
      ) : null}
      {notice !== null ? <p className="dsh-proxy-router-muted">{notice}</p> : null}
      {error !== null ? <p className="dsh-proxy-router-warn">{error}</p> : null}
    </section>
  )
}

/**
 * 设置分区组件:总开关 → 运行状态 → 配置表单 → 本地规则。
 * 面板标题由设置外壳给(导航项就是分区名),这里不重复画标题 —— 与官方分区一致。
 */
export function ProxyRouterSection(props: ProxyRouterSectionProps): JSX.Element {
  const state = props.useProxyRouterSection((snapshot) => snapshot)
  // 规则保存后让状态面板重读一次:上面那行「规则条数」要跟着变
  const [statusToken, setStatusToken] = useState(0)

  return (
    <div className="dsh-proxy-router-section">
      <EnableRow
        enabled={state.enabled.text === 'true'}
        locked={state.writable !== true || state.available !== true}
        onToggle={props.setEnabled}
      />
      <StatusPanel refreshToken={statusToken} />
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
      <RulesEditor onSaved={() => setStatusToken((value) => value + 1)} />
    </div>
  )
}

/** 分区样式:沿用 DSW 的 css 变量,不引入额外依赖。 */
export const SECTION_CSS = `
.dsh-proxy-router-section{display:flex;flex-direction:column;gap:16px}
.dsh-proxy-router-enable{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px}
.dsh-proxy-router-enableText{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-proxy-router-enableLabel{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-proxy-router-enableHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-proxy-router-status{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px}
.dsh-proxy-router-rules{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px}
.dsh-proxy-router-rulesActions{display:flex;align-items:center;gap:10px}
.dsh-proxy-router-rulesHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-proxy-router-rulesSave{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0;border-radius:var(--dsw-radius-md);padding:4px 12px;font-size:12px;cursor:pointer}
.dsh-proxy-router-rulesSave:disabled{opacity:.45;cursor:default}
.dsh-proxy-router-rulesText{width:100%;box-sizing:border-box;min-height:160px;resize:vertical;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.dsh-proxy-router-issues{margin:4px 0 0;padding-left:18px;font-size:12px;line-height:18px}
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
