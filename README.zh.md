# dsh-proxy-router

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-proxy-router)](https://www.npmjs.com/package/@yangzhe1991/dsh-proxy-router)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-proxy-router)](https://www.npmjs.com/package/@yangzhe1991/dsh-proxy-router)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-proxy-router)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)分流代理插件:只有**规则命中的被墙域名**走上游代理,其余(国内站点、内网地址、未知域名)一律直连,**配置项直接在 Web 的设置页(设置 → 分流代理)里改、热生效**。

起因很实际:启动 dsh 时 `export https_proxy=... http_proxy=... all_proxy=...` 之后,连 `api.deepseek.com`、`www.baidu.com` 都绕一圈代理。这个插件把「什么时候该走代理」变成一张可维护的规则表,把「上游是谁」变成一个能随时改的设置项。

---

## 覆盖范围

装上之后,下面这些出网全部先经过插件的本地分流代理,再按规则决定去向:

| 出网来源 | 说明 |
| --- | --- |
| 主进程 `fetch()` | LLM API(`api.deepseek.com`)、web_search、MCP、插件自己的 HTTP 请求 |
| `web_fetch` 工具 | 宿主 `proxyRouteFor()` 与主进程同一口径 |
| bash 子进程 | `curl`、`git`、`npm`/`pnpm` 等,经 `http_proxy` + `NODE_USE_ENV_PROXY` 继承同一路由 |

## 工作原理

```
DSH 主进程 fetch / web_fetch / bash 子进程
        │  插件把宿主代理策略里的 http(s) 代理指向本地分流代理
        ▼
本地分流代理(插件内置,只监听 127.0.0.1:17890)
        ├── 命中 proxy 规则 → 上游代理(配置页里配的那个地址)
        └── 其余(默认)     → 直连
```

规则三层优先级,先命中者生效:

1. **本地规则文件**(`~/.dsh/proxy-router/rules.txt`)—— 你按实际经验增删,改完即时生效
2. **远程被墙清单**(默认 `Loyalsoldier/clash-rules` 的 `gfw.txt` + `greatfire.txt`,经 jsDelivr,带缓存与 24h 刷新)
3. **内置种子清单** —— 离线首启时的兜底(约 140 个高频被墙域名)
4. 都不命中 → `defaultRoute`(默认 **直连**)

另外:**回环地址与内网地址永远直连**(`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、IPv6 ULA/链路本地、以及 `nas` 这类单标签主机名),不会被丢给上游代理。

## 安装

```sh
dsh plugin --profile web add @yangzhe1991/dsh-proxy-router
```

然后重启 `dsh web`。

> **装完默认是关的。** 总开关(见下)默认 `false`:插件一个端口都不占、也不碰宿主代理策略,
> 你的出网行为和没装之前完全一样。要用分流,去 设置 → 分流代理 把开关打开。

> 本地开发用 `link:` 装:在 `~/.dsh/profiles/web` 下把依赖改成 `"@yangzhe1991/dsh-proxy-router": "link:/path/to/repo"`,然后 `pnpm install` 并重启。

## 配置页(推荐用法)

重启后打开侧边栏 **设置** → **分流代理**(排在所有官方设置项之后;
插件把自己注册进设置页的 `settings.section` 槽位,入口就在这一层,不用进 Plugins 页翻包):

| 字段 | 说明 |
| --- | --- |
| **启用分流代理**(开关) | **默认关**:关 = 插件完全不动作 —— 不监听本地端口、不接管宿主代理策略、不刷清单,一切按你原有环境走(没 `export` 代理就是全直连)。开 = 按规则分流 |
| 上游代理 | 例如 `http://192.168.3.47:12801`;留空则沿用启动环境里的 `https_proxy` / `http_proxy` |
| 未命中任何规则时 | `直连`(推荐)或 `走上游代理` |
| 清单刷新周期 | 小时;`0` 表示只用手上已有的缓存 |
| 本地代理监听地址 | 插件在本地起的那个小代理绑在哪(**一般不用改**):宿主把所有出网都指给它,由它按规则决定直连还是走上游。**只允许回环地址**(如 `127.0.0.1:17890`);端口被占用时会自动改用随机端口;端口填 `0` = 让系统分配 |
| 连接超时 | 毫秒;只作用于建立连接阶段,不影响流式响应 |
| 上游失败时回退直连 | 走上游的连接失败时自动改用直连 |
| 打印每次请求的分流日志 | 排查时打开,日志进宿主 stderr |

分区自上而下是:**总开关** → **运行状态**(监听地址、上游及其来源、宿主策略是否已接管与 bash 子进程走没走分流、规则条数、命中统计、每条远程清单的条数与更新时间;本地规则文件路径在启动日志里)→ **配置表单** → **本地分流规则编辑器**。

几个要点:

- **开关拨一下就生效**(走 `settings` 命名空间的一次原子写,不过草稿):关掉时会立刻关监听、卸载宿主策略并把进程里的代理变量还原成原值;打开时重新装载规则、监听、接管策略。来回拨不用重启 dsh。
- **配置表单里的文本字段改完点保存才生效**:这些字段在插件 schema 里标了 `volatile`,宿主把新值直接写进运行中的实例并发 `loader/volatile-update` —— 上游、默认走向、超时、回退、调试是现读的;改监听地址会立即重新绑定并把宿主策略指过去。开关关着时保存只落盘,打开开关后按新值运行。
- 保存写回的是 **profile 的用户层**(`~/.dsh/profiles/<profile>/cordis.patch.yml` 里那一行),它盖在组合配置(部署默认值)与 schema 默认值之上;每个字段旁边的「恢复默认」= 把该字段从用户层删掉。
- 字段是否「已覆盖」只看它在不在用户层,与值本身无关;写入带 revision 栅栏,并发改动会被拒绝而不是静默覆盖。
- **监听地址只允许回环**是刻意的安全限制:本插件内置的本地代理不鉴权,绑到 `0.0.0.0` 或内网地址等于在局域网里开一个开放正向代理。表单侧会判非法拦住保存,宿主侧还有一道兜底(非回环直接改回 `127.0.0.1` 并告警)。
- `lists`(远程清单)与 `stateDir` / `rulesFile` 没标 volatile:**不出现在配置表单里**(它们是部署事实,不是随手改的偏好);清单 URL 只能写在 profile 组合配置里。**本地规则的内容可以直接在设置页里编辑**(见下)。
- 关着开关时**没有本地监听端口**,所以 `curl 127.0.0.1:17890/__proxy-router/status` 那条调试接口也不在(设置页面板走的是宿主的同源只读路由,仍然可用)。

### 本地分流规则(设置页里直接改)

分区最下面那块「本地分流规则」编辑的就是 `~/.dsh/proxy-router/rules.txt`:

```txt
# 每行一条,# 开头是注释;自上而下匹配,先命中者生效
proxy: some-blocked-site.com     # 该域名及其所有子域 → 走上游代理
direct: cdn.example.cn           # 该域名及其所有子域 → 强制直连
example.com                      # 裸域名等价于 proxy:
1.2.3.4                          # IP 字面量也可以
```

- 支持 `*.example.com`、`.example.com`、`+.example.com`、`DOMAIN-SUFFIX,example.com`、`DOMAIN,example.com`、`DOMAIN-KEYWORD,ads`,顺手也认 dnsmasq 的 `server=/example.com/114.114.114.114`;中文域名自动转 punycode。
- **本地规则优先级最高**:远程清单误伤了某个国内站点,加一条 `direct:` 就纠正了。
- 点「保存规则」即写盘并**立刻重载**(不用重启 dsh,也不用点上面那个「保存」);写之前会把原文件备份成 `rules.txt.bak`,替换走「临时文件 + rename」,不会读到写了一半的文件。
- 解析刻意宽容:**没看懂的行会被跳过,并在编辑器里按行号列出来**(打错一个域名却毫无提示,比拦住保存更糟)。
- 顺带说清两处**写入闸门**:宿主注册的路由不过会话认证,所以写操作只接受 `PUT` 且要求同源(`Origin`/`Referer` 与 `Host` 一致),请求体上限 256KB。
- 关着总开关时保存只写文件,打开开关后生效。

> **⚠️ 配好上游之后,启动命令里就不要再 `export http_proxy/https_proxy/all_proxy` 了。**
> 宿主在启动阶段就把那三个变量的值定格成「bash 子进程要用」的一份快照,子进程会优先用它,
> 于是 `curl`/`git`/`npm` 会绕过插件直接连你 export 的上游。插件检测到这种情况会在日志里明确告警,
> 并在状态面板里把 bash 子进程标成「直连上游(绕过分流)」。

## 组合配置(部署默认值)

配置页保存的值写进 **profile 用户层**;profile 组合配置(cordis.patch.yml 里那一行)是**部署默认值**,它盖在 schema 默认值之上。适合写在这里的是「这台机器上就长这样」的默认值,例如:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: proxy-router
  config:
    upstream: http://192.168.3.47:12801
    debug: false
```

还有两个只在部署层有意义的路径字段(不进配置页):

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `stateDir` | `~/.dsh/proxy-router` | 缓存与默认规则文件所在目录 |
| `rulesFile` | `<stateDir>/rules.txt` | 本地规则文件路径 |

配置页里的每个字段都可以写在组合配置里作为默认值;`lists` 既可以是 URL 字符串数组,也可以是 `{ name, url, route }` 对象(插件会把它压平成 URL 列表)。

## 本地规则文件(命令行 / 无 Web 时的等价路径)

规则文件默认在 `~/.dsh/proxy-router/rules.txt`,首次运行会自动生成带注释的模板。
**直接改文件同样立即生效**(插件监视这个文件),不用重启 dsh —— 设置页那块编辑器改的就是它,
两条路径共用同一份规则,不会打架:

- 用**设置页**:适合随手加一条、当场看诊断(无法识别的行会按行号列出来)。
- 用**编辑器/脚本**:`vi ~/.dsh/proxy-router/rules.txt`,适合批量粘贴、纳入 dotfiles 管理。

语法、优先级与保存行为见上面的 [本地分流规则](#本地分流规则设置页里直接改)。

## 调试

本地分流代理自带一个只监听本机的调试接口:

```sh
# 总览:监听地址、上游、规则条数、命中统计、策略自检结果
curl -s http://127.0.0.1:17890/__proxy-router/status

# 问某个域名会怎么走
curl -s "http://127.0.0.1:17890/__proxy-router/why?host=www.google.com"
# → {"host":"www.google.com","route":"proxy","reason":"list:gfw:google.com"}

# 手动重载规则(本地 + 远程)
curl -s http://127.0.0.1:17890/__proxy-router/reload
```

配置页那个分区读的是同一个状态快照,走宿主 Web 服务器的同源只读路由 `GET /dsh-proxy-router/status`;
设置页的规则编辑器走 `GET/PUT /dsh-proxy-router/rules`(PUT 要求同源,请求体上限 256KB,
写前备份 `rules.txt.bak` 并原子替换)。

直接用 curl 验证分流效果:

```sh
curl -x http://127.0.0.1:17890 -sI https://www.google.com   # 走上游
curl -x http://127.0.0.1:17890 -sI https://www.baidu.com    # 直连
```

启动日志会打印上游来源、监听地址、规则条数、策略自检结果、配置页入口,以及「bash 子进程是否也走分流」。

## 健壮性

- **不会自我递归**:目标指向本代理监听地址的请求一律拒绝转发(明文 421、`/favicon.ico` 204、根路径给人话提示)。
  否则「在浏览器里打开 `http://127.0.0.1:17890/...` 看状态」这类无害操作会引爆自我循环
  —— 0.1.0 曾因此刷出上亿次请求,故 0.1.1 起强制拦截。
- **上游填成自己会被忽略**:上游等于本插件监听地址时按「未配置上游」处理,并在日志与状态面板里明确告警,避免 CONNECT 回自己。
- **告警限流**:同一类失败每 5 秒最多一行,并汇总被抑制的条数,任何异常放大都不会刷屏终端。

## 兼容性

- 自 **0.3.0** 起在 **dsh 0.1.7-rc.2** 上验证通过。
- **dsh < 0.1.7 不再支持**:0.1.7 把插件配置从 `settings.yaml` + `ctx.settings.installSection` + 客户端的 `settingsScope`/`settings.plugin.item` 换成了「插件行 `Config` schema + volatile 热更新」,本插件已按新契约实现。
- 宿主半只依赖 `@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/schemastery`、`undici` 的公开导出与 cordis 的 `ctx.get` / `ctx.effect` / `ctx.inject`;
  浏览器半只 require `react`,不依赖任何 UI 包。
- 配置界面用的是官方设置体系(`Config` schema + 设置页 `settings.section` 槽位 + `ctx.configForms` 共享表单);
  宿主没在跑这一行时分区根本不出现(`configForms.whileServed` 门控),设置提供方缺失时安静退出,其余功能不受影响。

## 已知边界

- **上游只支持 HTTP 代理**(`http://` / `https://`)。`all_proxy=socks5://…` 会被忽略并告警;如果你的代理同时提供混合端口(mihomo/clash 的 `mixed-port`),把 `http://host:port` 配给上游即可。
- **不做 TLS 中间人**:https 只按 CONNECT 里的域名分流,不解析内容 —— 所以也无法按 URL 路径分流。
- 规则只支持域名后缀、精确域名、关键字与 IP 字面量,不支持正则表达式。
- 本地分流代理**只监听回环地址**,不对局域网暴露(`listen` 填非回环会被拒;宿主侧还有一道兜底)。
- 规则编辑区只编辑**本地规则文件**;远程清单 URL(`lists`)仍只在 profile 组合配置里改;规则语法本身不支持正则表达式。

## License

MIT
