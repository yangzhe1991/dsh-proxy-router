/**
 * 回环地址判定(宿主半与浏览器半共用的一处口径)。
 *
 * 为什么单独一个文件:同一个判断要在三个地方用 ——
 *   - 宿主半解析 `listen` 配置(非回环必须拒绝,见下);
 *   - 宿主半判断「上游是不是指着我自己的监听地址」(自环拦截);
 *   - 浏览器半在保存前先拦一道(别把用户放进「填了个 0.0.0.0 然后被静默改回 127.0.0.1」的坑)。
 *
 * 引用注意:三处 import 都写 `.ts` 后缀 —— 测试会直接 `import` 这些源码
 * (Node 的 TS 直跑不做 `.js`→`.ts` 映射,写 `.js` 会 ERR_MODULE_NOT_FOUND)。
 *
 * 安全口径:本插件内置的是**无认证的本地正向代理**,连调试接口
 * (`/__proxy-router/status|why|reload`)一起暴露。绑到非回环地址就等于在局域网里开一个
 * 开放代理,所以 `listen` 只接受回环地址 —— 这是刻意的限制,不是没实现。
 */

/** 是否是回环地址(`localhost` / `127.0.0.0/8` / `::1`,方括号形态也认)。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  if (value === '') return false
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  // IPv6 回环:带方括号、带 zone(`[::1%lo0]`)都算
  const v6 = value.replace(/^\[|\]$/g, '').split('%')[0]
  if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1') return true
  // IPv4 回环整段 127.0.0.0/8;显式排除 0.0.0.0(它表示「所有网卡」,不是回环)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (v4 !== null) {
    const octets = v4.slice(1, 5).map(Number)
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    return octets[0] === 127
  }
  return false
}

/**
 * 把 `host:port` 里的 host 部分取出来(去掉方括号),端口非法时返回 null。
 * @param raw - 形如 `127.0.0.1:17890` / `[::1]:17890` / `localhost:0`。
 * @returns 解析结果,或 null(格式不对)。
 */
export function splitHostPort(raw: string): { host: string; port: number } | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // 方括号 IPv6:`[::1]:17890`
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(trimmed)
  if (bracketed !== null) {
    const port = Number(bracketed[2])
    if (!Number.isInteger(port) || port < 0 || port > 65535) return null
    return { host: bracketed[1]!, port }
  }
  const at = trimmed.lastIndexOf(':')
  if (at <= 0) return null
  const host = trimmed.slice(0, at).trim()
  const portText = trimmed.slice(at + 1).trim()
  if (host === '' || !/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null
  return { host, port }
}
