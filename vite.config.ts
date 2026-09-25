import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { obfuscateUserscript } from './scripts/obfuscate.mjs';

const match = [
  'https://scratch.mit.edu/*', // Scratch
  'https://www.ccw.site/*', // CCW（全站：detail 编辑器/首页/改版路径全覆盖）
  'https://40code.com/*', // 40code
  'https://gitblock.cn/*', // GitBlock
  'https://world.xiaomawang.com/*', // 小码王
];

// 生产 @match 固定为 ccw.site 全站（用户指定头部模板只含这一条）；
// 调试构建：VAIMOD_DEBUG_BUILD=1 → 不混淆不压缩，出错堆栈可读（产物走 --outDir 分开放）
const debugBuild = process.env.VAIMOD_DEBUG_BUILD === '1';

// 本地虚拟测试宿主（假 vm 页面）**只在调试构建里挂**：
// 生产产物绝不能带 127.0.0.1 / localhost —— 那会让脚本在用户本机 8765 端口
// 的任意页面上注入运行（该端口常被其它开发工具占用），既干扰别人也可能被本地页面利用。
if (debugBuild) {
  match.push('http://127.0.0.1:8765/*', 'http://localhost:8765/*');
} else {
  // 非调试构建：只保留 ccw.site（模板逐字对齐）
  match.length = 0;
  match.push('https://www.ccw.site/*');
}

// 更新源：默认指向 GitHub Pages（发布产物的正确归宿；CI 也注入同名变量）。
// 需要指向本地安装服务（scripts/serve.mjs）时用 GITHUB_PAGES_URL=http://127.0.0.1:8899/ 覆盖。
// 注意：Tampermonkey 只在 @version 递增时才应用更新，版本固定时需手动重装。
const updateBase = process.env.GITHUB_PAGES_URL ?? 'https://VaIMod.github.io/VaIMod/';
const updateMeta = {
  downloadURL: `${updateBase}VaIMod.user.js`,
  updateURL: `${updateBase}VaIMod.user.js`,
};

// 产物头部逐字固化：无论 vite-plugin-monkey 生成什么元信息顺序，
// 最终都以这份模板为准（版本号用 SCRIPT_VERSION / 回退 0.1.0）。
// 调试构建额外保留 127.0.0.1:8765 / localhost:8765 两条 @match（本地探针宿主）。
function exactUserscriptHeader() {
  return {
    name: 'exact-userscript-header',
    apply: 'build' as const,
    enforce: 'post' as const,
    generateBundle(
      _options: unknown,
      bundle: Record<string, { type: string; fileName: string; code?: string }>,
    ) {
      const version = process.env.SCRIPT_VERSION ?? '0.1.0';
      for (const file of Object.values(bundle)) {
        if (!file || file.type !== 'chunk' || !file.fileName.endsWith('.js')) continue;
        if (typeof file.code !== 'string' || !file.code.includes('==UserScript==')) continue;
        const m = file.code.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==[ \t]*\r?\n/);
        if (!m) continue;
        const lines = [
          '// ==UserScript==',
          '// @name         VaIMod',
          '// @namespace    VaIMod',
          `// @version      ${version}`,
          '// @author       Maxkore@GitHub',
          '// @description  CCW-VaIMod',
          `// @downloadURL  ${updateBase}VaIMod.user.js`,
          `// @updateURL    ${updateBase}VaIMod.user.js`,
          '// @match        https://www.ccw.site/*',
        ];
        if (debugBuild) {
          lines.push('// @match        http://127.0.0.1:8765/*');
          lines.push('// @match        http://localhost:8765/*');
        }
        lines.push('// @grant        none', '// @run-at       document-start', '// ==/UserScript==', '');
        file.code = lines.join('\n') + file.code.slice(m[0].length);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    svelte(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'VaIMod',
        namespace: 'VaIMod',
        description: 'CCW-VaIMod',
        // CI 注入 SCRIPT_VERSION=0.1.<run_number>（每次构建 +1）。必须在这里消费它：
        // Tampermonkey 只在 @version 变大时才自动更新，若写死成常量，
        // 自动构建出来的新版本永远推不到已安装的用户手上（自动更新形同虚设）。
        version: process.env.SCRIPT_VERSION ?? '0.1.0',
        author: 'Maxkore@GitHub',
        match,
        grant: 'none',
        'run-at': 'document-start',
        ...updateMeta,
      },
      build: {
        fileName: 'VaIMod.user.js',
      },
    }),
    ...(debugBuild ? [] : [obfuscateUserscript()]), // 混淆代码，调试构建跳过
    exactUserscriptHeader(), // 头部逐字固化（必须最后跑，覆盖 monkey 生成与混淆保留的头）
  ],
  build: {
    minify: debugBuild ? false : 'esbuild',
    target: 'es2020',
    sourcemap: debugBuild,
  },
});
