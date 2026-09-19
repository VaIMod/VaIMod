<script lang="ts">
  // ===== 设置页 · 插件管理 =====
  // 能力：上传安装（.js / 多选）、查看列表、启停、卸载、导出单个插件、
  //       下载全部插件包、以及每个插件的设置项（settingsCss + settings）。
  import { pluginRegistry, clearPluginStore, tamperedPluginIds } from '../core/plugin-registry';
  import {
    serializePluginDef,
    parsePluginSource,
    type InstalledPlugin,
    type PluginSettingDef,
  } from '../core/plugins';
  import { buildPluginsOnlyBundle } from '../core/bundle';
  import { fly } from 'svelte/transition';

  let { onChanged }: { onChanged?: () => void } = $props();

  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2800);
  }

  let ver = $state(0);
  const plugins = $derived.by(() => {
    void ver;
    // 逐条浅拷贝：registry 返回的是被原地改写的同一对象引用（启停只翻 p.enabled），
    // Svelte 5 keyed each 对「同 key + 同引用」的行不重跑模板表达式（普通属性读
    // 不建立响应式依赖）——卡片开关就会出现「点了没反应、状态早已改变」的假死。
    // 拷贝后引用变化，行内所有 class:/aria/文本表达式随 ver 重新求值。
    return pluginRegistry.list().map((p) => ({ ...p }));
  });
  // 类型过滤：全部 / 补丁 / 扩展（分段选择器）
  let typeFilter = $state<'all' | 'patch' | 'ext'>('all');
  const shownPlugins = $derived(
    typeFilter === 'all' ? plugins : plugins.filter((p) => p.def.type === typeFilter),
  );
  const patchCount = $derived(plugins.filter((p) => p.def.type === 'patch').length);
  const extCount = $derived(plugins.length - patchCount);
  // 完整性校验未通过（源码与存储指纹不符）的条目：已拒绝加载，顶部给出可见提示
  const tampered = $derived.by(() => {
    void plugins;
    return tamperedPluginIds();
  });
  const bump = () => {
    ver = ver + 1;
    onChanged?.();
  };
  // registry 自身变化（安装/卸载）也要刷新；$effect 包裹保证销毁时自动退订
  $effect(() => pluginRegistry.subscribe(() => (ver = ver + 1)));

  let fileInputEl: HTMLInputElement | undefined = $state();
  let expanded = $state<Set<string>>(new Set());

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  async function onFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) return;
    let installed = 0;
    let skipped = 0;
    let upgraded = 0;
    let patches = 0;
    const fails: string[] = [];
    for (const f of files) {
      try {
        const src = await f.text();
        // 先解析拿类型：补丁参与 VaIMod 内部管道（更高信任面），安装前明确确认
        const def = parsePluginSource(src);
        if (def.type === 'patch') {
          const ok = confirm(
            `「${def.name}」是安全补丁（type: 'patch'）。\n\n` +
              '补丁会参与 VaIMod 内部管道（如变量写回拦截），请确认来源可信。\n继续安装？',
          );
          if (!ok) {
            skipped++;
            continue;
          }
          patches++;
        }
        const r = pluginRegistry.install(src);
        if (r === 'installed') installed++;
        else if (r === 'skipped') skipped++;
        else upgraded++;
      } catch (err) {
        fails.push(`${f.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    bump();
    const parts: string[] = [];
    if (installed) parts.push(`新装 ${installed}`);
    if (upgraded) parts.push(`升级 ${upgraded}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (patches) parts.push(`其中补丁 ${patches}`);
    if (fails.length > 0) {
      showToast(`安装失败：${fails[0]}`, 'err');
      return;
    }
    showToast(parts.length > 0 ? `插件已处理 · ${parts.join(' · ')}` : '未发现可安装的插件', parts.length > 0 ? 'ok' : 'err');
  }

  function uninstall(p: InstalledPlugin) {
    if (!confirm(`确定卸载插件「${p.def.name}」？\n（该插件的设置与私有数据一并清除）`)) return;
    clearPluginStore(p.def.id);
    pluginRegistry.uninstall(p.def.id);
    bump();
    showToast(`已卸载「${p.def.name}」`, 'ok');
  }

  function setEnabled(p: InstalledPlugin, enabled: boolean) {
    pluginRegistry.setEnabled(p.def.id, enabled);
    bump();
  }

  /** 游离锚点下载：a 节点从不 append 进页面 DOM（stealth，页面扫描器看不到） */
  function detachedDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadOne(p: InstalledPlugin) {
    const src = serializePluginDef(p.def);
    const blob = new Blob([src], { type: 'text/javascript;charset=utf-8' });
    detachedDownload(blob, `${p.def.id}.plugin.js`);
    showToast(`已导出「${p.def.name}」`, 'ok');
  }

  /** 批量导出：全部插件打包成一个「仅插件」配置包 JSON，导入配置即可整包装回 */
  function downloadAll() {
    if (plugins.length === 0) return;
    const bundle = buildPluginsOnlyBundle();
    const body = JSON.stringify(bundle, null, 2);
    const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
    detachedDownload(blob, `VaIMod-plugins-${Date.now()}.json`);
    showToast(`已导出全部插件 · ${plugins.length} 个（导入配置即可装回）`, 'ok');
  }

  // ---------- 设置项 ----------
  function settingsOf(id: string): Record<string, unknown> {
    void ver;
    return pluginRegistry.settingsOf(id);
  }

  function setSetting(id: string, key: string, value: unknown) {
    pluginRegistry.setSetting(id, key, value);
    bump();
  }

  function resetPluginSettings(p: InstalledPlugin) {
    pluginRegistry.resetSettings(p.def.id);
    bump();
    showToast(`「${p.def.name}」设置已恢复默认`, 'ok');
  }

  function settingValue(p: InstalledPlugin, s: PluginSettingDef): unknown {
    return settingsOf(p.def.id)[s.key];
  }

  /** 文本 / 数字设置项输入处理 */
  function onSettingInput(p: InstalledPlugin, s: PluginSettingDef, e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    setSetting(p.def.id, s.key, s.type === 'number' ? Number(raw) : raw);
  }

  /** 下拉设置项变更处理 */
  function onSettingSelect(p: InstalledPlugin, s: PluginSettingDef, e: Event) {
    setSetting(p.def.id, s.key, (e.currentTarget as HTMLSelectElement).value);
  }
</script>

<div class="svp-plug">
  {#if toast}
    <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>{toast.text}</div>
  {/if}

  <div class="svp-plug-bar">
    <button class="svp-btn svp-btn-sm" onclick={() => fileInputEl?.click()}>上传插件 JS</button>
    {#if plugins.length > 0}
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={downloadAll}>导出全部</button>
    {/if}
    <input
      bind:this={fileInputEl}
      class="svp-file-input"
      type="file"
      accept=".js,text/javascript,application/javascript"
      multiple
      tabindex="-1"
      onchange={onFiles}
    />
    <span class="svp-plug-count">已安装 {plugins.length}</span>
  </div>

  {#if tampered.length > 0}
    <div class="svp-plug-warn">
      检测到 {tampered.length} 个插件记录被外部改写或损坏，已拒绝加载；重新上传该插件即可修复
    </div>
  {/if}

  {#if plugins.length > 0 && patchCount > 0 && extCount > 0}
    <div class="svp-seg svp-plug-filter" role="tablist" aria-label="按类型筛选插件">
      <button
        class="svp-seg-btn"
        class:svp-seg-on={typeFilter === 'all'}
        onclick={() => (typeFilter = 'all')}
      >全部 {plugins.length}</button>
      <button
        class="svp-seg-btn"
        class:svp-seg-on={typeFilter === 'patch'}
        onclick={() => (typeFilter = 'patch')}
      >补丁 {patchCount}</button>
      <button
        class="svp-seg-btn"
        class:svp-seg-on={typeFilter === 'ext'}
        onclick={() => (typeFilter = 'ext')}
      >扩展 {extCount}</button>
    </div>
  {/if}

  {#if plugins.length === 0}
    <p class="svp-empty">还没有安装任何插件。</p>
  {:else if shownPlugins.length === 0}
    <p class="svp-empty">该类型下没有插件。</p>
  {:else}
    <div class="svp-cardlist">
      {#each shownPlugins as p (p.def.id)}
        {@const hasSettings = p.def.settings.length > 0}
        <div
          class="svp-card svp-plug-card"
          class:svp-plug-card-patch={p.def.type === 'patch'}
          class:svp-plug-off={!p.enabled}
        >
          <div class="svp-card-top">
            <strong class="svp-plug-name">{p.def.name}</strong>
            {#if p.def.type === 'patch'}
              <span class="svp-plug-badge svp-plug-badge-patch">补丁</span>
            {:else}
              <span class="svp-plug-badge">扩展</span>
            {/if}
            <span class="svp-meta">v{p.def.version}{p.def.author ? ` · ${p.def.author}` : ''}</span>
          </div>
          {#if p.def.type === 'patch'}
            <div class="svp-plug-id">安全补丁 · 管道优先级 {p.def.priority} · 无标签页</div>
          {/if}
          {#if p.def.desc}
            <div class="svp-plug-desc">{p.def.desc}</div>
          {/if}
          <div class="svp-plug-id">id: {p.def.id}</div>
          <div class="svp-btnrow">
            <button
              class="svp-toggle svp-plug-toggle"
              class:svp-toggle-on={p.enabled}
              onclick={() => setEnabled(p, !p.enabled)}
              role="switch"
              aria-checked={p.enabled}
              aria-label={p.enabled ? '停用插件' : '启用插件'}
            >
              <span class="svp-toggle-dot"></span>
            </button>
            {#if hasSettings}
              <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => toggleExpand(p.def.id)}>
                {expanded.has(p.def.id) ? '收起设置' : `设置（${p.def.settings.length}）`}
              </button>
            {/if}
            <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => downloadOne(p)}>导出</button>
            <button class="svp-btn svp-btn-red-ghost svp-btn-sm" onclick={() => uninstall(p)}>卸载</button>
          </div>

          {#if hasSettings && expanded.has(p.def.id)}
            <div class="svp-plug-settings">
              {#if p.def.settingsCss}
                <div class="svp-plug-css-note">该插件为设置项提供了自定义样式（已生效）</div>
              {/if}
              {#each p.def.settings as s (s.key)}
                <div class="svp-setting-item svp-plug-setitem">
                  <div class="svp-setting-text">
                    <div class="svp-setting-name">{s.label}</div>
                    {#if s.desc}<div class="svp-setting-desc">{s.desc}</div>{/if}
                  </div>
                  {#if s.type === 'toggle'}
                    <button
                      class="svp-toggle"
                      class:svp-toggle-on={settingValue(p, s) === true}
                      onclick={() => setSetting(p.def.id, s.key, settingValue(p, s) !== true)}
                      role="switch"
                      aria-checked={settingValue(p, s) === true}
                      aria-label={s.label}
                    >
                      <span class="svp-toggle-dot"></span>
                    </button>
                  {:else if s.type === 'select'}
                    <select
                      class="svp-input svp-select svp-plug-select"
                      value={String(settingValue(p, s) ?? '')}
                      onchange={(e) => onSettingSelect(p, s, e)}
                    >
                      {#each s.options as opt}
                        <option value={opt.value}>{opt.label}</option>
                      {/each}
                    </select>
                  {:else}
                    <input
                      class="svp-input svp-plug-input"
                      type={s.type === 'number' ? 'number' : 'text'}
                      value={String(settingValue(p, s) ?? '')}
                      placeholder={s.placeholder ?? ''}
                      spellcheck="false"
                      oninput={(e) => onSettingInput(p, s, e)}
                    />
                  {/if}
                </div>
              {/each}
              <div class="svp-btnrow">
                <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => resetPluginSettings(p)}>
                  恢复该插件默认设置
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
