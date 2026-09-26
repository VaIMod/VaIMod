// VaIMod 插件模板 · 可直接上传安装（设置 → 插件 → 上传插件 JS）
// 覆盖：html / css / code / refresh / 异步加载定义 / 市场元信息 /
//       三种 settings / 私有存储 / 变量订阅 / 清理函数
// 复制本文件，改掉 id 就是你自己的插件。
//
// ---------------------------------------------------------------
// 两种清单写法（可混用，**对象优先**、标签作回退）：
//
//   A. 对象写法（本文件用的）：VaIMod.plugin({ id, name, code, ... })
//      表达力强、有类型提示，适合写 code / css / html。
//
//   B. @标签写法：写在**文件开头的注释区**，扫到第一行真实代码即停止。
//      `//  @id my-tool`
//      `//  @name 我的工具`
//      `//  @async true`
//      `//  @waitVm`
//      `//  @timeout 8000`
//      `//  @market.category 工具`
//      `//  @market.tags 变量,批量`
//      `//  @html`            ← 块值：其后每一行都属于 html，直到下一个 @标签
//      `//    <div>...</div>`
//      布尔开关：裸写（`@async`）即 true，`@async false` 为 false。
//      未识别的标签原样收进 `extra.tags` / `extra.marketTags`，作者可自行扩展。
// ---------------------------------------------------------------
VaIMod.plugin({
  type: 'ext', // 插件类型（开头声明）：'ext'=扩展（带标签页）| 'patch'=安全补丁（无界面）
  id: 'my-tool',
  name: '我的工具',
  version: '1.0.0',
  author: '你的名字',
  desc: '模板示例：变量统计 + 私有存储 + 设置项 + 异步加载 + 清理函数',

  // 异步加载定义（全部可选，缺省 = 保守同步，时序与旧版完全一致）：
  //   code    : code 是异步的（返回 Promise），清理函数在 Promise 落定后才接管
  //   waitVm  : 等 vm 就绪再执行 code。未就绪期间标签页**一直显示真实的
  //             「等待获取vm」**（由桥接状态驱动，不按超时判死）；只有桥接
  //             出错才视为加载失败。避免「只该在有 vm 时工作」的插件带着
  //             空数据产生副作用。
  //   aspect  : 与 waitVm 搭配声明依赖的数据方面：'vars'=作品变量、
  //             'cloud'=云数据。vm 就绪后该方面为空 → 标签页显示真实
  //             「没有」空态（没有变量 / 没有云数据），数据出现才真正加载。
  //   load    : 预加载钩子，在 code 之前执行，可 async；用于按需拉远程资源 /
  //             初始化大依赖。抛错同样按失败处理（code 可能依赖它）。
  //   timeout : 历史兼容字段，对 waitVm 已无影响（等待不再超时）。
  //   lazy    : 懒加载。扩展默认 true（打开标签页才执行 code）；写 false =
  //             **常驻**，不打开标签页也跑（无界面实例，零面板 DOM）。
  //             补丁（type:'patch'）强制 false —— 补丁本就是 headless 常驻。
  async: {
    waitVm: true,
    aspect: 'vars',
    // load: `await new Promise(r => setTimeout(r, 50));`, // 预加载钩子示例
  },

  // 市场元信息（供插件市场/列表页消费，全部可选）：
  //   category 上架分类 | tags 检索关键词 | icon emoji 或图片 URL
  //   homepage 主页 | license 许可证 | minApp 最低本体版本
  //   changelog 更新说明 | screenshots 截图/示例链接
  market: {
    category: '工具',
    tags: ['变量', '统计', '模板'],
    icon: '🧰',
    license: 'MIT',
  },

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

  // 刷新钩子（可选）：用户点面板「刷新」且停在本插件页时执行，与 code 同一个 ctx。
  // 只做「数据重取 / 重渲染」；**不要**在这里重新订阅（onVariables/onSettings）——
  // 那会造成重复订阅。变量快照读取（ctx.variables()）在 refresh 里是实时的。
  refresh(ctx) {
    const nEl = ctx.root.querySelector('[data-n]');
    if (nEl) nEl.textContent = String(ctx.variables().length);
  },

  // 功能代码：ctx = { root, store, settings, onSettings, variables, onVariables, toast, id, extra }
  code(ctx) {
    // headless（async.lazy === false 的常驻实例）下 root 是游离节点、也不注入 html：
    // 仍然可查询/操作，但不会显示在界面上 —— 这类插件应只做「后台」工作
    // （写变量、监听、toast），不要依赖 root 里的元素可见或可测量。
    const nEl = ctx.root.querySelector('[data-n]');
    const cEl = ctx.root.querySelector('[data-c]');
    const btn = ctx.root.querySelector('[data-go]');
    if (!nEl || !cEl || !btn) {
      // 没有界面：本示例的界面部分整体跳过（真实插件在这里做后台逻辑）
      return () => {};
    }

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
