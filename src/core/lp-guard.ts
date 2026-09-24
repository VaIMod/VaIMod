// ===== loadProject 旁路包装：挂在「函数实际所在的那一层」 =====
//
// 为什么优先挂「原型」而不是「实例」：
//   数字签名家（digSig）的 _checkEnv() 用
//     Object.prototype.hasOwnProperty.call(vm, 'loadProject')
//     || vm.loadProject !== 原型链上第一个同名方法
//   判定「loadProject 被篡改」，命中即 _halt()（runtime.stopAll() + while(true) 卡死）。
//   实例包装哪怕用 defineProperty 非枚举，hasOwnProperty 依然为 true → 被判篡改。
//   真机 Scratch 的 loadProject 是 VirtualMachine.prototype 上的类方法（实例上无自有
//   属性）→ 挂到它所在的那个原型上，实例查不到自有属性、vm.loadProject 又恰好等于
//   原型链第一个同名方法 → 判定恒为「未篡改」。
//
// ⛔ 但「一律挂原型」是错的（实锤回归：probe-pirate 10/15，捕获计数恒 0）：
//   若站点把 loadProject 定义成 **实例自有属性**（探针假 vm 桩就是这么写的，
//   真机也存在自行赋值覆盖的场景），原型上的包装会被实例自有属性永久遮蔽 →
//   包装形同不存在。所以安装位置必须跟随 findNative 找到的 owner：
//     owner === vm  → 挂实例（此时 digSig 的 hasOwnProperty 本来就已是 true，
//                     不是我们引入的痕迹，不存在「新增可检测特征」问题）
//     owner 在原型链 → 挂该原型（digSig 判定保持「未篡改」）
//
// 与 Cave 事故铁律的边界：包装始终是纯旁路透传（先记录入参，再用原参数调用原生实现），
// 不改 window.vm 形状、不拒写、不吞站点赋值。
//
// 伪装三件套与旧实现一致：非枚举安装 / name 保持 / toString 返回原函数源码。
// 另有第四件：登记进 dom-utils 的已伪装集合（挡 Function.prototype.toString.call 这条旁路）。

import { markNative } from '../dom-utils';

const TAP_MARK = '__vaimodLpTap';

type TapHost = { [TAP_MARK]?: boolean };
type LoadProjectFn = (...args: unknown[]) => unknown;
type Tap = (input: unknown) => void;

/** owner 对象 → 该层承载的 tap 集合（原型与实例共用一张表，键是 owner 本身） */
const ownerTaps = new WeakMap<object, Set<Tap>>();
/** 已装载包装的 owner（WeakSet 自动回收） */
const ownerInstalled = new WeakSet<object>();

function disguise(wrapped: unknown, orig: LoadProjectFn): void {
  try {
    Object.defineProperty(wrapped as object, TAP_MARK, { value: true, configurable: true, enumerable: false });
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(wrapped, 'name', { value: orig.name, configurable: true });
  } catch {
    /* ignore */
  }
  try {
    const origSrc = Function.prototype.toString.call(orig);
    (wrapped as { toString: () => string }).toString = function (): string {
      return origSrc;
    };
  } catch {
    /* ignore */
  }
  // 自有 toString 只能骗过 `wrapped.toString()`；敌扩展用
  // `Function.prototype.toString.call(vm.loadProject)` 就直接拿到包装源码
  // （含 ownerTaps / for (const t of ownerTaps.get(base)) 这些 VaIMod 特征）。
  // 登记进 dom-utils 的已伪装集合，让那边的 Function.prototype.toString 补丁兜住这条路径。
  markNative(wrapped as object, orig.name || 'loadProject');
}

function isOurWrap(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as TapHost)[TAP_MARK] === true;
}

interface NativeSlot {
  fn: LoadProjectFn;
  /** 承载该函数的对象（实例本身，或其原型链上某一层） */
  owner: object;
}

/** 沿原型链找承载 loadProject 的函数及其 owner（跳过我们自己装的包装） */
function findNative(vm: object): NativeSlot | null {
  let level: object | null = vm;
  let guard = 0;
  while (level && guard++ < 16) {
    const d = Object.getOwnPropertyDescriptor(level, 'loadProject');
    const val = d?.value;
    if (typeof val === 'function' && !isOurWrap(val)) return { fn: val as LoadProjectFn, owner: level };
    level = Object.getPrototypeOf(level) as object | null;
  }
  return null;
}

/** 清掉早前版本可能留在实例上的自家包装（避免遮蔽原型包装、避免新增可检测痕迹） */
function dropStaleInstanceWrap(vm: object): void {
  try {
    const holder = vm as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(holder, 'loadProject') && isOurWrap(holder.loadProject)) {
      delete holder.loadProject;
    }
  } catch {
    /* ignore */
  }
}

/**
 * 安装 loadProject 旁路 tap（幂等，可多个 tap 共存；新 tap 可后加）。
 * @returns 是否已就位
 */
export function installLoadProjectTap(vm: object, tap: Tap): boolean {
  const slot = findNative(vm);
  if (!slot) return false;
  const { fn: orig, owner } = slot;

  // owner 不是实例时，实例上若残留自家旧包装必须先摘掉：它会把新装的包装遮死
  if (owner !== vm) dropStaleInstanceWrap(vm);

  let set = ownerTaps.get(owner);
  if (!set) {
    set = new Set<Tap>();
    ownerTaps.set(owner, set);
  }
  set.add(tap);
  if (ownerInstalled.has(owner)) return true;

  const base = owner;
  const wrapped = function (this: unknown, input: unknown, ...rest: unknown[]): unknown {
    for (const t of ownerTaps.get(base) ?? []) {
      try {
        t(input);
      } catch {
        /* 捕获失败不影响加载本身 */
      }
    }
    return orig.apply(this, [input, ...rest]);
  };
  disguise(wrapped, orig);

  try {
    Object.defineProperty(owner, 'loadProject', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    ownerInstalled.add(owner);
    return true;
  } catch {
    // 极端兜底：owner 被冻结/不可配置 → 若 owner 不是实例本身，再试实例层
    if (owner !== vm) {
      try {
        Object.defineProperty(vm, 'loadProject', {
          value: wrapped,
          writable: true,
          configurable: true,
          enumerable: false,
        });
        ownerInstalled.add(vm);
        return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

/** 该 vm 的 loadProject 是否已被包装接管（捕获层据此避免叠加） */
export function isLoadProjectTapped(vm: object): boolean {
  try {
    if (ownerInstalled.has(vm)) return true;
    const proto = Object.getPrototypeOf(vm) as object | null;
    if (proto && ownerInstalled.has(proto)) return true;
  } catch {
    /* ignore */
  }
  return false;
}
