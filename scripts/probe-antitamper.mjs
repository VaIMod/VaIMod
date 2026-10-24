/**
 * 防篡改升级专项探针 —— 覆盖《两种篡改方式的完整防御总结（10 种反制方法）》里
 * **此前没有落地**的那几种方法，以及两种篡改形态的正面效果。
 *
 * 为什么必须有这个探针：
 *   ext-hardlock 的四道防线（入口拦截 / 影子写入 / Proxy 护栏 / 看门狗）只覆盖了
 *   「篡改函数表」这一种形态（方法 1/2/3/4/7）。
 *   文档里最关键、也最隐蔽的一条是 **方法 5（`__disabled` 别名 opcode）** 与
 *   **方法 10（积木实例改名）**：
 *     · 敌扩展按方法 5 注册 `<key>__disabled` = 真身函数 → 可以绕开「按精确键中和」
 *     · 脚本编辑器 pro.js 把积木实例 opcode 改名 → VM 查表落空 → 积木静默失效
 *   没有专项探针，这两条随时可能被改坏而无人察觉。
 *
 * 逐条断言：
 *   M5-1  敌注册 `__disabled` 别名 → 别名键同样被中和（调用恒 false，不是真身）
 *   M5-2  敌看门狗反复夺回别名 → 别名仍然无效
 *   M5-3  良性扩展的裸 opcode 块定义不被碰（零误伤）
 *   M6-1  敌把 runtime 关键方法锁成不可写 → 我方修复回可写（平台自身包装才能装上）
 *   M6-2  敌锁成不可配置 → 不崩、不乱改（修不了就不修）
 *   M6-3  `startHats` 缺失平台 paused 语义 → 补上等价守卫（暂停时非广播帽不启动）
 *   M8-1  敌在 Blockly 层放真身 → 完整键被影子覆盖为中和包装
 *   M8-2  裸 opcode 的良性块定义不被影子覆盖
 *   M9-1  扩展被卸载 → 3 拍后释放管控，`_primitives` 不留残影
 *   M9-2  同 extId 换新实例 → 重新分类，敌块照样被中和
 *   M10-1 敌块实例被改名 `__disabled` → 还原原 opcode 并 resetCache
 *   M10-2 用户作品里的良性块被改名 → 同样还原（防篡改的本职）
 *   M10-3 认不出的后缀 → 不动（宁可漏改，不可改坏作品）
 *   Z-1   良性扩展零误伤（实例层 + primitives 层 + Blockly 层）
 *
 * 用法：node scripts/probe-antitamper.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-antitamper');

// ---------- 1. 编译真实源码 ----------

const ENTRY = `
export { installSecureGuardFront } from '../src/core/secure-guard';
export { installExtSanitize, sanitizeRuntime } from '../src/core/ext-sanitize';
export { hardLockExtensionPrimitive, isHardLocked, lockedKeysOf, lockedExtIdsOf } from '../src/core/ext-hardlock';
export { installExtAntitamper, antitamperStats } from '../src/core/ext-antitamper';
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
  return path.join(outDir, '.probe-tmp-antitamper', 'entry.js');
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
    replaceChild: noop,
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
  globalThis.sessionStorage = globalThis.localStorage;
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

// ---------- 4. 假 CCW VM ----------

const YIN_ID = 'YinSecurityxɺc' + String.fromCharCode(0x17);
const GOOD_ID = 'GoodHelper';

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
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      };
    },
    hasTM: () => true,
    jump: () => {
      calls.jump++;
    },
    blockScript: () => {
      calls.blockScript++;
    },
  };
  const goodInst = {
    getInfo() {
      return {
        id: GOOD_ID,
        name: 'GoodHelper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }],
      };
    },
    add(a, b) {
      return (a || 0) + (b || 0);
    },
  };

  const prims = {};
  const resetCount = { n: 0 };
  const stageBlocks = {
    _blocks: {
      // 用户作品里的一个良性积木
      goodBlock: { opcode: `${GOOD_ID}_add`, next: null },
      // 敌块实例（正常）
      yinBlock: { opcode: `${YIN_ID}_hasTM`, next: null },
    },
    resetCache() {
      resetCount.n++;
    },
  };

  const runtime = {
    _primitives: prims,
    _blockInfo: [
      {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has TM?' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'jump' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'destroy' } },
        ],
      },
      {
        id: GOOD_ID,
        name: 'GoodHelper',
        blocks: [{ info: { opcode: 'add', blockType: 'reporter', text: 'add %s %s' } }],
      },
    ],
    getOpcodeFunction(op) {
      return this._primitives[op];
    },
    targets: [{ id: 'stage', blocks: stageBlocks }],
    paused: false,
    startHats(hat) {
      return [`ran:${hat}`];
    },
    setTargetOrder() {},
    setSpriteLayer() {},
  };
  runtime[`ext_${YIN_ID}`] = yinInst;
  runtime[`ext_${GOOD_ID}`] = goodInst;

  prims[`${YIN_ID}_hasTM`] = () => true;
  prims[`${YIN_ID}_jump`] = () => {
    calls.jump++;
  };
  prims[`${YIN_ID}_blockScript`] = () => {
    calls.blockScript++;
  };
  prims[`${GOOD_ID}_add`] = (a, b) => (a || 0) + (b || 0);

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
      [GOOD_ID, 'GoodHelperService'],
    ]),
    _customExtensionInfo: { [YIN_ID]: { id: YIN_ID }, [GOOD_ID]: { id: GOOD_ID } },
    _officialExtensionInfo: {},
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
    registerExtension() {},
    loadExtensionIdSync() {},
  };
  return { runtime, prims, vmOuter, extensionManager, yinInst, goodInst, calls, stageBlocks, resetCount };
}

// ---------- 5. 主流程 ----------

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

async function main() {
  const mod = build();
  installStubs();
  const clock = installVirtualClock();

  const { runtime, prims, vmOuter, extensionManager, yinInst, goodInst, calls, stageBlocks, resetCount } =
    makeFakeVM();

  globalThis.Scratch = { vm: vmOuter, extensionManager };
  globalThis.vm = vmOuter;

  const api = require(mod);
  add('A1. 真实源码模块加载成功', !!api, `导出数=${Object.keys(api).length}`);

  // ── 敌扩展按方法 5 注册别名（规避「按精确键中和」）──
  const enemyReal = () => true;
  prims[`${YIN_ID}_hasTM__disabled`] = enemyReal;
  // ── 敌扩展在 Blockly 层放真身（方法 8 的敌对侧）──
  const blocklyBlocks = {};
  globalThis.Blockly = { Blocks: blocklyBlocks };
  blocklyBlocks[`${YIN_ID}_hasTM`] = { func: enemyReal };
  blocklyBlocks.add = { func: goodInst.add };

  // ── 敌锁 runtime 关键方法（方法 6）──
  // setTargetOrder：锁成不可写但**可配置** → 我方应能修复
  Object.defineProperty(runtime, 'setTargetOrder', {
    value: runtime.setTargetOrder,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  // setSpriteLayer：锁成不可配置 → 我方修不了，只要求不崩不乱改
  Object.defineProperty(runtime, 'setSpriteLayer', {
    value: runtime.setSpriteLayer,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // ── 我方布防 ──
  api.installSecureGuardFront();
  await new Promise((r) => setTimeout(r, 500));
  clock.advance(3000);

  // ── M5-1：别名键同样被中和 ──
  const aliasFn = runtime.getOpcodeFunction(`${YIN_ID}_hasTM__disabled`);
  let aliasOut = '<无函数>';
  try {
    aliasOut = typeof aliasFn === 'function' ? aliasFn() : aliasFn;
  } catch (e) {
    aliasOut = `抛错:${e.message}`;
  }
  add(
    'M5-1. 敌注册的 __disabled 别名同样被中和',
    aliasOut === false,
    `别名调用结果=${JSON.stringify(aliasOut)}（真身会返回 true）`,
  );

  // ── M5-2：敌看门狗反复夺回别名 → 仍然无效 ──
  for (let i = 0; i < 3; i++) {
    try {
      Object.defineProperty(prims, `${YIN_ID}_hasTM__disabled`, {
        value: enemyReal,
        writable: false,
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* ignore */
    }
    clock.advance(2200);
  }
  const aliasAfter = runtime.getOpcodeFunction(`${YIN_ID}_hasTM__disabled`);
  let aliasAfterOut = '<无函数>';
  try {
    aliasAfterOut = typeof aliasAfter === 'function' ? aliasAfter() : aliasAfter;
  } catch {
    aliasAfterOut = '抛错';
  }
  add(
    'M5-2. 敌反复夺回别名后别名仍无效',
    aliasAfterOut === false,
    `夺回 3 轮后别名结果=${JSON.stringify(aliasAfterOut)}`,
  );

  // ── M5-3：良性扩展的裸 opcode 块定义不被碰 ──
  add(
    'M5-3. 良性扩展的裸 opcode 块定义不被碰',
    blocklyBlocks.add?.func === goodInst.add,
    'Blockly.Blocks.add 未被改动',
  );

  // ── M5-4：别名键在 _primitives 的枚举里不可见 ──
  //    （宿主若遍历 _primitives 建块清单，别名键不能变成幻影 opcode）
  const aliasVisible = Object.keys(runtime._primitives).some((k) => k.endsWith('__disabled'));
  add('M5-4. 别名键在 _primitives 枚举里不可见', !aliasVisible, `可见别名键=${aliasVisible}`);

  // ── M6-1：可配置的锁 → 修复回可写 ──
  const stoDesc = Object.getOwnPropertyDescriptor(runtime, 'setTargetOrder');
  add(
    'M6-1. 敌锁死的 runtime 方法被修复回可写',
    !!stoDesc && stoDesc.writable === true && stoDesc.configurable === true,
    `setTargetOrder writable=${stoDesc?.writable} configurable=${stoDesc?.configurable}`,
  );

  // ── M6-2：不可配置的锁 → 不崩、不乱改 ──
  let m62ok = false;
  let m62detail = '';
  try {
    const sslDesc = Object.getOwnPropertyDescriptor(runtime, 'setSpriteLayer');
    runtime.setSpriteLayer(1);
    m62ok = !!sslDesc && sslDesc.configurable === false && typeof runtime.setSpriteLayer === 'function';
    m62detail = `configurable=${sslDesc?.configurable} 仍可调用`;
  } catch (e) {
    m62detail = `抛错:${e.message}`;
  }
  add('M6-2. 不可配置的锁不导致崩溃', m62ok, m62detail);

  // ── M6-3：startHats 的 paused 守卫 ──
  runtime.paused = true;
  let hatOut = '<未调用>';
  try {
    hatOut = runtime.startHats('event_whenflagclicked');
  } catch (e) {
    hatOut = `抛错:${e.message}`;
  }
  let broadcastOut = '<未调用>';
  try {
    broadcastOut = runtime.startHats('event_whenbroadcastreceived');
  } catch (e) {
    broadcastOut = `抛错:${e.message}`;
  }
  runtime.paused = false;
  add(
    'M6-3. startHats 补上平台 paused 语义',
    Array.isArray(hatOut) && hatOut.length === 0 && Array.isArray(broadcastOut) && broadcastOut.length === 1,
    `暂停时普通帽=${JSON.stringify(hatOut)} 广播帽=${JSON.stringify(broadcastOut)}`,
  );

  // ── M8-1：Blockly 完整键被影子覆盖 ──
  const shadowed = blocklyBlocks[`${YIN_ID}_hasTM`]?.func;
  let shadowOut = '<无函数>';
  try {
    shadowOut = typeof shadowed === 'function' ? shadowed() : shadowed;
  } catch {
    shadowOut = '抛错';
  }
  add('M8-1. Blockly 完整键被影子覆盖为中和包装', shadowOut === false, `影子调用结果=${JSON.stringify(shadowOut)}`);

  // ── M8-2：裸 opcode 不被覆盖 ──
  add(
    'M8-2. 裸 opcode 的良性块定义不被覆盖',
    blocklyBlocks.add?.func === goodInst.add,
    'Blockly.Blocks.add 仍是原实现',
  );

  // ── M10-1 / M10-2 / M10-3：实例改名自愈 ──
  stageBlocks._blocks.renamedYin = { opcode: `${YIN_ID}_hasTM__disabled`, next: null };
  stageBlocks._blocks.renamedGood = { opcode: `${GOOD_ID}_add__disabled`, next: null };
  stageBlocks._blocks.unknownOne = { opcode: `someUnknownBlock__disabled`, next: null };
  const resetsBefore = resetCount.n;
  clock.advance(2200);
  const yinOp = stageBlocks._blocks.renamedYin?.opcode;
  const goodOp = stageBlocks._blocks.renamedGood?.opcode;
  const unknownOp = stageBlocks._blocks.unknownOne?.opcode;
  add(
    'M10-1. 敌块实例改名后被还原',
    yinOp === `${YIN_ID}_hasTM`,
    `还原后=${JSON.stringify(yinOp)}`,
  );
  add(
    'M10-2. 用户作品里的良性块改名后被还原',
    goodOp === `${GOOD_ID}_add`,
    `还原后=${JSON.stringify(goodOp)}`,
  );
  add(
    'M10-3. 认不出的后缀不被乱改',
    unknownOp === `someUnknownBlock__disabled`,
    `保持=${JSON.stringify(unknownOp)}`,
  );
  add('M10-4. 还原后调用了 resetCache', resetCount.n > resetsBefore, `resetCache 次数=${resetCount.n}`);

  // ── M9-2：同 extId 换新实例 → 重新分类 ──
  const yinInst2 = {
    getInfo() {
      return {
        id: YIN_ID,
        name: 'YinSecurity',
        blocks: [{ info: { opcode: 'hasTM', blockType: 'Boolean', text: 'has TM?' } }],
      };
    },
    hasTM: () => true,
  };
  runtime[`ext_${YIN_ID}`] = yinInst2;
  clock.advance(2200);
  const inst2Out = yinInst2.hasTM();
  add('M9-2. 同 extId 换新实例后仍被中和', inst2Out === false, `新实例 hasTM=${JSON.stringify(inst2Out)}`);

  // ── 敌扩展仍被中和（整体没被前面的动作带偏）──
  //    注：这条必须放在「扩展卸载」之前 —— 卸载后释放管控是**预期行为**，
  //    那时 getOpcodeFunction 返回 undefined 才是正确语义。
  const yinFn = runtime.getOpcodeFunction(`${YIN_ID}_hasTM`);
  let yinOut = '<无函数>';
  try {
    yinOut = typeof yinFn === 'function' ? yinFn() : yinFn;
  } catch {
    yinOut = '抛错';
  }
  add('Z-2. 敌布尔探针始终恒 false', yinOut === false, `hasTM=${JSON.stringify(yinOut)}`);

  // ── M9-1：扩展被卸载 → 释放管控 ──
  runtime._blockInfo = runtime._blockInfo.filter((b) => b.id !== YIN_ID);
  delete runtime[`ext_${YIN_ID}`];
  extensionManager._loadedExtensions.delete(YIN_ID);
  delete extensionManager._customExtensionInfo[YIN_ID];
  clock.advance(2200);
  clock.advance(2200);
  clock.advance(2200);
  const stillLocked = api.lockedExtIdsOf(vmOuter).includes(YIN_ID);
  const residue = Object.keys(runtime._primitives).filter((k) => k.startsWith(`${YIN_ID}_`));
  add(
    'M9-1. 扩展卸载后释放管控且不留残影',
    !stillLocked && residue.length === 0,
    `仍被管控=${stillLocked} 残留键=${residue.length}`,
  );

  // ── Z-1：良性扩展零误伤 ──
  const goodOut = goodInst.add(2, 3);
  const goodPrim = runtime.getOpcodeFunction(`${GOOD_ID}_add`);
  const goodPrimOut = typeof goodPrim === 'function' ? goodPrim(2, 3) : '<无函数>';
  add(
    'Z-1. 良性扩展零误伤（实例层 / primitives 层 / Blockly 层）',
    goodOut === 5 && goodPrimOut === 5 && blocklyBlocks.add?.func === goodInst.add,
    `实例层=${goodOut} primitives层=${goodPrimOut} Blockly层未动=${blocklyBlocks.add?.func === goodInst.add}`,
  );

  // ── 幂等：多拍巡检不产生额外副作用 ──
  const snap = { ...calls };
  clock.advance(3000);
  clock.advance(3000);
  add(
    'Z-3. 多拍巡检幂等',
    calls.showDetail === snap.showDetail && calls.jump === snap.jump && calls.blockScript === snap.blockScript,
    `calls=${JSON.stringify(calls)}`,
  );

  const st = api.antitamperStats();
  console.log(
    `诊断: 自愈积木=${st.healedBlocks} paused守卫=${st.pausedGuards} Blockly影子=${st.shadowed} 释放管控=${st.released}`,
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
