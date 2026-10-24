/**
 * 七层防御对抗层（ext-hardlock）——敌方自我保护 vs. 我方反制的正面交锋。
 *
 * ===== 敌方形态（参考《七层防御完整总结》）=====
 * 敌扩展（如 YinSecurity / 角色管理器类）为了保住自己的积木不被停用，会叠七层：
 *   第 0 层  闭包私有化 + toString 伪装     → 拿不到函数引用
 *   第 1 层  属性描述符锁定（writable:false / configurable:false）
 *   第 2 层  Proxy 陷阱（set / defineProperty / deleteProperty）
 *   第 3 层  锁定 runtime 关键方法（startHats 等）
 *   第 4 层  看门狗自愈（250ms 轮询回源校验并夺回）
 *   第 5 层  影子注入（污染 Blockly 积木执行层）
 *   第 6 层  锁定 extensionManager 卸载方法
 *
 * ===== 为什么我方现有反制会被击穿 =====
 * `ext-sanitize.ts` 的 primitives 层走 `prims[key] = wrapped`（普通赋值）：
 *   · 撞第 1 层 → 静默失败（writable:false）或抛错（configurable:false）
 *   · 撞第 2 层 → 被 set 陷阱吞掉，判定"写入成功"实则没写
 *   · 撞第 4 层 → 250ms 后被看门狗夺回，我方中和失效，积木恢复真身
 * 即：敌扩展只要开第 1/2/4 层任一，我方"篡改返回值 + 禁用积木"就被抵消。
 *
 * ===== 对抗总纲 =====
 * 平台 VM 的积木**唯一执行面**是 `runtime.getOpcodeFunction(opcode)`，
 * 它内部读 `this._primitives[opcode]`（已对 vendor chunk 逐行核实）。
 * 敌方的七层全部围绕 `_primitives` 这**一个对象**展开 —— 它们能守住 `_primitives`，
 * 却守不住 `getOpcodeFunction` 这个**函数入口**。
 *
 * 因此我方对策分四道防线，逐层升级、互为备份：
 *
 *   防线 A（入口拦截，主力）
 *     用 Proxy 包裹 `runtime.getOpcodeFunction`：
 *       · 命中我方管控的 opcode → 返回我方中和包装（恒 false / 恒 no-op）
 *       · 其余 opcode → 原样透传（零影响，良性扩展不受牵连）
 *     敌方的七层**完全触及不到这个入口** —— 它们锁 `_primitives`、改 Proxy、
 *       锁 runtime 方法、注入 Blockly，全都绕不开 getOpcodeFunction 的分发。
 *
 *   防线 B（_primitives 影子写入 + 描述符加固）
 *     在 `_primitives` 上把敌 opcode 的值换成我方中和包装，并
 *     用 `configurable:false` 锁死属性 —— 让敌方的第 1 层反过来锁不住我方
 *     （它要夺回就得先 delete，而 delete 也要过第 2 层的 Proxy 陷阱）。
 *
 *   防线 C（Proxy 陷阱护栏，第 2 层反制）
 *     我方也用 Proxy 包 `_primitives`：
 *       · set / defineProperty / deleteProperty 命中受控 opcode → 拒绝并回灌我方包装
 *       · 敌方的看门狗想夺回写入 → 被陷阱吞掉且值被强制拉回我方版本
 *     这一层直接堵死敌方的第 2 层与第 4 层（看门狗靠写入夺回）。
 *
 *   防线 D（看门狗对看门狗，第 4 层反制）
 *     我方自建巡检节拍：每拍复核受控 opcode 的当前值，
 *     一旦被敌方夺回（值 !== 我方包装）→ 立刻重新写入并加固。
 *     与敌方 250ms 看门狗同频甚至更快的对拉中，我方稳赢（我方在 vm tick 内，
 *     且写入路径有 Proxy 护栏，敌方写入必被拒）。
 *
 * 敌方七层 → 我方反制对照：
 *   敌第 0 层（闭包+伪装） → 防线 A：入口拦截不需要敌函数引用
 *   敌第 1 层（描述符锁定）→ 防线 B：反向锁死 + 防线 A：入口根本读不到
 *   敌第 2 层（Proxy 陷阱）→ 防线 C：陷阱对陷阱，我方值恒赢
 *   敌第 3 层（锁 runtime）  → 防线 A：getOpcodeFunction 仍被我方接管
 *   敌第 4 层（看门狗夺回）→ 防线 C+D：写入被拒 + 逐拍回灌自愈
 *   敌第 5 层（Blockly 影子）→ 防线 A：VM 分发不走 Blockly 代码生成
 *   敌第 6 层（锁卸载方法）→ 与我方无关：我方不卸载敌扩展，只中和其积木
 *
 * ===== 零副作用铁律 =====
 *  · 只读不改宿主无关结构；`getOpcodeFunction` 包裹后对**非受控 opcode 完全透传**。
 *  · 不卸载敌扩展、不删敌积木、不动敌变量 —— 只中和"检测类返回值"与"破坏类命令"。
 *  · 受控名单按 extId 隔离，绝不误伤同名 opcode 的良性扩展。
 *
 * ===== 与《两种篡改方式的完整防御总结（10 种反制方法）》的对应 =====
 *  · 方法 1（锁 `_primitives` 引用）→ 防线 C 的 getter/setter + configurable:false
 *  · 方法 2（锁 opcode 函数属性）  → 防线 B 反向锁 writable + 防线 A 入口兜底
 *  · 方法 3（Proxy 拦截写入/删除） → 防线 C 陷阱对陷阱
 *  · 方法 4（闭包私有化 + toString 伪装）→ 防线 A 不依赖敌函数引用；
 *      且我方读源码走 `nativeToStringOf`（原始 Function.prototype.toString），
 *      敌方的 toString 伪装**骗不到我方分类**
 *  · 方法 5（`__disabled` 别名 opcode）→ **别名键同域管控**（见 ALIAS_SUFFIXES）
 *  · 方法 7（看门狗自愈）          → 防线 D 对看门狗
 *  · 方法 6 / 8 / 9 / 10           → 见 core/ext-antitamper.ts
 */
import { markFakeSource, nativeToStringOf } from '../dom-utils';
import { onVmTick } from './ext-watch';

/** 受控 opcode 的处置类别 */
export type HardClass = 'bool' | 'cmd';

/**
 * 别名 opcode 后缀（方法 5 的落点）。
 *
 * 「脚本编辑器 pro.js」把积木实例的 opcode 改名成 `<opcode>__disabled`，
 * 于是 VM 按新名字查 `_primitives` 查不到 → 积木静默失效。
 * 敌扩展也可能用同一手法给自己注册 `__disabled` 别名函数来**绕过**我方按精确键的中和。
 *
 * ★ 平台自身产物中 `__disabled` 零命中（已对站点 vendor chunk 全量检索确认），
 *   所以这个后缀是**篡改工具的指纹**而非平台语义 → 可以放心纳入管控域。
 *
 * 双向落地：
 *   ① 敌扩展注册别名 → 同一个中和包装接管别名键（别名失效，管控不漏）
 *   ② 积木实例被改名 → 别名键存在 → 积木照常执行（改名无效）
 */
export const ALIAS_SUFFIXES: readonly string[] = ['__disabled'];

/** 我方包装函数与「原始值」的对照（按 runtime 分桶） */
interface Bucket {
  /** 受控键 → 我方包装 */
  wrapped: Map<string, (...a: unknown[]) => unknown>;
  /** 受控键 → 处置类别 */
  classes: Map<string, HardClass>;
  /** 原件（用于伪装 toString 与夺回判定） */
  originals: Map<string, unknown>;
  /** 已施加管控的扩展 id（扩展 id 可含下划线，不能从键反推，故单独记） */
  extIds: Set<string>;
}

/**
 * runtime → 该 runtime 的受控桶。
 *
 * ★ 按 runtime 索引（而非按 _primitives 对象）——
 *   护栏装好后 `runtime._primitives` 读到的是我方 Proxy，与原始对象不是同一引用；
 *   若按对象索引，入口拦截时用 Proxy 查表会查不到桶。
 *   runtime 是稳定锚点（整个 VM 生命周期不变），用它索引最稳。
 */
const buckets = new WeakMap<object, Bucket>();

/** 已接管 getOpcodeFunction 的 runtime（幂等） */
const patchedRuntimes = new WeakSet<object>();

/** 已装好 Proxy 护栏的 runtime（幂等） */
const guardedRuntimes = new WeakSet<object>();

/** 取得（或创建）某 runtime 的受控桶 */
function bucketOf(runtime: object): Bucket {
  let b = buckets.get(runtime);
  if (!b) {
    b = { wrapped: new Map(), classes: new Map(), originals: new Map(), extIds: new Set() };
    buckets.set(runtime, b);
  }
  return b;
}

/** 构造我方中和包装：布尔恒 false / 命令恒 undefined */
function makeWrapper(cls: HardClass, orig: unknown, opcode: string): (...a: unknown[]) => unknown {
  const wrapped =
    cls === 'bool'
      ? function (): false {
          return false;
        }
      : function (): undefined {
          return undefined;
        };
  try {
    // toString 伪装：敌扩展会探测 primitives 函数源码，看到非原生形态会判定被注入
    const origSrc =
      typeof orig === 'function' ? nativeToStringOf(orig as () => string) : 'function () { [native code] }';
    markFakeSource(wrapped, origSrc);
    Object.defineProperty(wrapped, 'name', { value: opcode, configurable: true });
  } catch {
    /* ignore */
  }
  return wrapped;
}

/**
 * 防线 C：为 _primitives 装 Proxy 护栏。
 *
 * 命中受控键的 set / defineProperty / deleteProperty 一律拒绝并回灌我方包装：
 * 敌方的第 2 层（Proxy 陷阱）与第 4 层（看门狗夺回）都靠"写入"生效，
 * 写入被拒 → 它们永远夺不回控制权。
 *
 * ===== Proxy 嵌套顺序（关键）=====
 * 我方护栏必须在**最外层**，才能压住敌方护栏。但敌方可能在任意时刻
 * 用 `runtime._primitives = new Proxy(...)` 把自己包到外层，把我方护栏埋到内层。
 *
 * 破解方式：把护栏装成**不可替换**的 —— 用 `configurable:false` 的
 * getter/setter 定义 `runtime._primitives`，读取时永远返回我方护栏 Proxy，
 * 写入时拒绝并保持我方护栏。这样敌方无论何时试图包裹 / 替换 `_primitives`，
 * 都只能写到"我方护栏的内层 target"，其陷阱在我方护栏**内侧** → 夺回失败。
 * 而敌方自己读 `runtime._primitives` 时读到的也是我方护栏 → 它看到的
 * 永远是"已中和"状态，与它的看门狗预期一致（不会察觉异常）。
 */
function installGuard(runtime: object, prims: object): void {
  if (guardedRuntimes.has(runtime)) return;
  guardedRuntimes.add(runtime);
  const bucket = bucketOf(runtime);
  try {
    const proxy = new Proxy(prims, {
      set(target, prop, value) {
        const key = String(prop);
        const mine = bucket.wrapped.get(key);
        if (mine) {
          // 受控键：拒绝敌方写入，回灌我方包装（保持敌方看到的是"已中和"状态）
          //
          // ★ 规范要点：Proxy set 陷阱返回 truish 但目标属性 non-writable 且值不同
          //   → 引擎抛 TypeError。我方受控键被防线 B 锁成 writable:false，
          //   故必须先把它改成可写再回灌，否则平台/敌方的写入会把引擎打崩。
          try {
            const desc = Reflect.getOwnPropertyDescriptor(target, prop);
            if (desc && desc.writable === false) {
              Reflect.defineProperty(target, prop, { ...desc, writable: true, configurable: true });
            }
          } catch {
            /* ignore */
          }
          try {
            Reflect.set(target, prop, mine);
          } catch {
            /* ignore */
          }
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      defineProperty(target, prop, descriptor) {
        const key = String(prop);
        const mine = bucket.wrapped.get(key);
        if (mine) {
          // 受控键：把描述符里的 value 换成我方包装后放行（敌方以为成功了，实际是我方的）
          //
          // ★ 规范要点：defineProperty 陷阱返回 truish 但落地的描述符与目标不一致
          //   → 引擎抛 TypeError。故必须让落地描述符与我方包装**完全一致**。
          const landed = {
            value: mine,
            writable: descriptor.writable !== false,
            // 别名键恒不可枚举（不在宿主枚举 _primitives 时露出幻影 opcode）
            enumerable: isAliasKey(key) ? false : descriptor.enumerable !== false,
            configurable: descriptor.configurable !== false,
          };
          try {
            Reflect.defineProperty(target, prop, landed);
          } catch {
            /* ignore */
          }
          return true;
        }
        try {
          return Reflect.defineProperty(target, prop, descriptor);
        } catch {
          return false;
        }
      },
      deleteProperty(target, prop) {
        const key = String(prop);
        if (bucket.wrapped.has(key)) {
          // 受控键：允许平台删除（卸载扩展是平台的正当行为，我方不阻断）
          //
          // ★ 规范要点：deleteProperty 陷阱返回 truish 但目标属性 non-configurable
          //   且确实存在 → 引擎抛 TypeError。我方受控键保持 configurable:true
          //   （见防线 B：只锁 writable，不锁 configurable），
          //   故删除可以正常完成 —— 删完后入口拦截（防线 A）仍给出中和值，
          //   看门狗下一拍会把受控键重新种回（防线 D 自愈）。
          return Reflect.deleteProperty(target, prop);
        }
        return Reflect.deleteProperty(target, prop);
      },
    });

    // 把 runtime._primitives 锁成「不可替换的护栏」：
    //   · getter 永远返回我方护栏 Proxy（敌方无法把自己包到外层）
    //   · setter 拒绝一切替换（敌方的 runtime._primitives = new Proxy(...) 无效）
    //   · configurable:false → 敌方连 defineProperty 都改不了
    // 副作用控制：只影响 _primitives 这一个属性的读写通道，
    //   其余 key 的读写完全透传给原对象（Reflect 转发），零误伤。
    const rt = runtime;
    if (rt) {
      try {
        Object.defineProperty(rt, '_primitives', {
          get() {
            return proxy;
          },
          set() {
            // 拒绝替换：敌方的 runtime._primitives = new Proxy(...) 意图落空，
            // 护栏继续生效（静默丢弃，不写回原对象以免污染）
          },
          configurable: false,
          enumerable: true,
        });
      } catch {
        // runtime._primitives 已被敌方锁成 configurable:false（敌第 1 层）
        // → 退化为普通赋值：我方护栏装在对象本身（敌方 Proxy 在外层时由防线 A + D 兜底）
        try {
          Object.defineProperty(rt, '_primitives', {
            value: proxy,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 防线 A：包裹 runtime.getOpcodeFunction —— 平台积木的唯一执行面。
 *
 * 命中受控键 → 返回我方中和包装；其余键 → 原样透传。
 * 敌方七层全部围绕 _primitives 展开，触及不到这个入口，
 * 因此无论它们锁到什么程度，积木真身都执行不到。
 */
function patchOpcodeFunction(runtime: object): void {
  if (patchedRuntimes.has(runtime)) return;
  const rt = runtime as { getOpcodeFunction?: unknown };
  const orig = rt.getOpcodeFunction;
  if (typeof orig !== 'function') return;
  patchedRuntimes.add(runtime);

  const patched = function (this: unknown, opcode: string): unknown {
    try {
      // ★ 用 this（runtime）查桶：runtime 才是稳定锚点，
      //   this._primitives 可能是护栏 Proxy（与原对象不同引用）。
      const rt = this as object;
      const bucket = buckets.get(rt);
      if (bucket) {
        const mine = bucket.wrapped.get(opcode);
        if (mine) return mine;
      }
    } catch {
      /* ignore */
    }
    return orig.call(this, opcode);
  };

  try {
    markFakeSource(patched, nativeToStringOf(orig as () => string));
    Object.defineProperty(patched, 'name', { value: 'getOpcodeFunction', configurable: true });
  } catch {
    /* ignore */
  }

  try {
    Object.defineProperty(runtime, 'getOpcodeFunction', {
      value: patched,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    try {
      (runtime as unknown as Record<string, unknown>).getOpcodeFunction = patched;
    } catch {
      /* ignore */
    }
  }
}

/**
 * 对抗层总开关（默认开启）。
 *
 * 关闭后 `hardLockExtensionPrimitive` 退化为空操作 —— 此时 primitives 层只剩
 * 普通赋值（`prims[key] = wrapped`），在敌方七层防御下会被静默拒绝 / 被夺回。
 * 该开关仅供对照实验（scripts/probe-hardlock-ab.mjs）与故障排查使用，
 * 生产路径永远保持开启。
 */
let hardlockEnabled = true;

/** 设置对抗层启用状态（返回设置后的状态） */
export function setHardlockEnabled(on: boolean): boolean {
  hardlockEnabled = !!on;
  return hardlockEnabled;
}

/** 查询对抗层启用状态 */
export function isHardlockEnabled(): boolean {
  return hardlockEnabled;
}

/**
 * 写入并加固一个受控键（防线 B）。
 *
 * 只锁 writable、不锁 configurable —— 锁 configurable 会打断平台 `delete` 卸载流程
 * （副作用边界探针 ⑥ 实测过这个坑：平台删一个 non-configurable 且存在的属性会抛 TypeError）。
 *
 * @param enumerable 别名键传 false —— 让别名键在 `_primitives` 的枚举里**不可见**，
 *   避免任何遍历 `_primitives` 建立块清单的宿主逻辑看到幻影 opcode。
 */
function writeLocked(
  prims: object,
  key: string,
  value: (...a: unknown[]) => unknown,
  enumerable = true,
): void {
  try {
    Reflect.set(prims, key, value);
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(prims, key, {
      value,
      writable: false,
      configurable: true,
      enumerable,
    });
  } catch {
    // 已被敌方第 1 层锁成 configurable:false → 防线 A 兜底（入口拦截已生效）
    /* ignore */
  }
}

/** 该键是否是别名键（`xxx__disabled` 形态） */
function isAliasKey(key: string): boolean {
  return ALIAS_SUFFIXES.some((s) => key.endsWith(s));
}

/**
 * 对某个敌扩展的 opcode 施加硬锁（不可被夺回的中和）。
 *
 * @param vm       VM 外层（含 .runtime）
 * @param extId    敌扩展 id
 * @param opcode   积木 opcode
 * @param cls      处置类别：bool = 恒 false，cmd = 恒 no-op
 */
export function hardLockExtensionPrimitive(
  vm: object,
  extId: string,
  opcode: string,
  cls: HardClass,
): void {
  if (!hardlockEnabled) return;
  try {
    const runtime = (vm as { runtime?: { _primitives?: Record<string, unknown> } }).runtime;
    if (!runtime) return;
    const prims = runtime._primitives;
    if (!prims || typeof prims !== 'object') return;

    const bucket = bucketOf(runtime);
    const key = `${extId}_${opcode}`;
    bucket.extIds.add(extId);

    if (!bucket.classes.has(key)) {
      bucket.classes.set(key, cls);
      const orig = prims[key];
      bucket.originals.set(key, orig);
      bucket.wrapped.set(key, makeWrapper(cls, orig, opcode));
    }

    // 防线 A：入口拦截（最先安装 —— 分发面必须在我方掌控中，
    //   否则敌方若先锁了 _primitives 的描述符，我方后续写入会被拒）
    patchOpcodeFunction(runtime);

    // 防线 C：护栏（Proxy 陷阱 + _primitives 锁定，敌方夺回路径全封）
    installGuard(runtime, prims);

    // 防线 B：写入影子值 + 反向锁死描述符
    const mine = bucket.wrapped.get(key);
    if (!mine) return;
    writeLocked(prims, key, mine);

    // 方法 5：别名键同域管控。
    //   敌扩展若按方法 5 注册 `<key>__disabled` = 真身函数来规避按精确键的中和，
    //   这里用**同一个**中和包装把别名键一并接管 —— 入口拦截与 Proxy 护栏
    //   因为共用 bucket，天然覆盖别名键，无需额外分支。
    for (const suffix of ALIAS_SUFFIXES) {
      const aliasKey = `${key}${suffix}`;
      if (!bucket.classes.has(aliasKey)) {
        bucket.classes.set(aliasKey, cls);
        bucket.originals.set(aliasKey, prims[aliasKey]);
        bucket.wrapped.set(aliasKey, mine);
      }
      const aliasMine = bucket.wrapped.get(aliasKey);
      if (aliasMine) writeLocked(prims, aliasKey, aliasMine, false);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 防线 D：自建看门狗 —— 每拍复核受控 opcode，被夺回立刻回灌。
 *
 * 与敌方第 4 层（250ms 轮询夺回）对拉：我方写入有 Proxy 护栏兜底，
 * 敌方写入必被拒；即便敌方用了更底层的手段绕过了护栏，本拍也会拉回。
 */
function runHardlockTick(vm: object): void {
  try {
    const runtime = (vm as { runtime?: { _primitives?: Record<string, unknown>; getOpcodeFunction?: unknown } })
      .runtime;
    if (!runtime) return;
    const prims = runtime._primitives;
    if (!prims || typeof prims !== 'object') return;
    const bucket = buckets.get(runtime);
    if (!bucket || bucket.wrapped.size === 0) return;

    for (const [key, mine] of bucket.wrapped) {
      try {
        // 入口面复核（防线 A 是否仍在位）
        const getFn = runtime.getOpcodeFunction as ((k: string) => unknown) | undefined;
        const viaEntry = typeof getFn === 'function' ? getFn.call(runtime, key) : undefined;
        if (viaEntry !== mine) {
          // 入口被夺 → 重新安装
          patchedRuntimes.delete(runtime);
          patchOpcodeFunction(runtime);
        }
        // 数据面复核（防线 B 的值是否被夺回）
        const cur = prims[key];
        if (cur !== mine) {
          writeLocked(prims, key, mine, !isAliasKey(key));
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 我方看门狗的挂载状态（避免重复注册） */
let hardlockInstalled = false;

/**
 * 安装硬锁对抗层（front 布防时调用，幂等）。
 *
 * 挂在 vm 巡检上：每拍复核受控 opcode，被夺回即刻自愈。
 * 巡检节拍由 ext-watch 的 ticker 驱动（2s），敌方看门狗 250ms ——
 * 敌方夺回后到下一拍之间存在窗口，故防线 C（写入即拒）才是主力，
 * 防线 D 只是补最后漏。
 */
export function installExtHardlock(): void {
  if (hardlockInstalled) return;
  hardlockInstalled = true;
  onVmTick((vm) => runHardlockTick(vm));
}

/**
 * 查询某 opcode 是否处于我方硬锁管控下（供探针与诊断使用）。
 */
export function isHardLocked(vm: object, extId: string, opcode: string): boolean {
  try {
    const runtime = (vm as { runtime?: object }).runtime;
    if (!runtime) return false;
    const bucket = buckets.get(runtime);
    return !!bucket && bucket.wrapped.has(`${extId}_${opcode}`);
  } catch {
    return false;
  }
}

/**
 * 列出某 runtime 当前受控的全部键（含别名键）。
 * 供防篡改层做「Blockly 执行层兜底」与诊断使用。
 */
export function lockedKeysOf(vm: object): string[] {
  try {
    const runtime = (vm as { runtime?: object }).runtime;
    if (!runtime) return [];
    const bucket = buckets.get(runtime);
    return bucket ? [...bucket.wrapped.keys()] : [];
  } catch {
    return [];
  }
}

/** 取某受控键当前的中和包装（没有则 undefined） */
export function lockedWrapperOf(vm: object, key: string): unknown {
  try {
    const runtime = (vm as { runtime?: object }).runtime;
    if (!runtime) return undefined;
    const bucket = buckets.get(runtime);
    return bucket?.wrapped.get(key);
  } catch {
    return undefined;
  }
}

/** 列出某 runtime 当前被施加管控的扩展 id */
export function lockedExtIdsOf(vm: object): string[] {
  try {
    const runtime = (vm as { runtime?: object }).runtime;
    if (!runtime) return [];
    const bucket = buckets.get(runtime);
    return bucket ? [...bucket.extIds] : [];
  } catch {
    return [];
  }
}

/**
 * 释放某个扩展的全部管控（方法 9 的配套：扩展被平台卸载后不留残余管控）。
 *
 * 背景：平台卸载扩展时会 `delete runtime._primitives[key]`，
 * 而我方看门狗每拍会把被删的键**重新种回**（自愈）——
 * 若扩展已卸载，这会让「已不存在的扩展」在 `_primitives` 里留下残影。
 * 这里在确认扩展确实不在了之后，清掉 bucket 条目并删掉残留键。
 *
 * @returns 释放的键数
 */
export function releaseExtensionLocks(vm: object, extId: string): number {
  try {
    const runtime = (vm as { runtime?: { _primitives?: Record<string, unknown> } }).runtime;
    if (!runtime) return 0;
    const bucket = buckets.get(runtime);
    if (!bucket) return 0;
    const prims = runtime._primitives;
    const prefix = `${extId}_`;
    let n = 0;
    for (const key of [...bucket.wrapped.keys()]) {
      if (!key.startsWith(prefix)) continue;
      bucket.wrapped.delete(key);
      bucket.classes.delete(key);
      bucket.originals.delete(key);
      if (prims && typeof prims === 'object') {
        try {
          Reflect.deleteProperty(prims, key);
        } catch {
          /* ignore */
        }
      }
      n++;
    }
    bucket.extIds.delete(extId);
    return n;
  } catch {
    return 0;
  }
}
