// 本地重命名配置（仅显示层）：把「真实变量名 → 本地显示名」写成可读、可手改、可分享的 JSON。
//
// 语义边界（务必守住）：
//   · **绝不新建变量、绝不改作品里的变量名** —— 对项目零影响，只改面板里显示什么。
//   · 本模块**不 import 任何 vm / bridge**，从依赖层面杜绝「顺手写回变量」的可能。
//
// 与 display-names.ts 的分工：
//   display-names.ts  —— 手动改单条别名，键 = `v:<targetId>:<变量id>`（按 id）
//   alias-config.ts   —— 规则表，键 = **真实变量名**（按名匹配）
// 为什么需要两层：配置 JSON 要给人读、要能手写、要在**拿到变量 id 之前**就能加载，
// 只能按名写；而用户手动改的那一条必须精确锁定到具体变量，只能按 id 存。
// 显示优先级：手动别名（按 id） > 规则表（按名） > 原名。

/** 单条重命名规则 */
export interface AliasRule {
  /** 真实变量名（混淆名）；支持 `*` 通配（如 `n95*`） */
  match: string;
  /** 本地显示名 */
  label: string;
  /** 限定作用角色（targetName，如 'Stage' / 'player'）；省略或 'any' 表示不限 */
  scope?: string;
  /** 备注（不参与匹配，只为人读） */
  note?: string;
}

export interface AliasConfig {
  version: number;
  name: string;
  source: string;
  enabled: boolean;
  rules: AliasRule[];
}

/** 存储键运行时拼接，避免明文特征（与 display-names.ts 同一习惯） */
const STORE_KEY = ['vai', 'mod', '_alias', 'cfg'].join('');

/**
 * 规模上限：配置来自任意 JSON 文件，超大文件会让面板卡死。
 * 超限直接整份拒绝（不截断），避免「半份配置生效」这种难排查的中间态。
 */
export const ALIAS_LIMITS = {
  maxRules: 5000,
  maxKeyLen: 256,
  maxLabelLen: 256,
  maxNoteLen: 512,
  maxJsonBytes: 2_000_000,
} as const;

/** 危险键：防止原型污染（flat 形式的配置允许任意键名） */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EMPTY: AliasConfig = {
  version: 1,
  name: '',
  source: '',
  enabled: true,
  rules: [],
};

let cache: AliasConfig | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响其它 */
    }
  }
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function isBadKey(k: string): boolean {
  return BAD_KEYS.has(k);
}

/** 把各种形态的输入规整成规则数组；不认识的一律丢弃（不抛错） */
function coerceRules(raw: unknown): AliasRule[] {
  const out: AliasRule[] = [];

  // ① 原生 rules 数组
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const match = str(o.match ?? o.name ?? o.key, ALIAS_LIMITS.maxKeyLen);
      const label = str(o.label ?? o.display ?? o.alias ?? o.zh ?? o.value, ALIAS_LIMITS.maxLabelLen);
      if (!match || !label || isBadKey(match)) continue;
      const scope = str(o.scope ?? o.target, 64) ?? undefined;
      const note = str(o.note ?? o.desc ?? o.evidence, ALIAS_LIMITS.maxNoteLen) ?? undefined;
      out.push({ match, label, ...(scope ? { scope } : {}), ...(note ? { note } : {}) });
      if (out.length >= ALIAS_LIMITS.maxRules) break;
    }
    return out;
  }

  // ② 扁平 { "真实名": "本地名" }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const match = str(k, ALIAS_LIMITS.maxKeyLen);
      const label = str(v, ALIAS_LIMITS.maxLabelLen);
      if (!match || !label || isBadKey(match)) continue;
      out.push({ match, label });
      if (out.length >= ALIAS_LIMITS.maxRules) break;
    }
  }
  return out;
}

/**
 * 规整任意输入为配置对象。兼容四种形态：
 *   ① 原生：`{ version, name, rules: [{ match, label, scope? }] }`
 *   ② cave-vars.json：`{ variables: [{ name, label, scope, … }] }`
 *   ③ 配置包片段：`{ displayNames: { … } }`
 *   ④ 扁平表：`{ "真实名": "本地名" }`
 * 无法识别 → 返回 null（调用方据此报错，不静默污染存储）。
 */
export function normalizeAliasConfig(raw: unknown): AliasConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (raw.length > ALIAS_LIMITS.maxJsonBytes) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return normalizeAliasConfig(parsed);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // 形态 ②：cave-vars.json（variables[].name/label/scope）
  // 形态 ①：原生 rules
  // 形态 ③：displayNames
  // 形态 ④：扁平表
  let rules: AliasRule[];
  if (Array.isArray(o.rules)) {
    rules = coerceRules(o.rules);
  } else if (Array.isArray(o.variables)) {
    rules = coerceRules(o.variables);
  } else if (o.displayNames && typeof o.displayNames === 'object') {
    rules = coerceRules(o.displayNames);
  } else {
    rules = coerceRules(o);
  }
  if (rules.length === 0) return null;

  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 1;
  const name = str(o.name ?? o.title, 128) ?? '';
  const source = str(o.source ?? o.plugin, 128) ?? '';
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;
  return { version, name, source, enabled, rules };
}

function sanitizeStored(raw: unknown): AliasConfig | null {
  return normalizeAliasConfig(raw);
}

function load(): AliasConfig {
  if (cache) return cache;
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (!s || s.length > ALIAS_LIMITS.maxJsonBytes) {
      cache = { ...EMPTY, rules: [] };
      return cache;
    }
    cache = sanitizeStored(JSON.parse(s)) ?? { ...EMPTY, rules: [] };
  } catch {
    cache = { ...EMPTY, rules: [] };
  }
  return cache;
}

function persist(cfg: AliasConfig): void {
  cache = cfg;
  try {
    if (cfg.rules.length === 0) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
  notify();
}

/** 当前配置（副本，防外部改写内部缓存） */
export function getAliasConfig(): AliasConfig {
  const c = load();
  return { ...c, rules: c.rules.map((r) => ({ ...r })) };
}

/** 是否启用了一份有效配置 */
export function hasAliasConfig(): boolean {
  return load().rules.length > 0;
}

export function isAliasEnabled(): boolean {
  const c = load();
  return c.enabled && c.rules.length > 0;
}

/** 导入/覆盖整份配置；输入非法时抛错（调用方展示原因） */
export function setAliasConfig(raw: unknown): AliasConfig {
  const cfg = normalizeAliasConfig(raw);
  if (!cfg) throw new Error('配置格式无法识别：需要 rules / variables / displayNames / 扁平表之一');
  persist(cfg);
  return cfg;
}

export function setAliasEnabled(on: boolean): void {
  const c = load();
  persist({ ...c, enabled: !!on, rules: c.rules.map((r) => ({ ...r })) });
}

export function clearAliasConfig(): void {
  persist({ ...EMPTY, rules: [] });
}

/** 导出为可读 JSON（只有规则；给人手改/分享） */
export function exportAliasConfig(): string {
  const c = load();
  return JSON.stringify(
    {
      version: c.version,
      name: c.name,
      source: c.source,
      enabled: c.enabled,
      rules: c.rules,
    },
    null,
    2,
  );
}

export function subscribeAliasConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 舞台角色的多种写法归一。
 * 为什么需要：配置是人手写的（写 `Stage` 最自然），而面板拿到的 `targetName`
 * 是 Scratch 的**本地化角色名**（中文环境就是「舞台」）—— 直接字符串比较永远对不上，
 * 表现为「规则明明写了 scope: Stage 却完全不生效」。
 */
const STAGE_TOKENS = new Set([
  'stage',
  '舞台',
  'ステージ',
  '스테이지',
  'escenario',
  'bühne',
  'buehne',
  'scène',
  'scene',
  'piste',
  'etapas',
  'palco',
  'scena',
]);

function canonTarget(s: string): string {
  const t = s.trim().toLowerCase();
  return STAGE_TOKENS.has(t) ? '\u0000stage' : t;
}

/** 规则的匹配打分：越大越优先。-1 = 不匹配。精确匹配恒优于通配。 */
function score(rule: AliasRule, realName: string, targetName: string): number {
  const sc = rule.scope;
  const scoped = !!sc && sc.trim().toLowerCase() !== 'any';
  if (scoped) {
    if (canonTarget(String(sc)) !== canonTarget(targetName)) return -1;
  }
  const m = rule.match;
  if (m === realName) return scoped ? 3 : 2;
  if (m.includes('*')) {
    // 通配只在「首尾星号」这类简单形态上支持，中间不做正则（配置可手写，避免 ReDoS）
    const parts = m.split('*').filter((s) => s !== '');
    if (parts.length === 0) return 0; // match === '*' → 命中一切，最低优先级
    let idx = 0;
    for (const p of parts) {
      const at = realName.indexOf(p, idx);
      if (at < 0) return -1;
      idx = at + p.length;
    }
    if (!m.startsWith('*') && !realName.startsWith(parts[0])) return -1;
    if (!m.endsWith('*') && !realName.endsWith(parts[parts.length - 1])) return -1;
    return scoped ? 1 : 0;
  }
  return -1;
}

/**
 * 按真实名 + 所属角色解析本地显示名。未命中返回 undefined。
 * 纯函数、不写任何存储；调用方可放心在渲染里高频调用（内部 O(规则数)，规则表已被上限约束）。
 */
export function resolveAlias(realName: string, targetName: string): string | undefined {
  const c = load();
  if (!c.enabled || c.rules.length === 0) return undefined;
  let best = -1;
  let label: string | undefined;
  for (const r of c.rules) {
    const s = score(r, realName, targetName);
    if (s > best) {
      best = s;
      label = r.label;
    }
  }
  return best >= 0 ? label : undefined;
}

/** 规则条数 / 去重后的匹配键数（UI 展示用） */
export function aliasStats(): { rules: number; enabled: boolean; name: string } {
  const c = load();
  return { rules: c.rules.length, enabled: c.enabled && c.rules.length > 0, name: c.name };
}
