// ===== CSense 拦截器反制（csense-guard） =====
//
// 目标：ccw 社区扩展「CSense 拦截器」v0.1.5a3（Chen-Jin @ CCW）。
// 这是作品作者安装的「阻止 CSense 使用者运行你的作品」检测扩展（注册 csb3.2_*
// 自定义积木，作品运行时执行检测），载荷字符串表（base64+zlib 已解出）证实三板斧：
//   ① 检测 + 上报：DOM 扫描（html>div[style*="rgb"] * / body>div:empty[style*="inset"] /
//      shadow-root / iframe contentWindow）、vm.loadProject 原生性（Reflect+toString）、
//      ccwAPI.Extension / extensionManager / getInfo、localStorage __csense-plugins /
//      ext_csb3.2* / csbv / csb3u、cookie、navigator.userAgent
//      → fetch(keepalive) POST supabase csense_detections（带 publishable apikey）
//   ② 跳转：location.href / open → `https://d.chen-jin.dpdns.org/csdetected?...`
//   ③ 遮罩阻断：createElement + appendChild + innerHTML 注入 div.csense-window 盖住页面
// userscript 用户（含 VaIMod）被其通用启发式误伤的概率极高。
//
// 反制三板斧（与检测面一一对应，被动、窄口径、绝不破坏站点功能）：
//   1) 拦截检测：fetch / XHR / sendBeacon 命中 CSense 专属端点 → 本地合成假成功，
//      请求不出网；检测面本身由既有能力压成全负（closed shadow、toString 白名单、
//      品牌键无交集、不注册 extension）——探测不到就不上报，上报了也出不去。
//   2) 拦截跳转：三层咽喉 ——
//        a. Navigation API `navigate` 事件（首选，能拦 location.href= / assign /
//           replace / window.open 同页 / 链接 / 表单等一切文档级导航）
//        b. Location.prototype.assign / replace 包装（location 属性本身
//           [Unforgeable] 不可定义，但其方法在原型上、可安全包装）
//        c. window.open 包装，命中返回假 window 桩（不返回 null，避免它按
//           「弹窗被拦」走重试分支）
//   3) 允许作品继续运行：MutationObserver 即时纠正（childList 挂 documentElement
//      与 body）—— div.csense-window 一插入 DOM 立即移除，遮罩永远盖不住页面；
//      跳转被拦 + 遮罩被清 + 上报不出网 → 作品正常可玩。
//
// 黑名单口径刻意收窄到 CSense 专属端点/域名——其余任何导航与请求（包括
// m.ccw.site 的扩展热更新 JS）一律透传，保证站点与其它扩展功能零影响。
//
// 已知边界：无 Navigation API 的环境（老 Firefox）下 location.href= 直赋值不可拦
// （[Unforgeable] setter 无钩点），由 b/c 两层兜住其载荷实际使用的方法。

import { markNative } from '../dom-utils';

const REPORT_RE = /https?:\/\/dcynsppfvlkdtbaleefw\.supabase\.co\/rest\/v1\/csense_detections/i;
const REDIRECT_RE = /https?:\/\/d\.chen-jin\.dpdns\.org\/csdetected/i;

/** CSense 专属 localStorage / cookie 指纹（只记录，不作为拦截依据） */
const LS_KEYS = ['__csense-plugins', 'csbv', 'csb3u'];
const LS_PREFIX_RE = /^ext_csb/;
const COOKIE_RE = /(?:^|;\s*)(?:csbv|csb3u|__csense[^=]*)=/;

export interface CsenseStatus {
  /** 是否检测到 CSense 迹象（仅诊断展示，不代表已被上报） */
  present: boolean;
  /** 命中的信号列表（`ls:<键名>` / `dom:csense-window` / `cookie`） */
  signals: string[];
  /** 吞掉的 CSense 动作计数（检测上报 / 跳转 / 遮罩） */
  hits: { fetch: number; xhr: number; beacon: number; nav: number; overlay: number };
  /** 最近一次吞掉的时间戳（Date.now()），无则 null */
  lastHit: number | null;
}

let installed = false;
let origFetch: typeof fetch | null = null;
let origXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let origXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let origBeacon: ((url: string | URL, data?: BodyInit | null) => boolean) | null = null;
let origAssign: ((url: string) => void) | null = null;
let origReplace: ((url: string) => void) | null = null;
let origOpen: typeof window.open | null = null;
let navListenerInstalled = false;
let overlayMo: MutationObserver | null = null;
let scanTimer = 0;

const xhrMarked = new WeakSet<object>();
const hits: CsenseStatus['hits'] = { fetch: 0, xhr: 0, beacon: 0, nav: 0, overlay: 0 };
let lastHit: number | null = null;
let signals: string[] = [];
let present = false;

function noteHit(channel: keyof CsenseStatus['hits']): void {
  hits[channel]++;
  lastHit = Date.now();
}

/** URL 是否为 CSense 专属端点（其余一律透传） */
function isCsenseUrl(raw: string): boolean {
  try {
    return REPORT_RE.test(raw) || REDIRECT_RE.test(raw);
  } catch {
    return false;
  }
}

function fakeOkResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ───── 特征扫描（只读） ─────

function scan(): void {
  const sig: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (LS_KEYS.includes(k) || LS_PREFIX_RE.test(k)) sig.push(`ls:${k}`);
    }
  } catch {
    /* localStorage 不可用（隐私模式等） */
  }
  try {
    if (document.querySelector('.csense-window')) sig.push('dom:csense-window');
  } catch {
    /* ignore */
  }
  try {
    if (COOKIE_RE.test(document.cookie)) sig.push('cookie');
  } catch {
    /* ignore */
  }
  signals = sig;
  present = sig.length > 0;
}

/** 可见性门控的低频扫描（对齐 dom-utils heal 节奏；hidden 时跳过，回前台补扫） */
function tick(): void {
  if (document.visibilityState === 'hidden') return;
  scan();
}

// ───── 安装 ─────

export function installCsenseGuard(): void {
  if (installed) return;
  installed = true;

  // ① fetch 咽喉：命中 CSense 上报端点 → 本地合成假 200，不出网
  origFetch = window.fetch;
  const nativeFetch = origFetch;
  if (typeof nativeFetch === 'function') {
    const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else url = (input as Request).url;
      } catch {
        return nativeFetch.call(this as never, input, init);
      }
      if (!isCsenseUrl(url)) return nativeFetch.call(this as never, input, init);
      noteHit('fetch');
      try {
        return Promise.resolve(fakeOkResponse());
      } catch {
        // Response 构造不可用时退化为空 200 文本响应
        return Promise.resolve(new Response('', { status: 200 }));
      }
    };
    try {
      Object.defineProperty(patched, 'name', { configurable: true, value: 'fetch' });
      Object.defineProperty(patched, 'length', { configurable: true, value: 2 });
    } catch {
      /* ignore */
    }
    markNative(patched, 'fetch');
    window.fetch = patched as typeof fetch;
  }

  // ② XHR 咽喉：open 记号（WeakSet，页面不可见）→ send 吞掉并合成假完成
  const XP = XMLHttpRequest.prototype;
  origXhrOpen = XP.open;
  origXhrSend = XP.send;
  const nativeOpen = origXhrOpen;
  const nativeSend = origXhrSend;

  XP.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      if (isCsenseUrl(String(url))) xhrMarked.add(this);
    } catch {
      /* ignore */
    }
    return (nativeOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XP.open;

  XP.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (!xhrMarked.has(this)) {
      return (nativeSend as (...a: unknown[]) => void).apply(this, [body as never]);
    }
    // 合成假完成事件：必须 dispatchEvent（readystatechange+load+loadend 全量派发），
    // 只调 on*/onreadystatechange IDL 回调会让 addEventListener 型调用方永久悬挂
    // ——对齐 feishu-guard / net-firewall 的既有修法。
    const self = this;
    noteHit('xhr');
    setTimeout(() => {
      try {
        Object.defineProperty(self, 'readyState', { configurable: true, value: 4 });
        Object.defineProperty(self, 'status', { configurable: true, value: 200 });
        Object.defineProperty(self, 'responseText', { configurable: true, value: '{}' });
        Object.defineProperty(self, 'response', { configurable: true, value: '{}' });
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('load'));
        self.dispatchEvent(new ProgressEvent('loadend'));
      } catch {
        /* ignore */
      }
    }, 0);
    return undefined;
  } as typeof XP.send;

  // ③ sendBeacon 咽喉：keepalive 型信标同样吞掉
  try {
    const nav = navigator as Navigator & {
      sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean;
    };
    if (typeof nav.sendBeacon === 'function') {
      origBeacon = nav.sendBeacon.bind(navigator);
      const nativeBeacon = origBeacon;
      const patchedBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
        if (isCsenseUrl(String(url))) {
          noteHit('beacon');
          return true; // 假成功，不出网
        }
        return nativeBeacon(url, data);
      };
      try {
        Object.defineProperty(patchedBeacon, 'name', { configurable: true, value: 'sendBeacon' });
        Object.defineProperty(patchedBeacon, 'length', { configurable: true, value: 2 });
      } catch {
        /* ignore */
      }
      nav.sendBeacon = patchedBeacon;
    }
  } catch {
    /* ignore */
  }

  // ④ 跳转咽喉（三层）：location.href= / assign / replace / window.open / 链接 / 表单
  //    —— 命中 csdetected 域即静默取消，页面原地不动
  installNavigationKillSwitch();

  // ⑤ 遮罩即时清除：div.csense-window 一插入 DOM 立即移除，遮罩永远盖不住页面
  installOverlayStripper();

  // ⑥ 特征扫描：立即一次 + onIdle 补扫 + 可见性门控低频巡检
  scan();
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scan();
  });
  window.setTimeout(() => {
    scan();
    scanTimer = window.setInterval(tick, 4000);
  }, 1200);
}

// ───── ④ 跳转咽喉 ─────

/**
 * 导航事件最小结构（Navigation API，Chrome 102+；lib.dom 未收录，手写最小面）。
 * NavigateEvent 可取消 —— preventDefault 后本次文档级导航静默作废，
 * 覆盖 location.href= / assign / replace / window.open(同页) / 链接 / 表单。
 */
interface NavigateEventLike extends Event {
  destination: { url: string };
}

type NavigationLike = {
  addEventListener(type: 'navigate', cb: (e: NavigateEventLike) => void): void;
};

/** 假 window 桩：window.open 命中黑名单时返回，避免调用方按「弹窗被拦」走重试 */
function fakeWindowStub(): Window {
  const stub = {
    closed: false,
    close: () => undefined,
    focus: () => undefined,
    blur: () => undefined,
    print: () => undefined,
    postMessage: () => undefined,
    opener: null,
  };
  return stub as unknown as Window;
}

function installNavigationKillSwitch(): void {
  // a. Navigation API：唯一能拦住 `location.href = url` 直赋值的钩点
  try {
    const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
    if (nav && typeof nav.addEventListener === 'function' && !navListenerInstalled) {
      nav.addEventListener('navigate', (e) => {
        try {
          if (e.destination && isCsenseUrl(e.destination.url)) {
            e.preventDefault();
            noteHit('nav');
          }
        } catch {
          /* ignore */
        }
      });
      navListenerInstalled = true;
    }
  } catch {
    /* Navigation API 不可用（老 Firefox 等），由 b/c 兜底 */
  }

  // b. Location.prototype.assign / replace：location 属性本身 [Unforgeable] 不可
  //    定义，但其方法在原型上、可安全包装。markNative 进 toString 白名单。
  const LP = Location.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  if (typeof LP.assign === 'function' && !origAssign) {
    origAssign = LP.assign.bind(location) as (url: string) => void;
    const nativeAssign = origAssign;
    const patchedAssign = function (this: unknown, url: string) {
      if (isCsenseUrl(String(url))) {
        noteHit('nav');
        return undefined; // 静默吞掉，页面原地不动
      }
      return nativeAssign(url);
    };
    markNative(patchedAssign, 'assign');
    LP.assign = patchedAssign as typeof LP.assign;
  }
  if (typeof LP.replace === 'function' && !origReplace) {
    origReplace = LP.replace.bind(location) as (url: string) => void;
    const nativeReplace = origReplace;
    const patchedReplace = function (this: unknown, url: string) {
      if (isCsenseUrl(String(url))) {
        noteHit('nav');
        return undefined;
      }
      return nativeReplace(url);
    };
    markNative(patchedReplace, 'replace');
    LP.replace = patchedReplace as typeof LP.replace;
  }

  // c. window.open：命中返回假 window 桩（不返回 null）
  if (!origOpen) {
    origOpen = window.open.bind(window);
    const nativeOpen = origOpen;
    const patchedOpen = function (this: unknown, url?: string | URL, ...rest: unknown[]) {
      if (url !== undefined && url !== null && isCsenseUrl(String(url))) {
        noteHit('nav');
        return fakeWindowStub();
      }
      return (nativeOpen as (...a: unknown[]) => Window | null).apply(this, [url, ...rest]);
    };
    markNative(patchedOpen, 'open');
    window.open = patchedOpen as typeof window.open;
  }
}

// ───── ⑤ 遮罩即时清除 ─────

/**
 * childList 观察器挂 documentElement 与 body（顶层插入两种目标全覆盖）。
 * 铁律：对 UI 根的即时纠正必须挂属性观察器，不能只靠巡检——遮罩从插入到
 * 巡检周期之间有最长数秒的可见窗口，观察器把这个窗口压到 0。
 * 选择器窄口径：只删 .csense-window，其余任何节点零接触。
 */
function installOverlayStripper(): void {
  if (overlayMo || typeof MutationObserver === 'undefined') return;
  overlayMo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        try {
          // 直接命中或容器内携带（防它把遮罩包在自己的容器里插入）
          const overlays = node.classList.contains('csense-window')
            ? [node]
            : Array.from(node.querySelectorAll<HTMLElement>('.csense-window'));
          for (const el of overlays) {
            el.remove();
            noteHit('overlay');
          }
        } catch {
          /* ignore */
        }
      }
    }
  });
  try {
    overlayMo.observe(document.documentElement, { childList: true });
  } catch {
    /* ignore */
  }
  // document-start 时 body 可能还没解析出来，就绪后补挂
  if (document.body) {
    try {
      overlayMo.observe(document.body, { childList: true });
    } catch {
      /* ignore */
    }
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (overlayMo && document.body) {
          try {
            overlayMo.observe(document.body, { childList: true });
          } catch {
            /* ignore */
          }
        }
      },
      { once: true },
    );
  }
}

/** 卸载（仅测试/调试用）：先比对再还原（last-writer-wins 防护） */
export function uninstallCsenseGuard(): void {
  if (!installed) return;
  installed = false;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = 0;
  }
  if (origFetch && window.fetch !== origFetch) window.fetch = origFetch;
  const XP = XMLHttpRequest.prototype;
  if (origXhrOpen && XP.open !== origXhrOpen) XP.open = origXhrOpen;
  if (origXhrSend && XP.send !== origXhrSend) XP.send = origXhrSend;
  if (origBeacon) {
    try {
      (navigator as Navigator & { sendBeacon?: typeof origBeacon }).sendBeacon = origBeacon;
    } catch {
      /* ignore */
    }
  }
  // 跳转咽喉还原（origAssign/origReplace 已 bind(location)，直接回填；
  // 仅测试/调试路径使用，不比对 last-writer-wins —— 本体运行期不会卸载）
  const LP = Location.prototype as unknown as Record<string, unknown>;
  if (origAssign) LP.assign = origAssign;
  if (origReplace) LP.replace = origReplace;
  if (origOpen && window.open !== origOpen) window.open = origOpen;
  if (overlayMo) {
    overlayMo.disconnect();
    overlayMo = null;
  }
}

/** 对外只读状态（__vaimod_debug.csense / UI 用） */
export function csenseStatus(): CsenseStatus {
  return {
    present,
    signals: [...signals],
    hits: { ...hits },
    lastHit,
  };
}
