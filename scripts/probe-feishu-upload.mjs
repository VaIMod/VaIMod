/**
 * 飞书直链上传专项探针 —— 验证 ccw 官方 PostObject 上传协议的实现正确性。
 *
 * 背景：面板上的「直链上传失败」是因为旧实现用的是三条外部图床
 *   （catbox / 0x0.st / tmpfiles —— 实测浏览器端全部不可用），
 *   而站点自带的 `window.oss` 实例从不暴露给页面 → 主通道恒失败。
 *   新实现改走站点自己的上传协议（已对站点产物逐行逆向确认）：
 *     ① POST /storage/post-policy  {purpose,fileName,contentType,fileSize,contentHash}
 *     ② XHR FormData 直传 COS → resourceUrl 即直链
 *
 * 探针覆盖：
 *   H-1  MD5 实现对齐标准向量（空串 / abc / 快速棕色狐狸 / 千字符长串）
 *   H-2  contentHash 确实是文件内容的 MD5（与站点 CryptoJS 口径一致）
 *   H-3  策略请求的 URL / 方法 / body 字段 / 凭据模式 / token 头全对
 *   H-4  COS 直传的 URL / FormData 字段（fields 各项 + file）/ 成功判定
 *   H-5  返回的直链 = resourceUrl
 *   E-1  策略接口 401 → 判定为「未登录」，给出可读原因
 *   E-2  网络不可达 → 判定为「离线」，给出可读原因
 *   E-3  策略字段缺失 → 明确报出缺哪个字段
 *   E-4  COS 返回非 2xx → 报错带状态码
 *   S-1  文件名规范化：拒绝 `..`、取最后一段路径
 *   S-2  contentType：白名单命中用站点口径，未命中用浏览器 MIME 兜底
 *
 * 用法：node scripts/probe-feishu-upload.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-upload');

// ---------- 1. 编译真实源码 ----------

const ENTRY = `
export { md5Hex, md5HexOfBlob } from '../src/core/md5';
export { uploadToCcw, sanitizeFileName, contentTypeOf, extOfName, resolveCcwToken, CCW_POLICY_ENDPOINT } from '../src/core/ccw-upload';
export { uploadToLink, uploadHostLabel } from '../src/core/feishu';
`;

function build() {
  const entryPath = path.join(TMP, 'entry.ts');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(entryPath, ENTRY, 'utf8');
  const outDir = path.join(TMP, 'js');
  mkdirSync(outDir, { recursive: true });
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      entryPath,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'ES2020',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--skipLibCheck',
      '--rootDir',
      ROOT,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  return path.join(outDir, '.probe-tmp-upload', 'entry.js');
}

// ---------- 2. 环境垫片 ----------

function installStubs() {
  const store = {};
  globalThis.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  globalThis.document = { cookie: '' };
  globalThis.window = globalThis;
  globalThis.localStorage = globalThis.sessionStorage;
}

/** 记录一次 XHR 调用 */
let xhrCalls = [];

/** 安装可编排的 XMLHttpRequest 桩 */
function installXhrStub(behaviour) {
  xhrCalls = [];
  class FakeXhr {
    constructor() {
      this.upload = { onprogress: null };
      this.status = 0;
      this.responseText = '';
      this.statusText = '';
      this.onload = null;
      this.onerror = null;
      this.onabort = null;
      this._body = null;
      this._method = '';
      this._url = '';
    }
    open(method, url) {
      this._method = method;
      this._url = url;
    }
    send(body) {
      this._body = body;
      const rec = { method: this._method, url: this._url, body };
      xhrCalls.push(rec);
      const r = behaviour(rec, this);
      if (r === 'error') {
        setTimeout(() => this.onerror && this.onerror(new Error('network')), 0);
        return;
      }
      this.status = r?.status ?? 200;
      this.responseText = r?.body ?? '';
      setTimeout(() => this.onload && this.onload(), 0);
    }
    abort() {
      if (this.onabort) this.onabort();
    }
  }
  globalThis.XMLHttpRequest = FakeXhr;
}

/** 安装可编排的 fetch 桩 */
let fetchCalls = [];
function installFetchStub(behaviour) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const r = behaviour({ url, init });
    if (r?.throw) throw new Error(r.throw);
    return {
      ok: r?.status ? r.status >= 200 && r.status < 300 : true,
      status: r?.status ?? 200,
      text: async () => r?.body ?? '',
    };
  };
}

// ---------- 3. 主流程 ----------

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

/** 构造一个内存文件 */
function memFile(name, content, type = '') {
  const bytes = new TextEncoder().encode(content);
  return new File([bytes], name, { type });
}

const POLICY_URL = 'https://community-web.ccw.site/storage/post-policy';

async function main() {
  const mod = build();
  installStubs();
  const api = require(mod);

  add('A1. 真实源码模块加载成功', !!api, `导出数=${Object.keys(api).length}`);

  // ── H-1：MD5 标准向量 ──
  const enc = new TextEncoder();
  const vec = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
    ['a'.repeat(1000), 'cabe45dcc9ae5b66ba86600cca6b8ba8'],
  ];
  let md5Ok = true;
  const md5Detail = [];
  for (const [text, want] of vec) {
    const got = api.md5Hex(enc.encode(text));
    md5Detail.push(`${text.length}字→${got.slice(0, 8)}`);
    if (got !== want) md5Ok = false;
  }
  add('H-1. MD5 实现对齐标准向量', md5Ok, md5Detail.join(' '));

  // ── S-1：文件名规范化 ──
  // 口径与站点 `d()` 完全一致：取最后一段路径（/ 与 \ 都切），
  // 结果里含 `..` 一律拒绝（防止对象键路径穿越）。
  let s1ok = true;
  const s1detail = [];
  try {
    if (api.sanitizeFileName('a/b/c.png') !== 'c.png') s1ok = false;
    if (api.sanitizeFileName('dir\\file.png') !== 'file.png') s1ok = false;
    if (api.sanitizeFileName('../evil.png') !== 'evil.png') s1ok = false;
    s1detail.push('basename 正确');
  } catch (e) {
    s1ok = false;
    s1detail.push(`抛错:${e.message}`);
  }
  try {
    api.sanitizeFileName('a..b.png');
    s1ok = false;
    s1detail.push('含 .. 的文件名未被拒绝');
  } catch {
    s1detail.push('含 .. 被拒绝');
  }
  add('S-1. 文件名规范化正确', s1ok, s1detail.join(' '));

  // ── S-2：contentType ──
  const ctOk =
    api.contentTypeOf('a.png') === 'image/png' &&
    api.contentTypeOf('a.PNG') === 'image/png' &&
    api.contentTypeOf('a.pdf', 'application/pdf') === 'application/pdf' &&
    api.contentTypeOf('a.bin') === 'application/octet-stream';
  add(
    'S-2. contentType 归一化正确',
    ctOk,
    `png=${api.contentTypeOf('a.png')} pdf=${api.contentTypeOf('a.pdf', 'application/pdf')} bin=${api.contentTypeOf('a.bin')}`,
  );

  // ── H-3 / H-4 / H-5：完整上传流程 ──
  const policy = {
    provider: 'COS',
    objectKey: 'user_projects_assets/abc.png',
    resourceUrl: 'https://m.ccw.site/user_projects_assets/abc.png',
    url: 'https://bucket.cos.ap-beijing.myqcloud.com/',
    expireAt: '2026-01-01T00:00:00Z',
    forbidOverwrite: false,
    fields: {
      key: 'user_projects_assets/abc.png',
      policy: 'eyJleHBpcmF0aW9uIjoxfQ==',
      'q-sign-algorithm': 'sha1',
      'q-ak': 'AKIDtest',
      'q-key-time': '1760000000;1760003600',
      'q-signature': 'sigtest',
    },
  };
  installFetchStub(() => ({ status: 200, body: JSON.stringify(policy) }));
  installXhrStub(() => ({ status: 200, body: '' }));

  // 登录态 token
  globalThis.sessionStorage.setItem('__xigua_client_token__', 'tok-123');
  const file = memFile('hello.png', 'HELLO-CONTENT', 'image/png');
  const out = await api.uploadToCcw(file);

  const policyReq = fetchCalls[0];
  const body = policyReq ? JSON.parse(policyReq.init.body) : {};
  const wantHash = api.md5Hex(enc.encode('HELLO-CONTENT'));

  add(
    'H-3a. 策略请求端点与方法正确',
    !!policyReq && policyReq.url === POLICY_URL && policyReq.init.method === 'POST',
    `${policyReq?.url} ${policyReq?.init?.method}`,
  );
  add(
    'H-3b. 策略请求 body 字段完整且 hash 正确',
    body.purpose === 'TEMP_FILE' &&
      body.fileName === 'hello.png' &&
      body.contentType === 'image/png' &&
      body.fileSize === file.size &&
      body.contentHash === wantHash,
    JSON.stringify(body),
  );
  add(
    'H-3c. 携带 token 头且走 include 凭据',
    policyReq?.init?.headers?.token === 'tok-123' && policyReq?.init?.credentials === 'include',
    `token=${policyReq?.init?.headers?.token} credentials=${policyReq?.init?.credentials}`,
  );
  add('H-2. contentHash = 文件内容 MD5', body.contentHash === wantHash, `${body.contentHash}`);

  const xhr = xhrCalls[0];
  let formOk = false;
  let formDetail = '';
  if (xhr) {
    const fd = xhr.body;
    const keys = [...fd.keys()];
    const fileEntry = fd.get('file');
    formOk =
      xhr.method === 'POST' &&
      xhr.url === policy.url &&
      keys.includes('key') &&
      keys.includes('policy') &&
      keys.includes('q-signature') &&
      keys.includes('file');
    formDetail = `keys=${keys.join(',')} file=${fileEntry?.name ?? '<无>'}`;
  }
  add('H-4. COS 直传 URL 与 FormData 字段正确', formOk, formDetail);
  add('H-5. 返回直链 = resourceUrl', out.ok === true && out.url === policy.resourceUrl, `url=${out.url}`);
  add(
    'H-5b. 通道标签可用',
    api.uploadHostLabel('ccw') === 'ccw 云存储' && api.uploadHostLabel(undefined) === '直链',
    api.uploadHostLabel('ccw'),
  );

  // ── E-1：策略接口 401 ──
  installFetchStub(() => ({ status: 401, body: JSON.stringify({ code: 1092401, msg: 'token为空' }) }));
  const out401 = await api.uploadToCcw(memFile('a.png', 'x'));
  add(
    'E-1. 401 判定为未登录并给出可读原因',
    out401.ok === false && out401.needLogin === true && /登录/.test(out401.error ?? ''),
    `needLogin=${out401.needLogin} error=${out401.error}`,
  );

  // ── E-2：网络不可达 ──
  installFetchStub(() => ({ throw: 'Failed to fetch' }));
  const outNet = await api.uploadToCcw(memFile('a.png', 'x'));
  add(
    'E-2. 网络不可达判定为离线',
    outNet.ok === false && outNet.offline === true && /无法连接/.test(outNet.error ?? ''),
    `offline=${outNet.offline} error=${outNet.error}`,
  );

  // ── E-3：策略字段缺失 ──
  installFetchStub(() => ({
    status: 200,
    body: JSON.stringify({ ...policy, fields: { key: 'k' } }),
  }));
  const outFields = await api.uploadToCcw(memFile('a.png', 'x'));
  add(
    'E-3. 策略字段缺失时明确报出缺哪个字段',
    outFields.ok === false && /缺字段/.test(outFields.error ?? ''),
    `error=${outFields.error}`,
  );

  // ── E-4：COS 返回非 2xx ──
  installFetchStub(() => ({ status: 200, body: JSON.stringify(policy) }));
  installXhrStub(() => ({ status: 403, body: '<Error>AccessDenied</Error>' }));
  const outCos = await api.uploadToCcw(memFile('a.png', 'x'));
  add(
    'E-4. COS 非 2xx 时报错带状态码',
    outCos.ok === false && /403/.test(outCos.error ?? ''),
    `error=${outCos.error}`,
  );

  // ── 兜底：uploadToLink 走主通道 ──
  installFetchStub(() => ({ status: 200, body: JSON.stringify(policy) }));
  installXhrStub(() => ({ status: 200, body: '' }));
  const link = await api.uploadToLink(memFile('hello.png', 'HELLO-CONTENT', 'image/png'));
  add(
    'S-3. uploadToLink 主通道返回 ccw 直链',
    link.ok === true && link.host === 'ccw' && link.url === policy.resourceUrl,
    `host=${link.host} url=${link.url}`,
  );

  console.log('');
  let pass = 0;
  for (const c of checks) {
    if (c.ok) {
      pass++;
      console.log(`  ✓ ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
    } else {
      console.log(`  ✗ ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
    }
  }
  console.log(`\n通过 ${pass} / ${checks.length}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
