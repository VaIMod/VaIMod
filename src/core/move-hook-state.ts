// appendChild / insertBefore 合并包装的跨模块握手状态（v38 性能治理）。
// csp-guard 与 ui-guard 原本各自在 Node.prototype.appendChild / insertBefore
// 上包一层（每次 DOM 调用两层 JS 闭包，混淆产物下 ~0.27ms/层的实测税）。
// 现在 csp-guard 的单层包装内联 ui 的搬运检查（uiMoveBlocked），ui-guard
// 据此跳过自己的二次包装。仅用模块级布尔做握手——不能像旧 sig-guard 一样
// 把标记属性钉到被包装的函数上（getOwnPropertyNames 一扫即露）。
export const moveHookState: { cspMerged: boolean } = { cspMerged: false };
