<script lang="ts">
  // ===== 工具：同变量批量 / 前缀 JSON / 列表快捷操作 =====
  // 能力对应「变量与列表 / 存档码」等 ccw 扩展的常用数据操作，作用于 vm 真实变量与列表。
  import type { ScratchVaIMod, ScratchValue } from '../core';
  import { cleanDisplay, stringToListValue } from '../core';
  import { trashAdd } from '../core/ops-meta';
  import { secureAction } from '../core/veil-chain';
  import { fly } from 'svelte/transition';

  type BridgeLike = {
    readVariableValue: (id: string, targetId: string) => ScratchValue | null;
    setVariable: (id: string, value: ScratchValue, targetId: string) => boolean;
    createRuntimeVariable: (
      name: string,
      kind: 'variable' | 'list',
      targetId: string,
      init: ScratchValue,
    ) => { ok: boolean; id: string; mode: 'editor' | 'runtime'; message?: string };
    deleteVariableEntry: (id: string, targetId: string) => boolean;
  };

  let {
    bridge,
    variables,
  }: { bridge: BridgeLike; variables: ScratchVaIMod[] } = $props();

  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2600);
  }

  // 手动刷新（父面板刷新按钮）：清理输入草稿并重算派生列表，
  // 让「刷新」在每个 Tab 都是真刷新而非空转动画。
  let refreshVer = $state(0);
  export function refresh() {
    refreshVer = refreshVer + 1;
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

  // ---------- S1 同名变量批量 ----------
  let sameName = $state('');
  let sameValue = $state('');
  let kindSel = $state<'__all' | 'variable' | 'list'>('__all');
  let sameCreateMissing = $state(false);
  let sameTargetFilter = $state('');

  const targets = $derived.by(() => {
    const map = new Map<string, string>();
    for (const v of variables) {
      if (v.targetId && !map.has(v.targetId)) map.set(v.targetId, v.targetName || v.targetId);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  });

  const sameKind = $derived.by(() => {
    if (kindSel === '__all') return null;
    return kindSel;
  });

  function sameMatches(): ScratchVaIMod[] {
    const n = sameName.trim();
    if (!n) return [];
    const ks = sameKind;
    return variables.filter((v) => {
      if (v.name !== n) return false;
      if (v.isCloud) return false;
      if (ks && v.kind !== ks) return false;
      if (sameTargetFilter && v.targetId !== sameTargetFilter) return false;
      return true;
    });
  }

  const samePreview = $derived.by(() => {
    void refreshVer; // 刷新按钮触发重算
    const arr = sameMatches().slice(0, 6);    if (arr.length === 0) return '';
    return (
      arr.map((m) => `${cleanDisplay(m.name)}${m.kind === 'list' ? '（列表）' : ''}`).join('、') +
      (sameMatches().length > 6 ? '…' : '')
    );
  });

  function valueForKind(kind: 'variable' | 'list', raw: string): ScratchValue {
    if (kind === 'list') {
      const t = raw.trim();
      if (t.startsWith('[')) {
        try {
          const arr = JSON.parse(t) as unknown;
          if (Array.isArray(arr)) return arr.map((x) => String(x));
        } catch {
          /* 落回逗号拆分 */
        }
      }
      return stringToListValue(raw);
    }
    if (typeof raw === 'string') {
      const n = Number(raw);
      if (raw.trim() !== '' && !Number.isNaN(n)) return n;
    }
    return raw;
  }

  function batchSetValue() {
    secureAction(
      'write',
      `batch-set:${sameName.trim()}`,
      () => {
        const arr = sameMatches();
        if (arr.length === 0) {
          showToast('没有匹配到的同名变量', 'err');
          return;
        }
        let ok = 0;
        for (const v of arr) {
          const value = valueForKind(v.kind, sameValue);
          if (bridge.setVariable(v.id, value, v.targetId)) ok++;
        }
        showToast(
          `已批量设置 ${ok} / ${arr.length} 个变量`,
          ok === arr.length ? 'ok' : 'err',
        );
      },
    );
  }

  function batchCreateMissing() {
    const n = sameName.trim();
    if (!n) {
      showToast('先输入变量名', 'err');
      return;
    }
    secureAction('write', `batch-create:${n}`, () => {
      const existing = new Set(
        variables.filter((v) => v.name === n).map((v) => `${v.targetId}:${v.kind}`),
      );
      const jobs: { id: string; kind: 'variable' | 'list' }[] = [];
      for (const t of targets) {
        if (sameTargetFilter && t.id !== sameTargetFilter) continue;
        if (sameKind === null || sameKind === 'variable') {
          if (!existing.has(`${t.id}:variable`)) jobs.push({ id: t.id, kind: 'variable' });
        }
        if (sameKind === null || sameKind === 'list') {
          if (!existing.has(`${t.id}:list`)) jobs.push({ id: t.id, kind: 'list' });
        }
      }
      if (jobs.length === 0) {
        showToast('各目标均已存在同名变量', 'ok');
        return;
      }
      let ok = 0;
      for (const c of jobs) {
        const init: ScratchValue = c.kind === 'list' ? [] : '';
        if (bridge.createRuntimeVariable(n, c.kind, c.id, init).ok) ok++;
      }
      showToast(`已新建缺失 ${ok} 个同名变量`, ok === jobs.length ? 'ok' : 'err');
    });
  }

  function batchDeleteSame() {
    const arr = sameMatches();
    if (arr.length === 0) {
      showToast('没有匹配到的同名变量', 'err');
      return;
    }
    secureAction('write', `batch-del:${sameName.trim()}`, () => {
      let ok = 0;
      for (const v of arr) {
        const rawVal = bridge.readVariableValue(v.id, v.targetId) ?? '';
        trashAdd({
          key: v.id,
          name: v.name,
          kind: v.kind,
          value: rawVal,
          scope: 'vm',
          targetId: v.targetId,
          targetName: v.targetName,
          isCloud: v.isCloud,
        });
        if (bridge.deleteVariableEntry(v.id, v.targetId)) ok++;
      }
      showToast(
        `已删除 ${ok} 个同名变量（回收站可一键还原）`,
        ok === arr.length ? 'ok' : 'err',
      );
    });
  }

  // ---------- S2 前缀 JSON 序列化 ↔ 恢复 ----------
  let jsonScope = $state<'variable' | 'list'>('variable');
  let prefix = $state('');
  let jsonText = $state('');

  function serializePrefix() {
    secureAction(
      'read',
      `seri:${prefix}`,
      () => {
        const pre = prefix;
        const out: Record<string, unknown> = {};
        for (const v of variables) {
          if (v.kind !== jsonScope || !v.name.startsWith(pre)) continue;
          const raw = bridge.readVariableValue(v.id, v.targetId);
          out[v.name] = raw === null ? '' : raw;
        }
        jsonText = JSON.stringify(out, null, 2);
        showToast(
          `已序列化 ${Object.keys(out).length} 项（前缀 ${pre || '(全部)'}）`,
          'ok',
        );
      },
    );
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(jsonText);
      showToast('已复制 JSON', 'ok');
    } catch {
      showToast('复制失败（浏览器限制）', 'err');
    }
  }

  function restoreJson() {
    secureAction('write', `unseri:${prefix}`, () => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        showToast('JSON 格式错误', 'err');
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        showToast('需要 JSON 对象', 'err');
        return;
      }
      let ok = 0;
      let missing = 0;
      for (const [name, val] of Object.entries(data)) {
        const hits = variables.filter((v) => v.kind === jsonScope && v.name === name);
        if (hits.length === 0) {
          missing++;
          continue;
        }
        for (const v of hits) {
          let value: ScratchValue;
          if (jsonScope === 'list') {
            value = Array.isArray(val)
              ? val.map((x) => String(x))
              : stringToListValue(String(val));
          } else if (typeof val === 'number' || typeof val === 'boolean') {
            value = val;
          } else {
            value = val === null || val === undefined ? '' : String(val);
          }
          if (bridge.setVariable(v.id, value, v.targetId)) ok++;
        }
      }
      showToast(
        `已恢复 ${ok} 项` + (missing > 0 ? `（${missing} 项目标不存在已跳过）` : ''),
        ok > 0 ? 'ok' : 'err',
      );
    });
  }

  // ---------- S3 列表快捷操作 ----------
  type ListPick = { id: string; targetId: string; name: string; targetName: string };
  const lists = $derived.by(() => {
    const seen = new Map<string, ListPick>();
    for (const v of variables) {
      if (v.kind !== 'list') continue;
      seen.set(`${v.targetId}:${v.id}`, {
        id: v.id,
        targetId: v.targetId,
        name: v.name,
        targetName: v.targetName || '舞台',
      });
    }
    return [...seen.values()];
  });
  let pickKey = $state('');
  let copyTargetKey = $state('');
  const pickList = $derived(lists.find((l) => `${l.targetId}:${l.id}` === pickKey) ?? null);
  const copyTargetList = $derived(
    lists.find((l) => `${l.targetId}:${l.id}` === copyTargetKey) ?? null,
  );

  function sortArr(arr: string[], order: string): string[] {
    const a = arr.slice();
    const allNum = a.length > 0 && a.every((x) => x !== '' && !Number.isNaN(Number(x)));
    switch (order) {
      case 'asc':
        return allNum ? a.sort((x, y) => Number(x) - Number(y)) : a.sort();
      case 'desc':
        return allNum ? a.sort((x, y) => Number(y) - Number(x)) : a.sort().reverse();
      case 'random':
        return a
          .map((x) => [Math.random(), x] as const)
          .sort((x, y) => x[0] - y[0])
          .map((x) => x[1]);
      case 'dict':
        return a.sort();
      default:
        return a;
    }
  }

  function applyListOp(kind: 'clear' | 'reverse' | 'asc' | 'desc' | 'random' | 'dict' | 'dedupe') {
    const l = pickList;
    if (!l) {
      showToast('先选择列表', 'err');
      return;
    }
    secureAction('write', `listop:${l.name}:${kind}`, () => {
      const raw = bridge.readVariableValue(l.id, l.targetId);
      const arr = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
      let next = arr;
      switch (kind) {
        case 'clear':
          next = [];
          break;
        case 'reverse':
          next = arr.slice().reverse();
          break;
        case 'dedupe':
          next = [...new Set(arr)];
          break;
        default:
          next = sortArr(arr, kind);
      }
      if (bridge.setVariable(l.id, next, l.targetId)) {
        showToast(`列表「${l.name}」已${opLabel(kind)}（${arr.length}→${next.length} 项）`, 'ok');
      } else {
        showToast('列表写入失败', 'err');
      }
    });
  }

  function opLabel(kind: string): string {
    const map: Record<string, string> = {
      clear: '清空',
      reverse: '反转',
      asc: '升序排序',
      desc: '降序排序',
      random: '随机打乱',
      dict: '字典序排序',
      dedupe: '去重',
    };
    return map[kind] ?? kind;
  }

  function copyListTo() {
    const src = pickList;
    const dst = copyTargetList;
    if (!src || !dst) {
      showToast('请选择源列表与目标列表', 'err');
      return;
    }
    secureAction('write', `listcopy:${src.name}:${dst.name}`, () => {
      const raw = bridge.readVariableValue(src.id, src.targetId);
      const arr = Array.isArray(raw) ? raw.slice() : [];
      if (bridge.setVariable(dst.id, arr, dst.targetId)) {
        showToast(`已复制 ${arr.length} 项到「${dst.name}」`, 'ok');
      } else {
        showToast('复制失败', 'err');
      }
    });
  }
</script>

<div class="svp-tools">
  {#if toast}
    <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>{toast.text}</div>
  {/if}

  <!-- 同变量批量 -->
  <section class="svp-section">
    <h3 class="svp-section-title">同变量批量</h3>
    <p class="svp-section-sub">按名字操作所有目标上的同名变量（含同名列表）</p>
    <div class="svp-field">
      <input
        class="svp-input"
        type="text"
        bind:value={sameName}
        placeholder="变量名（如 score）"
        use:keyboardGuard
        spellcheck="false"
      />
    </div>
    <div class="svp-field svp-row2">
      <select class="svp-input svp-select" bind:value={sameTargetFilter}>
        <option value="">全部目标</option>
        {#each targets as t}
          <option value={t.id}>{t.name}</option>
        {/each}
      </select>
      <select class="svp-input svp-select" bind:value={kindSel}>
        <option value="__all">变量 + 列表</option>
        <option value="variable">仅变量</option>
        <option value="list">仅列表</option>
      </select>
    </div>
    <div class="svp-field svp-hint">
      <label class="svp-check">
        <input type="checkbox" bind:checked={sameCreateMissing} />
        若某目标缺失同名变量，允许批量新建补齐
      </label>
    </div>
    <div class="svp-field">
      <input
        class="svp-input"
        type="text"
        bind:value={sameValue}
        placeholder="要设置的默认值"
        use:keyboardGuard
        spellcheck="false"
      />
    </div>
    <div class="svp-btnrow">
      <button class="svp-btn svp-btn-sm" onclick={batchSetValue} disabled={!sameName.trim()}>批量设为值</button>
      <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={batchCreateMissing} disabled={!sameName.trim() || !sameCreateMissing}>批量新建缺失</button>
      <button class="svp-btn svp-btn-red svp-btn-sm" onclick={batchDeleteSame} disabled={!sameName.trim()}>批量删除（回收站）</button>
    </div>
    {#if sameName.trim() && samePreview}
      <p class="svp-meta">匹配 {sameMatches().length} 项：{samePreview}</p>
    {/if}
  </section>

  <!-- 前缀 JSON 序列化 / 恢复 -->
  <section class="svp-section">
    <h3 class="svp-section-title">前缀 JSON 序列化 ↔ 恢复</h3>
    <p class="svp-section-sub">把某一前缀开头的变量/列表整体导出为 JSON（存档码），也可整体还原</p>
    <div class="svp-field svp-row2">
      <select class="svp-input svp-select" bind:value={jsonScope}>
        <option value="variable">普通变量</option>
        <option value="list">列表</option>
      </select>
      <input
        class="svp-input"
        type="text"
        bind:value={prefix}
        placeholder="前缀"
        use:keyboardGuard
        spellcheck="false"
      />
    </div>
    <div class="svp-field">
      <textarea
        class="svp-input svp-textarea"
        bind:value={jsonText}
        placeholder="JSON 对象，如：值对示例；点上方「导出前缀」自动填充"
        rows={5}
        spellcheck="false"
        use:keyboardGuard
      ></textarea>
    </div>
    <div class="svp-btnrow">
      <button class="svp-btn svp-btn-blue svp-btn-sm" onclick={serializePrefix}>导出前缀 → JSON</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={copyJson} disabled={!jsonText}>复制 JSON</button>
      <button class="svp-btn svp-btn-green svp-btn-sm" onclick={restoreJson} disabled={!jsonText}>从 JSON 恢复</button>
    </div>
  </section>

  <!-- 列表快捷操作 -->
  <section class="svp-section">
    <h3 class="svp-section-title">列表快捷操作</h3>
    <div class="svp-field">
      <select class="svp-input svp-select" bind:value={pickKey}>
        <option value="">选择要操作的列表…</option>
        {#each lists as l}
          <option value={`${l.targetId}:${l.id}`}>{l.name} @ {l.targetName}</option>
        {/each}
      </select>
    </div>
    <div class="svp-btnrow svp-btnrow-wrap">
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('clear')}>清空</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('reverse')}>反转</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('asc')}>升序</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('desc')}>降序</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('random')}>随机</button>
      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={() => applyListOp('dedupe')}>去重</button>
    </div>
    <div class="svp-field svp-row2">
      <input class="svp-input" type="text" value={pickList?.name ?? ''} readonly placeholder="源列表" />
      <select class="svp-input svp-select" bind:value={copyTargetKey}>
        <option value="">复制到…</option>
        {#each lists as l}
          <option value={`${l.targetId}:${l.id}`}>{l.name} @ {l.targetName}</option>
        {/each}
      </select>
    </div>
    <div class="svp-btnrow">
      <button
        class="svp-btn svp-btn-blue svp-btn-sm"
        onclick={copyListTo}
        disabled={!pickKey || !copyTargetKey}
      >
        复制源列表内容 → 目标列表
      </button>
    </div>
  </section>
</div>

