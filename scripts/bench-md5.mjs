/**
 * MD5 性能与一致性快测（不进 CI，仅本地核对用）
 *   · 与 Node crypto 的 md5 逐字节对照（随机 1MB / 边界长度）
 *   · 100MB 吞吐估算
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const TMP = path.join(ROOT, '.probe-tmp-md5');

const ENTRY = `export { md5Hex } from '../src/core/md5';`;

mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, 'entry.ts'), ENTRY, 'utf8');
const outDir = path.join(TMP, 'js');
mkdirSync(outDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(TMP, 'entry.ts'),
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
const { md5Hex } = require(path.join(outDir, '.probe-tmp-md5', 'entry.js'));

// 一致性：随机 + 边界长度
const lens = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65536, 1048576];
let bad = 0;
for (const n of lens) {
  const buf = crypto.randomBytes(n);
  const mine = md5Hex(new Uint8Array(buf));
  const ref = crypto.createHash('md5').update(buf).digest('hex');
  if (mine !== ref) {
    bad++;
    console.log(`✗ len=${n} mine=${mine} ref=${ref}`);
  }
}
console.log(bad === 0 ? `✓ 一致性：${lens.length} 个长度全部与 Node crypto 相同` : `✗ ${bad} 个长度不一致`);

// 性能：100MB
const big = crypto.randomBytes(100 * 1024 * 1024);
const t0 = Date.now();
md5Hex(new Uint8Array(big));
const dt = (Date.now() - t0) / 1000;
console.log(`性能：100MB 用时 ${dt.toFixed(2)}s → ${(100 / dt).toFixed(1)} MB/s`);

rmSync(TMP, { recursive: true, force: true });
