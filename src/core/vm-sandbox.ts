// VM 安全沙盒（VaIMod 安全 VM 架构核心）
// 结合 GandiVM（scratch-vm 结构）与 secure-vm（双 Proxy 双向代理）思路：
// - 递归代理：从沙盒面访问到的任何 vm 子对象（runtime/targets/variables...）自动包装——
//   只读 + 方法审计，页面无法触及原生引用链；
// - 方法调用双向隔离：参数中的沙盒代理自动解包为原生（防代理套娃），返回值对象自动再包装
//   （防原生对象逃逸到调用方）——跨界对象永远以代理形态存在；
// - 只读：set / defineProperty / deleteProperty / setPrototypeOf / preventExtensions 一律拒绝，
//   变异方法（push/splice/set/delete/clear...）调用同样拒绝——堵住「通过方法调用改写 vm」的
//   绕过路径，保证属性写入与方法写入两条路都只读；
// - 构造隔离：new 沙盒暴露的类同样走代理（construct trap），构造结果再包装，防 new 逃逸；
// - 原型隔离：getPrototypeOf 返回只读代理，防沿原型链拿到原生引用；
// - 枚举隔离：ownKeys + getOwnPropertyDescriptor 对 descriptor 的 value/get/set 再包装，
//   防 Object.getOwnPropertyDescriptors 直接吐出原生对象；
// - 方法强制 bound 到宿主 vm（防解构后 this 丢失 / 借 this 逃逸）+ 调用审计计数；
// - 防重复包装：WeakMap 双向缓存（raw→proxy / proxy→raw），重复访问 O(1) 且不阻断 GC。
// VaIMod 自身读写仍走内部控制面（VpnChannel 原生引用 + writeVariable 审核收口 + 零信任验证）。

const PROXY_TO_RAW = new WeakMap<object, unknown>(); // 沙盒代理 → 原生对象（参数解包用）
const RAW_TO_PROXY = new WeakMap<object, unknown>(); // 原生对象 → 沙盒代理（防重复包装）
// 函数代理缓存：按 (函数, 绑定宿主) 双层区分——同一原生函数（如 Array.prototype.push）
// 被多个宿主共享（arr1.push / arr2.push），若只按函数缓存会导致 this 错绑到首次包装的对象，
// 必须按宿主分桶；boundThis 缺省（自由函数）用哨兵 NULL_KEY 作 WeakMap 键。
const FN_CACHE = new WeakMap<object, WeakMap<object, unknown>>();
const NULL_KEY: object = {};
let sandboxCalls = 0;

// 变异方法黑名单：这些方法会改写目标自身（Array/Map/Set 常见变异操作）。
// 沙盒面是「只读视图」，调用它们一律拒绝（返回 false，不执行、不抛错，避免暴露沙盒存在）。
const MUTATORS = new Set<string>([
  // Array
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  // Map / Set
  'set', 'delete', 'clear', 'add',
]);

/** 沙盒审计计数：经沙盒的 vm 方法调用次数（链路健康度参考） */
export function getSandboxCallCount(): number {
  return sandboxCalls;
}

/** 是否为可包装的引用类型（object / function） */
function isObjectLike(v: unknown): v is object {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

/** 参数解包：调用方传入的沙盒代理还原为原生对象（防代理套娃、保证 vm 方法收到真实引用） */
function unproxy(v: unknown): unknown {
  if (isObjectLike(v)) {
    const raw = PROXY_TO_RAW.get(v as object);
    if (raw !== undefined) return raw;
  }
  return v;
}

/** 是否为会变异自身内容的容器（Array / Map / Set）——变异方法拦截的判定基础 */
function isMutableTarget(v: unknown): boolean {
  return Array.isArray(v) || v instanceof Map || v instanceof Set;
}

/**
 * 函数审计代理：apply / construct 双向隔离 + 调用计数 + 变异方法拦截。
 * - apply：参数解包、this 绑定（属性函数绑宿主，返回值函数透传解包后的 this）、返回值再包装；
 *   变异方法（MUTATORS）一律拒绝——双保险判定：
 *   ① 访问路径 methodName 命中（get 路径传入）；
 *   ② 函数自身 name 命中且调用目标 this（解包后）是 Array/Map/Set 容器——
 *      堵住经 getOwnPropertyDescriptor 取到函数后绕过 methodName 检查的调用路径。
 * - construct：new 走构造代理，构造结果再包装（防 new 逃逸）。
 * - get：函数自身的属性（prototype/静态字段）同样包装；caller/arguments 等受限属性访问
 *   返回 undefined 而不是抛错（防异常中断探测面）。
 */
function wrapFn(fn: Function, boundThis?: object, methodName?: string): unknown {
  // 按 (fn, 宿主) 双层缓存：同一原生函数不同宿主各自独立的代理，this 绑定互不串扰
  let bucket = FN_CACHE.get(fn as object);
  if (bucket === undefined) {
    bucket = new WeakMap<object, unknown>();
    FN_CACHE.set(fn as object, bucket);
  }
  const bKey: object = boundThis ?? NULL_KEY;
  const cached = bucket.get(bKey);
  if (cached !== undefined) return cached;

  const proxy = new Proxy(fn, {
    apply(_t, thisArg, args) {
      sandboxCalls++;
      // ① 访问路径名命中（get 路径，methodName 即属性名）
      if (methodName !== undefined && MUTATORS.has(methodName)) {
        return false;
      }
      // ② 函数自身 name 命中 + 目标为可变容器（descriptor 等无路径名场景的兜底）
      if (MUTATORS.has(fn.name) && isMutableTarget(boundThis ?? unproxy(thisArg))) {
        return false;
      }
      const nativeArgs = args.map(unproxy);
      const thisV = boundThis !== undefined ? boundThis : unproxy(thisArg);
      try {
        return wrapValue(Reflect.apply(fn, thisV, nativeArgs));
      } catch (e) {
        throw unproxy(e);
      }
    },
    construct(_t, args) {
      sandboxCalls++;
      const nativeArgs = args.map(unproxy);
      try {
        return wrapValue(Reflect.construct(fn, nativeArgs)) as object;
      } catch (e) {
        throw unproxy(e);
      }
    },
    get(_t, p) {
      try {
        return wrapValue(Reflect.get(fn, p, fn));
      } catch {
        // caller / arguments 等受限属性在严格模式函数上访问会抛 TypeError：静默返回 undefined
        return undefined;
      }
    },
  });

  bucket.set(bKey, proxy);
  PROXY_TO_RAW.set(proxy, fn);
  return proxy;
}

/**
 * 值统一包装：函数 → 审计代理，对象 → 只读递归代理，原始值原样返回。
 * （跨界对象永远以代理形态存在，原生引用不逃逸）
 */
function wrapValue(v: unknown, boundThis?: object, methodName?: string): unknown {
  if (typeof v === 'function') return wrapFn(v as Function, boundThis, methodName);
  if (v !== null && typeof v === 'object') return sandboxWrap(v as object);
  return v;
}

/** 递归包装：对象 → 只读沙盒代理（命中缓存则复用） */
function sandboxWrap(target: object): unknown {
  const cached = RAW_TO_PROXY.get(target);
  if (cached !== undefined) return cached;

  const proxy = new Proxy(target, {
    get(t, p) {
      // symbol 属性不再透传：统一包装（Symbol.iterator / toPrimitive / toStringTag 等一并隔离）
      const v = Reflect.get(t, p, t);
      return wrapValue(v, t, typeof p === 'string' ? p : undefined);
    },
    set() {
      // 只读：拒绝一切写入（防篡改 vm 状态/原型/挂钩子）
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    setPrototypeOf() {
      return false;
    },
    preventExtensions() {
      return false;
    },
    has(t, p) {
      return Reflect.has(t, p);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, p) {
      const desc = Reflect.getOwnPropertyDescriptor(t, p);
      if (!desc) return undefined;
      const out: PropertyDescriptor = {};
      if ('value' in desc) out.value = wrapValue(desc.value);
      if (desc.writable !== undefined) out.writable = desc.writable;
      if (desc.enumerable !== undefined) out.enumerable = desc.enumerable;
      if (desc.configurable !== undefined) out.configurable = desc.configurable;
      if (desc.get) out.get = wrapValue(desc.get) as () => unknown;
      if (desc.set) out.set = wrapValue(desc.set) as (v: unknown) => void;
      return out;
    },
    getPrototypeOf(t) {
      const proto = Reflect.getPrototypeOf(t);
      // 全局共享原型（Object/Function.prototype）直接返回，避免过度包装影响基础操作；
      // null 原样；其余原型返回只读代理，阻断沿原型链逃逸。
      if (proto === null || proto === Object.prototype || proto === Function.prototype) {
        return proto;
      }
      // Proxy invariant：目标不可扩展时 getPrototypeOf 必须返回真实 [[Prototype]]
      if (!Reflect.isExtensible(t)) return proto;
      return wrapValue(proto) as object;
    },
  });

  RAW_TO_PROXY.set(target, proxy);
  PROXY_TO_RAW.set(proxy, target);
  return proxy;
}

/**
 * 构建 vm 安全沙盒面：传入原生 vm，返回只读 + 双向代理隔离的沙盒对象。
 * （GandiVM 结构 + secure-vm 双代理思路的结合实现）
 */
export function sandboxVm(vm: unknown): unknown {
  if (!isObjectLike(vm)) return vm;
  return sandboxWrap(vm as object);
}
