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
// - disableConsoleOutput 恒为 false——禁 console 会破坏宿主页面自身日志，零副作用底线。
// - renameGlobals 已启用（产物为自包含 bundle，无外部引用方，安全）。
// - domainLock 不启用——@match 已锁定 ccw.site，domainLock 是致命失败模式
//   （校验异常 = 脚本在目标站直接瘫痪），不值得赌。
const STAGE_A_OPTIONS = {
  compact: true,
  // 性能权衡（v2：作品卡顿治理）——CFF/DCI 是把函数体重写成状态机的变换，
  // 命中的函数每次调用都慢数倍；阈值过高会拖慢 VaIMod 里所有常驻热路径
  // （MutationObserver 清洗、2s 巡检遍历、bind/fetch 包装），装上后整站变卡。
  // 0.45/0.25 仍覆盖近半数函数 + 全部字符串数组/编码/重命名防还原层，
  // 防静态阅读强度不打折，运行时开销约降一半。
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4, // 实测 0.6 档反而慢 60%（更多函数进入字符串/表达式变换链），0.4 为拐点 // 热路径包装函数体量小，0.4 档只展平复杂函数（核心逻辑仍覆盖），
  // 小包装免于状态机税：DOM 钩子每次调用省掉一层 switch 调度
  deadCodeInjection: false, // P2 调优：DCI 只膨胀体积+分支数，防还原价值远低于 CFF
  deadCodeInjectionThreshold: 0.25,
  // 反动态调试：debugger 陷阱（初始 + 定时器续排）。headless/正常浏览零感知，
  // 仅在 DevTools 附着时产生暂停对抗。
  debugProtection: true,
  debugProtectionInterval: 4000,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: false, // 数字常量不再表达式化：热路径里的每次数字字面量都省一次运算
  // 反 AST / 反反混淆：全局名重命名 + 对象键表达式化，破坏跨文件符号对照
  renameGlobals: true,
  transformObjectKeys: true,
  // selfDefending 禁用（真 Bug 实锤，勿再开）：其自检对自身 toString 跑
  // 灾难性回溯正则 (((.+)+)+)+$，MB 级函数体直接打爆 V8 正则栈
  // → RangeError: Maximum call stack size exceeded（小样本探针发现不了，
  //   只有真实 bundle 冒烟能暴露）。防美化/防还原职责由 CFF+DCI+rc4+
  //   renameGlobals+transformObjectKeys+debugProtection 共同承担。
  simplify: true,
  // 切片粒度 16 → 32：条目数减半 → stringArray 旋转/洗牌/索引位移的
  // 初始化与每次索引换算成本同步下降，防 grep 特征的粒度仍然够碎。
  splitStrings: true,
  splitStringsChunkLength: 32,
  stringArray: true,
  stringArrayCallsTransform: false, // P1 调优：per-call 变换包装是挂载 +1.6s 的主要来源之一
  stringArrayEncoding: ['base64'], // P1 调优：rc4 每次取串都是对称解密，base64 解码快一个量级；防静态阅读由 splitStrings+escapes+rotate/shuffle/indexShift+CFF 承担
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  // 包装层数 3 → 2：每层包装 = 字符串访问多一跳函数调用。解码只在初始化
  // 一次，真正的持续开销在运行期每次取串都过包装链，2 层即可阻断直接求值。
  stringArrayWrappersCount: 1, // P1 调优：单层包装（配合 indexShift/rotate 仍阻断直接求值）
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 1,
  // 反静态分析：字面量 unicode 转义（grep/正则特征扫射失效）
  unicodeEscapeSequence: true,
  // 固定随机种子：产物可复现（此前每次构建种子随机，CFF 是否命中热路径看运气，
  // 同一份代码在不同构建间挂载耗时能差 1.4 倍）。固定后性能基线稳定可测。
  seed: 20261024,
};

// 二分排查开关：VAIMOD_OBF_NO="debugProtection,transformObjectKeys" 剔除指定选项
// （仅本地排查用，CI 不设置 → 全量强度）
for (const key of (process.env.VAIMOD_OBF_NO ?? '').split(',').filter(Boolean)) {
  delete STAGE_A_OPTIONS[key];
}

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
var __t0=Date.now();
var __bin=atob(__P);var __n=__bin.length;var __buf=new Uint8Array(__n);
for(var __i=0;__i<__n;__i++)__buf[__i]=__bin.charCodeAt(__i);
var __h=0x811c9dc5;
for(var __i=0;__i<__n;__i++){__h^=__buf[__i];__h=Math.imul(__h,0x01000193)>>>0;}
if(__h!==__C)return;
if(Date.now()-__t0>3000)return;
var __kb=atob(__K);var __kl=__kb.length;
for(var __j=0;__j<__n;__j++)__buf[__j]=__kb.charCodeAt(__j%__kl)^__buf[__j];
var __code=__inflate(__buf,{to:"string"});
if(Date.now()-__t0>5000)return;
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
        // 【v38 隐身】外面包一层 IIFE：生产 execLine 是间接 eval（全局作用域），
        // 第一层产物若带顶层 var/function 声明（混淆器 _0x* 命名 + __svelte 等
        // 模块级变量），会全部漏成 window 自有键——审计扩展枚举 window 一遍
        // 就实锤「页面进了混淆脚本」（probe-leakdeep L1 实测 _0x1711 等 5 键）。
        // IIFE 后全局零残留；代码对 window 的有意挂载不受影响。
        const stageA =
          '!function(){' +
          javascriptObfuscator.obfuscate(body, STAGE_A_OPTIONS).getObfuscatedCode() +
          '}();';

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
          // 解压后不立即 eval：4.7MB 混淆体的 V8 解析/编译会阻塞主线程 1.5s+（探针
          // 实锤：1.2MB 零逻辑惰性脚本也造成 +1.2s 挂载开销），放在 document-start
          // 会把站点自身加载整段卡死（「项目加载不了特别卡」根因）。改为等 load 事件
          // 再执行——站点可交互后一次性消化解析成本。防御语义不变：所有守卫在同一
          // 时刻整体生效（早于面板挂载与 VM 连接），只是从「文档解析前」挪到「load 后」。
          'var __e=eval;' +
            'var __boot=function(){__e(__code);};' +
            'var __idle=function(f){if(typeof requestIdleCallback==="function"){requestIdleCallback(f,{timeout:5000});}else{setTimeout(f,0);}};' +
            'if(document.readyState==="complete"){__idle(__boot);}' +
            'else{var __wr=function(){if(document.readyState==="complete"){__idle(__boot);}else{setTimeout(__wr,40);}};setTimeout(__wr,40);}',
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
