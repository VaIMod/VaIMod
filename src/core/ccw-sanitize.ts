// CCW 运行时方法原生伪装层 —— 自 CSRT AntiCSense v1.2 移植（行为对齐，实现并入 VaIMod 基建）。
// 与既有防线的分工：
//   csense-guard  → 网络咽喉（fetch/XHR/sendBeacon 黑名单，CSense 上报数据不出网）
//   dom-utils     → UI 隐身（宿主元素过滤 + toString 白名单）
//   本模块        → 运行时方法伪装（loadProject 等 CCW 方法洗白成 native）+ DOM 注入拦截
//                   （script src 陷阱 / innerHTML 反制 / 隐藏反制——补齐网络层覆盖不到的面）
// 与 CSRT 的差异：fetch 拦截不重复移植（csense-guard 原型级钩子已覆盖且更早）；
// hardenDocumentProto 不移植（stealth 的 applyPatch+markNative 已让全部查询 API 伪装 native）。

import { markFakeSource, markNative, nativeToStringOf } from '../dom-utils';

// CSense 特征：域名 / 上报路径关键字（与 csense-guard 黑名单同源）
const SUSPECT_HOSTS = ['csense_detections', 'csdetected', 'csense-detect', 'chen-jin.dpdns.org'];
const SUSPECT_KEYS = ['csense-window', 'csense_detections'];

// 需要「洗白成 native」的 CCW 运行时方法（CSRT SUSPECT_METHODS 同款）
const SUSPECT_METHODS = [
  'setCCWAPI',
  'getUserInfo',
  'greenFlag',
  'start',
  'addSprite',
  'exportSprite',
  'saveProjectSb3',
];
const CCWAPI_METHODS = [
  'getProjectUUID',
  'getUserInfo',
  'isFollowed',
  'isMyFans',
  'isLiked',
  'requestCoins',
  'requestFollow',
  'getCoinCount',
  'isLikedProject',
  'isFavoriteProject',
  'setCCWAPI',
];
const RT_METHODS = ['setCCWAPI'];
const EXT_MGR_METHODS = ['isValidExtensionURL', 'loadExtensionURL'];

interface VMLikeRuntime {
  loadProject?: unknown;
  setCCWAPI?: unknown;
  ccwAPI?: Record<string, unknown>;
  extensionManager?: {
    vm?: { loadProject?: unknown };
    isValidExtensionURL?: unknown;
    loadExtensionURL?: unknown;
  };
}

function isSuspectUrl(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  for (const h of SUSPECT_HOSTS) {
    if (v.indexOf(h) !== -1) return true;
  }
  return false;
}

function isSuspectKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  for (const k of SUSPECT_KEYS) {
    if (v.indexOf(k) !== -1) return true;
  }
  return false;
}

/**
 * 就地伪装：把 fn 的 toString/name/length 改成 native 形态并登记伪源码。
 * template 传入时以它为模板拷贝 name/length（保持签名一致）。
 */
export function sanitizeInPlace(fn: unknown, template?: unknown): unknown {
  if (typeof fn !== 'function') return fn;
  const tpl = typeof template === 'function' ? template : null;
  const name = tpl ? (tpl as Function).name || (fn as Function).name : (fn as Function).name;
  const source = tpl ? nativeToStringOf(tpl) : `function ${name || ''}() { [native code] }`;

  try {
    Object.defineProperty(fn, 'toString', {
      value: function toString(): string {
        return source;
      },
      writable: false,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* ignore */
  }
  try {
    if (name && (fn as Function).name !== name) {
      Object.defineProperty(fn, 'name', {
        value: name,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    /* ignore */
  }
  try {
    const wantLength = tpl ? (tpl as Function).length : (fn as Function).length;
    if ((fn as Function).length !== wantLength) {
      Object.defineProperty(fn, 'length', {
        value: wantLength,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    /* ignore */
  }
  markFakeSource(fn, source);
  return fn;
}

/** loadProject 元数据修复（CSRT 同款）：原生签名 name='loadProject'、length=3 */
export function fixLoadProjectMeta(fn: unknown): void {
  if (typeof fn !== 'function') return;
  try {
    if (!(fn as Function).name) {
      Object.defineProperty(fn, 'name', {
        value: 'loadProject',
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
    if ((fn as Function).length !== 3) {
      Object.defineProperty(fn, 'length', {
        value: 3,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    /* ignore */
  }
}

/** 对 VM 的 CCW 相关方法做全量原生伪装（CSRT sanitizeVM 同款遍历面） */
export function sanitizeVM(vm: unknown): void {
  if (!vm || typeof vm !== 'object') return;
  const v = vm as Record<string, unknown> & { runtime?: VMLikeRuntime };
  try {
    if (typeof v.loadProject === 'function') {
      sanitizeInPlace(v.loadProject);
      fixLoadProjectMeta(v.loadProject);
    }
    const rtVm = v.runtime?.extensionManager?.vm;
    if (rtVm && typeof rtVm.loadProject === 'function') {
      sanitizeInPlace(rtVm.loadProject);
      fixLoadProjectMeta(rtVm.loadProject);
    }
    for (const name of SUSPECT_METHODS) {
      const fn = v[name];
      if (typeof fn === 'function') sanitizeInPlace(fn);
    }
    const rt = v.runtime;
    if (rt) {
      for (const name of RT_METHODS) {
        const fn = (rt as unknown as Record<string, unknown>)[name];
        if (typeof fn === 'function') sanitizeInPlace(fn);
      }
      const ccwApi = rt.ccwAPI;
      if (ccwApi) {
        for (const name of CCWAPI_METHODS) {
          const fn = ccwApi[name];
          if (typeof fn === 'function') sanitizeInPlace(fn);
        }
      }
      const em = rt.extensionManager;
      if (em) {
        for (const name of EXT_MGR_METHODS) {
          const fn = (em as unknown as Record<string, unknown>)[name];
          if (typeof fn === 'function') sanitizeInPlace(fn);
        }
        const emVm = em.vm;
        if (emVm && typeof emVm.loadProject === 'function') {
          sanitizeInPlace(emVm.loadProject);
          fixLoadProjectMeta(emVm.loadProject);
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 持续洗白循环（CSRT startSanitizeLoop 同款）：VM 就绪前后页面都可能重新包装
 * 这些方法（补丁热更新/缓存加载），100ms 轮询持续重刷，上限 180s 自动停止。
 */
export function startSanitizeLoop(getVMRef: () => unknown): void {
  let count = 0;
  const timer = setInterval(() => {
    count++;
    let vm: unknown = null;
    try {
      vm = getVMRef();
    } catch {
      /* ignore */
    }
    if (vm) sanitizeVM(vm);
    if (count > 1800) clearInterval(timer);
  }, 100);
}

// ---------------- DOM 注入拦截（网络层覆盖不到的面） ----------------

let createElementPatched = false;
/** script src 陷阱：可疑域名的脚本注入改写为 about:blank（CSRT patchCreateElement 同款） */
export function patchCreateElement(): void {
  if (createElementPatched) return;
  const proto = Document.prototype as unknown as Record<string, unknown>;
  const orig = proto.createElement as (this: Document, tag: string) => HTMLElement;
  if (typeof orig !== 'function') return;
  createElementPatched = true;
  const wrapped = function (this: Document, tagName: string): HTMLElement {
    const el = orig.apply(this, arguments as unknown as [string]);
    try {
      if (String(tagName).toLowerCase() === 'script') {
        const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
        if (desc && desc.set && desc.get) {
          const setSrc = desc.set;
          const getSrc = desc.get;
          Object.defineProperty(el, 'src', {
            get: function (this: HTMLScriptElement) {
              return getSrc.call(this);
            },
            set: function (this: HTMLScriptElement, v: string) {
              if (isSuspectUrl(v)) return setSrc.call(this, 'about:blank');
              return setSrc.call(this, v);
            },
            configurable: true,
          });
        }
      }
    } catch {
      /* ignore */
    }
    return el;
  };
  try {
    proto.createElement = wrapped as unknown as typeof orig;
  } catch {
    /* ignore */
  }
  markNative(wrapped, 'createElement');
}

let suspiciousClear = false;
let innerHtmlPatched = false;
/** innerHTML 反制：拦 CSense 遮罩注入 + documentElement 清空（CSRT patchInnerHTML 同款） */
export function patchInnerHTML(): void {
  if (innerHtmlPatched) return;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (!desc || !desc.set || !desc.get) return;
  innerHtmlPatched = true;
  const origSet = desc.set;
  const origGet = desc.get;
  // 伪装纪律：先抓原生 setter 源码再包装，包装后把原生源码登记为伪源码
  const nativeSetSrc = nativeToStringOf(origSet);
  const wrappedSet = function (this: Element, v: string): void {
    try {
      if (isSuspectKey(v)) {
        return origSet.call(this, '');
      }
      if (this === document.documentElement && (v === '' || v == null)) {
        suspiciousClear = true;
        return;
      }
    } catch {
      /* ignore */
    }
    return origSet.call(this, v);
  };
  try {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      get: origGet,
      set: wrappedSet,
      configurable: true,
    });
    markFakeSource(wrappedSet, nativeSetSrc);
  } catch {
    /* ignore */
  }
}

let stylePatched = false;
/** 隐藏反制：紧跟「documentElement 清空」的 display:none 一并拦下（CSRT patchStyleDisplay 同款） */
export function patchStyleDisplay(): void {
  if (stylePatched) return;
  const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'display');
  if (!desc || !desc.set || !desc.get) return;
  stylePatched = true;
  const origSet = desc.set;
  const origGet = desc.get;
  const nativeSetSrc = nativeToStringOf(origSet);
  const wrappedSet = function (this: CSSStyleDeclaration, v: string): void {
    try {
      if (v === 'none' && suspiciousClear) {
        suspiciousClear = false;
        return;
      }
    } catch {
      /* ignore */
    }
    return origSet.call(this, v);
  };
  try {
    Object.defineProperty(CSSStyleDeclaration.prototype, 'display', {
      get: origGet,
      set: wrappedSet,
      configurable: true,
    });
    markFakeSource(wrappedSet, nativeSetSrc);
  } catch {
    /* ignore */
  }
}

/** document-start 安装入口：只装 DOM 注入拦截（运行时伪装等 VM 就绪后由 startSanitizeLoop 接管） */
export function installCcwSanitize(): void {
  patchCreateElement();
  patchInnerHTML();
  patchStyleDisplay();
}
