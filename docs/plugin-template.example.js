// VaIMod 插件模板 · 可直接上传安装（设置 → 插件 → 上传插件 JS）
// 覆盖：html / css / code / 三种 settings / 私有存储 / 变量订阅 / 清理函数
// 复制本文件，改掉 id 就是你自己的插件。
VaIMod.plugin({
  type: 'ext', // 插件类型（开头声明）：'ext'=扩展（带标签页）| 'patch'=安全补丁（无界面）
  id: 'my-tool',
  name: '我的工具',
  version: '1.0.0',
  author: '你的名字',
  desc: '模板示例：变量统计 + 私有存储 + 设置项 + 清理函数',

  // 内容区样式：自动加 #vmp-my-tool 前缀，只影响本插件
  css: `
    .wrap { display: flex; flex-direction: column; gap: 8px; }
    .row  { display: flex; justify-content: space-between; align-items: center;
            padding: 7px 10px; background: rgba(255,255,255,.06); border-radius: 8px; }
    .val  { font-weight: 700; color: var(--svp-primary, #4da3ff); }
    .btn  { padding: 8px 0; border: none; border-radius: 8px; cursor: pointer;
            background: var(--svp-primary, #4da3ff); color: #fff; font-weight: 600; }
  `,

  // 内容区结构：先注入，后执行 code
  html: `
    <div class="wrap">
      <div class="row"><span>变量数（按设置过滤）</span><span class="val" data-n>0</span></div>
      <div class="row"><span>点击计数（重开面板不丢）</span><span class="val" data-c>0</span></div>
      <button class="btn" data-go>点我 +1</button>
    </div>
  `,

  // 设置页功能项（改动后本页自动重建、code 重跑）
  settings: [
    { type: 'toggle', key: 'live',  label: '实时刷新变量数', def: true },
    { type: 'select', key: 'cloud', label: '变量范围', def: 'all',
      options: [
        { value: 'all',   label: '全部' },
        { value: 'local', label: '仅本地变量' },
        { value: 'cloud', label: '仅云变量' },
      ] },
    { type: 'number', key: 'min', label: '变量名最少字数', def: 0, desc: '0 = 不过滤' },
  ],

  // 功能代码：ctx = { root, store, settings, onSettings, variables, onVariables, toast, id, extra }
  code(ctx) {
    const nEl = ctx.root.querySelector('[data-n]');
    const cEl = ctx.root.querySelector('[data-c]');
    const btn = ctx.root.querySelector('[data-go]');

    // 私有存储（localStorage 命名空间隔离，自动 JSON 序列化）
    let count = ctx.store.get('count', 0);
    cEl.textContent = String(count);
    btn.onclick = () => {
      count++;
      ctx.store.set('count', count);
      cEl.textContent = String(count);
    };

    // 变量快照 + 按设置过滤
    function match(v) {
      if (ctx.settings.cloud === 'local' && v.isCloud) return false;
      if (ctx.settings.cloud === 'cloud' && !v.isCloud) return false;
      return String(v.name).length >= Number(ctx.settings.min || 0);
    }
    function refresh() {
      nEl.textContent = String(ctx.variables().filter(match).length);
    }
    refresh();

    // 实时刷新：onVariables 返回取消订阅函数
    let unsub;
    if (ctx.settings.live) unsub = ctx.onVariables(refresh);

    // ctx.ui 样式接口：不想手写 css 时，用内置组件拼出与面板同质感的界面
    ctx.root.append(
      ctx.ui.tip('提示条：这个插件正在用 ctx.ui 内置组件', 'info'),
      ctx.ui.check({ text: '复选框示例', checked: true, onchange: (on) => ctx.toast(`勾选=${on}`) }),
    );

    // ⚠️ 必须返回清理函数：切页 / 改设置 / 升级都会重建本页，
    // 不清理的订阅和事件会在每次重建时泄漏一份
    return () => {
      if (unsub) unsub();
      btn.onclick = null;
    };
  },
});
