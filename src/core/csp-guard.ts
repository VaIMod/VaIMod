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

const CSP_HTTP_EQUIV = /^content-security-policy(-report-only)?$/i;
// 字符串写入的廉价预滤：先小写化找 'http-equiv'，命中才剥离（剥离正则随后再跑）
const CSP_TAG_STRIP = /<meta\b[^>]*>/gi;

/** 判定：一个节点是不是「CSP meta」（nodeType=1 + META + http-equiv=CSP） */
function isCspMeta(node: unknown): boolean {
  try {
    if (!node || (node as { nodeType?: unknown }).nodeType !== 1) return false;
    const el = node as Element;
    if (el.tagName !== 'META') return false;
    return CSP_HTTP_EQUIV.test(el.getAttribute('http-equiv') || '');
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
    Element.prototype.setAttribute = function (name: string, value: string) {
      try {
        if (
          this.tagName === 'META' &&
          /^http-equiv$/i.test(String(name)) &&
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
  } catch {
    /* ignore */
  }

  // ② httpEquiv 属性 setter
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype, 'httpEquiv');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(HTMLMetaElement.prototype, 'httpEquiv', {
        set(this: HTMLMetaElement, v: string) {
          if (CSP_HTTP_EQUIV.test(String(v))) {
            blockedCount++;
            return;
          }
          desc.set!.call(this, v);
        },
        get: desc.get,
        configurable: true,
        enumerable: desc.enumerable,
      });
    }
  } catch {
    /* ignore */
  }

  // ③ 直插节点钩子：appendChild / insertBefore（热路径：两次属性读判定）
  try {
    const origAppend = Node.prototype.appendChild;
    Node.prototype.appendChild = function <T extends Node>(child: T): T {
      if (isCspMeta(child)) {
        blockedCount++;
        return child;
      }
      return origAppend.call(this, child) as T;
    };
    const origInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function <T extends Node>(
      node: T,
      child: Node | null,
    ): T {
      if (isCspMeta(node)) {
        blockedCount++;
        return node;
      }
      return origInsertBefore.call(this, node, child) as T;
    };
  } catch {
    /* ignore */
  }

  // ④ append / prepend（多参版本）
  for (const method of ['append', 'prepend'] as const) {
    try {
      const orig = (Element.prototype as unknown as Record<string, (...n: Node[]) => void>)[
        method
      ];
      (Element.prototype as unknown as Record<string, (...n: Node[]) => void>)[method] =
        function (...nodes: Node[]) {
          for (let i = nodes.length - 1; i >= 0; i--) {
            if (isCspMeta(nodes[i])) {
              blockedCount++;
              nodes.splice(i, 1);
            }
          }
          return orig.apply(this, nodes);
        };
    } catch {
      /* ignore */
    }
  }

  // ⑤ insertAdjacentElement
  try {
    const origAdj = Element.prototype.insertAdjacentElement;
    Element.prototype.insertAdjacentElement = function (
      this: Element,
      where: InsertPosition,
      element: Element,
    ): Element | null {
      if (isCspMeta(element)) {
        blockedCount++;
        return element;
      }
      return origAdj.call(this, where, element);
    };
  } catch {
    /* ignore */
  }

  // ⑥ 字符串写入：innerHTML / outerHTML / insertAdjacentHTML（廉价预滤 + 剥离）
  for (const prop of ['innerHTML', 'outerHTML'] as const) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      if (!desc || !desc.set || !desc.get) continue;
      Object.defineProperty(Element.prototype, prop, {
        set(this: Element, v: string) {
          let html = String(v);
          if (html.length >= 24 && html.toLowerCase().includes('http-equiv')) {
            const stripped = stripCspMetas(html);
            if (stripped !== html) blockedCount++;
            html = stripped;
          }
          desc.set!.call(this, html);
        },
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
    Element.prototype.insertAdjacentHTML = function (
      where: InsertPosition,
      text: string,
    ): void {
      let html = String(text);
      if (html.length >= 24 && html.toLowerCase().includes('http-equiv')) {
        const stripped = stripCspMetas(html);
        if (stripped !== html) blockedCount++;
        html = stripped;
      }
      origAdjHtml.call(this, where, html);
    };
  } catch {
    /* ignore */
  }

  // ⑦ 观察器兜底（异步、覆盖嵌套容器）：摘除绕过同步链的 CSP meta
  try {
    const sweepAdded = (node: Node): void => {
      if (isCspMeta(node)) {
        if (node.parentNode) node.parentNode.removeChild(node);
        sweptCount++;
        return;
      }
      if (node.nodeType === 1) {
        // 嵌套清扫：容器子树里藏的 CSP meta 也摘（观察器异步路径，可承受查询）
        sweptCount += sweepExisting(node as ParentNode);
      }
    };
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        const added = m.addedNodes;
        for (let i = 0; i < added.length; i++) sweepAdded(added[i]);
      }
    });
    const start = (): void => {
      const root = document.documentElement || document;
      observer.observe(root, { childList: true, subtree: true });
    };
    if (document.documentElement) {
      // ⑧ 安装时清扫（后装守卫清先到的注入）
      sweptCount += sweepExisting(document);
      start();
    } else {
      // document-start 极早期：文档结构未就绪，观察器等 DOM 有了再挂
      //（不轮询：用一次 readystatechange，页面脚本也还没跑到）
      document.addEventListener('readystatechange', () => {
        sweptCount += sweepExisting(document);
        start();
      }, { once: true });
    }
  } catch {
    /* ignore */
  }
}
