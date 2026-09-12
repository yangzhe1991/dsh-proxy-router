/**
 * @yangzhe1991/dsh-proxy-router 构建脚本(esbuild,无其他工具链依赖)。
 *
 * 产出两个半区(与官方双半区插件包一致):
 * - lib/index.js     node 半:宿主 Loader 直接 import 的 ESM 入口。
 * - lib/client.js    浏览器半:window.__ModuleLoader__.load({id, factory})
 *                    格式的 CJS bundle,externals 通过 loader 注入的 require
 *                    从平台模块表解析(react / jsx-runtime)。
 * - lib/types/*.d.ts 手写类型声明,供 exports.types 指向。
 *
 * 关键约束:`@deepseek-ai/dsh-http-proxy`、`undici`、`@deepseek-ai/schemastery`
 * 绝不能被打进产物。宿主启动时已经装了同一份模块(ESM 模块实例按 realpath 去重),
 * 插件必须拿到**同一个实例**:代理策略要装回宿主那份模块状态,
 * 设置命名空间要用宿主那份 schemastery,设置页才能重建 schema。
 * 因此这些都标为 external,运行期用 src/host-modules.ts 的解析链动态 import。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const PLUGIN_ID = '@yangzhe1991/dsh-proxy-router'

// 浏览器半的 externals:必须是平台模块表成员,否则 require 会在运行时抛错。
// 本插件的卡片只用 react(hooks + jsx-runtime),UI 样式全部用 DSW css 变量自带。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

// —— node 半 ——
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  external: ['@deepseek-ai/*', 'undici'],
})

// —— 浏览器半 ——
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // 与官方产物同构:闭包工厂由 __ModuleLoader__ 调用,require 为注入的模块表 require。
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
})

// —— 手写类型声明(与官方包的 exports.types 形态一致) ——
await mkdir('lib/types/client', { recursive: true })
await writeFile(
  'lib/types/index.d.ts',
  [
    '/**',
    ' * @yangzhe1991/dsh-proxy-router 插件,node 半(宿主侧)。',
    ' *',
    ' * apply 装配顺序:归一化配置 → 注册设置命名空间(设置页可编辑,热生效)',
    ' * → 装载规则(本地 + 远程缓存) → 起本地分流代理',
    ' * → 重新安装宿主代理策略 → 在宿主 Web 服务器上挂只读状态路由。',
    ' * 装配全程不抛错:任何一步失败都只记日志并降级(最差情形 = 全部直连,与不装插件一致)。',
    ' */',
    '/** 插件 apply 收到的宿主上下文里,本插件用到的部分。 */',
    'export interface HostContextLike {',
    '  get?(name: string): unknown;',
    '  effect?(fn: () => void | (() => void), name?: string): unknown;',
    '  inject?(deps: readonly string[], callback: (ctx: HostContextLike) => unknown): unknown;',
    '}',
    '/** 插件入口。 */',
    'export declare function apply(ctx: HostContextLike, config?: unknown): void;',
    '/** 宿主 Web 服务器上的只读状态路由路径(设置页卡片读它)。 */',
    'export declare const STATUS_ROUTE_PATH: "/dsh-proxy-router/status";',
    '',
  ].join('\n'),
)
await writeFile(
  'lib/types/client/index.d.ts',
  [
    '/** @yangzhe1991/dsh-proxy-router 插件,浏览器半:设置页里的配置卡片。 */',
    '/** 需要的客户端服务:slots(槽位)、settingsScope(设置分节读写)。 */',
    'export declare const inject: string[];',
    '/** 客户端插件 body。 */',
    'export declare function apply(ctx: unknown): void;',
    '/** 配置卡片组件(设置页注册用;也可单独渲染)。 */',
    'export declare function ProxyRouterCard(props: { scope: unknown; initialOpen?: boolean }): unknown;',
    '',
  ].join('\n'),
)

console.log(`[${PLUGIN_ID}] build done: lib/index.js, lib/client.js, lib/types/*.d.ts`)
