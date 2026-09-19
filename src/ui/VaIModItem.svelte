<script lang="ts">
  import type { ScratchVaIMod, VaIModValue } from '../core';
  import { cleanDisplay, listValueToString } from '../core';
  import lockIcon from '../assets/lock.svg?raw';
  import unlockIcon from '../assets/unlock.svg?raw';
  import pencilIcon from '../assets/pencil.svg?raw';
  import restoreIcon from '../assets/restore.svg?raw';

  const eyeIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOffIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  const trashIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';

  let {
    variable,
    onupdate,
    ontoggleLock,
    onrename,
    onrestore,
    canRename = true,
    displayName,
    oneditstart,
    oneditend,
    ondelete,
    canDelete = true,
    onmonitor,
    monitorOn = null,
  }: {
    variable: ScratchVaIMod;
    onupdate: (v: ScratchVaIMod, value: VaIModValue) => void;
    ontoggleLock: (v: ScratchVaIMod) => void;
    onrename?: (v: ScratchVaIMod, name: string) => void;
    onrestore?: (v: ScratchVaIMod) => void;
    canRename?: boolean;
    displayName?: string;
    oneditstart: () => void;
    oneditend: () => void;
    ondelete?: (v: ScratchVaIMod) => void;
    canDelete?: boolean;
    onmonitor?: (v: ScratchVaIMod) => void;
    monitorOn?: boolean | null;
  } = $props();

  let draft = $state('');
  let focused = $state(false);

  // 当前显示名（本地显示别名优先）
  const shownName = $derived(displayName ?? variable.name);
  // 是否有别名（区别于原始名 → 显示「恢复原名」按钮）
  const hasAlias = $derived(
    typeof displayName === 'string' && displayName.length > 0 && displayName !== variable.name,
  );

  // 重命名状态
  let renaming = $state(false);
  let draftName = $state('');

  function startRename() {
    draftName = shownName;
    renaming = true;
  }

  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const n = draftName.trim();
    if (n && n !== shownName) onrename?.(variable, n);
  }

  $effect(() => {
    if (focused) return;
    const text = listValueToString(variable.value);
    if (text !== draft) draft = text;
  });

  function onFocus() {
    focused = true;
    draft = listValueToString(variable.value);
    oneditstart();
  }

  function onBlur() {
    if (draft !== listValueToString(variable.value)) {
      onupdate(variable, draft);
    }
    focused = false;
    oneditend();
  }

  function onInput() {
    if (variable.isLocked) {
      onupdate(variable, draft);
    }
  }

  // 共享键盘守卫：原实现每个输入行各挂一个 window capture 监听 —— 展开 300 行的分组时
  // 页面任意按键都要跑 300 次 composedPath()。改为模块级只挂一个监听，
  // 按事件路径命中判定（O(路径长度) 而非 O(行数)），行为完全一致：
  // 命中自家输入框即 stopPropagation（防站点快捷键抢键），Enter 提交并失焦。
  const guardedInputs = new Set<HTMLInputElement>();
  let keyboardGuardInstalled = false;

  function sharedKeydownGuard(e: KeyboardEvent): void {
    let target: HTMLInputElement | null = null;
    for (const node of e.composedPath()) {
      if (node instanceof HTMLInputElement && guardedInputs.has(node)) {
        target = node;
        break;
      }
    }
    if (!target) return;
    e.stopPropagation();
    if (e.key === 'Enter') target.blur();
  }

  function keyboardGuard(node: HTMLInputElement) {
    guardedInputs.add(node);
    if (!keyboardGuardInstalled) {
      keyboardGuardInstalled = true;
      window.addEventListener('keydown', sharedKeydownGuard, true);
    }
    return {
      destroy() {
        guardedInputs.delete(node);
      },
    };
  }
</script>

<div class="svp-item" class:svp-item-locked={variable.isLocked}>
  <div class="svp-info">
    <div class="svp-name-row">
      {#if renaming}
        <input
          class="svp-input svp-name-input"
          type="text"
          bind:value={draftName}
          use:keyboardGuard
          onkeydown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') renaming = false;
          }}
          onblur={commitRename}
          spellcheck="false"
        />
      {:else}
        <span class="svp-name">{cleanDisplay(shownName)}</span>
        {#if canRename}
          {#if hasAlias}
            <button
              class="svp-rename-btn svp-restore-btn"
              onclick={() => onrestore?.(variable)}
              aria-label="恢复原始名"
            >
              {@html restoreIcon}
            </button>
          {/if}
          <button class="svp-rename-btn" onclick={startRename} aria-label="重命名">{@html pencilIcon}</button>
        {/if}
      {/if}
      <em class="svp-kind" class:svp-kind-list={variable.kind === 'list'}>
        {variable.kind === 'list' ? '列表' : '变量'}
      </em>
    </div>
  </div>

  <div class="svp-controls">
    <button
      class="svp-lock-btn"
      class:svp-lock-on={variable.isLocked}
      onclick={() => ontoggleLock(variable)}
      aria-label={variable.isLocked ? '解锁' : '锁定'}
    >
      {#if variable.isLocked}
        {@html lockIcon}
      {:else}
        {@html unlockIcon}
      {/if}
    </button>
    <input
      class="svp-input svp-value-input"
      type="text"
      use:keyboardGuard
      bind:value={draft}
      oninput={onInput}
      onfocus={onFocus}
      onblur={onBlur}
      spellcheck="false"
    />
    {#if onmonitor}
      <button
        class="svp-mini-btn"
        class:svp-mini-on={monitorOn === true}
        class:svp-mini-missing={monitorOn === null}
        onclick={() => onmonitor(variable)}
        aria-label="切换监视器"
      >
        {#if monitorOn === true}
          {@html eyeIcon}
        {:else}
          {@html eyeOffIcon}
        {/if}
      </button>
    {/if}
    {#if ondelete && canDelete}
      <button
        class="svp-mini-btn svp-mini-danger"
        onclick={() => ondelete(variable)}
        aria-label="删除变量"
      >
        {@html trashIcon}
      </button>
    {/if}
  </div>
</div>
