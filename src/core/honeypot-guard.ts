// ===== 蜜罐陷阱防检测层（Honeypot Guard） =====
// 目的：让敌扩展/检测器的"找修改器 → 清空/隐藏/删除"动作打在【假目标】上，
//      而不是打在 VaIMod 真身上；同时感知攻击并触发自愈轮换。
//
// 双路布防（针对敌反作弊扩展的真实行为链）：
//   A) 对外诱饵（DOM）：敌扩展 removeUI/UI 隐藏 用 querySelectorAll 找第三方修改器 UI，
//      其命中特征（.spectre-window / div[data-hack-intent] / #spd-toolbar 等）正是我们
//      布设假节点的选择器 —— 它 remove 到的是诱饵，真身（closed shadow）毫发无伤；
//   B) 对内陷阱（window 假 vm）：敌扩展 scanVMLeak 遍历全局找「长得像 vm 泄漏」的对象，
//      我们布设 getter/setter 陷阱属性（形如 { runtime:{ targets:[] } }），
//      任何读(get)/写(set) 都被计数并喂空数据；delete 因 configurable:false 静默失败。
//
// 自愈：心跳周期检查诱饵存活；被移除 → 攻击计数并自动重植（随机插入位置/随机 id 后缀）。
//      攻击计数达阈值 → vpnRecycle()（密钥/token/遮罩全轮换），让敌扩展刚定位的
//      静态特征全部失效（防二次定位/防特征积累）。
//
// 性能：零热路径开销 —— 无轮询遍历、无大 MO；仅 8s 心跳检查十几个节点的存在性（O(n) 极小）。
// 零特征泄露：本模块自身不向页面暴露任何 VaIMod 命名特征；陷阱名字全部取自敌方选择器/通用泄漏形态。
import { vpnRecycle } from './vpn-registry';

// 敌方 removeUI 隐藏第三方修改器 UI 时使用的命中选择器（与 secure-guard HIDE_CSS_MARKERS 对齐；
// 我们主动用它们当诱饵 id/class，让敌人删除动作指向假目标）
const DECOY_SELECTORS = [
  '.spectre-window',
  'div[data-hack-intent]',
  '.csense-window',
  '#spd-toolbar',
  '#spd-open',
  '#scratch-variable-panel',
  '.rd-modal-root-container',
];

// window 假 vm 泄漏属性名（通用泄漏形态；先探测占用，命中则不布设避免破坏页面真实全局）
const VM_DECOY_KEYS = ['__scratchCoreRef__', '__vmLeakBackup__', '_vmCoreMirror_'];

const HEARTBEAT_MS = 8000;
const STRIKE_RECYCLE_THRESHOLD = 4;
const RECYCLE_COOLDOWN_MS = 20000;

// 内网诱饵节点：样式完全不可见，绝不打扰真实用户（display:none + 离屏 + 无指针事件）
const DECOY_CSS =
  'position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;' +
  'opacity:0;pointer-events:none;z-index:-2147483647;';

interface HoneyState {
  domDecoys: number;
  windowDecoys: number;
  strikes: number;
  recycles: number;
  lastStrikeAt: number;
}

const state: HoneyState = {
  domDecoys: 0,
  windowDecoys: 0,
  strikes: 0,
  recycles: 0,
  lastStrikeAt: 0,
};

let installed = false;
let heartbeat: number | null = null;
let lastRecycleAt = 0;
// 当前在 DOM 中的诱饵节点（Map<选择器, 节点>：心跳判断存活 + 按缺失项精确重植）
let decoyNodes = new Map<string, HTMLElement>();

/** 攻击计数（节流：同一瞬间的批量 remove 只记一次） */
function strike(): void {
  const now = Date.now();
  if (now - state.lastStrikeAt < 400) return; // 批量删除合并为一次攻击
  state.lastStrikeAt = now;
  state.strikes++;
  maybeRecycle();
}

/** 攻击达阈值 → 全 VPN 轮换（节流防抖） */
function maybeRecycle(): void {
  const now = Date.now();
  if (state.strikes < STRIKE_RECYCLE_THRESHOLD) return;
  if (now - lastRecycleAt < RECYCLE_COOLDOWN_MS) return;
  lastRecycleAt = now;
  state.strikes = 0; // 已处置
  try {
    vpnRecycle();
    state.recycles++;
  } catch {
    /* ignore */
  }
}

// ---------- A) 对外诱饵：假「第三方修改器 UI」DOM 节点 ----------
// 诱饵的 class/id 必须【精确】等于敌人 removeUI 的选择器特征（.spectre-window / [data-hack-intent] 等），
// 这样敌扩展 querySelectorAll(...).forEach(remove) 时删掉的是诱饵而非真身（真身在 closed shadow 不可见）。
// 真正的 UI 不受影响：这些特征名只用于诱饵，VaIMod 真 UI 从不使用它们。
function spawnDecoyFor(sel: string): HTMLElement {
  const el = document.createElement('div');
  const marker = sel.replace(/^[.#]/, '').replace(/^div\[([^\]]+)\]$/, '$1');
  const attrOnly = sel.startsWith('div[');
  if (attrOnly) {
    const pair = marker.split('=');
    const name = pair[0];
    const val = (pair[1] ?? '').replace(/^["']|["']$/g, '');
    el.setAttribute(name, val || '');
  } else if (sel.startsWith('#')) {
    el.id = marker;
  } else {
    el.className = marker;
  }
  // 内嵌伪 UI 骨架，让「长得像修改器面板」更可信（内容是惰性占位，无任何真实逻辑）
  el.style.cssText = DECOY_CSS;
  el.setAttribute('data-role', 'placeholder');
  return el;
}

function spawnDecoy(): HTMLElement {
  const sel = DECOY_SELECTORS[(Math.random() * DECOY_SELECTORS.length) | 0];
  return spawnDecoyFor(sel);
}

function plantDecoys(): void {
  if (!document.body) return;
  // 每类选择器精确布设 1 个诱饵，全部不可见、互不干扰
  for (const sel of DECOY_SELECTORS) {
    if (decoyNodes.has(sel)) continue;
    try {
      const el = spawnDecoyFor(sel);
      decoyNodes.set(sel, el);
      // 随机插入位置（让敌人无法靠"固定在 body 末尾"定位我们的宿主规律）
      const kids = document.body.children;
      const idx = (Math.random() * (kids.length + 1)) | 0;
      if (idx >= kids.length) document.body.appendChild(el);
      else document.body.insertBefore(el, kids[idx]);
    } catch {
      decoyNodes.delete(sel);
    }
  }
  state.domDecoys = decoyNodes.size;
}

// ---------- B) 对内陷阱：window 假 vm 泄漏属性（getter/setter 陷阱） ----------
function plantWindowDecoys(): void {
  const win = globalThis as unknown as Record<string, unknown>;
  for (const key of VM_DECOY_KEYS) {
    try {
      // 页面真实全局占用同名 → 跳过（不破坏宿主）
      const existing = Object.getOwnPropertyDescriptor(win, key);
      if (existing && existing.value !== undefined && !existing.get) continue;
      // 陷阱：读 → 返回"假 vm 泄漏"（空运行时）；写 → 计数并忽略；删 → 静默失败
      const decoy = {
        runtime: { targets: [], extensions: new Map<string, unknown>() },
        targets: [],
        // 再挂一层容易误导的假数据
        _getValueFromProject: () => undefined,
        _setValueToProject: () => Promise.resolve(undefined),
      };
      Object.defineProperty(win, key, {
        configurable: false, // delete 静默失败 → 敌人无法移除陷阱
        enumerable: true, // 可被 for..in / Object.keys 扫到 → 诱导 scanVMLeak 命中
        get: () => {
          // 读取不计数（页面正常遍历 window 也会触发，避免噪音）；
          // 敌人读到的是假 vm，读多少次都无害 —— 防护在"给假数据"本身。
          return decoy;
        },
        set: () => {
          strike(); // 尝试覆盖/污染全局引用 = 明确的敌意行为
          // 拒绝替换，喂假数据也不让属性被污染
        },
      });
      state.windowDecoys++;
    } catch {
      /* ignore */
    }
  }
}

/** 心跳：诱饵存活检查 + 被移除自动重植（DOM 节点可能被敌人 remove 掉） */
function tick(): void {
  try {
    if (!document.body) return;
    // DOM 诱饵存活检查：被敌人 remove 的节点按缺失选择器精确重植
    let hit = false;
    for (const [sel, node] of [...decoyNodes]) {
      if (node.isConnected) continue;
      hit = true;
      decoyNodes.delete(sel);
      // 立即重植（同一次心跳内补齐，界面感知不到缺失窗口）
      try {
        const el = spawnDecoyFor(sel);
        decoyNodes.set(sel, el);
        const kids = document.body.children;
        const idx = (Math.random() * (kids.length + 1)) | 0;
        if (idx >= kids.length) document.body.appendChild(el);
        else document.body.insertBefore(el, kids[idx]);
      } catch {
        /* ignore */
      }
    }
    state.domDecoys = decoyNodes.size;
    if (hit) strike();
    // window 陷阱属性是否仍在（configurable:false 理论删不掉；万一被更强的敌人以 redefine 移除则补种）
    const win = globalThis as unknown as Record<string, unknown>;
    let missingWindows = 0;
    for (const key of VM_DECOY_KEYS) {
      const d = Object.getOwnPropertyDescriptor(win, key);
      if (!d || (d.value === undefined && !d.get)) missingWindows++;
    }
    if (missingWindows > 0) plantWindowDecoys();
  } catch {
    /* ignore */
  }
}

/** 蜜罐报告（调试桥用；默认零暴露） */
export function honeypotReport(): HoneyState {
  return { ...state };
}

/** 总装（document-start 幂等；window 陷阱立即布设，DOM 诱饵等 body 就绪） */
export function installHoneypotGuard(): void {
  if (installed) return;
  installed = true;
  try {
    plantWindowDecoys();
  } catch {
    /* ignore */
  }
  const tryDom = (): void => {
    try {
      if (document.body) {
        plantDecoys();
        return;
      }
    } catch {
      /* ignore */
    }
    setTimeout(tryDom, 200);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryDom, { once: true });
  } else {
    tryDom();
  }
  if (heartbeat === null) {
    heartbeat = window.setInterval(tick, HEARTBEAT_MS);
  }
}
