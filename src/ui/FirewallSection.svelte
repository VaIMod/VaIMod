<script lang="ts">
  // 网络防火墙设置分区（**独立补丁**，不是内置 Tab）：
  // 默认关闭 —— 关闭态下 core/net-firewall.ts 不安装任何网络钩子，零开销、零行为变化。
  // 本组件只做配置与展示；判定与钩子本体在 document-start 装好。
  import {
    subscribeFirewall,
    firewallHits,
    firewallStats,
    firewallRules,
    firewallClearLog,
    firewallMode,
    firewallBlockExfil,
    setFirewallMode,
    setFirewallBlockExfil,
    addFirewallRule,
    removeFirewallRule,
    clearFirewallRules,
    exportFirewallRules,
    importFirewallRules,
    type FirewallHit,
    type FwVerdict,
  } from '../core/net-firewall';
  import type { FirewallMode } from '../core/settings';

  const FW_MODES: { value: FirewallMode; label: string }[] = [
    { value: 'off', label: '关闭' },
    { value: 'watch', label: '监视' },
    { value: 'enforce', label: '拦截' },
  ];

  const FW_HINT: Record<FirewallMode, string> = {
    off: '不安装任何网络钩子，零开销。',
    watch: '记录发往站外的请求，一律放行。',
    enforce: '命中黑名单的请求会被拒绝。',
  };

  const VERDICT_LABEL: Record<FwVerdict, string> = {
    block: '黑名单',
    exfil: '疑似外传',
    allow: '白名单',
    third: '第三方',
  };

  const KIND_LABEL: Record<FirewallHit['kind'], string> = {
    fetch: 'FETCH',
    xhr: 'XHR',
    beacon: '信标',
    ws: 'WS',
  };

  /** 设置页里最多列这么多条日志：它是审计视图，不是全量导出工具 */
  const LOG_SHOWN = 20;

  let tick = $state(0);
  let mode = $state<FirewallMode>(firewallMode());
  let blockExfil = $state(firewallBlockExfil());
  let newHost = $state('');
  let msg = $state('');
  let msgErr = $state(false);
  let fileEl: HTMLInputElement | undefined = $state();

  $effect(() => subscribeFirewall(() => (tick = tick + 1)));

  const hits = $derived.by(() => {
    void tick;
    return firewallHits();
  });
  const shownHits = $derived(hits.slice(0, LOG_SHOWN));
  const stats = $derived.by(() => {
    void tick;
    return firewallStats();
  });
  const rules = $derived.by(() => {
    void tick;
    return firewallRules();
  });
  const ruleCount = $derived(rules.block.length + rules.allow.length);

  function say(text: string, err = false) {
    msg = text;
    msgErr = err;
  }

  function pickMode(m: FirewallMode) {
    setFirewallMode(m);
    mode = m;
    say('');
  }

  function toggleExfil() {
    const next = !blockExfil;
    setFirewallBlockExfil(next);
    blockExfil = next;
  }

  function addRule(kind: 'block' | 'allow') {
    const h = newHost.trim();
    if (!h) return;
    if (addFirewallRule(h, kind)) {
      say(`已${kind === 'block' ? '加入黑名单' : '加入白名单'}：${h}`);
      newHost = '';
    } else {
      say('域名格式不合法（可写 example.com 或 *.example.com）', true);
    }
  }

  function addFromHit(host: string, kind: 'block' | 'allow') {
    if (addFirewallRule(host, kind)) say(`已${kind === 'block' ? '拉黑' : '放行'}：${host}`);
  }

  function onExport() {
    const blob = new Blob([exportFirewallRules()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaimod-firewall-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    say('规则已导出为 JSON');
  }

  async function onImport(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const r = importFirewallRules(await file.text());
      say(`已导入：黑名单 ${r.block} 条、白名单 ${r.allow} 条`);
    } catch (e) {
      say(e instanceof Error ? e.message : '导入失败', true);
    }
  }

  function hhmmss(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(2)} MB`;
  }

  /** 键盘事件不外泄到页面（否则和站点快捷键互相打架）——与飞书面板同源实现 */
  function keyboardGuard(node: HTMLInputElement) {
    const host = (node.getRootNode() as ShadowRoot).host;
    const onKeydownCapture = (e: KeyboardEvent) => {
      if (!host || !e.composedPath().includes(host)) return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeydownCapture, true);
    return {
      destroy() {
        window.removeEventListener('keydown', onKeydownCapture, true);
      },
    };
  }
</script>

<div class="svp-fw">
  <div class="svp-seg">
    {#each FW_MODES as m}
      <button
        class="svp-seg-btn"
        class:svp-seg-active={mode === m.value}
        onclick={() => pickMode(m.value)}
      >
        {m.label}
      </button>
    {/each}
  </div>
  <p class="svp-note">{FW_HINT[mode]}</p>

  {#if mode === 'enforce'}
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">拦截数据外传</div>
        <div class="svp-setting-desc">拒绝疑似把变量/存档发往站外的请求（按体积与字段特征判定）</div>
      </div>
      <button
        class="svp-toggle"
        class:svp-toggle-on={blockExfil}
        onclick={toggleExfil}
        role="switch"
        aria-checked={blockExfil}
        aria-label="拦截数据外传"
      >
        <span class="svp-toggle-dot"></span>
      </button>
    </div>
  {/if}

  <div class="svp-meta">
    观察 {stats.hosts} 个站外域名 · 请求 {stats.hits} 次 · 已拦截 {stats.blocked} 次 · 规则 {stats.blockRules} 黑 / {stats.allowRules} 白
  </div>

  <div class="svp-field svp-row2">
    <input
      class="svp-input"
      type="text"
      bind:value={newHost}
      placeholder="example.com 或 *.example.com"
      spellcheck="false"
      use:keyboardGuard
      onkeydown={(e) => e.key === 'Enter' && addRule('block')}
    />
    <button class="svp-btn svp-btn-sm" onclick={() => addRule('block')} disabled={!newHost.trim()}>
      加黑名单
    </button>
    <button
      class="svp-btn svp-btn-ghost svp-btn-sm"
      onclick={() => addRule('allow')}
      disabled={!newHost.trim()}
    >
      加白名单
    </button>
  </div>

  {#if ruleCount > 0}
    <div class="svp-fs-rules">
      {#each rules.block as h (h)}
        <div class="svp-fs-rule">
          <span class="svp-fw-tag svp-fw-tag-block">黑名单</span>
          <span class="svp-fs-bot">{h}</span>
          <button class="svp-robot-del" onclick={() => removeFirewallRule(h, 'block')} aria-label="移除规则">×</button>
        </div>
      {/each}
      {#each rules.allow as h (h)}
        <div class="svp-fs-rule">
          <span class="svp-fw-tag svp-fw-tag-allow">白名单</span>
          <span class="svp-fs-bot">{h}</span>
          <button class="svp-robot-del" onclick={() => removeFirewallRule(h, 'allow')} aria-label="移除规则">×</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="svp-btnrow svp-btnrow-wrap">
    <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => fileEl?.click()}>导入规则</button>
    <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={onExport} disabled={ruleCount === 0}>
      导出规则
    </button>
    <button
      class="svp-btn svp-btn-red-ghost svp-btn-sm"
      onclick={() => {
        clearFirewallRules();
        say('已清空全部域名规则');
      }}
      disabled={ruleCount === 0}
    >
      清空规则
    </button>
    <input
      bind:this={fileEl}
      class="svp-file-input"
      type="file"
      accept=".json,application/json"
      tabindex="-1"
      onchange={onImport}
    />
  </div>
  {#if msg}
    <div class="svp-alias-msg" class:svp-alias-msg-err={msgErr}>{msg}</div>
  {/if}

  {#if mode !== 'off'}
    <div class="svp-setting-name">
      出网日志
      {#if hits.length > 0}<span class="svp-fs-badge">{hits.length}</span>{/if}
    </div>
    {#if hits.length === 0}
      <p class="svp-empty">暂无站外请求（站点自身与同族域名不进日志）</p>
    {:else}
      <div class="svp-fs-log">
        {#each shownHits as h (h.id)}
          <div class="svp-fs-item" class:svp-fw-item-blocked={h.blocked}>
            <div class="svp-fs-head">
              <span class="svp-fw-tag svp-fw-tag-{h.verdict}">{VERDICT_LABEL[h.verdict]}</span>
              <span class="svp-fs-bot svp-fw-host">{h.host}</span>
              <span class="svp-fs-state">{KIND_LABEL[h.kind]} · {h.count} 次</span>
            </div>
            <div class="svp-meta svp-fw-path">
              {h.method} {h.url}{#if h.bytes > 0} · {fmtBytes(h.bytes)}{/if}{#if h.blocked} · 已拦截{/if} · {hhmmss(h.lastAt)}
            </div>
            {#if h.note}
              <div class="svp-tag-red">{h.note}</div>
            {/if}
            <div class="svp-btnrow svp-btnrow-wrap">
              <button class="svp-btn svp-btn-sm" onclick={() => addFromHit(h.host, 'block')}>拉黑</button>
              <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => addFromHit(h.host, 'allow')}>放行</button>
            </div>
          </div>
        {/each}
      </div>
      {#if hits.length > shownHits.length}
        <div class="svp-meta">仅显示最近 {shownHits.length} 条，共 {hits.length} 个域名</div>
      {/if}
      <div class="svp-btnrow svp-btnrow-wrap">
        <button class="svp-btn svp-btn-red-ghost svp-btn-sm" onclick={() => firewallClearLog()}>
          清空日志
        </button>
      </div>
    {/if}
  {/if}
</div>
