# dsh-proxy-router

[English](README.md) | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@yangzhe1991/dsh-proxy-router)](https://www.npmjs.com/package/@yangzhe1991/dsh-proxy-router)
[![npm downloads](https://img.shields.io/npm/dm/@yangzhe1991/dsh-proxy-router)](https://www.npmjs.com/package/@yangzhe1991/dsh-proxy-router)
[![license](https://img.shields.io/github/license/yangzhe1991/dsh-proxy-router)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-1e90ff)](https://github.com/topics/dsh-plugin)

A routing-proxy plugin for DSH (DeepSeek Harness): **only rule-matched blocked domains go through the upstream proxy** — everything else (domestic sites, LAN addresses, unknown hosts) connects directly. **Its settings live in the Web settings page.**

The motivation is mundane: once you start dsh with `export https_proxy=... http_proxy=... all_proxy=...`, even `api.deepseek.com` and `www.baidu.com` take a detour through the proxy. This plugin turns "when should this go through the proxy" into a maintainable rule table, and "who is the upstream" into a setting you can change any time.

---

## What it covers

Everything outbound first hits the plugin's local routing proxy, which then decides where it goes:

| Outbound source | Notes |
| --- | --- |
| Main-process `fetch()` | LLM API (`api.deepseek.com`), web_search, MCP, plugin HTTP calls |
| `web_fetch` tool | shares one policy with the main process via the host's `proxyRouteFor()` |
| bash subprocesses | `curl`, `git`, `npm`/`pnpm` — inherit the same route through `http_proxy` + `NODE_USE_ENV_PROXY` |

## How it works

```
DSH main process fetch / web_fetch / bash subprocesses
        │  the plugin repoints the host's http(s) proxy at the local router
        ▼
Local routing proxy (built in, bound to 127.0.0.1:17890)
        ├── matches a proxy rule → upstream proxy (the address from the settings page)
        └── everything else (default) → direct connection
```

Three rule layers, first match wins:

1. **Local rules file** (`~/.dsh/proxy-router/rules.txt`) — your own additions/removals, hot-reloaded
2. **Remote blocklists** (default: `Loyalsoldier/clash-rules` `gfw.txt` + `greatfire.txt` via jsDelivr, cached, refreshed every 24h)
3. **Built-in seed list** — ~140 high-frequency blocked domains, for a first offline start
4. No match at all → `defaultRoute` (default: **direct**)

Loopback and LAN addresses always go direct (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, IPv6 ULA/link-local, plus single-label hostnames such as `nas`) — they are never handed to the upstream proxy.

## Install

```sh
dsh plugin --profile web add @yangzhe1991/dsh-proxy-router
```

Then restart `dsh web`.

> For local development, install with `link:`: set `"@yangzhe1991/dsh-proxy-router": "link:/path/to/repo"` in `~/.dsh/profiles/web`, run `pnpm install`, restart.

## Settings page (the recommended way)

After the restart, open **Settings → Plugins → Plugin configuration** and expand the "代理分流 (proxy-router)" card:

| Field | Meaning |
| --- | --- |
| Upstream proxy | e.g. `http://192.168.3.47:12801`; empty falls back to `https_proxy` / `http_proxy` from the launch environment |
| Route when nothing matches | `direct` (recommended) or `proxy` |
| Remote blocklists | one URL per line; clear the box to load none |
| List refresh period | hours; `0` keeps whatever cache exists |
| Local router bind address | e.g. `127.0.0.1:17890` |
| Connect timeout | milliseconds; applies to connection setup only, never to streaming responses |
| Fall back to direct when the upstream fails | retry directly when the proxied connection cannot be established |
| Log every routing decision | verbose per-request lines on the host's stderr |

Below the fields sits a live **status panel**: bind address, upstream and where it came from, whether the host policy was taken over (and whether bash subprocesses are routed), rule counts, hit statistics, the local rules file path, and each remote list's size and refresh time.

Worth knowing:

- **Saving takes effect immediately** — no dsh restart. Upstream, default route, timeout, fallback and debug are read per request; changing the bind address re-binds the listener and repoints the host policy at it.
- Settings are written to the `proxy-router:` section of `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`). Each field has a "reset" action that removes the user-layer entry, falling back to the composition default.
- A field counts as overridden purely by its presence in the user layer; concurrent writes are fenced by revision instead of silently overwriting each other.

> **⚠️ Once the upstream is configured here, stop exporting `http_proxy` / `https_proxy` / `all_proxy` in your launch command.**
> The host freezes those values into a snapshot at boot and hands it to bash subprocesses, which take priority —
> so `curl`/`git`/`npm` would bypass the router and talk to your exported upstream directly. The plugin detects this,
> warns loudly in the log, and marks bash subprocesses as "direct to upstream (bypassing the router)" in the status panel.

## Composition config (deployment defaults)

The settings page writes the **user layer**, which resolves above the profile's composition config (the deployment default). Put machine-wide defaults there:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: proxy-router
  config:
    upstream: http://192.168.3.47:12801
    debug: false
```

Two path-shaped fields stay composition-only (they are deployment facts, not preferences):

| Field | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `~/.dsh/proxy-router` | cache and default rules file location |
| `rulesFile` | `<stateDir>/rules.txt` | local rules file path |

Every settings field may also be written here as a default; in composition config `lists` accepts plain URL strings or `{ name, url, route }` objects (the settings page flattens them to a URL list).

## Local rules

The file lives at `~/.dsh/proxy-router/rules.txt`; a commented template is created on first run. **Edits take effect immediately** — no dsh restart. The settings page shows the path and the current rule count, but editing happens in your editor.

```txt
# one rule per line, '#' starts a comment; first match wins
proxy: some-blocked-site.com     # this domain and all subdomains → upstream proxy
direct: cdn.example.cn           # this domain and all subdomains → force direct
example.com                      # a bare domain means proxy:
```

- **Local rules win over remote lists**: if a remote list wrongly proxies a domestic site, one `direct:` line fixes it.
- Accepted spellings: `*.example.com`, `.example.com`, `+.example.com`, `DOMAIN-SUFFIX,example.com`, `DOMAIN,example.com` (exact), `DOMAIN-KEYWORD,ads` — and dnsmasq's `server=/example.com/114.114.114.114` for good measure.
- Non-ASCII domains are converted to punycode before matching.

## Debugging

The local router ships a loopback-only debug endpoint:

```sh
# overview: bind address, upstream, rule counts, hit stats, policy self-check
curl -s http://127.0.0.1:17890/__proxy-router/status

# ask how a host would be routed
curl -s "http://127.0.0.1:17890/__proxy-router/why?host=www.google.com"
# → {"host":"www.google.com","route":"proxy","reason":"list:gfw:google.com"}

# reload rules (local + remote)
curl -s http://127.0.0.1:17890/__proxy-router/reload
```

The settings card reads the same status snapshot through the host web server's same-origin read-only route `GET /dsh-proxy-router/status`.

You can also verify routing with curl directly:

```sh
curl -x http://127.0.0.1:17890 -sI https://www.google.com   # via upstream
curl -x http://127.0.0.1:17890 -sI https://www.baidu.com    # direct
```

The startup log prints the upstream and its source, the bind address, rule counts, the policy self-check result, the settings-page entry point, and whether bash subprocesses are routed too.

## Compatibility

- Verified against **dsh 0.1.5-rc.2** since **0.1.0**.
- The host half depends only on the public exports of `@deepseek-ai/dsh-http-proxy`, `@deepseek-ai/schemastery` and `undici`, plus cordis' `ctx.get` / `ctx.effect` / `ctx.inject`; the browser half requires only `react` and no UI package.
- The settings card uses the official settings system (`ctx.settings.installSection` + the `settings.plugin.item` slot). On a deployment without a settings provider the plugin falls back to its composition config and everything else keeps working.

## Known limits

- **HTTP proxies only** (`http://` / `https://`). `all_proxy=socks5://…` is ignored with a warning; if your proxy also exposes a mixed port (mihomo/clash `mixed-port`), point the upstream at `http://host:port`.
- **No TLS interception**: https is routed by the CONNECT hostname only, so URL-path rules are impossible by design.
- Rules support domain suffixes, exact domains, keywords and IP literals — no regular expressions.
- The local router binds `127.0.0.1` only; it is not exposed to the LAN, and the local rules file is not editable from the settings page (its path is shown there).

## License

MIT
