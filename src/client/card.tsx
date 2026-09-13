/**
 * 设置页里的配置卡片。
 *
 * 结构照官方「插件配置」卡片(DOM 是 li > button.header + div.body,视觉沿用同一套
 * DSW css 变量),但内容完全由本插件自己拥有:字段、校验、保存语义都在这里。
 *
 * 数据面只依赖两样:
 *   - `ctx.settingsScope.bind({ namespace })` 给出的 scope:读快照、写用户层;
 *   - 宿主 Web 服务器上的 `/dsh-proxy-router/status` 只读路由:显示运行态。
 * 保存走 scope(带 revision 栅栏,并发改动会被拒绝而不是静默覆盖),
 * 恢复默认就是把用户层那个 key 删掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FIELDS, isOverridden, parseDraft, toText, validate, type FieldSpec, type HostStatus } from './fields.js'

/** 设置命名空间(与宿主半、卡片 key 三处必须一致)。 */
export const NAMESPACE = 'proxy-router'
/** 宿主注册的只读状态路由。 */
export const STATUS_PATH = '/dsh-proxy-router/status'

/** 设置 scope 快照里本卡片用到的部分。 */
export interface SettingsScopeSnapshotLike {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** 设置 scope 里本卡片用到的方法。 */
export interface SettingsScopeLike {
  getSnapshot(): SettingsScopeSnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** 卡片显示文案。 */
const TEXT = {
  name: '代理分流(proxy-router)',
  description: '只有命中的被墙域名走上游代理,国内与未知域名直连;覆盖主进程、web_fetch 与 bash 子进程',
  overridden: '已覆盖',
  reset: '恢复默认',
  save: '保存',
  discard: '放弃修改',
  pending: '未保存',
  loading: '正在读取设置…',
  unavailable: '当前部署没有提供这个设置分节(宿主插件未注册命名空间)',
  readOnly: '当前会话是进程内模式,改动不会写回宿主设置文档',
  memoryMode: '连接未建立,设置暂时只存在本页',
  statusFailed: '读取运行状态失败,请确认宿主插件已加载',
}

/** 展开时才拉状态,顺便做一次轻量轮询(5 秒),关闭卡片就停。 */
function useHostStatus(active: boolean): { status: HostStatus | null; error: boolean; refresh: () => void } {
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as HostStatus
        if (!cancelled) {
          setStatus(body)
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, nonce])
  return { status, error, refresh: () => setNonce((value) => value + 1) }
}

/** 一个字段行:标题 + 覆盖标记/恢复默认 + 控件 + 提示或错误。 */
function FieldRow(props: {
  spec: FieldSpec
  text: string
  overridden: boolean
  invalid: string | undefined
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}): JSX.Element {
  const { spec, text, overridden, invalid, disabled } = props
  const inputClass = `dpr_input${invalid === undefined ? '' : ' dpr_inputInvalid'}`
  return (
    <div className="dpr_field">
      <div className="dpr_head">
        <label className="dpr_label" htmlFor={`dpr-${spec.key}`}>
          {spec.label}
        </label>
        {overridden ? <span className="dpr_badge">{TEXT.overridden}</span> : null}
        {overridden ? (
          <button type="button" className="dpr_reset" disabled={disabled} onClick={props.onReset}>
            {TEXT.reset}
          </button>
        ) : null}
      </div>
      {spec.kind === 'switch' ? (
        <input
          id={`dpr-${spec.key}`}
          className="dpr_check"
          type="checkbox"
          checked={text === 'true'}
          disabled={disabled}
          onChange={(event) => props.onEdit(event.target.checked ? 'true' : 'false')}
        />
      ) : spec.kind === 'choice' ? (
        <select
          id={`dpr-${spec.key}`}
          className={inputClass}
          value={text}
          disabled={disabled}
          onChange={(event) => props.onEdit(event.target.value)}
        >
          {(spec.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : spec.kind === 'lines' ? (
        <textarea
          id={`dpr-${spec.key}`}
          className={`${inputClass} dpr_textarea`}
          value={text}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => props.onEdit(event.target.value)}
        />
      ) : (
        <input
          id={`dpr-${spec.key}`}
          className={inputClass}
          type="text"
          value={text}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => props.onEdit(event.target.value)}
        />
      )}
      {invalid === undefined ? <p className="dpr_hint">{spec.hint}</p> : <p className="dpr_invalid">{invalid}</p>}
    </div>
  )
}

/** 运行状态面板:证明「现在到底走没走分流」,不用去翻日志。 */
function StatusPanel(props: { status: HostStatus | null; error: boolean; onRefresh: () => void }): JSX.Element {
  const { status, error } = props
  const rows: [string, string][] = []
  if (status !== null) {
    rows.push(['监听', status.listening === null || status.listening === undefined ? '未启动' : `${status.listening.host}:${status.listening.port}`])
    rows.push([
      '上游',
      status.upstream === null || status.upstream === undefined ? '未配置(命中规则的目标会退化为直连)' : `${status.upstream.url}(${status.upstream.source})`,
    ])
    if (status.policy !== null && status.policy !== undefined) {
      const child = status.policy.childRouting === 'router' ? '走分流' : status.policy.childRouting === 'upstream' ? '直连上游(绕过分流)' : '无'
      rows.push(['宿主策略', `${status.policy.verified ? '已接管并自检通过' : '自检未通过'};bash 子进程:${child}`])
    }
    if (status.upstreamIgnored === true) {
      rows.push(['注意', '上游地址指向了插件自己的监听地址,已被忽略(否则会自我循环);请改成真实代理地址'])
    }
    if (status.rules !== undefined) {
      rows.push(['规则', `本地 ${status.rules.local} / 远程 ${status.rules.remote} / 内置 ${status.rules.seed}`])
    }
    if (status.stats !== null && status.stats !== undefined) {
      rows.push(['命中', `共 ${status.stats.total}:直连 ${status.stats.direct},走上游 ${status.stats.proxied},失败 ${status.stats.failed}`])
    }
    if (status.rulesFile !== undefined) rows.push(['本地规则文件', `${status.rulesFile}(改完即时生效)`])
    for (const list of status.lists ?? []) {
      rows.push([
        `清单 ${list.name}`,
        `${list.count} 条${list.fetchedAt === null ? '(无缓存)' : `,更新于 ${list.fetchedAt.replace('T', ' ').slice(0, 16)}`}${list.lastError === null ? '' : `,上次失败:${list.lastError}`}`,
      ])
    }
    if (status.settingsRegistered === false) {
      rows.push(['提示', '宿主插件未注册设置命名空间,这个页面显示的是组合配置'])
    }
  }
  return (
    <div className="dpr_status">
      <div className="dpr_head">
        <span className="dpr_label">运行状态</span>
        <button type="button" className="dpr_reset" onClick={props.onRefresh}>
          刷新
        </button>
      </div>
      {error ? <p className="dpr_invalid">{TEXT.statusFailed}</p> : null}
      {status === null && !error ? (
        <p className="dpr_hint">读取中…</p>
      ) : (
        <dl className="dpr_statusList">
          {rows.map(([key, value]) => (
            <div className="dpr_statusRow" key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * 配置卡片本体。
 * @param props.scope 绑定到 `proxy-router` 命名空间的设置 scope。
 * @param props.initialOpen 初始是否展开;设置页注册时不传(与官方卡片一致,默认收起),
 *   测试与嵌入场景可以传 true 直接渲染出表单。
 */
export function ProxyRouterCard(props: { scope: SettingsScopeLike; initialOpen?: boolean }): JSX.Element {
  const { scope } = props
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  // 第三个参数是服务端渲染快照:同一份 getSnapshot 即可,
  // 这样在 Node 侧做冒烟渲染(测试/预渲染)不会因为缺它而抛错。
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const [open, setOpen] = useState(props.initialOpen === true)
  /** 草稿:key → 控件文本;没有条目的字段直接显示设置里的值。 */
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 用户重新载入设置(保存成功/放弃)时,把草稿整体丢掉。 */
  const lastRevision = useRef<number | undefined>(undefined)
  const current = snapshot.value ?? {}
  const status = useHostStatus(open)

  // revision 变了说明文档被别处改过(或自己的写入落地了):丢弃草稿,避免用过期的栅栏保存
  useEffect(() => {
    if (snapshot.revision !== lastRevision.current) {
      lastRevision.current = snapshot.revision
      setDraft({})
    }
  }, [snapshot.revision])

  const disabled = !snapshot.writable || snapshot.status !== 'ready'
  const rows = useMemo(
    () =>
      FIELDS.map((spec) => {
        const text = draft[spec.key] ?? toText(spec.kind, current[spec.key])
        return {
          spec,
          text,
          overridden: isOverridden(snapshot.user, spec.key),
          invalid: validate(spec.kind, spec.key, text),
          dirty: draft[spec.key] !== undefined && draft[spec.key] !== toText(spec.kind, current[spec.key]),
        }
      }),
    [draft, current, snapshot.user],
  )
  const dirtyRows = rows.filter((row) => row.dirty)
  const blocked = dirtyRows.some((row) => row.invalid !== undefined)

  const onSave = async (): Promise<void> => {
    if (dirtyRows.length === 0 || blocked) return
    setSaving(true)
    setFailure(null)
    try {
      // 逐字段写入:每个字段一次 set,宿主按 revision 串行合并
      for (const row of dirtyRows) {
        await scope.set(row.spec.key, parseDraft(row.spec.kind, row.text))
      }
      setDraft({})
      status.refresh()
    } catch (error) {
      setFailure(String((error as Error)?.message ?? error))
    } finally {
      setSaving(false)
    }
  }

  const onReset = async (key: string): Promise<void> => {
    setFailure(null)
    try {
      await scope.unset(key)
      setDraft((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
    } catch (error) {
      setFailure(String((error as Error)?.message ?? error))
    }
  }

  return (
    <li className={`dpr_card${open ? ' dpr_cardOpen' : ''}`}>
      <button
        type="button"
        className="dpr_header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dpr_headText">
          <span className="dpr_name">{TEXT.name}</span>
          <span className="dpr_description">{TEXT.description}</span>
        </span>
        {dirtyRows.length > 0 ? <span className="dpr_badge">{TEXT.pending}</span> : null}
        <span className={`dpr_chevron${open ? ' dpr_chevronOpen' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="dpr_body">
          {snapshot.status === 'loading' ? <p className="dpr_hint">{TEXT.loading}</p> : null}
          {snapshot.status === 'unavailable' ? <p className="dpr_hint">{TEXT.unavailable}</p> : null}
          {snapshot.status === 'ready' && snapshot.mode === 'memory' ? (
            <p className="dpr_hint">{TEXT.memoryMode}</p>
          ) : null}
          {snapshot.status === 'ready' && !snapshot.writable ? <p className="dpr_hint">{TEXT.readOnly}</p> : null}
          {rows.map((row) => (
            <FieldRow
              key={row.spec.key}
              spec={row.spec}
              text={row.text}
              overridden={row.overridden}
              invalid={row.invalid}
              disabled={disabled}
              onEdit={(text) => setDraft((previous) => ({ ...previous, [row.spec.key]: text }))}
              onReset={() => {
                void onReset(row.spec.key)
              }}
            />
          ))}
          <StatusPanel status={status.status} error={status.error} onRefresh={status.refresh} />
          <div className="dpr_footer">
            {failure === null ? null : <p className="dpr_failed">保存失败:{failure}</p>}
            <button
              type="button"
              className="dpr_discard"
              disabled={dirtyRows.length === 0 || saving}
              onClick={() => {
                setDraft({})
                setFailure(null)
              }}
            >
              {TEXT.discard}
            </button>
            <button
              type="button"
              className="dpr_save"
              disabled={dirtyRows.length === 0 || blocked || saving}
              onClick={() => {
                void onSave()
              }}
            >
              {TEXT.save}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 卡片样式:视觉 token 与官方设置卡片一致(`--dsw-alias-*`),
 * 类名自带 `dpr_` 前缀,插到 <head> 里而不是全局覆盖任何东西。
 */
export const CARD_CSS = `
.dpr_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dpr_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dpr_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dpr_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dpr_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dpr_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dpr_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dpr_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dpr_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dpr_chevronOpen{transform:rotate(180deg)}
.dpr_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dpr_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dpr_field+.dpr_field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dpr_head{align-items:center;gap:8px;display:flex}
.dpr_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dpr_badge{color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.6}
.dpr_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.dpr_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dpr_reset:disabled{cursor:default}
.dpr_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.dpr_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dpr_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dpr_inputInvalid{border-color:var(--dsw-alias-label-error)}
.dpr_textarea{height:auto;min-height:74px;padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:vertical}
.dpr_check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dpr_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.dpr_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dpr_status{border-top:.5px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;flex-direction:column;gap:8px}
.dpr_statusList{margin:0;display:flex;flex-direction:column;gap:4px}
.dpr_statusRow{display:flex;gap:10px;font-size:12px;line-height:1.6}
.dpr_statusRow dt{color:var(--dsw-alias-label-tertiary);flex:none;min-width:88px;margin:0}
.dpr_statusRow dd{color:var(--dsw-alias-label-secondary);margin:0;word-break:break-all}
.dpr_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dpr_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dpr_discard,.dpr_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dpr_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dpr_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dpr_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dpr_discard:disabled,.dpr_save:disabled{opacity:.4;cursor:default}
.dpr_discard:focus-visible,.dpr_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`
