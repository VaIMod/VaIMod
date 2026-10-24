/**
 * 真实 CCW VM 结构探针 —— 验证扩展反制全链路。
 *
 * 关键点：mock 严格复刻平台 vendor chunk 的真实结构（此前探针用的
 * `runtime.extensions` 在真实 VM 里根本不存在，导致所有反制测试"通过"
 * 却是空跑）：
 *   · 实例真身        runtime.ext_${id}          （compilerRegisterExtension 写入）
 *   · 元信息真身      runtime._blockInfo[]       （id + blocks[].info{opcode,blockType,text}）
 *   · primitives 键   ${extId}_${opcode}
 *   · _loadedExtensions 是 Map<id, serviceName>（值是**服务名字符串**，不是实例）
 *   · _customExtensionInfo / _officialExtensionInfo 是**普通对象**（不是 Map）
 *   · _gandiExternalExtensionServices 是**数组**（不是 Map）
 *
 * 用法：node scripts/probe-ext-registry.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp');

// ---------- 1. 用 esbuild 把 TS 源打成一个可 require 的 bundle ----------

const ENTRY = `
export { enumerateExtensions, enumerateInstances, classifyBlockType } from '../src/core/ext-registry';
export { sanitizeRuntime, neutralizeInstance, lockExtensionPrimitive } from '../src/core/ext-sanitize';
export { SecureGuard } from '../src/core/secure-guard';
`;

function build() {
  const entryPath = path.join(TMP, 'entry.ts');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(entryPath, ENTRY, 'utf8');
  const outDir = path.join(TMP, 'js');
  mkdirSync(outDir, { recursive: true });
  // 用 tsc 编译（esbuild 的平台二进制在部分沙箱内不可执行）
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
  ], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  // package.json 是 type:module —— 在产物目录写一个 {"type":"commonjs"} 覆盖，
  // 让 tsc 产出的 .js 按 CommonJS 解释，可直接 require
  writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  return path.join(outDir, '.probe-tmp', 'entry.js');
}
// ---------- 2. DOM 垫片（模块顶层会碰 document/window） ----------

/** 最小 DOM stub —— 只为让模块能在 node 里加载，不参与被测逻辑 */
function installDomStubs() {
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
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
}

// ---------- 3. 真实结构的 mock ----------

/** YinSecurity 的扩展 id（真实样本含不可打印字符） */
const YIN_ID = 'YinSecurityxɺc�';

function makeYinInstance() {
  const inst = {
    _c: '{"tampered":true}',
    hasTM() {
      return true; // 真实实现：探测 Tampermonkey 标记
    },
    hasScript(name) {
      return name === 'CSRT';
    },
    isHijacked(type) {
      return type === 'Function.bind';
    },
    showDetail(name) {
      globalThis.__yins = { shown: name };
    },
    jump(url) {
      globalThis.__yins = { jumped: url };
    },
    blockScript(name) {
      globalThis.__yins = { blocked: name };
    },
    getTamperInfo() {
      return JSON.stringify(this._c);
    },
    getInfo() {
      return {
        id: YIN_ID,
        name: '[stop cheat software]',
        blocks: [
          { opcode: 'hasTM', blockType: 'Boolean', text: 'Is Tampermonkey loaded' },
          { opcode: 'hasScript', blockType: 'Boolean', text: 'Is [NAME] script loaded' },
          { opcode: 'isHijacked', blockType: 'Boolean', text: 'Is [TYPE] hijacked' },
          { opcode: 'showDetail', blockType: 'command', text: 'Show Details: [NAME]' },
          { opcode: 'jump', blockType: 'command', text: 'Jump to [URL]' },
          { opcode: 'blockScript', blockType: 'command', text: 'Destroy [NAME] script' },
        ],
      };
    },
  };
  return inst;
}

/**
 * 真实样本形态：class CheatBlockerExtension —— opcode 在 **prototype** 上，
 * getInfo 是实例方法，构造期会读 runtime.getFormatMessage。
 * 这一形态必须单独覆盖：只扫实例自有属性会全漏。
 */
function makeYinClassInstance() {
  class CheatBlockerExtension {
    constructor(runtime) {
      this.runtime = runtime;
      this._c = '{"tampered":true}';
      this._formatMessage = (msg) => (msg && msg.default) || '';
    }
    hasTM() {
      return true;
    }
    hasScript(name) {
      return name === 'CSRT';
    }
    isHijacked(type) {
      return type === 'Function.bind';
    }
    showDetail(name) {
      globalThis.__yins = { shown: name };
    }
    jump(url) {
      globalThis.__yins = { jumped: url };
    }
    blockScript(name) {
      globalThis.__yins = { blocked: name };
    }
    getTamperInfo() {
      return JSON.stringify(this._c);
    }
    getInfo() {
      return {
        id: YIN_ID,
        name: this._formatMessage({ default: '[stop cheat software]' }),
        blocks: [
          { opcode: 'hasTM', blockType: 'Boolean', text: 'Is Tampermonkey loaded' },
          { opcode: 'hasScript', blockType: 'Boolean', text: 'Is [NAME] script loaded' },
          { opcode: 'isHijacked', blockType: 'Boolean', text: 'Is [TYPE] hijacked' },
          { opcode: 'showDetail', blockType: 'command', text: 'Show Details: [NAME]' },
          { opcode: 'jump', blockType: 'command', text: 'Jump to [URL]' },
          { opcode: 'blockScript', blockType: 'command', text: 'Destroy [NAME] script' },
        ],
      };
    }
  }
  return new CheatBlockerExtension({ getFormatMessage: (m) => (m && m.default) || '' });
}

function makeBenignInstance() {
  return {
    add(a, b) {
      return a + b;
    },
    sayHello() {
      return 'hello';
    },
    getInfo() {
      return {
        id: 'benignExt',
        name: 'benign',
        blocks: [
          { opcode: 'add', blockType: 'reporter', text: 'add [A] to [B]' },
          { opcode: 'sayHello', blockType: 'reporter', text: 'say hello' },
        ],
      };
    },
  };
}

/**
 * 构造一个结构与真实 CCW VM 完全一致的 mock vm。
 * @param {boolean} useClass true → 用真实样本的 class 形态（opcode 在 prototype 上）
 */
function makeVm(useClass = false) {
  const yin = useClass ? makeYinClassInstance() : makeYinInstance();
  const benign = makeBenignInstance();

  const prims = {
    // 内置积木（裸 opcode —— 平台 _registerBlockPackages 的形态）
    motion_movesteps: function () {
      return 1;
    },
    // 扩展积木：真实键 = ${extId}_${opcode}
    [`${YIN_ID}_hasTM`]: function () {
      return true;
    },
    [`${YIN_ID}_hasScript`]: function () {
      return true;
    },
    [`${YIN_ID}_isHijacked`]: function () {
      return true;
    },
    [`${YIN_ID}_showDetail`]: function () {
      globalThis.__yins = { shown: 'x' };
    },
    [`${YIN_ID}_jump`]: function () {
      globalThis.__yins = { jumped: 'about:blank' };
    },
    [`${YIN_ID}_blockScript`]: function () {
      globalThis.__yins = { blocked: 'x' };
    },
    [`benignExt_add`]: function (a, b) {
      return a + b;
    },
  };

  const runtime = {
    _primitives: prims,
    // 元信息真身：平台归一化后的 blockType
    _blockInfo: [
      {
        id: YIN_ID,
        name: '[stop cheat software]',
        blocks: [
          { info: { opcode: 'hasTM', blockType: 'Boolean', text: 'Is Tampermonkey loaded' } },
          { info: { opcode: 'hasScript', blockType: 'Boolean', text: 'Is [NAME] script loaded' } },
          { info: { opcode: 'isHijacked', blockType: 'Boolean', text: 'Is [TYPE] hijacked' } },
          { info: { opcode: 'showDetail', blockType: 'command', text: 'Show Details: [NAME]' } },
          { info: { opcode: 'jump', blockType: 'command', text: 'Jump to [URL]' } },
          { info: { opcode: 'blockScript', blockType: 'command', text: 'Destroy [NAME] script' } },
        ],
      },
      {
        id: 'benignExt',
        name: 'benign',
        blocks: [
          { info: { opcode: 'add', blockType: 'reporter', text: 'add [A] to [B]' } },
          { info: { opcode: 'sayHello', blockType: 'reporter', text: 'say hello' } },
        ],
      },
    ],
    // 实例真身：compilerRegisterExtension 写入
    [`ext_${YIN_ID}`]: yin,
    ext_benignExt: benign,
    targets: [],
  };

  const extensionManager = {
    // Map<id, serviceName> —— 值是服务名字符串，不是实例
    _loadedExtensions: new Map([
      [YIN_ID, `extension_0_${YIN_ID}`],
      ['benignExt', 'extension_1_benignExt'],
    ]),
    // 普通对象（非 Map）
    _customExtensionInfo: {
      [YIN_ID]: { info: { extensionId: YIN_ID }, url: 'https://example.invalid/yin.js' },
    },
    _officialExtensionInfo: {},
    // 数组（非 Map）
    _gandiExternalExtensionServices: [],
    builtinExtensions: {},
  };

  return { runtime, extensionManager, yin, benign, prims };
}

// ---------- 3. 断言 ----------

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? ` → ${extra}` : ''));
  }
}

function main() {
  installDomStubs();
  const bundlePath = build();
  // 加载 bundle（需要 document/window 的模块在 import 时不应崩）
  const mod = require(bundlePath);
  const { enumerateExtensions, enumerateInstances, sanitizeRuntime, neutralizeInstance, lockExtensionPrimitive } = mod;

  const vm = makeVm();
  const { runtime, extensionManager, yin, benign, prims } = vm;

  // === A. 枚举面 ===
  const entries = enumerateExtensions(vm);
  check('A1 枚举到 2 个扩展', entries.length === 2, `实际 ${entries.length}`);
  const yinEntry = entries.find((e) => e.id === YIN_ID);
  check('A2 找到 YinSecurity 条目', !!yinEntry);
  check('A3 YinSecurity 实例真身可取', yinEntry && yinEntry.instance === yin);
  check('A4 元信息含 6 积木', yinEntry && yinEntry.blocks.length === 6, yinEntry && yinEntry.blocks.length);
  check(
    'A5 blockType 归一化正确',
    yinEntry && yinEntry.blocks[0].blockType === 'Boolean' && yinEntry.blocks[3].blockType === 'command',
  );
  const insts = enumerateInstances(vm);
  check('A6 枚举到 2 个实例', insts.length === 2, `实际 ${insts.length}`);
  check('A7 实例含 YinSecurity', insts.some((i) => i.instance === yin));

  // === B. 分类（纯函数级） ===
  const benignEntry = entries.find((e) => e.id === 'benignExt');
  check('B1 良性扩展未被误判', !benignEntry.blocks.some((b) => b.opcode === 'add' && b.blockType === 'Boolean'));

  // === C. 反制：sanitizeRuntime 后 primitives 层行为 ===
  sanitizeRuntime(vm);

  check('C1 hasTM 恒 false', prims[`${YIN_ID}_hasTM`]() === false, String(prims[`${YIN_ID}_hasTM`]()));
  check('C2 hasScript 恒 false', prims[`${YIN_ID}_hasScript`]() === false);
  check('C3 isHijacked 恒 false', prims[`${YIN_ID}_isHijacked`]() === false);

  globalThis.__yins = undefined;
  prims[`${YIN_ID}_showDetail`]('CSRT');
  check('C4 showDetail no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  prims[`${YIN_ID}_jump`]('about:blank');
  check('C5 jump no-op（不跳转）', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  prims[`${YIN_ID}_blockScript`]('CSRT');
  check('C6 blockScript no-op（不摧毁）', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));

  // === D. 实例层 ===
  check('D1 实例 hasTM 恒 false', yin.hasTM() === false);
  check('D2 实例 isHijacked 恒 false', yin.isHijacked('Function.bind') === false);
  globalThis.__yins = undefined;
  yin.jump('about:blank');
  check('D3 实例 jump no-op', globalThis.__yins === undefined);
  yin.blockScript('CSRT');
  check('D4 实例 blockScript no-op', globalThis.__yins === undefined);

  // === E. 良性扩展零误伤 ===
  check('E1 良性 add 仍正常', prims.benignExt_add(2, 3) === 5, String(prims.benignExt_add(2, 3)));
  check('E2 良性实例 add 未被改', benign.add(2, 3) === 5);
  check('E3 良性 sayHello 未被改', benign.sayHello() === 'hello');
  check('E4 内置积木未被改', prims.motion_movesteps() === 1);

  // === F. 幂等 ===
  const before = prims[`${YIN_ID}_hasTM`];
  sanitizeRuntime(vm);
  check('F1 重复巡检幂等（同一包装）', prims[`${YIN_ID}_hasTM`] === before);
  check('F2 重复巡检后仍恒 false', prims[`${YIN_ID}_hasTM`]() === false);

  // === G. 家族专项：secure-guard 的 find() ===
  const guard = new mod.SecureGuard();
  const found = guard.find(vm);
  check('G1 secure-guard.find 命中 YinSecurity', !!found, JSON.stringify(found && found.id));
  check('G2 find 返回的实例正确', found && found.inst === yin);
  check('G3 find 返回的扩展 id 正确', found && found.id === YIN_ID, found && found.id);

  // === H. 家族专项 adopt → primitives 层锁 ===
  const vm2 = makeVm();
  const guard2 = new mod.SecureGuard();
  guard2.adopt(vm2.yin, YIN_ID, vm2);
  check('H1 adopt 后 hasTM 恒 false', vm2.prims[`${YIN_ID}_hasTM`]() === false);
  globalThis.__yins = undefined;
  vm2.prims[`${YIN_ID}_jump`]('x');
  check('H2 adopt 后 jump no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  globalThis.__yins = undefined;
  vm2.prims[`${YIN_ID}_blockScript`]('x');
  check('H3 adopt 后 blockScript no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  check('H4 adopt 后良性扩展不受影响', vm2.prims.benignExt_add(1, 1) === 2);

  // === I. 独立锁接口 ===
  const vm3 = makeVm();
  lockExtensionPrimitive(vm3, YIN_ID, 'hasTM', 'bool');
  check('I1 lockExtensionPrimitive 生效', vm3.prims[`${YIN_ID}_hasTM`]() === false);

  // === J. 无 runtime.extensions 的场景（真实 VM） ===
  check('J1 mock 里确实没有 runtime.extensions', runtime.extensions === undefined);
  check('J2 mock 的 _loadedExtensions 是 Map', extensionManager._loadedExtensions instanceof Map);
  check('J3 mock 的 _customExtensionInfo 是普通对象', !(extensionManager._customExtensionInfo instanceof Map));
  check('J4 mock 的 _gandiExternalExtensionServices 是数组', Array.isArray(extensionManager._gandiExternalExtensionServices));

  // === K. 真实样本 class 形态（opcode 在 prototype 上） ===
  const vmC = makeVm(true);
  sanitizeRuntime(vmC);
  check('K1 class 形态 hasTM 恒 false', vmC.prims[`${YIN_ID}_hasTM`]() === false, String(vmC.prims[`${YIN_ID}_hasTM`]()));
  check('K2 class 形态 hasScript 恒 false', vmC.prims[`${YIN_ID}_hasScript`]() === false);
  check('K3 class 形态 isHijacked 恒 false', vmC.prims[`${YIN_ID}_isHijacked`]() === false);
  globalThis.__yins = undefined;
  vmC.prims[`${YIN_ID}_jump`]('about:blank');
  check('K4 class 形态 jump no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  globalThis.__yins = undefined;
  vmC.prims[`${YIN_ID}_blockScript`]('CSRT');
  check('K5 class 形态 blockScript no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  globalThis.__yins = undefined;
  vmC.prims[`${YIN_ID}_showDetail`]('CSRT');
  check('K6 class 形态 showDetail no-op', globalThis.__yins === undefined, JSON.stringify(globalThis.__yins));
  check('K7 class 形态实例 hasTM 恒 false', vmC.yin.hasTM() === false);
  check('K8 class 形态良性扩展不受影响', vmC.prims.benignExt_add(2, 3) === 5);
  const guardC = new mod.SecureGuard();
  const foundC = guardC.find(vmC);
  check('K9 class 形态 find 命中', !!foundC && foundC.inst === vmC.yin);

  // === L. 扩展 id 含不可打印字符时键匹配仍精确 ===
  check('L1 特殊 id 的 primitives 键正确', typeof vmC.prims[`${YIN_ID}_hasTM`] === 'function');
  const otherId = 'otherExt';
  const vmL = makeVm();
  vmL.prims[`${otherId}_hasTM`] = function () {
    return 'SHOULD_STAY';
  };
  sanitizeRuntime(vmL);
  check('L2 同尾 opcode 的其它扩展未被误伤', vmL.prims[`${otherId}_hasTM`]() === 'SHOULD_STAY', String(vmL.prims[`${otherId}_hasTM`]()));

  // ---------- 输出 ----------
  console.log('\n=== 扩展反制探针结果 ===');
  console.log(`通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
  // 模块内置常驻定时器（巡检/守卫）→ 探针结束后主动退出
  process.exit(process.exitCode || 0);
}

main();
