/**
 * 对照实验：证明「七层防御对抗层」是**必需**的，不是锦上添花。
 *
 * 做法：把 ext-hardlock 的接管**关掉**（用环境变量开关），
 * 在敌方七层全开的环境下跑同一组断言：
 *   · 关闭对抗层 → 反制应当**失效**（布尔不再恒 false / 命令不再 no-op）
 *   · 开启对抗层 → 反制应当**完全成立**
 *
 * 这个对照把"对抗层有没有用"从推断变成实测。
 *
 * 用法：
 *   node scripts/probe-hardlock-ab.mjs          # 开启（默认）
 *   VAIMOD_HARDLOCK=off node scripts/probe-hardlock-ab.mjs   # 关闭对抗层
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-ab');

const HARDLOCK_ON = process.env.VAIMOD_HARDLOCK !== 'off';

// ---------- 1. 编译真实源码 ----------

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
  return path.join(outDir, '.probe-tmp-ab', 'entry.js');
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
  globalThis.clearTimeout = (id) => realSetTimeout(() => {}, 0);
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

// ---------- 4. 敌扩展 + 七层防御 ----------

const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x17);

function installEnemy(runtime, prims) {
  const report = { fired: 0, won: 0 };
  // 第 1 层：键描述符锁定
  for (const key of Object.keys(prims)) {
    if (!key.startsWith(`${YIN_ID}_`)) continue;
    try {
      Object.defineProperty(prims, key, {
        value: prims[key],
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch {
      /* ignore */
    }
  }
  // 第 2 层：Proxy 陷阱
  const enemyProxy = new Proxy(prims, {
    set(t, k, v) {
      if (String(k).startsWith(`${YIN_ID}_`)) return true;
      return Reflect.set(t, k, v);
    },
    defineProperty(t, k, d) {
      if (String(k).startsWith(`${YIN_ID}_`)) return true;
      try {
        return Reflect.defineProperty(t, k, d);
      } catch {
        return false;
      }
    },
    deleteProperty(t, k) {
      if (String(k).startsWith(`${YIN_ID}_`)) return true;
      return Reflect.deleteProperty(t, k);
    },
  });
  try {
    Object.defineProperty(runtime, '_primitives', {
      value: enemyProxy,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    /* ignore */
  }
  // 第 4 层：看门狗夺回
  const alwaysOne = function () {
    return 1;
  };
  const watchdog = setInterval(() => {
    report.fired++;
    const p = runtime._primitives;
    if (!p) return;
    for (const key of Object.keys(prims)) {
      if (!key.startsWith(`${YIN_ID}_`)) continue;
      if (p[key] === alwaysOne) continue;
      try {
        Object.defineProperty(p, key, {
          value: alwaysOne,
          writable: false,
          configurable: false,
          enumerable: true,
        });
        report.won++;
      } catch {
        /* ignore */
      }
    }
  }, 250);
  return { report, watchdog, alwaysOne };
}

function makeFakeVM() {
  const calls = { showDetail: 0, jump: 0, blockScript: 0 };
  const inst = {
    getInfo() {
      return {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has TM?' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      };
    },
    hasTM: () => true,
    showDetail: () => {
      calls.showDetail++;
    },
    jump: () => {
      calls.jump++;
    },
    blockScript: () => {
      calls.blockScript++;
    },
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
          { info: { opcode: 'showDetail', blockType: 'command', text: 'detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      },
    ],
    getOpcodeFunction(op) {
      return this._primitives[op];
    },
    targets: [],
  };
  runtime[`ext_${YIN_ID}`] = inst;
  prims[`${YIN_ID}_hasTM`] = () => true;
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    prims[`${YIN_ID}_${op}`] = () => {
      calls[op]++;
    };
  }
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
    _loadedExtensions: new Map([[YIN_ID, 'YinSecurityService']]),
    _customExtensionInfo: { [YIN_ID]: { id: YIN_ID, name: 'YinSecurity' } },
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
    registerExtension() {},
    loadExtensionIdSync() {},
  };
  return { runtime, prims, vmOuter, extensionManager, calls };
}

// ---------- 5. 主流程 ----------

async function main() {
  const mod = build();
  installStubs();
  const clock = installVirtualClock();
  const { runtime, prims, vmOuter, extensionManager, calls } = makeFakeVM();

  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;

  const api = require(mod);
  const enemy = installEnemy(runtime, prims);

  if (HARDLOCK_ON) {
    api.installExtHardlock();
  } else {
    // 关闭对抗层：硬锁退化为空操作 → primitives 层只剩普通赋值
    api.setHardlockEnabled(false);
  }
  api.installExtSanitize();
  await new Promise((r) => setTimeout(r, 500));
  clock.advance(3000);
  clock.advance(3000);

  const getPrim = (op) => {
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    return typeof fn === 'function' ? fn() : '<无函数>';
  };
  const boolVal = getPrim('hasTM');
  const before = { ...calls };
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    if (typeof fn === 'function') {
      try {
        fn();
      } catch {
        /* no-op */
      }
    }
  }
  const cmdFired = calls.showDetail - before.showDetail + (calls.jump - before.jump) + (calls.blockScript - before.blockScript);

  console.log(`\n=== 七层防御对抗层对照实验 ===`);
  console.log(`对抗层: ${HARDLOCK_ON ? '开启' : '关闭'}`);
  console.log(`敌看门狗: 触发=${enemy.report.fired} 夺回成功=${enemy.report.won}`);
  console.log(`布尔探针 hasTM = ${JSON.stringify(boolVal)}`);
  console.log(`危险命令实际执行次数 = ${cmdFired}`);
  console.log('');

  const neutralized = boolVal === false && cmdFired === 0;
  console.log(`反制结论: ${neutralized ? '✓ 反制成立' : '✗ 反制失效'}`);

  if (HARDLOCK_ON) {
    console.log(neutralized ? '  → 对抗层开启时反制完全成立 ✓' : '  → 对抗层开启但反制仍失效 ✗（有 Bug）');
    rmSync(TMP, { recursive: true, force: true });
    process.exit(neutralized ? 0 : 1);
  } else {
    console.log(
      neutralized
        ? '  → 对抗层关闭时反制**仍然成立**（对抗层非必需，说明七层防御不足为惧）'
        : '  → 对抗层关闭时反制**失效**（证明对抗层是必需的）',
    );
    rmSync(TMP, { recursive: true, force: true });
    process.exit(neutralized ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
