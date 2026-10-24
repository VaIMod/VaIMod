/**
 * 通用扩展积木反制层（行为级分类，不限敌扩展家族）。
 *
 * 吸收两份参考实现的机制并通用化：
 *  · 「角色管理器 ProMax」的运行时机制：
 *      - 返回值篡改：包装 primitives 让检测类 reporter 恒 false
 *      - 禁止积木运行：包装后恒 undefined（销毁/跳转命令 no-op）
 *  · 「CCW 扩展源码提取器（extGet）」的全量收集思路：不依赖单一注册咽喉，
 *    直接枚举真实 VM 结构里的全部扩展实例 —— 绕开 register 咽喉的路径也接得住。
 *
 * ===== 与真实 CCW VM 结构对齐（关键修正）=====
 * 此前本层用 `runtime.extensions` 枚举实例，但平台 VM 里该字段**不存在**
 * （平台包 `runtime.extensions` 零命中），导致：
 *   ① 实例集合恒空 → 检测类/销毁类判定从不触发；
 *   ② 分类表恒空 → primitives 锁无从下手（表里没有 opcode→类别映射）
 *      → 返回值篡改与积木禁用全部落空。
 * 现改为经 ext-registry 的真实枚举面取实例与元信息：
 *   实例真身 = `runtime.ext_${id}`；元信息真身 = `runtime._blockInfo[i].blocks[].info`
 *   primitives 键 = `${extId}_${opcode}`（不再是裸 opcode）
 *
 * 分类（行为级，opcode 名无法混淆 —— sb3 内积木按名引用）：
 *  A. 检测类布尔 reporter → 恒 false：
 *     VM 泄露探测、脚本加载探测、劫持探测、篡改探测 —— 无论哪个扩展、opcode 叫什么。
 *  B. 销毁/跳转类 command → no-op：
 *     body/documentElement 清场、location 跳转、about:blank、停机死循环、
 *     opcode 语义明确为 destroy/nuke/wipe/jump/redirect/block 类。
 *
 * 判定优先级（高 → 低）：
 *  ① 平台归一化的 blockType（'Boolean' → 布尔面，'command' → 命令面）
 *  ② 已知敌扩展家族的显式 opcode 名单（YinSecurity 六积木等）
 *  ③ opcode 形态 + 积木显示文本语义
 *  ④ 实例方法源码特征（探测/销毁执行面）
 *
 * 执行面（双层保险）：
 *  1. 实例层：shadowMethod 非枚举遮蔽（opcode 即实例方法名，runtime 分发约定）
 *  2. primitives 层：runtime._primitives 包装（WeakMap 存原件）——实例层被
 *     绕过或重新赋值时仍生效。包装零额外分支：布尔恒 false / 命令恒 undefined。
 */
import { onVmTick } from './ext-watch';
import { isProjectLoading } from './load-accel';
import { enumerateExtensions, classifyBlockType, type ExtBlockInfo, type ExtEntry } from './ext-registry';
import { markFakeSource, nativeToStringOf } from '../dom-utils';

type InstLike = Record<string, unknown> & { getInfo?: () => { id?: string; blocks?: unknown[] } | undefined };

/** 已按扩展 id 记录的处置类别：bool = 恒 false，cmd = no-op
 *  ★ 按 extId 隔离（不按裸 opcode）：不同扩展可能有同名 opcode
 *    （如 A 的 jump 是命令、B 的 jump 是 reporter），全局单表会互相污染。
 *  PASSED = 判定为放行（记录下来避免每拍重复取函数源码）。 */
const PASSED = null;
const extClass = new Map<string, Map<string, 'bool' | 'cmd' | null>>();
/** 已净化过的实例（幂等，WeakSet 自动回收）——每拍枚举靠它做到近零成本 */
const sanitizedInsts = new WeakSet<object>();
/** _primitives 原件（角色管理器式 WeakMap 侧表） */
const originals = new WeakMap<object, Map<string, (...a: unknown[]) => unknown>>();

// ---------- 敌扩展家族显式名单 ----------

/**
 * YinSecurity（拦截外挂 / CheatBlockerExtension）六积木 —— 还原样本逐行分析确定：
 *   三探针（Boolean）：hasTM / hasScript / isHijacked → 恒 false
 *   三命令（command）：showDetail / jump / blockScript → no-op
 * 显式名单优先于通用规则，避免中文/英文 locale 切换导致语义规则漏判。
 */
const KNOWN_BOOL_OPCODES = new Set([
  'hasTM',
  'hasScript',
  'isHijacked',
  'hasTampermonkey',
  'isTampered',
  'whenTampered',
  'scanVMLeak',
  'getTamperInfo',
]);

const KNOWN_CMD_OPCODES = new Set([
  'showDetail',
  'jump',
  'blockScript',
  'destroyScript',
  'nukeScript',
  'removeScript',
  'wipeProject',
  'clearProject',
  'blockAllScripts',
  'stopAllScripts',
  'redirect',
  'gotoUrl',
]);

// ---------- 通用分类特征 ----------

/**
 * 检测类布尔 reporter 的 opcode 形态（has 前缀、is 前缀、check 前缀、detect 前缀、
 * scan 前缀 + 泄露探测专名）。要求首字母大写，避免命中 haskell / island 之类普通词。
 */
const BOOL_DETECT_OP =
  /^(?:has[A-Z]|is[A-Z]|check[A-Z]|detect[A-Z]|scan[A-Z]|vmLeak|leak[A-Z]|audit[A-Z]|canSee[A-Z])/;

/** 检测类积木的语义关键词（opcode / 描述 / 名称均可命中） */
const DETECT_TEXT =
  /检测|探测|扫描|泄露|劫持|外挂|作弊|违规|篡改|脚本加载|加载了|挂机|detect|tamper|leak|hijack|cheat|audit|userscript|tampermonkey/i;

/** 销毁/跳转类 command 的强语义 opcode */
const DANGEROUS_CMD_OP =
  /^(?:destroy|nuke|wipe[A-Z]|kill[A-Z]|jump[A-Z]|redirect[A-Z]|goto[A-Z]*Url|gotoUrl|block[A-Z]|ban[A-Z]|clearAll|removeAll|stripAll|haltAll|stopAllWork|removeUI)/;

/** 销毁/跳转类积木语义关键词 */
const DESTROY_TEXT =
  /销毁|摧毁|拆除|清场|清空作品|跳转|重定向|about:blank|destroy|nuke|wipe[A-Z]|jumpTo|redirect[A-Z]|removeScript|blockScript/i;

/** 函数源码级确认：VM 泄露探测面 */
const LEAK_SRC: RegExp[] = [
  /__scratchCoreRef__/,
  /__vmLeakBackup__/,
  /_vmCoreMirror_/,
  /getOwnPropertyDescriptor\([^)]*['"](?:vm|_vm)['"]/,
  /\bwindow\.vm\b/,
  /\bwindow\[['"]_?vm['"]\]/,
  /\bglobalThis\[['"]_?vm['"]\]/,
  /data-tampermonkey/i,
];

/** 函数源码级确认：销毁/跳转执行面 */
const DESTROY_SRC: RegExp[] = [
  /document\.body\.innerHTML\s*=/,
  /document\.documentElement\.innerHTML\s*=/,
  /\.body\.remove\(\)/,
  /documentElement\.remove\(\)/,
  /location(?:\.href|\.replace)\s*=?\s*['"`]about:blank/,
  /window\.top\.location\s*=/,
  /location\.href\s*=\s*['"`]https?:\/\/(?!www\.ccw\.site)/,
  /while\s*\(\s*(?:!0|true|1)\s*\)\s*\{/,
];

function fnSource(fn: unknown): string {
  try {
    return typeof fn === 'function' ? nativeToStringOf(fn as () => string) : '';
  } catch {
    return '';
  }
}

/**
 * 单块分类：返回 'bool'（恒 false）/ 'cmd'（no-op）/ null（放行）。
 *
 * @param op     积木 opcode
 * @param meta   平台归一化的积木元信息（blockType/text）
 * @param src    实例方法的真实源码（空串表示取不到）
 */
function classifyBlock(op: string, meta: ExtBlockInfo, src: string): 'bool' | 'cmd' | null {
  // ① 已知敌扩展家族名单 —— 最高优先，不受 locale 影响
  if (KNOWN_BOOL_OPCODES.has(op)) return 'bool';
  if (KNOWN_CMD_OPCODES.has(op)) return 'cmd';

  // ② 平台归一化的 blockType 决定执行面
  const cls = classifyBlockType(meta.blockType);
  const opText = `${op} ${meta.text}`;

  if (cls === 'bool') {
    if (BOOL_DETECT_OP.test(op)) return 'bool';
    if (DETECT_TEXT.test(opText)) return 'bool';
    if (LEAK_SRC.some((re) => re.test(src))) return 'bool';
    return null;
  }
  if (cls === 'cmd') {
    if (DANGEROUS_CMD_OP.test(op)) return 'cmd';
    if (DESTROY_TEXT.test(opText)) return 'cmd';
    if (DESTROY_SRC.some((re) => re.test(src))) return 'cmd';
    return null;
  }

  // ③ 元信息缺失（其他宿主 / 早期注册）→ 回退到形态 + 文本判定
  if (BOOL_DETECT_OP.test(op) || DETECT_TEXT.test(opText)) return 'bool';
  if (DANGEROUS_CMD_OP.test(op) || DESTROY_TEXT.test(opText)) return 'cmd';
  if (LEAK_SRC.some((re) => re.test(src))) return 'bool';
  if (DESTROY_SRC.some((re) => re.test(src))) return 'cmd';
  return null;
}

// ---------- primitives 层锁（角色管理器式，第二道保险） ----------

/**
 * 按真实键格式锁定单个 primitives（供 secure-guard 的家族专项钝化调用）。
 *
 * 真实键 = `${extId}_${opcode}`（平台 `_convertBlockForScratchBlocks` 生成），
 * 扩展 id 允许含不可打印字符，故必须用**精确前缀**匹配，不能靠裸 opcode 后缀猜测
 * （后缀猜测会把别的扩展的同尾 opcode 一并误伤）。
 *
 * @param extId  扩展 id（形如 `YinSecurityxɺc…`）
 * @param opcode 积木 opcode
 */
export function lockExtensionPrimitive(
  vm: object,
  extId: string,
  opcode: string,
  cls: 'bool' | 'cmd',
): void {
  try {
    lockPrimitives(vm, extId, opcode, cls);
  } catch {
    /* ignore */
  }
}

/**
 * 按真实键格式锁定 primitives。
 *
 * @param prefix  扩展 id（形如 `YinSecurityxɺc…`）
 * @param opcode  积木 opcode
 */
function lockPrimitives(vm: object, prefix: string, opcode: string, cls: 'bool' | 'cmd'): void {
  const runtime = (vm as { runtime?: { _primitives?: Record<string, unknown> } }).runtime;
  const prims = runtime?._primitives;
  if (!prims || typeof prims !== 'object') return;
  const key = `${prefix}_${opcode}`;
  let origMap = originals.get(prims);
  if (!origMap) {
    origMap = new Map();
    originals.set(prims, origMap);
  }
  // 已锁过 → 早退（每拍对上千个键重复调用，此处是主要成本，必须 O(1) 短路）
  if (origMap.has(key)) return;
  const orig = prims[key];
  if (typeof orig !== 'function') return;
  origMap.set(key, orig as (...a: unknown[]) => unknown);
  const wrapped =
    cls === 'bool'
      ? function (): false {
          return false;
        }
      : function (): undefined {
          return undefined;
        };
  try {
    // toString 伪装：返回原件源码（YinSecurity 实测探测 primitives 函数源码）
    const origSrc = nativeToStringOf(orig as () => string);
    markFakeSource(wrapped, origSrc);
    // 原生外观（避免 toString 里出现非原生形态被判定为注入）
    Object.defineProperty(wrapped, 'name', { value: opcode, configurable: true });
  } catch {
    /* ignore */
  }
  try {
    prims[key] = wrapped;
  } catch {
    /* ignore */
  }
}

// ---------- 实例层净化 ----------

const returnFalse = (): false => false;
const returnUndefined = (): undefined => undefined;

function shadowMethod(inst: object, key: string, fn: unknown): void {
  try {
    Object.defineProperty(inst, key, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    try {
      (inst as Record<string, unknown>)[key] = fn;
    } catch {
      /* ignore */
    }
  }
}

function methodKeys(obj: object): string[] {
  const keys = new Set<string>(Object.keys(obj));
  try {
    let proto: object | null = Object.getPrototypeOf(obj) as object | null;
    let guard = 0;
    while (proto && proto !== Object.prototype && guard++ < 3) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (d && typeof d.value === 'function') keys.add(k);
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  } catch {
    /* ignore */
  }
  return [...keys];
}

/**
 * 实例层净化：按平台元信息分类逐个遮蔽（幂等）。返回处置块数。
 *
 * 幂等标记无条件落 WeakSet（即便本次 0 命中）——
 * 否则良性扩展每拍都要重跑「全方法源码扫描」（最贵的一步），
 * 实测 30 扩展 × 20 积木规模下单拍 0.20ms；无条件标记后降到 0.04ms 量级。
 * 晚注册的敌扩展是新实例对象，天然不在这张表里，不会被误跳过。
 *
 * @param inst    扩展实例
 * @param blocks  平台元信息（runtime._blockInfo[i].blocks[].info）
 */
export function neutralizeInstance(inst: InstLike, blocks?: ExtBlockInfo[]): number {
  if (!inst || typeof inst !== 'object') return 0;
  if (sanitizedInsts.has(inst)) return 0;
  sanitizedInsts.add(inst);
  let meta: ExtBlockInfo[] | undefined = blocks;
  if (!meta || !meta.length) {
    // 无平台元信息时回退到实例自报的 getInfo().blocks
    try {
      const raw = inst.getInfo?.()?.blocks;
      if (Array.isArray(raw)) {
        meta = [];
        for (const b of raw) {
          if (!b || typeof b !== 'object') continue;
          const o = (b as { opcode?: unknown }).opcode;
          if (typeof o !== 'string' || !o) continue;
          const bt = (b as { blockType?: unknown }).blockType;
          const tx = (b as { text?: unknown }).text;
          meta.push({
            opcode: o,
            blockType: typeof bt === 'string' ? bt : '',
            text: typeof tx === 'string' ? tx : '',
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  let hit = 0;
  if (meta && meta.length) {
    for (const b of meta) {
      const op = b.opcode;
      const src = fnSource(inst[op]);
      const cls = classifyBlock(op, b, src);
      if (!cls) continue;
      shadowMethod(inst, op, cls === 'bool' ? returnFalse : returnUndefined);
      hit++;
    }
  }
  // 源码驱动兜底（元信息缺失/改名/手工注册的实例）——
  // 方法体里有真实探测/销毁执行面就处置，与元信息无关。
  for (const k of methodKeys(inst)) {
    if (k === 'getInfo' || typeof inst[k] !== 'function') continue;
    if (inst[k] === returnFalse || inst[k] === returnUndefined) continue;
    const src = fnSource(inst[k]);
    const leak = LEAK_SRC.some((re) => re.test(src));
    const destr = DESTROY_SRC.some((re) => re.test(src));
    if (!leak && !destr) continue;
    // 已有元信息判定优先，避免与上面的结论冲突
    if (meta && meta.some((b) => b.opcode === k)) continue;
    const cls = leak && !destr ? 'bool' : 'cmd';
    shadowMethod(inst, k, cls === 'bool' ? returnFalse : returnUndefined);
    hit++;
  }
  return hit;
}

/**
 * 计算并记录某个扩展的 opcode → 处置类别映射（按 extId 隔离）。
 * 与 neutralizeInstance 分开：前者管实例层，后者管 primitives 层，
 * 两者的幂等条件不同（实例层一次性，primitives 层每拍都要复查）。
 *
 * 增量：已分类过的积木直接跳过（fnSource 取源码是本函数最贵的一步）。
 * ★ 关键：判定为「放行」的积木也要记入（值为 null）——
 *   否则未命中的积木每拍都要重取一次函数源码，
 *   实测 60 扩展 × 30 积木规模下单拍 0.52ms（占 2s 周期 0.026%）。
 */
function classifyExtension(extId: string, inst: InstLike, blocks: ExtBlockInfo[]): Map<string, 'bool' | 'cmd' | null> {
  let table = extClass.get(extId);
  if (!table) {
    table = new Map();
    extClass.set(extId, table);
  }
  // 增量：只处理尚未判定过的积木
  const fresh: ExtBlockInfo[] = [];
  for (const b of blocks) {
    if (!table.has(b.opcode)) fresh.push(b);
  }
  if (fresh.length === 0 && table.size > 0) return table;
  for (const b of fresh) {
    const src = fnSource(inst[b.opcode]);
    const cls = classifyBlock(b.opcode, b, src);
    // 放行也记录（null）→ 避免每拍重复取源码
    table.set(b.opcode, cls ?? PASSED);
  }
  // 元信息缺失时的源码兜底（与 neutralizeInstance 同源规则）
  if (blocks.length === 0) {
    for (const k of methodKeys(inst)) {
      if (k === 'getInfo' || typeof inst[k] !== 'function') continue;
      if (table.has(k)) continue;
      const src = fnSource(inst[k]);
      const leak = LEAK_SRC.some((re) => re.test(src));
      const destr = DESTROY_SRC.some((re) => re.test(src));
      table.set(k, leak && !destr ? 'bool' : 'cmd');
    }
  }
  return table;
}

// ---------- 主枚举 + 净化 ----------

/** 已完成首轮全量枚举的 runtime（首轮最重：要对每个扩展方法做源码分类） */
const enumeratedOnce = new WeakSet<object>();

/**
 * extGet 式全量枚举 + 净化 + primitives 锁（onVmTick 每拍调用）。
 *
 * 每拍重扫：晚注册的扩展也能接住；已净化实例由 sanitizedInsts 幂等短路，
 * 重复拍的成本只是遍历扩展表本身。
 * 首轮枚举在作品加载期推迟（反序列化优先），下一拍补上。
 */
export function sanitizeRuntime(vm: object): void {
  try {
    const entries = enumerateExtensions(vm);
    for (const e of entries) {
      const inst = e.instance as InstLike | undefined;
      if (!inst || typeof inst !== 'object') continue;
      try {
        // 实例层：一次性（WeakSet 幂等）
        neutralizeInstance(inst, e.blocks);
        // 分类表：按 extId 隔离，每拍增量补齐（晚注册的积木也能进表）
        const table = classifyExtension(e.id, inst, e.blocks);
        if (table.size === 0) continue;
        // primitives 层锁：按真实键 `${extId}_${opcode}`，每拍复查
        // （扩展的 primitives 可能晚于实例注册 → 锁必须每拍可重入）
        for (const [opcode, cls] of table) {
          if (!cls) continue; // 放行项（null）不锁
          lockPrimitives(vm, e.id, opcode, cls);
        }
      } catch {
        /* ignore */
      }
    }
    if (!enumeratedOnce.has(vm)) {
      enumeratedOnce.add(vm);
      analyzeExtensionSources(vm, entries);
    }
  } catch {
    /* ignore */
  }
}

let installed = false;
/** front 安装：注册 vm 巡检（幂等） */
export function installExtSanitize(): void {
  if (installed) return;
  installed = true;
  onVmTick((vm) => sanitizeRuntime(vm));
}

// ---------- 源码级分析（拉取全部自定义扩展源码） ----------

/** 从扩展源码里取扩展 id（getInfo 里的 id 字段） */
function extractExtId(src: string): string | null {
  const m = /id\s*:\s*['"]([^'"]{1,64})['"]/.exec(src);
  return m ? m[1] : null;
}

/**
 * 禁用整个扩展的积木：布尔恒 false、命令恒 undefined（禁止扩展积木）。
 *
 * 实例层遮蔽 + primitives 层锁同步执行 —— 只遮实例会被实例层绕过，
 * 只锁 primitives 则实例自报方法仍可被探测。
 */
export function disableExtensionBlocks(vm: object, extId: string, inst: InstLike, blocks?: ExtBlockInfo[]): number {
  if (!inst || typeof inst !== 'object') return 0;
  let meta: ExtBlockInfo[] | undefined = blocks;
  if (!meta || !meta.length) {
    try {
      const raw = inst.getInfo?.()?.blocks;
      if (Array.isArray(raw)) {
        meta = [];
        for (const b of raw) {
          if (!b || typeof b !== 'object') continue;
          const o = (b as { opcode?: unknown }).opcode;
          if (typeof o !== 'string' || !o) continue;
          const bt = (b as { blockType?: unknown }).blockType;
          const tx = (b as { text?: unknown }).text;
          meta.push({
            opcode: o,
            blockType: typeof bt === 'string' ? bt : '',
            text: typeof tx === 'string' ? tx : '',
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!meta || !meta.length) return 0;
  let table = extClass.get(extId);
  if (!table) {
    table = new Map();
    extClass.set(extId, table);
  }
  let n = 0;
  for (const b of meta) {
    const op = b.opcode;
    const cls = classifyBlockType(b.blockType) === 'cmd' ? 'cmd' : 'bool';
    shadowMethod(inst, op, cls === 'bool' ? returnFalse : returnUndefined);
    table.set(op, cls);
    lockPrimitives(vm, extId, op, cls);
    n++;
  }
  sanitizedInsts.add(inst);
  return n;
}

/**
 * 拉取所有自定义扩展的源码并分析（extGet 的收集思路落到反制侧）：
 *   来源：extensionManager._customExtensionInfo / _officialExtensionInfo
 *         （普通对象，值里带 url 与 Extension 类）、
 *         extensionManager._gandiExternalExtensionServices（数组）。
 *   命中检测/摧毁/跳转特征 → 从源码取扩展 id 匹配到实例 →
 *   禁用该扩展全部积木（禁止扩展积木）并让检测类返回值恒 false。
 * 拉取失败（跨域/CSP/离线）不影响主路径：实例方法源码分析已在 neutralizeInstance 覆盖。
 */
async function analyzeExtensionSources(vm: object, entries: ExtEntry[]): Promise<void> {
  if (isProjectLoading()) return;
  const em = (vm as { extensionManager?: Record<string, unknown> }).extensionManager;
  if (!em || typeof em !== 'object') return;
  const targets: { id?: string; url: string }[] = [];
  const pushTarget = (id: unknown, url: unknown): void => {
    if (typeof url !== 'string' || !url) return;
    if (!/^https?:/i.test(url)) return;
    targets.push({ id: typeof id === 'string' ? id : undefined, url });
  };
  for (const key of ['_customExtensionInfo', '_officialExtensionInfo'] as const) {
    const m = em[key];
    if (!m || typeof m !== 'object') continue;
    const list = m instanceof Map ? [...m.values()] : Object.values(m as Record<string, unknown>);
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { id?: unknown; url?: unknown; info?: { extensionId?: unknown } };
      pushTarget(e.info?.extensionId ?? e.id, e.url);
      if (targets.length >= 12) break;
    }
    if (targets.length >= 12) break;
  }
  const svc = em._gandiExternalExtensionServices;
  if (Array.isArray(svc) && targets.length < 12) {
    for (const s of svc) {
      if (!s || typeof s !== 'object') continue;
      const e = s as { id?: unknown; extensionId?: unknown; url?: unknown };
      pushTarget(e.extensionId ?? e.id, e.url);
      if (targets.length >= 12) break;
    }
  }
  if (targets.length === 0) return;

  for (const t of targets) {
    let text = '';
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : 0;
      const resp = await fetch(t.url, ctrl ? { credentials: 'omit', signal: ctrl.signal } : { credentials: 'omit' });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      text = await resp.text();
    } catch {
      continue;
    }
    if (!text) continue;
    const leak = LEAK_SRC.some((re) => re.test(text));
    const destr = DESTROY_SRC.some((re) => re.test(text));
    if (!leak && !destr) continue;
    const srcId = extractExtId(text) ?? t.id;
    if (!srcId) continue;
    for (const e of entries) {
      if (e.id !== srcId) continue;
      const inst = e.instance as InstLike | undefined;
      if (!inst || typeof inst !== 'object') continue;
      try {
        if (destr) {
          // 含摧毁/跳转代码 → 整个扩展的积木禁运行
          disableExtensionBlocks(vm, e.id, inst, e.blocks);
        } else {
          // 仅检测面 → 检测类返回值恒 false
          neutralizeInstance(inst, e.blocks);
        }
      } catch {
        /* ignore */
      }
    }
  }
}
