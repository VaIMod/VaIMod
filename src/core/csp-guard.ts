// ===== CSP meta 注入全链路拦截（csp-guard，butterAny.vm.0.1.7「CSP Remover」链移植）=====
//
// 威胁模型：恶意作品 / 宿主页面脚本向 document 注入
//   <meta http-equiv="Content-Security-Policy" content="script-src 'none' ...">
// CSP meta 一旦进 DOM 且先于脚本生效窗口被解析，会直接封死 eval / 注入脚本 /
// userscript 的数据通道——这是「封杀一切修改器」的最廉价手段。
//
// 拦截链（对齐原版七路 + 兜底观察器）：
//   ① Element.prototype.setAttribute（META + http-equiv + CSP 值 → 静默丢弃）
//   ② HTMLMetaElement.prototype.httpEquiv 属性 setter（同上）
//   ③ Node.prototype.appendChild / insertBefore（直插 CSP META → 拒绝挂载）
//   ④ Element.prototype.append / prepend（同上）
//   ⑤ Element.prototype.insertAdjacentElement（同上）
//   ⑥ innerHTML / outerHTML / insertAdjacentHTML 字符串写入（剥离 CSP meta 标签）
//   ⑦ MutationObserver（subtree childList）兜底清扫：绕过同步链的（含嵌套容器）
//     一律从 DOM 摘除
//   ⑧ 安装时全量清扫一次已存在的 CSP meta（后装的守卫也要清掉先到的注入）
//
// 对原版的三项硬化：
//   · 热路径零额外开销：appendChild/insertBefore/append/prepend 只做
//     nodeType + tagName 两次属性读，命中 META 才读 http-equiv；
//     原版在每次 appendChild 上对整个子树跑 querySelectorAll('meta')（热路径
//     大子树挂载时是实打实的布局外扫描）——嵌套清扫全部移交 ⑦ 观察器（异步、
//     语义等价：观察器本来就覆盖同一批节点）。
//   · 字符串写入先做廉价预滤（长度 + 小写子串命中才跑正则），绝大多数写入
//     一次 indexOf 便放行；正则只在预滤命中时执行。
//   · 零特征：不挂 window.__CCW_CSP_REMOVER__ 之类的全局标记（原版把
//     版本号/安装时间直接暴露在 window 上，本身就是可被作品检测的特征）。
//
// 零宿主副作用约束：所有钩子对「非 CSP META」内容严格透传（返回值/异常语义
// 与原方法一致）；页面正常的 charset / viewport / httpEquiv meta 不受影响。

import { markNative } from '../dom-utils';
import { onDomMutations } from './dom-watch';
import { moveHookState } from './move-hook-state';
import { uiMoveBlocked } from './ui-guard';
import { isProtectedHost } from '../dom-utils';

const CSP_HTTP_EQUIV = /^content-security-policy(-report-only)?$/i;
// 逐节点判定路径上的字符串：模块级常量，混淆后只在初始化解码一次
const TAG_META = 'META';
const ATTR_HTTP_EQUIV = 'http-equiv';
// 字符串写入的廉价预滤：正则流式判定（不构造小写副本——大字符串 toLowerCase
// 是一次全量分配，编辑器挂载期 innerHTML 写入频繁，能省则省）
const CSP_HTTP_EQUIV_RE = /http-equiv/i;
const CSP_TAG_STRIP = /<meta\b[^>]*>/gi;

/** 判定：一个节点是不是「CSP meta」（nodeType=1 + META + http-equiv=CSP） */
function isCspMeta(node: unknown): boolean {
  try {
    if (!node || (node as { nodeType?: unknown }).nodeType !== 1) return false;
    const el = node as Element;
    if (el.tagName !== TAG_META) return false;
    return CSP_HTTP_EQUIV.test(el.getAttribute(ATTR_HTTP_EQUIV) || '');
  } catch {
    return false;
  }
}

/** 从 HTML 字符串里剥离全部 CSP meta 标签（调用方已预滤命中） */
function stripCspMetas(html: string): string {
  return html.replace(CSP_TAG_STRIP, (tag) =>
    /http-equiv\s*=\s*["']?\s*content-security-policy/i.test(tag) ? '' : tag,
  );
}

/** 从既有 DOM 里摘除全部 CSP meta（root 内含嵌套） */
function sweepExisting(root: ParentNode): number {
  let removed = 0;
  try {
    const metas = root.querySelectorAll('meta');
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      if (isCspMeta(m) && m.parentNode) {
        m.parentNode.removeChild(m);
        removed++;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

export interface CspGuardReport {
  installed: boolean;
  blocked: number; // 同步链拒绝挂载 / 属性写入次数
  swept: number; // 观察器兜底摘除次数（含安装时清扫）
}

let blockedCount = 0;
let sweptCount = 0;
let installed = false;

export function cspGuardReport(): CspGuardReport {
  return { installed, blocked: blockedCount, swept: sweptCount };
}

/**
 * 幂等安装。document-start 调用（@run-at document-start 下 main.ts 模块级
 * boot 即触发）；documentElement 未就绪时零轮询等待——观察器与钩子都挂在
 * 原型上，与 document 状态无关，只有 ⑧ 清扫需要 DOM 存在，补扫即可。
 */
export function installCspGuard(): void {
  if (installed) return;
  installed = true;

  // ① setAttribute：META 上写 CSP http-equiv → 静默丢弃（返回 undefined 与原版一致）
  try {
    const origSetAttr = Element.prototype.setAttribute;
    const wrappedSetAttr = function (this: Element, name: string, value: string) {
      try {
        if (
          this.tagName === 'META' &&
          typeof name === 'string' &&
          name.length === 10 &&
          name.toLowerCase() === 'http-equiv' &&
          CSP_HTTP_EQUIV.test(String(value))
        ) {
          blockedCount++;
          return undefined;
        }
      } catch {
        /* 判定异常按放行处理 */
      }
      return origSetAttr.call(this, name, value);
    };
    markNative(wrappedSetAttr, 'setAttribute');
    Element.prototype.setAttribute = wrappedSetAttr as typeof Element.prototype.setAttribute;
  } catch {
    /* ignore */
  }

  // ② httpEquiv 属性 setter
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype, 'httpEquiv');
    if (desc && desc.set && desc.get) {
      const hookedSet = function (this: HTMLMetaElement, v: string) {
        if (CSP_HTTP_EQUIV.test(String(v))) {
          blockedCount++;
          return;
        }
        desc.set!.call(this, v);
      };
      markNative(hookedSet, 'set');
      Object.defineProperty(HTMLMetaElement.prototype, 'httpEquiv', {
        set: hookedSet,
        get: desc.get,
        configurable: true,
        enumerable: desc.enumerable,
      });
    }
  } catch {
    /* ignore */
  }

  // ③ 直插节点钩子：appendChild / insertBefore
  // 单层合并包装（v38 性能治理）：原来 csp 与 ui-guard 各包一层，每次 DOM 调用
  // 两层闭包（混淆产物实测 ~0.27ms/层，编辑器 mount 数千节点直接翻倍）。
  // 现在这一层同时内联 ui 的宿主搬运检查（uiMoveBlocked），ui-guard 依
  // moveHookState.cspMerged 跳过自己的二次包装——语义等价（两判定都是 O(1)
  // 属性读），调用层数减半。约定 installCspGuard 必须先于 installUiGuard
  // （main.ts 启动序列保证）；csp 未装成功时 cspMerged 保持 false，ui 回退自包。
  try {
    const origAppend = Node.prototype.appendChild;
    // 热路径内联：编辑器挂载期 appendChild 调用量极大（每个节点一次）。
    // 原实现每次要走 isCspMeta → uiMoveBlocked → isProtectedHost → isProtectedFast
    // 四层嵌套调用，混淆后每次调用都不便宜。这里把判定摊平：
    // 两次属性读 + 一次集合查即可放行，异常分支才调深层函数。
    const wrappedAppend = function <T extends Node>(this: Node, child: T): T {
      if (child.nodeType === 1) {
        const el = child as unknown as Element;
        if (el.tagName === TAG_META) {
          if (isCspMeta(child)) {
            blockedCount++;
            return child;
          }
        } else if (isProtectedHost(child) && uiMoveBlocked(child, this)) {
          return child;
        }
      }
      return origAppend.call(this, child) as T;
    };
    markNative(wrappedAppend, 'appendChild');
    Node.prototype.appendChild = wrappedAppend as typeof Node.prototype.appendChild;
    const origInsertBefore = Node.prototype.insertBefore;
    const wrappedInsertBefore = function <T extends Node>(
      this: Node,
      node: T,
      child: Node | null,
    ): T {
      if (node.nodeType === 1) {
        const el = node as unknown as Element;
        if (el.tagName === TAG_META) {
          if (isCspMeta(node)) {
            blockedCount++;
            return node;
          }
        } else if (isProtectedHost(node) && uiMoveBlocked(node, this)) {
          return node;
        }
      }
      return origInsertBefore.call(this, node, child) as T;
    };
    markNative(wrappedInsertBefore, 'insertBefore');
    Node.prototype.insertBefore = wrappedInsertBefore as typeof Node.prototype.insertBefore;
    moveHookState.cspMerged = true;
  } catch {
    /* ignore */
  }

  // ④ append / prepend（多参版本）
  for (const method of ['append', 'prepend'] as const) {
    try {
      const orig = (Element.prototype as unknown as Record<string, (...n: Node[]) => void>)[
        method
      ];
      const wrapped = function (this: Element, ...nodes: Node[]) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (isCspMeta(nodes[i])) {
            blockedCount++;
            nodes.splice(i, 1);
          }
        }
        return orig.apply(this, nodes);
      };
      markNative(wrapped, method);
      (Element.prototype as unknown as Record<string, (...n: Node[]) => void>)[method] = wrapped;
    } catch {
      /* ignore */
    }
  }

  // ⑤ insertAdjacentElement
  try {
    const origAdj = Element.prototype.insertAdjacentElement;
    const wrappedAdj = function (this: Element, where: InsertPosition, element: Element) {
      if (isCspMeta(element)) {
        blockedCount++;
        return element;
      }
      return origAdj.call(this, where, element);
    };
    markNative(wrappedAdj, 'insertAdjacentElement');
    Element.prototype.insertAdjacentElement = wrappedAdj as typeof Element.prototype.insertAdjacentElement;
  } catch {
    /* ignore */
  }

  // ⑥ 字符串写入：innerHTML / outerHTML / insertAdjacentHTML（廉价预滤 + 剥离）
  for (const prop of ['innerHTML', 'outerHTML'] as const) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      if (!desc || !desc.set || !desc.get) continue;
      const hookedSet = function (this: Element, v: string) {
        const html = typeof v === 'string' ? v : String(v);
        if (html.length >= 24 && CSP_HTTP_EQUIV_RE.test(html)) {
          const stripped = stripCspMetas(html);
          if (stripped !== html) blockedCount++;
          desc.set!.call(this, stripped);
          return;
        }
        desc.set!.call(this, html);
      };
      markNative(hookedSet, 'set');
      Object.defineProperty(Element.prototype, prop, {
        set: hookedSet,
        get: desc.get,
        configurable: true,
        enumerable: desc.enumerable,
      });
    } catch {
      /* ignore */
    }
  }
  try {
    const origAdjHtml = Element.prototype.insertAdjacentHTML;
    const wrappedAdjHtml = function (this: Element, where: InsertPosition, text: string): void {
      const html = typeof text === 'string' ? text : String(text);
      if (html.length >= 24 && CSP_HTTP_EQUIV_RE.test(html)) {
        const stripped = stripCspMetas(html);
        if (stripped !== html) blockedCount++;
        origAdjHtml.call(this, where, stripped);
        return;
      }
      origAdjHtml.call(this, where, html);
    };
    markNative(wrappedAdjHtml, 'insertAdjacentHTML');
    Element.prototype.insertAdjacentHTML = wrappedAdjHtml as typeof Element.prototype.insertAdjacentHTML;
  } catch {
    /* ignore */
  }

  // ⑦ 观察器兜底（异步、覆盖嵌套容器）：摘除绕过同步链的 CSP meta
  // 性能关键（v34 教训）：旧实现对**每个**新增元素节点都跑一次子树
  // querySelectorAll —— 编辑器/项目挂载期 React 一次 mount 数千节点，
  // 大容器子树逐个全扫是 O(n²)，直接把项目加载拖到卡死。
  // 现在拆两层：
  //   · 直插节点：isCspMeta 两次属性读，命中即摘（即时，语义不变）；
  //   · 嵌套清扫：100ms 去抖，合并成一趟 document 级查询。观察器本来就
  //     subtree 全覆盖，任何漏网的嵌套 meta 必然出现在 document 树里，
  //     一趟全扫与逐节点扫描的最终语义完全等价，最坏多存活 100ms。
  try {
    // 真去抖 + 1s 上限（v38 性能治理）：旧实现是「首触发后 100ms 必跑」的节流，
    // 挂载 churn 期间（React 数千节点分批 mount）每 100ms 白跑一趟 document 级
    // querySelectorAll。现在 churn 期间顺延、最多压 1000ms 必跑一次——
    // 直插摘除仍是即时路径，嵌套 meta 最坏多存活 1.1s，安全语义不丢。
    let sweepTimer: ReturnType<typeof setTimeout> | null = null;
    let firstPending = 0;
    const scheduleSweep = (): void => {
      const now = performance.now();
      if (sweepTimer !== null) {
        if (now - firstPending < 1000) clearTimeout(sweepTimer);
        else return; // 已到 1s 上限，让在手定时器照常触发
      } else {
        firstPending = now;
      }
      sweepTimer = setTimeout(() => {
        sweepTimer = null;
        try {
          sweptCount += sweepExisting(document);
        } catch {
          /* ignore */
        }
      }, 100);
    };
    // 返回 true 表示「本次有元素新增，需要排一次文档级清扫」
    const sweepAdded = (node: Node): boolean => {
      if (isCspMeta(node)) {
        if (node.parentNode) node.parentNode.removeChild(node);
        sweptCount++;
        return false;
      }
      return node.nodeType === 1;
    };
    // 共享观察器：与其它守卫共用一套 MutationRecord（原本各挂一个，
    // 编辑器一次挂载数千节点时浏览器要生成四套记录）
    onDomMutations((muts) => {
      // 清扫调度批级化：编辑器一次挂载数千节点，逐节点排定时器会放大成
      // 数千次 setTimeout 判定（混淆后每次判定都不便宜）。一批只排一次。
      let needSweep = false;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        const added = m.addedNodes;
        for (let i = 0; i < added.length; i++) {
          if (sweepAdded(added[i])) needSweep = true;
        }
      }
      if (needSweep) scheduleSweep();
    });
    // 安装时清扫（后装守卫清先到的注入）
    sweptCount += sweepExisting(document);
  } catch {
    /* ignore */
  }
}
