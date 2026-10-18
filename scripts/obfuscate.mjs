import javascriptObfuscator from 'javascript-obfuscator';
import { gzipSync, gunzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PAKO_INFLATE_MIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  'pako',
  'dist',
  'pako_inflate.min.js',
);

// ── 第一层：强力高性能混淆（javascript-obfuscator 全量强度） ─────────────
// 高性能取舍说明：
// - debugProtection / disableConsoleOutput 恒为 false——VaIMod 对宿主站点
//   零副作用是硬约束，绝不在 ccw.site 上锁 DevTools / 禁 console。
// - renameGlobals 恒为 false——产物以 @grant none 注入页面全局，改全局名
//   有碰撞风险。
// - domainLock 不启用——@match 已锁定 ccw.site，domainLock 是致命失败模式
//   （校验异常 = 脚本在目标站直接瘫痪），不值得赌。
const STAGE_A_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 16,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 1,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

// 加载器外层轻混淆：只隐藏装配胶水与 pako 特征，
// 不做 CFF/DCI/splitStrings（inflate 是热路径 + 巨大 base64 字面量不能切碎）。
const LOADER_OPTIONS = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  simplify: true,
  stringArray: false,
  selfDefending: false,
  unicodeEscapeSequence: false,
};

// FNV-1a 32bit——与加载器内实现逐字对齐（Math.imul 防溢出）
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── 加载器胶水模板 ─────────────────────────────────────────────────────
// pako inflate 以「假 module/exports」方式内嵌：命中 UMD 的 CommonJS 分支，
// 填充局部 exports 对象，绝不触碰 window/globalThis（对宿主零污染）。
// execLine 由构建注入：生产 = 间接 eval（全局作用域，@run-at document-start
// 语义与原直出产物一致）；测试 = 捕获到 globalThis 供 Node 字节级比对。
function makeLoaderBody(pakoSource, payloadB64, keyB64, checksum, execLine) {
  return `
(function(){
var exports={};var module={exports:exports};
${pakoSource}
var __inflate=module.exports.inflate;
var __P="${payloadB64}";
var __K="${keyB64}";
var __C=${checksum};
try{
var __bin=atob(__P);var __n=__bin.length;var __buf=new Uint8Array(__n);
for(var __i=0;__i<__n;__i++)__buf[__i]=__bin.charCodeAt(__i);
var __h=0x811c9dc5;
for(var __i=0;__i<__n;__i++){__h^=__buf[__i];__h=Math.imul(__h,0x01000193)>>>0;}
if(__h!==__C)return;
var __kb=atob(__K);var __kl=__kb.length;
for(var __j=0;__j<__n;__j++)__buf[__j]=__kb.charCodeAt(__j%__kl)^__buf[__j];
var __code=__inflate(__buf,{to:"string"});
${execLine}
}catch(__e){}
})();
`;
}

// Node 侧等价解码（字节级验证用）：XOR → gunzip → 比对
// （checksum 校验由加载器模板测试②覆盖，与生产实现逐字对齐）
function nodeDecode(payloadBytes, keyBytes) {
  const out = Buffer.alloc(payloadBytes.length);
  for (let i = 0; i < payloadBytes.length; i++) {
    out[i] = keyBytes[i % keyBytes.length] ^ payloadBytes[i];
  }
  return gunzipSync(out).toString('utf8');
}

export function obfuscateUserscript() {
  return {
    name: 'obfuscate-userscript',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!file || file.type !== 'chunk' || !file.fileName.endsWith('.js')) continue;
        const code = file.code;
        if (typeof code !== 'string' || !code.includes('==UserScript==')) continue;

        const headerMatch = code.match(/^(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*)/);
        const header = headerMatch ? headerMatch[1] : '';
        const body = header ? code.slice(header.length) : code;
        if (!body.trim()) continue;

        // 第一层：强力混淆（控制流扁平化 + 死代码注入 + rc4 字符串矩阵 + 自守卫）
        const stageA = javascriptObfuscator.obfuscate(body, STAGE_A_OPTIONS).getObfuscatedCode();

        // 第二层：GZIP level 9
        const gz = gzipSync(Buffer.from(stageA, 'utf8'), { level: 9 });

        // 第三层：XOR——每次构建随机 32 字节密钥
        const key = crypto.randomBytes(32);

        // 第四层：完整性校验（FNV-1a，针对密文本体；篡改即拒绝执行）
        const payload = Buffer.alloc(gz.length);
        for (let i = 0; i < gz.length; i++) payload[i] = gz[i] ^ key[i % key.length];
        const checksum = fnv1a(payload);

        // ── 构建期字节级验证（失败即构建失败）──────────────────────────
        // ① 密文链路：checksum → XOR → gunzip 必须还原出第一层产物
        const decoded = nodeDecode(payload, key);
        if (decoded !== stageA) {
          throw new Error('[obfuscate] 验证失败：XOR+GZIP 链路还原结果与第一层产物不一致');
        }
        // ② 加载器机制：完整模板（含内嵌 pako inflate）在 Node 跑一遍，
        //    exec 换成捕获桩，捕获结果必须与第一层产物逐字节一致
        const testSrc = makeLoaderBody(
          readFileSync(PAKO_INFLATE_MIN, 'utf8'),
          payload.toString('base64'),
          key.toString('base64'),
          checksum,
          'globalThis.__vaimodCaptured=__code;',
        );
        globalThis.__vaimodCaptured = undefined;
        new Function(testSrc)();
        if (globalThis.__vaimodCaptured !== stageA) {
          throw new Error('[obfuscate] 验证失败：加载器模板解码结果与第一层产物不一致');
        }
        delete globalThis.__vaimodCaptured;

        // 第五层：装配 + 轻混淆加载器本体
        // pako 的 license 横幅注释剥离 + UMD 死分支的 `.pako={}` 全局属性名中性化
        // ——不让产物暴露打包器特征（CJS 分支必然命中，else 分支永不执行）
        const pakoSource = readFileSync(PAKO_INFLATE_MIN, 'utf8')
          .replace(/^\/\*![\s\S]*?\*\//, '')
          .replace(/\.pako=/g, '._=')
          .replace(/pako inflate/gi, 'inflate');
        const loader = makeLoaderBody(
          pakoSource,
          payload.toString('base64'),
          key.toString('base64'),
          checksum,
          'var __e=eval;__e(__code);',
        );
        const loaderObf = javascriptObfuscator.obfuscate(loader, LOADER_OPTIONS).getObfuscatedCode();

        file.code = header + loaderObf;

        const kb = (n) => (n / 1024).toFixed(1) + 'KB';
        console.log(
          `[obfuscate] 5层流水线完成: 源 ${kb(body.length)} → 强混淆 ${kb(stageA.length)}` +
            ` → GZIP ${kb(gz.length)} → XOR+校验 ${kb(payload.length)}` +
            ` → 最终(含pako加载器) ${kb(file.code.length)}` +
            ` | 压缩率 ${(file.code.length / body.length).toFixed(2)}x`,
        );
      }
    },
  };
}
