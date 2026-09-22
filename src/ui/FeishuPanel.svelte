<script lang="ts">
  // ===== 飞书：机器人管理 + 消息发送 + 消息请求拦截 =====
  // 通道为飞书群自定义机器人 webhook 直发（不触碰开放平台凭证）：
  // - 机器人来源两路：扫描变量与列表内容（含云变量）/ 手动添加；可自定义名称；
  // - 发送：文本、@全员、@指定成员、图片（已有 image_key）、交互卡片 JSON、捷径/透传 JSON；
  // - 图片与任意文件：先上传拿直链（ccw OSS → catbox → 0x0.st 降级），再以「卡片链接」发出；
  // - 消息请求拦截：拦下页面/作品发往飞书 webhook 的请求，在本面板内裁决放行或拒绝。
  import type { ScratchVaIMod } from '../core';
  import { cleanDisplay } from '../core';
  import {
    buildLinkCard,
    ingestTokens,
    maskToken,
    normalizeRobot,
    robotAdd,
    robotList,
    robotPin,
    robotRemove,
    sendAt,
    sendAtAll,
    sendCard,
    sendImage,
    sendRawJson,
    sendText,
    uploadToLink,
    type FeishuRobot,
    type SendResult,
  } from '../core/feishu';
  import { extractTokens } from '../core/feishu';
  import {
    clearFeishuLog,
    feishuHits,
    feishuMode,
    feishuPendingCount,
    feishuRules,
    resolveAllFeishu,
    resolveFeishu,
    setFeishuRule,
    setFeishuMode,
    subscribeFeishu,
    type FeishuHit,
  } from '../core/feishu-guard';
  import { loadSettings, saveSettings, type FeishuInterceptMode } from '../core/settings';
  import { fly } from 'svelte/transition';
  import { secureAction } from '../core/veil-chain';

  // ===== 消息请求拦截（内嵌 UI） =====
  // 真正的 fetch/XHR hook 在 document-start 就装好了（core/feishu-guard），
  // 这里只是它的展示层：模式开关、待裁决请求、命中记录、记忆规则。
  // 之所以做成内嵌而不是页面浮层：浮层会被作品/站点 DOM 操作干扰，也不符合面板一体化体验。
  const FS_MODES: { value: FeishuInterceptMode; label: string }[] = [
    { value: 'off', label: '不拦截' },
    { value: 'manual', label: '询问' },
    { value: 'allowAll', label: '只记录' },
    { value: 'blockAll', label: '全拒绝' },
  ];
  const FS_MODE_HINT: Record<FeishuInterceptMode, string> = {
    off: '不介入任何请求，行为与未安装一致。',
    manual: '命中飞书 webhook 就挂起，等你在这里点允许 / 拒绝；超时按下方兜底动作处理。',
    allowAll: '全部放行，只把命中记下来（审计用）。',
    blockAll: '命中一律拒绝，请求方会收到失败。',
  };
  const FS_STATE_LABEL: Record<FeishuHit['decision'], string> = {
    pending: '待裁决',
    allowed: '已允许',
    denied: '已拒绝',
    'auto-allowed': '自动放行',
    'auto-denied': '自动拒绝',
    'timeout-allowed': '超时放行',
    'timeout-denied': '超时拒绝',
    'rule-allowed': '规则放行',
    'rule-denied': '规则拒绝',
  };

  let fsMode = $state<FeishuInterceptMode>(feishuMode());
  let fsHits = $state<FeishuHit[]>([]);
  let fsPending = $state(0);
  let fsRulesList = $state<Array<{ botId: string; allow: boolean }>>([]);
  let fsOnTimeout = $state<'allow' | 'block'>(loadSettings().feishuOnTimeout);
  let fsTimeoutMs = $state<number>(loadSettings().feishuTimeoutMs);

  function syncFeishu(): void {
    fsHits = feishuHits();
    fsPending = feishuPendingCount();
    fsRulesList = feishuRules();
    fsMode = feishuMode();
  }

  $effect(() => {
    const off = subscribeFeishu(syncFeishu);
    syncFeishu();
    return off;
  });

  function persistFs(patch: { feishuOnTimeout?: 'allow' | 'block'; feishuTimeoutMs?: number }): void {
    const s = loadSettings();
    Object.assign(s, patch);
    saveSettings(s);
    fsOnTimeout = s.feishuOnTimeout;
    fsTimeoutMs = s.feishuTimeoutMs;
  }

  function decideFs(id: number, allow: boolean, remember = false): void {
    if (!resolveFeishu(id, allow, remember)) showToast('该请求已结束', 'err');
  }

  function decideAllFs(allow: boolean, remember = false): void {
    const n = resolveAllFeishu(allow, remember);
    showToast(n > 0 ? `已${allow ? '放行' : '拒绝'} ${n} 条` : '没有待裁决的请求', n > 0 ? 'ok' : 'err');
  }

  function forgetFsRule(botId: string): void {
    setFeishuRule(botId, null);
  }

  // 机器人来源只依赖变量（含云变量）+ 手动添加，不再需要 vm 桥接面。
  let { variables }: { variables: ScratchVaIMod[] } = $props();

  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2800);
  }

  // ---------- 机器人 ----------
  let ver = $state(0);
  const robots = $derived.by(() => {
    void ver;
    return robotList();
  });
  const bump = () => (ver = ver + 1);

  // 手动刷新（父面板刷新按钮）：从 localStorage 重读机器人登记表，
  // 让「刷新」在本页也是真刷新而非空转动画。
  export function refresh() {
    bump();
  }

  let newName = $state('');
  let newInput = $state('');
  // 选中集合：`kind:token`
  let selected = $state<Set<string>>(new Set());
  let selectAll = $state(true); // 有新机器人自动加入发送列表

  const srcLabel: Record<FeishuRobot['src'], string> = {
    var: '变量',
    manual: '手动',
    seed: '内置',
  };

  function addManual() {
    const name = newName.trim();
    const input = newInput.trim();
    if (!input) {
      showToast('请输入机器人 webhook 地址 / ID', 'err');
      return;
    }
    secureAction('generic', 'fs-add', () => {
      const r = robotAdd(name || maskToken(input), input, 'manual');
      if (!r) {
        showToast('无法识别该机器人地址', 'err');
        return;
      }
      if (selectAll) selected.add(`hook:${r.token}`);
      newInput = '';
      newName = '';
      bump();
      showToast('机器人已添加', 'ok');
    });
  }

  function scanVariables() {
    secureAction('generic', 'fs-scan-var', () => {
      // token → 类型（hook/flow）：类型必须一起传下去，否则捷径 webhook 会被拼错地址
      const tokens = new Map<string, 'hook' | 'flow'>();
      // 变量与列表一起扫描：云变量同样纳入（名称与值都可能藏 webhook / 捷径 ID）。
      // 云变量与普通变量只差持久化层，其值同样是用户可读文本，没有理由跳过。
      for (const v of variables) {
        extractTokens(v.name, tokens);
        extractTokens(v.value, tokens);
      }
      const added = ingestTokens(tokens, 'var');
      bump();
      if (tokens.size === 0) showToast('变量/列表中未发现飞书机器人', 'err');
      else showToast(`变量扫描：发现 ${tokens.size} 个，新增 ${added} 个`, 'ok');
    });
  }

  function removeRobot(r: FeishuRobot) {
    secureAction('generic', 'fs-rm', () => {
      robotRemove(r.token, r.kind);
      selected.delete(`${r.kind}:${r.token}`);
      bump();
      showToast('已移除机器人', 'ok');
    });
  }

  function pinRobot(r: FeishuRobot) {
    secureAction('generic', 'fs-pin', () => {
      const pinned = !r.pin;
      robotPin(r.token, r.kind, pinned);
      bump();
      showToast(
        pinned
          ? `「${cleanDisplay(r.name)}」已置顶`
          : `已取消「${cleanDisplay(r.name)}」置顶`,
        'ok',
      );
    });
  }

  function toggle(r: FeishuRobot) {
    const key = `${r.kind}:${r.token}`;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }

  // 已「自动加选」过的机器人 key 集（组件级普通变量，不参与响应式）：
  // 仅把「新捕获」的机器人自动加入目标一次；之后用户手动取消不会再被加回，
  // 也避免旧实现（$effect 无条件 selected = new Set(...) 触发自激写回）造成的
  // effect_update_depth 死循环 → 切到飞书页整个面板停摆。
  let seenAutoKeys = new Set<string>();

  $effect(() => {
    if (!selectAll) return;
    const list = robots;
    let changed = false;
    const next = new Set(selected);
    for (const r of list) {
      if (r.src === 'var' || r.src === 'seed') {
        const key = `${r.kind}:${r.token}`;
        if (!seenAutoKeys.has(key)) {
          seenAutoKeys.add(key);
          next.add(key);
          changed = true;
        }
      }
    }
    if (changed) selected = next;
  });


  // ---------- 发送 ----------
  type Mode = 'text' | 'atAll' | 'atUser' | 'imgkey' | 'card' | 'raw' | 'upload';
  const MODES: { value: Mode; label: string }[] = [
    { value: 'text', label: '文本' },
    { value: 'atAll', label: '@全员' },
    { value: 'atUser', label: '@成员' },
    { value: 'imgkey', label: '图片key' },
    { value: 'card', label: '卡片JSON' },
    { value: 'raw', label: '捷径JSON' },
    { value: 'upload', label: '文件/图片' },
  ];
  let mode = $state<Mode>('text');

  let text = $state('');
  let atUserId = $state('');
  let imageKey = $state('');
  let cardJson = $state('');
  let rawJson = $state('');
  let uploadDesc = $state('');
  let uploadUrl = $state('');
  let uploadName = $state('');
  let uploading = $state(false);
  let sending = $state(false);
  let fileInputEl: HTMLInputElement | undefined = $state();

  const pickedRobots = $derived.by(() => {
    const list: FeishuRobot[] = [];
    for (const r of robots) {
      if (selected.has(`${r.kind}:${r.token}`)) list.push(r);
    }
    return list;
  });

  const robotsPreview = $derived.by(() => {
    if (pickedRobots.length === 0) return '';
    return (
      pickedRobots
        .slice(0, 3)
        .map((r) => cleanDisplay(r.name))
        .join('、') + (pickedRobots.length > 3 ? '…' : '')
    );
  });

  function switchMode(m: Mode) {
    mode = m;
  }

  function parseJsonOrAlert(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      showToast('JSON 格式错误', 'err');
      return null;
    }
  }

  function hookRobots(): FeishuRobot[] {
    return pickedRobots.filter((r) => r.kind === 'hook');
  }

  function flowRobots(): FeishuRobot[] {
    return pickedRobots.filter((r) => r.kind === 'flow');
  }

  async function doSend() {
    if (pickedRobots.length === 0) {
      showToast('请至少选择一个发送目标机器人', 'err');
      return;
    }
    const results: SendResult[] = [];
    const one = async (r: FeishuRobot, fn: () => Promise<SendResult>) => {
      try {
        results.push(await fn());
      } catch (err) {
        results.push({ token: r.token, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    };

    sending = true;
    try {
      await secureAction('generic', 'fs-send', async () => {
        const hooks = hookRobots();
        switch (mode) {
          case 'text':
            for (const r of hooks) await one(r, () => sendText(r.kind, r.token, text));
            break;
          case 'atAll':
            for (const r of hooks) await one(r, () => sendAtAll(r.kind, r.token, text));
            break;
          case 'atUser':
            if (!atUserId.trim()) {
              showToast('请输入要 @ 的成员 open_id / user_id', 'err');
              return;
            }
            for (const r of hooks) await one(r, () => sendAt(r.kind, r.token, text, atUserId.trim()));
            break;
          case 'imgkey':
            if (!imageKey.trim()) {
              showToast('请输入 image_key（需已上传到飞书）', 'err');
              return;
            }
            for (const r of hooks) await one(r, () => sendImage(r.kind, r.token, imageKey.trim()));
            break;
          case 'card': {
            const card = parseJsonOrAlert(cardJson);
            if (card === null) return;
            for (const r of hooks) await one(r, () => sendCard(r.kind, r.token, card));
            break;
          }
          case 'raw': {
            const data = parseJsonOrAlert(rawJson);
            if (data === null) return;
            const list = pickedRobots.length > 0 ? pickedRobots : robots;
            for (const r of list) await one(r, () => sendRawJson(r.kind, r.token, data));
            break;
          }
          case 'upload': {
            if (!uploadUrl) {
              showToast('请先上传文件获取直链', 'err');
              return;
            }
            const card = buildLinkCard({ title: uploadName || '文件直链', url: uploadUrl, desc: uploadDesc });
            for (const r of hooks) await one(r, () => sendCard(r.kind, r.token, card));
            break;
          }
        }
      });
    } finally {
      sending = false;
    }

    const okN = results.filter((r) => r.ok).length;
    const failN = results.length - okN;
    if (results.length === 0) return;
    if (failN === 0) showToast(`已发送到 ${okN} 个机器人`, 'ok');
    else {
      const firstErr = results.find((r) => !r.ok);
      showToast(
        `发送完成：成功 ${okN}，失败 ${failN}` +
          (firstErr?.detail ? `（${firstErr.detail.slice(0, 60)}）` : ''),
        'err',
      );
    }
  }

  function pickFile() {
    fileInputEl?.click();
  }

  async function onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploading = true;
    uploadUrl = '';
    try {
      const out = await uploadToLink(file);
      if (!out.ok || !out.url) {
        showToast(out.error ?? '上传失败', 'err');
        return;
      }
      uploadUrl = out.url;
      uploadName = file.name;
      showToast(`已上传（${out.host}）→ ${out.url.slice(0, 46)}…`, 'ok');
    } catch (err) {
      showToast(`上传失败：${err instanceof Error ? err.message : err}`, 'err');
    } finally {
      uploading = false;
    }
  }

  function keyboardGuard(node: HTMLInputElement | HTMLTextAreaElement) {
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

  // 编辑区自适应：面板拉宽/拉长时输入框自动「补位」，而不是固定 rows 留下大片空白。
  // 关键：必须观察「面板」而不是 shadow host —— host 是全视口大小，永远不变，
  // 观察它等于什么都没观察（曾因此补位完全失效）。这里向上找到 .svp-panel 再观察。
  const AUTO_MIN_H = 84;
  // 上限不再硬编码：按面板可用空间走，只有极长面板才收敛（防止输入框高得离谱）
  const AUTO_MAX_RATIO = 0.72;
  function autoGrowArea(node: HTMLTextAreaElement) {
    const fit = () => {
      const panel = node.closest('.svp-panel') as HTMLElement | null;
      const box = node.closest('.svp-section') as HTMLElement | null;
      if (!panel || !box) return;
      // 同区块内其它元素占掉的高度（标题/分段控件/发送栏/说明）要扣掉，
      // 剩下的才是输入框可用高度。
      let used = 0;
      for (const el of box.children) {
        if (el === node || (el as HTMLElement).contains(node)) continue;
        used += (el as HTMLElement).offsetHeight;
      }
      const gap = 8 * (box.children.length + 1);
      const avail = panel.clientHeight - used - gap - 28;
      // 用户手动拖过高度则不再覆盖（resize: vertical 的显式设定优先）
      if (node.dataset.userSized === '1') return;
      const maxH = Math.max(AUTO_MIN_H, Math.round(panel.clientHeight * AUTO_MAX_RATIO));
      const h = Math.max(AUTO_MIN_H, Math.min(maxH, Math.round(avail)));
      // 防 ResizeObserver 自激：只有目标高度与「上次写入值」不同才写。
      // 直接比较 offsetHeight 会因布局回弹反复触发（写 → 变高 → 再算 → 再写）。
      const last = node.dataset.fitH ? Number(node.dataset.fitH) : -1;
      if (last === h) return;
      node.dataset.fitH = String(h);
      node.style.height = h + 'px';
    };
    const markUserSized = () => (node.dataset.userSized = '1');
    node.addEventListener('pointerup', markUserSized);
    const panel = node.closest('.svp-panel') as HTMLElement | null;
    const ro = new ResizeObserver(() => fit());
    if (panel) ro.observe(panel);
    ro.observe(node.parentElement ?? node);
    const host = (node.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
    if (host) ro.observe(host);
    requestAnimationFrame(fit);
    const t = setTimeout(fit, 120);
    return {
      destroy() {
        ro.disconnect();
        clearTimeout(t);
        node.removeEventListener('pointerup', markUserSized);
      },
    };
  }

  // ---------- 编辑器草稿/目标持久化：切走再切回/刷新后仍可快速接着发 ----------
  const NS_UI = ['vai', 'mod', '_fs_ui'].join('');
  function persistUi() {
    try {
      localStorage.setItem(
        NS_UI,
        JSON.stringify({
          mode,
          text,
          atUserId,
          imageKey,
          cardJson,
          rawJson,
          uploadDesc,
          selectedKeys: [...selected],
        }),
      );
    } catch {
      /* ignore */
    }
  }
  function restoreUi() {
    try {
      const raw = localStorage.getItem(NS_UI);
      if (!raw) return;
      const s = JSON.parse(raw) as Record<string, unknown>;
      if (!s || typeof s !== 'object') return;
      if (typeof s.mode === 'string' && MODES.some((m) => m.value === s.mode)) {
        mode = s.mode as Mode;
      }
      if (typeof s.text === 'string') text = s.text;
      if (typeof s.atUserId === 'string') atUserId = s.atUserId;
      if (typeof s.imageKey === 'string') imageKey = s.imageKey;
      if (typeof s.cardJson === 'string') cardJson = s.cardJson;
      if (typeof s.rawJson === 'string') rawJson = s.rawJson;
      if (typeof s.uploadDesc === 'string') uploadDesc = s.uploadDesc;
      if (Array.isArray(s.selectedKeys)) {
        const next = new Set(selected);
        for (const k of s.selectedKeys) {
          if (typeof k === 'string' && k.includes(':')) next.add(k);
        }
        // 只保留登记表里仍存在的机器人（防止遗留脏 key 越选越多）
        const alive = new Set(robots.map((r) => `${r.kind}:${r.token}`));
        for (const k of [...next]) {
          if (!alive.has(k)) next.delete(k);
        }
        if (next.size !== selected.size) selected = next;
      }
    } catch {
      /* ignore */
    }
  }
  restoreUi();
  // 卸载（切走/关面板）时保存，刷新/重进也走同一份存储
  $effect(() => {
    const save = () => persistUi();
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      persistUi();
    };
  });

</script>

<div class="svp-feishu">
  {#if toast}
    <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>{toast.text}</div>
  {/if}

  <!-- 机器人 -->
  <section class="svp-section">
    <h3 class="svp-section-title">发送目标机器人</h3>
    <div class="svp-btnrow svp-btnrow-wrap">
      <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={scanVariables}>扫描变量/列表</button>
      <label class="svp-check svp-check-inline">
        <input type="checkbox" bind:checked={selectAll} />
        新捕获的自动加入目标
      </label>
    </div>

    {#if robots.length === 0}
      <p class="svp-empty">还没有机器人。点上方自动扫描，或在下方手动添加 webhook 地址。</p>
    {:else}
      <div class="svp-robotlist">
        {#each robots as r (r.kind + ':' + r.token)}
          <button
            class="svp-robot"
            class:svp-robot-on={selected.has(`${r.kind}:${r.token}`)}
            onclick={() => toggle(r)}
          >
            <span class="svp-robot-name">{cleanDisplay(r.name)}</span>
            <span class="svp-robot-meta">{maskToken(r.token)} · {srcLabel[r.src]}{r.kind === 'flow' ? ' · 捷径' : ''}</span>
          </button>
          <button
            class="svp-robot-star"
            class:svp-robot-star-on={r.pin}
            onclick={() => pinRobot(r)}
            aria-label="置顶"
          >
            {r.pin ? '★' : '☆'}
          </button>
          <button class="svp-robot-del" onclick={() => removeRobot(r)} aria-label="移除">×</button>
        {/each}
      </div>
    {/if}

    <div class="svp-field svp-row2">
      <input class="svp-input" type="text" bind:value={newName} placeholder="备注名" spellcheck="false" use:keyboardGuard />
      <input class="svp-input" type="text" bind:value={newInput} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/… 或 ID" spellcheck="false" use:keyboardGuard onkeydown={(e) => e.key === 'Enter' && addManual()} />
      <button class="svp-btn svp-btn-sm" onclick={addManual} disabled={!newInput.trim()}>添加</button>
    </div>
  </section>

  <!-- 消息请求拦截（内嵌 UI；hook 本体在 document-start 装好） -->
  <section class="svp-section">
    <h3 class="svp-section-title">
      消息请求拦截
      {#if fsPending > 0}<span class="svp-fs-badge">{fsPending}</span>{/if}
    </h3>
    <div class="svp-seg">
      {#each FS_MODES as m}
        <button
          class="svp-seg-btn"
          class:svp-seg-active={fsMode === m.value}
          onclick={() => setFeishuMode(m.value)}
        >
          {m.label}
        </button>
      {/each}
    </div>
    <p class="svp-note">{FS_MODE_HINT[fsMode]}</p>

    {#if fsMode === 'manual'}
      <div class="svp-row2">
        <label class="svp-check">
          超时
          <select class="svp-select" value={fsOnTimeout} onchange={(e) => persistFs({ feishuOnTimeout: (e.currentTarget as HTMLSelectElement).value === 'block' ? 'block' : 'allow' })}>
            <option value="allow">放行</option>
            <option value="block">拒绝</option>
          </select>
        </label>
        <input
          class="svp-input"
          type="number"
          min="0"
          max="300000"
          step="1000"
          value={fsTimeoutMs}
          onchange={(e) => persistFs({ feishuTimeoutMs: Math.max(0, Math.min(300000, Number((e.currentTarget as HTMLInputElement).value) || 0)) })}
          aria-label="等待裁决的毫秒数"
          use:keyboardGuard
        />
      </div>
    {/if}

    {#if fsPending > 0}
      <div class="svp-btnrow svp-btnrow-wrap">
        <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={() => decideAllFs(true)}>全部放行</button>
        <button class="svp-btn svp-btn-sm" onclick={() => decideAllFs(false)}>全部拒绝</button>
        <button class="svp-btn svp-btn-sm" onclick={() => decideAllFs(true, true)}>放行并记住</button>
      </div>
    {/if}

    {#if fsHits.length === 0}
      <p class="svp-empty">暂无命中。切到「询问」后，页面与作品发往飞书群机器人的请求都会在这里等你裁决。</p>
    {:else}
      <div class="svp-fs-log">
        {#each fsHits as h (h.id)}
          <div class="svp-fs-item" class:svp-fs-item-pending={h.decision === 'pending'}>
            <div class="svp-fs-head">
              <span class="svp-fs-bot">{h.botId === '未知' ? '未知机器人' : maskToken(h.botId)}</span>
              <span class="svp-meta">{h.via.toUpperCase()} · {h.method}</span>
              <span class="svp-fs-state" class:svp-fs-state-pending={h.decision === 'pending'}>{FS_STATE_LABEL[h.decision]}</span>
            </div>
            <div class="svp-fs-text">{h.text}</div>
            {#if h.decision === 'pending'}
              <div class="svp-btnrow svp-btnrow-wrap">
                <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={() => decideFs(h.id, true)}>允许</button>
                <button class="svp-btn svp-btn-sm" onclick={() => decideFs(h.id, false)}>拒绝</button>
                <button class="svp-btn svp-btn-sm" onclick={() => decideFs(h.id, true, true)}>允许并记住</button>
                <button class="svp-btn svp-btn-sm" onclick={() => decideFs(h.id, false, true)}>拒绝并记住</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if fsRulesList.length > 0}
        <div class="svp-fs-rules">
          {#each fsRulesList as r (r.botId)}
            <div class="svp-fs-rule">
              <span class="svp-fs-bot">{maskToken(r.botId)}</span>
              <span class="svp-meta">{r.allow ? '总是允许' : '总是拒绝'}</span>
              <button class="svp-robot-del" onclick={() => forgetFsRule(r.botId)} aria-label="忘记该规则">×</button>
            </div>
          {/each}
        </div>
      {/if}

      <div class="svp-btnrow">
        <button class="svp-btn svp-btn-sm" onclick={clearFeishuLog}>清空记录</button>
      </div>
    {/if}
  </section>

  <!-- 编辑发送：flex:1 让它吃掉面板被拉长多出来的高度，
       配合文本域的 autoGrowArea 实现「拉长自动补位」 -->
  <section class="svp-section svp-section-grow">
    <h3 class="svp-section-title">编辑并发送</h3>
    <div class="svp-seg">
      {#each MODES as m}
        <button class="svp-seg-btn" class:svp-seg-active={mode === m.value} onclick={() => switchMode(m.value)}>
          {m.label}
        </button>
      {/each}
    </div>

    {#if mode === 'text' || mode === 'atAll' || mode === 'atUser'}
      <div class="svp-field">
        <textarea class="svp-input svp-textarea" bind:value={text} placeholder="消息文本…" rows={4} spellcheck="false" use:keyboardGuard use:autoGrowArea></textarea>
      </div>
      {#if mode === 'atUser'}
        <div class="svp-field">
          <input class="svp-input" type="text" bind:value={atUserId} placeholder="成员 open_id / user_id" spellcheck="false" use:keyboardGuard />
        </div>
      {/if}
    {:else if mode === 'imgkey'}
      <div class="svp-field">
        <input class="svp-input" type="text" bind:value={imageKey} placeholder="image_key" spellcheck="false" use:keyboardGuard />
      </div>
    {:else if mode === 'card'}
      <div class="svp-field">
        <textarea class="svp-input svp-textarea svp-mono" bind:value={cardJson} placeholder="交互卡片 JSON（含 config / header / elements），点上方模板可参照" rows={8} spellcheck="false" use:keyboardGuard use:autoGrowArea></textarea>
      </div>
    {:else if mode === 'raw'}
      <div class="svp-field">
        <textarea class="svp-input svp-textarea svp-mono" bind:value={rawJson} placeholder="任意 JSON 消息体（捷径/透传），如文本消息示例" rows={6} spellcheck="false" use:keyboardGuard use:autoGrowArea></textarea>
      </div>
    {:else}
      <input bind:this={fileInputEl} class="svp-file-input" type="file" onchange={onFileSelected} />
      <div class="svp-btnrow">
        <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={pickFile} disabled={uploading}>
          {uploading ? '上传中…' : '选择文件 / 图片上传'}
        </button>
      </div>
      {#if uploadUrl}
        <div class="svp-uploaded">
          <span class="svp-meta">{uploadName || '直链'}</span>
          <a class="svp-link" href={uploadUrl} target="_blank" rel="noopener noreferrer">{uploadUrl.slice(0, 50)}{uploadUrl.length > 50 ? '…' : ''}</a>
          <div class="svp-field">
            <input class="svp-input" type="text" bind:value={uploadDesc} placeholder="附带说明" spellcheck="false" use:keyboardGuard />
          </div>
        </div>
      {/if}
      <p class="svp-note">群机器人 webhook 不支持直接推送文件/图片二进制：文件会先上传拿直链（ccw OSS 优先，catbox / 0x0.st 降级），再以卡片链接消息发送给选中机器人。</p>
    {/if}

    <div class="svp-sendbar">
      <span class="svp-meta">
        目标 {pickedRobots.length} 个{#if pickedRobots.length > 0}：{robotsPreview}{/if}
      </span>
      <button
        class="svp-btn svp-send-btn"
        onclick={doSend}
        disabled={sending || pickedRobots.length === 0 || (mode === 'upload' && !uploadUrl)}
      >
        {sending ? '发送中…' : '发送'}
      </button>
    </div>
  </section>
</div>

