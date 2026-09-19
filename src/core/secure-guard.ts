import type { ScratchVariable, ScratchValue } from './types';
import { hookExtensionManager, onVmTick, trackVm } from './ext-watch';

// ===== 通用反作弊扩展反制引擎（原 Killeriest 专用 → 多版本自适应） =====
// 已识别敌样本（同族防作弊「安全变量」扩展）：
//   A) 明文版 KilleriestsSecureVars：RSA 签名后门 window.parent._djknbjkas（私钥不可伪造）、
//      while(true) 死循环、_fillAttackerCache 空项目冲刷、saveProjectSb3/exportSprite 空导出、
//      scanVMLeak(Z) 删 vm 全局、_A() 调用栈校验、removeUI 隐藏第三方修改器 UI、XOR+_key 加密存储
//   B) 双层混淆强化版（保存.js → dec-payload）：同族存储结构（_a/_q/_setEnc/_getEnc/_setEncStr/_key 保留），
//      注册 id 动态化、后门字段改名/去字面量、新增 _misleadingApiCalls 蜜罐 / decoy_meta 诱饵 /
//      .spectre-window 与 div[data-hack-intent] 隐藏
// 对抗分四层（本模块整体 document-start 最先安装，先于一切页面脚本）：
//   ① 签名白名单：_djknbjkas 读值替换为哨兵 + crypto.subtle.verify 对哨兵签名放行 →
//      旧版后门 Promise 在构造期 resolve true → 死循环/清空/冲刷/空导出分支全部放行（无需私钥）
//   ② register 前置拦截：Scratch.extensions.register 包装，实例特征化识别即刻接管净化
//   ③ 实例净化：scanVMLeak/Z、_A 栈校验、removeUI/UI 隐藏、_fillAttackerCache 全部无害化；
//      后门 Promise 字段覆盖为已决 true；
//      ⑤（2026-09-13 按 v3.0.0 样本逆向补全）篡改记录字段 _c 冻结（getter 恒 null、
//      写入静默吞掉）→ getTamperInfo 恒返回 ''；_decoyCheck/_setupDecoyGuard/
//      _misleadingApiCalls（保存前轮换 _key）/ _fillDecoyCache / _isEditorEnv / _L 点名
//      无害化；startHats 对 *tamper* 帽一刀切；写入走回读校验防「空函数假成功」；
//      opcode 名无法混淆，按积木描述抓拍 getTamperInfo 干净视图 + when* 篡改帽永闭
//   ④ UI 隐藏样式免疫：持续清理含第三方修改器隐藏选择器的 style 节点
// 加密变量读写：方法优先（_setEnc/_getEnc/_setEncStr），缺失时用 _key 自实现 XOR 兜底。

const EXT_ID_LEGACY = 'KilleriestsSecureVars';
// 安全变量在面板中的 id 前缀（运行时拼接，消除明文特征）
export const SECURE_PREFIX = ['s', 'ec', ':'].join('');

// 敌扩展积木特征（判定注册对象身份用）
const CHEAT_OPCODES = [
  'defineVar', 'setVar', 'getVar', 'changeVar',
  'whenTampered', 'getTamperInfo', 'scanVMLeak',
  'defineStrVar', 'setStrVar', 'getStrVar', 'getAllStrVarNames',
  'clearAllVars', 'clearAllStrVars', 'resetSalt',
];

// 第三方修改器 UI 隐藏选择器特征（命中即整体清除，全面中和敌扩展的 UI 隐藏）
// 数字签名家（ScratchSign / 变体）的 _mask() 也向 #ui-base 注入 style 做同类隐藏，
// 其选择器集合与本表高度重合，因此同一套清理器可覆盖两家。
const HIDE_CSS_MARKERS = [
  '.rd-modal-root-container', '.csense-window', '#vervesynckit', '#vervesynckit-ui',
  '#vervesynckit-message', '#scratch-variable-panel', '#spd-open', '#spd-toolbar',
  '.spectre-window', 'data-hack-intent', 'anti-cheat-hidden-css',
  '\u6253\u5f00\u53d8\u91cf\u4fee\u6539\u5668',
];

// 后门哨兵：合法 base64、可被 atob 解析；verify 补丁识别它即放行（对正常验签零影响）
const SENTINEL = ['S2ls', 'bGVyaWVz', 'dC1zZW', '50aW5lbA', '=='].join(''); // b64("Killeriest-sentinel")

interface SecureExtensionLike {
  _a?: Record<string, string>;
  _q?: Record<string, string>;
  _setEnc?: (name: string, value: number) => void;
  _getEnc?: (name: string) => number | null;
  _setEncStr?: (name: string, value: string) => void;
  _getEncStr?: (name: string) => string | null;
  _key?: string;
  _A?: () => void;
  Z?: (...args: unknown[]) => void;
  removeUI?: () => void;
  _runtime?: unknown;
  getInfo?: () => { id?: string; blocks?: { opcode?: string }[] };
  [key: string]: unknown;
}

// ---------- 纯本地 base64 / XOR 工具（不依赖全局 btoa/atob，防站点篡改） ----------
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function localB64Encode(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const c1 = input.charCodeAt(i);
    const c2 = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    out += B64_CHARS.charAt(c1 >> 2);
    out += B64_CHARS.charAt(((c1 & 3) << 4) | (Number.isNaN(c2) ? 0 : c2 >> 4));
    out += Number.isNaN(c2) ? '=' : B64_CHARS.charAt(((c2 & 15) << 2) | (Number.isNaN(c3) ? 0 : c3 >> 6));
    out += Number.isNaN(c3) ? '=' : B64_CHARS.charAt(c3 & 63);
  }
  return out;
}

function localB64Decode(input: string): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (ch === '=') break;
    const idx = B64_CHARS.indexOf(ch);
    if (idx < 0) continue;
    buf = (buf << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** 与敌扩展同构的 XOR 解密：b64 密文 ^ 逐码元 _key（其存储值为 ASCII 时完全兼容） */
function xorDecryptLocal(cipher: string, key: string): string | null {
  try {
    const bin = localB64Decode(cipher);
    let out = '';
    const klen = key.length;
    for (let i = 0; i < bin.length; i++) {
      out += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % klen));
    }
    return out;
  } catch {
    return null;
  }
}

/** 与敌扩展同构的 XOR 加密 */
function xorEncryptLocal(plain: string, key: string): string | null {
  try {
    let out = '';
    const klen = key.length;
    for (let i = 0; i < plain.length; i++) {
      out += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % klen));
    }
    return localB64Encode(out);
  } catch {
    return null;
  }
}

// ---------- ① 白名单标记 + 签名放行补丁（document-start 最先执行） ----------
function applyWhitelistMark(): void {
  try {
    const self = globalThis as unknown as Record<string, unknown>;
    let parent: unknown = null;
    try {
      parent = (globalThis as { parent?: unknown }).parent;
    } catch {
      /* ignore */
    }
    const targets: unknown[] = parent && parent !== globalThis ? [self, parent] : [self];
    for (const w of targets) {
      try {
        Object.defineProperty(w as object, '_djknbjkas', {
          configurable: true,
          get: () => SENTINEL,
        });
      } catch {
        /* 属性已存在不可重定义则跳过 */
        try {
          (w as Record<string, unknown>)._djknbjkas = SENTINEL;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* 跨域等场景忽略 */
  }
}

/** crypto.subtle.verify 补丁：敌扩展的后门验签以固定消息（'Killeriest'）验 RSA 签名——
 *  对其验签调用直接放行（哨兵 signature 亦放行），正常站点验签不受影响 */
let verifyPatched = false;
function patchCryptoVerify(): void {
  if (verifyPatched) return;
  verifyPatched = true;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.verify !== 'function') return;
    const origVerify = subtle.verify.bind(subtle);
    const wrapped = async (
      algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
      key: CryptoKey,
      signature: BufferSource,
      data: BufferSource,
    ): Promise<boolean> => {
      try {
        // algorithm 可为字符串（'RSASSA-PKCS1-v1_5'）或参数对象，两种形态都识别
        const algName =
          typeof algorithm === 'string'
            ? algorithm
            : (algorithm as { name?: string } | null)?.name;
        if (algName === 'RSASSA-PKCS1-v1_5') {
          let hit = false;
          // 判据一：被验消息正是敌扩展的固定后门消息
          try {
            const msg = new TextDecoder().decode(data as BufferSource);
            hit = msg === '\x4b\x69\x6c\x6c\x65\x72\x69\x65\x73\x74';
          } catch {
            /* ignore */
          }
          // 判据二：签名即为哨兵字节序列（兼容消息不明但带哨兵的变体）
          if (!hit) {
            try {
              const raw = signature as unknown;
              if (raw instanceof Uint8Array) {
                let sigStr = '';
                for (let i = 0; i < raw.length; i++) sigStr += String.fromCharCode(raw[i]);
                if (localB64Encode(sigStr) === SENTINEL) hit = true;
              }
            } catch {
              /* ignore */
            }
          }
          if (hit) return true;
        }
      } catch {
        /* ignore */
      }
      return origVerify(algorithm, key, signature, data);
    };
    (subtle as unknown as { verify: typeof subtle.verify }).verify = wrapped as typeof subtle.verify;
  } catch {
    /* ignore */
  }
}

/** 全局保护统一入口（幂等）：白名单标记 + 签名放行 */
export function installSecureGuardMark(): void {
  applyWhitelistMark();
  patchCryptoVerify();
}

// ---------- 识别 ----------
function detectInstance(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const obj = x as SecureExtensionLike;
  const keys = Object.keys(obj);
  let score = 0;
  if (keys.includes('_a') && keys.includes('_q')) score += 2;
  if (keys.includes('_setEnc') || keys.includes('_setEncStr')) score += 2;
  if (keys.includes('_xorEncrypt')) score += 2;
  if (keys.includes('_A')) score += 1;
  if (keys.includes('_b') && keys.includes('_key') && keys.includes('_c')) score += 1;
  for (const k of keys) {
    const fn = obj[k];
    if (typeof fn === 'function') {
      const src = String(fn);
      if (
        src.includes('whenTampered') || src.includes('scanVMLeak') ||
        src.includes('SV_CHECK_FAIL') || src.includes('illegal_call') ||
        src.includes('resetSalt') || src.includes('executeBroadcast')
      ) {
        score += 2;
      }
    }
  }
  if (score >= 3) return true;
  // 兜底：id 命中旧版
  try {
    const id = obj.getInfo?.()?.id;
    if (id === EXT_ID_LEGACY) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function detectDescriptor(d: unknown): boolean {
  const desc = d as { id?: string; blocks?: { opcode?: string }[] };
  if (!desc || typeof desc !== 'object') return false;
  if (desc.id === EXT_ID_LEGACY) return true;
  const blocks = desc.blocks;
  if (!Array.isArray(blocks)) return false;
  let hit = 0;
  for (const b of blocks) {
    if (b && typeof b.opcode === 'string' && CHEAT_OPCODES.includes(b.opcode)) hit++;
    if (hit >= 3) return true;
  }
  return false;
}

// ---------- 篡改上报面净化（与样本无关，按积木描述行为识别） ----------
/**
 * 敌扩展把「篡改了吗」的判定结果暴露给游戏脚本只有两条路：
 *   · 篡改帽（whenTampered 类 when* 积木）触发反应脚本；
 *   · 查询积木（getTamperInfo 类）返回篡改状态对象。
 * opcode 名无法混淆（sb3 内积木按 opcode 引用，getInfo 必须一致），
 * 因此在净化前按积木描述识别这两类方法并先行处理：
 *   · when* 篡改帽 → 无操作（永不触发）；
 *   · get* 查询   → 在接管时（必然尚未篡改）抓拍一份「干净返回值」，
 *     之后永远返回这份干净快照（深拷贝，防调用方改动污染）。
 * 必须先抓拍再 sanitize：sanitize 可能把查询方法整体替换成空函数。
 */
function captureCleanTamperViews(inst: SecureExtensionLike): void {
  try {
    const info = inst.getInfo?.();
    const blocks = info?.blocks;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      const op = (b as { opcode?: unknown } | null)?.opcode;
      if (typeof op !== 'string' || !op) continue;
      const fn = (inst as Record<string, unknown>)[op];
      if (typeof fn !== 'function') continue;
      if (/^when/i.test(op) && /tamper|cheat|hack|illegal|check|audit/i.test(op)) {
        try {
          (inst as Record<string, unknown>)[op] = () => {};
        } catch {
          /* ignore */
        }
        continue;
      }
      if (/^get/i.test(op) && /tamper|audit/i.test(op)) {
        let clean: unknown;
        try {
          clean = (fn as (...a: unknown[]) => unknown).call(inst);
        } catch {
          clean = undefined;
        }
        const snapshot =
          typeof clean === 'object' && clean !== null
            ? () => {
                try {
                  return structuredClone(clean);
                } catch {
                  try {
                    return JSON.parse(JSON.stringify(clean));
                  } catch {
                    return clean;
                  }
                }
              }
            : () => clean;
        try {
          (inst as Record<string, unknown>)[op] = snapshot;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// ---------- 实例净化 ----------
function sanitizeInstance(inst: SecureExtensionLike): void {
  try {
    // 0) 冻结篡改记录字段 `_c`（本族扩展唯一的篡改上报载体：getTamperInfo 直接
    //    返回 JSON.stringify(this._c)，游戏脚本以「非空串 = 有篡改」判定）。
    //    写成「getter 恒 null + setter 静默吞写」后：
    //      · _A / Z / _decoyCheck / _L / _misleadingApiCalls 等对 _c 的赋值全部失效
    //        （含接管前已由构造期 setTimeout/PROJECT_LOADED 触发过的迟到写入）；
    //      · getTamperInfo 恒返回 ''（干净），无需逐个猜字段名（强化版改名也免疫）。
    const rec = inst as unknown as Record<string, unknown>;
    if ('_c' in rec) {
      try {
        Object.defineProperty(inst, '_c', {
          configurable: true,
          get: () => null,
          set: () => {},
        });
      } catch {
        try {
          rec._c = null;
        } catch {
          /* ignore */
        }
      }
    }
    // 0′) 蜜罐/反制机械点名无害化（明文名与行为级规则双保险；强化版改名后由
    //     下面的关键词 / .stack 规则兜底）：
    //     · _decoyCheck：环境蜜罐（decoy-publish-button / __honeypot_editor_flag → decoy_env）
    //     · _setupDecoyGuard：包装 vm.saveProjectSb3/exportSprite 的入口
    //     · _misleadingApiCalls：每次保存前轮换 _key（全部密文变垃圾）+ decoy_meta 上报
    //     · _fillDecoyCache / _isEditorEnv / _L（篡改帽触发 + _c 写入）
    const decoyFns = [
      '_decoyCheck',
      '_setupDecoyGuard',
      '_misleadingApiCalls',
      '_fillDecoyCache',
      '_isEditorEnv',
      '_L',
    ] as const;
    for (const k of decoyFns) {
      if (typeof inst[k] === 'function') {
        try {
          rec[k] = () => {};
        } catch {
          /* ignore */
        }
      }
    }
    // 1) 后门 Promise 字段 → 已决 true（覆盖后续访问；构造期挂载的 then 由签名放行层兜底）
    for (const k of Object.keys(inst)) {
      const v = inst[k];
      if (v && typeof v === 'object' && typeof (v as Promise<unknown>).then === 'function') {
        try {
          (inst as Record<string, unknown>)[k] = Promise.resolve(true);
        } catch {
          /* ignore */
        }
      }
    }
    // 2) scanVMLeak(Z) → 无害（不删 vm 全局、不清零、不触发 whenTampered）
    if (typeof inst.Z === 'function') inst.Z = () => {};
    // 3) _A() 调用栈校验 → 无害（防合法外部调用被误判清空）
    if (typeof inst._A === 'function') inst._A = () => {};
    // 4) removeUI / UI 隐藏 → 无害（防隐藏 VaIMod 及第三方修改器 UI）
    if (typeof inst.removeUI === 'function') inst.removeUI = () => {};
    // 5) 兜底按特征替换：函数体含防作弊关键词的实例方法 → 无操作
    for (const k of Object.keys(inst)) {
      const fn = inst[k];
      if (typeof fn !== 'function' || fn === inst.Z || fn === inst._A || fn === inst.removeUI) continue;
      const src = String(fn);
      if (
        (k === 'Z' || src.includes('scanVMLeak')) ||
        src.includes('whenTampered') || src.includes('SV_CHECK_FAIL') ||
        src.includes('_fillAttackerCache') ||
        (src.includes('stopAll') && /while\s*\(\s*(?:!0|true|1)\s*\)/.test(src)) ||
        src.includes('hidden-css') || (src.includes('removeUI') && src.includes('display')) ||
        // 栈校验变体（强化版把 _A 改名/内联）：任何读调用栈的实例方法都是
        // 「写 must come from 扩展自身积木」类的合法性检查 → 无害化。
        src.includes('.stack') || src.includes('["stack"]') || src.includes("['stack']")
      ) {
        try {
          (inst as Record<string, unknown>)[k] = () => {};
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// ---------- ② register 前置拦截 ----------
function hookRegister(extApi: { register: (...args: unknown[]) => unknown }): void {
  try {
    const orig = extApi.register.bind(extApi);
    extApi.register = (...args: unknown[]) => {
      try {
        for (const arg of args) {
          if (!arg || typeof arg !== 'object') continue;
          const obj = arg as SecureExtensionLike;
          if (detectInstance(obj)) {
            frontGuard.adopt(obj);
          } else if (typeof obj.getInfo === 'function') {
            try {
              if (detectDescriptor(obj.getInfo())) frontGuard.adopt(obj);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      return orig(...args);
    };
  } catch {
    /* ignore */
  }
}

function watchScratchApi(): void {
  let attempts = 0;
  let scratchSlot: unknown;
  const tryHook = (): void => {
    try {
      if (!scratchSlot || typeof scratchSlot !== 'object') return;
      const ext = (scratchSlot as { extensions?: { register: (...a: unknown[]) => unknown } }).extensions;
      if (ext && typeof ext.register === 'function') hookRegister(ext);
    } catch {
      /* ignore */
    }
  };
  const tick = (): void => {
    attempts++;
    try {
      const win = globalThis as unknown as { Scratch?: unknown };
      scratchSlot = win.Scratch;
      if (scratchSlot) {
        tryHook();
        return;
      }
    } catch {
      /* ignore */
    }
    if (attempts < 60) setTimeout(tick, 400); // 最长约 24s；其后交给 init(vm) 轮询兜底
  };
  try {
    const win = globalThis as unknown as Record<string, unknown>;
    const existing = win.Scratch;
    if (existing) {
      scratchSlot = existing;
      tick();
      return;
    }
    // 捕获站点后续对 window.Scratch 的赋值（同步脚本最可能走这条路）；引用存于闭包，不暴露特征属性
    Object.defineProperty(win, 'Scratch', {
      configurable: true,
      enumerable: true,
      get: () => scratchSlot,
      set: (v: unknown) => {
        scratchSlot = v;
        tryHook();
      },
    });
  } catch {
    /* ignore */
  }
  tick();
}

// ---------- ④ UI 隐藏样式清理 ----------
let styleWatcherInstalled = false;
function purgeHiddenCss(node: ParentNode): void {
  try {
    const styles = node.querySelectorAll('style');
    for (const st of Array.from(styles)) {
      const text = (st.textContent || '');
      if (HIDE_CSS_MARKERS.some((mk) => text.includes(mk))) {
        st.remove();
      }
    }
  } catch {
    /* ignore */
  }
}

// 扫描合并：编辑器渲染每秒会产生数百次 DOM 插入，若逐节点即时扫整棵新增子树
// 代价可观（探针实测为热路径）。这里把一批新增节点合并到 50ms 窗口内扫一次，
// 并消去互相嵌套的根（包含关系只扫最外层），语义与逐节点扫描等价。
const pendingCssRoots: Element[] = [];
let cssScanScheduled = false;

/** 单根扫描：STYLE 直接判内容，其余子树无 <style> 时零分配快速返回 */
function scanHiddenCssRoot(el: Element): void {
  try {
    if (el.tagName === 'STYLE') {
      const text = el.textContent || '';
      if (text && HIDE_CSS_MARKERS.some((mk) => text.includes(mk))) el.remove();
      return;
    }
    // querySelector 命中即返回，且不建数组；绝大多数新节点子树里根本没有 style
    if (!el.querySelector('style')) return;
    purgeHiddenCss(el);
  } catch {
    /* ignore */
  }
}

function queueHiddenCssScan(el: Element): void {
  for (const r of pendingCssRoots) {
    if (r === el || r.contains(el)) return; // 已有祖先在待扫列表，无需重复
  }
  for (let i = pendingCssRoots.length - 1; i >= 0; i--) {
    if (el.contains(pendingCssRoots[i])) pendingCssRoots.splice(i, 1);
  }
  pendingCssRoots.push(el);
  if (cssScanScheduled) return;
  cssScanScheduled = true;
  const run = (): void => {
    cssScanScheduled = false;
    const roots = pendingCssRoots.splice(0, pendingCssRoots.length);
    for (const r of roots) scanHiddenCssRoot(r);
  };
  try {
    setTimeout(run, 50);
  } catch {
    run();
  }
}

function installStyleWatcher(): void {
  if (styleWatcherInstalled) return;
  styleWatcherInstalled = true;
  const tryStart = (): void => {
    try {
      const root = document.documentElement || document;
      purgeHiddenCss(root);
      if (typeof MutationObserver === 'function') {
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of Array.from(m.addedNodes)) {
              const el = node as Element;
              if (el.nodeType === 1) queueHiddenCssScan(el);
            }
          }
        });
        mo.observe(document.documentElement || document, { childList: true, subtree: true });
      }
    } catch {
      /* ignore */
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart, { once: true });
  } else {
    tryStart();
  }
}

// ---------- SecureGuard（对外 API 兼容：init/list/set/key） ----------
export class SecureGuard {
  private instances: SecureExtensionLike[] = [];
  private patchedKeys = new WeakSet<object>();
  private retries = 0;
  private projectHooked = new WeakSet<object>();
  private tickInstalled = false;

  /** register 前置拦截接管实例（幂等，去重） */
  adopt(inst: SecureExtensionLike): boolean {
    if (!inst || this.instances.includes(inst)) return false;
    this.instances.push(inst);
    this.patchInstance(inst);
    return true;
  }

  /** vm 上查找安全扩展并接管（扩展可能稍后才注册：重试 + 事件 + 常驻巡检三路补漏） */
  init(vm: unknown): void {
    if (!vm || typeof vm !== 'object') return;
    const v = vm as object;
    trackVm(v);
    this.hookStartHats(v);
    hookExtensionManager(v, () => {
      const f = this.find(v);
      if (f) this.adopt(f);
    });
    this.watchProjectLoaded(v);
    this.ensureTick();
    const found = this.find(v);
    if (found) {
      this.adopt(found);
      return;
    }
    if (this.retries > 10) return;
    this.retries++;
    setTimeout(() => this.init(v), 500);
  }

  /** PROJECT_LOADED：项目（可能内嵌敌扩展）加载完成后立即重扫 */
  private watchProjectLoaded(vm: object): void {
    if (this.projectHooked.has(vm)) return;
    this.projectHooked.add(vm);
    try {
      (vm as { on?: (event: string, cb: () => void) => void }).on?.('PROJECT_LOADED', () => {
        const rescan = (): void => {
          const f = this.find(vm);
          if (f) this.adopt(f);
        };
        rescan();
        for (const delay of [200, 800, 2000]) setTimeout(rescan, delay);
      });
    } catch {
      /* ignore */
    }
  }

  /** 每 2s 常驻巡检：晚注册的敌扩展（不经 window.Scratch.register 的路径）也能接住 */
  private ensureTick(): void {
    if (this.tickInstalled) return;
    this.tickInstalled = true;
    onVmTick((vm) => {
      this.hookStartHats(vm);
      hookExtensionManager(vm, () => {
        const f = this.find(vm);
        if (f) this.adopt(f);
      });
      const f = this.find(vm);
      if (f) this.adopt(f);
    });
  }

  // startHats 篡改帽压制：敌扩展用 runtime.startHats('KilleriestsSecureVars_whenTampered')
  // 触发反应脚本（_L → 篡改广播）。opcode 名无法混淆（sb3 按名引用），按 /tamper/i
  // 一刀切即可（正常项目不会有名为 *tamper* 的帽子）。每 runtime 只钩一次。
  private startHatsHooked = new WeakSet<object>();

  private hookStartHats(vm: unknown): void {
    try {
      const rt = (vm as { runtime?: { startHats?: (...a: unknown[]) => unknown } }).runtime;
      if (!rt || typeof rt.startHats !== 'function') return;
      if (this.startHatsHooked.has(rt)) return;
      this.startHatsHooked.add(rt);
      const orig = rt.startHats.bind(rt);
      rt.startHats = (op: unknown, ...rest: unknown[]) => {
        if (typeof op === 'string' && /tamper/i.test(op)) return [];
        return orig(op, ...rest);
      };
    } catch {
      /* ignore */
    }
  }

  private find(vm: unknown): SecureExtensionLike | null {
    try {
      const runtime = (vm as { runtime?: { extensions?: unknown } })?.runtime;
      const extensions = (runtime as { extensions?: unknown })?.extensions;
      if (!extensions) return null;
      const candidates: unknown[] = [];
      if (extensions instanceof Map) {
        candidates.push(...extensions.values());
        const direct = extensions.get(EXT_ID_LEGACY);
        if (direct) return direct as SecureExtensionLike;
      } else if (typeof extensions === 'object') {
        const rec = extensions as Record<string, unknown>;
        const direct = rec[EXT_ID_LEGACY];
        if (direct && detectInstance(direct)) return direct as SecureExtensionLike;
        candidates.push(...Object.values(rec));
      }
      for (const c of candidates) {
        if (detectInstance(c)) return c as SecureExtensionLike;
      }
      // 深一层：runtime._registeredExtensions / workerExtensions 常见容器
      const deeper: unknown[] = [
        (runtime as { _registeredExtensions?: unknown })._registeredExtensions,
        (runtime as { workerExtensions?: unknown }).workerExtensions,
      ];
      for (const d of deeper) {
        if (!d) continue;
        if (d instanceof Map) {
          for (const v of d.values()) if (detectInstance(v)) return v as SecureExtensionLike;
        } else if (typeof d === 'object') {
          for (const v of Object.values(d as Record<string, unknown>)) if (detectInstance(v)) return v as SecureExtensionLike;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** 实例净化（幂等：每个实例只净化一次）。清记录 → 抓拍干净视图 → 整体净化。 */
  private patchInstance(inst: SecureExtensionLike): void {
    if (this.patchedKeys.has(inst)) return;
    this.patchedKeys.add(inst);
    try {
      // 接管前游戏积木可能已触发 _A() 写脏 _c：先清零再抓拍，避免把脏记录冻成「干净快照」
      (inst as unknown as Record<string, unknown>)._c = null;
    } catch {
      /* ignore */
    }
    captureCleanTamperViews(inst);
    sanitizeInstance(inst);
  }

  /** 探测读数字/字符串方法（方法优先，缺失回退本地 XOR） */
  private readNum(inst: SecureExtensionLike, name: string, cipher: string): number | null {
    try {
      const via = inst._getEnc?.(name);
      if (via !== undefined && via !== null) return via;
    } catch {
      /* ignore */
    }
    if (!cipher) return null;
    const dec = xorDecryptLocal(cipher, inst._key ?? '');
    if (dec === null) return null;
    const num = Number(dec);
    return Number.isNaN(num) ? null : num;
  }

  private readStr(inst: SecureExtensionLike, name: string, cipher: string): string | null {
    try {
      const via = inst._getEncStr?.(name);
      if (via !== undefined && via !== null) return via;
    } catch {
      /* ignore */
    }
    if (!cipher) return null;
    return xorDecryptLocal(cipher, inst._key ?? '');
  }

  /** 全部安全变量（数字 _a + 字符串 _q），解密为可显示值；多实例以 @i 区分 id */
  list(): ScratchVariable[] {
    const out: ScratchVariable[] = [];
    this.instances.forEach((inst, idx) => {
      const suffix = this.instances.length > 1 ? '@' + idx : '';
      try {
        const a = inst._a;
        if (a) {
          for (const name of Object.keys(a)) {
            const cipher = String(a[name] ?? '');
            const value = this.readNum(inst, name, cipher);
            out.push({
              id: SECURE_PREFIX + 'n:' + name + suffix,
              name,
              kind: 'variable',
              value: value ?? 0,
              isCloud: false,
              targetId: SECURE_PREFIX + 'n' + suffix,
              targetName: '\u5b89\u5168\u53d8\u91cf',
              isLocked: false,
            });
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const q = inst._q;
        if (q) {
          for (const name of Object.keys(q)) {
            const cipher = String(q[name] ?? '');
            const value = this.readStr(inst, name, cipher);
            out.push({
              id: SECURE_PREFIX + 's:' + name + suffix,
              name,
              kind: 'variable',
              value: value ?? '',
              isCloud: false,
              targetId: SECURE_PREFIX + 's' + suffix,
              targetName: '\u5b89\u5168\u53d8\u91cf',
              isLocked: false,
            });
          }
        }
      } catch {
        /* ignore */
      }
    });
    return out;
  }

  /** 写入安全变量（走实例自身的加密存储，保持盐一致；方法缺失时本地 XOR 兜底） */
  set(id: string, value: ScratchValue): boolean {
    if (typeof id !== 'string' || !id.startsWith(SECURE_PREFIX)) return false;
    const sep = id.indexOf(':', SECURE_PREFIX.length);
    if (sep < 0) return false;
    const kind = id.slice(SECURE_PREFIX.length, sep);
    const rest = id.slice(sep + 1);
    let name = rest;
    let inst: SecureExtensionLike | null = null;
    if (this.instances.length > 1) {
      const at = rest.lastIndexOf('@');
      if (at >= 0) {
        const idx = Number(rest.slice(at + 1));
        name = rest.slice(0, at);
        inst = this.instances[idx] ?? null;
      }
    }
    inst = inst ?? this.instances[0] ?? null;
    if (!inst || !name) return false;
    try {
      if (kind === 's') {
        if (typeof inst._setEncStr === 'function') {
          inst._setEncStr(name, String(value));
          // 回读校验：净化可能已把 _setEncStr 换成无害空函数（栈校验变体兜底误伤），
          // 空写会造成「返回成功但存储未变」的假成功 → 不匹配立即走本地 XOR 兜底
          const back = this.readStr(inst, name, String(inst._q?.[name] ?? ''));
          if (back === String(value)) return true;
        }
        const key = inst._key;
        if (!key) return false;
        const enc = xorEncryptLocal(String(value), key);
        if (enc === null || !inst._q) return false;
        inst._q[name] = enc;
        return true;
      }
      if (kind === 'n') {
        const num = typeof value === 'number' ? value : Number(value);
        if (Number.isNaN(num)) return false;
        if (typeof inst._setEnc === 'function') {
          inst._setEnc(name, num);
          const back = this.readNum(inst, name, String(inst._a?.[name] ?? ''));
          if (back === num) return true;
        }
        const key = inst._key;
        if (!key) return false;
        const enc = xorEncryptLocal(String(num), key);
        if (enc === null || !inst._a) return false;
        inst._a[name] = enc;
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** 摘要：并入变量轮询判重 */
  key(): string {
    // 数组拼接 + 一次性 join：本函数每次变量判重都会走（每 tick 一次），
    // 用 += 逐步拼接会在安全变量较多时产生大量中间字符串。
    const parts: string[] = [];
    for (const inst of this.instances) {
      try {
        const a = inst._a;
        if (a) {
          for (const n of Object.keys(a)) {
            parts.push(n, '\u0001', String(this.readNum(inst, n, String(a[n] ?? '')) ?? ''), '\u001f');
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const q = inst._q;
        if (q) {
          for (const n of Object.keys(q)) {
            parts.push(n, '\u0001', String(this.readStr(inst, n, String(q[n] ?? '')) ?? ''), '\u001f');
          }
        }
      } catch {
        /* ignore */
      }
    }
    return parts.join('');
  }

  /** 已接管实例数（调试/测试用） */
  get size(): number {
    return this.instances.length;
  }
}

/** 单例：register 拦截接管与 scratch-vm 的 init 共享同一状态 */
const frontGuard = new SecureGuard();
export function getSecureGuard(): SecureGuard {
  return frontGuard;
}

let frontInstalled = false;

/** 前置防线总装（document-start 最先调用，幂等）：
 *  ① 白名单标记 + 签名放行  ② register 拦截  ④ UI 隐藏样式清理 */
export function installSecureGuardFront(): void {
  if (frontInstalled) return;
  frontInstalled = true;
  installSecureGuardMark();
  watchScratchApi();
  installStyleWatcher();
}

// 模块加载即布防（对 @run-at document-start 的最早窗口；installSecureGuardFront 幂等重复调用无害）
installSecureGuardFront();
