/**
 * 产物级行为验证 —— 在 jsdom 提供的**真实 DOM 环境**里执行构建产物。
 *
 * 设计要点：
 *  1. 不用 node:vm 的独立 context —— 那里 `Document.prototype.hidden` 等内建对象
 *     与 Node realm 不是同一套，页面可见性判定会误判，导致巡检提前 return
 *     （沙箱保真度缺陷，不是产物缺陷）。jsdom + 当前 realm 组合可避免。
 *  2. DOM 用 jsdom 实现（而非手搓桩）：Svelte 面板挂载需要真实的
 *     Node.prototype descriptor / cloneNode / querySelector 语义，桩做不到。
 *  3. 时间压缩：把 400ms / 2000ms 的长延时压到 25ms，让巡检 ticker 在测试
 *     窗口内确定性地触发若干轮，同时保留真实定时器语义（产物内部有
 *     await setTimeout 的等待逻辑，虚拟时钟会死锁）。
 *
 * 用法：
 *   node scripts/verify-artifact-behavior.mjs                # 验证 dist/VaIMod.user.js
 *   node scripts/verify-artifact-behavior.mjs --raw <file>   # 验证未混淆产物
 *   node scripts/verify-artifact-behavior.mjs <file>          # 验证混淆产物（自动解码）
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────── 1. 产物解码 ───────────────────

/**
 * 混淆产物解码：最长 base64 字面量 = 载荷，32 字节 base64 字面量 = XOR 密钥，
 * XOR 后 gunzip 得到第一层明文（混淆器固定 seed，这层跨构建逐字节可复现）。
 * 未混淆产物没有这种结构 → 原样返回。
 */
function decodeArtifact(file) {
  const code = readFileSync(file, 'utf8');
  const lit = /(["'`])([A-Za-z0-9+/]{24,}={0,2})\1/g;
  let m;
  let payload = null;
  let key = null;
  while ((m = lit.exec(code)) !== null) {
    const raw = m[2];
    let buf;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      continue;
    }
    if (buf.length === 32 && !key) key = buf;
    if (!payload || raw.length > payload.raw.length) payload = { raw, buf };
  }
  if (!payload || !key) return { code, stage: 'raw' };
  try {
    const out = Buffer.alloc(payload.buf.length);
    for (let i = 0; i < out.length; i++) out[i] = key[i % key.length] ^ payload.buf[i];
    const stage = gunzipSync(out).toString('utf8');
    return { code: stage, stage: 'decoded' };
  } catch {
    return { code, stage: 'raw' };
  }
}

// ─────────────────── 2. 敌扩展样本（YinSecurity 家族形态） ───────────────────

// 样本特征：extensionId 含不可打印字符；六积木 = 3 布尔探针 + 3 命令。
const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x17);
const BENIGN_ID = 'benignHelper';

const calls = { showDetail: 0, jump: 0, blockScript: 0 };

function makeYinInstance() {
  return {
    getInfo() {
      return {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has Tampermonkey?' } },
          { info: { opcode: 'hasScript', blockType: 'Boolean', text: 'has script?' } },
          { info: { opcode: 'isHijacked', blockType: 'Boolean', text: 'is hijacked?' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump to about:blank' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy script' } },
        ],
      };
    },
    hasTM() {
      return true;
    },
    hasScript() {
      return true;
    },
    isHijacked() {
      return true;
    },
    showDetail() {
      calls.showDetail++;
    },
    jump() {
      calls.jump++;
    },
    blockScript() {
      calls.blockScript++;
    },
  };
}

function makeBenignInstance() {
  return {
    getInfo() {
      return {
        id: BENIGN_ID,
        name: 'Benign Helper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %n to %n' } }],
      };
    },
    add(a, b) {
      return a + b;
    },
  };
}

// ─────────────────── 3. 假 CCW VM（严格复刻平台结构） ───────────────────

function makeFakeVM() {
  const yin = makeYinInstance();
  const benign = makeBenignInstance();

  const prims = {};
  const runtime = {
    _primitives: prims,
    _blockInfo: [
      {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has Tampermonkey?' } },
          { info: { opcode: 'hasScript', blockType: 'Boolean', text: 'has script?' } },
          { info: { opcode: 'isHijacked', blockType: 'Boolean', text: 'is hijacked?' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump to about:blank' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy script' } },
        ],
      },
      {
        id: BENIGN_ID,
        name: 'Benign Helper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %n to %n' } }],
      },
    ],
    getOpcodeFunction(op) {
      return this._primitives[op];
    },
    targets: [],
  };
  // 实例真身：runtime.ext_${id}
  runtime[`ext_${YIN_ID}`] = yin;
  runtime[`ext_${BENIGN_ID}`] = benign;

  // 敌扩展的 primitives（真实平台在注册扩展时写入）
  for (const op of ['hasTM', 'hasScript', 'isHijacked']) {
    prims[`${YIN_ID}_${op}`] = () => true;
  }
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    prims[`${YIN_ID}_${op}`] = () => {
      calls[op]++;
    };
  }
  prims[`${BENIGN_ID}_add`] = (a, b) => a + b;

  // VM 外层：isVMLike 口径（setVariableValue/getVariableValue + runtime.targets）
  const vmOuter = {
    runtime,
    editingTarget: { id: 'stage', blocks: {} },
    setVariableValue() {},
    getVariableValue() {
      return 0;
    },
    on() {},
    off() {},
    emitWorkspaceUpdate() {},
    loadProject() {},
    start() {},
  };

  const extensionManager = {
    _loadedExtensions: new Map([
      [YIN_ID, 'YinSecurityService'],
      [BENIGN_ID, 'BenignService'],
    ]),
    _customExtensionInfo: {
      [YIN_ID]: { id: YIN_ID, name: 'YinSecurity' },
      [BENIGN_ID]: { id: BENIGN_ID, name: 'Benign Helper' },
    },
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
    registerExtension() {},
    loadExtensionIdSync() {},
  };

  return { runtime, extensionManager, vmOuter, yin, benign };
}

// ─────────────────── 4. 宿主环境（jsdom 真实 DOM） ───────────────────

function installStubs() {
  const g = globalThis;
  const saved = {};
  const set = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(g, k);
    // 用 defineProperty：Node 22 部分内建（如 navigator）自带只读 getter
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: true });
  };

  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="app"></div></body></html>',
    { url: 'https://www.ccw.site/', pretendToBeVisual: true },
  );
  const win = dom.window;

  // DOM 全套
  for (const k of [
    'document',
    'Document',
    'Element',
    'HTMLElement',
    'HTMLDivElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
    'HTMLCanvasElement',
    'HTMLStyleElement',
    'HTMLLinkElement',
    'HTMLIFrameElement',
    'HTMLScriptElement',
    'Node',
    'NodeList',
    'Text',
    'Comment',
    'DocumentFragment',
    'ShadowRoot',
    'Range',
    'DOMParser',
    'XPathResult',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'CustomEvent',
    'MutationObserver',
    'IntersectionObserver',
    'ResizeObserver',
    'getComputedStyle',
    'matchMedia',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'CSS',
    'CSSStyleDeclaration',
    'CSSStyleSheet',
    'StyleSheet',
    'Screen',
    'Storage',
    'Location',
    'History',
    'Navigator',
    'XMLHttpRequest',
    'WebSocket',
    'MessageChannel',
    'BroadcastChannel',
    'FileReader',
    'Blob',
    'FormData',
    'Headers',
    'Request',
    'Response',
    'AbortController',
    'TextEncoder',
    'TextDecoder',
    'URL',
    'URLSearchParams',
    'localStorage',
    'sessionStorage',
  ]) {
    if (win[k] !== undefined) set(k, win[k]);
  }

  set('window', win);
  set('self', win);
  set('top', win);
  set('parent', win);
  set('screen', win.screen);
  set('innerWidth', 1920);
  set('innerHeight', 1080);
  set('devicePixelRatio', 1);
  set('GM_info', undefined);
  set('GM', undefined);

  // 时间压缩：把 400ms / 2000ms 的长延时压到 25ms
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const compress = (ms) => Math.min(typeof ms === 'number' && ms > 0 ? ms : 0, 25);
  set('setTimeout', (fn, ms, ...args) => realSetTimeout(fn, compress(ms), ...args));
  set('setInterval', (fn, ms, ...args) => realSetInterval(fn, compress(ms), ...args));

  return {
    dom,
    restore() {
      for (const k of Object.keys(saved)) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]);
        else delete g[k];
      }
      win.close();
    },
  };
}

// ─────────────────── 5. 主流程 ───────────────────

async function main() {
  const argv = process.argv.slice(2);
  const rawMode = argv[0] === '--raw';
  const target = rawMode
    ? path.resolve(argv[1] || path.join(ROOT, 'dist-debug', 'VaIMod.user.js'))
    : path.resolve(argv[0] || path.join(ROOT, 'dist', 'VaIMod.user.js'));
  if (!existsSync(target)) {
    console.error(`产物不存在: ${target}`);
    process.exit(1);
  }

  console.log(`\n=== 产物级行为验证 ===`);
  console.log(`目标: ${target}`);

  const { code, stage } = decodeArtifact(target);
  console.log(`阶段: ${stage === 'decoded' ? '混淆产物（已解码第一层）' : '原始产物'}`);
  console.log(`大小: ${(code.length / 1024).toFixed(1)} KB\n`);

  const { runtime, extensionManager, vmOuter, yin, benign } = makeFakeVM();
  const stubs = installStubs();

  // 平台形态：window.Scratch.vm / window.Scratch.extensionManager
  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;

  console.log('在 jsdom 环境执行产物...');
  let execError = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(code)();
  } catch (e) {
    execError = e;
  }

  // 巡检 ticker 是 2s 一拍（被压缩到 25ms）→ 给足窗口让它跑几轮
  await new Promise((r) => setTimeout(r, 800));

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // ① 实例层：布尔探针恒 false
  const b1 = yin.hasTM();
  const b2 = yin.hasScript();
  const b3 = yin.isHijacked();
  add(
    '实例层布尔探针恒 false',
    b1 === false && b2 === false && b3 === false,
    `hasTM=${b1} hasScript=${b2} isHijacked=${b3}`,
  );

  // ② 实例层：命令积木 no-op
  const before = { ...calls };
  try {
    yin.showDetail();
    yin.jump();
    yin.blockScript();
  } catch {
    /* ignore */
  }
  add(
    '实例层销毁/跳转/详情命令被禁用',
    calls.showDetail === before.showDetail &&
      calls.jump === before.jump &&
      calls.blockScript === before.blockScript,
    `showDetail+${calls.showDetail - before.showDetail} jump+${calls.jump - before.jump} blockScript+${calls.blockScript - before.blockScript}`,
  );

  // ③ primitives 层：布尔探针恒 false
  const getPrim = (op) => {
    const f = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    return typeof f === 'function' ? f() : '<缺失>';
  };
  const p1 = getPrim('hasTM');
  const p2 = getPrim('hasScript');
  const p3 = getPrim('isHijacked');
  add(
    'primitives 层布尔探针恒 false',
    p1 === false && p2 === false && p3 === false,
    `hasTM=${p1} hasScript=${p2} isHijacked=${p3}`,
  );

  // ④ primitives 层：命令积木 no-op
  const pBefore = { ...calls };
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    const f = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    if (typeof f === 'function') {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
  }
  add(
    'primitives 层销毁/跳转/详情命令被禁用',
    calls.showDetail === pBefore.showDetail &&
      calls.jump === pBefore.jump &&
      calls.blockScript === pBefore.blockScript,
    `showDetail+${calls.showDetail - pBefore.showDetail} jump+${calls.jump - pBefore.jump} blockScript+${calls.blockScript - pBefore.blockScript}`,
  );

  // ⑤ 零误伤：良性扩展仍正常
  const benignInst = benign.add(2, 3);
  const benignPrim = runtime.getOpcodeFunction(`${BENIGN_ID}_add`);
  const benignPrimOut = typeof benignPrim === 'function' ? benignPrim(2, 3) : '<缺失>';
  add(
    '良性扩展零误伤',
    benignInst === 5 && benignPrimOut === 5,
    `实例层 add(2,3)=${benignInst} primitives add(2,3)=${benignPrimOut}`,
  );

  // ⑥ 反制层已就位（primitives 键被真正改写，不是原实现）
  const rewritten = runtime.getOpcodeFunction(`${YIN_ID}_hasTM`);
  const rewrittenOut = typeof rewritten === 'function' ? rewritten() : '<缺失>';
  add('primitives 键已被改写（反制层就位）', rewrittenOut === false, `返回值=${rewrittenOut}`);

  // ⑦ 产物执行无致命错误
  add(
    '产物执行无致命错误',
    execError === null,
    execError ? (execError instanceof Error ? execError.message : String(execError)) : '无',
  );

  let pass = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  (${c.detail})`);
    if (c.ok) pass++;
  }
  console.log(`\n通过 ${pass} / ${checks.length}`);

  stubs.restore();
  if (pass !== checks.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
