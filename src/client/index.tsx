/**
 * @yangzhe1991/dsh-proxy-router 插件,浏览器半。
 *
 * 只做一件事:把「代理分流」的配置卡片注册进 **Plugins 页**(侧边栏 Plugins →
 * 本插件包 → 行 `proxy-router` → Configure)。dsh 0.1.7 起插件配置不再走
 * 「设置 → 插件 → 插件配置」那套(`settingsScope` / `settings.plugin.item` 都已移除),
 * 而是:
 *   - 宿主侧插件导出 `Config` schema(本插件 node 半的 `Config`),宿主据此在
 *     `settings.describe` 里暴露这一行的 schema、当前值与写入口;
 *   - 浏览器侧用 `ctx.configForms.get(行 id)` 拿到共享表单,注册进
 *     `plugins.row.config`(key = `<包名>#<行 id>`)渲染自己的控件;
 *   - 只有这一行所在的宿主插件真的在运行时才注册(`configForms.whileServed`),
 *     否则行页面不该出现一个点了没反应的 Configure。
 *
 * inject 必须声明用到的客户端服务 —— 浏览器半读没声明的 cordis 服务会让整个客户端
 * 组合树崩溃(整页白屏)。这里只读 `slots`(注册槽位)与 `configForms`(共享表单)。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CARD_CSS, NAMESPACE, ProxyRouterCard, ProxyRouterCardController } from './card.js'

/** 再导出卡片与控制器:嵌入/测试可以直接用。 */
export { CARD_CSS, NAMESPACE, ProxyRouterCard, ProxyRouterCardController }

/** 浏览器半需要的客户端服务(声明后即使服务缺失也只返回 undefined,不会崩)。 */
export const inject = ['slots', 'configForms']

/** 卡片 CSS 的插入标记:重复加载(硬刷新/HMR)时不重复插。 */
const CSS_TAG = '@yangzhe1991/dsh-proxy-router/Card.css'

/** 本包的包名:注册 key 的前半段。 */
const PACKAGE_NAME = '@yangzhe1991/dsh-proxy-router'
/** 插件行 id:与 cordis.patch.yml、node 半的命名空间三处一致。 */
const ROW_ID = 'proxy-router'

/** 本文件用到的 cordis 客户端上下文形状。 */
export interface ClientContextLike {
  slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  configForms?: Pick<ConfigForms, 'get' | 'whileServed'>
  effect?(fn: () => void | (() => void), name?: string): unknown
}

/** 把卡片样式插进 <head>(与官方插件用同一个 data-plugin-css 约定)。 */
function injectStyle(css: string): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = PACKAGE_NAME
    tag.dataset.pluginCss = CSS_TAG
    tag.textContent = css
    document.head.appendChild(tag)
  }
}

/**
 * 注册配置卡片。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContextLike): void {
  injectStyle(CARD_CSS)
  // 形状校验:浏览器半一旦抛错会掀掉整个客户端组合树(整页白屏),
  // 代价远大于少一张卡片 —— 服务不在或形状不对就安静退出。
  const forms = ctx.configForms
  if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') {
    console.warn('[proxy-router] configForms 不可用,Plugins 页的配置卡片未注册')
    return
  }
  const register = (): (() => void) => {
    let card: ProxyRouterCardController | null = null
    try {
      card = new ProxyRouterCardController(forms.get(NAMESPACE))
    } catch (error) {
      console.warn('[proxy-router] 绑定配置表单失败,Plugins 页的配置卡片未注册:', error)
      return () => {}
    }
    const controller = card
    const disposeSlot = ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register(
        {
          name: 'plugins.row.config',
          key: `${PACKAGE_NAME}#${ROW_ID}`,
          inject: () => controller.inject(),
        },
        ProxyRouterCard,
      ),
    ) as unknown as (() => void) | undefined
    return () => {
      try {
        if (typeof disposeSlot === 'function') disposeSlot()
      } finally {
        controller.dispose()
      }
    }
  }
  // 宿主确实在跑这一行(命名空间被 served)才注册;行被关掉时自动撤下。
  const disposeRegistration = forms.whileServed([NAMESPACE], register)
  // 用 effect 挂卸载清理:插件卸载 = 撤卡片 + 释放表单订阅。
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeRegistration, 'proxy-router: config card')
}
