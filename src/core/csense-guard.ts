// ===== CSense 拦截器反制（csense-guard） =====
//
// 目标：ccw 社区扩展「CSense 拦截器」v0.1.5a3（Chen-Jin @ CCW）。
// 这是作品作者安装的「阻止 CSense 使用者运行你的作品」检测扩展，检测面：
//   - DOM 扫描：`html>div[style*="rgb"] *`、`body>div:empty[style*="inset"]`、
//     `button[title*="CCW"] img[alt]`、shadow-root 探测、iframe contentWindow
//   - VM 检查：vm.loadProject 原生性、ccwAPI.Extension / extensionManager / getInfo
//   - 存储指纹：localStorage `__csense-plugins`、`ext_csb3.2*`、`csbv`、`csb3u`、cookie
//   - 环境指纹：navigator.userAgent
// 命中后：fetch(keepalive) POST →
//   `https://dcynsppfvlkdtbaleefw.supabase.co/rest/v1/csense_detections`
//   以及 `https://d.chen-jin.dpdns.org/csdetected?...`（携带页面上下文的外泄信标）。
// userscript 用户（含 VaIMod）被其通用启发式误伤的概率极高 → 检测数据被送往第三方。
//
// 反制原则（与本体一致：被动、窄口径、绝不破坏站点功能）：
//   1) 上报咽喉：fetch / XHR / sendBeacon 命中 CSense 专属端点 → 本地合成假成功，
//      请求不出网。CSense 拿到 200 不会重试风暴，检测记录永不落库；
//   2) 特征记录：只读扫描 CSense 迹象（localStorage 键 / .csense-window / cookie），
//      供 `__vaimod_debug.csense()` 诊断 —— 绝不动它的对象（不与扩展正面对抗）；
//   3) 检测面对策（多数为既有能力，此处仅汇总不新增钩子）：
//        shadow-root 扫描   → 面板活在 closed shadow（DOM 查询查无此人）
//        vm.loadProject     → lp-guard 纯旁路 + stealth toString 白名单
//        DOM/遍历扫描       → stealth 已过滤宿主（含 `body>div:empty[inset]` 类探测）
//        localStorage 指纹  → 品牌键（val_mod_* / vaimod-*）与 csb* 无任何交集
//        ccwAPI.Extension   → VaIMod 不注册任何 extension / extensionManager 条目
//
// 黑名单口径刻意收窄到两个 CSense 专属端点——其余任何请求（包括 m.ccw.site 的
// 扩展热更新 JS）一律透传，保证站点与其它扩展功能零影响。
//
// 已知边界：Location.assign/replace/href 属 [Unforgeable]（实例自有、不可配置），
// 无法包装；但 CSense 的上报主通道是 fetch POST（`qX2:"fetch"` / `uB2:"post"`），
// 导航式上报未在载荷中出现，风险接受。

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
  /** 吞掉的 CSense 上报计数 */
  hits: { fetch: number; xhr: number; beacon: number };
  /** 最近一次吞掉的时间戳（Date.now()），无则 null */
  lastHit: number | null;
}

let installed = false;
let origFetch: typeof fetch | null = null;
let origXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let origXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let origBeacon: ((url: string | URL, data?: BodyInit | null) => boolean) | null = null;
let scanTimer = 0;

const xhrMarked = new WeakSet<object>();
const hits: CsenseStatus['hits'] = { fetch: 0, xhr: 0, beacon: 0 };
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

  // ④ 特征扫描：立即一次 + onIdle 补扫 + 可见性门控低频巡检
  scan();
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scan();
  });
  window.setTimeout(() => {
    scan();
    scanTimer = window.setInterval(tick, 4000);
  }, 1200);
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
