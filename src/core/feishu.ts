// ===== 飞书群机器人通道（webhook 直发，不触开放平台凭证） =====
// 设计（对齐 ccw「飞书」扩展能力面并补齐可操作性）：
// - 机器人地址归一化：接受完整 webhook URL / 捷径 URL / 纯 token，统一为可发状态；
// - 机器人登记表持久化 + 自动捕获（变量/列表内容，含云变量）→ 作品里可能多个 ID；
// - 发送：文本 / @全员 / @指定 / 图片(image_key) / 卡片 / 捷径 JSON 透传；
// - 图片与任意文件：先上传拿直链（ccw OSS 主用 → catbox.moe → 0x0.st 降级），
//   再以「卡片链接 / 文本直链」发出（webhook 无法上传媒体，此为无凭证下的最优路径）。

import { FEISHU_BYPASS } from './feishu-guard';

export interface FeishuRobot {
  id: string; // 唯一登记 id（自动捕获时为 token）
  name: string;
  token: string; // webhook 尾部 / 捷径 id
  kind: 'hook' | 'flow';
  src: 'var' | 'manual' | 'seed';
  at: number;
  pin?: boolean; // 手动置顶（常用机器人）
}

const NS_ROBOTS = ['vai', 'mod', '_fs_robots'].join('');
const HOOK_RE = /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/([A-Za-z0-9\-_]+)/;
const FLOW_RE = /(?:www\.|open\.)?feishu\.cn\/flow\/api\/trigger-webhook\/([A-Za-z0-9\-_]+)/;
const BARE_RE = /^[A-Za-z0-9\-_]{10,80}$/;

/** 从任意输入（URL / token / 含 token 文本）解析出可用机器人描述；无法解析返回 null */
export function normalizeRobot(input: string): { token: string; kind: 'hook' | 'flow' } | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const h = raw.match(HOOK_RE);
  if (h) return { token: h[1], kind: 'hook' };
  const f = raw.match(FLOW_RE);
  if (f) return { token: f[1], kind: 'flow' };
  if (BARE_RE.test(raw)) {
    // 纯 token：按 webhook 处理（兼容用户直接粘贴机器人 URL 尾部 key）
    return { token: raw, kind: 'hook' };
  }
  return null;
}

export function hookUrlOf(r: FeishuRobot | { token: string; kind: 'hook' | 'flow' }): string {
  return r.kind === 'flow'
    ? `https://www.feishu.cn/flow/api/trigger-webhook/${r.token}`
    : `https://open.feishu.cn/open-apis/bot/v2/hook/${r.token}`;
}

export function maskToken(t: string): string {
  return t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
}

// ---------- 登记表 ----------
function readRobots(): FeishuRobot[] {
  try {
    const raw = localStorage.getItem(NS_ROBOTS);
    const list = raw ? (JSON.parse(raw) as FeishuRobot[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRobots(list: FeishuRobot[]): void {
  try {
    localStorage.setItem(NS_ROBOTS, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function robotList(): FeishuRobot[] {
  return readRobots().sort((a, b) => {
    const pa = a.pin ? 1 : 0;
    const pb = b.pin ? 1 : 0;
    if (pa !== pb) return pb - pa; // 置顶优先
    return b.at - a.at; // 其次最近使用
  });
}

/** 整体覆盖（用于配置包导入） */
export function setRobots(list: FeishuRobot[]): void {
  saveRobots(list);
}

/** 切换「常用置顶」（置顶的排在最前，便于快速点选） */
export function robotPin(token: string, kind: 'hook' | 'flow', pinned: boolean): void {
  const list = readRobots();
  const hit = list.find((r) => r.token === token && r.kind === kind);
  if (!hit) return;
  hit.pin = pinned;
  saveRobots(list);
}

/** 追加（同 token 去重；同 id 刷新时间戳） */
export function robotAdd(name: string, input: string, src: FeishuRobot['src']): FeishuRobot | null {
  const parsed = normalizeRobot(input);
  if (!parsed) return null;
  const list = readRobots();
  const hit = list.find((r) => r.token === parsed.token && r.kind === parsed.kind);
  let stored: FeishuRobot;
  if (hit) {
    hit.name = name || hit.name;
    hit.src = src === 'manual' ? 'manual' : hit.src;
    hit.at = Date.now();
    stored = hit;
  } else {
    stored = {
      id: parsed.kind === 'flow' ? `f_${parsed.token}` : parsed.token,
      name: name || maskToken(parsed.token),
      token: parsed.token,
      kind: parsed.kind,
      src,
      at: Date.now(),
    };
    list.push(stored);
  }
  saveRobots(list);
  return stored;
}

export function robotAddParsed(r: Omit<FeishuRobot, 'at'>): void {
  const list = readRobots();
  if (list.some((x) => x.token === r.token && x.kind === r.kind)) return;
  list.push({ ...r, at: Date.now() });
  saveRobots(list);
}

export function robotRemove(token: string, kind: 'hook' | 'flow'): void {
  saveRobots(readRobots().filter((r) => !(r.token === token && r.kind === kind)));
}

// ---------- 从文本/值里采集机器人 token ----------
/** 从变量名 / 变量值里提取 webhook token（记录判定出的类型，供 URL 拼接使用） */
export function extractTokens(value: unknown, out: Map<string, 'hook' | 'flow'>): void {
  const collect = (s: string) => {
    const h = s.match(HOOK_RE);
    if (h) out.set(h[1], 'hook');
    const f = s.match(FLOW_RE);
    if (f) out.set(f[1], 'flow');
  };
  if (typeof value === 'string') {
    collect(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') collect(v);
      else if (v && typeof v === 'object') extractTokens(v, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) extractTokens(v, out);
  }
}

/**
 * 批量把采集到的 token 写入登记表，返回新增数。
 * kind 必须跟着 token 一起传：旧实现一律按 'hook' 登记，扫到的捷径（flow）webhook
 * 会被拼成 bot/v2/hook 地址，发送必然失败。同名同 token 但类型判错的旧记录就地纠正。
 */
export function ingestTokens(tokens: Map<string, 'hook' | 'flow'>, src: 'var'): number {
  let added = 0;
  let fixed = 0;
  const list = readRobots();
  for (const [token, kind] of tokens) {
    const exist = list.find((r) => r.token === token);
    if (exist) {
      if (exist.kind !== kind) {
        exist.kind = kind;
        fixed++;
      }
      continue;
    }
    list.push({ id: token, name: maskToken(token), token, kind, src, at: Date.now() });
    added++;
  }
  if (added > 0 || fixed > 0) saveRobots(list);
  return added;
}

// ---------- 发送 ----------
export interface SendResult {
  token: string;
  ok: boolean;
  code?: number;
  detail?: string;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; code?: number; detail?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // VaIMod 自己发的消息不进拦截队列（否则开着拦截模式时会拦到自己）
      [FEISHU_BYPASS]: true,
    } as RequestInit);
    let msg = '';
    try {
      const j = (await res.json()) as { code?: number; msg?: string };
      msg = j.msg ?? '';
      if (res.ok && (j.code === undefined || j.code === 0)) return { ok: true, code: j.code };
      return { ok: false, code: j.code ?? res.status, detail: msg };
    } catch {
      return { ok: res.ok, code: res.status };
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function urlOf(kind: 'hook' | 'flow', token: string): string {
  return hookUrlOf({ token, kind });
}

export async function sendText(kind: 'hook' | 'flow', token: string, text: string): Promise<SendResult> {
  const res = await postJson(urlOf(kind, token), { msg_type: 'text', content: { text: String(text).slice(0, 2000) } });
  return { token, ...res };
}

export async function sendAt(kind: 'hook' | 'flow', token: string, text: string, atUser: string): Promise<SendResult> {
  const uid = String(atUser).trim();
  const rich = uid
    ? `${text} <at user_id="${uid}"></at>`
    : text;
  const res = await postJson(urlOf(kind, token), { msg_type: 'text', content: { text: rich } });
  return { token, ...res };
}

export async function sendAtAll(kind: 'hook' | 'flow', token: string, text: string): Promise<SendResult> {
  const rich = `${text} <at user_id="all"></at>`;
  const res = await postJson(urlOf(kind, token), { msg_type: 'text', content: { text: rich } });
  return { token, ...res };
}

export async function sendImage(kind: 'hook' | 'flow', token: string, imageKey: string): Promise<SendResult> {
  const res = await postJson(urlOf(kind, token), { msg_type: 'image', content: { image_key: String(imageKey).trim() } });
  return { token, ...res };
}

/** card: 已构造好的 interactive card 对象（card 字段） */
export async function sendCard(kind: 'hook' | 'flow', token: string, card: unknown): Promise<SendResult> {
  const res = await postJson(urlOf(kind, token), { msg_type: 'interactive', card });
  return { token, ...res };
}

export async function sendRawJson(kind: 'hook' | 'flow', token: string, data: unknown): Promise<SendResult> {
  const res = await postJson(urlOf(kind, token), data);
  return { token, ...res };
}

// ---------- 卡片构造 ----------
export interface CardLinkOptions {
  title: string;
  url: string;
  desc?: string;
  color?: string;
}

/** 链接卡片：标题 + markdown 链接 + 说明（webhook 下「文件/图片直链」的标准呈现） */
export function buildLinkCard(o: CardLinkOptions): unknown {
  const lines = [`**[${o.title}](${o.url})**`];
  if (o.desc) lines.push(o.desc);
  return {
    header: { title: { tag: 'plain_text', content: o.title.slice(0, 40) }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'VaIMod · 已上传直链' }] },
    ],
  };
}

export function buildTextCard(title: string, text: string): unknown {
  return {
    header: { title: { tag: 'plain_text', content: title.slice(0, 40) }, template: 'grey' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  };
}

// ---------- 直链上传（图片/任意文件） ----------
// 主通道改为 ccw 站点自带的 OSS（`window.oss.put`，见「文件上传工具」同款接法）：
// tmpfiles.org 已停止服务，catbox/0x0.st 仅作降级。
export type UploadHost = 'ccw' | 'catbox' | '0x0';

export interface UploadOutcome {
  ok: boolean;
  url?: string;
  host?: UploadHost;
  error?: string;
}

/** ccw OSS 允许的路径前缀（镜像站点资源桶策略；命中其一才可能被接受） */
const CCW_PREFIXES = [
  'user_projects_assets',
  'works-covers',
  'creator-college',
  'gandi',
  'gandi_application',
  'avatar',
  'user_projects_sb3',
];

/** ccw 站点直链基址（与站点资源引用一致） */
const CCW_BASE = 'https://m.ccw.site/';

function randomHex(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ((Math.random() * 16) | 0).toString(16);
  return s;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
};

/** 取扩展名：优先文件名，其次按 MIME 推断，兜底 bin */
function extOf(file: File): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(file.name || '');
  if (m) return m[1].toLowerCase();
  return MIME_EXT[file.type] || 'bin';
}

type CcwOss = { put: (path: string, file: File | Blob) => Promise<unknown> };

/** 取站点注入的 OSS 实例（可能在 window 或 GM 的 unsafeWindow 上） */
function ccwOss(): CcwOss | null {
  try {
    const w = window as unknown as Record<string, unknown>;
    const direct = w.oss as CcwOss | undefined;
    if (direct && typeof direct.put === 'function') return direct;
    const unsafe = w.unsafeWindow as Record<string, unknown> | undefined;
    const relay = unsafe?.oss as CcwOss | undefined;
    if (relay && typeof relay.put === 'function') return relay;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 上传到 ccw OSS。站点 SDK 只在加载了 OSS 的 ccw 页面上存在（m.ccw.site 等），
 * 拿不到实例时直接抛错交给降级通道，而不是静默失败。
 * 路径前缀按站点桶策略逐个尝试——不同页面开放的桶不一样。
 */
async function uploadCcw(file: File): Promise<string> {
  const oss = ccwOss();
  if (!oss) throw new Error('ccw OSS 不可用（当前页面未注入 window.oss）');
  const ext = extOf(file);
  let lastErr = '';
  for (const prefix of CCW_PREFIXES) {
    const path = `${prefix}/${randomHex(32)}.${ext}`;
    try {
      await oss.put(path, file);
      return CCW_BASE + path;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`ccw OSS: ${lastErr.slice(0, 80) || '全部前缀均被拒绝'}`);
}

async function uploadCatbox(file: File): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', file, file.name);
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`catbox: ${text.slice(0, 80) || res.status}`);
  return text;
}

async function upload0x0(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('https://0x0.st', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`0x0.st: ${text.slice(0, 80) || res.status}`);
  return text;
}

/** 上传任意文件到直链；ccw OSS 主用，catbox / 0x0.st 降级。失败返回错误信息 */
export async function uploadToLink(file: File): Promise<UploadOutcome> {
  if (file.size > 180 * 1024 * 1024) return { ok: false, error: '文件过大（上限 180MB）' };
  const attempts: Array<[UploadHost, (f: File) => Promise<string>]> = [
    ['ccw', uploadCcw],
    ['catbox', uploadCatbox],
    ['0x0', upload0x0],
  ];
  let lastErr = '';
  for (const [host, fn] of attempts) {
    try {
      const url = await fn(file);
      return { ok: true, url, host };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: `直链上传失败：${lastErr.slice(0, 120)}` };
}

/** 读本地文件为 DataURL（小图预览 / 备用发送） */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
