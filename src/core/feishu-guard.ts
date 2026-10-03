// ===== 飞书消息请求拦截（document-start 安装，UI 内嵌在面板里） =====
// 拦截算法整体移植自「飞书拦截器」脚本 v3.0（用户提供的参考实现）：
// - 命中判定 isTargetUrl：宽松匹配 `open.feishu.cn/open-apis/bot/v2/hook/` 路径，
//   不在 hook 路径上的请求一律直通（脚本同款 CONFIG.interceptPattern）；
// - 机器人 ID extractBotId：`/hook/([^/?]+)` 萃取，取不到记「未知」；
// - 消息内容 extractMessageContent：string/URLSearchParams/FormData 展开 → JSON.parse →
//   content.text → JSON.stringify(content) → String(content) → text → 原文截断 500；
// - 决策流 shouldAllowRequest：先记录后裁决；blockAll 一律拒绝、manual 挂起问人；
// - fetch：string / Request 双形态提取——Request 的 body 是 ReadableStream 不能读
//   （读了会破坏原请求），只认 init.body（脚本同款注释与行为）；
// - XHR：**实例级 HookedXHR 包装**（脚本同款）：每个实例创建真 XHR 后覆盖实例自身的
//   open/send，`HookedXHR.prototype = XMLHttpRequest.prototype` 保持 instanceof 不失效，
//   防 axios 之类缓存原型方法的库绕过；
// - 拒绝合成：readyState=4 / status=0（defineProperty 绕过只读）+ error 通知（脚本同款）。
//
// 与脚本的刻意差异（VaIMod 硬约束所需，行为为脚本的超集，不改变算法语义）：
// - 决策 UI 内嵌在面板的「飞书」标签页里（脚本往页面 DOM 插浮层对话框——违反
//   「零宿主干扰」红线；面板内嵌同样完成「问人」这一步，且不被作品 DOM 干扰）；
// - 拒绝合成用 dispatchEvent 投递：IDL 属性回调（onerror/onreadystatechange）同样会被
//   触发，脚本里手动调回调会漏掉 addEventListener 型调用方（axios 等其 Promise 永不
//   settle）——dispatchEvent 是脚本行为的无损超集；
// - VaIMod 自身发出的飞书消息带 FEISHU_BYPASS 直通，避免自己拦自己；
// - 所有包装函数进 toString 白名单（markNative / markNativeCtor），探测只见 [native code]；
// - 不往 window 暴露 __feishuInterceptor 调试全局（window own property 是指纹面），
//   等价能力由面板提供（模式切换 / 清空记录）。
//
// 其余 VaIMod 侧保留件：off 默认零影响、manual 超时兜底、「记住该机器人」规则、
// 命中记录与规则落盘（配置包可带走）、面板只读 API 契约不变。

import { loadSettings, saveSettings, type FeishuInterceptMode } from './settings';
import { markNative, markNativeCtor } from '../dom-utils';
// 循环依赖说明：feishu.ts 只在 postJson 函数体内读 FEISHU_BYPASS（发送时），
// 本模块只在 decide 函数体内调 robotAddParsed（拦截时）——双方都是函数级访问，
// ESM 活绑定下无 TDZ 风险。
import { robotAddParsed } from './feishu';

/** 飞书 webhook 地址特征（对齐脚本：包含 hook 路径即命中） */
const HOOK_PATH_RE = /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\//;

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
let nativeXhrCtor: typeof XMLHttpRequest | null = null;

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

/**
 * 命中日志裁剪：超过上限时从最旧的一端淘汰**已决策**的条目。
 * 挂起（pending）中的条目绝不能被挤出——它一旦不在日志里，面板就渲染不出
 * 允许/拒绝按钮，而它的 resolver 还挂在 resolvers 里，请求只能干等超时。
 */
function trimHits(): void {
  if (hits.length <= NS_LOG_LIMIT) return;
  for (let i = hits.length - 1; i >= 0 && hits.length > NS_LOG_LIMIT; i--) {
    if (hits[i].decision !== 'pending') hits.splice(i, 1);
  }
  // 全是挂起条目的极端情况下才硬截（此时旧条目已无 UI 可裁决，靠超时兜底收尾）
  if (hits.length > NS_LOG_LIMIT) {
    const overflow = hits.splice(NS_LOG_LIMIT);
    for (const h of overflow) {
      const finish = resolvers.get(h.id);
      if (finish) {
        resolvers.delete(h.id);
        pendingIds.delete(h.id);
        const s = loadSettings();
        const allow = s.feishuOnTimeout !== 'block';
        h.decision = allow ? 'timeout-allowed' : 'timeout-denied';
        finish(allow, h.decision);
      }
    }
  }
}

// ---------- 脚本算法移植：URL 判定 / botId / 消息内容 ----------

/** 宽松匹配（脚本同款）：包含 hook 路径即命中，其余一律直通 */
function isTargetUrl(url: unknown): boolean {
  if (!url) return false;
  try {
    const u = typeof url === 'string' ? url : String(url);
    return HOOK_PATH_RE.test(u);
  } catch {
    return false;
  }
}

/** 脚本同款：`/hook/([^/?]+)` 萃取机器人 ID，取不到记「未知」 */
function extractBotId(url: string): string {
  const match = String(url).match(/\/hook\/([^/?]+)/);
  return match ? match[1] : '未知';
}

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

/** 脚本同款 extractMessageContent：把 webhook body 萃取成「人能看懂的」消息正文 */
function extractMessageContent(body: unknown): string {
  if (body === null || body === undefined) return '(无内容)';
  let raw = '';
  if (typeof body === 'string') raw = body;
  else if (body instanceof URLSearchParams) raw = body.toString();
  else if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    try {
      for (const [k, v] of body.entries()) parts.push(`${k}=${typeof v === 'string' ? v : '[file]'}`);
    } catch {
      /* ignore */
    }
    raw = parts.join('&');
  } else if (typeof Blob !== 'undefined' && body instanceof Blob) return '(Blob 数据)';
  else if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '(ArrayBuffer 数据)';
  else raw = String(body);

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const content = parsed.content;
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      if (c.text) return String(c.text);
      return JSON.stringify(content);
    }
    if (content) return String(content);
    if (parsed.text) return String(parsed.text);
    return raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

/**
 * 命中判定 + 决策（脚本 shouldAllowRequest 语义：先记录后按模式裁决）。
 * 返回 null = 与目标无关，调用方直通；Promise<boolean>：true 放行 / false 拒绝。
 * manual 模式下唤醒面板 UI 并等待；无人应答按超时兜底。
 */
function decide(url: string, method: string, body: unknown, via: FeishuHit['via']): Promise<boolean> | null {
  const s = loadSettings();
  const m = s.feishuIntercept;
  if (m === 'off') return null;
  if (!isTargetUrl(url)) return null;

  const raw = bodyToRaw(body);
  const hit: FeishuHit = {
    id: seq++,
    url: String(url),
    method: method || 'GET',
    botId: extractBotId(String(url)),
    kind: 'hook',
    text: extractMessageContent(body),
    raw: raw.slice(0, 2000),
    at: Date.now(),
    via,
    decision: 'pending',
  };
  // 脚本同款：命中先入记录（interceptedRequests.push），再按模式分支
  hits.unshift(hit);
  trimHits();

  // 用户设置开启时，捕获到的机器人按需自动登记进机器人列表
  //（robotAddParsed 内部按 token+kind 去重；botId 未知的不登记）
  if (hit.botId !== '未知' && s.feishuAutoAdd) {
    try {
      robotAddParsed({ id: hit.botId, name: hit.botId, token: hit.botId, kind: 'hook', src: 'intercept' });
    } catch {
      /* ignore */
    }
  }

  // 记忆规则优先（VaIMod 扩展）：命中即决，不再打扰
  const remembered = rules.get(hit.botId);
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
    // 脚本 blockAll：一律拒绝
    hit.decision = 'auto-denied';
    emit();
    return Promise.resolve(false);
  }

  // manual：挂起等面板裁决（脚本此处弹页面浮层对话框；本体内嵌面板，零宿主干扰）
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

// ===== 安装（脚本 hook 形态移植） =====
export function installFeishuGuard(): void {
  if (installed) return;
  installed = true;
  readRules();

  // ---------- 1. Hook fetch（脚本同款：string / Request 双形态，Request body 不读） ----------
  origFetch = window.fetch;
  const nativeFetch = origFetch;
  if (typeof nativeFetch === 'function') {
    const patched = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      // VaIMod 自身发出的消息直通（否则开着拦截模式会拦到自己）
      const internal = Boolean(init && (init as Record<PropertyKey, unknown>)[FEISHU_BYPASS]);
      if (internal || mode() === 'off') return nativeFetch.call(this as never, input, init);
      let url = '';
      let method = 'GET';
      let body: unknown = null;
      if (typeof input === 'string') {
        url = input;
        method = (init && init.method) || 'GET';
        body = (init && init.body) || null;
      } else if (input instanceof URL) {
        url = input.href;
        method = (init && init.method) || 'GET';
        body = (init && init.body) || null;
      } else if (input && typeof input === 'object') {
        // Request 对象：body 是 ReadableStream，不能直接读，否则会破坏原请求（脚本同款）
        url = (input as Request).url || '';
        method = (input as Request).method || (init && init.method) || 'GET';
        body = (init && init.body) || null;
      }
      const decision = decide(url, method, body, 'fetch');
      if (!decision) return nativeFetch.call(this as never, input, init);
      return decision.then((allow) => {
        if (allow) return nativeFetch.call(this as never, input, init);
        // 脚本同款：拒绝以 TypeError 拒绝
        return Promise.reject(new TypeError('请求被用户脚本拦截'));
      });
    };
    try {
      Object.defineProperty(patched, 'name', { configurable: true, value: 'fetch' });
      Object.defineProperty(patched, 'length', { configurable: true, value: 2 });
    } catch {
      /* ignore */
    }
    markNative(patched, 'fetch'); // toString 白名单：与 csense-guard 同口径
    window.fetch = patched as typeof fetch;
  }

  // ---------- 2. Hook XMLHttpRequest（脚本同款：实例级 HookedXHR，原型链保留） ----------
  // 实例级而不是原型级：axios 之类缓存原型方法的库也能被覆盖到；本体的 csense-guard
  // 在此之前已占住原型 open/send，实例 hook 经 `new NativeXHR()` 的原型链解析自动
  // 叠在 csense 钩子之上（feishu open → csense open → native），两层互不遮蔽。
  const NativeXHR = window.XMLHttpRequest;
  nativeXhrCtor = NativeXHR;
  type FsXhr = XMLHttpRequest & { __vaimod_fs_method?: string; __vaimod_fs_url?: string };

  const HookedXHR = function (): XMLHttpRequest {
    const xhr = new NativeXHR() as FsXhr;
    const originalOpen = xhr.open;
    const originalSend = xhr.send;

    xhr.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      xhr.__vaimod_fs_method = String(method || 'GET');
      xhr.__vaimod_fs_url = String(url);
      return (originalOpen as (this: FsXhr, m: string, u: string | URL, ...r: unknown[]) => void).apply(
        xhr,
        [method, url, ...rest],
      );
    } as typeof xhr.open;

    xhr.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const url = xhr.__vaimod_fs_url;
      const method = xhr.__vaimod_fs_method || 'GET';
      const decision = url ? decide(url, method, body ?? null, 'xhr') : null;
      if (!decision) {
        return (originalSend as (...a: unknown[]) => void).apply(xhr, [body as never]);
      }
      void decision.then((allow) => {
        if (allow) {
          try {
            (originalSend as (...a: unknown[]) => void).call(xhr, body as never);
          } catch {
            /* ignore */
          }
          return;
        }
        // 脚本同款语义：readyState=4 / status=0（defineProperty 绕过只读）+ error 通知。
        // 投递用 dispatchEvent：IDL 回调同样触发，addEventListener 型调用方不再永久悬挂。
        setTimeout(() => {
          try {
            Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(xhr, 'status', { value: 0, configurable: true });
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new ProgressEvent('error'));
            xhr.dispatchEvent(new ProgressEvent('loadend'));
          } catch {
            /* ignore */
          }
        }, 0);
      });
      return undefined as never;
    } as typeof xhr.send;

    return xhr;
  } as unknown as typeof XMLHttpRequest;

  // 脚本同款：保留原型链，instanceof 不失效
  (HookedXHR as unknown as { prototype: unknown }).prototype = NativeXHR.prototype;
  markNativeCtor(HookedXHR as unknown as object, 'XMLHttpRequest'); // toString 白名单（保留 prototype）
  window.XMLHttpRequest = HookedXHR;
}

/** 卸载（仅测试/调试用） */
export function uninstallFeishuGuard(): void {
  if (!installed) return;
  installed = false;
  if (origFetch) window.fetch = origFetch;
  if (nativeXhrCtor) window.XMLHttpRequest = nativeXhrCtor;
  for (const [, finish] of resolvers) finish(true, 'allowed');
  resolvers.clear();
  pendingIds.clear();
}

// ===== 对外只读面（UI 用，契约不变） =====
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
