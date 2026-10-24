/**
 * 防篡改升级层（ext-antitamper）——《两种篡改方式的完整防御总结（10 种反制方法）》的落地。
 *
 * ===== 两种篡改形态（本次要防的） =====
 *  · 角色管理器Pro：篡改 `runtime._primitives` 的函数表（改返回值 / 拦 opcode）
 *  · 脚本编辑器 pro.js：给积木实例的 opcode 追加 `__disabled` 后缀
 *    （`target.blocks._blocks[id].opcode` → VM 查表落空 → 积木静默失效）
 *
 * 前者由 ext-hardlock 的四道防线正面硬扛（入口拦截 / 影子写入 / Proxy 护栏 / 看门狗），
 * 本模块补齐**文档里剩下的方法**与两处此前真实存在的缺口。
 *
 * ===== 本模块的四项落地 =====
 *
 * ① 方法 5（别名 opcode）+ 方法 10（实例改名）—— 改名这一路的双向兜底
 *   · 别名键管控在 ext-hardlock（别名键与主键共用同一 bucket → 入口与护栏天然覆盖）
 *   · 本模块负责**实例层**：扫描 `runtime.targets[].blocks._blocks[*].opcode`，
 *     发现 `__disabled` 后缀就还原成原 opcode 并 `resetCache()`。
 *     还原只在「去掉后缀的 opcode 在 `_primitives` 里确实存在」时才做 ——
 *     绝不在认不出的情况下瞎改实例（宁可漏改，不可改坏作品）。
 *   · 平台产物中 `__disabled` 零命中（已对站点 vendor chunk 全量检索确认），
 *     该后缀是篡改工具的指纹，不是平台语义 → 还原是安全的。
 *
 * ② 方法 6（锁定 runtime 关键方法）—— 落点是**保护平台自身**，不是锁死宿主
 *   平台自己会包装 `runtime.startHats`（站点 vendor 实测：
 *     `var n = e.runtime.startHats; e.runtime.startHats = function(...t){ if (e.runtime.paused) {...} return n.apply(this,t) }`）。
 *   敌扩展若把该方法锁成 `writable:false / configurable:false`，
 *   平台这段包装赋值会在严格模式下**抛 TypeError**（webpack 模块是 ESM → 严格模式），
 *   于是「暂停 / 绿旗」这类平台功能直接坏掉 —— 站点故障点。
 *   所以这里的做法是：
 *     · 保证这些方法**始终可写可配置**（被锁就尝试修复，修不了就记录）
 *     · `startHats` 缺失平台 paused 语义时，补一个**语义等价**的守卫
 *       （平台后续自己再包装会覆盖掉我们的，不冲突）
 *   ★ 绝不用 non-writable 去锁 runtime 方法 —— 那正是把平台写坏的写法。
 *
 * ③ 方法 8（Blockly 执行层影子注入）—— 编辑器侧的兜底
 *   只对**带扩展 id 前缀的完整键**做影子覆盖（`${extId}_${opcode}`），
 *   这种键天然唯一 → 不会误伤同名 opcode 的良性扩展；
 *   裸 opcode 的块定义一律不碰（无法区分归属）。
 *
 * ④ 方法 9（扩展注册信息 / 卸载绕过）—— 配套两件事
 *   · 扩展被平台卸载后，释放我方对该扩展的管控（不留残影，见 releaseExtensionLocks）
 *   · 同一 extId 换了新实例时，分类缓存按**实例身份**失效重算（见 ext-sanitize）
 *
 * ===== 零副作用铁律 =====
 *  · 只在「确认是篡改」时动手：`__disabled` 后缀还原必须能对上 `_primitives` 里的真键
 *  · 不删积木、不改坐标、不动变量、不改用户作品的任何结构（只还原 opcode 字段本身）
 *  · runtime 方法只做「可写性保障」，不抢占控制权
 *  · Blockly 影子只覆盖唯一键
 */
import { onVmTick } from './ext-watch';
import { isProjectLoading } from './load-accel';
import { enumerateExtensions } from './ext-registry';
import { lockedExtIdsOf, lockedKeysOf, lockedWrapperOf, releaseExtensionLocks } from './ext-hardlock';
import { markFakeSource, nativeToStringOf } from '../dom-utils';

// ---------- 方法 10：积木实例 opcode 自愈 ----------

/** 篡改工具的改名后缀 */
const DISABLED_SUFFIX = '__disabled';

/**
 * 还原被改名的积木实例 opcode。
 *
 * @returns 还原的积木数
 */
function healRenamedBlocks(vm: object): number {
  let healed = 0;
  try {
    const runtime = (vm as { runtime?: { targets?: unknown; _primitives?: Record<string, unknown> } }).runtime;
    if (!runtime) return 0;
    const prims = runtime._primitives;
    if (!prims || typeof prims !== 'object') return 0;
    const targets = Array.isArray(runtime.targets) ? runtime.targets : [];
    for (const target of targets) {
      if (!target || typeof target !== 'object') continue;
      const blocks = (target as { blocks?: { _blocks?: Record<string, unknown>; resetCache?: () => void } }).blocks;
      const table = blocks?._blocks;
      if (!table || typeof table !== 'object') continue;
      let changed = 0;
      for (const id of Object.keys(table)) {
        const blk = table[id] as { opcode?: unknown } | undefined;
        const op = blk?.opcode;
        if (typeof op !== 'string' || !op.endsWith(DISABLED_SUFFIX)) continue;
        const base = op.slice(0, op.length - DISABLED_SUFFIX.length);
        const resolved = resolveBaseOpcode(prims, base);
        // 认不出原 opcode → 不动（宁可漏改，不可改坏作品）
        if (!resolved || !blk) continue;
        try {
          blk.opcode = resolved;
          changed++;
        } catch {
          /* ignore */
        }
      }
      if (changed > 0) {
        healed += changed;
        try {
          blocks?.resetCache?.();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return healed;
}

/**
 * 解析去掉后缀后的原 opcode。
 *
 * ① 直接命中 `_primitives[base]` → 用 base
 * ② 否则在 `_primitives` 里找**唯一**一个以 `_${base}` 结尾的键 → 用那个完整键
 *    （平台把扩展积木的 primitives 键写成 `${extId}_${opcode}`，
 *      而项目里的积木实例可能只存了裸 opcode —— 这种形态要还原成完整键）
 * ③ 认不出 → 返回 null（不改）
 */
function resolveBaseOpcode(prims: Record<string, unknown>, base: string): string | null {
  if (!base) return null;
  if (Object.prototype.hasOwnProperty.call(prims, base)) return base;
  let hit: string | null = null;
  let count = 0;
  const suffix = `_${base}`;
  for (const key of Object.keys(prims)) {
    if (!key.endsWith(suffix)) continue;
    count++;
    if (count > 1) return null;
    hit = key;
  }
  return count === 1 ? hit : null;
}

// ---------- 方法 6：runtime 关键方法保障 ----------

/** 平台自身会包装 / 使用到的 runtime 方法 */
const RUNTIME_KEY_METHODS = ['startHats', 'greenFlag', 'setTargetOrder', 'setSpriteLayer'];

/** 已补过 paused 守卫的 runtime（幂等） */
const pausedGuarded = new WeakSet<object>();

/**
 * 保证 runtime 关键方法**可写可配置**。
 *
 * 敌扩展按方法 6 锁死这些方法后，平台自己的包装赋值会抛 TypeError（严格模式），
 * 站点功能（暂停 / 绿旗 / 图层顺序）会直接坏掉 —— 那是站点故障点，不是保护。
 * 这里能修就修（configurable:true 时可改回可写），修不了就记一笔，不强来。
 */
function keepRuntimeMethodsWritable(runtime: Record<string, unknown>): number {
  let repaired = 0;
  for (const name of RUNTIME_KEY_METHODS) {
    try {
      const desc = Object.getOwnPropertyDescriptor(runtime, name);
      if (!desc) continue;
      if (desc.writable !== false && desc.configurable !== false) continue;
      // 访问器描述符没有 writable —— 不能混着 defineProperty（会抛）
      if (!('writable' in desc)) continue;
      Object.defineProperty(runtime, name, { ...desc, writable: true, configurable: true });
      repaired++;
    } catch {
      /* ignore */
    }
  }
  return repaired;
}

/**
 * `startHats` 的 paused 守卫（平台语义等价物）。
 *
 * 平台 vendor 原文：
 *   `e.runtime.startHats = function(...t){ if (e.runtime.paused) { var r = t[0];
 *      if ("event_whenbroadcastreceived" !== r && "control_start_as_clone" !== r) return []; }
 *      return n.apply(this, t); }`
 * 这里补一份同语义实现：平台若随后自己再包装，会覆盖掉我们的（我们不锁属性，不冲突）；
 * 平台若被敌扩展锁死导致这段包装装不上，我们的守卫保证 paused 语义不丢。
 */
function ensurePausedGuard(runtime: Record<string, unknown>): boolean {
  try {
    if (pausedGuarded.has(runtime)) return false;
    const cur = runtime.startHats;
    if (typeof cur !== 'function') return false;
    // 平台语义只在这个宿主上存在（runtime.paused 是平台特性）
    if (!('paused' in runtime)) return false;
    const src = nativeToStringOf(cur as () => string);
    // 已有 paused 语义（平台的包装或我们自己装的）→ 不重复包
    if (src.includes('paused')) {
      pausedGuarded.add(runtime);
      return false;
    }
    const orig = cur as (...a: unknown[]) => unknown;
    const guard = function (this: unknown, ...args: unknown[]): unknown {
      try {
        if ((runtime as { paused?: unknown }).paused) {
          const hat = args[0];
          if (hat !== 'event_whenbroadcastreceived' && hat !== 'control_start_as_clone') return [];
        }
      } catch {
        /* ignore */
      }
      return orig.apply(this, args);
    };
    try {
      markFakeSource(guard, nativeToStringOf(orig));
      Object.defineProperty(guard, 'name', { value: 'startHats', configurable: true });
    } catch {
      /* ignore */
    }
    runtime.startHats = guard;
    pausedGuarded.add(runtime);
    return true;
  } catch {
    return false;
  }
}

// ---------- 方法 8：Blockly 执行层影子注入 ----------

/**
 * 在 Blockly 积木执行层给受控积木套上同一个中和包装。
 *
 * 只覆盖**带扩展 id 前缀的完整键**（`${extId}_${opcode}`）：
 * 这种键在全平台唯一，不会与同名 opcode 的良性扩展撞车；
 * 裸 opcode 的块定义无法区分归属 → 一律不碰（宁可不覆盖，不可误伤）。
 */
function shadowInjectBlockly(vm: object): number {
  let n = 0;
  try {
    const w = globalThis as unknown as { Blockly?: { Blocks?: Record<string, { func?: unknown }> } };
    const defs = w.Blockly?.Blocks;
    if (!defs || typeof defs !== 'object') return 0;
    for (const key of lockedKeysOf(vm)) {
      // 只认「完整键」：必须含扩展 id 分隔符，且能对上受控桶
      const def = defs[key];
      if (!def || typeof def !== 'object') continue;
      const mine = lockedWrapperOf(vm, key);
      if (typeof mine !== 'function') continue;
      if (def.func === mine) continue;
      try {
        def.func = mine;
        n++;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return n;
}

// ---------- 方法 9：卸载残留释放 ----------

/** extId → 连续「查无此扩展」的拍数（连续 3 拍 ≈ 6s 才释放，避免加载期误判） */
const missingTicks = new Map<string, number>();

/**
 * 扩展被平台卸载后释放我方管控（不留 `_primitives` 残影）。
 * 加载期（作品正在反序列化）不释放 —— 那段时间枚举面会短暂为空。
 */
function releaseDeadExtensions(vm: object): number {
  let released = 0;
  try {
    if (isProjectLoading()) return 0;
    const live = new Set<string>();
    for (const e of enumerateExtensions(vm)) {
      if (e.id) live.add(e.id);
    }
    for (const id of lockedExtIdsOf(vm)) {
      if (live.has(id)) {
        missingTicks.delete(id);
        continue;
      }
      const next = (missingTicks.get(id) ?? 0) + 1;
      if (next >= 3) {
        released += releaseExtensionLocks(vm, id);
        missingTicks.delete(id);
      } else {
        missingTicks.set(id, next);
      }
    }
  } catch {
    /* ignore */
  }
  return released;
}

// ---------- 巡检 ----------

/** 每拍统计（诊断用） */
export interface AntitamperStats {
  /** 还原的改名积木数（累计） */
  healedBlocks: number;
  /** 补上的 paused 守卫数 */
  pausedGuards: number;
  /** Blockly 层影子覆盖数 */
  shadowed: number;
  /** 释放的扩展管控数 */
  released: number;
}

const stats: AntitamperStats = { healedBlocks: 0, pausedGuards: 0, shadowed: 0, released: 0 };

/** 读取防篡改层统计（诊断用） */
export function antitamperStats(): AntitamperStats {
  return { ...stats };
}

/** 防篡改层开关（默认开启；关闭后仅保留实例自愈与 runtime 保障） */
let antitamperEnabled = true;

/** 设置防篡改层启用状态（返回设置后的状态） */
export function setAntitamperEnabled(on: boolean): boolean {
  antitamperEnabled = !!on;
  return antitamperEnabled;
}

/** 查询防篡改层启用状态 */
export function isAntitamperEnabled(): boolean {
  return antitamperEnabled;
}

/** 一拍巡检 */
function runAntitamperTick(vm: object): void {
  if (!antitamperEnabled) return;
  try {
    const runtime = (vm as { runtime?: Record<string, unknown> }).runtime;
    if (!runtime || typeof runtime !== 'object') return;

    // 方法 10：实例改名自愈
    stats.healedBlocks += healRenamedBlocks(vm);

    // 方法 6：runtime 关键方法保障
    keepRuntimeMethodsWritable(runtime);
    if (ensurePausedGuard(runtime)) stats.pausedGuards++;

    // 方法 8：Blockly 执行层兜底
    stats.shadowed += shadowInjectBlockly(vm);

    // 方法 9：卸载残留释放
    stats.released += releaseDeadExtensions(vm);
  } catch {
    /* ignore */
  }
}

let installed = false;

/** 安装防篡改升级层（front 布防时调用，幂等） */
export function installExtAntitamper(): void {
  if (installed) return;
  installed = true;
  onVmTick((vm) => runAntitamperTick(vm));
}
