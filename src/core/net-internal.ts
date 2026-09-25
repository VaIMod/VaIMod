// ===== 内部请求标记（本体 ↔ 网络类插件之间唯一的约定）=====
//
// 为什么需要它：VaIMod 本体也会发网络请求（云数据直写等）。如果用户装了一个
// 网络类插件（如 `docs/plugin-net-firewall.js`）并打开了拦截模式，那个插件在
// `XMLHttpRequest.prototype.send` 上看到的请求里就**混着本体的后台请求**——
// 分不出来就会自伤：用户拉黑某个域名后，本体的云数据保存也跟着失败。
//
// 标记方式用 WeakSet：不落任何可枚举属性，页面既探测不到也无法伪造
// （`Object.getOwnPropertyNames(xhr)` / `JSON.stringify` 都看不见）。
//
// ⛔ 网络防火墙**不在本体内**：它是可分发的插件（`docs/plugin-net-firewall.js`），
//    不导入就完全没有这个功能。本体这里只提供「我是谁」的标记能力，
//    通过 `ctx.net.isInternalXhr` 与 `ctx.net.markNative` 交给插件使用。
//
// ⛔ 这里绝不安装任何网络钩子、也不持久化任何东西 —— 只是两个纯函数 + 一个 WeakSet。

const internalXhr = new WeakSet<object>();

/** 标记「该 XHR 是 VaIMod 本体发的」→ 网络类插件据此直接透传（不记录、不拦截） */
export function markInternalXhr(xhr: XMLHttpRequest): void {
  try {
    internalXhr.add(xhr);
  } catch {
    /* ignore */
  }
}

/** 该 XHR 是否为本体发出（插件侧通过 ctx.net.isInternalXhr 调用） */
export function isInternalXhr(xhr: unknown): boolean {
  try {
    return internalXhr.has(xhr as object);
  } catch {
    return false;
  }
}
