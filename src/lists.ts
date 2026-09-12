/**
 * 清单装载层:本地规则文件(热加载)+ 远程被墙清单(带磁盘缓存)。
 *
 * 磁盘布局(默认 `<DSH_HOME>/proxy-router/`):
 *   rules.txt          本地规则,用户按经验增删;不存在时写入带注释的模板
 *   cache/<name>.txt   远程清单缓存;文件 mtime 即上次成功拉取时间
 *
 * 装载顺序决定了首启体验:先用「本地规则 + 上次缓存」把规则表建起来(毫秒级,
 * 不依赖网络),再在后台刷新过期清单并把新表原子换上去 —— 任何时刻网络不可用,
 * 插件都已经处于可用状态。
 */
import { existsSync, mkdirSync, watch as watchFs, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseRules, RuleTable, type Route, type RuleStore } from './rules.js'
import type { Logger, TextFetcher } from './fetcher.js'

/** 一条远程清单的配置。 */
export interface RemoteListSpec {
  name: string
  url: string
  /** 命中的域名走哪个动作(被墙清单 = proxy)。 */
  route: Route
}

/** 每条远程清单的装载状态,供日志与 /status 展示。 */
export interface RemoteListState {
  name: string
  url: string
  route: Route
  count: number
  fetchedAt: number | null
  lastError: string | null
}

export interface RuleLoaderOptions {
  store: RuleStore
  /** 本地规则文件绝对路径。 */
  localFile: string
  /** 状态目录(缓存与模板所在)。 */
  stateDir: string
  lists: readonly RemoteListSpec[]
  /** 远程清单刷新周期(小时);0 = 不自动刷新。 */
  refreshHours: number
  /** 本地规则文件里裸域名的默认动作。 */
  localDefaultRoute: Route
  fetcher: TextFetcher
  log: Logger
}

/** 首次运行时写下的模板:语法就地说明,用户不用翻 README。 */
const LOCAL_RULES_TEMPLATE = `# @yangzhe1991/dsh-proxy-router 本地规则
#
# 这个文件改完立即生效(自动热加载),不需要重启 dsh。
# 规则自上而下匹配,先命中者生效;本地规则优先级高于远程被墙清单,
# 所以「远程清单误伤了国内站点」时,在这里加一条 direct: 就能纠正。
#
# 语法(每行一条,# 开头是注释):
#   proxy: example.com        该域名及其所有子域 → 走上游代理
#   direct: example.com       该域名及其所有子域 → 强制直连
#   example.com               裸域名等价于 proxy:
#
# 兼容写法:*.example.com、.example.com、+.example.com、DOMAIN-SUFFIX,example.com
#
# 例子:
# proxy: some-blocked-site.com
# direct: cdn.example.cn
`

/** 缓存文件路径:名字只用来做文件名,做一次保守净化,避免配置里的奇怪字符越出目录。 */
function cachePathFor(stateDir: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(stateDir, 'cache', `${safe}.txt`)
}

export class RuleLoader {
  private readonly options: RuleLoaderOptions
  private readonly states: RemoteListState[]
  private localCount = 0
  private localSkipped = 0
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private closed = false
  /** 远程刷新串行化:重复调用复用同一轮,避免并发拉取与规则表反复重建。 */
  private refreshing: Promise<void> | null = null

  constructor(options: RuleLoaderOptions) {
    this.options = options
    this.states = options.lists.map((list) => ({
      name: list.name,
      url: list.url,
      route: list.route,
      count: 0,
      fetchedAt: null,
      lastError: null,
    }))
  }

  /**
   * 起步:建目录、确保本地规则文件存在、装载本地规则与远程缓存,
   * 然后挂上热加载与刷新定时器。
   */
  async start(): Promise<void> {
    const { stateDir, localFile, log } = this.options
    try {
      await mkdir(join(stateDir, 'cache'), { recursive: true })
    } catch (error) {
      log.warn(`状态目录创建失败(${String(error)}),远程清单缓存将不可用`)
    }
    if (!existsSync(localFile)) {
      try {
        await mkdir(dirname(localFile), { recursive: true })
        await writeFile(localFile, LOCAL_RULES_TEMPLATE, 'utf8')
        log.info(`已生成本地规则文件模板: ${localFile}`)
      } catch (error) {
        log.warn(`本地规则文件创建失败(${String(error)}),本地规则暂不可用`)
      }
    }
    await this.reloadLocal()
    await this.loadCaches()
    this.watchLocalFile()
    if (this.options.refreshHours > 0) {
      const periodMs = Math.max(1, this.options.refreshHours) * 3600_000
      this.timer = setInterval(() => {
        void this.refresh(false)
      }, periodMs)
      this.timer.unref()
    }
  }

  /** 装载本地规则文件(热加载与手动 reload 都走这里)。 */
  async reloadLocal(): Promise<void> {
    const { localFile, localDefaultRoute, store, log } = this.options
    let text = ''
    try {
      text = await readFile(localFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`本地规则文件读取失败(${String(error)}),本次按空规则处理`)
      }
    }
    const { rules, skipped } = parseRules(text, { defaultRoute: localDefaultRoute, source: 'local' })
    const table = new RuleTable()
    table.addAll(rules)
    store.local = table
    this.localCount = table.size
    this.localSkipped = skipped
  }

  /** 从磁盘缓存装载远程清单(不联网)。 */
  private async loadCaches(): Promise<void> {
    const { store, stateDir, log } = this.options
    const table = new RuleTable()
    for (const state of this.states) {
      const path = cachePathFor(stateDir, state.name)
      try {
        const info = await stat(path)
        const text = await readFile(path, 'utf8')
        const { rules } = parseRules(text, { defaultRoute: state.route, source: `list:${state.name}` })
        table.addAll(rules)
        state.count = rules.length
        state.fetchedAt = info.mtimeMs
        state.lastError = null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`清单缓存读取失败 ${path}: ${String(error)}`)
        }
        state.count = 0
        state.fetchedAt = null
      }
    }
    store.remote = table
  }

  /**
   * 刷新远程清单。force=true 时忽略周期。
   * 强制串行:同一时刻只跑一轮,重复调用复用同一 promise。
   */
  async refresh(force: boolean): Promise<void> {
    if (this.closed) return
    if (this.refreshing !== null) return await this.refreshing
    this.refreshing = this.doRefresh(force).finally(() => {
      this.refreshing = null
    })
    return await this.refreshing
  }

  private async doRefresh(force: boolean): Promise<void> {
    const { stateDir, fetcher, log } = this.options
    const maxAgeMs = Math.max(1, this.options.refreshHours) * 3600_000
    const now = Date.now()
    let changed = false
    for (const state of this.states) {
      if (state.fetchedAt !== null && now - state.fetchedAt < maxAgeMs && !force) continue
      // 直连优先(国内多数网络可达 jsDelivr),不行再借上游代理这条现成通道
      let text: string | null = null
      let firstError: unknown = null
      for (const viaProxy of [false, true]) {
        try {
          text = await fetcher.fetchText(state.url, viaProxy)
          break
        } catch (error) {
          if (firstError === null) firstError = error
        }
      }
      if (text === null) {
        state.lastError = String(firstError)
        log.warn(`清单刷新失败 ${state.name} (${state.url}): ${String(firstError)}`)
        continue
      }
      const path = cachePathFor(stateDir, state.name)
      try {
        // 原子替换:先写临时文件再 rename,避免宿主中途挂掉留下半截清单
        const temp = `${path}.tmp`
        await writeFile(temp, text, 'utf8')
        await rename(temp, path)
      } catch (error) {
        log.warn(`清单缓存写入失败 ${path}: ${String(error)}`)
      }
      state.fetchedAt = Date.now()
      state.lastError = null
      changed = true
    }
    if (changed) {
      await this.loadCaches()
      log.info(`远程清单已更新: ${this.describeRemote()}`)
    }
  }

  /** 本地规则文件热加载:防抖 200ms,兼容编辑器「写临时文件再 rename」的保存方式。 */
  private watchLocalFile(): void {
    const { localFile, log } = this.options
    try {
      this.watcher = watchFs(dirname(localFile), { persistent: false }, (_event, filename) => {
        if (filename !== null && String(filename) !== basename(localFile)) return
        if (this.debounce !== null) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          void this.reloadLocal()
            .then(() => {
              log.info(`本地规则已重载: ${this.localCount} 条(跳过 ${this.localSkipped} 行)`)
            })
            .catch((error: unknown) => log.warn(`本地规则重载失败: ${String(error)}`))
        }, 200)
        this.debounce.unref()
      })
    } catch (error) {
      log.warn(`本地规则文件监听失败(${String(error)}),改动需重启 dsh 生效`)
    }
  }

  /** 手动触发一次完整重载(供调试接口使用)。 */
  async reloadAll(): Promise<void> {
    await this.reloadLocal()
    await this.refresh(true)
  }

  private describeRemote(): string {
    return this.states
      .map((state) => `${state.name}=${state.count}${state.lastError === null ? '' : '(失败)'}`)
      .join(', ')
  }

  /** 启动摘要(一行,便于在宿主日志里定位)。 */
  describe(): string {
    const parts = [`本地规则 ${this.localCount} 条`]
    if (this.localSkipped > 0) parts.push(`跳过 ${this.localSkipped} 行`)
    for (const state of this.states) {
      const when =
        state.fetchedAt === null ? '无缓存' : new Date(state.fetchedAt).toISOString().slice(0, 16).replace('T', ' ')
      parts.push(`${state.name} ${state.count} 条(${when}${state.lastError === null ? '' : ',上次刷新失败'})`)
    }
    return parts.join('; ')
  }

  /** 每条远程清单当前是否过期(供 /status 展示)。 */
  staleList(): { state: RemoteListState; stale: boolean }[] {
    const maxAgeMs = Math.max(1, this.options.refreshHours) * 3600_000
    const now = Date.now()
    return this.states.map((state) => ({
      state,
      stale: this.options.refreshHours > 0 && (state.fetchedAt === null || now - state.fetchedAt > maxAgeMs),
    }))
  }

  /** 本地规则文件路径(供日志与 /status 展示)。 */
  get localFile(): string {
    return this.options.localFile
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) clearInterval(this.timer)
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.watcher?.close()
    this.watcher = null
  }
}
