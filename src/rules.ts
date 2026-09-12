/**
 * 规则层:把各种来路的清单文本解析成一张可分流的规则表,并回答
 * 「这个主机名该直连还是该走上游代理」。
 *
 * 支持三种来源,优先级从高到低:
 *   1. 本地规则文件(用户按经验增删,支持热加载)
 *   2. 远程被墙清单(gfw.txt / greatfire.txt 之类的 Clash rule-provider)
 *   3. 内置种子清单(离线兜底)
 * 三者都不命中时落到配置的 defaultRoute(本插件默认 direct)。
 *
 * 匹配语义:一条 `example.com` 规则同时命中 `example.com` 与 `*.example.com`
 * (与 Clash 的 domain/domain-suffix behavior 一致,GWF 清单里的 `+.example.com`
 * 也是这个意思),查找时按标签从右往左逐级收缩,单次查找最多 N 次哈希(域名标签数)。
 */

/** 分流动作:direct = 直连;proxy = 交给上游代理。 */
export type Route = 'direct' | 'proxy'

/** 一条规则的匹配形态。 */
export type RuleKind = 'suffix' | 'exact' | 'keyword'

/** 解析后的一条规则。 */
export interface ParsedRule {
  /** 规则主体(已归一化:小写、punycode、无前导点)。 */
  pattern: string
  route: Route
  kind: RuleKind
  /** 规则出处,命中时写进日志/`why` 接口,便于溯源。 */
  source: string
}

/** 一次命中的结果。 */
export interface RuleHit {
  route: Route
  pattern: string
  kind: RuleKind
  source: string
}

/**
 * 主机名归一化:去掉 IPv6 方括号、末尾点,统一小写。
 * 非 ASCII(中文域名等)经 URL 转成 punycode —— 清单里存的是 punycode,
 * 用户手写中文域名时也要能对上。
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim()
  if (host.startsWith('[')) host = host.replace(/^\[|\]$/g, '')
  host = host.replace(/\.$/, '')
  if (host === '') return host
  // eslint-disable-next-line no-control-regex -- 非 ASCII 才需要走 URL 转换
  if (!/^[\x00-\x7F]*$/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname
    } catch {
      /* 转换失败就按原样匹配,交给后面的校验兜底 */
    }
  }
  return host.toLowerCase()
}

/** 点分十进制 IPv4 解析(供私有地址判定使用),非法返回 undefined。 */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    nums.push(n)
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
}

/**
 * 是否本机/局域网地址 —— 这类目标永远直连,绝不能丢给上游代理:
 * 上游在别的网络里,既解析不到也路由不回来;本机服务更是只有直连才可达。
 *
 * 覆盖:localhost / *.localhost;IPv4 私有段(10/8、172.16/12、192.168/16)、
 * 回环 127/8、链路本地 169.254/16、运营商级 NAT 100.64/10、组播与保留段;
 * IPv6 的 ::1、fc00::/7(ULA)、fe80::/10(链路本地)以及 IPv4 映射写法;
 * 另外把「不含点的单标签主机名」(nas、router 之类)也当内网处理。
 */
export function isPrivateHost(rawHost: string): boolean {
  const host = normalizeHost(rawHost)
  if (host === '' ) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fc') || host.startsWith('fd')) {
    // fc00::/7:唯一本地地址
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true
  }
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true // fe80::/10 链路本地
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (mapped) return isPrivateHost(mapped[1]!)
  const v4 = parseIpv4(host)
  if (v4) {
    const [a, b] = v4
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 198 && (b === 18 || b === 19)) return true // 基准测试段
    if (a >= 224) return true // 组播 + 保留
    return false
  }
  // 不含点的单标签主机名:内网短名(DHCP/DNS 后缀补齐),直连最稳
  if (!host.includes('.')) return true
  return false
}

/** 域名/IP 字面量校验:宽松到够用即可,目的是挡掉解析噪声而不是做 DNS 校验。 */
function isValidPattern(pattern: string): boolean {
  if (pattern === '') return false
  if (pattern.includes('*')) return false
  if (parseIpv4(pattern)) return true
  if (pattern.includes(':')) return /^[0-9a-f:]+$/.test(pattern) // IPv6 字面量
  return /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+$/.test(pattern)
}

/** 解析统计,便于启动日志里解释「为什么少了若干行」。 */
export interface ParseOutcome {
  rules: ParsedRule[]
  skipped: number
}

/**
 * 解析任意清单文本。刻意做得宽容:直接被喂进来的既有我们自己写的本地规则,
 * 也有第三方 Clash rule-provider(gfw.txt 是 `payload:` + `- '+.domain'` 形态,
 * direct.txt/proxy.txt 是裸域名列表),还有可能顺手粘进来的 dnsmasq 行。
 *
 * @param text 清单全文。
 * @param options.defaultRoute 没有显式动作前缀的行按什么动作处理(远程代理清单 = proxy)。
 * @param options.source 出处名,写进 RuleHit 供溯源。
 */
export function parseRules(
  text: string,
  options: { defaultRoute: Route; source: string },
): ParseOutcome {
  const rules: ParsedRule[] = []
  let skipped = 0
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue
    // YAML 列表项 / 引号
    line = line.replace(/^-\s+/, '')
    line = line.replace(/^['"]|['"]$/g, '')
    // rule-provider 的元信息行(payload: / behavior: / type: ...)
    if (/^(payload|behavior|type|name|version|description)\s*:/i.test(line)) {
      // payload: 后面可能直接跟条目(同一行),把它切出来继续解析
      const colon = line.indexOf(':')
      const rest = line.slice(colon + 1).trim()
      if (rest === '') continue
      line = rest
    }
    // dnsmasq 的 server=/domain/dns 形态:顺手支持,免得用户贴错文件格式白忙
    const dnsmasq = /^server=\/([^/]+)\//.exec(line)
    if (dnsmasq) line = dnsmasq[1]!

    let route = options.defaultRoute
    let kind: RuleKind = 'suffix'

    // 显式动作前缀:本地规则用 `proxy:` / `direct:`
    const prefixed = /^(proxy|direct)\s*:\s*(.+)$/i.exec(line)
    if (prefixed) {
      route = prefixed[1]!.toLowerCase() === 'direct' ? 'direct' : 'proxy'
      line = prefixed[2]!.trim()
    } else {
      // Clash / Surge 规则行:DOMAIN-SUFFIX,x / DOMAIN,x / DOMAIN-KEYWORD,x
      const clash = /^(DOMAIN-SUFFIX|HOST-SUFFIX|DOMAIN|HOST|DOMAIN-KEYWORD|HOST-KEYWORD|PROXY|DIRECT)\s*,\s*(.+)$/i.exec(line)
      if (clash) {
        const type = clash[1]!.toUpperCase()
        const value = clash[2]!.trim().replace(/^['"]|['"]$/g, '')
        if (type === 'PROXY' || type === 'DIRECT') {
          const inner = type === 'PROXY' ? 'proxy' : 'direct'
          const rest = /^(proxy|direct)\s*:\s*(.+)$/i.exec(value)
          const pattern = normalizeHost(rest ? rest[2]! : value)
          if (!isValidPattern(pattern)) { skipped++; continue }
          rules.push({ pattern, route: inner, kind: 'exact', source: options.source })
          continue
        }
        if (type.includes('KEYWORD')) {
          const keyword = value.toLowerCase()
          if (keyword === '') { skipped++; continue }
          rules.push({ pattern: keyword, route, kind: 'keyword', source: options.source })
          continue
        }
        line = value
        kind = type.includes('SUFFIX') ? 'suffix' : 'exact'
      }
    }

    // 清洗各种通配写法
    line = line.replace(/^\|\|?/, '').replace(/\^$/, '').replace(/\/.*$/, '')
    line = line.replace(/^\*\./, '').replace(/^\+\./, '').replace(/^\./, '')
    const pattern = normalizeHost(line)
    if (!isValidPattern(pattern)) { skipped++; continue }
    rules.push({ pattern, route, kind, source: options.source })
  }
  return { rules, skipped }
}

/**
 * 规则表:域名后缀 / 精确 / 关键字三类规则,查找按「后缀表 → 精确表 → 关键字表」。
 * 后缀表用 Map 存,查找时对主机名逐级去头(api.a.example.com → a.example.com → example.com),
 * 命中即返回,所以单次查找开销是 O(标签数),几十万条规则的清单也不慢。
 */
export class RuleTable {
  private readonly suffix = new Map<string, RuleHit>()
  private readonly exact = new Map<string, RuleHit>()
  private readonly keywords: RuleHit[] = []

  /** 同名规则后写覆盖先写(本地文件从下往上、后加载的清单优先,符合直觉)。 */
  set(rule: ParsedRule): void {
    const hit: RuleHit = { route: rule.route, pattern: rule.pattern, kind: rule.kind, source: rule.source }
    if (rule.kind === 'keyword') this.keywords.push(hit)
    else if (rule.kind === 'exact') this.exact.set(rule.pattern, hit)
    else this.suffix.set(rule.pattern, hit)
  }

  addAll(rules: readonly ParsedRule[]): void {
    for (const rule of rules) this.set(rule)
  }

  /** 按主机名查找;未命中返回 undefined。 */
  lookup(rawHost: string): RuleHit | undefined {
    const host = normalizeHost(rawHost)
    if (host === '') return undefined
    const exact = this.exact.get(host)
    if (exact) return exact
    const labels = host.split('.')
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.')
      const hit = this.suffix.get(candidate)
      if (hit) return hit
    }
    for (const keyword of this.keywords) if (host.includes(keyword.pattern)) return keyword
    return undefined
  }

  get size(): number {
    return this.suffix.size + this.exact.size + this.keywords.length
  }
}

/**
 * 三层优先级的规则仓库:local(本地文件) > remote(远程清单) > seed(内置种子)。
 * 三张表分别持有,查询时依次问 —— 这样「本地直连白名单」总能盖住远程代理清单,
 * 用户不必去改远程清单。
 */
export class RuleStore {
  local = new RuleTable()
  remote = new RuleTable()
  seed = new RuleTable()

  /** 决策入口:私有地址/单标签主机名永远直连,其余按三层规则,最后落默认值。 */
  decide(rawHost: string, defaultRoute: Route): { route: Route; reason: string } {
    if (isPrivateHost(rawHost)) return { route: 'direct', reason: 'private' }
    const hit = this.local.lookup(rawHost) ?? this.remote.lookup(rawHost) ?? this.seed.lookup(rawHost)
    if (hit) return { route: hit.route, reason: `${hit.source}:${hit.pattern}` }
    return { route: defaultRoute, reason: 'default' }
  }

  /** 各层规则条数,供启动日志与 /status 接口展示。 */
  counts(): { local: number; remote: number; seed: number } {
    return { local: this.local.size, remote: this.remote.size, seed: this.seed.size }
  }
}
