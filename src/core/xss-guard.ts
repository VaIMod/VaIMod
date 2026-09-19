// ===== XSS 速执行拦截（保守版） =====
// 只拦截「低风险、高攻击性、页面框架不使用」的执行入口：
// 整页重写（document.write）与字符串形式定时器。
// **不封禁 eval / Function**：webpack 构建的站点（React/vendor）重度依赖
// Function 构造器与动态执行做运行时初始化，封禁会导致页面整体崩溃
// （实测 vendor~main 报 `undefined.call` → React componentDidCatch 连锁崩）。
// XSS 速执行防护由「透明遮罩层级掩护 + stealth 隐藏 + 上述入口拦截」共同承担。

export function installXssGuard(): void {
  // ① 整页重写型 XSS：document.write / writeln 置空（页面框架不使用，安全）
  try {
    const doc = document as unknown as { write: () => void; writeln: () => void };
    doc.write = () => {};
    doc.writeln = () => {};
  } catch {
    /* ignore */
  }

  // ② 字符串形式定时器：setTimeout/setInterval('code') 忽略，函数形式保留（页面兼容）
  try {
    const win = window as unknown as Record<string, unknown>;
    const origST = window.setTimeout.bind(window);
    const origSI = window.setInterval.bind(window);
    win.setTimeout = ((fn: unknown, ...args: unknown[]) => {
      if (typeof fn === 'string') return 0;
      return origST(fn as TimerHandler, ...(args as []));
    }) as unknown;
    win.setInterval = ((fn: unknown, ...args: unknown[]) => {
      if (typeof fn === 'string') return 0;
      return origSI(fn as TimerHandler, ...(args as []));
    }) as unknown;
  } catch {
    /* ignore */
  }
}
