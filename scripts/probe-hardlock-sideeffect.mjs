/**
 * 副作用边界探针 —— 验证对抗层对宿主结构的干扰是**零容忍级**的。
 *
 * 护栏把 `runtime._primitives` 锁成 getter/setter（configurable:false），
 * 这是一处对宿主 VM 的真实改动。必须逐条确认它没有破坏平台的正常行为：
 *
 *   ① 扩展注册：平台注册新扩展时要写 `runtime._primitives[key] = fn` → 必须能写进去
 *   ② 扩展卸载：平台 `removeExtensionPrimitives` 要 `delete runtime._primitives[key]` → 必须能删
 *   ③ 非受控 key 的读写：完全透传（数值 / 字符串 / 函数都要原样）
 *   ④ 良性扩展的积木：正常执行，值不被篡改
 *   ⑤ runtime._primitives 的引用身份：平台其他代码读到的仍是同一个对象语义
 *   ⑥ 受控键被删除后再读取：护栏不应让平台崩
 *   ⑦ 平台重新赋值 runtime._primitives（少见但要确认不崩）
 *
 * 用法：node scripts/probe-hardlock-sideeffect.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-side');

// ---------- 1. 编译 ----------

const ENTRY = `
export { installSecureGuardFront } from '../src/core/secure-guard';
export { installExtSanitize, sanitizeRuntime } from '../src/core/ext-sanitize';
export { hardLockExtensionPrimitive, installExtHardlock, setHardlockEnabled } from '../src/core/ext-hardlock';
export { startVmProbe, trackVm, onVmTick } from '../src/core/ext-watch';
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
  return path.join(outDir, '.probe-tmp-side', 'entry.js');
}

// ---------- 2. 环境垫片 ----------

function installStubs() {
  const noop = () => {};
  const fakeEl = () => ({
    setAttribute: noop,
    removeAttribute: noop,
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild: noop,
    removeChild: noop,
    remove: noop,
    insertBefore: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    children: [],
    childNodes: [],
    parentNode: null,
    ownerDocument: null,
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
    dataset: {},
    textContent: '',
    innerHTML: '',
  });
  const doc = {
    readyState: 'complete',
    documentElement: fakeEl(),
    head: fakeEl(),
    body: fakeEl(),
    createElement: fakeEl,
    createTextNode: () => ({}),
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    visibilityState: 'visible',
    hidden: false,
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.location = { hostname: 'localhost', href: 'http://localhost/' };
  globalThis.localStorage = {
    _d: {},
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    },
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', language: 'zh-CN', platform: 'Win32' },
    writable: true,
    configurable: true,
  });
}

// ---------- 3. 虚拟时钟 ----------

function installVirtualClock() {
  const intervals = new Map();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms: ms || 0 });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++;
    realSetTimeout(fn, ms || 0);
    return id;
  };
  globalThis.clearTimeout = () => {};
  return {
    advance(ms) {
      const due = [...intervals.entries()].filter(([, t]) => t.ms <= ms);
      for (const [, t] of due) {
        try {
          t.fn();
        } catch {
          /* ignore */
        }
      }
      return due.length;
    },
  };
}

// ---------- 4. 假 VM ----------

const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x17);

function makeFakeVM() {
  const calls = { showDetail: 0, jump: 0, blockScript: 0 };
  const yinInst = {
    getInfo() {
      return {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has TM?' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
        ],
      };
    },
    hasTM: () => true,
    jump: () => {
      calls.jump++;
    },
  };
  const goodId = 'GoodHelper';
  const goodInst = {
    getInfo() {
      return {
        id: goodId,
        name: 'GoodHelper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }],
      };
    },
    add: (a, b) => (a || 0) + (b || 0),
  };

  const prims = {};
  const runtime = {
    _primitives: prims,
    _blockInfo: [
      {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has TM?' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
        ],
      },
      {
        id: goodId,
        name: 'GoodHelper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }],
      },
    ],
    getOpcodeFunction(op) {
      return this._primitives[op];
    },
    targets: [],
  };
  runtime[`ext_${YIN_ID}`] = yinInst;
  runtime[`ext_${goodId}`] = goodInst;
  prims[`${YIN_ID}_hasTM`] = () => true;
  prims[`${YIN_ID}_jump`] = () => {
    calls.jump++;
  };
  prims[`${goodId}_add`] = (a, b) => (a || 0) + (b || 0);

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
    _loadedExtensions: new Map(),
    _customExtensionInfo: {},
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
    registerExtension() {},
    loadExtensionIdSync() {},
  };
  return { runtime, prims, vmOuter, extensionManager, yinInst, goodInst, goodId, calls };
}

// ---------- 5. 主流程 ----------

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

async function main() {
  const mod = build();
  installStubs();
  const clock = installVirtualClock();
  const { runtime, prims, vmOuter, extensionManager, goodInst, goodId, calls } = makeFakeVM();

  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;

  const api = require(mod);
  api.installExtHardlock();
  api.installExtSanitize();
  await new Promise((r) => setTimeout(r, 500));
  clock.advance(3000);

  // ① 平台注册新扩展：写 primitives 必须成功
  const newExtId = 'LaterExt';
  const laterFn = () => 'LATER_OK';
  let writeOk = false;
  try {
    runtime._primitives[`${newExtId}_hello`] = laterFn;
    writeOk = runtime._primitives[`${newExtId}_hello`] === laterFn;
  } catch (e) {
    writeOk = false;
  }
  add('① 平台注册新扩展（写 primitives）不受阻', writeOk, `写入=${writeOk}`);

  // ② 平台卸载扩展：delete primitives 必须成功
  let delOk = false;
  try {
    delete runtime._primitives[`${newExtId}_hello`];
    delOk = runtime._primitives[`${newExtId}_hello`] === undefined;
  } catch (e) {
    delOk = false;
  }
  add('② 平台卸载扩展（删 primitives）不受阻', delOk, `删除后=${runtime._primitives[`${newExtId}_hello`]}`);

  // ③ 非受控 key 读写透传
  let passThrough = true;
  let ptDetail = '';
  try {
    runtime._primitives.plainNum = 42;
    runtime._primitives.plainStr = 'hello';
    runtime._primitives.plainFn = () => 'FN';
    const n = runtime._primitives.plainNum;
    const s = runtime._primitives.plainStr;
    const f = runtime._primitives.plainFn;
    passThrough = n === 42 && s === 'hello' && typeof f === 'function' && f() === 'FN';
    ptDetail = `num=${n} str=${s} fn=${typeof f}`;
  } catch (e) {
    passThrough = false;
    ptDetail = `抛错:${e.message}`;
  }
  add('③ 非受控 key 读写完全透传', passThrough, ptDetail);

  // ④ 良性扩展积木正常执行
  const goodOut = goodInst.add(2, 3);
  const goodFn = runtime.getOpcodeFunction(`${goodId}_add`);
  const goodPrimOut = typeof goodFn === 'function' ? goodFn(2, 3) : '<无>';
  add('④ 良性扩展积木正常执行', goodOut === 5 && goodPrimOut === 5, `add(2,3)=${goodOut}/${goodPrimOut}`);

  // ⑤ runtime._primitives 引用语义：平台其他代码读到的仍是可用对象
  const p = runtime._primitives;
  let refOk = false;
  let refDetail = '';
  try {
    refOk = !!p && typeof p === 'object' && typeof runtime.getOpcodeFunction === 'function';
    refDetail = `typeof=${typeof p} 可调用=${typeof runtime.getOpcodeFunction === 'function'}`;
  } catch (e) {
    refDetail = `抛错:${e.message}`;
  }
  add('⑤ runtime._primitives 引用语义完好', refOk, refDetail);

  // ⑥ 受控键被平台 delete（卸载敌扩展）→ 不崩，且语义正确（积木已不存在）
  //    平台卸载扩展后该积木本就不该再返回值 → undefined 是正确语义，
  //    关键是**不抛错**（早期版本锁 configurable:false 会让平台卸载时崩）。
  let delCtrlOk = false;
  let delCtrlDetail = '';
  try {
    delete runtime._primitives[`${YIN_ID}_hasTM`];
    const v = runtime.getOpcodeFunction(`${YIN_ID}_hasTM`);
    // 卸载后：入口仍能安全返回（不抛错）。
    // 值语义有两种正确形态：
    //   · undefined —— 积木已彻底不存在
    //   · 函数且调用返回 false —— 我方中和仍覆盖着（更保险）
    let callVal;
    try {
      callVal = typeof v === 'function' ? v() : v;
    } catch (e) {
      callVal = `抛错:${e.message}`;
    }
    delCtrlOk = callVal === undefined || callVal === false;
    delCtrlDetail = `取值类型=${typeof v} 调用结果=${JSON.stringify(callVal)}`;
  } catch (e) {
    delCtrlOk = false;
    delCtrlDetail = `抛错:${e.message}`;
  }
  add('⑥ 受控键被平台删除后不崩（且语义正确）', delCtrlOk, delCtrlDetail);

  // ⑦ 平台整体重新赋值 runtime._primitives → 不崩
  let reassignOk = false;
  let reassignDetail = '';
  try {
    runtime._primitives = { ...runtime._primitives };
    reassignOk = true;
    reassignDetail = '赋值未抛错';
  } catch (e) {
    reassignDetail = `抛错:${e.message}`;
  }
  add('⑦ 平台整体重赋值 runtime._primitives 不崩', reassignOk, reassignDetail);

  // ⑧ 平台重新赋值后反制仍然生效（护栏未被拆掉）
  clock.advance(3000);
  const afterReassign = runtime.getOpcodeFunction(`${YIN_ID}_hasTM`);
  const afterReassignOut = typeof afterReassign === 'function' ? afterReassign() : '<无>';
  add(
    '⑧ 平台重赋值后反制仍生效',
    afterReassignOut === false,
    `hasTM=${JSON.stringify(afterReassignOut)}`,
  );

  // ⑨ 敌扩展实例层仍被中和（不受 primitives 面变化影响）
  const instBool = runtime[`ext_${YIN_ID}`]?.hasTM?.();
  add('⑨ 实例层中和不受影响', instBool === false, `hasTM=${JSON.stringify(instBool)}`);

  // 输出
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
