// ===== 扩展注册咽喉 + vm 常驻扫描（两套反制共用的补漏层） =====
//
// `window.Scratch.extensions.register` 只覆盖「官方注册通道」；ccw / TurboWarp 系宿主
// 加载项目内嵌扩展走 extensionManager（loadExtensionId / _registerInternalExtension 等），
// 实例不经过 register 参数 —— 在这些方法外再包一层，注册完成后立即重扫 runtime.extensions，
// 保证「项目加载后才注册的反作弊扩展」也能在它第一次 _checkEnv / _halt 之前被接管净化。
//
// 三层补漏（幂等，可从多个反制模块同时调用）：
//   hookExtensionManager(vm, onAfter) —— 包住 extensionManager 的 register/load/install 族方法，
//                                        同步返回后与 Promise 决议后各触发一次 onAfter
//   trackVm(vm)                       —— 把 vm 放进常驻扫描池（去重，弱引用优先）
//   onVmTick(cb)                      —— 每 2s 对扫描池内全部 vm 调用一次 cb（各反制自查补接）

type WeakishRef = { deref(): object | undefined };

/** ES2021 WeakRef（tsconfig lib 未包含，从 globalThis 取）；运行时缺失则退化为强引用
 *  （vm 本就随页面常驻，强引用不产生额外泄漏） */
const WeakRefImpl: (new (t: object) => WeakishRef) | undefined = (() => {
  try {
    const w = (globalThis as unknown as { WeakRef?: new (t: object) => WeakishRef }).WeakRef;
    return typeof w === 'function' ? w : undefined;
  } catch {
    return undefined;
  }
})();

const vmRefs: WeakishRef[] = [];
const vmCallbacks = new Set<(vm: object) => void>();
// 已挂钩子的原型 → 该原型上的回调集合（多个反制模块共用一份钩子，回调全部保留）
const hookedProtos = new WeakMap<object, Set<() => void>>();
let vmTicker: ReturnType<typeof setInterval> | null = null;

function ensureTicker(): void {
  if (vmTicker !== null) return;
  vmTicker = setInterval(() => {
    // 回收已失活引用（页面导航后旧 vm 可被 GC）
    for (let i = vmRefs.length - 1; i >= 0; i--) {
      if (vmRefs[i].deref() === undefined) vmRefs.splice(i, 1);
    }
    if (vmRefs.length === 0) return;
    for (const cb of [...vmCallbacks]) {
      for (const ref of vmRefs) {
        const vm = ref.deref();
        if (!vm) continue;
        try {
          cb(vm);
        } catch {
          /* ignore */
        }
      }
    }
  }, 2000);
}

/** 把 vm 加入常驻扫描池（幂等；上限 8 个，超出丢最旧 —— 同页 vm 数量级就是个位数） */
export function trackVm(vm: object): void {
  for (const ref of vmRefs) {
    if (ref.deref() === vm) return;
  }
  if (vmRefs.length >= 8) vmRefs.shift();
  vmRefs.push(WeakRefImpl ? new WeakRefImpl(vm) : { deref: () => vm });
  ensureTicker();
}

/** 注册每 2s 一次的 vm 巡检回调（幂等集合，多次注册同一 cb 只保留一份） */
export function onVmTick(cb: (vm: object) => void): void {
  vmCallbacks.add(cb);
  ensureTicker();
}

/**
 * 包住 extensionManager 的 register/load/install 族方法（幂等，按原型去重）。
 * onAfter 在每次调用后触发（同步立即 + Promise 决议后各一次），
 * 调用方在里面重扫 runtime.extensions 并 adopt 新出现的敌意实例。
 */
export function hookExtensionManager(vm: unknown, onAfter: () => void): void {
  try {
    if (!vm || typeof vm !== 'object') return;
    const em = (vm as { extensionManager?: unknown }).extensionManager;
    if (!em || typeof em !== 'object') return;
    // 方法大多挂在类原型上；实例自有方法也要盖到（优先原型，一份钩子覆盖全部实例）
    const proto = Object.getPrototypeOf(em);
    const target =
      proto && typeof proto === 'object' ? (proto as Record<string, unknown>) : (em as Record<string, unknown>);
    if (hookedProtos.has(target)) {
      // 同一原型已被别的反制模块包过：把回调并入同一个钩子集合。
      // 旧实现直接 return 会把后注册一方的回调丢掉（secure-guard 先注册后，
      // sig-guard 的注册咽喉就静默失效了，只剩 2s 巡检兜底）。
      hookedProtos.get(target)?.add(onAfter);
      return;
    }
    const callbacks = new Set<() => void>([onAfter]);
    hookedProtos.set(target, callbacks);
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!/register|load|install/i.test(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(target, key);
      const fn = desc?.value;
      if (typeof fn !== 'function') continue;
      const orig = fn as (this: unknown, ...a: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const r = orig.apply(this, args);
        const fire = (): void => {
          // 快照遍历：回调里可能再注册新回调，避免边遍历边改集合
          for (const cb of [...callbacks]) {
            try {
              cb();
            } catch {
              /* ignore */
            }
          }
        };
        fire();
        // 异步注册（loadExtensionId 等返回 Promise）：实例在决议后才进入 runtime.extensions
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).then(fire, fire);
        }
        return r;
      };
      try {
        Object.defineProperty(wrapped, 'name', { value: key, configurable: true });
      } catch {
        /* ignore */
      }
      Object.defineProperty(target, key, {
        ...desc,
        value: wrapped,
      });
    }
  } catch {
    /* ignore */
  }
}
