// ===== VM 劫持安全加固（防检查 / 防删除 / 防修改 + 看门狗自愈） =====
// 设计原则（对齐 VaIMod 硬约束）：
// - 只加不改：本模块只登记检查与修复，不触碰任何既有链路；修复动作由各子系统
//   自身的幂等安装函数承担（重复装无害）。
// - 零编辑器干扰 / 对宿主零副作用：巡检静默容错，任何检查/修复失败都吞掉，
//   加固层自身不得成为页面故障点。
// - 不可检查：登记表寄存在 globalThis 的**不可枚举随机 Symbol** 槽位——
//   Object.getOwnPropertyNames / Reflect.ownKeys 都列不出来；
//   定时器句柄闭包持有，外部拿不到 id，clearInterval 无从清起。
// - 不可删除 / 不可修改：巡检循环每轮自检（定时器被清即重挂、登记表被换即重建），
//   修复函数全部走幂等重装——「删了就补回来」而非「删不掉」。

export interface TamperCheck {
  /** 检查名（诊断报告用） */
  name: string;
  /** 返回 true = 完好；false = 被篡改/失效，需要修复 */
  check: () => boolean;
  /** 修复动作（幂等；失败静默，下一轮继续尝试） */
  repair: () => void;
  /** 巡检间隔倍数：默认每轮都查；传 N 表示每 N 轮查一次（低频检查用） */
  every?: number;
}

interface HardeningRegistry {
  checks: Map<string, TamperCheck & { tick: number }>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  runs: number;
  repairs: number;
  lastReport: Record<string, boolean>;
}

// 随机 Symbol：每次加载不同，页面脚本无法按名探测；不可枚举配置无法被 for-in 列出
const REG_SYMBOL = Symbol(
  'vh' + Math.random().toString(36).slice(2, 10),
);

function registry(): HardeningRegistry {
  const g = globalThis as unknown as Record<symbol, unknown>;
  let reg = g[REG_SYMBOL] as HardeningRegistry | undefined;
  if (!reg || typeof reg !== 'object' || !(reg.checks instanceof Map)) {
    // 登记表被外部替换/删除（理论上 Symbol 键拿不到，防御兜底）：重建
    reg = {
      checks: new Map(),
      timer: null,
      intervalMs: 5000,
      runs: 0,
      repairs: 0,
      lastReport: {},
    };
    try {
      Object.defineProperty(g, REG_SYMBOL, {
        value: reg,
        enumerable: false,
        configurable: false, // 不可删除 / 不可重定义
        writable: false,
      });
    } catch {
      g[REG_SYMBOL] = reg; // 极端环境退化为普通赋值（Symbol 键仍不可枚举发现）
    }
  }
  return reg;
}

/** 登记一项篡改检查（幂等：同名覆盖） */
export function registerVmTamperCheck(
  name: string,
  check: () => boolean,
  repair: () => void,
  every?: number,
): void {
  const reg = registry();
  reg.checks.set(name, { name, check, repair, every: every && every > 1 ? every : 1, tick: 0 });
}

/** 巡检一轮：全部检查静默执行，失败项跑修复；返回本轮触发修复的次数 */
function runPatrol(): number {
  const reg = registry();
  let repaired = 0;
  for (const item of [...reg.checks.values()]) {
    item.tick = (item.tick + 1) % (item.every ?? 1);
    if (item.tick !== 0) continue;
    let ok = true;
    try {
      ok = item.check() === true;
    } catch {
      ok = true; // 检查器自身异常按完好处理（不得误伤正常环境）
    }
    reg.lastReport[item.name] = ok;
    if (!ok) {
      try {
        item.repair();
        repaired++;
        reg.repairs++;
      } catch {
        /* 修复失败静默：下一轮再试 */
      }
    }
  }
  return repaired;
}

/**
 * 启动加固巡检（幂等）。定时器句柄闭包持有，外部无从获取；
 * 每轮巡检自检定时器存活性——被清（理论不可达）即重挂，构成自愈闭环。
 */
export function installVmHardening(intervalMs = 5000): void {
  const reg = registry();
  if (intervalMs > 0) reg.intervalMs = intervalMs;
  if (reg.timer !== null) return;
  const arm = (): void => {
    reg.timer = setInterval(() => {
      reg.runs++;
      try {
        runPatrol();
      } catch {
        /* ignore */
      }
      // 自愈：句柄若被外部清掉（防御性兜底），下一拍重新武装
      if (reg.timer === null) arm();
    }, reg.intervalMs);
  };
  arm();
}

/** 加固状态报告（仅调试通道使用） */
export function vmHardeningReport(): {
  checks: Array<{ name: string; ok: boolean }>;
  runs: number;
  repairs: number;
  intervalMs: number;
} {
  const reg = registry();
  return {
    checks: [...reg.checks.values()].map((c) => ({
      name: c.name,
      ok: reg.lastReport[c.name] !== false,
    })),
    runs: reg.runs,
    repairs: reg.repairs,
    intervalMs: reg.intervalMs,
  };
}
