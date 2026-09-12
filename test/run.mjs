/**
 * 验证脚本:不依赖测试框架,直接跑真实网络与真实上游代理。
 *
 *   node test/run.mjs
 *
 * 覆盖:
 *   1. 规则层单测(清单解析 / 后缀匹配 / 本地规则覆盖 / 私有地址判定)
 *   2. 端到端:mock cordis ctx 跑真正的 apply() —— 起本地分流代理、接管宿主策略
 *      a. CONNECT(https)直连路径:国内站点 md5 直连成功
 *      b. CONNECT(https)代理路径:被墙域名经上游代理成功
 *      c. 绝对形式(http)直连路径
 *      d. 决策查询接口 why / 状态接口 status
 *      e. bash 子进程环境:proxyEnvironmentForChild 指向本地分流代理
 *      f. 本地规则热加载:新增 direct: 规则后立即改判
 *   3. 上游挂掉时回退直连(fallbackDirect)
 *   4. 卸载:关监听、还原环境变量
 *
 * 需要:本机可访问 https://www.baidu.com(直连)与上游代理(默认 192.168.3.47:12801)。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseRules, RuleTable, isPrivateHost, normalizeHost } from '../src/rules.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const STATE_DIR = join(HERE, '.test-state')
const UPSTREAM = process.env.TEST_UPSTREAM ?? 'http://192.168.3.47:12801'
const PORT = Number(process.env.TEST_PORT ?? 17911)
const LOCAL = `http://127.0.0.1:${PORT}`

let failures = 0
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ─────────────────────────── 1. 规则层单测 ───────────────────────────
console.log('\n[1] 规则层')
{
  const table = new RuleTable()
  const parsed = parseRules(
    [
      'payload:',
      "  - '+.google.com'",
      "  - 'example.com'",
      'DOMAIN,exact.example.net',
      'DOMAIN-KEYWORD,tracker',
      'server=/dnsmasq-style.cn/114.114.114.114',
      '# 注释行',
      'direct: override.cn',
      '中文域名.中国',
    ].join('\n'),
    { defaultRoute: 'proxy', source: 'test' },
  )
  table.addAll(parsed.rules)
  check('payload 形态的行被解析', table.size >= 6, `解析出 ${table.size} 条`)
  check('后缀规则命中子域', table.lookup('a.b.google.com')?.pattern === 'google.com')
  check('裸域名按后缀匹配', table.lookup('sub.example.com')?.pattern === 'example.com')
  check('DOMAIN, 走精确匹配', table.lookup('exact.example.net')?.kind === 'exact')
  check('DOMAIN, 不匹配子域', table.lookup('sub.exact.example.net') === undefined)
  check('DOMAIN-KEYWORD 命中', table.lookup('ads.tracker.io')?.kind === 'keyword')
  check('dnsmasq 行被识别', table.lookup('www.dnsmasq-style.cn')?.pattern === 'dnsmasq-style.cn')
  check('direct: 前缀改判直连', table.lookup('x.override.cn')?.route === 'direct')
  check('中文域名转 punycode', table.lookup('中文域名.中国') !== undefined)
  check('注释行不产出规则', !table.lookup('# 注释行'))

  check('回环/内网判定', isPrivateHost('127.0.0.1') && isPrivateHost('192.168.1.5') && isPrivateHost('10.1.2.3'))
  check('单标签主机名按内网处理', isPrivateHost('nas'))
  check('公网域名不算内网', !isPrivateHost('www.baidu.com') && !isPrivateHost('8.8.8.8'))
  check('主机名归一化', normalizeHost('[::1]') === '::1' && normalizeHost('Example.COM.') === 'example.com')
}

// ─────────────────────── 2. 端到端(mock ctx) ───────────────────────
console.log('\n[2] 端到端(mock cordis ctx)')
rmSync(STATE_DIR, { recursive: true, force: true })
mkdirSync(STATE_DIR, { recursive: true })
const rulesFile = join(STATE_DIR, 'rules.txt')
writeFileSync(rulesFile, '# 测试规则\nproxy: www.google.com\n', 'utf8')

const disposers = []
const ctx = {
  get: () => undefined,
  effect: (fn) => {
    disposers.push(fn())
  },
}

/** 宿主 schema 与客户端卡片共用的字段集合,任一侧漏字段都要在这里炸出来。 */
const FIELDS_KEYS = ['upstream', 'defaultRoute', 'lists', 'refreshHours', 'listen', 'connectTimeoutMs', 'fallbackDirect', 'debug']

const { apply } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
apply(ctx, {
  upstream: UPSTREAM,
  listen: `127.0.0.1:${PORT}`,
  lists: [],
  refreshHours: 0,
  stateDir: STATE_DIR,
  rulesFile,
})

/** 轮询等待本地分流代理起来。 */
async function waitForReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${LOCAL}/__proxy-router/status`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('本地分流代理未在超时时间内就绪')
}

const run = promisify(execFile)

/**
 * 用 curl 走本地代理发一次请求,返回 { code, err }。
 *
 * 必须用异步 execFile:同步版本会阻塞本进程的事件循环,
 * 而本地分流代理就跑在同一个进程里 —— 同步调用等于自己把服务器锁死,
 * 现象是 curl 一直收不到字节直到超时。
 */
async function curlThroughProxy(url, extraArgs = []) {
  try {
    const { stdout } = await run(
      'curl',
      ['-sS', '-x', LOCAL, '--max-time', '25', '-o', '/dev/null', '-w', '%{http_code}', ...extraArgs, url],
      { env: { ...process.env, no_proxy: '', NO_PROXY: '' }, encoding: 'utf8' },
    )
    return { code: stdout.trim(), err: '' }
  } catch (error) {
    return { code: '', err: String(error.stderr ?? error.message).trim().slice(0, 140) }
  }
}

const status = await waitForReady()
check('本地分流代理已监听', status.listening?.port === PORT, JSON.stringify(status.listening))
check('上游代理被识别', status.upstream?.url?.startsWith('http://'), status.upstream?.url ?? '无')
check('宿主策略自检通过', status.policy?.verified === true, JSON.stringify(status.policy))
check('策略模块路径来自 dsh 安装目录', (status.policy?.modulePath ?? '').includes('dsh-http-proxy'))
check('内置种子清单已装载', status.rules?.seed > 50, `seed=${status.rules?.seed}`)

// a. 直连:国内站点
const baidu = await curlThroughProxy('https://www.baidu.com/')
check('CONNECT 直连国内站点成功', baidu.code === '200', baidu.code || baidu.err)
// b. 代理:规则命中 + 被墙域名
const google = await curlThroughProxy('https://www.google.com/')
check('CONNECT 经上游代理访问被墙站点成功', google.code === '200', google.code || google.err)
// c. 绝对形式 http
const example = await curlThroughProxy('http://example.com/')
check('绝对形式 http 请求成功', example.code === '200', example.code || example.err)

const afterStats = await (await fetch(`${LOCAL}/__proxy-router/status`)).json()
check(
  '统计:直连与代理路径各走过',
  afterStats.stats.direct >= 1 && afterStats.stats.proxied >= 1,
  JSON.stringify(afterStats.stats),
)

// d. 决策查询接口
const whyGoogle = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.google.com`)).json()
const whyBaidu = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.baidu.com`)).json()
const whyLan = await (await fetch(`${LOCAL}/__proxy-router/why?host=192.168.3.10`)).json()
const whySeed = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.youtube.com`)).json()
check('why:本地规则命中 → proxy', whyGoogle.route === 'proxy', JSON.stringify(whyGoogle))
check('why:未命中 → 默认直连', whyBaidu.route === 'direct' && whyBaidu.reason === 'default', JSON.stringify(whyBaidu))
check('why:内网地址 → 直连', whyLan.route === 'direct' && whyLan.reason === 'private', JSON.stringify(whyLan))
check('why:内置种子清单兜底 → proxy', whySeed.route === 'proxy', JSON.stringify(whySeed))

// e. bash 子进程环境
{
  const require_ = createRequire(join(homedir(), '.dsh', 'profiles', 'anchor.js'))
  const hostProxyPath = require_.resolve('@deepseek-ai/dsh-http-proxy')
  const hostProxy = await import(pathToFileURL(hostProxyPath).href)
  const childEnv = hostProxy.proxyEnvironmentForChild()
  check(
    'bash 子进程拿到本地分流代理',
    childEnv.http_proxy === LOCAL && childEnv.https_proxy === LOCAL,
    JSON.stringify({ http_proxy: childEnv.http_proxy, NODE_USE_ENV_PROXY: childEnv.NODE_USE_ENV_PROXY }),
  )
  check('子进程 no_proxy 只留回环', (childEnv.no_proxy ?? '').includes('127.0.0.1') && !(childEnv.no_proxy ?? '').includes('baidu'))
  check('进程内环境变量已改写', process.env.http_proxy === LOCAL, process.env.http_proxy ?? '未设置')
  const route = hostProxy.proxyRouteFor(new URL('http://www.baidu.com/'))
  check('web_fetch 会走本地分流代理', route.proxied === true && route.proxy === LOCAL, JSON.stringify(route))
}

// f. 本地规则热加载
{
  writeFileSync(rulesFile, '# 测试规则\nproxy: www.google.com\ndirect: www.google.com\n', 'utf8')
  let route = null
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    route = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.google.com`)).json()
    if (route.route === 'direct') break
    await new Promise((r) => setTimeout(r, 200))
  }
  check('本地规则热加载:改判为直连', route?.route === 'direct', JSON.stringify(route))
}

// ─────────────────── 3. 上游不可用时回退直连 ───────────────────
console.log('\n[3] 上游不可用时的回退')
{
  // 卸载上一轮:关监听、还原环境
  for (const dispose of disposers.splice(0)) await dispose()
  let closed = false
  try {
    await fetch(`${LOCAL}/__proxy-router/status`, { signal: AbortSignal.timeout(800) })
  } catch {
    closed = true
  }
  check('卸载后本地代理端口已关闭', closed)

  const STATE2 = join(HERE, '.test-state-2')
  rmSync(STATE2, { recursive: true, force: true })
  mkdirSync(STATE2, { recursive: true })
  const rulesFile2 = join(STATE2, 'rules.txt')
  writeFileSync(rulesFile2, 'proxy: www.baidu.com\n', 'utf8')
  const ctx2 = { get: () => undefined, effect: (fn) => disposers.push(fn()) }
  apply(ctx2, {
    upstream: 'http://127.0.0.1:9', // 必然连不上的上游
    listen: `127.0.0.1:${PORT}`,
    lists: [],
    refreshHours: 0,
    stateDir: STATE2,
    rulesFile: rulesFile2,
    connectTimeoutMs: 2000,
  })
  const status2 = await waitForReady()
  check('第二轮就绪', status2.listening?.port === PORT, JSON.stringify(status2.listening))
  const fallback = await curlThroughProxy('https://www.baidu.com/')
  check('上游挂掉时回退直连仍成功', fallback.code === '200', fallback.code || fallback.err)
  const stats2 = await (await fetch(`${LOCAL}/__proxy-router/status`)).json()
  check('回退被计数', stats2.stats.fallback >= 1, JSON.stringify(stats2.stats))
  for (const dispose of disposers.splice(0)) await dispose()
}

// ──────────── 4. 默认远程清单(jsDelivr)+ 本地覆盖远程 ────────────
console.log('\n[4] 默认远程清单与优先级')
{
  const STATE3 = join(HERE, '.test-state-3')
  rmSync(STATE3, { recursive: true, force: true })
  mkdirSync(STATE3, { recursive: true })
  const rulesFile3 = join(STATE3, 'rules.txt')
  // 本地规则故意与远程 gfw 清单冲突:本地必须赢
  writeFileSync(rulesFile3, 'direct: www.google.com\n', 'utf8')
  const ctx3 = { get: () => undefined, effect: (fn) => disposers.push(fn()) }
  apply(ctx3, {
    upstream: UPSTREAM,
    listen: `127.0.0.1:${PORT}`,
    stateDir: STATE3,
    rulesFile: rulesFile3,
    debug: false,
  })
  const status3 = await waitForReady()
  // 首启是后台刷新,等清单落盘
  let lists = status3.lists ?? []
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && (lists.find((l) => l.name === 'gfw')?.count ?? 0) < 1000) {
    await new Promise((r) => setTimeout(r, 500))
    lists = (await (await fetch(`${LOCAL}/__proxy-router/status`)).json()).lists ?? []
  }
  const gfw = lists.find((l) => l.name === 'gfw')
  check('远程 gfw 清单已装载', (gfw?.count ?? 0) > 3000, `gfw=${gfw?.count ?? 0} 条`)
  check('清单缓存已落盘', existsSync(join(STATE3, 'cache', 'gfw.txt')))
  const whyYt = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.youtube.com`)).json()
  check('远程清单命中 → proxy', whyYt.route === 'proxy' && String(whyYt.reason).startsWith('list:gfw'), JSON.stringify(whyYt))
  const whyLocal = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.google.com`)).json()
  check('本地 direct: 覆盖远程清单', whyLocal.route === 'direct' && whyLocal.reason === 'local:www.google.com', JSON.stringify(whyLocal))
  const whyCn = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.qq.com`)).json()
  check('国内域名默认直连', whyCn.route === 'direct', JSON.stringify(whyCn))
  const cacheText = readFileSync(join(STATE3, 'cache', 'gfw.txt'), 'utf8')
  check('缓存内容形态正确', cacheText.includes('google.com'), cacheText.slice(0, 40).replace(/\n/g, ' '))
  for (const dispose of disposers.splice(0)) await dispose()
  rmSync(STATE3, { recursive: true, force: true })
}

// ──────────── 5. 设置命名空间接入 + 热应用 ────────────
console.log('\n[5] 设置命名空间与热应用')
{
  const STATE5 = join(HERE, '.test-state-5')
  rmSync(STATE5, { recursive: true, force: true })
  mkdirSync(STATE5, { recursive: true })
  const rulesFile5 = join(STATE5, 'rules.txt')
  writeFileSync(rulesFile5, 'proxy: www.google.com\n', 'utf8')

  /** 捕获插件注册的设置分节(模拟宿主 dsh-settings-file 的 installSection)。 */
  let section = null
  const routes = []
  const fakeWebServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const provider = {
    installSection(owner, ns, schema, entry, hooks) {
      section = { ns, schema, entry, hooks }
    },
  }
  const ctx5 = {
    get: (name) => (name === 'settings' ? provider : name === 'webServer' ? fakeWebServer : undefined),
    effect: (fn) => disposers.push(fn()),
    inject: (deps, cb) => cb({ get: (name) => (name === 'settings' ? provider : name === 'webServer' ? fakeWebServer : undefined) }),
  }
  apply(ctx5, {
    upstream: UPSTREAM,
    listen: `127.0.0.1:${PORT}`,
    lists: [],
    refreshHours: 0,
    stateDir: STATE5,
    rulesFile: rulesFile5,
  })
  const status5 = await waitForReady()
  check('设置命名空间已注册', section?.ns === 'proxy-router', section?.ns ?? '未注册')
  check('设置分节被标记为已注册', status5.settingsRegistered === true, String(status5.settingsRegistered))
  check(
    'schema 可被宿主序列化',
    typeof section?.schema?.toJSON === 'function' && JSON.stringify(section.schema.toJSON()).includes('upstream'),
  )
  check('base 层 = 组合配置', section?.entry?.upstream === UPSTREAM.trim(), String(section?.entry?.upstream))
  check(
    'schema 默认值来自插件常量',
    section?.schema?.({})?.defaultRoute === 'direct' && section?.schema?.({})?.listen === '127.0.0.1:17890',
    JSON.stringify(section?.schema?.({})),
  )
  check('段校验能拒绝 socks 上游', (() => {
    try {
      section.hooks.validate({ ...section.entry, upstream: 'socks5://1.2.3.4:1080' })
      return false
    } catch {
      return true
    }
  })())
  check('状态路由已挂到 Web 服务器', routes.some((route) => route.path === '/dsh-proxy-router/status'))

  // 模拟用户在设置页保存:上游换成一个连不上的地址,监听端口也换一个
  const NEW_PORT = PORT + 2
  section.hooks.setSource(() => ({
    upstream: 'http://127.0.0.1:9',
    defaultRoute: 'direct',
    lists: [],
    refreshHours: 0,
    listen: `127.0.0.1:${NEW_PORT}`,
    connectTimeoutMs: 15000,
    fallbackDirect: true,
    debug: false,
  }))
  section.hooks.onChange()
  // 等热应用完成(重新绑定监听 + 重装策略)
  let moved = null
  const moveDeadline = Date.now() + 10_000
  while (Date.now() < moveDeadline) {
    try {
      const candidate = await (await fetch(`http://127.0.0.1:${NEW_PORT}/__proxy-router/status`)).json()
      if (candidate?.listening?.port === NEW_PORT) {
        moved = candidate
        break
      }
    } catch {
      /* 还没绑上 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  check('设置改监听地址后已重新绑定', moved?.listening?.port === NEW_PORT, JSON.stringify(moved?.listening ?? null))
  check('设置改上游后运行时立即生效', moved?.upstream?.url === 'http://127.0.0.1:9/', String(moved?.upstream?.url))

  // 宿主策略要跟着指到新端口,否则主进程还打旧地址
  {
    const require_ = createRequire(join(homedir(), '.dsh', 'profiles', 'anchor.js'))
    const hostProxy = await import(pathToFileURL(require_.resolve('@deepseek-ai/dsh-http-proxy')).href)
    const childEnv = hostProxy.proxyEnvironmentForChild()
    check(
      '重绑后宿主策略同步指向新端口',
      childEnv.http_proxy === `http://127.0.0.1:${NEW_PORT}`,
      String(childEnv.http_proxy),
    )
  }
  // 设置页读的状态路由返回 JSON
  {
    const handler = routes.find((route) => route.path === '/dsh-proxy-router/status').handler
    let body = ''
    const fakeRes = {
      writeHead() {},
      end(text) {
        body = text ?? ''
      },
    }
    await handler({ method: 'GET' }, fakeRes)
    const parsed = JSON.parse(body)
    check('状态路由返回运行态 JSON', parsed.namespace === 'proxy-router' && parsed.listening.port === NEW_PORT, JSON.stringify(parsed.listening))
  }
  for (const dispose of disposers.splice(0)) await dispose()
  rmSync(STATE5, { recursive: true, force: true })
}

// ──────────── 6. 浏览器半 bundle(设置页卡片) ────────────
console.log('\n[6] 浏览器半')
{
  const fallback = join(homedir(), '.dsh', 'profiles', 'web', '.dsh-module-fallback', 'node_modules')
  const table = {}
  for (const [name, entry] of [
    ['react', 'react/index.js'],
    ['react/jsx-runtime', 'react/jsx-runtime.js'],
    ['react-dom', 'react-dom/index.js'],
    ['react-dom/client', 'react-dom/client.js'],
    ['react-dom/server', 'react-dom/server.js'],
  ]) {
    const module = await import(pathToFileURL(join(fallback, entry)).href)
    table[name] = module.default ?? module
  }
  const React = table.react
  const server = table['react-dom/server']

  // mock window.__ModuleLoader__:执行 bundle 的工厂并记录导出
  const loadedModules = []
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loadedModules.push({ id, exports: factory((name) => {
          if (!(name in table)) throw new Error(`平台模块表里没有 ${name}`)
          return table[name]
        }) })
      },
    },
  }
  await import(pathToFileURL(join(ROOT, 'lib/client.js')).href)

  const plugin = loadedModules.find((entry) => entry.id === '@yangzhe1991/dsh-proxy-router')?.exports
  check('bundle 完成注册且 id 正确', loadedModules.length === 1 && loadedModules[0].id === '@yangzhe1991/dsh-proxy-router')
  check('浏览器半导出 apply 与 inject', typeof plugin?.apply === 'function' && Array.isArray(plugin?.inject))
  check(
    'inject 声明了用到的客户端服务',
    plugin?.inject?.includes('slots') && plugin?.inject?.includes('settingsScope'),
    JSON.stringify(plugin?.inject),
  )

  // mock document + slots + settingsScope,跑一次真正的 apply
  const styleTags = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styleTags.push(tag) },
  }
  const registrations = []
  const snapshot = {
    status: 'ready',
    value: {
      upstream: 'http://192.168.3.47:12801',
      defaultRoute: 'direct',
      lists: ['https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt'],
      refreshHours: 24,
      listen: '127.0.0.1:17890',
      connectTimeoutMs: 15000,
      fallbackDirect: true,
      debug: true,
    },
    base: {},
    user: { debug: true },
    revision: 7,
    writable: true,
    mode: 'host',
  }
  const writes = []
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => writes.push({ op: 'set', field, value }),
    unset: async (field) => writes.push({ op: 'unset', field }),
  }
  const ctxClient = {
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    settingsScope: { bind: (spec) => (spec.namespace === 'proxy-router' ? scope : null) },
  }
  plugin.apply(ctxClient)
  check('注册到 settings.plugin.item 且 key 为命名空间', registrations.length === 1 && registrations[0].options.key === 'proxy-router', JSON.stringify(registrations[0]?.options))
  check('卡片样式已注入且带 data-plugin-css 标记', styleTags.length === 1 && String(styleTags[0].dataset.pluginCss ?? '').includes('dsh-proxy-router'))

  // 注册进槽位的组件默认收起:先验头部
  const collapsed = server.renderToStaticMarkup(React.createElement(registrations[0].component))
  check('收起态渲染插件名与说明', collapsed.includes('代理分流') && collapsed.includes('bash 子进程'))
  // 注意别拿「上游代理」当判据:卡片描述里也有这四个字,要判表单元素本身
  check('收起态不渲染表单', !collapsed.includes('dpr_field') && !collapsed.includes('<input'))

  // 展开态:直接渲染组件本体(initialOpen),覆盖表单、覆盖标记、按钮禁用逻辑
  const html = server.renderToStaticMarkup(React.createElement(plugin.ProxyRouterCard, { scope, initialOpen: true }))
  check(
    '展开态渲染出全部字段标签',
    ['上游代理', '未命中任何规则时', '远程被墙清单', '清单刷新周期', '本地分流代理监听地址', '连接超时', '上游失败时回退直连', '打印每次请求的分流日志'].every(
      (label) => html.includes(label),
    ),
    FIELDS_KEYS.filter((key) => !html.includes(key)).join(',') || '全部命中',
  )
  check('展开态显示已覆盖字段的标记与恢复默认', html.includes('已覆盖') && html.includes('恢复默认'))
  check('未编辑时保存/放弃按钮禁用', (html.match(/disabled/g) ?? []).length >= 2)
  check('状态面板占位存在', html.includes('运行状态') && html.includes('读取中'))
  delete globalThis.window
  delete globalThis.document
}

// ──────────── 7. 客户端字段规则(纯函数) ────────────
console.log('\n[7] 客户端字段规则')
{
  const { FIELDS, validate, parseDraft, toText, isOverridden } = await import('../src/client/fields.ts')
  const byKey = Object.fromEntries(FIELDS.map((field) => [field.key, field]))
  check('字段集合与宿主 schema 对齐', FIELDS_KEYS.every((key) => key in byKey), FIELDS.map((f) => f.key).join(','))
  check('上游只接受 http(s)', validate('text', 'upstream', 'socks5://1.2.3.4:1080') !== undefined && validate('text', 'upstream', 'http://1.2.3.4:8080') === undefined)
  check('上游留空合法(沿用环境变量)', validate('text', 'upstream', '') === undefined)
  check('监听地址校验端口', validate('text', 'listen', '127.0.0.1:99999') !== undefined && validate('text', 'listen', '127.0.0.1:17890') === undefined)
  check('数字字段拒绝负数与空值', validate('number', 'refreshHours', '-1') !== undefined && validate('number', 'refreshHours', '') !== undefined)
  check('连接超时有下限', validate('number', 'connectTimeoutMs', '500') !== undefined)
  check('清单行必须是 URL', validate('lines', 'lists', 'https://a/gfw.txt\nnot-a-url') !== undefined)
  check('草稿解析:多行清单', JSON.stringify(parseDraft('lines', ' https://a/gfw.txt \n\nhttps://b/x.txt\n')) === JSON.stringify(['https://a/gfw.txt', 'https://b/x.txt']))
  check('草稿解析:开关与数字', parseDraft('switch', 'true') === true && parseDraft('number', ' 42 ') === 42)
  check('草稿渲染:开关与清单', toText('switch', true) === 'true' && toText('lines', ['a', 'b']) === 'a\nb')
  check('覆盖判定只看 key 在不在', isOverridden({ debug: false }, 'debug') && !isOverridden({}, 'upstream'))
}

rmSync(STATE_DIR, { recursive: true, force: true })
rmSync(join(HERE, '.test-state-2'), { recursive: true, force: true })

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`)
process.exit(failures === 0 ? 0 : 1)
