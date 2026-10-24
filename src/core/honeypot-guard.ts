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

// window 假 vm 泄漏属性名（【v34 退役】不再布设——保留常量仅为文档化历史威胁模型）

const HEARTBEAT_MS = 8000;
const STRIKE_RECYCLE_THRESHOLD = 4;
const RECYCLE_COOLDOWN_MS = 20000;

// 内网诱饵节点：样式完全不可见，不打扰真实用户（display:none + 离屏 + 无指针事件）
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

/**
 * 布设单个诱饵并插入 body；不布设时返回 null。
 * `#id` 形态多一步：**已存在同名元素就直接放弃**——重复 id 会让
 * `document.getElementById` 返回我们的隐形诱饵，站点自己的面板逻辑会操作到错的节点，
 * secure-guard / sig-guard 的「回滚 inline 隐藏」也会打在诱饵上而不是真元素。
 */
function plantOne(sel: string): HTMLElement | null {
  if (sel.startsWith('#')) {
    try {
      if (document.getElementById(sel.slice(1))) return null;
    } catch {
      return null;
    }
  }
  const el = spawnDecoyFor(sel);
  // 随机插入位置（让敌人无法靠"固定在 body 末尾"定位我们的宿主规律）
  const kids = document.body.children;
  const idx = (Math.random() * (kids.length + 1)) | 0;
  if (idx >= kids.length) document.body.appendChild(el);
  else document.body.insertBefore(el, kids[idx]);
  return el;
}

function plantDecoys(): void {
  if (!document.body) return;
  // 每类选择器精确布设 1 个诱饵，全部不可见、互不干扰
  for (const sel of DECOY_SELECTORS) {
    if (decoyNodes.has(sel)) continue;
    try {
      const el = plantOne(sel);
      if (el) decoyNodes.set(sel, el);
    } catch {
      decoyNodes.delete(sel);
    }
  }
  state.domDecoys = decoyNodes.size;
}

// ---------- B) 对内陷阱：window 假 vm 泄漏属性（getter/setter 陷阱） ----------
// 【v34 退役】三类 VM 泄漏键诱饵（__scratchCoreRef__/__vmLeakBackup__/_vmCoreMirror_）
// 不再布设。实测代价>收益：审计扩展（YinSecurity）的扫描清单恰好逐个
// getOwnPropertyDescriptor 这三个键——诱饵从「钓攻击者」变成「给审计方递确认」，
// 违背「不能被检测到」的一票否决约束。DOM 诱饵保留（display:none + 通用
// 修改器特征名，不可枚举扫描命中，防销毁职责不变）；真 VM 防泄露由
// closed shadow + 沙盒桥 + 全局零残留承担（本就不依赖这几枚诱饵）。
function plantWindowDecoys(): void {
  /* retired: 见上方 v34 退役说明 */
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
        const el = plantOne(sel);
        if (el) decoyNodes.set(sel, el);
      } catch {
        /* ignore */
      }
    }
    state.domDecoys = decoyNodes.size;
    if (hit) strike();
    // 【v34】window VM 键诱饵已退役（见 plantWindowDecoys 处说明）——
    // 不再布设、也不再补种；审计扫描下 window 保持与原生页面同形。
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
