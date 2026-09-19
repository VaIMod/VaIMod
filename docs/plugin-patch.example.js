// VaIMod 安全补丁模板 · 可直接上传安装（设置 → 插件 → 上传插件 JS）
// 类型：patch（安全补丁）—— 无界面、headless 运行，参与 VaIMod 内部管道。
// 本示例实现「云变量写保护」：所有云变量的写回会被拦截，可在设置里放行或改为只读提示。
// 复制本文件，改掉 id 就是你自己的补丁。
VaIMod.plugin({
  type: 'patch', // 插件类型（开头声明）：'patch'=安全补丁 | 'ext'=扩展（带标签页）
  id: 'cloud-write-guard',
  name: '云变量写保护',
  version: '1.0.0',
  author: '你的名字',
  desc: '拦截面板内对云变量的写回操作，防止误改云端数据。可在设置里切换拦截/放行。',
  priority: 100, // 管道优先级：越小越先过链（0–10000，默认 100）

  // 补丁可以有设置项（设置页里配置），但没有标签页 UI（html/css 不会渲染）
  settings: [
    { type: 'toggle', key: 'block', label: '拦截云变量写入', desc: '关闭后放行所有写入（补丁仍参与管道）', def: true },
    { type: 'toggle', key: 'allowLists', label: '列表放行', desc: '开启后只拦截标量变量，列表照常写入', def: false },
  ],

  // 补丁代码：ctx.patch.hooks.add 注册管道钩子（当前可用：'variable:write'）
  // 钩子返回值语义：
  //   return false      → 拒绝本次写回
  //   return undefined  → 放行，值不变
  //   return 其它值     → 用返回值替换，继续过后续补丁的钩子
  // 钩子抛错会自动熔断（连续 3 次错误禁用），不会拖垮写回链路。
  code(ctx) {
    const p = ctx.patch;
    if (!p) return; // 类型不是 patch 时没有 patch 能力面（正常运行不会走到）

    p.hooks.add('variable:write', (value, meta) => {
      const block = ctx.settings.block !== false;
      const allowLists = ctx.settings.allowLists === true;
      if (!block) return undefined;      // 设置里放行 → 不拦截
      if (allowLists && meta.kind === 'list') return undefined;
      if (!meta.isCloud) return undefined; // 只管云变量，本地变量放行
      ctx.toast(`已拦截对云变量「${meta.name}」的写入`, 'err');
      return false; // 拒绝写回
    });

    // 清理函数（可选）：补丁被卸载/禁用/升级时自动调用
    return () => {
      // 钩子随补丁生命周期自动注销，这里通常不需要额外清理
    };
  },
});
