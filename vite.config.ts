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
  // 本地虚拟测试宿主（假 vm 页面，仅开发用；普通用户页面无 window.vm 时脚本自动待机）
  'http://127.0.0.1:8765/*',
  'http://localhost:8765/*',
];

const pagesUrl = process.env.GITHUB_PAGES_URL;
// 更新源：部署了 GitHub Pages 用线上地址；否则回落本地安装服务（scripts/serve.mjs）。
// 注意：Tampermonkey 只在 @version 递增时才应用更新，版本固定时需手动重装。
const updateBase = pagesUrl ?? 'http://127.0.0.1:8899/';
const updateMeta = {
  downloadURL: `${updateBase}VaIMod.user.js`,
  updateURL: `${updateBase}VaIMod.user.js`,
};

// 调试构建：VAIMOD_DEBUG_BUILD=1 → 不混淆不压缩，出错堆栈可读（产物走 --outDir 分开放）
const debugBuild = process.env.VAIMOD_DEBUG_BUILD === '1';

export default defineConfig({
  plugins: [
    svelte(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'VaIMod',
        namespace: 'VaIMod',
        description: 'Scratch变量修改器',
        version: '0.1.0',
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
  ],
  build: {
    minify: debugBuild ? false : 'esbuild',
    target: 'es2020',
    sourcemap: debugBuild,
  },
});
