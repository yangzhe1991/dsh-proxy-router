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

/**
 * 设置页可改的字段(= schema 里标了 volatile 的那些)。
 *
 * 这份清单是**故意的重复**:schema 新增一个 volatile 字段、却忘了在宿主半的
 * `readConfigRaw` 里读它,后果不是报错而是「它永远走默认值」—— 加总开关时就踩过
 * (`enabled` 漏读 = 开关永远是关的)。两条断言一起把这种静默漂移钉住:
 * ① 第 5 段比对 schema 的 volatile 集合与本清单;② 第 9 段拿 enabled 跑真实启停。
 */
const VOLATILE_KEYS = [
  'enabled',
  'upstream',
  'defaultRoute',
  'listen',
  'refreshHours',
  'connectTimeoutMs',
  'fallbackDirect',
  'debug',
]

const { apply } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
apply(ctx, {
  enabled: true,
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
async function curlThroughProxy(url, extraArgs = [], proxy = LOCAL) {
  try {
    const { stdout } = await run(
      'curl',
      ['-sS', '-x', proxy, '--max-time', '25', '-o', '/dev/null', '-w', '%{http_code}', ...extraArgs, url],
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
    enabled: true,
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
    enabled: true,
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

// ──────────── 5. 行配置 schema + volatile 热应用(dsh 0.1.7 契约) ────────────
console.log('\n[5] 行配置 schema 与 volatile 热应用')
{
  const STATE5 = join(HERE, '.test-state-5')
  rmSync(STATE5, { recursive: true, force: true })
  mkdirSync(STATE5, { recursive: true })
  const rulesFile5 = join(STATE5, 'rules.txt')
  writeFileSync(rulesFile5, 'proxy: www.google.com\n', 'utf8')

  const { Config } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
  check('导出 Config schema(宿主读它校验配置、生成设置页表单)', typeof Config?.['~standard'] === 'object')
  const schemaJson = JSON.stringify(typeof Config.toJSON === 'function' ? Config.toJSON() : {})
  check(
    'schema 里运行期旋钮都带 volatile(只有 volatile 字段能出现在表单里并热生效)',
    VOLATILE_KEYS.every((key) => schemaJson.includes(`"${key}"`)),
  )
  // 反向钉住:宿主半 readConfigRaw 逐字段列举,漏一个就永远走默认值(不报错)。
  // volatile 字段在解析结果里是引用({get}),非 volatile 是普通值 —— 据此把集合取出来比对。
  const volatileFromSchema = Object.entries(Config({}))
    .filter(([, value]) => value !== null && typeof value === 'object' && typeof value.get === 'function')
    .map(([key]) => key)
    .sort()
  check(
    'schema 的 volatile 集合 = 可改字段清单(新增字段必须同时改 readConfigRaw 与本清单)',
    JSON.stringify(volatileFromSchema) === JSON.stringify([...VOLATILE_KEYS].sort()),
    JSON.stringify(volatileFromSchema),
  )
  const defaults = Config({})
  // volatile 字段在解析结果里是引用(宿主热更新就是改这个引用),测试里按引用读一次。
  const plain = (node) => (node !== null && typeof node === 'object' && typeof node.get === 'function' ? node.get() : node)
  check(
    'schema 默认值来自插件常量(总开关默认关 = 新装全直连)',
    plain(defaults.enabled) === false &&
      plain(defaults.defaultRoute) === 'direct' &&
      plain(defaults.listen) === '127.0.0.1:17890' &&
      plain(defaults.fallbackDirect) === true,
    JSON.stringify({ enabled: plain(defaults.enabled), route: plain(defaults.defaultRoute), listen: plain(defaults.listen) }),
  )
  check('schema 校验拒绝 socks 上游之外的类型错误(非字符串)', (() => {
    try {
      Config({ listen: 123 })
      return false
    } catch {
      return true
    }
  })())

  // 模拟宿主:volatile 字段以引用形态交给插件,热更新时改写引用并派发 loader/volatile-update
  const state = {
    enabled: true,
    upstream: UPSTREAM,
    listen: `127.0.0.1:${PORT}`,
    defaultRoute: 'direct',
    refreshHours: 0,
    connectTimeoutMs: 15000,
    fallbackDirect: true,
    debug: false,
  }
  const ref = (key) => ({ get: () => state[key] })
  const configLike = {
    enabled: ref('enabled'),
    upstream: ref('upstream'),
    listen: ref('listen'),
    defaultRoute: ref('defaultRoute'),
    refreshHours: ref('refreshHours'),
    connectTimeoutMs: ref('connectTimeoutMs'),
    fallbackDirect: ref('fallbackDirect'),
    debug: ref('debug'),
    lists: [],
    stateDir: STATE5,
    rulesFile: rulesFile5,
  }
  let volatileListener = null
  const routes = []
  const fakeWebServer = { register(route) { routes.push(route); return () => {} } }
  const ctx5 = {
    get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
    on: (name, listener) => { if (name === 'loader/volatile-update') volatileListener = listener },
    effect: (fn) => disposers.push(fn()),
    inject: (deps, cb) => cb({ get: (name) => (name === 'webServer' ? fakeWebServer : undefined) }),
  }
  apply(ctx5, configLike)
  const status5 = await waitForReady()
  check('状态路由已挂到 Web 服务器', routes.some((route) => route.path === '/dsh-proxy-router/status'))
  check('状态里带上游来源', status5.upstream?.source === 'config', String(status5.upstream?.source))

  // 模拟设置页保存:上游换成一个连不上的地址,监听端口也换一个 —— 宿主只改引用并发事件
  const NEW_PORT = PORT + 2
  state.upstream = 'http://127.0.0.1:9'
  state.listen = `127.0.0.1:${NEW_PORT}`
  check('已订阅 loader/volatile-update', typeof volatileListener === 'function')
  volatileListener?.()
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
  check('volatile 改监听地址后立即重新绑定', moved?.listening?.port === NEW_PORT, JSON.stringify(moved?.listening ?? null))
  check('volatile 改上游后运行时立即生效', moved?.upstream?.url === 'http://127.0.0.1:9/', String(moved?.upstream?.url))

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
  // 状态路由返回 JSON
  {
    const handler = routes.find((route) => route.path === '/dsh-proxy-router/status').handler
    let body = ''
    const fakeRes = { writeHead() {}, end(text) { body = text ?? '' } }
    await handler({ method: 'GET' }, fakeRes)
    const parsed = JSON.parse(body)
    check('状态路由返回运行态 JSON', parsed.namespace === 'proxy-router' && parsed.listening.port === NEW_PORT, JSON.stringify(parsed.listening))
  }
  for (const dispose of disposers.splice(0)) await dispose()
  rmSync(STATE5, { recursive: true, force: true })
}

// ──────────── 6. 浏览器半 bundle(设置页「分流代理」分区) ────────────
console.log('\n[6] 浏览器半')
{
  // 平台模块表 stub:bundle 的 factory 只 require 这三样;
  // 分区本身不渲染(渲染测试交给真浏览器),这里只验证装配与注册契约。
  // `actions()` 必须与官方同形(edit/resetField/save/discard)——空对象会让
  // 「inject 交出的面」那条断言假绿:插件只是把 form.actions() 原样摊出去。
  const table = {
    react: { useCallback: (fn) => fn, useEffect: () => {}, useState: (value) => [value, () => {}] },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: null },
    '@deepseek-ai/dsh-client-ui-primitives': {
      SettingsFormModel: class {
        bind() { return { getSnapshot: () => ({}), subscribe: () => () => {} } }
        dispose() {}
        actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
      },
      SettingsForm: () => null,
      SettingsValueField: () => null,
    },
  }
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
    'inject 声明了用到的客户端服务(slots + configForms)',
    plugin?.inject?.includes('slots') && plugin?.inject?.includes('configForms'),
    JSON.stringify(plugin?.inject),
  )

  // mock document + slots + configForms,跑一次真正的 apply
  const styleTags = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styleTags.push(tag) },
  }
  const registrations = []
  const served = []
  const fakeScope = { getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }), subscribe: () => () => {}, mutate: async () => true }
  const ctxClient = {
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get: (ns) => {
        if (ns !== 'proxy-router') throw new Error(`未知命名空间 ${ns}`)
        return fakeScope
      },
      whileServed: (namespaces, register) => {
        served.push(...namespaces)
        return register(new Set(namespaces)) ?? (() => {})
      },
    },
    effect: (fn) => fn(),
  }
  plugin.apply(ctxClient)
  check('分区只在该行被 served 时注册', JSON.stringify(served) === JSON.stringify(['proxy-router']), JSON.stringify(served))
  check(
    '注册到 settings.section(id=行 id、order=22 排在官方项之后、label=分流代理)',
    registrations.length === 1 &&
      registrations[0].options.name === 'settings.section' &&
      registrations[0].options.id === 'proxy-router' &&
      registrations[0].options.order === 22 &&
      registrations[0].options.label === '分流代理',
    JSON.stringify(registrations[0]?.options),
  )
  // 组件与注册之间靠这个 hook 名对接:hooks.proxyRouterSection → props.useProxyRouterSection。
  const face = registrations[0]?.options.inject?.()
  check(
    'inject 交出的面:proxyRouterSection store + 表单动作',
    face?.hooks?.proxyRouterSection !== undefined && typeof face.save === 'function' && typeof face.edit === 'function',
    JSON.stringify(Object.keys(face ?? {})),
  )
  check('分区样式已注入且带 data-plugin-css 标记', styleTags.length === 1 && String(styleTags[0].dataset.pluginCss ?? '').includes('dsh-proxy-router'))

  // 白屏防线:服务缺失/形状不符时必须安静退出,绝不抛(浏览器半抛错会掀掉整棵组合树)
  const registrations2 = []
  const ctxMissing = { slots: { inject: () => {}, register: (o) => { registrations2.push(o); return () => {} } }, effect: (fn) => fn() }
  let threw = false
  const warns = []
  const realWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    plugin.apply(ctxMissing)
  } catch {
    threw = true
  }
  console.warn = realWarn
  check('configForms 缺失时安静退出(不抛错、不注册)', threw === false && registrations2.length === 0 && warns.some((line) => line.includes('configForms 不可用')))
  delete globalThis.window
  delete globalThis.document
}

// ──────────── 7. 字段规则(客户端)与监听地址加固(两侧) ────────────
console.log('\n[7] 字段规则与监听地址加固')
{
  const { upstreamField, listenField, routeField, booleanField, nonNegativeNumberField, millisecondsField } = await import('../src/client/fields.ts')
  const parse = (spec, text) => spec.parse(text)
  check('上游只接受 http(s)', parse(upstreamField(), 'socks5://1.2.3.4:1080') === undefined && parse(upstreamField(), 'http://1.2.3.4:8080')?.value === 'http://1.2.3.4:8080')
  check('上游留空 = 清除覆盖(回落到环境变量)', parse(upstreamField(), '  ')?.kind === 'clear')
  check('监听地址校验端口', parse(listenField(), '127.0.0.1:99999') === undefined && parse(listenField(), '127.0.0.1:17890')?.value === '127.0.0.1:17890')
  check('监听地址留空 = 回到默认', parse(listenField(), '')?.kind === 'clear')
  check(
    '监听地址只收回环(0.0.0.0 / 内网 / 公网 / 非回环 IPv6 都判非法)',
    ['0.0.0.0:17890', '192.168.1.5:17890', '8.8.8.8:17890', '[2001:db8::1]:17890'].every(
      (text) => parse(listenField(), text) === undefined,
    ) &&
      parse(listenField(), 'localhost:0')?.value === 'localhost:0' &&
      parse(listenField(), '[::1]:1234')?.value === '[::1]:1234',
  )
  check('未命中走向只认 direct/proxy', parse(routeField(), 'both') === undefined && parse(routeField(), 'proxy')?.value === 'proxy')
  check('布尔字段接受 true/false/1/0/on/off', ['true', '1', 'on', 'yes'].every((t) => parse(booleanField('debug'), t)?.value === true) && ['false', '0', 'off', 'no'].every((t) => parse(booleanField('debug'), t)?.value === false))
  check('非负整数字段拒绝负数与小数', parse(nonNegativeNumberField('refreshHours'), '-1') === undefined && parse(nonNegativeNumberField('refreshHours'), '2.5') === undefined && parse(nonNegativeNumberField('refreshHours'), '24')?.value === 24)
  check('超时字段有下限', parse(millisecondsField('connectTimeoutMs', 1000), '500') === undefined && parse(millisecondsField('connectTimeoutMs', 1000), '15000')?.value === 15000)

  // 宿主侧再拦一道:有人直接改 profile 文件(绕过上面的表单校验)时不能真的绑出去
  const { parseListen } = await import('../src/config.ts')
  const warns = []
  const fakeLog = { info: () => {}, debug: () => {}, warn: (message) => warns.push(String(message)) }
  check(
    '宿主侧 parseListen 把非回环地址改回回环并告警',
    parseListen('0.0.0.0:18080', fakeLog).host === '127.0.0.1' &&
      parseListen('0.0.0.0:18080', fakeLog).port === 18080 &&
      warns.some((line) => line.includes('不是回环地址')),
    JSON.stringify({ warn: warns.at(-1) }),
  )
  check('宿主侧 parseListen 保留合法回环地址', parseListen('127.0.0.1:18081', fakeLog).port === 18081 && parseListen(':18082', fakeLog).port === 18082)
}

// ──────────── 8. 防自环(线上曾刷出 1.1 亿次请求) ────────────
console.log('\n[8] 防自环')
{
  const net = await import('node:net')
  const http = await import('node:http')
  const { createRouterServer } = await import('../src/router.ts')
  /** 直接用 node:http 打代理端口(绕开进程全局 dispatcher,也更贴近浏览器/curl 的真实行为)。 */
  const rawGet = (url, timeoutMs = 4000) =>
    new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        resolve({ status: 0, body: 'timeout' })
      })
      req.on('error', (error) => resolve({ status: 0, body: error.message }))
    })
  const warns = []
  const isolated = createRouterServer({
    decide: () => ({ route: 'direct', reason: 'private' }),
    getUpstream: () => null,
    getConnectTimeoutMs: () => 1000,
    getDebug: () => false,
    getFallbackDirect: () => true,
    log: { info: () => {}, warn: (message) => warns.push(message), debug: () => {} },
  })
  const bound = await isolated.listen('127.0.0.1', PORT + 4)
  const base = `http://127.0.0.1:${bound.port}`
  const before = isolated.stats().total

  const probe = await rawGet(`${base}/probe-self`)
  check('目标=自己的明文请求被拒绝(421)', probe.status === 421, String(probe.status))
  const favicon = await rawGet(`${base}/favicon.ico`)
  check('favicon 返回 204(浏览器打开代理端口不再引爆循环)', favicon.status === 204, String(favicon.status))
  const root = await rawGet(`${base}/`)
  check('根路径返回人话提示', root.status === 200 && root.body.includes('分流代理'), String(root.status))

  const connectReply = await new Promise((resolve) => {
    const socket = net.connect(bound.port, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${bound.port} HTTP/1.1\r\nHost: probe\r\n\r\n`)
    })
    socket.once('data', (data) => {
      resolve(String(data).slice(0, 16))
      socket.destroy()
    })
    socket.once('error', () => resolve('error'))
    setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, 3000)
  })
  check('CONNECT 到自己被拒绝而不是递归', String(connectReply).includes('421'), String(connectReply))

  // 同样的请求再打 5 次:限流应当只让第一行通过(否则浏览器一刷新就刷屏)
  for (let i = 0; i < 5; i++) await rawGet(`${base}/probe-self`)
  const delta = isolated.stats().total - before
  check('未发生自我递归(请求数增量 <= 11)', delta <= 11, `增量 ${delta}(修复前一次请求会滚成上万次)`)
  check(
    '同一情况的告警被限流(只记一行,并带方法与路径)',
    warns.length === 4 && warns[0].includes('自我递归') && warns[0].includes('/probe-self'),
    `${warns.length} 行:${warns.join(' | ').slice(0, 120)}`,
  )
  await isolated.close()

  // B) 完整装配:上游被填成插件自己的监听地址 → 必须忽略,且规则命中时退化为直连而不是死循环
  const STATE8 = join(HERE, '.test-state-8')
  rmSync(STATE8, { recursive: true, force: true })
  mkdirSync(STATE8, { recursive: true })
  const rulesFile8 = join(STATE8, 'rules.txt')
  writeFileSync(rulesFile8, 'proxy: www.baidu.com\n', 'utf8')
  const ctx8 = { get: () => undefined, effect: (fn) => disposers.push(fn()) }
  apply(ctx8, {
    enabled: true,
    upstream: `http://127.0.0.1:${PORT}`,
    listen: `127.0.0.1:${PORT}`,
    lists: [],
    refreshHours: 0,
    stateDir: STATE8,
    rulesFile: rulesFile8,
  })
  const status8 = await waitForReady()
  // 状态里保留用户填的原值(设置页要显示它),另用 upstreamIgnored 标注「已忽略」——
  // 这样用户看得到自己填了什么、也看得到为什么没生效。
  check(
    '上游指向自己时被忽略并在状态里标注',
    status8.upstreamIgnored === true && String(status8.upstream?.url ?? '').startsWith('http://127.0.0.1:'),
    JSON.stringify({ upstream: status8.upstream, ignored: status8.upstreamIgnored }),
  )
  const why8 = await (await fetch(`${LOCAL}/__proxy-router/why?host=www.baidu.com`)).json()
  check('规则本身仍判定为 proxy(只是没有可用上游)', why8.route === 'proxy', JSON.stringify(why8))
  const statsBefore = (await (await fetch(`${LOCAL}/__proxy-router/status`)).json()).stats.total
  const baidu = await curlThroughProxy('https://www.baidu.com/')
  const statsAfter = (await (await fetch(`${LOCAL}/__proxy-router/status`)).json()).stats.total
  check('规则命中但没有上游时退化为直连且不循环', baidu.code === '200' && statsAfter - statsBefore <= 3, `${baidu.code || baidu.err};增量 ${statsAfter - statsBefore}`)
  for (const dispose of disposers.splice(0)) await dispose()
  rmSync(STATE8, { recursive: true, force: true })
}

// ──────────── 9. 总开关:默认关 = 插件完全不动作 ────────────
console.log('\n[9] 总开关(默认关 / 热启停)')
{
  const STATE9 = join(HERE, '.test-state-9')
  rmSync(STATE9, { recursive: true, force: true })
  mkdirSync(STATE9, { recursive: true })
  const rulesFile9 = join(STATE9, 'rules.txt')
  writeFileSync(rulesFile9, 'proxy: www.google.com\n', 'utf8')
  const PORT9 = Number(process.env.TEST_PORT_SWITCH ?? 17931)
  const LOCAL9 = `http://127.0.0.1:${PORT9}`

  const { apply: applySwitch } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)

  // 上一段的收摊是异步的(disposer 只是 `void shutdown()`,不 await):不等它落地就取基线,
  // 会把别人回填环境变量的动作算到这一段头上 —— 这里先等一拍再取基线。
  await new Promise((r) => setTimeout(r, 800))
  // 环境变量基线:关掉开关后必须还原成这一份(策略模块自己负责还原)。
  const envBefore = {
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    no_proxy: process.env.no_proxy,
  }
  const envMatches = () =>
    process.env.http_proxy === envBefore.http_proxy &&
    process.env.https_proxy === envBefore.https_proxy &&
    process.env.no_proxy === envBefore.no_proxy
  /** 等环境变量回到基线:策略还原发生在「关监听」之后,不能抢跑断言。 */
  const waitEnv = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (envMatches()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  /** 总开关的「宿主引用」:默认关(与 schema 默认一致)。 */
  let enabled = false
  const events9 = []
  const routes9 = []
  const disposers9 = []
  const fakeWebServer9 = { register(route) { routes9.push(route); return () => {} } }
  const ctx9 = {
    get: (name) => (name === 'webServer' ? fakeWebServer9 : undefined),
    on: (name, listener) => { events9.push([name, listener]) },
    effect: (fn) => { disposers9.push(fn()) },
    inject: (deps, cb) => cb({ get: (name) => (name === 'webServer' ? fakeWebServer9 : undefined) }),
  }
  applySwitch(ctx9, {
    // 不传 enabled = 让插件走 schema 默认(false);其余字段给足,证明「关」是开关说了算
    enabled: { get: () => enabled },
    upstream: { get: () => UPSTREAM },
    listen: { get: () => `127.0.0.1:${PORT9}` },
    refreshHours: { get: () => 0 },
    connectTimeoutMs: { get: () => 15000 },
    fallbackDirect: { get: () => true },
    debug: { get: () => false },
    lists: [],
    stateDir: STATE9,
    rulesFile: rulesFile9,
  })

  /** 直连端口:连得上 = 有人在监听(关着的时候不该有人监听)。 */
  const probe = async () => {
    try {
      const res = await fetch(`${LOCAL9}/__proxy-router/status`, { signal: AbortSignal.timeout(1000) })
      return res.ok ? await res.json() : null
    } catch {
      return null
    }
  }
  /** 从 Web 状态路由读快照(关着的时候没有本地端口,面板走的就是这条)。 */
  const webStatus = async () => {
    const handler = routes9.find((route) => route.path === '/dsh-proxy-router/status')?.handler
    if (handler === undefined) return null
    let body = ''
    await handler({ method: 'GET' }, { writeHead() {}, end(text) { body = text ?? '' } })
    return JSON.parse(body)
  }
  /** 派发一次宿主热更新(宿主改完引用后发的就是它)。 */
  const fire = () => {
    for (const [name, listener] of events9) if (name === 'loader/volatile-update') listener()
  }

  await new Promise((r) => setTimeout(r, 400))
  check('默认关:根本没人监听本地端口', (await probe()) === null)
  const off = await webStatus()
  check(
    '默认关:状态路由仍可用,并如实报告 enabled=false / 未监听 / 未接管策略',
    off?.enabled === false && off?.listening === null && off?.policy === null && off?.stats === null,
    JSON.stringify({ enabled: off?.enabled, listening: off?.listening, policy: off?.policy }),
  )
  check(
    '默认关:一个代理变量都不碰',
    envMatches(),
    `http_proxy=${String(process.env.http_proxy)} / https_proxy=${String(process.env.https_proxy)}`,
  )

  // 打开开关:宿主改引用 + 派发事件
  enabled = true
  fire()
  let up = null
  for (let i = 0; i < 40 && up === null; i++) {
    await new Promise((r) => setTimeout(r, 150))
    up = await probe()
  }
  check(
    '打开开关后立即开始监听并接管策略(不用重启宿主)',
    up !== null && up.enabled === true && up.policy?.verified === true,
    JSON.stringify({ enabled: up?.enabled, childRouting: up?.policy?.childRouting, listening: up?.listening }),
  )
  const routed = await curlThroughProxy('https://www.google.com/', [], LOCAL9)
  check('打开后分流真的生效(被墙域名经上游 200)', routed.code === '200', routed.code || routed.err)

  // 再关掉:必须收干净 —— 端口关掉、策略还原、状态如实
  enabled = false
  fire()
  let closed = false
  for (let i = 0; i < 40 && !closed; i++) {
    await new Promise((r) => setTimeout(r, 150))
    closed = (await probe()) === null
  }
  check('关掉开关后停止监听', closed)
  const offAgain = await webStatus()
  check(
    '关掉后状态回到 enabled=false(策略与统计清空,不再误导)',
    offAgain?.enabled === false && offAgain?.listening === null && offAgain?.policy === null,
    JSON.stringify({ enabled: offAgain?.enabled, listening: offAgain?.listening, policy: offAgain?.policy }),
  )
  check(
    '关掉开关把代理变量还原了',
    await waitEnv(),
    `http_proxy=${String(process.env.http_proxy)} / https_proxy=${String(process.env.https_proxy)}`,
  )

  for (const dispose of disposers9.splice(0)) await dispose()
  rmSync(STATE9, { recursive: true, force: true })
}

// ──────────── 10. 本地规则路由(GET/PUT /dsh-proxy-router/rules) ────────────
console.log('\n[10] 设置页的规则编辑区(宿主路由)')
{
  const http = await import('node:http')
  const STATE10 = join(HERE, '.test-state-10')
  rmSync(STATE10, { recursive: true, force: true })
  mkdirSync(STATE10, { recursive: true })
  const rulesFile10 = join(STATE10, 'rules.txt')
  writeFileSync(rulesFile10, '# 初始\nproxy: www.google.com\n', 'utf8')
  const PROXY_PORT = Number(process.env.TEST_PORT_RULES ?? 17941)
  const ROUTE_PORT = PROXY_PORT + 1

  const { apply: applyRules } = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
  const routes10 = []
  const disposers10 = []
  const fakeWebServer10 = { register(route) { routes10.push(route); return () => {} } }
  applyRules(
    {
      get: (name) => (name === 'webServer' ? fakeWebServer10 : undefined),
      on: () => {},
      effect: (fn) => { disposers10.push(fn()) },
      inject: (deps, cb) => cb({ get: (name) => (name === 'webServer' ? fakeWebServer10 : undefined) }),
    },
    {
      enabled: true,
      upstream: UPSTREAM,
      listen: `127.0.0.1:${PROXY_PORT}`,
      lists: [],
      refreshHours: 0,
      stateDir: STATE10,
      rulesFile: rulesFile10,
    },
  )

  // 把插件注册的路由挂到一个真实的 node:http 服务器上 —— 这样 request body、头部与
  // 流式读取都走真实的 IncomingMessage,而不是自己捏的假对象。
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes10.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(ROUTE_PORT, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${ROUTE_PORT}`
  const origin = { origin: base }
  const put = (content, headers) =>
    fetch(`${base}/dsh-proxy-router/rules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ content }),
    })

  const got = await (await fetch(`${base}/dsh-proxy-router/rules`)).json()
  check(
    'GET 返回路径/正文/解析摘要',
    got.path === rulesFile10 && got.exists === true && got.content.includes('proxy: www.google.com') && got.summary?.total === 1,
    JSON.stringify({ path: got.path, summary: got.summary }),
  )
  check('PUT 缺 Origin/Referer → 403(宿主路由不过会话认证,写入口自己挡)', (await put('proxy: a.com', {})).status === 403)
  check('PUT 跨站 Origin → 403', (await put('proxy: a.com', { origin: 'http://evil.example' })).status === 403)
  check('POST → 405', (await fetch(`${base}/dsh-proxy-router/rules`, { method: 'POST', ...{ headers: origin } })).status === 405)

  const badJson = await fetch(`${base}/dsh-proxy-router/rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...origin },
    body: '{ 不是 JSON',
  })
  check('PUT 非法 JSON → 400', badJson.status === 400)

  const tooBig = await put('x'.repeat(300 * 1024), origin)
  check('PUT 超过体积上限 → 413', tooBig.status === 413)

  // 正常保存:带一行无法识别的内容,检查「写盘 + 备份 + 逐行诊断 + 立刻生效」
  const next = '# 新规则\ndirect: www.google.com\n这行肯定不是域名\nproxy: 1.2.3.4\n'
  const saved = await (await put(next, origin)).json()
  check(
    'PUT 保存成功并回报诊断(1 行未识别,行号指向它)',
    saved.ok === true && saved.summary?.direct === 1 && saved.summary?.skipped === 1 && saved.issues?.[0]?.line === 3,
    JSON.stringify({ summary: saved.summary, issues: saved.issues }),
  )
  check('写盘内容与提交一致', readFileSync(rulesFile10, 'utf8') === next)
  check('旧内容已备份到 <rulesFile>.bak', readFileSync(`${rulesFile10}.bak`, 'utf8').includes('proxy: www.google.com'))
  check('没有留下临时文件', !existsSync(`${rulesFile10}.tmp-${process.pid}`))
  const why = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/__proxy-router/why?host=www.google.com`)).json()
  check('保存后立刻生效(google 从 proxy 改判 direct)', why.route === 'direct' && why.reason.includes('local'), JSON.stringify(why))

  for (const dispose of disposers10.splice(0)) await dispose()
  await new Promise((resolve) => server.close(resolve))
  rmSync(STATE10, { recursive: true, force: true })
}

rmSync(STATE_DIR, { recursive: true, force: true })
rmSync(join(HERE, '.test-state-2'), { recursive: true, force: true })

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`)
process.exit(failures === 0 ? 0 : 1)
