// ===== 飞书消息请求拦截（document-start 安装，UI 内嵌在面板里） =====
// 目标：拦下页面/作品发往飞书群机器人 webhook 的请求，**在内嵌于 VaIMod 面板的 UI 里**
// 让人决定放行还是拒绝（对齐「飞书拦截器」脚本的能力，但不往页面 DOM 注入任何浮层）。
//
// 设计要点：
// - 默认模式 off：不匹配、不排队、不影响任何既有请求，行为与未安装完全一致；
// - hook 在 document-start 安装：作品/站点的请求都发生在页面脚本运行之后，
//   只有先占住 fetch/XHR 才拦得住（与官方云 API 观察钩子同一思路）；
// - VaIMod 自身发出的飞书消息带内部标记，直接放行，避免自己拦自己；
// - 唤醒式决策：命中后把请求挂起（fetch 返回 pending Promise / XHR 延迟 send），
//   等 UI 决策；无人应答按超时兜底，绝不让请求永久悬挂；
// - 命中记录与「记住该机器人」写入 localStorage，配置包可一并带走。

import { loadSettings, saveSettings, type FeishuInterceptMode } from './settings';

/** 飞书 webhook 地址特征（群机器人 / 捷径触发器） */
const HOOK_RE = /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/([A-Za-z0-9\-_]+)/;
const FLOW_RE = /(?:www\.|open\.)?feishu\.cn\/flow\/api\/trigger-webhook\/([A-Za-z0-9\-_]+)/;
/** 宽松命中：只要落在飞书域名上就算候选，交由上面两条抓 bot id */
const CANDIDATE_RE = /(^|\.)(open\.)?feishu\.cn\/|(^|\.)feishu\.cn\//i;

const RULES_KEY = ['vai', 'mod', '_fs_rules'].join('');
const NS_LOG_LIMIT = 200;

export type FeishuDecision =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'auto-allowed'
  | 'auto-denied'
  | 'timeout-allowed'
  | 'timeout-denied'
  | 'rule-allowed'
  | 'rule-denied';

export interface FeishuHit {
  id: number;
  url: string;
  method: string;
  /** webhook 尾部 token（识别机器人） */
  botId: string;
  kind: 'hook' | 'flow' | 'other';
  /** 从 body 里萃取的可见文本（卡片/文本消息的正文） */
  text: string;
  /** 原始 body（截断，便于排查） */
  raw: string;
  at: number;
  via: 'fetch' | 'xhr';
  decision: FeishuDecision;
}

type Listener = () => void;

let installed = false;
let seq = 1;
const hits: FeishuHit[] = [];
const pendingIds = new Set<number>();
const listeners = new Set<Listener>();
const resolvers = new Map<number, (allow: boolean, decision: FeishuDecision) => void>();
/** botId -> 允许 / 拒绝（「记住该机器人」）；缺失 = 每次都问 */
const rules = new Map<string, boolean>();
/** 已安装的原始实现（内部放行用） */
let origFetch: typeof fetch | null = null;
let origXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let origXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

/** 内部标记：VaIMod 自身发出的请求带它即跳过拦截（symbol 页面不可见） */
export const FEISHU_BYPASS = Symbol('vaimod-internal');

function readRules(): void {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'boolean') rules.set(k, v);
    }
  } catch {
    /* ignore */
  }
}

function writeRules(): void {
  try {
    const obj: Record<string, boolean> = {};
    for (const [k, v] of rules) obj[k] = v;
    localStorage.setItem(RULES_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function mode(): FeishuInterceptMode {
  return loadSettings().feishuIntercept;
}

// ---------- body 文本萃取 ----------
function bodyToRaw(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    try {
      body.forEach((v, k) => parts.push(`${k}=${typeof v === 'string' ? v : '[file]'}`));
    } catch {
      /* ignore */
    }
    return parts.join('&');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return '(Blob 数据)';
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '(ArrayBuffer 数据)';
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** 把 webhook body 萃取成「人能看懂的一行/多行文本」 */
function extractText(raw: string): string {
  if (!raw) return '(无内容)';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const content = parsed.content;
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      if (typeof c.text === 'string') return c.text;
      return JSON.stringify(content);
    }
    if (typeof content === 'string') return content;
    if (typeof parsed.text === 'string') return parsed.text;
    return raw.slice(0, 800);
  } catch {
    return raw.slice(0, 800);
  }
}

function classifyBot(url: string): { botId: string; kind: FeishuHit['kind'] } {
  const h = url.match(HOOK_RE);
  if (h) return { botId: h[1], kind: 'hook' };
  const f = url.match(FLOW_RE);
  if (f) return { botId: f[1], kind: 'flow' };
  return { botId: '未知', kind: 'other' };
}

/**
 * 命中判定 + 决策。返回 true = 放行。
 * manual 模式下唤醒 UI 并等待；无人应答按超时兜底。
 */
function decide(url: string, method: string, body: unknown, via: FeishuHit['via']): Promise<boolean> | null {
  const m = mode();
  if (m === 'off') return null;
  if (!CANDIDATE_RE.test(url)) return null;

  const raw = bodyToRaw(body);
  const { botId, kind } = classifyBot(url);
  const hit: FeishuHit = {
    id: seq++,
    url,
    method: method || 'GET',
    botId,
    kind,
    text: extractText(raw),
    raw: raw.slice(0, 2000),
    at: Date.now(),
    via,
    decision: 'pending',
  };
  hits.unshift(hit);
  if (hits.length > NS_LOG_LIMIT) hits.length = NS_LOG_LIMIT;

  // 记忆规则优先：命中即决，不再打扰
  const remembered = rules.get(botId);
  if (remembered !== undefined) {
    hit.decision = remembered ? 'rule-allowed' : 'rule-denied';
    emit();
    return Promise.resolve(remembered);
  }

  if (m === 'allowAll') {
    hit.decision = 'auto-allowed';
    emit();
    return Promise.resolve(true);
  }
  if (m === 'blockAll') {
    hit.decision = 'auto-denied';
    emit();
    return Promise.resolve(false);
  }

  // manual：挂起等决策
  const s = loadSettings();
  pendingIds.add(hit.id);
  emit();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (allow: boolean, decision: FeishuDecision): void => {
      if (settled) return;
      settled = true;
      resolvers.delete(hit.id);
      pendingIds.delete(hit.id);
      hit.decision = decision;
      emit();
      resolve(allow);
    };
    resolvers.set(hit.id, finish);
    const ms = s.feishuTimeoutMs;
    if (ms <= 0) {
      finish(s.feishuOnTimeout === 'block' ? false : true, s.feishuOnTimeout === 'block' ? 'timeout-denied' : 'timeout-allowed');
      return;
    }
    setTimeout(() => {
      const allow = s.feishuOnTimeout !== 'block';
      finish(allow, allow ? 'timeout-allowed' : 'timeout-denied');
    }, ms);
  });
}

// ===== 安装 =====
export function installFeishuGuard(): void {
  if (installed) return;
  installed = true;
  readRules();

  origFetch = window.fetch;
  const nativeFetch = origFetch;
  if (typeof nativeFetch === 'function') {
    const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const internal = Boolean(init && (init as Record<PropertyKey, unknown>)[FEISHU_BYPASS]);
      if (internal || mode() === 'off') return nativeFetch.call(this as never, input, init);
      let url = '';
      let method = 'GET';
      let body: unknown = null;
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else {
          url = (input as Request).url;
          method = (input as Request).method || 'GET';
        }
        if (init?.method) method = init.method;
        if (init?.body != null) body = init.body;
        else if (typeof input === 'object' && !(input instanceof URL)) body = (input as Request).body ?? null;
      } catch {
        return nativeFetch.call(this as never, input, init);
      }
      const decision = decide(url, method, body, 'fetch');
      if (!decision) return nativeFetch.call(this as never, input, init);
      return decision.then((allow) => {
        if (allow) return nativeFetch.call(this as never, input, init);
        return Promise.reject(new TypeError('VaIMod：飞书 Webhook 请求已被拒绝'));
      });
    };
    try {
      Object.defineProperty(patched, 'name', { configurable: true, value: 'fetch' });
      Object.defineProperty(patched, 'length', { configurable: true, value: 2 });
    } catch {
      /* ignore */
    }
    window.fetch = patched as typeof fetch;
  }

  const XP = XMLHttpRequest.prototype;
  origXhrOpen = XP.open;
  origXhrSend = XP.send;
  const nativeOpen = origXhrOpen;
  const nativeSend = origXhrSend;

  XP.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      (this as unknown as Record<string, unknown>).__vaimod_fs = {
        method: String(method || 'GET'),
        url: String(url),
      };
    } catch {
      /* ignore */
    }
    return (nativeOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XP.open;

  XP.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = (this as unknown as { __vaimod_fs?: { method: string; url: string } }).__vaimod_fs;
    if (!info || mode() === 'off') {
      return (nativeSend as (...a: unknown[]) => void).apply(this, [body as never]);
    }
    const decision = decide(info.url, info.method, body ?? null, 'xhr');
    if (!decision) return (nativeSend as (...a: unknown[]) => void).apply(this, [body as never]);
    const self = this;
    decision.then((allow) => {
      if (allow) {
        (nativeSend as (...a: unknown[]) => void).apply(self, [body as never]);
        return;
      }
      // 拒绝：合成一次失败事件，调用方的 onerror/onreadystatechange 能正常感知
      setTimeout(() => {
        try {
          if (typeof self.onerror === 'function') {
            self.onerror(new ProgressEvent('error') as never);
          }
          if (typeof self.onreadystatechange === 'function') {
            Object.defineProperty(self, 'readyState', { configurable: true, value: 4 });
            Object.defineProperty(self, 'status', { configurable: true, value: 0 });
            (self.onreadystatechange as (e?: unknown) => void)(new Event('readystatechange'));
          }
        } catch {
          /* ignore */
        }
      }, 0);
    });
    return undefined;
  } as typeof XP.send;
}

/** 卸载（仅测试/调试用） */
export function uninstallFeishuGuard(): void {
  if (!installed) return;
  installed = false;
  if (origFetch) window.fetch = origFetch;
  if (origXhrOpen) XMLHttpRequest.prototype.open = origXhrOpen;
  if (origXhrSend) XMLHttpRequest.prototype.send = origXhrSend;
  for (const [, finish] of resolvers) finish(true, 'allowed');
  resolvers.clear();
  pendingIds.clear();
}

// ===== 对外只读面（UI 用） =====
export function subscribeFeishu(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 命中记录（新→旧，返回副本避免 UI 侧误改） */
export function feishuHits(): FeishuHit[] {
  return hits.slice();
}

export function feishuPendingCount(): number {
  return pendingIds.size;
}

export function feishuRules(): Array<{ botId: string; allow: boolean }> {
  return Array.from(rules, ([botId, allow]) => ({ botId, allow }));
}

export function setFeishuRule(botId: string, allow: boolean | null): void {
  if (allow === null) rules.delete(botId);
  else rules.set(botId, allow);
  writeRules();
  emit();
}

/** 决策一条挂起请求；remember=true 时同时记住该机器人 */
export function resolveFeishu(id: number, allow: boolean, remember = false): boolean {
  const finish = resolvers.get(id);
  if (!finish) return false;
  const hit = hits.find((h) => h.id === id);
  if (remember && hit && hit.botId !== '未知') {
    rules.set(hit.botId, allow);
    writeRules();
  }
  finish(allow, allow ? 'allowed' : 'denied');
  return true;
}

/** 全部挂起请求一次决策（面板「全部放行 / 全部拒绝」） */
export function resolveAllFeishu(allow: boolean, remember = false): number {
  let n = 0;
  for (const id of Array.from(resolvers.keys())) {
    if (resolveFeishu(id, allow, remember)) n++;
  }
  return n;
}

export function clearFeishuLog(): void {
  hits.length = 0;
  emit();
}

export function feishuGuardInstalled(): boolean {
  return installed;
}

/** 切换拦截模式并持久化（UI 开关用） */
export function setFeishuMode(m: FeishuInterceptMode): void {
  const s = loadSettings();
  s.feishuIntercept = m;
  saveSettings(s);
  // 关掉拦截时把还挂着的一律放行，避免请求被永久悬挂
  if (m === 'off' || m === 'allowAll') resolveAllFeishu(true);
  emit();
}

export function feishuMode(): FeishuInterceptMode {
  return mode();
}
