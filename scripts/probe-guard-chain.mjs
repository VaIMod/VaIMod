/**
 * 反制链路端到端探针 —— 直接跑 **真实源码**（tsc 编译），不走打包产物。
 *
 * 目的：把「布防 → vm 探测 → 入池 → 巡检 → 反制」每一环单独钉死。
 * 之前的产物级验证只能看到最终结果，中间哪一环断了全靠猜；
 * 这里每一环都有独立断言，能精确指出断点。
 *
 * 覆盖：
 *   A. installExtSanitize 注册了 onVmTick 回调
 *   B. startVmProbe 能在全局探测到 vm 并 trackVm 入池
 *   C. 巡检 ticker 触发后 sanitizeRuntime 真正执行
 *   D. 实例层：三个布尔探针恒 false
 *   E. 实例层：三个危险命令恒 no-op（不跳转 / 不摧毁 / 不弹详情）
 *   F. primitives 层：真实分发键 ${extId}_${opcode} 同样被锁
 *   G. 良性扩展零误伤
 *   H. 幂等：连续多拍巡检不产生副作用
 *
 * 用法：node scripts/probe-guard-chain.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-chain');

// ---------- 1. 编译真实源码 ----------

const ENTRY = `
export { installSecureGuardFront } from '../src/core/secure-guard';
export { installExtSanitize, sanitizeRuntime, neutralizeInstance, lockExtensionPrimitive } from '../src/core/ext-sanitize';
export { startVmProbe, trackVm, onVmTick } from '../src/core/ext-watch';
export { enumerateExtensions, enumerateInstances } from '../src/core/ext-registry';
`;

function build() {
  const entryPath = path.join(TMP, 'entry.ts');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(entryPath, ENTRY, 'utf8');
  const outDir = path.join(TMP, 'js');
  mkdirSync(outDir, { recursive: true });
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [
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
  ], { cwd: ROOT, stdio: 'inherit' });
  writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  return path.join(outDir, '.probe-tmp-chain', 'entry.js');
}

// ---------- 2. DOM 垫片 ----------

function installDomStubs() {
  const noop = () => {};
  const fakeEl = () => ({
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null, hasAttribute: () => false,
    appendChild: noop, removeChild: noop, remove: noop, insertBefore: noop,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [], children: [], childNodes: [],
    parentNode: null, ownerDocument: null, style: {}, classList: { add: noop, remove: noop, contains: () => false },
    dataset: {}, textContent: '', innerHTML: '',
  });
  const doc = {
    readyState: 'complete',
    documentElement: fakeEl(), head: fakeEl(), body: fakeEl(),
    createElement: fakeEl, createTextNode: () => ({}),
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [],
    visibilityState: 'visible',
    hidden: false,
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.location = { hostname: 'localhost', href: 'http://localhost/' };
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  // Node 22 的 navigator 是只读 getter，不能整体赋值 → 只能改它的属性
  try {
    Object.defineProperty(globalThis.navigator, 'userAgent', { value: 'node', configurable: true });
    Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true });
    Object.defineProperty(globalThis.navigator, 'platform', { value: 'Win32', configurable: true });
  } catch { /* ignore */ }
  globalThis.open = () => null;
  globalThis.alert = () => {};
  globalThis.confirm = () => false;
  globalThis.prompt = () => null;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
}

// ---------- 3. 真实结构的 mock ----------

const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x18, 0x07, 0x11);

function makeYinInstance() {
  const inst = {
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
    hasTM() { globalThis.__yin_calls.hasTM = (globalThis.__yin_calls.hasTM || 0) + 1; return true; },
    hasScript() { globalThis.__yin_calls.hasScript = (globalThis.__yin_calls.hasScript || 0) + 1; return true; },
    isHijacked() { globalThis.__yin_calls.isHijacked = (globalThis.__yin_calls.isHijacked || 0) + 1; return true; },
    showDetail() { globalThis.__yin_calls.showDetail = (globalThis.__yin_calls.showDetail || 0) + 1; },
    jump() { globalThis.__yin_calls.jump = (globalThis.__yin_calls.jump || 0) + 1; },
    blockScript() { globalThis.__yin_calls.blockScript = (globalThis.__yin_calls.blockScript || 0) + 1; },
  };
  return inst;
}

function makeFakeVM() {
  globalThis.__yin_calls = {};
  const prims = {
    [`${YIN_ID}_hasTM`]: () => true,
    [`${YIN_ID}_hasScript`]: () => true,
    [`${YIN_ID}_isHijacked`]: () => true,
    [`${YIN_ID}_showDetail`]: () => { globalThis.__yin_calls.primShowDetail = (globalThis.__yin_calls.primShowDetail || 0) + 1; },
    [`${YIN_ID}_jump`]: () => { globalThis.__yin_calls.primJump = (globalThis.__yin_calls.primJump || 0) + 1; },
    [`${YIN_ID}_blockScript`]: () => { globalThis.__yin_calls.primBlockScript = (globalThis.__yin_calls.primBlockScript || 0) + 1; },
  };
  const runtime = {
    _primitives: prims,
    _blockInfo: [
      {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has Tampermonkey?' }, json: [1], xml: '<block/>' },
          { info: { opcode: 'hasScript', blockType: 'Boolean', text: 'has script?' }, json: [1], xml: '<block/>' },
          { info: { opcode: 'isHijacked', blockType: 'Boolean', text: 'is hijacked?' }, json: [1], xml: '<block/>' },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' }, json: [1], xml: '<block/>' },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump to about:blank' }, json: [1], xml: '<block/>' },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy script' }, json: [1], xml: '<block/>' },
        ],
      },
    ],
    getOpcodeFunction(op) { return this._primitives[op]; },
    targets: [],
  };
  runtime[`ext_${YIN_ID}`] = makeYinInstance();

  // 【对照实验】把 runtime 与 _primitives 各包一层 Proxy（与产物级验证器完全同构），
  // 用来确认「观测层本身」不会让反制失效。
  const primLog = [];
  const rtLog = [];
  const runtimeProxy = new Proxy(runtime, {
    get(t, p, r) {
      if (typeof p === 'string') rtLog.push(`get:${p}`);
      return Reflect.get(t, p, r);
    },
  });
  runtimeProxy._primitives = new Proxy(prims, {
    get(t, p, r) {
      if (typeof p === 'string') primLog.push(`get:${p}`);
      return Reflect.get(t, p, r);
    },
    set(t, p, v) {
      if (typeof p === 'string') primLog.push(`set:${p}`);
      return Reflect.set(t, p, v);
    },
  });

  const extensionManager = {
    _loadedExtensions: new Map([[YIN_ID, 'YinSecurityService']]),
    _customExtensionInfo: { [YIN_ID]: { id: YIN_ID, name: 'YinSecurity' } },
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
  };

  const vmOuter = {
    runtime: runtimeProxy,
    extensionManager,
    editingTarget: { id: 'stage', blocks: {} },
    setVariableValue() {}, getVariableValue() { return 0; },
    on() {}, off() {}, emitWorkspaceUpdate() {}, loadProject() {}, start() {},
  };
  return { runtime: runtimeProxy, extensionManager, vmOuter, primLog, rtLog };
}

// ---------- 4. 虚拟时钟（抓 interval 回调） ----------

function installVirtualClock() {
  const intervals = new Map();
  let nextId = 1;
  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms: ms || 0 });
    return id;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  return {
    size: () => intervals.size,
    /** 推进虚拟时钟：触发所有 ms <= 预算的回调 */
    advance(ms) {
      const due = [...intervals.values()].filter((t) => t.ms <= ms);
      for (const t of due) {
        try { t.fn(); } catch { /* ignore */ }
      }
      return due.length;
    },
  };
}

// ---------- 5. 主流程 ----------

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

async function main() {
  const mod = build();
  installDomStubs();
  const clock = installVirtualClock();

  const { runtime, extensionManager, vmOuter, primLog, rtLog } = makeFakeVM();

  // 全局挂 vm（模拟平台形态：window.Scratch.vm）
  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;
  globalThis._vm = vmOuter;

  // require 真实源码（模块顶层即布防）
  const api = require(mod);
  add('A1. 真实源码模块加载成功', !!api, `导出数=${Object.keys(api).length}`);

  // 模块加载时 installSecureGuardFront 已跑 → startVmProbe 已启动
  // 探测是 setTimeout 轮询（400ms 一拍），等一拍让它命中
  await new Promise((r) => setTimeout(r, 500));
  add('B1. 探测到全局 vm 并注册了巡检 ticker', clock.size() > 0, `interval 数=${clock.size()}`);

  // 推进虚拟时钟触发巡检
  const fired = clock.advance(3000);
  add('C1. 巡检 ticker 被触发', fired > 0, `触发回调数=${fired}`);

  const inst = runtime[`ext_${YIN_ID}`];

  // D. 实例层布尔恒 false
  const boolDetail = [];
  let boolOk = true;
  for (const op of ['hasTM', 'hasScript', 'isHijacked']) {
    let v;
    try { v = inst[op](); } catch (e) { v = `抛错:${e.message}`; }
    boolDetail.push(`${op}=${JSON.stringify(v)}`);
    if (v !== false) boolOk = false;
  }
  add('D1. 实例层布尔探针恒 false', boolOk, boolDetail.join(' '));

  // E. 实例层危险命令 no-op
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    try { inst[op](); } catch { /* no-op 抛错也算拦下 */ }
  }
  const cmdCalls = globalThis.__yin_calls;
  add(
    'E1. 实例层销毁/跳转/详情命令被禁用',
    !cmdCalls.showDetail && !cmdCalls.jump && !cmdCalls.blockScript,
    `showDetail=${cmdCalls.showDetail || 0} jump=${cmdCalls.jump || 0} blockScript=${cmdCalls.blockScript || 0}`,
  );

  // F. primitives 层（真实分发路径）
  const primBool = [];
  let primOk = true;
  for (const op of ['hasTM', 'hasScript', 'isHijacked']) {
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    let v = '无函数';
    if (typeof fn === 'function') {
      try { v = fn(); } catch (e) { v = `抛错:${e.message}`; }
    }
    primBool.push(`${op}=${JSON.stringify(v)}`);
    if (v !== false) primOk = false;
  }
  add('F1. primitives 层布尔探针恒 false', primOk, primBool.join(' '));

  const beforePrimCmd = { ...globalThis.__yin_calls };
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    if (typeof fn === 'function') {
      try { fn(); } catch { /* 拦下即可 */ }
    }
  }
  const after = globalThis.__yin_calls;
  add(
    'F2. primitives 层销毁/跳转/详情命令被禁用',
    (after.primShowDetail || 0) === (beforePrimCmd.primShowDetail || 0) &&
      (after.primJump || 0) === (beforePrimCmd.primJump || 0) &&
      (after.primBlockScript || 0) === (beforePrimCmd.primBlockScript || 0),
    `showDetail=${after.primShowDetail || 0} jump=${after.primJump || 0} blockScript=${after.primBlockScript || 0}`,
  );

  // G. 良性扩展零误伤
  const goodId = 'GoodHelper';
  const goodInst = {
    getInfo() { return { id: goodId, name: 'GoodHelper', blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }] }; },
    add(a, b) { return (a || 0) + (b || 0); },
  };
  runtime[`ext_${goodId}`] = goodInst;
  runtime._blockInfo.push({
    id: goodId,
    name: 'GoodHelper',
    blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' }, json: [1], xml: '<block/>' }],
  });
  clock.advance(3000);
  let goodOk = false;
  let goodDetail = '';
  try {
    const v = goodInst.add(2, 3);
    goodOk = v === 5;
    goodDetail = `add(2,3)=${v}`;
  } catch (e) { goodDetail = `抛错:${e.message}`; }
  add('G1. 良性扩展零误伤（add 仍返回 5）', goodOk, goodDetail);

  // H. 幂等：多拍巡检不产生副作用（敌扩展原实现调用次数不增长）
  const snapshot = { ...globalThis.__yin_calls };
  clock.advance(3000);
  clock.advance(3000);
  const same =
    (globalThis.__yin_calls.showDetail || 0) === (snapshot.showDetail || 0) &&
    (globalThis.__yin_calls.jump || 0) === (snapshot.jump || 0) &&
    (globalThis.__yin_calls.blockScript || 0) === (snapshot.blockScript || 0);
  add('H1. 多拍巡检幂等（不重复触发敌扩展原实现）', same, `calls=${JSON.stringify(globalThis.__yin_calls)}`);

  // I. 敌扩展「晚注册」：巡检跑过之后才出现的新敌扩展，下一拍必须被接管
  //    这是用户反馈「检测不到」的最常见成因——扩展在首拍枚举之后才加载。
  const LATE_ID = 'LateYin' + String.fromCharCode(0x17);
  globalThis.__late_calls = { showDetail: 0, jump: 0, blockScript: 0 };
  const lateInst = {
    getInfo() {
      return {
        id: LATE_ID,
        name: 'LateYin',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has Tampermonkey?' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      };
    },
    hasTM() { return true; },
    showDetail() { globalThis.__late_calls.showDetail++; },
    jump() { globalThis.__late_calls.jump++; },
    blockScript() { globalThis.__late_calls.blockScript++; },
  };
  runtime[`ext_${LATE_ID}`] = lateInst;
  runtime._blockInfo.push({
    id: LATE_ID,
    name: 'LateYin',
    blocks: [
      { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has Tampermonkey?' }, json: [1], xml: '<block/>' },
      { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' }, json: [1], xml: '<block/>' },
      { info: { opcode: 'jump', blockType: 'command', text: 'jump' }, json: [1], xml: '<block/>' },
      { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' }, json: [1], xml: '<block/>' },
    ],
  });
  // 敌扩展的 primitives 也晚于首拍写入
  runtime._primitives[`${LATE_ID}_hasTM`] = () => true;
  runtime._primitives[`${LATE_ID}_showDetail`] = () => { globalThis.__late_calls.showDetail++; };
  runtime._primitives[`${LATE_ID}_jump`] = () => { globalThis.__late_calls.jump++; };
  runtime._primitives[`${LATE_ID}_blockScript`] = () => { globalThis.__late_calls.blockScript++; };

  clock.advance(3000); // 下一拍巡检 → 必须接管晚注册的扩展

  let lateInstBool = null;
  try { lateInstBool = lateInst.hasTM(); } catch (e) { lateInstBool = `抛错:${e.message}`; }
  const latePrimFn = runtime.getOpcodeFunction(`${LATE_ID}_hasTM`);
  let latePrimBool = '无函数';
  if (typeof latePrimFn === 'function') {
    try { latePrimBool = latePrimFn(); } catch (e) { latePrimBool = `抛错:${e.message}`; }
  }
  add(
    'I1. 晚注册敌扩展实例层布尔恒 false',
    lateInstBool === false,
    `hasTM=${JSON.stringify(lateInstBool)}`,
  );
  add(
    'I2. 晚注册敌扩展 primitives 层布尔恒 false',
    latePrimBool === false,
    `hasTM=${JSON.stringify(latePrimBool)}`,
  );
  const lateBefore = { ...globalThis.__late_calls };
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    try { lateInst[op](); } catch { /* no-op */ }
    const fn = runtime.getOpcodeFunction(`${LATE_ID}_${op}`);
    if (typeof fn === 'function') { try { fn(); } catch { /* no-op */ } }
  }
  const lateAfter = globalThis.__late_calls;
  add(
    'I3. 晚注册敌扩展销毁/跳转/详情命令被禁用',
    lateAfter.showDetail === lateBefore.showDetail &&
      lateAfter.jump === lateBefore.jump &&
      lateAfter.blockScript === lateBefore.blockScript,
    `showDetail+${lateAfter.showDetail - lateBefore.showDetail} jump+${lateAfter.jump - lateBefore.jump} blockScript+${lateAfter.blockScript - lateBefore.blockScript}`,
  );

  // 输出
  console.log(`诊断: runtime 访问 = ${rtLog.length} 次 → ${rtLog.slice(0, 12).join(', ') || '(无)'}`);
  console.log(`诊断: primitives 访问 = ${primLog.length} 次 → ${primLog.slice(0, 12).join(', ') || '(无)'}`);
  console.log('');

  let pass = 0;
  for (const c of checks) {
    if (c.ok) { pass++; console.log(`  ✓ ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
    else { console.log(`  ✗ ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
  }
  console.log(`\n通过 ${pass} / ${checks.length}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === checks.length ? 0 : 1);
}

main();
