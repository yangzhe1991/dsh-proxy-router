/**
 * @yangzhe1991/dsh-proxy-router 插件,浏览器半。
 *
 * 只做一件事:把「分流代理」注册成**设置页里的一个分区** —— 侧边栏 设置 → 分流代理,
 * 做法与 dsh-im 的「IM机器人」一致(`settings.section` 槽位:id 自取、order 决定导航位置)。
 *
 * 为什么不用 Plugins 页的行卡片(`plugins.row.config`,key = `<包名>#<行 id>`):
 * 那条路要求用户先进 Plugins 页 → 找到本插件包 → 展开行,入口太深;设置页分区
 * 点开侧边栏就能看到,和官方设置项(通用/模型/内置插件)并排。
 *
 * 数据面不变:表单仍是官方共享表单 `ctx.configForms.get('proxy-router')` —— 这一行的
 * 配置由宿主半的 `Config` schema 提供,标了 volatile 的字段写回 profile 用户层并**热生效**
 * (不重挂插件、不重启宿主)。
 *
 * 注册时机:只在宿主真的在跑这一行(命名空间被 served)时才注册,行被关掉时自动撤下 ——
 * 部署里没有这个宿主插件时,设置页里不会多出一个点了没反应的分区。
 *
 * inject 必须声明用到的客户端服务 —— 浏览器半读没声明的 cordis 服务会让整个客户端
 * 组合树崩溃(整页白屏)。这里只读 `slots`(注册槽位)与 `configForms`(共享表单)。
 */
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { NAMESPACE, ProxyRouterSection, ProxyRouterSectionController, SECTION_CSS } from './card.js'

/** 再导出分区组件与控制器:嵌入/测试可以直接用。 */
export { NAMESPACE, ProxyRouterSection, ProxyRouterSectionController, SECTION_CSS }

/** 浏览器半需要的客户端服务(声明后即使服务缺失也只返回 undefined,不会崩)。 */
export const inject = ['slots', 'configForms']

/** 分区 CSS 的插入标记:重复加载(硬刷新/HMR)时不重复插。 */
const CSS_TAG = '@yangzhe1991/dsh-proxy-router/Section.css'

/** 本包的包名:样式标记用。 */
const PACKAGE_NAME = '@yangzhe1991/dsh-proxy-router'

/**
 * 设置分区的 id,同时也是 `configForms` 的命名空间。
 * 三处必须一致:宿主 `Config` 注册的命名空间、插件行 id(cordis.patch.yml)、这里。
 * 宿主侧注册时用的是「行 id」(`entry.options.id`),所以这里就是 `proxy-router`。
 */
const SECTION_ID = 'proxy-router'

/**
 * 导航位置。官方分区:账户 -10、通用 0、模型 10、内置插件 15、Agent 预设 20;
 * dsh-im 的「IM机器人」取 21。这里取 22 = 排在**所有官方设置项之后**
 * (与 IM机器人 谁先谁后无所谓;不取并列的 21 是因为并列时顺序不稳定)。
 */
const SECTION_ORDER = 22

/** 导航标签。分区内文案一样是硬编码中文(插件不挂 locale 字典)。 */
const NAV_LABEL = '分流代理'

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
 * 注册设置分区。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContextLike): void {
  injectStyle(SECTION_CSS)
  // 形状校验:浏览器半一旦抛错会掀掉整个客户端组合树(整页白屏),
  // 代价远大于少一个分区 —— 服务不在或形状不对就安静退出。
  const forms = ctx.configForms
  if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') {
    console.warn('[proxy-router] configForms 不可用,设置页的分区未注册')
    return
  }
  const register = (): (() => void) => {
    let card: ProxyRouterSectionController | null = null
    try {
      card = new ProxyRouterSectionController(forms.get(NAMESPACE))
    } catch (error) {
      console.warn('[proxy-router] 绑定配置表单失败,设置页的分区未注册:', error)
      return () => {}
    }
    const controller = card
    const disposeSlot = ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: NAV_LABEL,
          inject: () => controller.inject(),
        },
        ProxyRouterSection,
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
  // 用 effect 挂卸载清理:插件卸载 = 撤分区 + 释放表单订阅。
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeRegistration, 'proxy-router: settings section')
}
