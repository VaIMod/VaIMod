// ===== 早期作品捕获（document-start 级，抢在站点初始 loadProject 之前） =====
//
// 站点进入编辑器时通常在页面加载早期就调用 vm.loadProject 载入作品，而
// ScratchVM 桥接层的轮询发现要等到 onIdle + pollInterval（≥1.5s）之后——
// 仅靠 bindVM 时的包装必然错过初始加载，盗作神器等插件的捕获列表会一直为空。
// 本模块在脚本注入的第一毫秒起用 25ms 轻量轮询盯 window.vm 的出现，命中即给
// loadProject 装捕获包装（与 bridge 版完全一致的伪装三件套），把初始作品也收进
// 环形缓冲；桥接层构造后停轮询并收割存量、转发增量。
//
// 与 Cave 事故铁律的边界：这里不做「伪装 loadProject / 拒载」——包装是纯旁路
// 透传（记录入参后原样调用原函数），window.vm 属性形状零改动，站点行为不受影响。
// 安装位置由 lp-guard 统一决定：挂 vm 的直接原型。若挂在实例上（哪怕 defineProperty
// 非枚举），数字签名家的 _checkEnv 会用 hasOwnProperty 判成「loadProject 被篡改」
// → 触发 stopAll + while(true) 死循环。
import { installLoadProjectTap } from './lp-guard';
import { captureFromLoadInput } from './project-export';

export interface EarlyCaptureEntry {
  id: number;
  time: number;
  size: number;
  name: string;
  blob: Blob;
}

const EARLY_CAP = 8;
const POLL_MS = 25;
const POLL_MAX_MS = 10_000;

let seq = 0;
let enabled = true;
let stopped = false;
let harvested = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const entries: EarlyCaptureEntry[] = [];
const listeners = new Set<(e: EarlyCaptureEntry) => void>();
const wrappedVms = new WeakSet<object>();

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function makeEntry(input: unknown): EarlyCaptureEntry | null {
  try {
    const made = captureFromLoadInput(input);
    if (!made || made.size <= 0) return null;
    const d = new Date();
    const name = `project-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.sb3`;
    return { id: ++seq, time: d.getTime(), size: made.size, name, blob: made.blob };
  } catch {
    return null;
  }
}

/** 旁路记录 loadProject 入参（收割前进环形缓冲，收割后只实时通知）。 */
function recordEarlyCapture(input: unknown): void {
  if (!enabled) return;
  const entry = makeEntry(input);
  if (!entry) return;
  if (!harvested) {
    entries.push(entry);
    while (entries.length > EARLY_CAP) entries.shift();
  }
  for (const l of [...listeners]) {
    try {
      l(entry);
    } catch {
      /* ignore */
    }
  }
}

/** 给 vm.loadProject 装早期捕获包装（原型级安装，伪装细节见 lp-guard）。 */
export function wrapVmLoadProjectEarly(vm: object): boolean {
  if (stopped) return false;
  const holder = vm as { loadProject?: unknown };
  if (!holder || typeof holder.loadProject !== 'function' || wrappedVms.has(vm)) return false;
  // 标记必须与「安装真的成功」绑定：installLoadProjectTap 会失败（典型场景是
  // loadProject 被定义成访问器——上面 typeof holder.loadProject === 'function'
  // 能过，但 lp-guard 的 findNative 只认数据描述符 → 返回 null）。
  // 先标后装在失败时会让 earlyWrapped(vm) 恒为 true，bridge 据此**跳过自己的 tap**
  // （scratch-vm 侧逻辑）→ 「作品捕获」整条链永久为空，且轮询因 wrappedVms 命中而白跑。
  const ok = installLoadProjectTap(vm, (input) => recordEarlyCapture(input));
  if (ok) wrappedVms.add(vm);
  return ok;
}

function scanOnce(): boolean {
  try {
    const vm = (globalThis as { vm?: unknown }).vm;
    if (vm && typeof vm === 'object' && wrapVmLoadProjectEarly(vm as object)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** document-start 调用：开装早期盯梢。vm 已在则立即包，否则 25ms 轮询等待。 */
export function installEarlyCaptureWatch(): void {
  if (stopped || pollTimer) return;
  if (scanOnce()) return;
  const startedAt = Date.now();
  pollTimer = setInterval(() => {
    if (scanOnce() || Date.now() - startedAt > POLL_MAX_MS) stopEarlyCapturePoll();
  }, POLL_MS);
}

/** 桥接层构造后调用：停轮询（此后包装统一归 bridge 的 tick 补挂管，防双包装）。 */
export function stopEarlyCapturePoll(): void {
  stopped = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** vm 是否已被早期包装（bridge 据此跳过自身包装，避免双层）。 */
export function earlyWrapped(vm: object): boolean {
  return wrappedVms.has(vm);
}

/** 收割早期存量捕获（清空缓冲，bridge 合并进自己的捕获列表）。 */
export function takeEarlyEntries(): EarlyCaptureEntry[] {
  return entries.splice(0, entries.length);
}

/** 订阅早期捕获事件（收割后 bridge 靠它实时接续增量）。 */
export function onEarlyCaptured(cb: (e: EarlyCaptureEntry) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** bridge 收割完成后标记：early 不再落盘（只实时通知），避免双份内存。 */
export function markEarlyHarvested(): void {
  harvested = true;
}

/** 早期捕获开关（与 bridge 的 captureEnabled 联动；关闭即清空早期缓冲）。 */
export function setEarlyCaptureEnabled(v: boolean): void {
  enabled = v;
  if (!v) entries.length = 0;
}
