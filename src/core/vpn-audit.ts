import type { ScratchValue } from './types';

// ===== VPN 审核系统 =====
// 数据进出 VPN 通道必须通过安全审核：
// - 写往 vm（outbound）：类型 / 长度 / 防逃逸对象（函数、Symbol、循环引用、非纯对象、特殊对象）
// - 从 vm 读出（inbound）：非安全类型清洗为安全值（防 vm 被污染后注入 UI）
// 审核不通过即拦截，保证数据面纯净（防检测 / 防逃逸）。

export type AuditResult = { ok: true } | { ok: false; reason: string };

const MAX_ARR = 200000;
const MAX_STR = 500000;

// 防逃逸对象检测：循环引用 / 函数 / Symbol / 特殊对象 / 非纯原型 → 一律拒绝
function detectEscape(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const el of value) {
      if (detectEscape(el, seen)) return true;
    }
    return false;
  }
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return true;
  const keys = Object.keys(value);
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (typeof v === 'function' || typeof v === 'symbol') return true;
    if (detectEscape(v, seen)) return true;
  }
  return false;
}

/** 出站审核：写往 vm / 云数据之前 */
export function auditOutbound(value: unknown): AuditResult {
  if (Array.isArray(value)) {
    if (value.length > MAX_ARR) return { ok: false, reason: 'array-too-large' };
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (typeof el !== 'string' && typeof el !== 'number' && typeof el !== 'boolean') {
        return { ok: false, reason: 'bad-element' };
      }
      if (typeof el === 'number' && !Number.isFinite(el)) {
        return { ok: false, reason: 'bad-number' };
      }
    }
    return { ok: true };
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STR) return { ok: false, reason: 'string-too-large' };
    return { ok: true };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true } : { ok: false, reason: 'bad-number' };
  }
  if (typeof value === 'boolean') return { ok: true };
  if (value === null || value === undefined) return { ok: true };
  if (typeof value === 'object') {
    if (detectEscape(value, new Set())) return { ok: false, reason: 'escape-object' };
    return { ok: true };
  }
  return { ok: false, reason: 'bad-type' };
}

/** 入站清洗：从 vm / 云数据读出的值，非法类型归为安全值 */
export function auditInbound(value: unknown): ScratchValue {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    // 快路径：先逐项判类型，全部合法时用 slice 走原生拷贝（memcpy），
    // 避免为常规列表付出 filter 的逐项回调开销——getVariables / 快照每 tick 都会走这里。
    // 一旦遇到非法项再退回 filter（保持原有「剔除非法元素」语义）。
    for (let i = 0; i < value.length; i++) {
      const el: unknown = value[i];
      if (typeof el !== 'string' && typeof el !== 'number' && typeof el !== 'boolean') {
        return value.filter(
          (x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean',
        ) as unknown as ScratchValue;
      }
    }
    return value.slice() as unknown as ScratchValue;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return '';
}
