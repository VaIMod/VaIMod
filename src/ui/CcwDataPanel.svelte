<script lang="ts">
  import { ccwDataStore, LOCK_PREFIX, type CloudType } from '../core/ccwdata';
  import { cleanDisplay } from '../core';
  import { cloneJson, trashAdd, trashCount } from '../core/ops-meta';
  import { fly } from 'svelte/transition';
  import {
    loadDisplayNames,
    setDisplayName,
    removeDisplayName,
    clearDisplayNames,
  } from '../core/display-names';
  import pencilIcon from '../assets/pencil.svg?raw';
  import restoreIcon from '../assets/restore.svg?raw';
  import lockIcon from '../assets/lock.svg?raw';
  import unlockIcon from '../assets/unlock.svg?raw';
  import { secureAction } from '../core/veil-chain';

  // 行内小图标（避免新增 asset 文件）
  const trashIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';

  let {
    active = true,
    // selected 提升为可双向绑定：父面板在「变量/云数据」tab 间切换时保留上次打开的子标签
    selected = $bindable<CloudType>('project'),
    onOpenSystem,
  }: { active?: boolean; selected?: CloudType; onOpenSystem?: () => void } = $props();

  // 手动刷新计数：驱动内容重挂载重播动画（轮询刷新不 +1，避免每 500ms 闪动）
  let animKey = $state(0);
  let items = $state<{ name: string; serialized: string; kind: 'variable' | 'list' }[]>([]);
  let drafts = $state<Record<string, string>>({});
  let focused = $state<string | null>(null);
  let query = $state('');
  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const serialize = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return JSON.stringify(v);
    return String(v);
  };

  const coerce = (raw: string, current: unknown): string | number | boolean => {
    if (Array.isArray(current)) {
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error('需要 JSON 数组');
      }
    }
    if (typeof current === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error('需要数字');
      return n;
    }
    if (typeof current === 'boolean') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error('需要 true / false');
    }
    return raw;
  };

  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2500);
  }

  // 云数据快照摘要：无变化时跳过重建数组与渲染（500ms 轮询热路径零分配）
  let lastCloudKey = '';

  // 从 store 拉取当前云数据；未聚焦的草稿同步展示值，避免编辑被刷新回滚
  // force=true 时无视「无变化」摘要，强制重建列表（手动刷新按钮用）
  function refresh(force = false) {
    if (!ccwDataStore.ready) return;
    const db = selected === 'project' ? ccwDataStore.project : ccwDataStore.user;
    const entries = db.entries();
    let key = '';
    const next: { name: string; serialized: string; kind: 'variable' | 'list' }[] = [];
    let e = entries.next();
    while (!e.done) {
      const [name, value] = e.value;
      // 双保险：锁标记（#VMLOCK#:…）是 VaIMod 内部簿记，永不进入面板
      if (name.startsWith(LOCK_PREFIX)) {
        e = entries.next();
        continue;
      }
      const serialized = serialize(value);
      key += name;
      key += '\u0001';
      key += serialized;
      key += '\u001f';
      next.push({
        name,
        serialized,
        kind: Array.isArray(value) ? ('list' as const) : ('variable' as const),
      });
      e = entries.next();
    }
    // 远端锁感知必须在「无变化提前返回」之前：数据值不变时列表项与上次一致，
    // 但其它端可能新加了云端锁 marker —— 若跟着早返回一起跳过，本端永远发现不了，
    // 锁定态显示会与实际不一致（内部自带 ≥8s 节流，开销可忽略）。
    maybeSyncRemoteLocks();
    if (!force && key === lastCloudKey) return;
    lastCloudKey = key;
    items = next;
    for (const it of next) {
      if (focused !== it.name && (drafts[it.name] === undefined || drafts[it.name] === it.serialized)) {
        drafts[it.name] = it.serialized;
      }
    }
  }

  // ===== 全局锁定 =====
  // 锁定把条目值「钉住」+ 云端写 marker：本端与其它 VaIMod 都无法再修改，除非手动解锁。
  let lockVer = $state(0);
  const rowLocked = (name: string): boolean => {
    void lockVer;
    return ccwDataStore.isLocked(selected, name);
  };
  let lastLockSync = 0;
  // 周期（≥8s）把当前列表条目与云端 marker 对齐一次：感知其它 VaIMod 加的锁
  function maybeSyncRemoteLocks() {
    const now = Date.now();
    if (now - lastLockSync < 8000) return;
    const names = items.map((i) => i.name).slice(0, 40);
    // 无可同步条目时不吃掉节流窗口（否则首次列表为空会把真正的同步推迟 8s）
    if (names.length === 0) return;
    lastLockSync = now;
    void ccwDataStore
      .syncRemoteLocks(selected, names)
      .then((n) => {
        if (n > 0) lockVer = lockVer + 1;
      })
      .catch(() => undefined);
  }

  async function toggleCloudLock(name: string) {
    await secureAction('cloud', `cloud-lock:${name}`, async () => {
      try {
        if (ccwDataStore.isLocked(selected, name)) {
          await ccwDataStore.unlockValue(selected, name);
          showToast(`已解锁「${name}」，可继续修改`, 'ok');
        } else {
          const confirmed = await ccwDataStore.lockValue(selected, name);
          if (confirmed) {
            showToast(`已锁定「${name}」：数值已钉住，任何来源都无法修改，需手动解锁`, 'ok');
          } else {
            showToast(`已锁定「${name}」（云端 marker 暂未写成功，本端已生效并自动重试）`, 'err');
          }
        }
      } catch (e) {
        showToast(`操作失败：${e instanceof Error ? e.message : e}`, 'err');
      }
      lockVer = lockVer + 1;
    });
  }

  // 手动刷新（父面板「刷新」按钮）：重播进入动画，不重建组件、不重置子标签；
  // 按「刷新回作品」语义：停在「用户」但无用户云数据时回退作品页。
  // force 刷新：无视摘要缓存，强制重读 store 并重建列表（真刷新）。
  export function animateRefresh() {
    animKey = animKey + 1;
    if (
      selected === 'user' &&
      ccwDataStore.ready &&
      ccwDataStore.user.entries().next().done
    ) {
      selected = 'project';
    }
    refresh(true);
  }

  // 云数据扩展加载状态（响应式镜像 ready，供模板/超时检测使用）
  let cloudReady = $state(false);
  let cloudWait = $state<'waiting' | 'missing'>('waiting');
  let waitTimer: ReturnType<typeof setTimeout> | undefined;

  // 面板可见（active）时持续拉取；面板收起或未激活时停止，避免后台开销
  $effect(() => {
    if (!active) return;
    cloudReady = ccwDataStore.ready;
    if (ccwDataStore.ready) {
      cloudWait = 'waiting';
      clearTimeout(waitTimer);
      refresh();
      // 事件驱动：平台写入云数据 → 即时刷新（300ms 节流合并，由 store 侧保证）
      const unsub = ccwDataStore.subscribe(() => refresh());
      // 低频兜底（2s）：覆盖云端下发/外部同步等无事件路径，替代原 500ms 全量轮询
      const id = setInterval(() => {
        cloudReady = ccwDataStore.ready;
        refresh();
      }, 2000);
      return () => {
        clearInterval(id);
        clearTimeout(waitTimer);
        unsub();
      };
    }
    // 未加载：轮询检测 + 6s 后给出「云数据扩展未加载」提示（不再无限转圈）
    const wait = setInterval(() => {
      if (ccwDataStore.ready) {
        cloudReady = true;
        clearInterval(wait);
        clearTimeout(waitTimer);
        refresh();
      }
    }, 300);
    waitTimer = setTimeout(() => {
      if (!ccwDataStore.ready && cloudWait === 'waiting') cloudWait = 'missing';
    }, 6000);
    return () => {
      clearInterval(wait);
      clearTimeout(waitTimer);
    };
  });

  function retryCloud() {
    cloudWait = 'waiting';
    ccwDataStore.retry();
  }

  // 键盘保护：面板内输入框的按键不冒泡到页面（防止页面全局键盘监听干扰增删字符）
  function keyboardGuard(node: HTMLInputElement) {
    const host = (node.getRootNode() as ShadowRoot).host;
    const onKeydownCapture = (e: KeyboardEvent) => {
      if (!host || !e.composedPath().includes(host)) return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        node.blur();
      }
    };
    window.addEventListener('keydown', onKeydownCapture, true);
    return {
      destroy() {
        window.removeEventListener('keydown', onKeydownCapture, true);
      },
    };
  }

  // 切换作品/用户时立即刷新
  $effect(() => {
    void selected;
    refresh();
  });

  // 「重新进入/刷新」回退：组件挂载后首次就绪时，若上次停在「用户」但无用户云数据 → 回作品。
  // 只在就绪瞬间执行一次（fallbackChecked），会话内主动点击「用户」不受影响——空库可自由停留。
  let fallbackChecked = $state(false);
  $effect(() => {
    if (fallbackChecked || !ccwDataStore.ready) return;
    fallbackChecked = true;
    if (selected === 'user' && ccwDataStore.user.entries().next().done) {
      selected = 'project';
    }
  });

  // 显示别名（本地显示层）：云变量重命名只改面板显示，不改云端真实名
  let displayNames = $state(loadDisplayNames());
  const cloudKey = (name: string) => ['c', selected, name].join(':');
  const shownName = (name: string) => displayNames[cloudKey(name)] ?? name;
  // 单条是否有别名（有且与原名不同）
  const hasAlias = (name: string) => {
    const a = displayNames[cloudKey(name)];
    return typeof a === 'string' && a.length > 0 && a !== name;
  };
  // 是否展示「一键恢复」按钮：只看当前列表里实际存在且被改名的项——
  // 不含 localStorage 残留（已删除/已不存在的云数据项的旧别名），
  // 只有真正有「被改变」的云数据时才显示，恢复后自动消失
  const hasCloudAliases = $derived(items.some((it) => hasAlias(it.name)));
  let renamingName = $state<string | null>(null);
  let draftName = $state('');

  function startRename(name: string) {
    draftName = shownName(name);
    renamingName = name;
  }

  // 恢复单个云数据原始名（删除该显示别名）——云动作：遮罩→SDP cloud→审核→封印
  function restoreName(name: string) {
    secureAction('cloud', `cloud-restore:${name}`, () => {
      const key = cloudKey(name);
      if (!displayNames[key]) return;
      delete displayNames[key];
      removeDisplayName(key);
      showToast('已恢复原始名', 'ok');
    });
  }

  // 一键恢复全部云数据原始名（仅清云数据域 c: 前缀，变量别名不受影响）
  function restoreAllCloudNames() {
    secureAction('cloud', 'cloud-restore-all', () => {
      if (!hasCloudAliases) {
        showToast('没有自定义名称', 'err');
        return;
      }
      for (const k of Object.keys(displayNames)) {
        if (k.startsWith('c:')) delete displayNames[k];
      }
      clearDisplayNames('c');
      showToast('已全部恢复原始名', 'ok');
    });
  }

  function commitRename() {
    secureAction('cloud', `cloud-rename:${renamingName ?? ''}`, () => {
      const orig = renamingName;
      renamingName = null;
      if (!orig) return;
      const n = draftName.trim();
      if (!n || n === shownName(orig)) return;
      if (n.includes('\x23BVM\x23') || n === '\x23VMDBS\x23') {
        showToast('\u53d8\u91cf\u540d\u4e0d\u5408\u6cd5', 'err');
        return;
      }
      const key = cloudKey(orig);
      displayNames[key] = n;
      setDisplayName(key, n);
      showToast('\u5df2\u91cd\u547d\u540d', 'ok');
    });
  }

  // 云数据搜索：默认按显示名匹配；「#SVV# 值」前缀按值匹配
  // （大小写不敏感，容忍全宽＃，前缀后可不带空格；列表值为 JSON 串）
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase().replace(/＃/g, '#');
    if (!q) return items;
    const VALUE_TAG = '#svv#';
    if (q.startsWith(VALUE_TAG)) {
      const vq = q.slice(VALUE_TAG.length).trim();
      if (!vq) return items;
      return items.filter((it) => it.serialized.toLowerCase().includes(vq));
    }
    return items.filter((it) => shownName(it.name).toLowerCase().includes(q));
  });

  function saveOne(name: string) {
    // 点击经统一多层安全栈（遮罩→SDP cloud→审核→多层封印，层间安全传递）后执行
    secureAction('cloud', `cloud-save:${name}`, () => {
      const raw = drafts[name] ?? '';
      const db = selected === 'project' ? ccwDataStore.project : ccwDataStore.user;
      const current = db.get(name);
      let next: string | number | boolean;
      try {
        next = coerce(raw, current);
      } catch (e) {
        showToast(`「${name}」格式错误：${e instanceof Error ? e.message : e}`, 'err');
        return;
      }
      // 乐观更新：本地镜像 + UI 立即生效，后台同步不阻塞（显著提升保存速度感）
      const prev = current;
      db.set(name, next);
      drafts[name] = serialize(next);
      ccwDataStore
        .setValue(selected, name, next)
        .then(() => showToast(`「${name}」已保存`, 'ok'))
        .catch((e) => {
          // 失败回滚本地镜像：否则镜像停在未写入的新值上，「保存全部」下次
          // 会按「未改动」跳过该项，用户再也没法重试。草稿保留用户输入（显示为待保存）。
          db.set(name, prev);
          showToast(`「${name}」保存失败：${e instanceof Error ? e.message : e}`, 'err');
        });
    });
  }

  async function saveAll() {
    // 点击经统一多层安全栈（遮罩→SDP cloud→审核→多层封印）后执行
    await secureAction('cloud', 'cloud-save-all', async () => {
      const db = selected === 'project' ? ccwDataStore.project : ccwDataStore.user;
      const jobs: { name: string; value: string | number | boolean; prev: unknown }[] = [];
      let ok = 0;
      let fail = 0;
      let skip = 0;
      for (const it of items) {
        const raw = drafts[it.name];
        if (raw === undefined) continue;
        const current = db.get(it.name);
        if (serialize(current) === raw) {
          skip++;
          continue;
        }
        let next: string | number | boolean;
        try {
          next = coerce(raw, current);
        } catch {
          fail++;
          continue;
        }
        // 乐观更新：本地镜像 + UI 立即生效
        db.set(it.name, next);
        drafts[it.name] = serialize(next);
        jobs.push({ name: it.name, value: next, prev: current });
      }
      if (jobs.length === 0) {
        showToast(`未改动：跳过 ${skip} 项`, 'ok');
        return;
      }
      // 并行后台同步，不逐个等待（速度显著提升）
      const results = await Promise.allSettled(
        jobs.map((j) => ccwDataStore.setValue(selected, j.name, j.value)),
      );
      ok = results.filter((r) => r.status === 'fulfilled').length;
      fail += results.length - ok;
      // 失败项回滚本地镜像，使该项恢复「有改动」状态（可被下次保存全部重试）
      results.forEach((r, i) => {
        if (r.status === 'rejected') db.set(jobs[i].name, jobs[i].prev);
      });
      if (fail === 0) showToast(`已保存全部：更新 ${ok} 项，未改动 ${skip} 项`, 'ok');
      else showToast(`保存完成：成功 ${ok} 项，失败 ${fail} 项`, 'err');
    });
  }

  // ===== 新建云变量（官方 Cloud Database save API 直写，不依赖扩展捕获） =====
  let creating = $state(false);
  let createName = $state('');
  let createValue = $state('');
  let createBusy = $state(false);

  function startCreate() {
    createName = '';
    createValue = '';
    creating = true;
  }

  function cancelCreate() {
    creating = false;
    createName = '';
    createValue = '';
  }

  async function doCreate() {
    if (createBusy) return;
    // 点击经统一多层安全栈（遮罩→SDP cloud→审核→多层封印）后执行
    await secureAction('cloud', `cloud-create:${createName}`, async () => {
      const name = createName.trim();
      if (!name) {
        showToast('变量名不能为空', 'err');
        return;
      }
      if (name.includes('\x23BVM\x23') || name === '\x23VMDBS\x23') {
        showToast('变量名不合法', 'err');
        return;
      }
      const db = selected === 'project' ? ccwDataStore.project : ccwDataStore.user;
      if (db.has(name)) {
        showToast(`「${name}」已存在，直接编辑即可`, 'err');
        return;
      }
      createBusy = true;
      try {
        const r = await ccwDataStore.createValue(selected, name, createValue);
        // 成功后清空表单回到列表（store 已乐观镜像并通知刷新）
        creating = false;
        createName = '';
        createValue = '';
        if (selected === 'project' && !r.official) {
          showToast(`「${name}」已新建，但官方后端直写失败，可能未永久保存（刷新后可能丢失）`, 'err');
        } else {
          showToast(`「${name}」已新建`, 'ok');
        }
      } catch (e) {
        showToast(
          `新建失败：${e instanceof Error ? e.message : e}`,
          'err',
        );
      } finally {
        createBusy = false;
      }
    });
  }

  // ===== 删除云数据（先进回收站，系统页可一键还原） =====
  let trashVer = $state(0);
  const trashTotal = $derived.by(() => {
    void trashVer;
    return trashCount('cloud:p') + trashCount('cloud:u');
  });
  let deletingName = $state<string | null>(null);

  const scopeOf = (type: CloudType): 'cloud:p' | 'cloud:u' =>
    type === 'project' ? 'cloud:p' : 'cloud:u';

  function toTrashValue(v: unknown): { kind: 'variable' | 'list'; value: unknown } {
    if (Array.isArray(v)) {
      return {
        kind: 'list',
        value: v.map((x) =>
          x !== null && typeof x === 'object' ? JSON.stringify(x) : x,
        ),
      };
    }
    if (v === null || v === undefined) return { kind: 'variable', value: '' };
    if (typeof v === 'object') {
      try {
        return { kind: 'variable', value: JSON.stringify(v) };
      } catch {
        return { kind: 'variable', value: String(v) };
      }
    }
    return { kind: 'variable', value: v as string | number | boolean };
  }

  async function deleteCloudItem(name: string) {
    if (deletingName) return;
    const type = selected;
    const db = type === 'project' ? ccwDataStore.project : ccwDataStore.user;
    await secureAction('cloud', `cloud-del:${name}`, async () => {
      const cur = db.get(name);
      if (cur === undefined) {
        showToast(`「${name}」不存在`, 'err');
        return;
      }
      deletingName = name;
      try {
        const { kind, value } = toTrashValue(cloneJson(cur));
        await ccwDataStore.removeValue(type, name);
        trashAdd({
          key: name,
          name,
          kind,
          value: value as never,
          scope: scopeOf(type),
        });
        // 同步清理本地显示别名
        const key = cloudKey(name);
        if (displayNames[key]) {
          delete displayNames[key];
          removeDisplayName(key);
        }
        trashVer = trashVer + 1;
        showToast(`「${name}」已移入回收站`, 'ok');
      } catch (e) {
        showToast(`删除失败：${e instanceof Error ? e.message : e}`, 'err');
      } finally {
        deletingName = null;
      }
    });
  }
</script>

<div class="svp-ccw">
  {#if active}
  {#if toast}
    <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>{toast.text}</div>
  {/if}

  {#if !cloudReady}
    {#if cloudWait === 'missing'}
      <div class="svp-error">
        <p>云数据扩展未加载</p>
        <button class="svp-btn" onclick={retryCloud}>重新捕获</button>
      </div>
    {:else}
      <div class="svp-loading">等待捕获云数据扩展…</div>
    {/if}
  {:else}
    <div class="svp-ccw-tabs">
      <button
        class="svp-ccw-tab"
        class:svp-ccw-tab-active={selected === 'project'}
        onclick={() => (selected = 'project')}
      >
        作品
      </button>
      <button
        class="svp-ccw-tab"
        class:svp-ccw-tab-active={selected === 'user'}
        onclick={() => (selected = 'user')}
      >
        用户
      </button>
    </div>

    {#if trashTotal > 0}
      <div class="svp-trashbar">
        <span class="svp-trashbar-count">回收站 · {trashTotal} 项</span>
        <button class="svp-trashbar-go" onclick={() => onOpenSystem?.()}>前往系统页还原</button>
      </div>
    {/if}

    <div class="svp-actionbar">
      <input
        class="svp-search"
        type="text"
        bind:value={query}
        placeholder="搜索名称或值…"
        aria-label="搜索云数据"
        use:keyboardGuard
      />
      {#if hasCloudAliases}
        <button class="svp-restore-all svp-restore-inline" onclick={restoreAllCloudNames}>
          一键恢复原始名
        </button>
      {/if}
    </div>
    <div class="svp-actionbar">
      <button class="svp-saveall" onclick={saveAll}>保存全部</button>
      <button class="svp-btn svp-new-cloud" onclick={startCreate} aria-label="新建云变量">
        ＋ 新建
      </button>
    </div>

    {#if creating}
      <div class="svp-create-row">
        <input
          class="svp-input svp-create-name"
          type="text"
          bind:value={createName}
          placeholder="变量名"
          spellcheck="false"
          use:keyboardGuard
          onkeydown={(e) => {
            if (e.key === 'Enter') doCreate();
            else if (e.key === 'Escape') cancelCreate();
          }}
        />
        <input
          class="svp-input svp-create-value"
          type="text"
          bind:value={createValue}
          placeholder="初始值"
          spellcheck="false"
          use:keyboardGuard
          onkeydown={(e) => {
            if (e.key === 'Enter') doCreate();
            else if (e.key === 'Escape') cancelCreate();
          }}
        />
        <button class="svp-btn" onclick={doCreate} disabled={createBusy}>
          {createBusy ? '创建中…' : '创建'}
        </button>
        <button class="svp-btn svp-btn-ghost" onclick={cancelCreate}>取消</button>
      </div>
    {/if}

    <div class="svp-ccw-content">
      {#key `${selected}:${animKey}`}
        {#if filtered.length === 0}
          <div class="svp-empty svp-empty-cloud">
            <div class="svp-empty-icon" aria-hidden="true">☁</div>
            <p class="svp-empty-msg">当前{selected === 'project' ? '作品' : '用户'}还没有云数据</p>
            <button class="svp-btn" onclick={startCreate}>＋ 新建云数据</button>
          </div>
        {:else}
          {#each filtered as v, idx (v.name)}
            <div
              class="svp-ccw-item svp-ccw-item-enter"
              style:animation-delay={`${Math.min(idx * 32, 320)}ms`}
            >
              <div class="svp-info">
                <div class="svp-name-row">
                  {#if renamingName === v.name}
                    <input
                      class="svp-input svp-name-input"
                      type="text"
                      bind:value={draftName}
                      use:keyboardGuard
                      onkeydown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') renamingName = null;
                      }}
                      onblur={commitRename}
                      spellcheck="false"
                    />
                  {:else}
                    <span class="svp-name">{cleanDisplay(shownName(v.name))}</span>
                    {#if hasAlias(v.name)}
                      <button
                        class="svp-rename-btn svp-restore-btn"
                        onclick={() => restoreName(v.name)}
                        aria-label="恢复原始名"
                      >
                        {@html restoreIcon}
                      </button>
                    {/if}
                    <button class="svp-rename-btn" onclick={() => startRename(v.name)} aria-label="重命名">{@html pencilIcon}</button>
                  {/if}
                  <em class="svp-kind" class:svp-kind-list={v.kind === 'list'}>
                    {v.kind === 'list' ? '列表' : '变量'}
                  </em>
                </div>
              </div>
              <div class="svp-ccw-controls">
                {#if rowLocked(v.name)}
                  <button
                    class="svp-ccw-lock svp-ccw-lock-on"
                    onclick={() => toggleCloudLock(v.name)}
                    aria-label="解锁"
                  >
                    {@html lockIcon}
                  </button>
                  <input
                    class="svp-input svp-value-input"
                    type="text"
                    value={drafts[v.name]}
                    disabled
                    spellcheck="false"
                  />
                {:else}
                  <button
                    class="svp-ccw-lock"
                    onclick={() => toggleCloudLock(v.name)}
                    aria-label="锁定"
                  >
                    {@html unlockIcon}
                  </button>
                  <input
                    class="svp-input svp-value-input"
                    type="text"
                    bind:value={drafts[v.name]}
                    onfocus={() => (focused = v.name)}
                    onblur={() => {
                      focused = null;
                      saveOne(v.name);
                    }}
                    spellcheck="false"
                  />
                {/if}
                <button class="svp-ccw-save" onclick={() => saveOne(v.name)} disabled={rowLocked(v.name)}>保存</button>
                <button
                  class="svp-ccw-del"
                  onclick={() => deleteCloudItem(v.name)}
                  disabled={deletingName === v.name || rowLocked(v.name)}
                  aria-label="删除"
                >
                  {@html trashIcon}
                </button>
              </div>
            </div>
          {/each}
        {/if}
      {/key}
    </div>
  {/if}
  {/if}
</div>
