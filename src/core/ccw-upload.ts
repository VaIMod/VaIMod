/**
 * ccw 官方对象存储直链上传（PostObject 协议）。
 *
 * ===== 为什么必须有这个模块 =====
 * 飞书「文件/图片发送」需要先拿到一个可公开访问的直链再发卡片。
 * 旧实现用的是三条**外部**图床（catbox.moe / 0x0.st / tmpfiles），
 * 实测在本机与浏览器环境**全部不可用**：
 *   · catbox.moe          → 连接失败（网络不可达）
 *   · 0x0.st              → HTTP 503（平台公告：因 AI 僵尸网络垃圾上传而停用）
 *   · uguu.se             → 上传成功但 OPTIONS 预检 400、响应无 Access-Control-Allow-Origin
 *                           → 浏览器端被 CORS 拦死，只能当参考
 *   · litterbox / bashupload / transfer.sh / tmpfiles / envs / pomf2 → 全部失败或超时
 * 而 ccw 站点自带的 `window.oss` 实例**从不暴露**给页面（它只是 webpack 模块内部导出），
 * 所以旧实现里那条 `ccw OSS` 主通道是**恒定失败**的 —— 面板上表现为「直链上传失败」。
 *
 * ===== 本模块做什么 =====
 * 完整复刻 ccw 站点自己的上传协议（已对站点产物逐行逆向确认）：
 *
 *   ① POST https://community-web.ccw.site/storage/post-policy
 *      body: { purpose, fileName, contentType, fileSize, contentHash }
 *      · contentHash = 文件内容的 **MD5 十六进制**（站点用 CryptoJS.MD5，口径一致）
 *      · fileName     = 文件名（不含 `..`）
 *      · contentType  = 按扩展名归一化
 *      → 响应 { objectKey, resourceUrl, url, fields:{key,policy,q-sign-algorithm,q-ak,q-key-time,q-signature}, forbidOverwrite, expireAt, ... }
 *
 *   ② 用 **XMLHttpRequest** 把 `fields` 各项 + `file` 以 FormData POST 到响应里的 `url`
 *      （腾讯云 COS PostObject 表单直传；2xx 即成功，`resourceUrl` 就是直链）
 *
 * 鉴权：站点 axios 走 `withCredentials:true`，token 取自
 *   `sessionStorage.__xigua_client_token__` → cookie `token`；
 * 服务端接受 cookie 或 `token` 请求头。CORS 预检实测放行
 *   `Access-Control-Allow-Origin: https://www.ccw.site` + `Allow-Credentials: true`
 *   + `Allow-Headers: content-type, token`。
 *
 * ===== 零副作用 =====
 * 只发两个请求（一次取策略、一次传文件），不读写宿主任何结构，
 * 不落地凭据，不改站点状态；失败时只回错误文案。
 */

import { md5HexOfBlob } from './md5';

/** 站点取上传策略的端点 */
export const CCW_POLICY_ENDPOINT = 'https://community-web.ccw.site/storage/post-policy';

/** 站点 sessionStorage 里的客户端 token 键 */
const CCW_SESSION_TOKEN_KEY = '__xigua_client_token__';

/** 上传用途（站点枚举里的通用临时文件用途） */
export type CcwPurpose = 'TEMP_FILE' | 'PROJECT_ASSET' | 'WORK_COVER';

/** 站点自己的扩展名 → contentType 映射（逆向自站点模块 `5n2j`） */
const CCW_CONTENT_TYPES: Record<string, string> = {
  atlas: 'text/plain',
  gif: 'image/gif',
  glsl: 'text/plain',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'application/javascript',
  json: 'application/json',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  png: 'image/png',
  py: 'text/plain',
  sb3: 'application/zip',
  skel: 'application/octet-stream',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  zip: 'application/zip',
};

/** 上传结果 */
export interface CcwUploadOutcome {
  ok: boolean;
  /** 直链（成功时） */
  url?: string;
  /** 对象键（成功时，便于排障） */
  objectKey?: string;
  /** 失败原因（中文，可直接展示） */
  error?: string;
  /** 是否因为未登录 / 登录态失效 */
  needLogin?: boolean;
  /** 是否网络不可达（区别于服务端拒绝） */
  offline?: boolean;
}

/** 读 cookie（同名取第一个） */
function readCookie(name: string): string | null {
  try {
    const raw = document.cookie || '';
    for (const part of raw.split(';')) {
      const kv = part.split('=');
      if (kv.length < 2) continue;
      if (kv[0].trim() !== name) continue;
      return decodeURIComponent(kv.slice(1).join('=').trim());
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 取站点客户端 token（与站点 `getAuthToken()` 同口径）。
 * 返回 null 表示拿不到 —— 此时仍可尝试（cookie 可能自动随请求带上）。
 */
export function resolveCcwToken(): string | null {
  try {
    const s = sessionStorage.getItem(CCW_SESSION_TOKEN_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  return readCookie('token');
}

/**
 * 文件名规范化（对齐站点 `d()`）：
 * 取最后一段路径（同时切 `/` 与 `\`），为空或含 `..` 一律拒绝。
 */
export function sanitizeFileName(raw: string): string {
  const name = String(raw ?? '')
    .split('/')
    .pop()
    ?.split('\\')
    .pop() ?? '';
  if (!name || name.includes('..')) throw new Error('文件名不合法');
  return name;
}

/** 取扩展名（小写，站点用 `^[a-z0-9]{1,16}$` 口径） */
export function extOfName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || !/^[a-z0-9]{1,16}$/.test(ext)) throw new Error(`不支持的文件名：${name}`);
  return ext;
}

/**
 * 归一化 contentType。
 * 站点对未知扩展名是**客户端直接抛错**的；但那份白名单只覆盖站点自己的上传场景，
 * 我们这里不做同等硬限制（避免 PDF/文档类直接不可用），改为：
 *   · 命中站点白名单 → 用站点口径
 *   · 未命中           → 用浏览器给出的 MIME，再兜底 octet-stream
 * 服务端若拒绝，会把拒绝原因原样带回。
 */
export function contentTypeOf(name: string, mime?: string): string {
  const ext = extOfName(name);
  const known = CCW_CONTENT_TYPES[ext];
  if (known) return known;
  const m = String(mime ?? '').trim();
  if (m && /^[a-z0-9!\#$&^_.+-]+\/[a-z0-9!\#$&^_.+-]+$/i.test(m)) return m;
  return 'application/octet-stream';
}

/** 站点返回的上传策略 */
interface CcwPolicy {
  objectKey: string;
  resourceUrl: string;
  url: string;
  expireAt?: string | number;
  forbidOverwrite?: boolean;
  contentAddressed?: boolean;
  alreadyExists?: boolean;
  fields: Record<string, string>;
  provider?: string;
}

/** COS PostObject 必填字段（逆向自站点 vendor 模块 `skS+`） */
const COS_REQUIRED_FIELDS = [
  'key',
  'policy',
  'q-sign-algorithm',
  'q-ak',
  'q-key-time',
  'q-signature',
];

/** 校验策略包完整性（与站点 `l()` 同口径，缺字段直接给出可读原因） */
function checkPolicy(p: CcwPolicy): void {
  if (!p || typeof p !== 'object') throw new Error('上传策略为空');
  if (p.provider && p.provider !== 'COS') throw new Error('上传策略类型不支持');
  if (!p.url || !p.objectKey || !p.resourceUrl) throw new Error('上传策略不完整');
  if (!p.fields || typeof p.fields !== 'object' || !Object.keys(p.fields).length) {
    throw new Error('上传策略字段为空');
  }
  for (const k of COS_REQUIRED_FIELDS) {
    const v = p.fields[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`上传策略缺字段：${k}`);
  }
  if (p.fields.key !== p.objectKey) throw new Error('上传策略键不匹配');
}

/** 用 XHR 把文件 POST 到 COS（表单直传，2xx 即成功） */
function putToCos(file: File, policy: CcwPolicy, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest !== 'function' || typeof FormData !== 'function') {
      reject(new Error('当前环境不支持文件直传'));
      return;
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(policy.fields)) {
      if (v === undefined || v === null) continue;
      form.append(k, String(v));
    }
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', policy.url);
    xhr.upload.onprogress = (e: ProgressEvent): void => {
      try {
        if (e.lengthComputable && e.total > 0) onProgress?.(Math.round((e.loaded / e.total) * 100));
      } catch {
        /* ignore */
      }
    };
    xhr.onerror = (): void => reject(new Error('文件传输网络错误'));
    xhr.onabort = (): void => reject(new Error('文件传输已中止'));
    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`文件传输失败（${xhr.status}）${xhr.responseText ? ` ${String(xhr.responseText).slice(0, 120)}` : ''}`));
    };
    xhr.send(form);
  });
}

/** 把服务端返回体翻成可读错误 */
function readApiError(status: number, body: string): { error: string; needLogin: boolean } {
  let msg = '';
  try {
    const j = JSON.parse(body) as { msg?: string; message?: string; error?: string };
    msg = String(j.msg ?? j.message ?? j.error ?? '');
  } catch {
    msg = String(body ?? '').slice(0, 120);
  }
  if (status === 401 || status === 403) {
    // 登录态问题要给明确指引（用户最常见的就是没登录 / 登录过期）
    return {
      error: `未登录或登录态已失效${msg ? `（${msg}）` : ''}，请先登录 ccw 站点`,
      needLogin: true,
    };
  }
  return { error: msg || `上传策略申请失败（${status}）`, needLogin: false };
}

/**
 * 上传文件到 ccw 对象存储，返回可公开访问的直链。
 *
 * @param file       待上传文件
 * @param purpose    上传用途（默认临时文件）
 * @param onProgress 上传进度回调（0-100）
 */
export async function uploadToCcw(
  file: File,
  purpose: CcwPurpose = 'TEMP_FILE',
  onProgress?: (pct: number) => void,
): Promise<CcwUploadOutcome> {
  let fileName = '';
  try {
    const rawName = file.name || 'upload.bin';
    fileName = sanitizeFileName(rawName);
    const contentType = contentTypeOf(fileName, file.type);

    // ① 申请上传策略
    const contentHash = await md5HexOfBlob(file);

    const token = resolveCcwToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.token = token;

    let res: Response;
    try {
      res = await fetch(CCW_POLICY_ENDPOINT, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          purpose,
          fileName,
          contentType,
          fileSize: file.size,
          contentHash,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `无法连接 ccw 上传服务（${msg}）`, offline: true };
    }

    const bodyText = await res.text();
    if (!res.ok) {
      const e = readApiError(res.status, bodyText);
      return { ok: false, error: e.error, needLogin: e.needLogin };
    }
    let policy: CcwPolicy;
    try {
      policy = JSON.parse(bodyText) as CcwPolicy;
    } catch {
      return { ok: false, error: '上传策略返回格式异常' };
    }

    // ② 内容寻址命中（服务端已存在同内容对象）→ 直接给直链
    if (policy.alreadyExists && policy.resourceUrl) {
      return { ok: true, url: policy.resourceUrl, objectKey: policy.objectKey };
    }

    // ③ 直传 COS
    try {
      checkPolicy(policy);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
    try {
      await putToCos(file, policy, onProgress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `文件传输失败：${msg}` };
    }
    return { ok: true, url: policy.resourceUrl, objectKey: policy.objectKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
