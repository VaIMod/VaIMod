/**
 * 通用扩展积木反制层（行为级分类，不限敌扩展家族）。
 *
 * 吸收两份参考实现的机制并通用化：
 *  · 「角色管理器 ProMax」的运行时机制：
 *      - 返回值篡改（applyRtToOpcode 式）：包装 _primitives[opcode] 固定返回值
 *      - 禁止积木运行（EXTENSION_INTERCEPT_LOCKED 式）：包装后恒 undefined
 *  · 「CCW 扩展源码提取器（extGet）」的全量收集思路：不依赖注册咽喉，
 *    直接枚举 runtime.extensions / extensionManager._loadedExtensions /
 *    _customExtensionInfo / _officialExtensionInfo / _gandiExternalExtensionServices
 *    里出现过的全部自定义扩展实例 —— 绕开 register 咽喉的路径也接得住。
 *
 * 分类（行为级，opcode 名无法混淆——sb3 内积木按名引用）：
 *  A. 检测类布尔 reporter → 恒 false：
 *     VM 泄露探测（window.vm / __scratchCoreRef__ / __vmLeakBackup__ / gopd(win,'vm')…）、
 *     脚本加载探测（data-tampermonkey / document.scripts / performance resource 扫描…）、
 *     劫持探测、篡改探测 —— 无论哪个扩展、opcode 叫什么。
 *  B. 销毁/跳转类 command → no-op：
 *     body/documentElement 清场、location 跳转、about:blank、while(true) 停机、
 *     opcode 语义明确为 destroy/nuke/wipe/jump/redirect/block 类。
 *
 * 两层执行面（双层保险）：
 *  1. 实例层：shadowMethod 非枚举遮蔽（opcode 即实例方法名，runtime 分发约定）
 *  2. primitives 层：runtime._primitives 包装（WeakMap 存原件）——实例层被
 *     绕过或重新赋值时仍生效。包装零额外分支：布尔恒 false / 命令恒 undefined。
 */
import { onVmTick } from './ext-watch';
import { isProjectLoading } from './load-accel';

type BlockLike = { opcode?: unknown; blockType?: unknown };
type InfoLike = { id?: string; blocks?: BlockLike[] };
type InstLike = Record<string, unknown> & { getInfo?: () => InfoLike | undefined };

/** 已按 opcode 记录的处置类别（primitives 层用）：bool = 恒 false，cmd = no-op */
const opClass = new Map<string, 'bool' | 'cmd'>();
/** 已净化过的实例（幂等，WeakSet 自动回收）——每拍枚举靠它做到近零成本 */
const sanitizedInsts = new WeakSet<object>();
/** _primitives 原件（角色管理器式 WeakMap 侧表） */
const originals = new WeakMap<object, Map<string, (...a: unknown[]) => unknown>>();

// ---------- 分类特征 ----------

/**
 * 检测类布尔 reporter 的 opcode 形态（has 前缀、is 前缀、check 前缀、detect 前缀、
 * scan 前缀 + 泄露探测专名）
 */
const BOOL_DETECT_OP =
  /^(?:has[A-Z]|is[A-Z]|check[A-Z]|detect[A-Z]|scan[A-Z]|vmLeak|leak[A-Z]|audit[A-Z]|canSee[A-Z])/i;

/** 检测类积木的语义关键词（opcode / 描述 / 名称均可命中） */
const DETECT_TEXT =
  /检测|探测|扫描|泄露|劫持|外挂|作弊|违规|篡改|脚本加载|加载了|挂机|detect|tamper|leak|hijack|cheat|audit|userscript|tampermonkey|userscript/i;

/** 销毁/跳转类 command 的强语义 opcode */
const DANGEROUS_CMD_OP =
  /^(?:destroy|nuke|wipe|kill[A-Z]|jump[A-Z]|redirect[A-Z]|goto[A-Z]*Url|gotoUrl|block[A-Z]|ban[A-Z]|clearAll|removeAll|stripAll|haltAll|stopAllWork)/i;

/** 销毁/跳转类积木语义关键词 */
const DESTROY_TEXT =
  /销毁|摧毁|拆除|清场|清空作品|跳转|重定向|about:blank| destroy |nuke|wipe[A-Z]|jumpTo|redirect[A-Z]|about:blank/i;

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
  /getEntriesByType\(\s*['"]resource['"]/,
  /document\.scripts/,
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
    return String(fn);
  } catch {
    return '';
  }
}

/** blocks 元信息里该积木是否布尔 reporter */
function isBoolBlock(b: BlockLike): boolean {
  const bt = typeof b.blockType === 'string' ? b.blockType : '';
  if (bt) return /boolean|reporter/i.test(bt) && !/command/i.test(bt);
  // 无 blockType 时按 opcode 形态推断：has*/is*/check*/detect* 一律按布尔处理
  return typeof b.opcode === 'string' && BOOL_DETECT_OP.test(b.opcode);
}

/** 单块分类：返回 'bool'（恒 false）/ 'cmd'（no-op）/ null（放行） */
function classifyBlock(op: string, b: BlockLike, src: string): 'bool' | 'cmd' | null {
  const opText = `${op} ${typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''}`;
  if (isBoolBlock(b)) {
    // 命中任一：检测语义 opcode / 检测语义描述 / 源码里有真实探测面
    if (BOOL_DETECT_OP.test(op)) return 'bool';
    if (DETECT_TEXT.test(opText)) return 'bool';
    if (LEAK_SRC.some((re) => re.test(src))) return 'bool';
    return null;
  }
  // command：销毁/跳转
  if (DANGEROUS_CMD_OP.test(op)) return 'cmd';
  if (DESTROY_TEXT.test(opText)) return 'cmd';
  if (DESTROY_SRC.some((re) => re.test(src))) return 'cmd';
  return null;
}

/** 实例层净化：按 blocks 分类逐个遮蔽（幂等）。返回处置块数。 */
export function neutralizeInstance(inst: InstLike): number {
  if (!inst || typeof inst !== 'object' || sanitizedInsts.has(inst)) return 0;
  let info: InfoLike | undefined;
  try {
    info = inst.getInfo?.();
  } catch {
    /* ignore */
  }
  const blocks = info?.blocks;
  let hit = 0;
  // 路径 1：getInfo 元数据驱动（opcode 即实例方法名，runtime 分发约定）
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (!b || typeof b.opcode !== 'string' || !b.opcode) continue;
      const op = b.opcode;
      const src = fnSource(inst[op]);
      const cls = classifyBlock(op, b, src);
      if (!cls) continue;
      shadowMethod(inst, op, cls === 'bool' ? returnFalse : returnUndefined);
      opClass.set(op, cls);
      hit++;
    }
  }
  // 路径 2：源码驱动兜底（元信息缺失/改名/手工注册的实例）——
  // 方法体里有真实探测/销毁面就处置，与元信息无关。
  for (const k of methodKeys(inst)) {
    if (k === 'getInfo' || typeof inst[k] !== 'function') continue;
    if (inst[k] === returnFalse || inst[k] === returnUndefined) continue;
    const src = fnSource(inst[k]);
    const leak = LEAK_SRC.some((re) => re.test(src));
    const destr = DESTROY_SRC.some((re) => re.test(src));
    if (!leak && !destr) continue;
    const cls = leak && !destr ? 'bool' : destr && !leak ? 'cmd' : 'cmd';
    shadowMethod(inst, k, cls === 'bool' ? returnFalse : returnUndefined);
    opClass.set(k, cls);
    hit++;
  }
  if (hit) sanitizedInsts.add(inst);
  return hit;
}

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

// ---------- primitives 层锁（角色管理器式，第二道保险） ----------

/** 已处理过的 primitives 原件表（WeakMap，随 runtime 回收） */

function lockPrimitives(vm: object): void {
  const runtime = (vm as { runtime?: { _primitives?: Record<string, unknown> } }).runtime;
  const prims = runtime?._primitives;
  if (!prims || typeof prims !== 'object') return;
  if (opClass.size === 0) return;
  let origMap = originals.get(prims);
  if (!origMap) {
    origMap = new Map();
    originals.set(prims, origMap);
  }
  for (const key of Object.keys(prims)) {
    // opcode 匹配：键等于 opcode，或以 `_<opcode>` 结尾（scratch-vm 的 id_opcode 组合形态）
    let cls = opClass.get(key);
    if (!cls) {
      const m = /_([A-Za-z][A-Za-z0-9_]*)$/.exec(key);
      if (m) cls = opClass.get(m[1]);
    }
    if (!cls) continue;
    if (origMap.has(key)) continue;
    const orig = prims[key];
    if (typeof orig !== 'function') continue;
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
      const origStr = (orig as { toString?: () => string }).toString;
      if (typeof origStr === 'function') {
        Object.defineProperty(wrapped, 'toString', { value: origStr.bind(orig) });
      }
    } catch {
      /* ignore */
    }
    prims[key] = wrapped;
  }
}

/** 已完成首轮全量枚举的 runtime（首轮最重：要对每个扩展方法做源码分类） */
const enumeratedOnce = new WeakSet<object>();

/**
 * extGet 式全量枚举 + 净化 + primitives 锁（onVmTick 每拍调用）。
 * 每拍重扫：晚注册的扩展也能接住；已净化实例由 sanitizedInsts 幂等短路，
 * 重复拍的成本只是遍历 extensions 表本身（几十个键的属性读）。
 * 首轮枚举在作品加载期推迟（反序列化优先），下一拍补上。
 * 枚举面：runtime.extensions（id→实例）、em._loadedExtensions（service→实例）、
 * em._customExtensionInfo / _officialExtensionInfo / _gandiExternalExtensionServices
 * （仅用于发现线索对象，能取到实例就一并净化）。
 */
export function sanitizeRuntime(vm: object): void {
  try {
    const v = vm as {
      runtime?: { extensions?: Record<string, unknown>; _primitives?: Record<string, unknown> };
      extensionManager?: Record<string, unknown>;
    };
    const instances = new Set<unknown>();
    const exts = v.runtime?.extensions;
    if (exts && typeof exts === 'object') {
      for (const k of Object.keys(exts)) {
        const inst = (exts as Record<string, unknown>)[k];
        if (inst && typeof inst === 'object') instances.add(inst);
      }
    }
    const em = v.extensionManager;
    if (em && typeof em === 'object') {
      for (const mk of ['_loadedExtensions', '_customExtensionInfo', '_officialExtensionInfo', '_gandiExternalExtensionServices'] as const) {
        const m = em[mk];
        if (m instanceof Map) {
          for (const val of m.values()) {
            if (val && typeof val === 'object') instances.add(val);
          }
        }
      }
    }
    for (const inst of instances) {
      try {
        neutralizeInstance(inst as InstLike);
      } catch {
        /* ignore */
      }
    }
    if (!enumeratedOnce.has(vm)) {
      enumeratedOnce.add(vm);
      analyzeExtensionSources(vm, instances);
    }
    lockPrimitives(vm);
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

/** 取实例的扩展 id */
function instanceId(inst: unknown): string | null {
  try {
    const info = (inst as { getInfo?: () => { id?: unknown } }).getInfo?.();
    const id = info?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** 禁用整个扩展的积木：布尔恒 false、命令恒 undefined（禁止扩展积木） */
export function disableExtensionBlocks(inst: InstLike): number {
  if (!inst || typeof inst !== 'object') return 0;
  let blocks: BlockLike[] | undefined;
  try {
    blocks = inst.getInfo?.()?.blocks;
  } catch {
    /* ignore */
  }
  if (!Array.isArray(blocks)) return 0;
  let n = 0;
  for (const b of blocks) {
    if (!b || typeof b.opcode !== 'string' || !b.opcode) continue;
    const op = b.opcode;
    const cls = isBoolBlock(b) ? 'bool' : 'cmd';
    shadowMethod(inst, op, cls === 'bool' ? returnFalse : returnUndefined);
    opClass.set(op, cls);
    n++;
  }
  if (n) sanitizedInsts.add(inst);
  return n;
}

/**
 * 拉取所有自定义扩展的源码并分析（extGet 的收集思路落到反制侧）：
 *   来源：extensionManager._customExtensionInfo / _officialExtensionInfo /
 *         _gandiExternalExtensionServices —— 值里带 url。
 *   命中检测/摧毁/跳转特征 → 从源码取扩展 id 匹配到实例 →
 *   禁用该扩展全部积木（禁止扩展积木）并让检测类返回值恒 false。
 * 拉取失败（跨域/CSP/离线）不影响主路径：实例方法源码分析已在 neutralizeInstance 覆盖。
 */
async function analyzeExtensionSources(vm: object, instances: Set<unknown>): Promise<void> {
  if (isProjectLoading()) return;
  const em = (vm as { extensionManager?: Record<string, unknown> }).extensionManager;
  if (!em || typeof em !== 'object') return;
  const targets: { id?: string; url: string }[] = [];
  for (const mk of ['_customExtensionInfo', '_officialExtensionInfo', '_gandiExternalExtensionServices'] as const) {
    const m = em[mk];
    const list: unknown[] = [];
    if (m instanceof Map) list.push(...m.values());
    else if (m && typeof m === 'object') list.push(...Object.values(m as Record<string, unknown>));
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { id?: unknown; url?: unknown };
      const url = typeof e.url === 'string' ? e.url : '';
      if (!url || !/^https?:/i.test(url)) continue;
      targets.push({ id: typeof e.id === 'string' ? e.id : undefined, url });
      if (targets.length >= 12) break;
    }
    if (targets.length >= 12) break;
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
    for (const inst of instances) {
      const id = instanceId(inst);
      if (!id || id !== srcId) continue;
      try {
        if (destr) {
          // 含摧毁/跳转代码 → 整个扩展的积木禁运行
          disableExtensionBlocks(inst as InstLike);
        } else {
          // 仅检测面 → 检测类返回值恒 false
          neutralizeInstance(inst as InstLike);
        }
      } catch {
        /* ignore */
      }
    }
  }
}
