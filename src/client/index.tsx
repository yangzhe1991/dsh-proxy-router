/**
 * @yangzhe1991/dsh-proxy-router 插件,浏览器半。
 *
 * 只做一件事:把「代理分流」的配置卡片注册进设置 →「插件」→「插件配置」标签页。
 * 那个标签页按 settings 命名空间派发 `settings.plugin.item` 槽位,
 * 所以我们用同名 key(`proxy-router`)认领自己的卡片,其余交给宿主外壳。
 *
 * inject 必须声明用到的客户端服务:AGENTS 经验里最贵的一课 ——
 * 浏览器半读没声明的 cordis 服务会让整个客户端组合树崩溃(整页白屏)。
 * 这里只读 `slots`(注册槽位)与 `settingsScope`(读写设置分节),两者都声明。
 */
import { ProxyRouterCard, CARD_CSS, type SettingsScopeLike } from './card.js'

/** 再导出卡片组件:设置页注册时用不到,但嵌入/测试可以直接渲染它。 */
export { ProxyRouterCard, CARD_CSS }

/** 浏览器半需要的客户端服务(声明后即使服务缺失也只返回 undefined,不会崩)。 */
export const inject = ['slots', 'settingsScope']

/** 卡片 CSS 的插入标记:重复加载(硬刷新/HMR)时不重复插。 */
const CSS_TAG = '@yangzhe1991/dsh-proxy-router/Card.css'

/** 本文件用到的 cordis 客户端上下文形状。 */
export interface ClientContextLike {
  slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  settingsScope?: {
    bind?(spec: { namespace: string }): unknown
  }
  effect?(fn: () => void | (() => void), name?: string): unknown
}

/** 把卡片样式插进 <head>(与官方插件用同一个 data-plugin-css 约定)。 */
function injectStyle(css: string): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@yangzhe1991/dsh-proxy-router'
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = css
  document.head.appendChild(tag)
}

/**
 * 注册配置卡片。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContextLike): void {
  injectStyle(CARD_CSS)
  // 绑定命名空间:scope 是「读快照 + 写用户层」的句柄,revision 栅栏由它维护。
  // 虽然 inject 已经声明了 settingsScope,这里仍做一次形状校验:
  // 浏览器半一旦抛错会掀掉整个客户端组合树(整页白屏),代价远大于少一张卡片。
  const scope = ctx.settingsScope?.bind?.({ namespace: 'proxy-router' }) as SettingsScopeLike | undefined
  if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') {
    console.warn('[proxy-router] settingsScope 不可用,设置页卡片未注册')
    return
  }
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({ name: 'settings.plugin.item', key: 'proxy-router', order: 0 }, () => (
      <ProxyRouterCard scope={scope} />
    )),
  )
}
