// VaIMod 本地安装服务：在 8899 端口实时下发 dist/ 的构建产物（无缓存，读盘即最新）。
// 用法：node scripts/serve.mjs   （保持窗口开着；Tampermonkey 访问 http://127.0.0.1:8899/VaIMod.user.js 安装/重装）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const PORT = Number(process.env.PORT || 8899);

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    // 旧文件名兼容：更名前安装的脚本仍请求旧品牌文件名（或小写），改发新产物。
    // ⛔ LEGACY_NAMES 是**兼容字面量**，不要跟着品牌改名。
    const LEGACY_NAMES = ['/ValMod.user.js', '/valmod.user.js'];
    const rel = url === '/' ? '/VaIMod.user.js' : LEGACY_NAMES.includes(url) ? '/VaIMod.user.js' : url;
    const file = join(DIST, rel.replace(/^\/+/, ''));
    // 防目录穿越
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found（先 npm run build 生成 dist）');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[vaimod-serve] http://127.0.0.1:${PORT}/VaIMod.user.js  ← 实时读 dist/，无缓存`);
});
