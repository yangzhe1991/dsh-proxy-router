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
        ├── matches a proxy rule → upstream proxy (the address from the configuration page)
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

> **It starts switched off.** The master switch (below) defaults to `false`: the plugin binds no port
> and never touches the host proxy policy, so your networking behaves exactly as before it was installed.
> To use the router, open Settings → 分流代理 and flip the switch.

> For local development, install with `link:`: set `"@yangzhe1991/dsh-proxy-router": "link:/path/to/repo"` in `~/.dsh/profiles/web`, run `pnpm install`, restart.

## Configuration page (the recommended way)

After the restart, open **Settings** in the sidebar → **分流代理 (Proxy Router)** — it is ordered after every shipped section. The plugin registers itself into the settings page's `settings.section` slot, so the entry is one click away instead of hiding behind the Plugins page's package list:

| Field | Meaning |
| --- | --- |
| **Enable routing proxy** (switch) | **Off by default**: off = the plugin does nothing at all — no local listener, no host-policy takeover, no list refreshing; everything follows your existing environment (no `export`ed proxy means all direct). On = route by the rules |
| Upstream proxy | e.g. `http://192.168.3.47:12801`; empty falls back to `https_proxy` / `http_proxy` from the launch environment |
| Route when nothing matches | `direct` (recommended) or `proxy` |
| List refresh period | hours; `0` keeps whatever cache exists |
| Local router bind address | where the small local proxy the plugin starts is bound (**you normally never touch this**): the host points all outbound traffic at it, and it decides direct vs. upstream per rule. **Loopback only** (e.g. `127.0.0.1:17890`); if the port is taken it falls back to a random one; port `0` = let the OS choose |
| Connect timeout | milliseconds; applies to connection setup only, never to streaming responses |
| Fall back to direct when the upstream fails | retry directly when the proxied connection cannot be established |
| Log every routing decision | verbose per-request lines on the host's stderr |

The section reads top-down: the **master switch** → the live **status panel** (bind address, upstream and where it came from, whether the host policy was taken over and whether bash subprocesses are routed, rule counts, hit statistics, the local rules file path, and each remote list's size and refresh time) → the **settings form** → the **local-rules editor**.

Worth knowing:

- **The switch takes effect on the flip** (one atomic write through the `settings` namespace, bypassing drafts): switching off closes the listener, uninstalls the host policy and restores the process's proxy variables to their previous values; switching on loads the rules, binds the listener and takes the policy over again. No dsh restart either way.
- **The text fields in the form save when you press Save.** They are `volatile`, so the host writes new values straight into the running instance and emits `loader/volatile-update` — upstream, default route, timeout, fallback and debug are read per request, and changing the bind address re-binds the listener and repoints the host policy at it. While the switch is off, saving only persists the values; they take effect when you switch it on.
- Settings are written to the **profile's user layer** (the row's `config:` in `~/.dsh/profiles/<profile>/cordis.patch.yml`), over the composition layer and the schema defaults. Each field has a "reset" action that removes the user-layer entry, falling back to the composition default.
- A field counts as overridden purely by its presence in the user layer; concurrent writes are fenced by revision instead of silently overwriting each other.
- **Loopback-only bind addresses are a deliberate safety limit**: the plugin's local proxy is unauthenticated, so binding `0.0.0.0` or a LAN address would publish an open forward proxy to your network. The form rejects it, and the host side has a second guard (a non-loopback value is rewritten to `127.0.0.1` with a warning).
- `lists` (remote blocklist URLs) and `stateDir` / `rulesFile` are **not** `volatile`, so they never appear in the settings form — they are deployment facts, and blocklist URLs live in the profile's composition config. The **contents of the local rules file, however, are editable right in the settings page** (below).
- With the switch off there is no local listener, so the `curl 127.0.0.1:17890/__proxy-router/status` debugging endpoint is gone too (the settings panel still works — it reads the host's same-origin read-only route).

### Local routing rules (edited right in the settings page)

The "本地分流规则" block at the bottom of the section edits `~/.dsh/proxy-router/rules.txt`:

```txt
# one rule per line; '#' starts a comment; first match wins, top-down
proxy: some-blocked-site.com     # this domain and all subdomains → via the upstream
direct: cdn.example.cn           # this domain and all subdomains → always direct
example.com                      # a bare domain is the same as proxy:
1.2.3.4                          # IP literals work too
```

- Also accepted: `*.example.com`, `.example.com`, `+.example.com`, `DOMAIN-SUFFIX,example.com`, `DOMAIN,example.com`, `DOMAIN-KEYWORD,ads`, plus dnsmasq's `server=/example.com/114.114.114.114`; IDN domains are punycoded before matching.
- **Local rules win over everything**: if a remote blocklist over-matches a domestic site, one `direct:` line corrects it.
- "保存规则" writes the file and **reloads it immediately** (no dsh restart, and no need to press the form's Save above); the previous content is copied to `rules.txt.bak` first, and the replacement is a temp-file + rename so nothing ever reads a half-written file.
- Parsing is deliberately lenient: **lines it cannot understand are skipped and listed with line numbers** in the editor (a silently ignored typo is worse than refusing to save).
- Two write gates, for the record: routes registered by the host skip session auth, so writes accept `PUT` only and must be same-origin (`Origin`/`Referer` matching `Host`), with a 256 KB body cap.
- With the master switch off, saving only writes the file; it takes effect once you switch the plugin on.

> **⚠️ Once the upstream is configured here, stop exporting `http_proxy` / `https_proxy` / `all_proxy` in your launch command.**
> The host freezes those values into a snapshot at boot and hands it to bash subprocesses, which take priority —
> so `curl`/`git`/`npm` would bypass the router and talk to your exported upstream directly. The plugin detects this,
> warns loudly in the log, and marks bash subprocesses as "direct to upstream (bypassing the router)" in the status panel.

## Composition config (deployment defaults)

Saving the section writes the **profile's user layer**; the profile's composition config (the row's `config:` in `cordis.patch.yml`) is the **deployment default** and resolves above the schema defaults. Put machine-wide defaults there:

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

Every editable field may also be written here as a default; `lists` accepts plain URL strings or `{ name, url, route }` objects (the plugin flattens them to a URL list).

## The local rules file (the CLI / headless equivalent)

The file lives at `~/.dsh/proxy-router/rules.txt`; a commented template is created on first run.
**Editing the file takes effect immediately too** (the plugin watches it) — no dsh restart. The settings
page's editor writes exactly this file, so the two paths share one rule set and never fight:

- **Settings page**: handy for adding one line and seeing the diagnostics right there (unparsable lines are listed with line numbers).
- **Editor / scripts**: `vi ~/.dsh/proxy-router/rules.txt` — better for bulk pastes and keeping the file in your dotfiles.

Syntax, precedence and save behaviour are documented under
[Local routing rules](#local-routing-rules-edited-right-in-the-settings-page) above.

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

The settings section reads the same status snapshot through the host web server's same-origin read-only route `GET /dsh-proxy-router/status`; its rules editor goes through `GET/PUT /dsh-proxy-router/rules` (PUT must be same-origin, body capped at 256 KB, and the previous file is backed up to `rules.txt.bak` and replaced atomically).

You can also verify routing with curl directly:

```sh
curl -x http://127.0.0.1:17890 -sI https://www.google.com   # via upstream
curl -x http://127.0.0.1:17890 -sI https://www.baidu.com    # direct
```

The startup log prints the upstream and its source, the bind address, rule counts, the policy self-check result, the configuration-page entry point, and whether bash subprocesses are routed too.

## Robustness

- **No self-recursion**: a request whose target is this proxy's own listen address is never forwarded (plain HTTP gets 421, `/favicon.ico` gets 204, `/` gets a human-readable hint). Without that guard, something as harmless as opening `http://127.0.0.1:17890/...` in a browser snowballs into a self-loop — 0.1.0 produced over a hundred million requests that way, so 0.1.1 rejects them outright.
- **An upstream pointing at itself is ignored**: when the upstream equals this plugin's own listen address it is treated as "no upstream", with an explicit warning in the log and in the status panel, instead of CONNECTing back into itself.
- **Rate-limited warnings**: one line per distinct failure every 5 seconds, with a suppressed-count summary, so no failure mode can flood your terminal.

## Compatibility

- Verified against **dsh 0.1.7-rc.2** since **0.3.0**, and against **dsh 0.2.0-rc.1** since **0.3.1**.
- **Why 0.3.1 exists** — dsh 0.2.0-rc.1 checks every declared `@deepseek-ai/dsh-*` peer range against the *runtime version* and skips any plugin whose ranges do not match (`^0.1.7-rc.2` excludes `0.2.0-rc.1`). No plugin code changed: **0.3.1** only widens those ranges to `^0.1.7-rc.2 || ^0.2.0-rc.1`. On 0.2.0-rc.1 an already-installed **0.3.0** can also be admitted without upgrading, by granting the exact-version exemption (`dsh plugin --profile <profile> allow-version @yangzhe1991/dsh-proxy-router@0.3.0 --dsh-version 0.2.0-rc.1 --accept-risk`).
- **dsh < 0.1.7 is not supported**: 0.1.7 replaced plugin configuration (`settings.yaml` + `ctx.settings.installSection` + the client's `settingsScope` / `settings.plugin.item`) with a row-level `Config` schema and volatile live updates; this plugin implements the new contract.
- The host half depends only on the public exports of `@deepseek-ai/dsh-http-proxy`, `@deepseek-ai/schemastery` and `undici`, plus cordis' `ctx.get` / `ctx.effect` / `ctx.inject`; the browser half requires only platform module-table entries (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`) and declares no non-baseline module request.
- The configuration UI uses the official settings system (a `Config` schema + the settings page's `settings.section` slot + the shared `ctx.configForms` form). The section does not appear at all unless the host is running this row (`configForms.whileServed` gates it), and the plugin exits quietly on a deployment without a settings provider — everything else keeps working.

## Known limits

- **HTTP proxies only** (`http://` / `https://`). `all_proxy=socks5://…` is ignored with a warning; if your proxy also exposes a mixed port (mihomo/clash `mixed-port`), point the upstream at `http://host:port`.
- **No TLS interception**: https is routed by the CONNECT hostname only, so URL-path rules are impossible by design.
- Rules support domain suffixes, exact domains, keywords and IP literals — no regular expressions.
- The local router binds **loopback only** and is never exposed to the LAN (a non-loopback `listen` value is rejected, with a second guard on the host side).
- The rules editor edits the **local rules file**; remote blocklist URLs (`lists`) still live in the profile composition config, and the rule syntax itself has no regular expressions.

## License

MIT
