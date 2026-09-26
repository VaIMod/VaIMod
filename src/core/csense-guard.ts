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
//
// ─────────────────────────────────────────────────────────────────────────────
// V2 增量（⑦ VA 加固）：移植外挂脚本「Void Apex v0.1.12」的两套手法。
// ① 防检测补漏 installVaStealth()——原脚本 DeepStealth 段落里 VaIMod anti-fp
//    尚未覆盖的指纹/自动化痕迹项（Error 堆栈清痕、selenium/playwright/puppeteer/
//    cdc_ 等自动化特征抹除、maxTouchPoints/language/getBattery/permissions/
//    enumerateDevices、screen.colorDepth/pixelDepth、WebRTC iceServers 清空、
//    chrome.runtime 接口删除）。已覆盖项（UA 画像/时间/canvas/audio/console
//    静默等）一律不重复装，只补缺口。
// ② 拦截自愈 installInterceptorWatchdog()——原脚本用 hooked WeakSet + Proxy.wrap
//    给「被自己包过的函数」记账；这里同构地把 csense-guard 装的全部咽喉登记成
//    账本，低频比对：一旦被第三方还原成**原生函数**（CSense 或恶意脚本的反反制）
//    立即重装并计数。判定口径刻意收窄到「=== 原生引用」——别人叠加的包装不动，
//    保证与官方云通道/net-firewall 等同样 hook XHR 的模块零冲突。
// 全部为增量，原三板斧（fetch/XHR/beacon 拦截、跳转咽喉、遮罩清除）逻辑不变。

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
  /**
   * 吞掉的 CSense 动作计数（检测上报 / 跳转 / 遮罩）；
   * `shield` 为 V2 增量：被第三方还原后自愈重装的拦截器次数。
   */
  hits: {
    fetch: number;
    xhr: number;
    beacon: number;
    nav: number;
    overlay: number;
    shield: number;
  };
  /** 最近一次吞掉的时间戳（Date.now()），无则 null */
  lastHit: number | null;
  /** V2 增量：已应用的防检测补漏项名（只读诊断，来自 Void Apex 手法移植） */
  stealth: string[];
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

/** V2 增量：原始（未包装）引用，仅用于判定「我们的拦截器是否被还原成原生」 */
let rawAssign: ((url: string) => void) | null = null;
let rawReplace: ((url: string) => void) | null = null;
let rawOpen: typeof window.open | null = null;
let vaStealthInstalled = false;

/**
 * V2 增量：拦截器账本（对齐 Void Apex 的 hooked WeakSet 思路）。
 * `ours` 是我们装的引用、`native` 是原生引用；票据判定见 watchInterceptors()。
 */
interface InterceptorEntry {
  label: string;
  read: () => unknown;
  ours: unknown;
  native: unknown;
  reinstall: () => void;
}
const interceptorBook: InterceptorEntry[] = [];

const xhrMarked = new WeakSet<object>();
const hits: CsenseStatus['hits'] = { fetch: 0, xhr: 0, beacon: 0, nav: 0, overlay: 0, shield: 0 };
let lastHit: number | null = null;
let signals: string[] = [];
let present = false;
/** V2 增量：已应用的防检测补漏项（诊断用） */
let stealthApplied: string[] = [];

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
  watchInterceptors();
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
    interceptorBook.push({
      label: 'fetch',
      read: () => window.fetch,
      ours: patched as unknown,
      native: nativeFetch as unknown,
      reinstall: () => {
        window.fetch = patched as typeof fetch;
      },
    });
  }

  // ② XHR 咽喉：open 记号（WeakSet，页面不可见）→ send 吞掉并合成假完成
  const XP = XMLHttpRequest.prototype;
  origXhrOpen = XP.open;
  origXhrSend = XP.send;
  const nativeOpen = origXhrOpen;
  const nativeSend = origXhrSend;

  const patchedXhrOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      if (isCsenseUrl(String(url))) xhrMarked.add(this);
    } catch {
      /* ignore */
    }
    return (nativeOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XP.open;
  XP.open = patchedXhrOpen;

  const patchedXhrSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
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
  XP.send = patchedXhrSend;
  interceptorBook.push({
    label: 'XHR.open',
    read: () => XP.open,
    ours: patchedXhrOpen as unknown,
    native: nativeOpen as unknown,
    reinstall: () => {
      XP.open = patchedXhrOpen;
    },
  });
  interceptorBook.push({
    label: 'XHR.send',
    read: () => XP.send,
    ours: patchedXhrSend as unknown,
    native: nativeSend as unknown,
    reinstall: () => {
      XP.send = patchedXhrSend;
    },
  });

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
      interceptorBook.push({
        label: 'sendBeacon',
        read: () => nav.sendBeacon,
        ours: patchedBeacon as unknown,
        native: nativeBeacon as unknown,
        reinstall: () => {
          nav.sendBeacon = patchedBeacon;
        },
      });
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

  // ⑦ V2 增量：VA 加固（Void Apex 手法移植）—— 防检测补漏 + 拦截自愈守护
  // 逃生口：localStorage 置 vaimod_csense_va_off=1 可整段停用（误伤排查用，刷新生效）。
  // 与 anti-fp 的熔断同口径：安全增强一律留一键回退，避免装上去就摘不下来。
  let vaOff = false;
  try {
    vaOff = localStorage.getItem('vaimod_csense_va_off') === '1';
  } catch {
    /* localStorage 不可用（隐私模式等）→ 保持默认启用 */
  }
  if (!vaOff) {
    try {
      installVaStealth();
    } catch {
      /* ignore */
    }
    try {
      installInterceptorWatchdog();
    } catch {
      /* ignore */
    }
  }

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
    rawAssign = LP.assign as (url: string) => void;
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
    interceptorBook.push({
      label: 'Location.assign',
      read: () => LP.assign,
      ours: patchedAssign as unknown,
      native: rawAssign as unknown,
      reinstall: () => {
        LP.assign = patchedAssign as typeof LP.assign;
      },
    });
  }
  if (typeof LP.replace === 'function' && !origReplace) {
    rawReplace = LP.replace as (url: string) => void;
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
    interceptorBook.push({
      label: 'Location.replace',
      read: () => LP.replace,
      ours: patchedReplace as unknown,
      native: rawReplace as unknown,
      reinstall: () => {
        LP.replace = patchedReplace as typeof LP.replace;
      },
    });
  }

  // c. window.open：命中返回假 window 桩（不返回 null）
  if (!origOpen) {
    rawOpen = window.open;
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
    interceptorBook.push({
      label: 'window.open',
      read: () => window.open,
      ours: patchedOpen as unknown,
      native: rawOpen as unknown,
      reinstall: () => {
        window.open = patchedOpen as typeof window.open;
      },
    });
  }
}

// ───── ⑤ 遮罩即时清除 ─────

/**
 * childList+class 属性观察器挂 documentElement 与 body（顶层插入两种目标全覆盖）。
 * 铁律：对 UI 根的即时纠正必须挂属性观察器，不能只靠巡检——遮罩从插入到
 * 巡检周期之间有最长数秒的可见窗口，观察器把这个窗口压到 0。
 * V3 实测（动态插桩确认）：遮罩的 className 是「先插入 DOM、后赋值」——
 * childList-only 观察器在插入瞬间看不到 csense-window，必然漏检；必须同时盯
 * class 属性变化，赋类那一刻命中即删。
 * 选择器窄口径：只删 className 含 csense-window 的节点，其余任何节点零接触
 * （官方弹窗里的「CSense 拦截器」纯文本不是 className，绝不误伤）。
 */
function installOverlayStripper(): void {
  if (overlayMo || typeof MutationObserver === 'undefined') return;
  overlayMo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        // 「先插入、后赋 className」路径：赋类那一刻命中即删
        try {
          const t = m.target as HTMLElement | null;
          if (t && t.parentNode && t.classList.contains('csense-window')) {
            t.remove();
            noteHit('overlay');
          }
        } catch {
          /* ignore */
        }
        continue;
      }
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
    overlayMo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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

// ───── ⑦ VA 加固（Void Apex 手法移植） ─────

/**
 * 自动化框架特征键（来源：外挂脚本 Void Apex v0.1.12 的 DeepStealth 名单）。
 * navigator 面一律隐藏；window 面按「自动特征」抹除。
 */
const AUTOMATION_KEYS = [
  'webdriver',
  'callPhantom',
  '_phantom',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
  'selenium',
  '__selenium_unwrapped',
  '__selenium_evaluate',
  '__webdriver_evaluate',
  '__driver_evaluate',
  '__playwright',
  '__pw_manual',
  '__PW_inspect',
  '__puppeteer_evaluation_script__',
  'cdc_adoQpoasnfa76pfcZLmcfl_Array',
  'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
  'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
  '$cdc_asdjflasutopfhvcZLmcfl_',
  '_Selenium_IDE_Recorder',
  'spawn',
  'emit',
  'Buffer',
];

/**
 * 过于通用、在正常页面也可能存在的键。原脚本无条件删，这里收窄：
 * 仅在确认处于自动化环境（webdriver 为真）时才动，避免误伤站点自身逻辑。
 */
const AUTOMATION_GENERIC = new Set(['spawn', 'emit', 'Buffer']);

/** 堆栈帧是否来自 userscript / 浏览器扩展（清痕口径） */
const STEALTH_FRAME_RE = /userscript|chrome-extension|moz-extension|extension:\/\/|vaimod|csense/i;

function isStealthFrame(frame: unknown): boolean {
  try {
    const cs = frame as {
      getFileName?: () => string | null | undefined;
      getFunctionName?: () => string | null | undefined;
    };
    const file = String(cs.getFileName?.() ?? '');
    const fn = String(cs.getFunctionName?.() ?? '');
    return STEALTH_FRAME_RE.test(file) || STEALTH_FRAME_RE.test(fn);
  } catch {
    return false;
  }
}

/** 在宿主/原型上定义一个只读 getter（失败静默；幂等） */
function defineGetter(target: object, prop: string, value: () => unknown): boolean {
  try {
    Object.defineProperty(target, prop, { get: value, configurable: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 防检测补漏（V2 增量）：补齐 anti-fp 尚未覆盖的指纹 / 自动化痕迹项。
 * 已覆盖项（UA 画像、计时器、canvas/audio/WebGL 噪声、console 静默、F12 守卫等）
 * 一律不重复安装，避免双层包装造成的身份语义漂移。
 *
 * 注：原脚本还有「Function.prototype.toString 白名单伪装」与「console 前缀日志过滤」
 * 两项——VaIMod 侧已由 dom-utils.markNative / anti-fp.installConsolePatches 覆盖，
 * 此处不重复实现。
 */
function installVaStealth(): void {
  if (vaStealthInstalled) return;
  vaStealthInstalled = true;
  const done: string[] = [];

  // ① Error 堆栈清痕（原脚本：stackTraceLimit=5 + prepareStackTrace 过滤自身帧）
  try {
    const E = Error as unknown as {
      stackTraceLimit?: number;
      prepareStackTrace?: (err: Error, frames: unknown[]) => unknown;
    };
    if (typeof E.stackTraceLimit === 'number') E.stackTraceLimit = 5;
    if (typeof E.prepareStackTrace !== 'function') {
      E.prepareStackTrace = function (err: Error, frames: unknown[]): unknown {
        try {
          const kept = Array.isArray(frames) ? frames.filter((f) => !isStealthFrame(f)) : [];
          let out = String(err);
          for (const f of kept) {
            try {
              const s = (f as { toString?: () => string }).toString?.();
              if (s) out += '\n    at ' + s;
            } catch {
              /* ignore */
            }
          }
          return out;
        } catch {
          return String(err);
        }
      };
      done.push('error-stack');
    }
  } catch {
    /* ignore */
  }

  // ② 自动化框架特征抹除（selenium / playwright / puppeteer / cdc_ 等）
  try {
    let autoEnv = false;
    try {
      autoEnv = Boolean((navigator as unknown as { webdriver?: boolean }).webdriver);
    } catch {
      /* ignore */
    }
    const nav = navigator as unknown as Record<string, unknown>;
    const win = window as unknown as Record<string, unknown>;
    let scrubbed = 0;
    for (const key of AUTOMATION_KEYS) {
      try {
        if (key in nav) {
          defineGetter(nav, key, () => undefined);
          scrubbed++;
        }
      } catch {
        /* ignore */
      }
      try {
        if (key in win && (!AUTOMATION_GENERIC.has(key) || autoEnv)) {
          delete win[key];
          scrubbed++;
        }
      } catch {
        /* ignore */
      }
    }
    if (scrubbed > 0) done.push('automation-traces');
  } catch {
    /* ignore */
  }

  // ③ navigator 画像补漏（anti-fp 已覆盖 userAgent/platform/cores/memory/languages/webdriver）
  try {
    const nav = navigator as unknown as Record<string, unknown>;
    if (defineGetter(nav, 'maxTouchPoints', () => 0)) done.push('maxTouchPoints');
    if (defineGetter(nav, 'language', () => 'zh-CN')) done.push('language');
  } catch {
    /* ignore */
  }

  // ④ 电池 / 权限 / 设备枚举（沿用原脚本的固定值口径）
  try {
    const nav = navigator as unknown as {
      getBattery?: () => Promise<unknown>;
      permissions?: { query?: (d: unknown) => Promise<unknown> };
      mediaDevices?: { enumerateDevices?: () => Promise<unknown[]> };
    };
    if (typeof nav.getBattery === 'function') {
      nav.getBattery = () =>
        Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
          addEventListener() {
            /* noop */
          },
          removeEventListener() {
            /* noop */
          },
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
        });
      done.push('getBattery');
    }
    const perms = nav.permissions;
    if (perms && typeof perms.query === 'function') {
      const origQuery = perms.query.bind(perms);
      perms.query = function (desc: unknown): Promise<unknown> {
        try {
          if (desc && (desc as { name?: string }).name === 'notifications') {
            return Promise.resolve({ state: 'denied', onchange: null });
          }
        } catch {
          /* ignore */
        }
        return origQuery(desc);
      };
      done.push('permissions');
    }
    const md = nav.mediaDevices;
    if (md && typeof md.enumerateDevices === 'function') {
      const origEnum = md.enumerateDevices.bind(md);
      md.enumerateDevices = async function (): Promise<unknown[]> {
        const list = await origEnum();
        return (list || []).map((d) => ({
          deviceId: (d as MediaDeviceInfo).deviceId,
          groupId: (d as MediaDeviceInfo).groupId,
          kind: (d as MediaDeviceInfo).kind,
          label: '',
        }));
      };
      done.push('enumerateDevices');
    }
  } catch {
    /* ignore */
  }

  // ⑤ screen 色深（原脚本：恒 24）
  try {
    if (typeof screen !== 'undefined') {
      const s = screen as unknown as Record<string, unknown>;
      if (defineGetter(s, 'colorDepth', () => 24)) done.push('colorDepth');
      if (defineGetter(s, 'pixelDepth', () => 24)) done.push('pixelDepth');
    }
  } catch {
    /* ignore */
  }

  // ⑥ WebRTC：清空 iceServers（防 STUN/STUN-less 收集暴露真实 IP）
  //    —— anti-fp 的 installWebRtcPatches 只做了 relay 策略，未清空 iceServers
  try {
    const rc = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    if (typeof rc === 'function' && !(rc as { __vaIce?: boolean }).__vaIce) {
      const Base = rc as new (cfg?: RTCConfiguration) => RTCPeerConnection;
      const Hardened = class extends Base {
        constructor(cfg?: RTCConfiguration) {
          super(
            Object.assign({}, cfg ?? {}, {
              iceServers: [],
              iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
            }),
          );
        }
      };
      Object.defineProperty(Hardened, '__vaIce', { value: true, configurable: true });
      markNative(Hardened as unknown as object, 'RTCPeerConnection');
      Object.defineProperty(globalThis, 'RTCPeerConnection', {
        configurable: true,
        writable: true,
        value: Hardened,
      });
      done.push('webrtc-ice');
    }
  } catch {
    /* ignore */
  }

  // ⑦ chrome.runtime 自动化锚点（onConnect / onMessage）
  try {
    const rt = (window as unknown as { chrome?: { runtime?: Record<string, unknown> } }).chrome
      ?.runtime;
    if (rt) {
      if ('onConnect' in rt) {
        delete rt.onConnect;
        done.push('chrome.onConnect');
      }
      if ('onMessage' in rt) {
        delete rt.onMessage;
        done.push('chrome.onMessage');
      }
    }
  } catch {
    /* ignore */
  }

  stealthApplied = done;
}

/**
 * 低频比对拦截器账本：仅当我们的拦截器被**还原成原生引用**时才自愈重装
 * （对齐外挂脚本 Void Apex 的 hooked 账本 + 自愈重装思路）。
 *
 * 判定刻意不用 `cur !== ours`——那会把同样 hook XHR/fetch 的其它模块（官方云通道、
 * net-firewall 插件）误判成「篡改」并覆盖回去，形成互相拆台的循环。
 * 用 `cur === native` 则只命中「被人把我们的咽喉整个拆掉」这一种情形。
 */
function watchInterceptors(): void {
  for (const entry of interceptorBook) {
    let cur: unknown;
    try {
      cur = entry.read();
    } catch {
      continue;
    }
    if (cur === entry.ours) continue; // 拦截器在位
    if (cur !== entry.native) continue; // 第三方叠加的包装 → 不属于拆台，不动
    try {
      entry.reinstall();
      noteHit('shield');
    } catch {
      /* ignore */
    }
  }
}

/** 安装 ⑦ 段（供 installCsenseGuard 调用；也可单独用于测试） */
function installInterceptorWatchdog(): void {
  watchInterceptors();
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
  // ⑦ 段（VA 加固）不回滚：均为幂等的只读 getter / 前置加固，无副作用；
  // 且 setter 已改变的宿主再还原意义有限，故仅在测试路径下清账本防止重复记账。
  interceptorBook.length = 0;
}

/** 对外只读状态（__vaimod_debug.csense / UI 用） */
export function csenseStatus(): CsenseStatus {
  return {
    present,
    signals: [...signals],
    hits: { ...hits },
    lastHit,
    stealth: [...stealthApplied],
  };
}
