/**
 * 扩展枚举面性能探针 —— 测量每 2s 巡检的单拍成本。
 *
 * 背景：新枚举面每拍要走三路（_blockInfo / runtime.ext_${id} / extensionManager），
 * 必须确认真实开销可接受（不能因反制而拖慢站点）。
 *
 * 用法：node scripts/probe-ext-perf.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp');

const ENTRY = `
export { enumerateExtensions, enumerateInstances } from '../src/core/ext-registry';
export { sanitizeRuntime } from '../src/core/ext-sanitize';
`;

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
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    children: [],
    childNodes: [],
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
    dataset: {},
    textContent: '',
    innerHTML: '',
  });
  globalThis.document = {
    readyState: 'complete',
    documentElement: fakeEl(),
    head: fakeEl(),
    body: fakeEl(),
    createElement: fakeEl,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = globalThis;
  globalThis.location = { hostname: 'localhost', href: 'http://localhost/' };
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
}

function build() {
  const entryPath = path.join(TMP, 'entry.ts');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(entryPath, ENTRY, 'utf8');
  const outDir = path.join(TMP, 'js');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
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
  return path.join(outDir, '.probe-tmp', 'entry.js');
}

/** 构造 N 个扩展的 mock vm（贴近真实规模） */
function makeVm(nExt, nBlocks) {
  const runtime = { _primitives: {}, _blockInfo: [], targets: [] };
  const em = { _loadedExtensions: new Map(), _customExtensionInfo: {}, _officialExtensionInfo: {}, _gandiExternalExtensionServices: [], builtinExtensions: {} };
  for (let i = 0; i < nExt; i++) {
    const id = `ext${i}`;
    const blocks = [];
    const prims = {};
    for (let b = 0; b < nBlocks; b++) {
      const op = `op${b}`;
      blocks.push({ info: { opcode: op, blockType: b % 3 === 0 ? 'Boolean' : 'reporter', text: `block ${b}` } });
      prims[`${id}_${op}`] = function () {
        return 1;
      };
    }
    runtime._blockInfo.push({ id, name: `ext ${i}`, blocks });
    runtime[`ext_${id}`] = {
      getInfo: () => ({ id, blocks: blocks.map((x) => ({ opcode: x.info.opcode, blockType: x.info.blockType, text: x.info.text })) }),
    };
    for (const k of Object.keys(prims)) runtime._primitives[k] = prims[k];
    em._loadedExtensions.set(id, `extension_${i}_${id}`);
  }
  return { runtime, extensionManager: em };
}

function bench(label, fn, iters) {
  // 预热
  for (let i = 0; i < 20; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / iters;
  console.log(`${label.padEnd(46)} ${ms.toFixed(4)} ms/次`);
  return ms;
}

function main() {
  installDomStubs();
  const mod = require(build());
  const { enumerateExtensions, sanitizeRuntime } = mod;

  console.log('\n=== 扩展枚举面性能 ===\n');

  for (const [nExt, nBlocks] of [
    [10, 10],
    [30, 20],
    [60, 30],
  ]) {
    const vm = makeVm(nExt, nBlocks);
    const label = `${nExt} 扩展 × ${nBlocks} 积木`;
    bench(`枚举面 enumerateExtensions  ${label}`, () => enumerateExtensions(vm), 2000);
    // sanitizeRuntime 含分类 + 首次源码分析（较重），取后续稳定态
    sanitizeRuntime(vm);
    bench(`巡检 sanitizeRuntime(稳定态)  ${label}`, () => sanitizeRuntime(vm), 500);
    console.log('');
  }

  // 阈值判定：2s 巡检周期下，单拍 < 1ms 意味着占用率 < 0.05%
  const vm = makeVm(30, 20);
  const ms = bench('基准（30×20）单拍成本', () => enumerateExtensions(vm), 2000);
  const duty = (ms / 2000) * 100;
  console.log(`2s 巡检周期下的主线程占用率：${duty.toFixed(4)}%`);
  if (ms > 1) {
    console.log('✗ 单拍超过 1ms —— 需要优化');
    process.exitCode = 1;
  } else {
    console.log('✓ 单拍在 1ms 以内，占用率可忽略');
  }
  process.exit(process.exitCode || 0);
}

main();
