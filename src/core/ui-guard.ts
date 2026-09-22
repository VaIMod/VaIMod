// ===== UI 防篡改 + 恒定最顶层（document-start 安装） =====
// 威胁模型：作品内部代码 / 页面脚本 / 其它扩展只要拿到 light DOM，就能对 VaIMod 的
// **宿主元素**动手（面板与悬浮球本体在 closed Shadow DOM 里拿不到，唯一入口就是宿主）：
//   ① 移除 / 搬走宿主（remove / removeChild / replaceChild / appendChild / innerHTML 洗地）
//   ② 用内联样式把它藏起来（display / visibility / opacity）
//   ③ 用更高层级或更靠后的 DOM 顺序把它盖住（z-index 平级时后者胜）
// 对应三条硬约束：不可移除、不可隐藏、恒定最顶层。
//
// 与 secure-guard 的分工：那边负责「删掉敌扩展注入的隐藏 <style>」+ 回滚
// display:none!important；这边负责**结构层**（拿不走）与**层级层**（盖不住），
// 外加 visibility/opacity 这两条它没覆盖的隐藏路径。

import {
  getStealthRoots,
  getProtectedHosts,
  isProtectedHost,
  isProtected,
  trueElementsFromPoint,
} from '../dom-utils';

/** 视口最大层级（宿主恒在此层） */
const TOP_Z = 2147483647;
/** 争用判定阈值：页面元素 computed z-index 达到它，说明对方也在顶格抢层级 */
const CONTEST_Z = 2147483640;

let installed = false;
let tamperCount = 0;
let levelFixCount = 0;
let patrolTimer: number | null = null;
let visBound = false;

export interface UiGuardReport {
  installed: boolean;
  tamper: number;
  levelFix: number;
  hosts: number;
  topZ: number;
}

export function uiGuardReport(): UiGuardReport {
  return {
    installed,
    tamper: tamperCount,
    levelFix: levelFixCount,
    hosts: allHosts().length,
    topZ: TOP_Z,
  };
}

function allHosts(): HTMLElement[] {
  const out = getProtectedHosts();
  if (out.length > 0) return out;
  // 兜底：宿主登记表为空时按 shadow 根反查（closed 模式下唯一可行的另一条路）
  try {
    for (const r of getStealthRoots()) {
      const h = r?.host as HTMLElement | undefined;
      if (h) out.push(h);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function reportTamper(): void {
  tamperCount++;
}

/** 宿主当前挂载点：body 优先，回退 documentElement */
function mountPoint(): Node | null {
  try {
    return document.body ?? document.documentElement ?? null;
  } catch {
    return null;
  }
}

/**
 * 把宿主放回文档并抬到层级顶格。
 * `last=true` 时移动到父节点末尾——z-index 平级时 DOM 顺序决定胜负，
 * 只在检测到「有人也在顶格抢层级」时才用，平时保持随机插入位置（不破坏 stealth）。
 */
function healHost(host: HTMLElement, last: boolean): void {
  if (!host) return;
  if (!host.isConnected) {
    const parent = mountPoint();
    if (parent) {
      try {
        parent.appendChild(host);
        reportTamper();
      } catch {
        /* ignore */
      }
    }
  } else if (last) {
    const parent = host.parentNode;
    if (parent && parent.lastChild !== host) {
      try {
        parent.appendChild(host);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    if (host.style.zIndex !== String(TOP_Z)) {
      host.style.zIndex = String(TOP_Z);
      levelFixCount++;
    }
  } catch {
    /* ignore */
  }
}

/** 内联隐藏回滚（display / visibility / opacity；VaIMod 从不写这三个 inline） */
function revertInlineHide(host: HTMLElement): void {
  const s = host.style;
  if (!s) return;
  try {
    if (s.getPropertyValue('display') === 'none') s.removeProperty('display');
    if (s.getPropertyValue('visibility') === 'hidden') s.removeProperty('visibility');
    const op = s.getPropertyValue('opacity');
    if (op && Number(op) === 0) s.removeProperty('opacity');
  } catch {
    /* ignore */
  }
}

/**
 * 采样点：悬浮球中心 +（面板可见时）面板中心。
 * 取「真实命中栈」顶部元素（未被 stealth 过滤），其 computed z-index 达到 CONTEST_Z
 * 即认为存在层级争用 → 需要把宿主挪到 DOM 末尾抢顺序。
 */
function detectContest(): boolean {
  try {
    const pts: Array<[number, number]> = [];
    for (const r of getStealthRoots()) {
      if (!r) continue;
      const pick = (sel: string): void => {
        try {
          const el = r.querySelector(sel) as HTMLElement | null;
          if (!el) return;
          if (el.classList.contains('svp-fab-hidden') || el.classList.contains('svp-panel-hidden')) return;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return;
          pts.push([rect.left + rect.width / 2, rect.top + rect.height / 2]);
        } catch {
          /* ignore */
        }
      };
      pick('.svp-fab');
      pick('.svp-panel');
    }
    for (const [x, y] of pts) {
      const stack = trueElementsFromPoint(x, y);
      for (const el of stack) {
        if (isProtected(el)) return false; // 命中栈里已有 VaIMod 且在最前 → 我们已在最上
        const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
        if (Number.isFinite(z) && z >= CONTEST_Z) return true;
      }
      // 只裁决第一个有效采样点：点位之间相互独立，避免反复摆动
      return false;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 幂等：回滚隐藏、保证在文档里、抬到顶格。可高频调用 */
export function assertUiTop(): void {
  const hosts = allHosts();
  if (hosts.length === 0) return;
  const contest = detectContest();
  for (const host of hosts) {
    if (!host) continue;
    revertInlineHide(host);
    healHost(host, contest);
  }
}

function schedulePatrol(): void {
  try {
    if (document.visibilityState === 'hidden') return;
  } catch {
    /* ignore */
  }
  assertUiTop();
}

// ---------- DOM 结构层守卫 ----------
type AnyFn = (...args: unknown[]) => unknown;

function wrapNative<T extends AnyFn>(orig: T, impl: (orig: T) => T): T {
  const wrapped = impl(orig) as unknown as { name?: string };
  try {
    Object.defineProperty(wrapped, 'name', { configurable: true, value: (orig as { name?: string }).name || '' });
  } catch {
    /* ignore */
  }
  return wrapped as unknown as T;
}

function installStructureGuard(): void {
  const NP = Node.prototype as unknown as Record<string, AnyFn>;
  const EP = Element.prototype as unknown as Record<string, AnyFn>;

  // ① 不允许把宿主从文档里摘掉
  if (typeof NP.removeChild === 'function') {
    NP.removeChild = wrapNative(NP.removeChild, (orig) =>
      function (this: Node, child: Node) {
        if (isProtectedHost(child)) {
          reportTamper();
          healHost(child as HTMLElement, false);
          return child;
        }
        return orig.call(this, child);
      } as unknown as AnyFn,
    );
  }
  if (typeof NP.replaceChild === 'function') {
    NP.replaceChild = wrapNative(NP.replaceChild, (orig) =>
      function (this: Node, newNode: Node, oldNode: Node) {
        if (isProtectedHost(oldNode)) {
          reportTamper();
          healHost(oldNode as HTMLElement, false);
          return oldNode;
        }
        if (isProtectedHost(newNode)) {
          // 拿宿主当替换物：把待替换节点删掉就好，宿主位置不动
          reportTamper();
          try {
            orig.call(this, newNode, oldNode);
          } catch {
            /* ignore */
          }
          return newNode;
        }
        return orig.call(this, newNode, oldNode);
      } as unknown as AnyFn,
    );
  }

  // ② 不允许把已挂载的宿主搬到别处（首次插入 parent 为空，放行）
  const guardMove = (name: 'appendChild' | 'insertBefore'): void => {
    if (typeof NP[name] !== 'function') return;
    NP[name] = wrapNative(NP[name], (orig) =>
      function (this: Node, node: Node, ...rest: unknown[]) {
        if (isProtectedHost(node)) {
          const parent = node.parentNode;
          if (parent && parent.isConnected && parent !== this) {
            reportTamper();
            return node;
          }
        }
        return (orig as unknown as (...a: unknown[]) => unknown).call(this, node, ...rest);
      } as unknown as AnyFn,
    );
  };
  guardMove('appendChild');
  guardMove('insertBefore');

  // ③ remove() / replaceWith() / before() / after()：宿主一律不许被摘/被替
  if (typeof EP.remove === 'function') {
    EP.remove = wrapNative(EP.remove, (orig) =>
      function (this: Element) {
        if (isProtectedHost(this)) {
          reportTamper();
          healHost(this as HTMLElement, false);
          return;
        }
        return orig.call(this);
      } as unknown as AnyFn,
    );
  }
  for (const name of ['replaceWith', 'before', 'after'] as const) {
    if (typeof EP[name] !== 'function') continue;
    EP[name] = wrapNative(EP[name], (orig) =>
      function (this: Element, ...args: unknown[]) {
        const kept = args.filter((a) => !isProtectedHost(a as Node));
        if (kept.length !== args.length) reportTamper();
        if (isProtectedHost(this)) {
          reportTamper();
          healHost(this as HTMLElement, false);
          if (kept.length === 0) return;
        }
        return (orig as unknown as (...a: unknown[]) => unknown).call(this, ...kept);
      } as unknown as AnyFn,
    );
  }

  // ④ replaceChildren / innerHTML 洗地：跑完立刻把宿主接回文档
  const reattachAfter = (fn: AnyFn, thisArg: unknown, args: unknown[]): unknown => {
    const res = (fn as unknown as (...a: unknown[]) => unknown).apply(thisArg, args);
    for (const host of allHosts()) {
      if (host && !host.isConnected) healHost(host, false);
    }
    return res;
  };
  if (typeof EP.replaceChildren === 'function') {
    EP.replaceChildren = wrapNative(EP.replaceChildren, (orig) =>
      function (this: Element, ...nodes: unknown[]) {
        return reattachAfter(orig as unknown as AnyFn, this, nodes);
      } as unknown as AnyFn,
    );
  }

  const innerHtmlDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const setter = innerHtmlDesc?.set;
  if (typeof setter === 'function') {
    try {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: innerHtmlDesc?.enumerable ?? false,
        get: innerHtmlDesc?.get,
        set(this: Element, value: string) {
          const html = String(value ?? '');
          // 宿主自己不许被 innerHTML 覆盖（那会连 closed shadow 一起丢掉）
          if (isProtectedHost(this)) {
            reportTamper();
            return;
          }
          const res = setter.call(this, html);
          for (const host of allHosts()) {
            if (host && !host.isConnected) healHost(host, false);
          }
          return res;
        },
      });
    } catch {
      /* ignore */
    }
  }

  const outerHtmlDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
  const outerSetter = outerHtmlDesc?.set;
  if (typeof outerSetter === 'function') {
    try {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: true,
        enumerable: outerHtmlDesc?.enumerable ?? false,
        get: outerHtmlDesc?.get,
        set(this: Element, value: string) {
          if (isProtectedHost(this)) {
            reportTamper();
            return;
          }
          return outerSetter.call(this, String(value ?? ''));
        },
      });
    } catch {
      /* ignore */
    }
  }

  // ⑤ 属性层：宿主上的 style / class / hidden 只允许「不隐藏」的写入
  const SP = Element.prototype as unknown as Record<string, AnyFn>;
  if (typeof SP.setAttribute === 'function') {
    SP.setAttribute = wrapNative(SP.setAttribute, (orig) =>
      function (this: Element, name: string, value: string) {
        if ((name === 'style' || name === 'class' || name === 'hidden') && isProtectedHost(this)) {
          // style：写入后立刻回滚隐藏声明（保留其它声明，站点可能给宿主加合法样式）
          if (name === 'style') {
            const res = orig.call(this, name, value);
            revertInlineHide(this as HTMLElement);
            return res;
          }
          if (name === 'hidden') {
            reportTamper();
            return;
          }
        }
        return orig.call(this, name, value);
      } as unknown as AnyFn,
    );
  }
  if (typeof SP.toggleAttribute === 'function') {
    SP.toggleAttribute = wrapNative(SP.toggleAttribute, (orig) =>
      function (this: Element, name: string, force?: boolean) {
        if (name === 'hidden' && isProtectedHost(this)) {
          reportTamper();
          return false;
        }
        return (orig as unknown as (...a: unknown[]) => unknown).call(this, name, force);
      } as unknown as AnyFn,
    );
  }
}

/** 宿主上的 style 属性观察器：即时回滚隐藏，不等巡检 */
const styleWatched = new WeakSet<Element>();
function watchHostStyle(host: HTMLElement): void {
  if (styleWatched.has(host)) return;
  styleWatched.add(host);
  try {
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(() => {
      revertInlineHide(host);
      healHost(host, false);
    });
    mo.observe(host, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
  } catch {
    /* ignore */
  }
}

export function installUiGuard(): void {
  if (installed) return;
  installed = true;
  try {
    installStructureGuard();
  } catch {
    /* ignore */
  }

  // 宿主可能晚于本函数创建（createStealthHost 在 boot 里）→ 巡检时补挂观察器
  const tick = (): void => {
    for (const host of allHosts()) watchHostStyle(host);
    schedulePatrol();
  };

  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', tick, { passive: true });
      window.addEventListener('orientationchange', tick, { passive: true });
      window.addEventListener('scroll', tick, { passive: true, capture: true });
    }
    if (!visBound) {
      visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick();
      });
    }
  } catch {
    /* ignore */
  }

  if (patrolTimer === null) patrolTimer = window.setInterval(tick, 1000);
  // 首次 ASAP（宿主可能尚未插入 → 自己会重试）
  tick();
  setTimeout(tick, 250);
  setTimeout(tick, 1200);
}

export function uninstallUiGuard(): void {
  if (!installed) return;
  installed = false;
  if (patrolTimer !== null) {
    window.clearInterval(patrolTimer);
    patrolTimer = null;
  }
}
