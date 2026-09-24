import { hookExtensionManager, onVmTick, trackVm } from './ext-watch';

// ===== 数字签名扩展反制（ScratchSign / digSig 族） =====
//
// 敌样本：`数字签名.js`（Scratch 扩展，id="digSig"，ECDSA P-256 签名 / RC4 加解密 /
// IndexedDB 密钥库 ScratchKeyStore_<fnv16> / 项目哈希校验）。它本身是正经的加密工具，
// 但内置了一整套「反修改器」机制，会在 ccw.site 上主动破坏变量修改器：
//
//   ① loadProject tamper 检测（_checkEnv）
//       沿 vm 原型链向上找 loadProject 的原始实现 e；随后判定
//         - Object.prototype.hasOwnProperty.call(vm, 'loadProject')  → tampered
//         - vm.loadProject !== e                                       → tampered
//       任何「在实例上挂/换 loadProject」的修改器都会被抓到。
//   ② 死循环停机（_halt）
//       f && usable && tampered 时 → runtime.stopAll() + while(true){}。
//       整个标签页主线程被占死，页面直接卡死（不是抛错，是冻结）。
//   ③ UI 隐藏（_mask）
//       注入 <style id="ui-base"> 把 h[] 里的选择器全部 display:none!important，
//       含 #scratch-variable-panel / button[title="打开变量修改器"] 等修改器 UI。
//   ④ 变量名清空（_onProjectLoaded）
//       非 gandi/creator 域名（即 ccw.site）下，遍历 runtime.targets，把
//       type === '' || type === 'list' 的变量 d.name 清成空串 —— 变量修改器
//       列表直接变一片空白。
//
// 反制分层（2026-09-13 重构）：
//   ① 实例净化（主防线）：register / extensionManager 双咽喉在敌扩展第一次运行前
//      接管实例 —— _checkEnv/_enforce 恒答「不可用」，_halt/_mask 无害化，
//      `f && usable && tampered` 永不成立，死循环从源头断掉。
//      ⚠️ 不再对 vm.loadProject 做实例级「getter 伪装 + 拒绝写入」：VaIMod 从不
//      在实例上写 loadProject，敌检测天然通过；而那层伪装会静默吞掉游戏/站点
//      后续对 vm.loadProject 的合法赋值（Cave 等自带关卡加载器的游戏因此无法运行）。
//   ② 覆盖面补漏：window.Scratch.register 之外，extensionManager 的注册/加载方法
//      也被包住（项目内嵌扩展不经过 register）；每 2s 常驻扫描 + PROJECT_LOADED
//      事件重扫，晚注册的敌扩展同样在首次执行前被接管。
//   ③ UI 隐藏免疫：'ui-base' 隐藏样式注入即清除，inline display:none 逐条撤销。
//   ④ 变量名清空免疫：变量表条目铺 name 访问器，拒绝「写入空串」（连接时 +
//      PROJECT_LOADED 后 + 每 2s 巡检补扫，覆盖晚加载/晚创建的目标）。

const SIGN_EXT_ID = 'digSig';
const SIGN_EXT_NAME = '\u6570\u5b57\u52a0\u5bc6';

// _mask 注入的 style 节点 id（清理器据此识别并移除）
const MASK_STYLE_ID = 'ui-base';

/** 敌扩展的积木 opcode 特征（判定注册对象身份用） */
const SIGN_OPCODES = [
  'generateKeyPair', 'getPrivateKey', 'getPublicKey', 'signData', 'verifyData',
  'encryptData', 'decryptData', 'hashProject', 'getProjectHash',
];

interface SignExtLike {
  _vm?: unknown;
  runtime?: unknown;
  _halted?: boolean;
  _checkEnv?: () => { usable: boolean; tampered: boolean };
  _enforce?: () => unknown;
  _halt?: () => void;
  _mask?: () => void;
  _onProjectLoaded?: () => void;
  _resolveVM?: () => unknown;
  getInfo?: () => { id?: string; name?: string; blocks?: { opcode?: string }[] };
  [key: string]: unknown;
}

// ---------- 识别 ----------
function detectSignInstance(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as SignExtLike;
  const keys = Object.keys(o);
  let score = 0;
  // 方法名特征：这套命名（下划线 + 语义名）是敌样本的稳定指纹，
  // 即便混淆改名算法细节，控制流方法名几乎不会动
  if (keys.includes('_checkEnv')) score += 2;
  if (keys.includes('_enforce')) score += 2;
  if (keys.includes('_halt')) score += 2;
  if (keys.includes('_mask')) score += 1;
  if (keys.includes('_onProjectLoaded')) score += 1;
  if (keys.includes('_resolveVM')) score += 1;
  // 兜底：函数体里出现死循环 + stopAll 的组合
  for (const k of keys) {
    const fn = o[k];
    if (typeof fn !== 'function') continue;
    const src = String(fn);
    if (src.includes('stopAll') && /while\s*\(\s*(!0|true|1)\s*\)/.test(src)) score += 3;
  }
  if (score >= 3) return true;
  try {
    const info = o.getInfo?.();
    if (info?.id === SIGN_EXT_ID) return true;
    if (info?.name === SIGN_EXT_NAME) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function detectSignDescriptor(d: unknown): boolean {
  const desc = d as { id?: string; name?: string; blocks?: { opcode?: string }[] };
  if (!desc || typeof desc !== 'object') return false;
  if (desc.id === SIGN_EXT_ID || desc.name === SIGN_EXT_NAME) return true;
  const blocks = desc.blocks;
  if (!Array.isArray(blocks)) return false;
  let hit = 0;
  for (const b of blocks) {
    if (b && typeof b.opcode === 'string' && SIGN_OPCODES.includes(b.opcode)) hit++;
  }
  return hit >= 3;
}

// ---------- 实例净化 ----------
function sanitizeSignInstance(inst: SignExtLike): void {
  try {
    // _checkEnv 恒答「不可用」：_enforce 的 `f && usable && tampered` 永不成立，
    // _halt 从源头断掉（这是最干净的一层，优先）
    inst._checkEnv = () => ({ usable: false, tampered: false });
    // _enforce 直接返回上面的结果（不再进入 _halt 分支）
    inst._enforce = () => ({ usable: false, tampered: false });
    // _halt 兜底：即使被别的路径调到也没有副作用
    inst._halt = () => {};
    // _mask 兜底：不让它再注入隐藏样式（清理器仍在，双保险）
    inst._mask = () => {};
    // _onProjectLoaded：保留（它自身只做分析，不破坏数据），但要拦掉清空变量名
    // 的分支 —— 该分支直接写 d.name = ''，无法在实例层拦，改由变量表代理层处理。
    // _halted 复位：若此前已被置真，会导致后续 _halt 早返（无害），保持一致即可。
    void inst._halted;
  } catch {
    /* ignore */
  }
}

// ---------- UI 隐藏免疫 ----------
let maskWatchInstalled = false;

/** _mask 会写 inline 隐藏的修改器 UI 元素 id（均为纯 id 选择器，可用哈希查找） */
const MASK_TARGET_IDS = ['scratch-variable-panel', 'spd-open', 'spd-toolbar'];

/** 移除 _mask 注入的 <style id="ui-base">，并撤销其对修改器 UI 的 inline 隐藏 */
function purgeMaskStyle(): void {
  if (typeof document === 'undefined') return;
  try {
    const st = document.getElementById(MASK_STYLE_ID);
    if (st && st.tagName === 'STYLE') {
      const text = st.textContent || '';
      // 只清理「确实是隐藏样式」的节点，避免误删同 id 的站点正常样式
      if (text.includes('display') && (text.includes('none') || text.includes('important'))) {
        st.remove();
      }
    }
  } catch {
    /* ignore */
  }
  // _mask 第二段会给命中元素写 inline display:none!important —— 逐条撤销。
  // 用 getElementById 而非 querySelectorAll：三个目标都是纯 id 选择器，
  // 哈希查找 O(1)，避免每次 DOM 变更都做 3 次全文档选择器匹配。
  // 只认 !important 与 secure-guard 对齐：普通 inline display:none 是站点/第三方
  // 修改器自己的正常折叠，撤销它会形成「藏-显」拉锯（本函数挂在全文档 style 变更上）。
  try {
    for (const id of MASK_TARGET_IDS) {
      const e = document.getElementById(id) as HTMLElement | null;
      if (!e) continue;
      revertImportantHide(e);
      // honeypot 会植入同 id 的隐形诱饵（data-role=placeholder）：撞上时 getElementById
      // 返回的可能是诱饵，真元素就被漏掉 → 退回全量同名扫描（仅此分支付这个代价）。
      if (e.getAttribute('data-role') !== 'placeholder') continue;
      for (const same of Array.from(document.querySelectorAll(`[id="${id}"]`))) {
        revertImportantHide(same as HTMLElement);
      }
    }
  } catch {
    /* ignore */
  }
}

/** 只撤销「display:none + !important」这一种（站点自己的普通折叠不动） */
function revertImportantHide(e: HTMLElement): void {
  try {
    const s = e.style;
    if (s.getPropertyValue('display') === 'none' && s.getPropertyPriority('display') === 'important') {
      s.removeProperty('display');
    }
  } catch {
    /* ignore */
  }
}

// 清理合帧：_mask 注入属罕见事件，但观察者挂在全文档 attributes:style 上，
// Scratch 拖积木/监视器会持续写 inline style → 每批变更都跑一次全量清理代价可观。
// 合并到 50ms 窗口执行一次，清理语义不变（UI 隐藏被纠正的延迟用户不可感知）。
let purgeScheduled = false;
function schedulePurgeMaskStyle(): void {
  if (purgeScheduled) return;
  purgeScheduled = true;
  const run = (): void => {
    purgeScheduled = false;
    purgeMaskStyle();
  };
  try {
    setTimeout(run, 50);
  } catch {
    run();
  }
}

function installMaskWatcher(): void {
  if (maskWatchInstalled) return;
  maskWatchInstalled = true;
  // 非浏览器环境（单测 / SSR）无 document：跳过，其余层照常布防
  if (typeof document === 'undefined') return;
  const start = (): void => {
    purgeMaskStyle();
    try {
      if (typeof MutationObserver !== 'function') return;
      const mo = new MutationObserver(() => schedulePurgeMaskStyle());
      mo.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    } catch {
      /* ignore */
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

// ---------- 变量名清空免疫 ----------
// _onProjectLoaded 的致命操作是直接把 variables[i].name 写成 ''。
// 变量表本身是普通对象，无法预知哪个 target 会被改；因此在 vm 连接后，
// 给每个 target.variables 里的条目铺 name 访问器：记录原名，拒绝「写入空串」。
const guardedNames = new WeakMap<object, string>();

function guardVariableNames(vm: object): void {
  try {
    const runtime = (vm as { runtime?: { targets?: unknown[] } }).runtime;
    const targets = runtime?.targets;
    if (!Array.isArray(targets)) return;
    for (const t of targets) {
      const vars = (t as { variables?: unknown })?.variables;
      if (!vars || typeof vars !== 'object') continue;
      // 变量表两种形态都要盖到：普通对象（真实 VM 的 target.variables）与
      // Map（部分宿主直接用 Map 存，本仓库验证用假 vm 也是 Map）
      const entries: unknown[] =
        vars instanceof Map
          ? Array.from((vars as Map<string, unknown>).values())
          : Object.values(vars as Record<string, unknown>);
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as { name?: unknown };
        if (typeof entry.name !== 'string') continue;
        const obj = entry as object;
        if (guardedNames.has(obj)) continue;
        const orig = entry.name;
        guardedNames.set(obj, orig);
        try {
          Object.defineProperty(obj, 'name', {
            configurable: true,
            enumerable: true,
            get: () => guardedNames.get(obj) ?? orig,
            set: (v: unknown) => {
              // 拒绝被清空：空串且原名非空 → 静默忽略（保留原名）
              if (typeof v === 'string' && v === '' && (guardedNames.get(obj) ?? '') !== '') {
                return;
              }
              guardedNames.set(obj, typeof v === 'string' ? v : String(v));
            },
          });
        } catch {
          /* 属性不可重定义时跳过该条目 */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// ---------- 接线 ----------
class SigGuard {
  private adopted: SignExtLike[] = [];
  private patched = new WeakSet<object>();
  private projectHooked = new WeakSet<object>();
  private tickInstalled = false;

  /** 是否已识别到数字签名扩展（供调试/UI 提示） */
  get detected(): boolean {
    return this.adopted.length > 0;
  }

  /** register 前置拦截接管（幂等） */
  adopt(inst: unknown): boolean {
    if (!inst || typeof inst !== 'object') return false;
    if (this.adopted.includes(inst as SignExtLike)) return false;
    this.adopted.push(inst as SignExtLike);
    this.patch(inst as SignExtLike);
    return true;
  }

  private patch(inst: SignExtLike): void {
    if (this.patched.has(inst)) return;
    this.patched.add(inst);
    sanitizeSignInstance(inst);
  }

  /** 重扫 vm 上的扩展容器，接管新出现的敌实例（幂等， adopt 去重） */
  private rescan(vm: object): void {
    const found = this.find(vm);
    if (found) this.adopt(found);
  }

  /** PROJECT_LOADED 事件：项目（可能内嵌敌扩展）加载完成后立即重扫 + 变量名补扫 */
  private watchProjectLoaded(vm: object): void {
    if (this.projectHooked.has(vm)) return;
    this.projectHooked.add(vm);
    try {
      (vm as { on?: (event: string, cb: () => void) => void }).on?.('PROJECT_LOADED', () => {
        this.rescan(vm);
        guardVariableNames(vm);
        for (const delay of [200, 800, 2000]) {
          setTimeout(() => {
            try {
              this.rescan(vm);
              guardVariableNames(vm);
            } catch {
              /* ignore */
            }
          }, delay);
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** vm 就绪后：接管已有实例 + 全通道补漏 + 保护变量名 */
  init(vm: unknown): void {
    if (!vm || typeof vm !== 'object') return;
    const v = vm as object;
    this.rescan(v);
    trackVm(v); // 常驻扫描池
    hookExtensionManager(v, () => this.rescan(v)); // extensionManager 注册咽喉
    this.watchProjectLoaded(v); // 项目加载事件补扫
    guardVariableNames(v);
    // 变量表可能随项目切换重建，做几次延迟补扫（成本极低，幂等）
    for (const delay of [200, 800, 2000]) {
      setTimeout(() => {
        try {
          this.rescan(v);
          guardVariableNames(v);
        } catch {
          /* ignore */
        }
      }, delay);
    }
    this.ensureTick();
  }

  /** 每 2s 巡检：晚注册的敌扩展 / 晚建的目标变量表也在覆盖范围内 */
  private ensureTick(): void {
    if (this.tickInstalled) return;
    this.tickInstalled = true;
    onVmTick((vm) => {
      hookExtensionManager(vm, () => this.rescan(vm));
      this.rescan(vm);
      guardVariableNames(vm);
    });
  }

  /** vm 上直接查找数字签名扩展实例 */
  find(vm: unknown): SignExtLike | null {
    try {
      const runtime = (vm as { runtime?: { extensions?: unknown } })?.runtime;
      const extensions = (runtime as { extensions?: unknown })?.extensions;
      if (!extensions) return null;
      const candidates: unknown[] = [];
      if (extensions instanceof Map) {
        const direct = extensions.get(SIGN_EXT_ID);
        if (direct) return direct as SignExtLike;
        candidates.push(...extensions.values());
      } else if (typeof extensions === 'object') {
        const rec = extensions as Record<string, unknown>;
        const direct = rec[SIGN_EXT_ID];
        if (direct) return direct as SignExtLike;
        candidates.push(...Object.values(rec));
      }
      for (const c of candidates) if (detectSignInstance(c)) return c as SignExtLike;
    } catch {
      /* ignore */
    }
    return null;
  }
}

const sigGuard = new SigGuard();
export function getSigGuard(): SigGuard {
  return sigGuard;
}

// ---------- register 拦截 ----------
function hookSignRegister(extApi: { register: (...args: unknown[]) => unknown }): void {
  try {
    if ((extApi.register as { __vaimodSigHooked?: boolean }).__vaimodSigHooked) return;
    const orig = extApi.register.bind(extApi);
    const wrapped = (...args: unknown[]) => {
      try {
        for (const arg of args) {
          if (!arg || typeof arg !== 'object') continue;
          const obj = arg as SignExtLike;
          if (detectSignInstance(obj)) {
            sigGuard.adopt(obj);
          } else if (typeof obj.getInfo === 'function') {
            try {
              if (detectSignDescriptor(obj.getInfo())) sigGuard.adopt(obj);
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
    Object.defineProperty(wrapped, '__vaimodSigHooked', { value: true });
    extApi.register = wrapped;
  } catch {
    /* ignore */
  }
}

function watchSignApi(): void {
  let attempts = 0;
  let scratchSlot: unknown;
  const tryHook = (): void => {
    try {
      if (!scratchSlot || typeof scratchSlot !== 'object') return;
      const ext = (scratchSlot as { extensions?: { register: (...a: unknown[]) => unknown } })
        .extensions;
      if (ext && typeof ext.register === 'function') hookSignRegister(ext);
    } catch {
      /* ignore */
    }
  };
  const tick = (): void => {
    attempts++;
    try {
      const win = globalThis as unknown as { Scratch?: unknown };
      if (win.Scratch) {
        scratchSlot = win.Scratch;
        tryHook();
        return;
      }
    } catch {
      /* ignore */
    }
    if (attempts < 60) setTimeout(tick, 400);
  };
  try {
    const win = globalThis as unknown as Record<string, unknown>;
    const existing = win.Scratch;
    if (existing) {
      scratchSlot = existing;
      tick();
      return;
    }
    // 与 secure-guard 共用同一个 Scratch 捕获点：若已被 secure-guard 改成访问器，
    // 这里读到的 getter 会返回当前槽位；再包一层 setter 会互相覆盖，
    // 因此仅在「尚未被包装」时接管。
    const desc = Object.getOwnPropertyDescriptor(win, 'Scratch');
    if (!desc || (!desc.get && !desc.set)) {
      Object.defineProperty(win, 'Scratch', {
        configurable: true,
        enumerable: true,
        get: () => scratchSlot,
        set: (v: unknown) => {
          scratchSlot = v;
          tryHook();
        },
      });
    } else {
      // 已被 secure-guard 接管：借其 getter 轮询捕获
      const poll = setInterval(() => {
        try {
          const s = win.Scratch;
          if (s) {
            scratchSlot = s;
            tryHook();
            clearInterval(poll);
          }
        } catch {
          /* ignore */
        }
      }, 400);
      setTimeout(() => clearInterval(poll), 25_000);
    }
  } catch {
    /* ignore */
  }
  tick();
}

let signInstalled = false;

/**
 * 数字签名反制总装（document-start 调用，幂等）。
 * 与 secure-guard 一致：模块加载即布防，installSecureGuardFront 后再调用一次也无害。
 */
export function installSigGuardFront(): void {
  if (signInstalled) return;
  signInstalled = true;
  installMaskWatcher(); // UI 隐藏免疫
  watchSignApi(); // register 拦截
}

// 模块加载即布防（最早窗口）
installSigGuardFront();
