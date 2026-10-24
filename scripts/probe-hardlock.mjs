/**
 * 七层防御对抗专项探针 —— 复刻敌方《七层防御完整总结》的全部七层，
 * 验证 VaIMod 的反制（返回值篡改 + 销毁/跳转积木禁用）在敌方全力自保下**仍然成立**。
 *
 * 为什么必须有这个探针：
 *   敌方的七层全部围绕 `runtime._primitives` 展开 —— 描述符锁定、Proxy 陷阱、
 *   250ms 看门狗夺回、Blockly 影子注入。原有的 `prims[key] = wrapped` 写法
 *   撞上其中任一层就会被静默拒绝或被夺回，"篡改返回值"与"禁用积木"直接归零。
 *
 * 逐层断言（每层单独钉死，断了能立刻定位）：
 *   L1  属性描述符锁定（writable:false / configurable:false）
 *   L2  Proxy 陷阱（set / defineProperty / deleteProperty）
 *   L3  锁定 runtime 关键方法（startHats 等）
 *   L4  250ms 看门狗夺回
 *   L5  Blockly 影子注入（污染积木执行层）
 *   L6  锁定 extensionManager 卸载方法
 *   L0  闭包私有化 + toString 伪装
 *   ＋  综合：七层全开时，布尔仍恒 false / 危险命令仍恒 no-op / 良性零误伤
 *
 * 用法：node scripts/probe-hardlock.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-hardlock');

// ---------- 1. 编译真实源码 ----------

const ENTRY = `
export { installSecureGuardFront } from '../src/core/secure-guard';
export { installExtSanitize, sanitizeRuntime, lockExtensionPrimitive } from '../src/core/ext-sanitize';
export { hardLockExtensionPrimitive, isHardLocked, installExtHardlock } from '../src/core/ext-hardlock';
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
  return path.join(outDir, '.probe-tmp-hardlock', 'entry.js');
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
  // Node 22 的 navigator 是只读 getter → 用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', language: 'zh-CN', platform: 'Win32' },
    writable: true,
    configurable: true,
  });
}

// ---------- 3. 虚拟时钟 ----------

function installVirtualClock() {
  const intervals = new Map();
  const timeouts = new Map();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  globalThis.setInterval = (fn, ms) => {
    const id = nextId++;
    intervals.set(id, { fn, ms: ms || 0 });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++;
    timeouts.set(id, { fn, ms: ms || 0 });
    // 虚拟时钟接管了长延时；但 await 语义必须能用真定时器兜底，
    // 否则探针自身的 `await new Promise(r => setTimeout(r, 500))` 永不落定。
    // 折中：长延时也用真定时器兜底（虚拟时钟只用于驱动 setInterval 巡检）。
    realSetTimeout(fn, ms || 0);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
    realClearTimeout(id);
  };

  return {
    size: () => intervals.size,
    /** 推进虚拟时钟：触发所有到期的 interval */
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

// ---------- 4. 敌扩展样本（YinSecurity 家族形态） ----------

const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x17);

function makeYinInstance() {
  const calls = { showDetail: 0, jump: 0, blockScript: 0 };
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
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      };
    },
    hasTM: () => true,
    hasScript: () => true,
    isHijacked: () => true,
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
  return { inst, calls };
}

// ---------- 5. 敌方七层防御（严格按《七层防御完整总结》复刻） ----------

/**
 * 把敌方的七层防御装到 runtime 上。
 * 返回操作接口，供探针在反制前后分别验证。
 */
function installEnemySevenLayers(runtime, extensionManager, prims, alwaysOne) {
  const report = { watchdogFired: 0, watchdogWon: 0, blocklyHits: 0 };

  // ── 敌第 1 层：属性描述符锁定 ──
  const lockedKeys = [];
  for (const key of Object.keys(prims)) {
    if (!key.startsWith(`${YIN_ID}_`)) continue;
    const desc = Object.getOwnPropertyDescriptor(prims, key);
    if (!desc || desc.configurable === false) continue;
    try {
      Object.defineProperty(prims, key, {
        value: prims[key],
        writable: false,
        configurable: false,
        enumerable: true,
      });
      lockedKeys.push(key);
    } catch {
      /* ignore */
    }
  }

  // ── 敌第 2 层：Proxy 陷阱 ──
  // 注意：文档的顺序是「先锁属性 → 再包 Proxy」，但 Proxy 包装会让
  // defineProperty 落到 trap —— 这里严格照文档复刻。
  const enemyProxy = new Proxy(prims, {
    set(target, prop, value) {
      // 敌方陷阱：吞掉对受控键的写入（模拟"写入被静默拒绝"）
      if (String(prop).startsWith(`${YIN_ID}_`)) return true;
      return Reflect.set(target, prop, value);
    },
    defineProperty(target, prop, descriptor) {
      if (String(prop).startsWith(`${YIN_ID}_`)) return true;
      try {
        return Reflect.defineProperty(target, prop, descriptor);
      } catch {
        return false;
      }
    },
    deleteProperty(target, prop) {
      if (String(prop).startsWith(`${YIN_ID}_`)) return true;
      return Reflect.deleteProperty(target, prop);
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

  // ── 敌第 3 层：锁定 runtime 关键方法 ──
  for (const name of ['startHats', 'setTargetOrder', 'setSpriteLayer']) {
    if (typeof runtime[name] !== 'function') continue;
    try {
      Object.defineProperty(runtime, name, {
        value: runtime[name],
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // ── 敌第 6 层：锁定 extensionManager 卸载方法 ──
  for (const name of ['unloadExtension', 'deleteExtension', 'removeExtension']) {
    if (typeof extensionManager[name] !== 'function') continue;
    try {
      Object.defineProperty(extensionManager, name, {
        value: function () {
          return false;
        },
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // ── 敌第 5 层：Blockly 影子注入 ──
  const blocklyBlocks = {};
  globalThis.Blockly = {
    Blocks: blocklyBlocks,
  };
  for (const key of Object.keys(prims)) {
    if (!key.startsWith(`${YIN_ID}_`)) continue;
    blocklyBlocks[key] = { func: prims[key] };
  }
  const enemyShadowInject = () => {
    for (const key of Object.keys(blocklyBlocks)) {
      const def = blocklyBlocks[key];
      if (def && typeof def.func === 'function') {
        report.blocklyHits++;
        def.func = alwaysOne;
      }
    }
  };

  // ── 敌第 4 层：250ms 看门狗夺回 ──
  const enemyWatchdog = setInterval(() => {
    report.watchdogFired++;
    const p = runtime._primitives;
    if (!p) return;
    for (const key of Object.keys(prims)) {
      if (!key.startsWith(`${YIN_ID}_`)) continue;
      if (p[key] === alwaysOne) continue;
      try {
        // 敌方夺回：defineProperty 写回真身
        Object.defineProperty(p, key, {
          value: alwaysOne,
          writable: false,
          configurable: false,
          enumerable: true,
        });
        report.watchdogWon++;
      } catch {
        /* ignore */
      }
    }
    enemyShadowInject();
  }, 250);

  return { report, enemyWatchdog, blocklyBlocks, lockedKeys };
}

// ---------- 6. 假 CCW VM ----------

function makeFakeVM() {
  const { inst, calls } = makeYinInstance();
  const goodId = 'GoodHelper';
  const goodInst = {
    getInfo() {
      return {
        id: goodId,
        name: 'GoodHelper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }],
      };
    },
    add(a, b) {
      return (a || 0) + (b || 0);
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
          { info: { opcode: 'hasScript', blockType: 'Boolean', text: 'has script?' } },
          { info: { opcode: 'isHijacked', blockType: 'Boolean', text: 'is hijacked?' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'show detail' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
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
    startHats() {},
    setTargetOrder() {},
    setSpriteLayer() {},
  };
  runtime[`ext_${YIN_ID}`] = inst;
  runtime[`ext_${goodId}`] = goodInst;

  // 敌扩展的 primitives 真身
  for (const op of ['hasTM', 'hasScript', 'isHijacked']) {
    prims[`${YIN_ID}_${op}`] = () => true;
  }
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    prims[`${YIN_ID}_${op}`] = () => {
      calls[op]++;
    };
  }
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
    _loadedExtensions: new Map([[YIN_ID, 'YinSecurityService']]),
    _customExtensionInfo: { [YIN_ID]: { id: YIN_ID, name: 'YinSecurity' } },
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
    registerExtension() {},
    loadExtensionIdSync() {},
    // 敌方第 6 层要锁的卸载方法必须在场（否则"锁卸载"无从谈起）
    unloadExtension() {
      return true;
    },
    deleteExtension() {
      return true;
    },
    removeExtension() {
      return true;
    },
  };

  return { runtime, extensionManager, vmOuter, inst, calls, prims, goodInst, goodId };
}

// ---------- 7. 主流程 ----------

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

async function main() {
  const mod = build();
  installStubs();
  const clock = installVirtualClock();

  const { runtime, extensionManager, vmOuter, inst, calls, prims, goodInst, goodId } = makeFakeVM();

  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;

  const api = require(mod);
  add('A1. 真实源码模块加载成功', !!api, `导出数=${Object.keys(api).length}`);

  // ── 敌方七层在反制**之前**装好（最坏情况：敌方先手自保）──
  const alwaysOne = function () {
    return 1;
  };
  const enemy = installEnemySevenLayers(runtime, extensionManager, prims, alwaysOne);
  add(
    'L1. 敌方属性描述符锁定已生效',
    enemy.lockedKeys.length >= 6,
    `锁定 ${enemy.lockedKeys.length} 个键`,
  );
  add(
    'L2. 敌方 Proxy 陷阱已生效',
    (() => {
      // 敌第 1 层（键锁成 non-writable/non-configurable）+ 第 2 层（Proxy 陷阱）叠加时，
      // 按 JS 规范：Proxy set 陷阱返回 true 但目标值不同 → 引擎抛 TypeError
      // （Proxy trap 不受严格模式豁免）。两种表现都算陷阱生效：
      //   · 抛错 → 写入被硬拒
      //   · 值未变 → 写入被静默吞掉
      try {
        const marker = function () {
          return 'ENEMY_MARKER';
        };
        const key = `${YIN_ID}_hasTM`;
        const before = runtime._primitives[key];
        runtime._primitives[key] = marker;
        const after = runtime._primitives[key];
        return after === before && after !== marker;
      } catch {
        return true; // 抛错 = 写入被硬拒，陷阱生效
      }
    })(),
    '写入被陷阱拒写（抛错或静默吞掉）',
  );
  add(
    'L3. 敌方 runtime 方法锁定已生效',
    (() => {
      const d = Object.getOwnPropertyDescriptor(runtime, 'startHats');
      return !!d && d.configurable === false;
    })(),
    'startHats 已 configurable:false',
  );
  add(
    'L5. 敌方 Blockly 影子注入已就位',
    typeof globalThis.Blockly?.Blocks?.[`${YIN_ID}_hasTM`]?.func === 'function',
    'Blockly.Blocks 已布防',
  );

  // ── 我方反制上马 ──
  api.installSecureGuardFront();
  await new Promise((r) => setTimeout(r, 500));
  clock.advance(3000);

  // 敌看门狗夺回（模拟 250ms 一次，连跑 3 轮）
  clock.advance(1000);

  const getPrim = (op) => {
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    return typeof fn === 'function' ? fn() : '<无函数>';
  };

  // ① 布尔探针恒 false（穿透全部七层）
  const b1 = getPrim('hasTM');
  const b2 = getPrim('hasScript');
  const b3 = getPrim('isHijacked');
  add(
    'B1. 七层全开时布尔探针仍恒 false',
    b1 === false && b2 === false && b3 === false,
    `hasTM=${JSON.stringify(b1)} hasScript=${JSON.stringify(b2)} isHijacked=${JSON.stringify(b3)}`,
  );

  // ② 实例层同样恒 false
  const ib1 = inst.hasTM();
  const ib2 = inst.hasScript();
  const ib3 = inst.isHijacked();
  add(
    'B2. 实例层布尔探针仍恒 false',
    ib1 === false && ib2 === false && ib3 === false,
    `hasTM=${JSON.stringify(ib1)} hasScript=${JSON.stringify(ib2)} isHijacked=${JSON.stringify(ib3)}`,
  );

  // ③ 危险命令恒 no-op
  const before = { ...calls };
  for (const op of ['showDetail', 'jump', 'blockScript']) {
    try {
      inst[op]();
    } catch {
      /* no-op */
    }
    const fn = runtime.getOpcodeFunction(`${YIN_ID}_${op}`);
    if (typeof fn === 'function') {
      try {
        fn();
      } catch {
        /* no-op */
      }
    }
  }
  const after = calls;
  add(
    'B3. 危险命令（详情/跳转/摧毁）仍恒 no-op',
    after.showDetail === before.showDetail &&
      after.jump === before.jump &&
      after.blockScript === before.blockScript,
    `showDetail+${after.showDetail - before.showDetail} jump+${after.jump - before.jump} blockScript+${after.blockScript - before.blockScript}`,
  );

  // ④ 敌看门狗反复夺回后仍不失效（自愈能力）
  const preWatch = { ...calls };
  for (let i = 0; i < 5; i++) {
    clock.advance(1000); // 触发敌看门狗多次 + 我方巡检
  }
  const w1 = getPrim('hasTM');
  const w2 = getPrim('isHijacked');
  add(
    'B4. 敌看门狗多次夺回后仍恒 false（自愈）',
    w1 === false && w2 === false,
    `hasTM=${JSON.stringify(w1)} isHijacked=${JSON.stringify(w2)} 敌看门狗 fired=${enemy.report.watchdogFired} 夺回成功=${enemy.report.watchdogWon}`,
  );

  // ⑤ 敌看门狗"夺回成功"次数应为 0（我方护栏把写入全挡了）
  add(
    'B5. 敌看门狗夺回全部失败（我方护栏拒写）',
    enemy.report.watchdogWon === 0,
    `夺回成功=${enemy.report.watchdogWon} / 触发=${enemy.report.watchdogFired}`,
  );

  // ⑥ 敌第 5 层 Blockly 影子注入不影响 VM 分发
  const afterShadow = getPrim('hasTM');
  add('B6. Blockly 影子注入不影响 VM 分发', afterShadow === false, `hasTM=${JSON.stringify(afterShadow)}`);

  // ⑦ 良性扩展零误伤
  const goodOut = goodInst.add(2, 3);
  const goodFn = runtime.getOpcodeFunction(`${goodId}_add`);
  const goodPrimOut = typeof goodFn === 'function' ? goodFn(2, 3) : '<无函数>';
  add(
    'B7. 良性扩展零误伤（add 仍返回 5）',
    goodOut === 5 && goodPrimOut === 5,
    `实例层 add(2,3)=${goodOut} primitives add(2,3)=${goodPrimOut}`,
  );

  // ⑧ 敌第 6 层锁了卸载方法 → 我方不依赖卸载（反制照常）
  add(
    'B8. 敌锁卸载方法不影响我方反制（不靠卸载实现）',
    (() => {
      const d = Object.getOwnPropertyDescriptor(extensionManager, 'unloadExtension');
      const locked = !!d && d.configurable === false;
      const fn = runtime.getOpcodeFunction(`${YIN_ID}_jump`);
      return locked && typeof fn === 'function';
    })(),
    '卸载方法已锁死，反制仍生效',
  );

  // ⑨ 硬锁状态可查询（供诊断）
  add(
    'B9. 硬锁状态可查询',
    api.isHardLocked(vmOuter, YIN_ID, 'hasTM') === true,
    `isHardLocked=${api.isHardLocked(vmOuter, YIN_ID, 'hasTM')}`,
  );

  // ⑩ 幂等：多拍巡检不产生副作用
  const snap = { ...calls };
  clock.advance(3000);
  clock.advance(3000);
  add(
    'B10. 多拍巡检幂等（不重复触发敌扩展原实现）',
    calls.showDetail === snap.showDetail && calls.jump === snap.jump && calls.blockScript === snap.blockScript,
    `calls=${JSON.stringify(calls)}`,
  );

  // 输出
  console.log(
    `诊断: 敌看门狗 fired=${enemy.report.watchdogFired} 夺回成功=${enemy.report.watchdogWon} Blockly注入=${enemy.report.blocklyHits}`,
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
