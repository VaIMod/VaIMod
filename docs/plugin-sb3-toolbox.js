// VaIMod 插件 · 作品保存工具箱（盗作神器插件版）v1.1.0
// 与原 userscript 版的差异：
//   - 零页面元素注入：全部 UI 活在 VaIMod 的 stealth Shadow DOM 内，
//     页面级 DOM 扫描器看不到任何 spd-* / 工具栏 / 浮层节点
//   - 不碰 window.vm：导出与捕获全部走 ctx.project（VaIMod 官方能力面，
//     由 bridge 在 VPN 通道内的隔离 vm 上实现；捕获包装非枚举 + toString 拟真）
//   - 不钩 Function.prototype.bind（原版暴露点）：捕获由 VaIMod 桥接层托管
//   - 下载用游离锚点（a 节点从不 append 进 DOM），用后回收 objectURL
//   - 文件内敏感字面量一律 unicode 转义，零 console 输出
// v1.1.0：UI 升级（状态行 / 按钮层级 / 行悬停与入场动效 / 徽章计数）+ refresh 钩子
//   - 面板「刷新」点击时执行 refresh(ctx)：重读角色列表与捕获记录并重渲染（真刷新）
//   - code 与 refresh 是两段独立执行的函数体，渲染逻辑经 ctx.root.__rerender 复用
VaIMod.plugin({
  type: 'ext',
  id: 'sb3-toolbox',
  name: '\u76D7\u4F5C\u795E\u5668', // 盗作神器
  version: '1.1.0',
  author: 'Maxkore',
  desc: '\u4F5C\u54C1\u4FDD\u5B58\u5DE5\u5177\u7BB1\uFF1Asb3 \u5BFC\u51FA / \u89D2\u8272\u6253\u5305 / \u52A0\u8F7D\u6355\u83B7',

  css: `
    .wrap { display: flex; flex-direction: column; gap: 12px; }
    .stat { display: flex; align-items: center; gap: 7px; padding: 0 2px;
            font-size: 11.5px; color: rgba(255,255,255,.45); }
    .stat .dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
                 background: var(--svp-primary, #4da3ff);
                 box-shadow: 0 0 6px var(--svp-primary, #4da3ff); }
    .stat.off .dot { background: rgba(255,255,255,.22); box-shadow: none; }
    .acts { display: flex; gap: 8px; }
    .go { flex: 1; padding: 10px 0; border: none; border-radius: 10px; cursor: pointer;
          background: var(--svp-primary, #4da3ff); color: #fff; font-weight: 600; font-size: 13px;
          transition: scale .15s ease, filter .15s ease; }
    .go:hover { filter: brightness(1.08); scale: 1.02; }
    .go:active { scale: .97; }
    .go.alt { background: rgba(255,255,255,.10); color: #e6e8ea; }
    .go.busy { opacity: .55; pointer-events: none; }
    .sec { display: flex; flex-direction: column; gap: 7px; }
    .sec-title { display: flex; align-items: center; gap: 7px; font-size: 12px;
                 color: rgba(255,255,255,.55); padding: 0 2px; }
    .sec-title em { font-style: normal; font-weight: 700; font-size: 11px; color: #fff;
                    background: rgba(255,255,255,.10); padding: 1px 8px; border-radius: 99px; }
    .sec-title .mini { margin-left: auto; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px;
           padding: 9px 11px; background: rgba(255,255,255,.055); border-radius: 10px;
           transition: background .15s ease;
           animation: pi-in .26s ease both; }
    .row:hover { background: rgba(255,255,255,.095); }
    .row .tag { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    .row .tag.spr { background: var(--svp-primary, #4da3ff); }
    .row .tag.cap { background: #58c776; }
    .row .info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .row .info b { font-size: 13px; color: #e6e8ea; overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; }
    .row .info i { font-style: normal; font-size: 11px; color: rgba(255,255,255,.42); }
    .mini { padding: 5px 12px; border: none; border-radius: 8px; cursor: pointer;
            font-size: 12px; font-weight: 600; color: #fff; background: rgba(255,255,255,.13);
            transition: scale .15s ease, filter .15s ease; }
    .mini:hover { filter: brightness(1.15); scale: 1.04; }
    .mini:active { scale: .94; }
    .mini.busy { opacity: .55; pointer-events: none; }
    .mini.save { background: rgba(77, 163, 255, .85); }
    .mini.clear { background: rgba(244, 67, 54, .75); }
    .empty { padding: 14px 10px; text-align: center; font-size: 12px;
             color: rgba(255,255,255,.35); background: rgba(255,255,255,.03);
             border: 1px dashed rgba(255,255,255,.10); border-radius: 10px; }
    @keyframes pi-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  `,

  html: `
    <div class="wrap">
      <div class="stat" data-stat><span class="dot"></span><span data-stattext></span></div>
      <div class="acts">
        <button class="go" data-save>\u4FDD\u5B58\u5F53\u524D\u4F5C\u54C1</button>
        <button class="go alt" data-zipall>\u5168\u90E8\u89D2\u8272\u6253\u5305</button>
      </div>
      <div class="sec">
        <div class="sec-title"><span>\u89D2\u8272</span><em data-scount>0</em></div>
        <div data-sprites></div>
      </div>
      <div class="sec">
        <div class="sec-title">
          <span>\u6355\u83B7\u7684\u4F5C\u54C1</span><em data-ccount>0</em>
          <button class="mini clear" data-clear aria-label="\u6E05\u7A7A\u5168\u90E8\u6355\u83B7\u8BB0\u5F55">\u6E05\u7A7A</button>
        </div>
        <div data-captured></div>
      </div>
    </div>
  `,

  settings: [
    {
      type: 'toggle',
      key: 'autocapture',
      label: '自动捕获加载的作品',
      desc: '作品通过加载流程进入编辑器时自动记录（纯内存，最多 8 条，关闭即清空）',
      def: true,
    },
    {
      type: 'text',
      key: 'prefix',
      label: '导出文件名前缀',
      desc: '非法字符自动替换为下划线',
      def: 'project',
      placeholder: 'project',
    },
  ],

  async code(ctx) {
    const $ = (sel) => ctx.root.querySelector(sel);
    const esc = (s) =>
      String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');
    const pad = (n) => String(n).padStart(2, '0');
    const fmtTime = (t) => {
      const d = new Date(t);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    };
    const stamp = () => {
      const d = new Date();
      return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    };
    const safeName = (s) =>
      String(s || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 60) || 'project';
    const prefix = () => safeName(ctx.settings.prefix || 'project');

    // 游离锚点下载：a 节点从不入 DOM（不向页面注入任何元素），URL 用后即回收
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    const busy = (btn, on) => {
      if (btn) btn.classList.toggle('busy', !!on);
    };

    // 状态行：自动捕获开/关跟随设置（关=灰点弱化）
    function renderStat() {
      const el = $('[data-stat]');
      if (!el) return;
      const on = ctx.settings.autocapture !== false;
      el.classList.toggle('off', !on);
      const t = $('[data-stattext]');
      if (t) t.textContent = on ? '\u81EA\u52A8\u6355\u83B7\u5DF2\u5F00\u542F' : '\u81EA\u52A8\u6355\u83B7\u5DF2\u5173\u95ED';
    }

    // ---------- 角色列表 ----------
    async function renderSprites() {
      const box = $('[data-sprites]');
      if (!box) return;
      let list = [];
      try {
        list = ctx.project.listSprites();
      } catch {
        list = [];
      }
      const c = $('[data-scount]');
      if (c) c.textContent = String(list.length);
      if (!list.length) {
        box.innerHTML = '<div class="empty">\u6682\u65E0\u53EF\u5BFC\u51FA\u7684\u89D2\u8272\uFF0C\u8FDE\u63A5\u4F5C\u54C1\u540E\u70B9\u9762\u677F\u5237\u65B0\u91CD\u8BFB</div>';
        return;
      }
      box.innerHTML = list
        .map(
          (s, i) =>
            '<div class="row" data-sid="' + esc(s.id) + '" data-sname="' + esc(s.name) + '" style="animation-delay:' + Math.min(i * 30, 240) + 'ms">' +
            '<span class="tag spr"></span>' +
            '<div class="info"><b>' + esc(s.name) + '</b><i>\u9020\u578B ' + s.costumeCount + ' \u00B7 \u58F0\u97F3 ' + s.soundCount + '</i></div>' +
            '<button class="mini save" data-export>\u5BFC\u51FA</button>' +
            '</div>',
        )
        .join('');
    }

    // ---------- 捕获列表 ----------
    function capRow(c, i) {
      return (
        '<div class="row" data-cid="' + c.id + '" data-cname="' + esc(c.name) + '" style="animation-delay:' + Math.min(i * 30, 240) + 'ms">' +
        '<span class="tag cap"></span>' +
        '<div class="info"><b>' + esc(c.name) + '</b><i>' + fmtTime(c.time) + ' \u00B7 ' + fmtSize(c.size) + '</i></div>' +
        '<button class="mini save" data-download>\u4E0B\u8F7D</button>' +
        '</div>'
      );
    }
    function renderCaptured() {
      const box = $('[data-captured]');
      if (!box) return;
      let list = [];
      try {
        list = ctx.project.listCaptured();
      } catch {
        list = [];
      }
      const c = $('[data-ccount]');
      if (c) c.textContent = String(list.length);
      box.innerHTML = list.length
        ? list.map(capRow).join('')
        : '<div class="empty">\u81EA\u52A8\u6355\u83B7\u5DF2\u5F00\u542F\uFF1A\u4F5C\u54C1\u52A0\u8F7D\u65F6\u4F1A\u8BB0\u5F55\u5728\u8FD9\u91CC</div>';
    }

    // 渲染入口：refresh 钩子经 ctx.root.__rerender 复用（code 与 refresh 是两段
    // 独立执行的函数体，闭包不共享；挂在本页根节点上随清理一起摘除）
    function renderAll() {
      renderStat();
      renderSprites();
      renderCaptured();
    }
    ctx.root.__rerender = renderAll;

    // ---------- 事件（委托，重建 DOM 不丢事件） ----------
    const onClick = async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const row = t.closest('.row');
      try {
        if (t.hasAttribute('data-export')) {
          busy(t, true);
          const sid = row.getAttribute('data-sid');
          const sname = safeName(row.getAttribute('data-sname'));
          const blob = await ctx.project.exportSprite(sid);
          download(blob, prefix() + '-' + sname + '.sprite3');
          ctx.toast('\u5DF2\u5BFC\u51FA\u89D2\u8272\uFF1A' + sname);
        } else if (t.hasAttribute('data-download')) {
          busy(t, true);
          const cid = Number(row.getAttribute('data-cid'));
          const cname = row.getAttribute('data-cname') || 'project.sb3';
          const blob = await ctx.project.getCapturedBlob(cid);
          if (!blob) {
            ctx.toast('\u8BE5\u6355\u83B7\u8BB0\u5F55\u5DF2\u5931\u6548', 'err');
            return;
          }
          download(blob, cname);
          ctx.toast('\u5DF2\u4E0B\u8F7D\uFF1A' + cname);
        } else if (t.hasAttribute('data-save')) {
          busy(t, true);
          const blob = await ctx.project.exportSb3();
          download(blob, prefix() + '-' + stamp() + '.sb3');
          ctx.toast('\u4F5C\u54C1\u5DF2\u5BFC\u51FA');
        } else if (t.hasAttribute('data-zipall')) {
          busy(t, true);
          const blob = await ctx.project.exportSpritesZip();
          download(blob, prefix() + '-sprites-' + stamp() + '.zip');
          ctx.toast('\u5168\u90E8\u89D2\u8272\u5DF2\u6253\u5305');
        } else if (t.hasAttribute('data-clear')) {
          const ok = await ctx.ui.confirm({
            title: '\u6E05\u7A7A\u6355\u83B7\u5217\u8868',
            message: '\u786E\u5B9A\u6E05\u7A7A\u6240\u6709\u6355\u83B7\u8BB0\u5F55\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002',
            okText: '\u786E\u5B9A\u6E05\u7A7A',
            danger: true,
          });
          if (ok) {
            ctx.project.clearCaptured();
            renderCaptured();
            ctx.toast('\u5DF2\u6E05\u7A7A');
          }
        }
      } catch (err) {
        ctx.toast('\u64CD\u4F5C\u5931\u8D25\uFF1A' + (err && err.message ? err.message : String(err)), 'err');
      } finally {
        busy(t, false);
      }
    };
    ctx.root.addEventListener('click', onClick);

    // ---------- 自动捕获开关同步 + 新捕获订阅 ----------
    ctx.project.setCapture(ctx.settings.autocapture !== false);
    const unsubCap = ctx.project.onCaptured(() => {
      renderCaptured();
      ctx.toast('\u6355\u83B7\u5230\u65B0\u4F5C\u54C1');
    });
    const unsubSet = ctx.onSettings((v) => {
      ctx.project.setCapture(v.autocapture !== false);
      renderStat();
    });

    renderAll();

    // 清理：切页 / 改设置 / 升级都会重建本页
    return () => {
      unsubCap();
      unsubSet();
      ctx.root.removeEventListener('click', onClick);
      delete ctx.root.__rerender;
    };
  },

  // 面板「刷新」按钮触发（停在盗作神器页时）：真刷新语义——
  // 重读角色列表与捕获记录并重渲染，不重挂载本页（状态与滚动位置都保留）
  refresh(ctx) {
    const rerender = ctx.root.__rerender;
    if (typeof rerender === 'function') rerender();
  },
});
