// ===== 操作元数据层：回收站 + 快照标记（仅本地浏览器持久化） =====
// VaIMod 不擅自动云端/作品本体：删除一律先进「回收站」，快照标记提供「一键还原」。
// 存储走 localStorage（本项目既有的轻量持久化通道），按当前作品 oid 分桶隔离。
import type { ScratchValue } from './types';

const NS_TRASH = ['vai', 'mod', '_trash'].join('');
const NS_MARK = ['vai', 'mod', '_marks'].join('');

// ---------- 命名空间 JSON 读写 ----------
function readJson<T>(ns: string): T {
  try {
    const raw = localStorage.getItem(ns);
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function writeJson(ns: string, obj: unknown): void {
  try {
    localStorage.setItem(ns, JSON.stringify(obj));
  } catch {
    /* 容量超限静默：不影响主流程 */
  }
}

/** 当前作品 oid（与面板同一规则） */
export function currentOid(): string {
  try {
    const m = window.location.pathname.match(/(?:detail|creation|p|project|work)\/([0-9a-fA-F]{16,})/);
    return m ? m[1].toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------- 回收站 ----------
export interface TrashEntry {
  key: string; // 原始变量 id / 云数据名
  name: string;
  kind: 'variable' | 'list';
  value: ScratchValue;
  scope: 'vm' | 'cloud:p' | 'cloud:u';
  targetId?: string;
  targetName?: string;
  isCloud?: boolean;
  displayName?: string; // 还原时恢复的本地显示别名
  at: number;
}

export type TrashScope = TrashEntry['scope'];

interface TrashRoot {
  [oid: string]: Record<string, TrashEntry[]>;
}

function trashNs(): string {
  return [currentOid(), 't'].join(':');
}

export function trashAdd(entry: Omit<TrashEntry, 'at'>): void {
  const root = readJson<TrashRoot>(NS_TRASH);
  const oid = currentOid();
  const bucket = (root[oid] ??= {});
  const list = (bucket[entry.scope] ??= []);
  // 同名去重：同 scope 下已有同名/同 key 则先移除旧条目（保留最新一次删除）
  const kept = list.filter((e) => e.key !== entry.key || e.name !== entry.name);
  kept.unshift({ ...entry, at: Date.now() });
  bucket[entry.scope] = kept.slice(0, 60); // 每桶上限 60 条
  writeJson(NS_TRASH, root);
}

export function trashList(scope: TrashScope): TrashEntry[] {
  const root = readJson<TrashRoot>(NS_TRASH);
  return [...(root[currentOid()]?.[scope] ?? [])];
}

export function trashCount(scope?: TrashScope): number {
  const root = readJson<TrashRoot>(NS_TRASH);
  const oid = currentOid();
  const bucket = root[oid];
  if (!bucket) return 0;
  if (!scope) return Object.values(bucket).reduce((n, l) => n + l.length, 0);
  return (bucket[scope] ?? []).length;
}

/** 移除并返回条目（还原 / 彻底删除共用） */
export function trashTake(scope: TrashScope, key: string, name?: string): TrashEntry | undefined {
  const root = readJson<TrashRoot>(NS_TRASH);
  const oid = currentOid();
  const bucket = root[oid];
  const list = bucket?.[scope];
  if (!list) return undefined;
  const idx = list.findIndex((e) => e.key === key && (name === undefined || e.name === name));
  if (idx < 0) return undefined;
  const [entry] = list.splice(idx, 1);
  writeJson(NS_TRASH, root);
  return entry;
}

export function trashClear(scope?: TrashScope): number {
  const root = readJson<TrashRoot>(NS_TRASH);
  const oid = currentOid();
  const bucket = root[oid];
  if (!bucket) return 0;
  let n = 0;
  if (!scope) {
    n = Object.values(bucket).reduce((a, l) => a + l.length, 0);
    delete root[oid];
  } else {
    n = (bucket[scope] ?? []).length;
    delete bucket[scope];
  }
  writeJson(NS_TRASH, root);
  return n;
}

// ---------- 快照标记（还原系统） ----------
export interface MarkerEntry {
  id: string;
  name: string;
  at: number;
  // 变量/列表：targetId → {name, value}；云数据：scope 内直接 {name: value}
  vars?: Record<string, Record<string, unknown>>;
  lists?: Record<string, Record<string, unknown>>;
  cloud?: { p?: Record<string, unknown>; u?: Record<string, unknown> };
  kind: 'full' | 'vars' | 'cloud';
}

interface MarkRoot {
  [oid: string]: MarkerEntry[];
}

const MARK_CAP = 8;

export function markerList(): MarkerEntry[] {
  const root = readJson<MarkRoot>(NS_MARK);
  return [...(root[currentOid()] ?? [])];
}

export function markerAdd(entry: Omit<MarkerEntry, 'id' | 'at'> & { name: string }): MarkerEntry {
  const root = readJson<MarkRoot>(NS_MARK);
  const oid = currentOid();
  const list = root[oid] ?? [];
  const e: MarkerEntry = { ...entry, id: `m_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, at: Date.now() };
  list.unshift(e);
  root[oid] = list.slice(0, MARK_CAP);
  writeJson(NS_MARK, root);
  return e;
}

export function markerRemove(id: string): void {
  const root = readJson<MarkRoot>(NS_MARK);
  const oid = currentOid();
  const list = root[oid];
  if (!list) return;
  root[oid] = list.filter((m) => m.id !== id);
  writeJson(NS_MARK, root);
}

/** 读取当前 oid 的所有 marker（用于配置包导出） */
export function loadAllMarkers(): MarkerEntry[] {
  return markerList();
}

/** 覆盖当前 oid 的所有 marker（用于配置包导入） */
export function saveAllMarkers(list: MarkerEntry[]): void {
  const root = readJson<MarkRoot>(NS_MARK);
  root[currentOid()] = list.slice(0, MARK_CAP);
  writeJson(NS_MARK, root);
}

/** 读取当前 oid 的全部回收站条目（跨 scope 合并，按 at 倒序） */
export function loadAllTrash(): TrashEntry[] {
  const scopes: TrashScope[] = ['vm', 'cloud:p', 'cloud:u'];
  const all: TrashEntry[] = [];
  for (const s of scopes) all.push(...trashList(s));
  return all.sort((a, b) => b.at - a.at);
}

/** 覆盖当前 oid 的某 scope 回收站（用于配置包导入；先清空再写入） */
export function saveAllTrash(scope: TrashScope, list: TrashEntry[]): void {
  const root = readJson<TrashRoot>(NS_TRASH);
  const oid = currentOid();
  const bucket = (root[oid] ??= {});
  bucket[scope] = list.slice(0, 60);
  writeJson(NS_TRASH, root);
}

// ---------- 通用小工具 ----------
export function sizeOf(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s ? s.length : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function uid(prefix = 'v'): string {
  try {
    const a = crypto.getRandomValues(new Uint32Array(3));
    return prefix + '_' + a[0].toString(36) + a[1].toString(36) + a[2].toString(36);
  } catch {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
  }
}

/** 深拷贝（JSON 安全值）；失败返回原值浅拷贝 */
export function cloneJson<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}
