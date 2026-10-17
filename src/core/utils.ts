import type { ScratchValue, VariableValue } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 显示净化：变量名/云数据名在渲染前剥掉控制字符与零宽字符（保留 \n \t \r）。
// 目的：名称来自页面（不可信输入），控制字符会让文本显示与 aria-label 变形，
// 零宽字符可制造「看起来同名」的伪装；仅影响显示层，不改 vm / 云端的真实名。
const DISPLAY_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;

export function cleanDisplay(name: unknown): string {
  if (name === null || name === undefined) return '';
  return String(name).replace(DISPLAY_CTRL_RE, '');
}

export function isVMLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const vm = value as Record<string, unknown>;
  if (typeof vm.setVariableValue !== 'function' || typeof vm.getVariableValue !== 'function') {
    return false;
  }
  // runtime 为 null（页面侧半残假 vm / 站点摘除 runtime）时不能抛异常：
  // 旧实现 `vm.runtime.targets` 在 runtime === null 时抛 TypeError，
  // 且 discoverVM 调用它无 try 保护 → 整条发现链被打断、桥接永久 Error 态。
  if (vm.runtime === undefined || vm.runtime === null) return false;
  try {
    return typeof (vm.runtime as { targets?: unknown }).targets !== 'undefined';
  } catch {
    // runtime 是 getter 且访问抛异常 → 按 vm-like 否处理（不得让异常打断发现循环）
    return false;
  }
}

function scanFiberFromNode(node: object): unknown {
  const seen = new Set<object>();
  const queue: object[] = [node];
  let budget = 200_000;

  while (queue.length && budget-- > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);

    // 提取策略（对齐 CSRT _findVMInFiber 的五路，覆盖 CCW 不同页面结构的挂载差异）：
    // ① memoizedProps.vm（最常见：VM 直接作为组件 prop 传入）
    // ② memoizedProps.scratchGui.vm（gui 状态整体作为 prop）
    // ③ stateNode 本身是 VM（类组件直接持有）
    // ④ stateNode.state.scratchGui.vm（类组件 state 持 gui）
    // ⑤ memoizedState 链表逐节点找 state.scratchGui.vm（hooks 组件，链深上限 30）
    const memoizedProps = (cur as { memoizedProps?: unknown }).memoizedProps as
      | Record<string, unknown>
      | undefined;
    if (memoizedProps) {
      if (isVMLike(memoizedProps.vm)) return memoizedProps.vm;
      const gui = memoizedProps.scratchGui as { vm?: unknown } | undefined;
      if (gui && isVMLike(gui.vm)) return gui.vm;
    }

    const stateNode = (cur as { stateNode?: unknown }).stateNode as
      | (Record<string, unknown> & { state?: { scratchGui?: { vm?: unknown } } })
      | undefined;
    if (stateNode && typeof stateNode === 'object') {
      if (isVMLike(stateNode)) return stateNode;
      const gui = stateNode.state?.scratchGui;
      if (gui && isVMLike(gui.vm)) return gui.vm;
    }

    const memoizedState = (cur as { memoizedState?: unknown }).memoizedState;
    if (memoizedState && typeof memoizedState === 'object') {
      let node2 = memoizedState as Record<string, unknown> & {
        next?: unknown;
        state?: { scratchGui?: { vm?: unknown } };
      };
      for (let depth = 0; node2 && depth < 30; depth++) {
        const gui = node2.state?.scratchGui;
        if (gui && isVMLike(gui.vm)) return gui.vm;
        node2 = (node2.next ?? null) as typeof node2;
      }
    }

    const fiber = cur as {
      return?: unknown;
      child?: unknown;
      sibling?: unknown;
    };
    if (fiber.return) queue.push(fiber.return as object);
    if (fiber.child) queue.push(fiber.child as object);
    if (fiber.sibling) queue.push(fiber.sibling as object);
  }
  return null;
}

/** 收集 React 根容器元素（fiber 通道 / redux 通道共用） */
function collectReactRoots(): Element[] {
  const candidates: Element[] = [];
  // CSRT 同款：window.root（CCW 挂 React 根到 window.root 的场景）优先于 DOM 查找
  const winRoot = (window as unknown as { root?: unknown }).root;
  if (winRoot instanceof Element) candidates.push(winRoot);
  const app = document.getElementById('app');
  if (app) candidates.push(app);
  const root = document.getElementById('root');
  if (root && root !== app) candidates.push(root);

  // 兜底：不同站点 React 根节点 id 可能不同，扫描常见根标记与 fiber key
  if (candidates.length === 0) {
    let budget = 4096;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && budget-- > 0; i++) {
      const el = all[i];
      if (!el) continue;
      if (el.hasAttribute('data-reactroot')) {
        candidates.push(el);
        break;
      }
      const keys = Object.keys(el);
      let found = false;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          candidates.push(el);
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  return candidates;
}

/** 在根容器元素上定位全部 fiber 起点 key（React 16/17/18 三代键名兼容）。
 * 站点重建/热更新可能在同一元素残留多个 fiber key（旧的指向死树），
 * 只取第一个会被旧 key 遮蔽 → 必须返回全部、逐个尝试。 */
function fiberKeysOf(el: Element): string[] {
  return Object.keys(el).filter(
    (k) =>
      k.startsWith('__reactFiber$') ||
      k.startsWith('__reactInternalInstance$') ||
      k.startsWith('__reactContainer$'),
  );
}

export function findVmViaFiber(): unknown {
  const candidates = collectReactRoots();

  for (const el of candidates) {
    for (const fiberKey of fiberKeysOf(el)) {
      const start = (el as unknown as Record<string, unknown>)[fiberKey];
      if (!start || typeof start !== 'object') continue;
      const vm = scanFiberFromNode(start as object);
      if (vm) return vm;
    }
  }

  // React DevTools hook 通道（CSRT 同款）：React 根不在常见容器时从 DevTools 全局钩子取
  try {
    const hook = (window as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        getFiberRoots?: (rendererId: number) => Set<{ current?: object }>;
      };
    }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const roots = hook?.getFiberRoots?.(1);
    if (roots && typeof roots.forEach === 'function') {
      let found: unknown = null;
      roots.forEach((rootEntry) => {
        if (found || !rootEntry?.current) return;
        found = scanFiberFromNode(rootEntry.current);
      });
      if (found) return found;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---- Redux store 通道（VM 发现优先级第 1 位） ----

/**
 * 从 redux store 提取 vm：getState 后定向取 state.scratchGui.vm
 * （scratch-gui 标准挂载点），未命中再浅扫 state 顶层值（非标准宿主
 * 可能挂在其它键下；只扫一层，控成本）。
 */
function vmFromStore(store: unknown): unknown {
  try {
    const s = store as { getState?: () => unknown } | null;
    if (!s || typeof s.getState !== 'function') return null;
    const state = s.getState();
    if (!state || typeof state !== 'object') return null;
    const direct = (state as { scratchGui?: { vm?: unknown } }).scratchGui;
    if (direct && isVMLike(direct.vm)) return direct.vm;
    for (const v of Object.values(state as Record<string, unknown>)) {
      if (isVMLike(v)) return v;
      if (v && typeof v === 'object') {
        const gui = (v as { scratchGui?: { vm?: unknown } }).scratchGui;
        if (gui && isVMLike(gui.vm)) return gui.vm;
      }
    }
  } catch {
    /* getState 可能是 getter / store 是 Proxy，异常按无处理 */
  }
  return null;
}

/** 站点可能把 redux store 暴露为全局的常见键名 */
const WINDOW_STORE_KEYS = ['store', '__store', 'reduxStore', '__reduxStore__', '__REDUX_STORE__'] as const;

function isStoreShaped(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { getState?: unknown }).getState === 'function'
  );
}

/**
 * fiber 树内找 Provider store：react-redux <Provider store={store}> 把 store
 * 作为 prop 注入根组件，BFS 遍历 fiber 树检查 memoizedProps.store / reduxStore。
 * 预算独立且小于 vm 扫描（store 必在树的上层，命中通常在前几十个节点）。
 */
function scanFiberForStore(start: object): unknown {
  const seen = new Set<object>();
  const queue: object[] = [start];
  let budget = 50_000;
  while (queue.length && budget-- > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const props = (cur as { memoizedProps?: unknown }).memoizedProps as
      | Record<string, unknown>
      | undefined;
    if (props) {
      const store = props.store ?? props.reduxStore;
      if (isStoreShaped(store)) {
        const vm = vmFromStore(store);
        if (vm) return vm;
      }
    }
    const fiber = cur as { return?: unknown; child?: unknown; sibling?: unknown };
    if (fiber.return) queue.push(fiber.return as object);
    if (fiber.child) queue.push(fiber.child as object);
    if (fiber.sibling) queue.push(fiber.sibling as object);
  }
  return null;
}

/**
 * Redux store 通道：① window 挂载的 store 全局 → ② fiber 树内 Provider store
 * → ③ DevTools hook 根同样扫一遍 store。三路全空返回 null，由下一优先级通道接管。
 */
export function findVmViaRedux(): unknown {
  const w = window as unknown as Record<string, unknown>;
  // ① 全局 store
  for (const k of WINDOW_STORE_KEYS) {
    try {
      if (isStoreShaped(w[k])) {
        const vm = vmFromStore(w[k]);
        if (vm) return vm;
      }
    } catch {
      /* ignore */
    }
  }
  // ② fiber Provider store
  for (const el of collectReactRoots()) {
    for (const fiberKey of fiberKeysOf(el)) {
      const start = (el as unknown as Record<string, unknown>)[fiberKey];
      if (!start || typeof start !== 'object') continue;
      const vm = scanFiberForStore(start as object);
      if (vm) return vm;
    }
  }
  // ③ DevTools hook 根
  try {
    const hook = (window as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        getFiberRoots?: (rendererId: number) => Set<{ current?: object }>;
      };
    }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const roots = hook?.getFiberRoots?.(1);
    if (roots && typeof roots.forEach === 'function') {
      let found: unknown = null;
      roots.forEach((rootEntry) => {
        if (found || !rootEntry?.current) return;
        found = scanFiberForStore(rootEntry.current as object);
      });
      if (found) return found;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function normalizeValue(value: unknown): ScratchValue {
  if (Array.isArray(value)) return value as VariableValue[];
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return value === undefined || value === null ? '' : String(value);
}

export function listValueToString(value: unknown): string {
  if (!Array.isArray(value)) return String(value ?? '');
  return value.map((item) => String(item)).join(', ');
}

export function stringToListValue(input: string): VariableValue[] {
  return input.split(',').map((item) => {
    const s = item.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
    return s;
  });
}

export function coerceValue(
  input: string,
  current: string | number | boolean,
): string | number | boolean {
  if (typeof current === 'number') {
    const n = Number(input);
    return Number.isNaN(n) ? current : n;
  }
  if (typeof current === 'boolean') {
    return input === 'true';
  }
  return input;
}
