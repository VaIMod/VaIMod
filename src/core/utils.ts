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
  return (
    typeof vm.setVariableValue === 'function' &&
    typeof vm.getVariableValue === 'function' &&
    vm.runtime !== undefined &&
    typeof (vm.runtime as { targets?: unknown }).targets !== 'undefined'
  );
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

export function findVmViaFiber(): unknown {
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

  for (const el of candidates) {
    // fiber key 兼容 __reactContainer$（React 18 createRoot 挂在容器上的容器键，CSRT 同款）
    const fiberKey = Object.keys(el).find(
      (k) =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$') ||
        k.startsWith('__reactContainer$'),
    );
    if (!fiberKey) continue;
    const start = (el as unknown as Record<string, unknown>)[fiberKey];
    if (!start || typeof start !== 'object') continue;
    const vm = scanFiberFromNode(start as object);
    if (vm) return vm;
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
