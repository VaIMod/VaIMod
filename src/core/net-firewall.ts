// ===== 网络防火墙（document-start 安装）=====
// 目标：把「页面/作品往站外发东西」这件事变得**可见、可控**。
//
// 安全底线（不可越过的设计原则）：
// 1. 默认 watch（只观察记录、一律放行）——不改变站点任何行为；
// 2. 同源 / 站点同族域名请求**不进判定链**（一次字符串前缀比较即返回），零日志、零判定开销；
// 3. 只有用户显式加黑名单（或显式打开「外传拦截」）才会拒绝请求；
// 4. VaIMod 自身发起的请求（云数据直写等）用 WeakSet 标记后直接透传 —— 不记录、不拦截，
//    标记不落在任何可枚举属性上（页面既看不到也无法伪造）；
// 5. 绝不 hook `img.src` / `script` / `link`（统计像素、CDN 会大量误伤）；
//    WebSocket 只观察 `send`，不替换构造器（替换构造器会改变 `instanceof` 与 toString 特征）。
//
// 判定分类（非站点请求）：
//   allow  用户白名单 —— 记录但不拦
//   block  用户黑名单 —— enforce 模式下拒绝
//   exfil  疑似把变量/存档数据外传 —— enforce + 已开启外传拦截时拒绝
//   third  其它第三方出网 —— 仅记录

import { markNative } from '../dom-utils';
import { loadSettings, saveSettings, type FirewallMode } from './settings';

export type FwVerdict = 'third' | 'block' | 'exfil' | 'allow';
export type FwKind = 'fetch' | 'xhr' | 'beacon' | 'ws';

export interface FirewallHit {
  id: number;
  /** 目标主机名 */
  host: string;
  /** 完整地址（截断） */
  url: string;
  method: string;
  kind: FwKind;
  verdict: FwVerdict;
  /** 该「主机 + 方法 + 路径 + 通道」被观察到的次数 */
  count: number;
  /** 累计载荷字节（近似值） */
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** 是否实际被拒绝 */
  blocked: boolean;
  /** 外传特征说明（空 = 无） */
  note: string;
  /** 内部去重键（UI 不展示） */
  key: string;
}

export interface FwRules {
  block: string[];
  allow: string[];
}

export interface FwStats {
  mode: FirewallMode;
  hosts: number;
  hits: number;
  blocked: number;
  blockRules: number;
  allowRules: number;
}

const RULES_KEY = ['vai', 'mod', '_fw_rules'].join('');

const LIMITS = {
  maxHosts: 300, // 日志里不同主机上限
  maxRules: 500,
  maxHostLen: 253,
  maxUrlLen: 300,
  maxNoteLen: 64,
} as const;

/** host 合法字符：字母数字、点、连字符、下划线、通配 *、端口 :（支持 `*.example.com`） */
const HOST_RE = /^(?:\*\.?)?[a-z0-9](?:[a-z0-9._\-:*]*[a-z0-9*])?$/i;

type Listener = () => void;

let initialized = false;
let hooked = false;
let hitSeq = 1;
let blockedCount = 0;
const log: FirewallHit[] = [];
const index = new Map<string, FirewallHit>();
const listeners = new Set<Listener>();

/** 域名规则（内存态，写盘 = localStorage） */
let rules: FwRules = { block: [], allow: [] };

/** 站点族（host 末两段）与页面 host —— document-start 时确定，无需每次请求重算 */
let pageHost = '';
let pageFamily = '';
/** pageFamily 是否为真域名（IP 主机时禁用「同族」宽松判定，避免 127.0.0.1 与 x.0.0.1 互认） */
let pageFamilyIsDomain = false;
let originPrefix = '';

/** VaIMod 自身请求标记：不落任何可枚举属性（页面无法探测/伪造） */
const internalXhr = new WeakSet<object>();

// ---------- 基础工具 ----------

function safeHost(url: string): string {
  try {
    return new URL(url, location.href).hostname || '';
  } catch {
    return '';
  }
}

/** host 的「站点族」：末两段（ccw.site / m.ccw.site → ccw.site） */
function familyOf(host: string): string {
  const p = host.split('.');
  return p.length >= 2 ? p.slice(-2).join('.') : host;
}

/** 一次前缀比较即可排除的「不用管」请求（占绝大多数）：相对路径 / 同源 / 内部协议 */
function quickSkip(url: string): boolean {
  const c = url.charCodeAt(0);
  if (c === 47 /* / */ || c === 35 /* # */ || c === 63 /* ? */) return true;
  if (originPrefix && url.startsWith(originPrefix)) return true;
  if (c === 100 /* d */ && url.startsWith('data:')) return true;
  if (c === 98 /* b */ && (url.startsWith('blob:') || url.startsWith('about:'))) return true;
  return false;
}

/** 规则匹配：`example.com` 含子域；`*.example.com` 仅子域 */
function domainMatch(host: string, rule: string): boolean {
  const h = host.toLowerCase();
  const r = rule.trim().toLowerCase().replace(/^\.+/, '');
  if (!r) return false;
  if (r.startsWith('*.')) {
    const base = r.slice(2);
    return h.endsWith('.' + base);
  }
  if (r.startsWith('*')) return h.endsWith(r.slice(1));
  return h === r || h.endsWith('.' + r);
}

function inList(host: string, list: string[]): boolean {
  for (const r of list) if (domainMatch(host, r)) return true;
  return false;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

/**
 * 数据外传启发式：返回特征说明（空串 = 无特征）。
 * 只做「够用就好」的廉价判断——不解析 JSON 树、不做正则回溯，单次开销是几次字符比较。
 */
function exfilNote(url: string, body: unknown): string {
  let size = 0;
  let raw = '';
  if (typeof body === 'string') {
    raw = body;
    size = body.length;
  } else if (body && typeof body === 'object') {
    const b = body as { size?: unknown };
    if (typeof b.size === 'number' && Number.isFinite(b.size)) size = b.size;
  }
  if (size >= 8192) return `批量上传 ${fmtBytes(size)}`;
  if (size < 16) {
    // 无 body 时只看 query：短 query 不可能是数据外传
    const q = url.indexOf('?');
    if (q < 0 || url.length - q < 48) return '';
  }
  const q = url.indexOf('?');
  const probe = (raw.length > 2048 ? raw.slice(0, 2048) : raw) + (q >= 0 ? url.slice(q, q + 512) : '');
  if (probe.length < 24) return '';
  if (/"(?:variables?|cloud[_-]?data|snapshot|saveData|save_data)"\s*:/i.test(probe))
    return '结构疑似变量/存档数据';
  if (/(?:^|[?&"'])(?:variable|variables|snapshot|dump|export|saveData)=/i.test(probe))
    return '参数疑似变量数据';
  return '';
}

// ---------- 规则读写 ----------

function sanitizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!s || s.length > LIMITS.maxHostLen) return null;
  if (!HOST_RE.test(s)) return null;
  if (s.includes('..')) return null;
  return s;
}

function sanitizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const h = sanitizeHost(item);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= LIMITS.maxRules) break;
  }
  return out;
}

function readRules(): void {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    rules = {
      block: sanitizeList(obj.block),
      allow: sanitizeList(obj.allow),
    };
  } catch {
    /* ignore */
  }
}

function writeRules(): void {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* ignore */
  }
}

// ---------- 通知（微节流：一帧内多次命中只通知一次） ----------

let emitScheduled = false;

function emitSoon(): void {
  if (emitScheduled || listeners.size === 0) return;
  emitScheduled = true;
  setTimeout(() => {
    emitScheduled = false;
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }, 80);
}

// ---------- 判定 ----------

function mode(): FirewallMode {
  return loadSettings().firewall;
}

interface Decision {
  verdict: FwVerdict;
  note: string;
  blocked: boolean;
}

/**
 * 判定一个出网请求。返回 null = 不管（同源 / 站点同族 / 已跳过）。
 * 注意：这里**只判定不记录**，记录交给 record()——避免被拒绝的请求重复写日志。
 */
function judge(url: string, body: unknown): Decision | null {
  if (!url || quickSkip(url)) return null;
  const host = safeHost(url);
  if (!host) return null;
  // 站点同族（ccw.site 及其全部子域）一律放行且不记录
  if (host === pageHost) return null;
  if (pageFamilyIsDomain && (host.endsWith('.' + pageFamily) || familyOf(host) === pageFamily))
    return null;

  const m = mode();
  if (m === 'off') return null;

  const note = exfilNote(url, body);
  const enforce = m === 'enforce';

  if (inList(host, rules.allow)) {
    return { verdict: 'allow', note, blocked: false };
  }
  if (inList(host, rules.block)) {
    return { verdict: 'block', note, blocked: enforce };
  }
  if (note) {
    const blockExfil = loadSettings().firewallBlockExfil;
    return { verdict: 'exfil', note, blocked: enforce && blockExfil };
  }
  return { verdict: 'third', note: '', blocked: false };
}

function record(
  url: string,
  host: string,
  method: string,
  kind: FwKind,
  body: unknown,
  d: Decision,
): void {
  let path = '';
  try {
    path = new URL(url, location.href).pathname;
  } catch {
    path = url.slice(0, 64);
  }
  const key = `${host}\u0000${method}\u0000${path}\u0000${kind}`;
  let size = 0;
  if (typeof body === 'string') size = body.length;
  else if (body && typeof body === 'object') {
    const b = body as { size?: unknown };
    if (typeof b.size === 'number' && Number.isFinite(b.size)) size = b.size;
  }

  const existing = index.get(key);
  if (existing) {
    existing.count += 1;
    existing.bytes += size;
    existing.lastAt = Date.now();
    if (d.blocked) {
      existing.blocked = true;
      blockedCount += 1;
    }
    emitSoon();
    return;
  }

  // 新主机超过上限时淘汰最旧的一条（日志是环形缓冲，绝不无限增长）
  if (index.size >= LIMITS.maxHosts) {
    const old = log.pop();
    if (old) index.delete(old.key);
  }

  const hit: FirewallHit = {
    id: hitSeq++,
    host,
    url: url.length > LIMITS.maxUrlLen ? url.slice(0, LIMITS.maxUrlLen) : url,
    method,
    kind,
    verdict: d.verdict,
    count: 1,
    bytes: size,
    firstAt: Date.now(),
    lastAt: Date.now(),
    blocked: d.blocked,
    note: d.note.length > LIMITS.maxNoteLen ? d.note.slice(0, LIMITS.maxNoteLen) : d.note,
    key,
  };
  log.unshift(hit);
  index.set(key, hit);
  if (d.blocked) blockedCount += 1;
  emitSoon();
}

/** 统一入口：判定 + 记录，返回是否应放行 */
function inspect(url: string, method: string, body: unknown, kind: FwKind): boolean {
  try {
    const d = judge(url, body);
    if (!d) return true;
    record(url, safeHost(url), method, kind, body, d);
    return !d.blocked;
  } catch {
    return true; // 判定期任何异常都放行 —— 防火墙绝不能成为站点的故障点
  }
}

// ---------- 安装 ----------

export function installNetFirewall(): void {
  if (!initialized) {
    initialized = true;
    try {
      pageHost = location.hostname;
      pageFamily = familyOf(pageHost);
      pageFamilyIsDomain = /[a-z]/i.test(pageFamily);
      originPrefix = location.origin === 'null' ? '' : location.origin;
    } catch {
      /* ignore */
    }
    readRules();
  }
  if (hooked) return;
  if (mode() === 'off') return; // 关闭态：不装任何钩子（切回 watch/enforce 时再装）
  hooked = true;

  // ① fetch
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        try {
          let url = '';
          let method = 'GET';
          let body: unknown = null;
          if (typeof input === 'string') url = input;
          else if (input instanceof URL) url = input.href;
          else {
            url = (input as Request).url;
            method = (input as Request).method || 'GET';
          }
          if (init?.method) method = init.method;
          if (init?.body != null) body = init.body;
          if (!quickSkip(url) && !inspect(url, method, body, 'fetch')) {
            return Promise.reject(new TypeError('VaIMod 防火墙：请求已被拦截'));
          }
        } catch {
          /* ignore */
        }
        return origFetch.call(this as never, input, init);
      };
      markNative(patched, 'fetch');
      window.fetch = patched as typeof fetch;
    }
  } catch {
    /* ignore */
  }

  // ② XMLHttpRequest（open 记地址，send 带载荷）
  try {
    const XP = XMLHttpRequest.prototype;
    const openFn = XP.open;
    const sendFn = XP.send;
    const patchedOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        const meta = this as unknown as Record<string, unknown>;
        meta._vf = { m: String(method || 'GET'), u: typeof url === 'string' ? url : String(url) };
      } catch {
        /* ignore */
      }
      return (openFn as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    };
    markNative(patchedOpen, 'open');
    XP.open = patchedOpen as typeof XP.open;

    const patchedSend = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      // VaIMod 自身请求直接透传（WeakSet 标记，页面无法探测也无法伪造）
      if (!internalXhr.has(this)) {
        try {
          const meta = this as unknown as { _vf?: { m: string; u: string } };
          const info = meta._vf;
          if (info && !quickSkip(info.u) && !inspect(info.u, info.m, body ?? null, 'xhr')) {
            setTimeout(() => {
              try {
                Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
                Object.defineProperty(this, 'status', { configurable: true, value: 0 });
                if (typeof this.onerror === 'function') {
                  this.onerror(new ProgressEvent('error') as never);
                }
                if (typeof this.onreadystatechange === 'function') {
                  (this.onreadystatechange as (e?: unknown) => void)(new Event('readystatechange'));
                }
              } catch {
                /* ignore */
              }
            }, 0);
            return undefined;
          }
        } catch {
          /* ignore */
        }
      }
      return (sendFn as (...a: unknown[]) => void).apply(this, [body as never]);
    };
    markNative(patchedSend, 'send');
    XP.send = patchedSend as typeof XP.send;
  } catch {
    /* ignore */
  }

  // ③ navigator.sendBeacon（页面关闭时的常见外传通道）
  try {
    const NP = Navigator.prototype as unknown as Record<string, unknown>;
    const beacon = NP.sendBeacon;
    if (typeof beacon === 'function') {
      const origBeacon = beacon as (url: string | URL, data?: BodyInit | null) => boolean;
      const patchedBeacon = function (
        this: Navigator,
        url: string | URL,
        data?: BodyInit | null,
      ): boolean {
        try {
          const u = typeof url === 'string' ? url : url.href;
          if (!quickSkip(u) && !inspect(u, 'POST', data ?? null, 'beacon')) return false;
        } catch {
          /* ignore */
        }
        return origBeacon.call(this, url, data);
      };
      markNative(patchedBeacon, 'sendBeacon');
      NP.sendBeacon = patchedBeacon;
    }
  } catch {
    /* ignore */
  }

  // ④ WebSocket.send（只观察：绝不替换构造器——替换会改变 instanceof/toString 特征）
  try {
    const SP = WebSocket.prototype;
    const wsSend = SP.send;
    if (typeof wsSend === 'function') {
      const patchedWsSend = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        try {
          const u = this.url;
          if (u && !quickSkip(u) && !inspect(u, 'WS', data ?? null, 'ws')) {
            // 已建立的长连接无法安全「拒绝单条消息」（会把连接搞成半死状态）→ 只记不拦
            return undefined;
          }
        } catch {
          /* ignore */
        }
        return (wsSend as (...a: unknown[]) => void).apply(this, [data as never]);
      };
      markNative(patchedWsSend, 'send');
      SP.send = patchedWsSend as typeof SP.send;
    }
  } catch {
    /* ignore */
  }
}

/** 标记「该 XHR 是 VaIMod 自己发的」→ 防火墙直接透传 */
export function markInternalXhr(xhr: XMLHttpRequest): void {
  try {
    internalXhr.add(xhr);
  } catch {
    /* ignore */
  }
}

// ---------- 对外只读面（UI / 调试用） ----------

export function subscribeFirewall(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 命中日志（按最近活跃排序的副本） */
export function firewallHits(): FirewallHit[] {
  return log.slice().sort((a, b) => b.lastAt - a.lastAt);
}

export function firewallStats(): FwStats {
  return {
    mode: mode(),
    hosts: index.size,
    hits: log.reduce((n, h) => n + h.count, 0),
    blocked: blockedCount,
    blockRules: rules.block.length,
    allowRules: rules.allow.length,
  };
}

export function firewallRules(): FwRules {
  return { block: rules.block.slice(), allow: rules.allow.slice() };
}

export function setFirewallMode(m: FirewallMode): void {
  const s = loadSettings();
  s.firewall = m;
  saveSettings(s);
  // off ← 从 watch/enforce 切过来时钩子已经装了：判定链里 mode==='off' 会直接放行，
  // 因此无需卸载钩子（卸载再重装反而会丢别的模块叠加的包装层）
  if (m !== 'off') installNetFirewall();
  emitSoon();
}

export function firewallMode(): FirewallMode {
  return mode();
}

export function setFirewallBlockExfil(on: boolean): void {
  const s = loadSettings();
  s.firewallBlockExfil = on;
  saveSettings(s);
  emitSoon();
}

export function firewallBlockExfil(): boolean {
  return loadSettings().firewallBlockExfil;
}

/** 加一条域名规则；返回 false = 域名格式不合法 */
export function addFirewallRule(host: string, kind: 'block' | 'allow'): boolean {
  const h = sanitizeHost(host);
  if (!h) return false;
  const other = kind === 'block' ? rules.allow : rules.block;
  // 同域名不能同时黑白：加进一边就从另一边移除（避免规则互相矛盾、行为难解释）
  const oi = other.indexOf(h);
  if (oi >= 0) other.splice(oi, 1);
  if (!rules[kind].includes(h)) {
    if (rules[kind].length >= LIMITS.maxRules) return false;
    rules[kind].push(h);
  }
  writeRules();
  emitSoon();
  return true;
}

export function removeFirewallRule(host: string, kind: 'block' | 'allow'): void {
  const i = rules[kind].indexOf(host);
  if (i < 0) return;
  rules[kind].splice(i, 1);
  writeRules();
  emitSoon();
}

export function clearFirewallRules(): void {
  rules = { block: [], allow: [] };
  writeRules();
  emitSoon();
}

export function firewallClearLog(): void {
  log.length = 0;
  index.clear();
  blockedCount = 0;
  emitSoon();
}

/** 导出规则 JSON（配置包 / 手动备份用） */
export function exportFirewallRules(): string {
  return JSON.stringify(
    { name: 'VaIMod 防火墙规则', version: 1, block: rules.block, allow: rules.allow },
    null,
    2,
  );
}

/**
 * 导入规则：接受 `{block:[],allow:[]}` / 纯数组（视为黑名单）/ JSON 字符串。
 * 返回导入条数；无法识别时抛错（整份拒绝，不写半份）。
 */
export function importFirewallRules(raw: unknown): { block: number; allow: number } {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error('不是合法的 JSON');
    }
  }
  if (Array.isArray(obj)) {
    rules = { block: sanitizeList(obj), allow: [] };
  } else if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    if (!('block' in o) && !('allow' in o)) throw new Error('缺少 block / allow 字段');
    rules = { block: sanitizeList(o.block), allow: sanitizeList(o.allow) };
  } else {
    throw new Error('规则格式无法识别');
  }
  writeRules();
  emitSoon();
  return { block: rules.block.length, allow: rules.allow.length };
}

/** 该域名当前是否被拦（UI 高亮用） */
export function firewallIsBlocked(host: string): boolean {
  return inList(host, rules.block);
}

/** 该域名是否在用户白名单 */
export function firewallIsAllowed(host: string): boolean {
  return inList(host, rules.allow);
}

export function firewallInstalled(): boolean {
  return hooked;
}
