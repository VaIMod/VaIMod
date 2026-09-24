<script lang="ts">
  // ===== 系统：快照标记（还原系统）+ 回收站 =====
  // 快照标记：把「当前全部变量/列表 + 作品/用户云数据」存档为命名快照，随时一键还原；
  // 回收站：变量 / 作品云数据 / 用户云数据 三桶，支持单项还原、一键全部还原、彻底删除/清空。
  import type { ScratchVaIMod, ScratchValue } from '../core';
  import { cleanDisplay } from '../core';
  import { ccwDataStore, type CloudType } from '../core/ccwdata';
  import {
    cloneJson,
    markerAdd,
    markerList,
    markerRemove,
    trashClear,
    trashCount,
    trashList,
    trashTake,
    type MarkerEntry,
    type TrashEntry,
    type TrashScope,
  } from '../core/ops-meta';
  import { secureAction } from '../core/veil-chain';
  import type { Settings } from '../core/settings';
  import { fly } from 'svelte/transition';

  type BridgeLike = {
    readVariableValue: (id: string, targetId: string) => ScratchValue | null;
    /** 整表回读 vm 真实值（忽略锁定覆盖值）；键 = `targetId\u0000variableId`。快照采集专用 */
    readVmLiveValues: () => Map<string, ScratchValue>;
    setVariable: (id: string, value: ScratchValue, targetId: string) => boolean;
    createRuntimeVariable: (
      name: string,
      kind: 'variable' | 'list',
      targetId: string,
      init: ScratchValue,
    ) => { ok: boolean; id: string; mode: 'editor' | 'runtime'; message?: string };
    getStatus: () => string;
  };

  let {
    bridge,
    variables,
    active = true,
    settings,
    onOpenSettings,
    showSettingsEntry = true,
  }: {
    bridge: BridgeLike;
    variables: ScratchVaIMod[];
    active?: boolean;
    settings: Settings;
    onOpenSettings?: () => void;
    /** 是否渲染本页右下角设置入口（Header 齿轮隐藏时作为主入口） */
    showSettingsEntry?: boolean;
  } = $props();

  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let markerVer = $state(0);
  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2600);
  }

  // 手动刷新（父面板刷新按钮）：从 localStorage 重读快照与回收站，
  // 让「刷新」在本页也是真刷新而非空转动画。
  let trashVer = $state(0);
  export function refresh() {
    markerVer = markerVer + 1;
    trashVer = trashVer + 1;
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

  // ---------- 快照标记 ----------
  let autoDone = $state(false);
  /**
   * 初始快照是否已「排期」。effect 会随 variables 更新反复重跑（轮询每 2s 一次、
   * 聊天室类作品更频繁），没有这个守卫就会重复排期；而且它是普通 let 不是 $state，
   * 在 effect 里同步写不会触发 effect_update_depth 自激。
   */
  let autoScheduled = false;
  let newMarkName = $state('');
  let importText = $state('');

  /**
   * 空闲调度（rIC + setTimeout 双保险，rIC 在无头/后台标签可能长期不触发）。
   * 用途见下方「初始快照」——那是一次百毫秒级同步重活，必须晚于切页首帧，
   * 不能跟用户交互抢帧。
   */
  function scheduleIdle(fn: () => void, timeoutMs = 1200, fallbackMs = 300): void {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      fn();
    };
    try {
      const g = globalThis as {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      };
      if (typeof g.requestIdleCallback === 'function') {
        g.requestIdleCallback(run, { timeout: timeoutMs });
        setTimeout(run, fallbackMs);
        return;
      }
    } catch {
      /* 走兜底 */
    }
    setTimeout(run, 30);
  }

  function fmtTime(t: number): string {
    const diff = Date.now() - t;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60000)} 分钟前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 采集当前状态为快照数据（不含 isCloud 的 vm 云变量：避免还原时联动云端）。
   *
   * 性能（本函数是全项目单次最重的同步路径之一）：
   * 值改为**整表一次回读**，不再逐条 bridge.readVariableValue —— 逐条读每次都要付
   * ztna 校验 + getSecureVm + 扫 targets 的固定开销，乘以变量数后在 5704 变量时
   * 实测 65.6ms，占快照总成本 74%；整表回读只走一遍 SecureVm 快照。
   * 同时这里**去掉了 cloneJson**：值来自入站清洗（auditInbound 对数组已复制、
   * 标量不可变），本就是与 vm 脱钩的纯数据，再深拷贝等于白付一次 JSON 往返
   * （实测 19.1ms/5704 变量）。云数据那两处仍保留 cloneJson —— toJSON() 可能
   * 吐出内部引用，必须真拷一份。
   */
  function captureSnapshot(): Omit<MarkerEntry, 'id' | 'at' | 'name' | 'lists'> {
    const vars: Record<string, Record<string, { k: 'variable' | 'list'; value: ScratchValue }>> = {};
    const live = bridge.readVmLiveValues();
    for (const v of variables) {
      if (v.isCloud) continue;
      // undefined = 该变量不在 vm 里（安全扩展变量等）→ 与逐条读返回 null 同义
      const raw = live.get(v.targetId + '\u0000' + v.id);
      if (raw === undefined) continue;
      (vars[v.targetId] ??= {})[v.name] = { k: v.kind, value: raw };
    }
    const cloud = {
      p: cloneJson(ccwDataStore.project.toJSON()) as Record<string, unknown>,
      u: cloneJson(ccwDataStore.user.toJSON()) as Record<string, unknown>,
    };
    return { vars, cloud, kind: 'full' as const };
  }

  function doSaveMarker() {
    secureAction('generic', 'marker-save', () => {
      const name = newMarkName.trim() || `快照 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      const snap = captureSnapshot();
      const added = markerAdd({ name, ...snap });
      newMarkName = '';
      markerVer = markerVer + 1;
      if (markerEntryCount(added) === 0) showToast('当前无可用数据（未连接或项目无变量）', 'err');
      else showToast(`快照「${name}」已保存（共 ${markerEntryCount(added)} 项）`, 'ok');
    });
  }

  function markerEntryCount(m: MarkerEntry): number {
    let n = 0;
    for (const t of Object.values(m.vars ?? {})) n += Object.keys(t).length;
    n += Object.keys(m.cloud?.p ?? {}).length;
    n += Object.keys(m.cloud?.u ?? {}).length;
    return n;
  }

  async function applyMarker(m: MarkerEntry) {
    if (!m.vars && !m.cloud) {
      showToast('该快照无数据', 'err');
      return;
    }
    await secureAction('write', `marker-apply:${m.name}`, async () => {
      let ok = 0;
      let missed = 0;
      const cloudOk: string[] = [];
      const cloudFail: string[] = [];
      // 变量 / 列表
      const varsData = m.vars as
        | Record<string, Record<string, { k: 'variable' | 'list'; value: ScratchValue }>>
        | undefined;
      // 预建索引：还原循环里对 variables 逐条 some/find 是 O(条目数 × 变量数)，
      // 数百条快照 × 数百个变量即数十万次比较，会让面板明显卡顿。
      const targetIds = new Set<string>();
      const varIndex = new Map<string, (typeof variables)[number]>();
      for (const v of variables) {
        targetIds.add(v.targetId);
        varIndex.set(`${v.targetId}\u0001${v.name}\u0001${v.kind}`, v);
      }
      for (const [targetId, entries] of Object.entries(varsData ?? {})) {
        for (const [name, e] of Object.entries(entries)) {
          if (!targetIds.has(targetId)) {
            missed++;
            continue;
          }
          const hit = varIndex.get(`${targetId}\u0001${name}\u0001${e.k}`);
          if (hit) {
            if (bridge.setVariable(hit.id, e.value, targetId)) ok++;
            else missed++;
          } else if (settings.applyCreateOnRestore) {
            const r = bridge.createRuntimeVariable(name, e.k, targetId, e.value);
            if (r.ok) ok++;
            else missed++;
          } else {
            missed++;
          }
        }
      }
      // 云数据（仅在 ready 且镜像存在时写回）
      const applyCloud = async (type: CloudType, scope: 'p' | 'u') => {
        const data = m.cloud?.[scope];
        if (!data) return;
        const db = type === 'project' ? ccwDataStore.project : ccwDataStore.user;
        for (const [name, value] of Object.entries(data)) {
          if (!ccwDataStore.ready) {
            cloudFail.push(name);
            continue;
          }
          try {
            db.set(name, value);
            await ccwDataStore.setValue(type, name, value);
            cloudOk.push(name);
          } catch {
            cloudFail.push(name);
          }
        }
      };
      await applyCloud('project', 'p');
      await applyCloud('user', 'u');
      const parts = [`变量/列表还原 ${ok} 项`];
      if (missed > 0) parts.push(`跳过 ${missed}`);
      if (cloudOk.length > 0) parts.push(`云数据 ${cloudOk.length}`);
      if (cloudFail.length > 0) parts.push(`云失败 ${cloudFail.length}`);
      showToast(parts.join(' · '), cloudFail.length === 0 && missed === 0 ? 'ok' : 'err');
    });
  }

  async function exportMarker(m: MarkerEntry) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(m));
      showToast('快照 JSON 已复制', 'ok');
    } catch {
      showToast('复制失败', 'err');
    }
  }

  function importMarkerFromText() {
    secureAction('generic', 'marker-import', () => {
      let data: Partial<MarkerEntry>;
      try {
        data = JSON.parse(importText) as Partial<MarkerEntry>;
      } catch {
        showToast('JSON 格式错误', 'err');
        return;
      }
      const name = data.name?.trim() || `导入 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      markerAdd({
        name,
        vars: data.vars,
        lists: undefined,
        cloud: data.cloud,
        kind: data.kind ?? 'full',
      });
      importText = '';
      markerVer = markerVer + 1;
      showToast(`快照「${name}」已导入`, 'ok');
    });
  }

  function removeMarker(id: string) {
    secureAction('generic', 'marker-del', () => {
      markerRemove(id);
      markerVer = markerVer + 1;
      showToast('已删除快照', 'ok');
    });
  }

  const markers = $derived.by(() => {
    void markerVer; // 增/删/导入快照后经 markerVer 触发重算
    return markerList();
  });
  // 进入本页且从未建过标记时，自动落一份「初始快照」，随时一键回到初始。
  // 注意：不能在变量未加载（variables 为空）时提前置位任何"已尝试"标记，
  // 否则变量晚到后 effect 不再重跑，初始快照永远不会生成。
  //
  // 性能（本页唯一的百毫秒级同步开销就在这里）：
  // captureSnapshot() 要遍历全部变量逐条回读 + cloneJson，markerAdd 还要把整份快照
  // 序列化进 localStorage。900 变量实测 59ms 长任务；6000 变量量级线性变大。
  // 原先用 queueMicrotask —— 它在当前任务结束后、**绘制之前**执行，正好卡住切页首帧，
  // 这正是「切到系统页时面板卡一下」的来源。改为空闲调度：先让本页画出来，再补做快照。
  // 语义完全不变（同样的数据、同样只在无标记时建一次），只是不再抢交互帧。
  $effect(() => {
    if (!active || autoDone || autoScheduled) return;
    if (bridge.getStatus() !== 'connected') return;
    if (variables.length === 0) return;
    autoScheduled = true; // 普通 let，同步写不触发 effect 自激（见其声明处注释）
    scheduleIdle(() => {
      if (autoDone) return;
      try {
        if (markerList().length === 0) {
          markerAdd({ name: '初始快照（自动）', ...captureSnapshot() });
        }
      } catch {
        /* ignore */
      } finally {
        autoDone = true;
        markerVer = markerVer + 1;
      }
    });
  });

  // ---------- 回收站 ----------
  type Bucket = { scope: TrashScope; label: string };
  const BUCKETS: Bucket[] = [
    { scope: 'vm', label: '普通变量' },
    { scope: 'cloud:p', label: '作品云数据' },
    { scope: 'cloud:u', label: '用户云数据' },
  ];
  let bucket = $state<TrashScope>('vm');
  const trashItems = $derived.by(() => {
    void trashVer;
    return trashList(bucket);
  });
  const trashBadge = $derived.by(() => {
    void trashVer;
    return BUCKETS.map((b) => ({ ...b, n: trashCount(b.scope) }));
  });
  const allTrashN = $derived.by(() => {
    void trashVer;
    return BUCKETS.reduce((n, b) => n + trashCount(b.scope), 0);
  });

  function bumpTrash() {
    trashVer = trashVer + 1;
  }

  const bucketLabel = $derived(BUCKETS.find((b) => b.scope === bucket)?.label ?? '');

  /** 还原一条回收站条目；返回是否真的还原成功（供「全部还原」如实计数） */
  async function restoreTrashEntry(e: TrashEntry): Promise<boolean> {
    let done = false;
    await secureAction('write', `trash-restore:${e.key}`, async () => {
      if (e.scope === 'vm') {
        const targetStill = variables.some((v) => v.targetId === e.targetId);
        const targetId = targetStill
          ? (e.targetId ?? '')
          : variables.find((v) => v.targetName === e.targetName)?.targetId ?? '';
        if (!targetId) {
          showToast(`变量「${e.name}」所在目标不存在，无法还原`, 'err');
          return;
        }
        const cur = variables.find((v) => v.id === e.key && v.targetId === targetId);
        if (cur) {
          // 写回失败也必须如实上报（旧实现忽略返回值 → 失败也当成功）
          if (!bridge.setVariable(cur.id, e.value, targetId)) {
            showToast(`还原失败：无法写入变量「${e.name}」`, 'err');
            return;
          }
        } else {
          const r = bridge.createRuntimeVariable(e.name, e.kind, targetId, e.value);
          if (!r.ok) {
            showToast(`还原失败：${r.message ?? '环境不支持'}`, 'err');
            return;
          }
        }
        trashTake('vm', e.key, e.name);
        bumpTrash();
        done = true;
        showToast(`变量「${e.name}」已还原`, 'ok');
        return;
      }
      // 云数据还原
      if (!ccwDataStore.ready) {
        showToast('云数据扩展未加载，无法还原云数据', 'err');
        return;
      }
      const type: CloudType = e.scope === 'cloud:p' ? 'project' : 'user';
      const db = type === 'project' ? ccwDataStore.project : ccwDataStore.user;
      try {
        db.set(e.name, e.value);
        await ccwDataStore.setValue(type, e.name, e.value);
        trashTake(e.scope, e.key, e.name);
        bumpTrash();
        done = true;
        showToast(`云数据「${e.name}」已还原`, 'ok');
      } catch (err) {
        db.delete(e.name);
        showToast(`还原失败：${err instanceof Error ? err.message : err}`, 'err');
      }
    });
    return done;
  }

  async function restoreBucketAll() {
    const list = trashList(bucket);
    if (list.length === 0) {
      showToast('回收站是空的', 'err');
      return;
    }
    let okN = 0;
    for (const e of list) {
      try {
        // 按真实结果计数：restoreTrashEntry 内部失败只 toast，不能无条件当成功
        if (await restoreTrashEntry(e)) okN++;
      } catch {
        /* 单项失败继续 */
      }
    }
    bumpTrash();
    const failN = list.length - okN;
    showToast(
      failN === 0
        ? `已还原 ${okN} 项`
        : `已还原 ${okN} 项，${failN} 项失败并保留在回收站`,
      failN === 0 ? 'ok' : 'err',
    );
  }

  function purgeTrashEntry(e: TrashEntry) {
    secureAction('generic', 'trash-purge', () => {
      trashTake(e.scope, e.key, e.name);
      bumpTrash();
      showToast(`「${e.name}」已彻底删除`, 'ok');
    });
  }

  function clearBucket() {
    secureAction('generic', 'trash-clear', () => {
      const n = trashClear(bucket);
      bumpTrash();
      showToast(`已清空${bucketLabel}回收站（${n} 项）`, 'ok');
    });
  }

  const shownName = (s: string) => cleanDisplay(s);
</script>

<div class="svp-sys">
  {#if toast}
    <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>{toast.text}</div>
  {/if}

  <!-- 快照还原系统 -->
  <section class="svp-section">
    <h3 class="svp-section-title">
      快照标记 · 还原系统
      {#if allTrashN > 0}<em class="svp-tag-red">{allTrashN} 项待还原</em>{/if}
    </h3>
    <p class="svp-section-sub">把当前变量/列表 + 作品/用户云数据保存为命名快照，随时一键还原到那一刻</p>
    <div class="svp-field svp-row2">
      <input class="svp-input" type="text" bind:value={newMarkName} placeholder="快照名称" spellcheck="false" use:keyboardGuard />
      <button class="svp-btn svp-btn-sm" onclick={doSaveMarker}>捕获当前为快照</button>
    </div>

    {#if markers.length === 0}
      <p class="svp-empty">还没有快照。连接并打开一次后会自动生成「初始快照」。</p>
    {:else}
      <div class="svp-cardlist">
        {#each markers as m (m.id)}
          <div class="svp-card">
            <div class="svp-card-top">
              <strong>{m.name}</strong>
              <span class="svp-meta">{fmtTime(m.at)} · {markerEntryCount(m)} 项</span>
            </div>
            <div class="svp-btnrow">
              <button class="svp-btn svp-btn-green svp-btn-sm" onclick={() => applyMarker(m)}>一键还原</button>
              <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => exportMarker(m)}>复制 JSON</button>
              <button class="svp-btn svp-btn-red-ghost svp-btn-sm" onclick={() => removeMarker(m.id)}>删除</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="svp-field svp-hint svp-importrow">
      <input class="svp-input" type="text" bind:value={importText} placeholder="粘贴快照 JSON 导入…" spellcheck="false" use:keyboardGuard />
      <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={importMarkerFromText} disabled={!importText.trim()}>导入</button>
    </div>
  </section>

  <!-- 回收站 -->
  <section class="svp-section">
    <h3 class="svp-section-title">回收站</h3>
    <div class="svp-seg">
      {#each BUCKETS as b}
        <button
          class="svp-seg-btn"
          class:svp-seg-active={bucket === b.scope}
          onclick={() => (bucket = b.scope)}
        >
          {b.label}
          {#if trashBadge.find((x) => x.scope === b.scope)?.n}
            <em>{trashBadge.find((x) => x.scope === b.scope)?.n}</em>
          {/if}
        </button>
      {/each}
    </div>

    <div class="svp-btnrow">
      <button class="svp-btn svp-btn-green svp-btn-sm" onclick={restoreBucketAll} disabled={trashItems.length === 0}>一键全部还原</button>
      <button class="svp-btn svp-btn-red-ghost svp-btn-sm" onclick={clearBucket} disabled={trashItems.length === 0}>清空{bucketLabel}回收站</button>
    </div>

    {#if trashItems.length === 0}
      <p class="svp-empty">回收站是空的。删除的变量/云数据会先到这里，可随时还原。</p>
    {:else}
      <div class="svp-cardlist">
        {#each trashItems as e (e.key + e.at)}
          <div class="svp-card">
            <div class="svp-card-top">
              <strong>{shownName(e.name)}</strong>
              <span class="svp-meta">{e.kind === 'list' ? '列表' : '变量'}{e.targetName ? ' · ' + cleanDisplay(e.targetName) : ''} · {fmtTime(e.at)}</span>
            </div>
            <div class="svp-card-val">
              {String(e.value).slice(0, 60)}{String(e.value).length > 60 ? '…' : ''}
            </div>
            <div class="svp-btnrow">
              <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={() => restoreTrashEntry(e)}>还原</button>
              <button class="svp-btn svp-btn-red-ghost svp-btn-sm" onclick={() => purgeTrashEntry(e)}>彻底删除</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- 设置入口（右下角）：仅在 Header 齿轮不显示时作为主入口。
         已连接且系统页可见时 Header 齿轮隐藏，此处保留入口避免无处可去；
         否则该按钮与 Header 齿轮重复，交给 Header 即可。 -->
    {#if showSettingsEntry}
      <button class="svp-settings-trigger" onclick={onOpenSettings} aria-label="设置">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        设置
      </button>
    {/if}
  </section>
</div>

