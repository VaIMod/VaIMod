// 临时调试构建：不混淆、不压缩，输出到 dist-debug/，仅用于定位运行时崩溃
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [
    svelte(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'VaIModDebug',
        namespace: 'VaIModDebug',
        description: 'debug',
        version: '0.0.0',
        match: ['https://www.ccw.site/*'],
        grant: 'none',
        'run-at': 'document-start',
      },
      build: {
        fileName: 'VaIMod.debug.user.js',
      },
    }),
  ],
  build: {
    minify: false,
    target: 'es2020',
    outDir: 'dist-debug',
    sourcemap: false,
  },
});
