<script lang="ts">
  import {
    BridgeStatus,
    type BridgeListener,
    type ScratchVM,
    type ScratchValue,
    type ScratchVaIMod,
    type VaIModValue,
    normalizeValue,
    stringToListValue,
  } from '../core';
  import VaIModItem from './VaIModItem.svelte';
  import CcwDataPanel from './CcwDataPanel.svelte';
  import ToolsPanel from './ToolsPanel.svelte';
  import FeishuPanel from './FeishuPanel.svelte';
  import SystemPanel from './SystemPanel.svelte';
  import SettingsOverlay from './SettingsOverlay.svelte';
  import PluginTab from './PluginTab.svelte';
  import { pluginRegistry } from '../core/plugin-registry';
  import { syncPatchPlugins, applyVariableWritePatches } from '../core/plugin-registry';
  import type { PluginProjectApi } from '../core/plugins';
  import { isBuiltinTab, pluginIdOfTab, tabLabel } from '../core/settings';
  import { fly } from 'svelte/transition';
  import type { CloudType } from '../core/ccwdata';
  import { ccwDataStore } from '../core/ccwdata';
  import { exportVaIModBundle, importVaIModBundle, applyVaIModBundleLocal, pluginInstallDetail, resolveBundleVariables, detectBundleKind, summarizeBundle, summaryText, WILDCARD } from '../core/bundle';
  import { trashAdd, trashCount } from '../core/ops-meta';
  import {
    loadDisplayNames,
    setDisplayName,
    removeDisplayName,
    clearDisplayNames,
    hasDisplayNames,
  } from '../core/display-names';
  import { secureAction } from '../core/veil-chain';
  import { loadSettingsFor, saveSettings, type Settings, type TabId } from '../core/settings';
  import refreshIcon from '../assets/refresh.svg?raw';
  import closeIcon from '../assets/close.svg?raw';
  import downloadIcon from '../assets/download.svg?raw';
  import uploadIcon from '../assets/upload.svg?raw';
  import icon from '../assets/icon.svg?raw';

  let { bridge }: { bridge: ScratchVM } = $props();

  // 显式标注 BridgeStatus 联合类型：若让 TS 从初始值推断，会被窄化成
  // 字面量 Disconnected，导致任何 `status === BridgeStatus.Connected` 比较报
  // 「无重叠类型」。这里用 as 断言保留完整联合。
  let status = $state<BridgeStatus>(BridgeStatus.Disconnected as BridgeStatus);
  let variables: ScratchVaIMod[] = $state([]);
  let errorMsg = $state('');
  let refreshing = $state(false);
  let minimized = $state(true);
  // 一次性读取初始设置（组件级普通值，供 activeTab 初始值；避免 $state 初始表达式互相引用）
  // 传入已安装插件（排除补丁：不注册 Tab）的 Tab 标识：剔除已卸载插件留下的僵尸 Tab、补齐新装插件缺的 Tab
  const bootSettings = loadSettingsFor(
    pluginRegistry
      .list()
      .filter((p) => p.def.type !== 'patch')
      .map((p) => `plug:${p.def.id}`),
  );
  // 加载模式（异步/同步）与其它共享设置；设置面板可改，改动经 onSettingsChange 通知子面板
  let settings = $state<Settings>(bootSettings);
  // 设置覆盖层（全局入口，Header 齿轮触发；即使系统标签页被隐藏也能恢复）
  let showSettings = $state(false);
  let tabLoading = $state(false);
  // 启用的 Tab 列表（按设置顺序过滤；至少一个）
  const visibleTabs = $derived(settings.tabs.filter((t) => t.enabled));
  // 已安装插件（用于 Tab 命名与插件页渲染）；registry 变化时自增版本重算
  let plugVer = $state(0);
  // $effect 包裹订阅（返回值即退订函数）；面板常驻不销毁，主要为模式统一与防御
  $effect(() => pluginRegistry.subscribe(() => (plugVer = plugVer + 1)));
  const pluginNames = $derived.by(() => {
    void plugVer;
    const m: Record<string, string> = {};
    for (const p of pluginRegistry.list()) m[p.def.id] = p.def.name;
    return m;
  });
  const pluginMap = $derived.by(() => {
    void plugVer;
    const m = new Map<string, ReturnType<typeof pluginRegistry.get>>();
    for (const p of pluginRegistry.list()) m.set(p.def.id, p);
    return m;
  });
  // 补丁不注册标签页（headless）：参与 Tab 集合/命名映射的只有扩展类插件
  const tabEligiblePlugins = $derived.by(() => {
    void plugVer;
    return pluginRegistry.list().filter((p) => p.def.type !== 'patch');
  });
  // 作品能力面（ctx.project）：bridge 背书的窄面——导出/捕获。
  // 铁律：插件拿不到 vm/bridge 本体，只暴露这组受控方法。
  const projectApi: PluginProjectApi = {
    exportSb3: () => bridge.exportProjectSb3(),
    exportSprite: (targetId) => bridge.exportSpriteSb3(targetId),
    exportSpritesZip: () => bridge.exportSpritesZip(),
    listSprites: () => bridge.listSprites(),
    setCapture: (enabled) => bridge.setProjectCapture(enabled),
    listCaptured: () => bridge.listCaptured(),
    getCapturedBlob: async (id) => bridge.getCapturedBlob(id),
    clearCaptured: () => bridge.clearCaptured(),
    onCaptured: (cb) => bridge.onProjectCaptured(cb),
  };
  // 补丁宿主：toast 走面板，变量走面板状态 + bridge 事件订阅，写走统一漏斗
  const patchHost = {
    toast: showToast,
    variables(): ReadonlyArray<{
      id: string;
      name: string;
      kind: 'variable' | 'list';
      value: unknown;
      isCloud: boolean;
      targetId: string;
      targetName: string;
      isLocked: boolean;
    }> {
      return variables;
    },
    onVariables(cb: () => void): () => void {
      // 只转发「变量变化」事件。bridge.subscribe 会广播 status/error 等全部事件，
      // 不加过滤的话每次连接状态抖动（重连/写入报错）都会被补丁误当成变量变化。
      return bridge.subscribe((event) => {
        if (event.type === 'variables') cb();
      });
    },
    write(variableId: string, value: unknown, targetId?: string): void {
      writeById(variableId, value, targetId);
    },
    project: projectApi,
  };
  /** Tab 显示名（内置查表 / 插件查插件名） */
  const tabName = (id: TabId): string => tabLabel(id, pluginNames);
  // 当前激活的插件（activeTab 是 plug:<id> 时命中）
  const activePlugin = $derived.by(() => {
    const pid = pluginIdOfTab(activeTab);
    if (!pid) return undefined;
    void plugVer;
    return pluginRegistry.get(pid);
  });
  /**
   * 常驻扩展（`async.lazy === false`）：不打开标签页也要跑 code。
   *
   * 用 headless 实例（游离 root，零面板 DOM）承载 —— 插件照常执行，只是没有可见
   * 界面；这样既兑现 lazy 语义，又不给面板加节点、不影响既有布局与命中测试。
   *
   * 必须排除**当前激活的那个**：它已经有可见实例在跑，再来一个会双跑
   * （定时器翻倍、toast 重复、写变量双发）。
   */
  const headlessPlugins = $derived.by(() => {
    void plugVer;
    const activeId = pluginIdOfTab(activeTab);
    return pluginRegistry
      .list()
      .filter(
        (p) =>
          p.def.type !== 'patch' && p.enabled && p.def.async.lazy === false && p.def.id !== activeId,
      );
  });
  // 补丁差量同步：挂载后立即对齐一次；插件安装/卸载/启停（plugVer 变化）后再对齐。
  // 幂等：已对齐状态下重复调用零副作用（无 DOM 重建、无钩子重注册）。
  $effect(() => {
    void plugVer;
    syncPatchPlugins(patchHost);
  });

  // 系统标签页是否可见（设置入口的去处；可见时无需 Header 常驻齿轮）
  const systemTabVisible = $derived(settings.tabs.some((t) => t.id === 'system' && t.enabled));
  // Header 设置齿轮显隐：只在「VM 未就绪」或「系统标签页被隐藏」时出现。
  // 前者保证等待/报错状态下也能改设置；后者保证系统页藏起来后仍有入口。
  // 两者都不成立（已连接且系统页可见）时隐藏，避免与系统页右下角入口重复占位。
  const headerSettingsVisible = $derived(
    status !== BridgeStatus.Connected || !systemTabVisible,
  );
  // 初始 activeTab 直接取第一个可见 Tab——vars 被隐藏时不至于默认加载一个看不见的页
  let activeTab = $state<TabId>(bootSettings.tabs.find((t) => t.enabled)?.id ?? 'vars');
  // 当前可见 Tab 的第一个（默认加载用）
  const defaultTabId = $derived(visibleTabs[0]?.id ?? 'vars');
  // 设置变化后若当前 Tab 被隐藏，activeTab 自动校准到第一个可见 Tab
  $effect(() => {
    if (!visibleTabs.some((t) => t.id === activeTab)) {
      activeTab = defaultTabId;
    }
  });
  // 云数据子标签记忆：在「变量/云数据」tab 间切换时保留上次打开的作品/用户子标签
  let ccwSelected = $state<CloudType>('project');
  let varsAnimKey = $state(0);
  // 内容区进入动画的 key：切 Tab / 刷新时自增 → 重播 svp-content-in（任意页面都有动画）
  let bodyAnimKey = $state(0);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // 刷新图标旋转时长：给用户明确反馈（真刷新数据重取在后面紧接着发生）
  const REFRESH_SPIN_MS = 420;
  // 插件 async.waitVm 声明 timeout: 0（不限制）时面板侧的兜底上限：见 waitVm()
  const VM_WAIT_MAX_MS = 120_000;
  let ccwPanel: { animateRefresh: () => void } | null = $state(null);
  let toolsPanel: { refresh: () => void } | null = $state(null);
  let feishuPanel: { refresh: () => void } | null = $state(null);
  let systemPanel: { refresh: () => void } | null = $state(null);
  // 插件页实例：刷新按钮在插件页调用插件声明的 refresh 钩子
  let pluginTabRef: { refresh: () => void } | null = $state(null);
  let editing = $state(false);
  let panelEl: HTMLElement | undefined = $state();
  let bodyEl: HTMLElement | undefined = $state();
  let contentEl: HTMLElement | undefined = $state();
  let fabEl: HTMLElement | undefined = $state();
  let suppressFabClick = false;
  // 分组展开状态：localStorage 记忆（跨会话）。新项目无记忆 → 默认全折叠，
  // 用户手动展开/折叠的分组状态会被记住，下次按记忆恢复。
  const GROUP_EXPAND_KEY = ['vai', 'mod', '_grp_exp'].join('');
  function loadExpandedGroups(): Set<string> {
    try {
      const raw = localStorage.getItem(GROUP_EXPAND_KEY);
      if (!raw) return new Set<string>();
      const arr = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(arr) ? (arr as string[]) : []);
    } catch {
      return new Set<string>();
    }
  }
  function saveExpandedGroups(s: Set<string>): void {
    try {
      localStorage.setItem(GROUP_EXPAND_KEY, JSON.stringify([...s]));
    } catch {
      /* ignore */
    }
  }
  let expandedGroups = $state(loadExpandedGroups());
  let dragging = $state(false);
  let userSized = false;
  let lastGrowTarget = -1;
  let growRaf = 0;

  type SavedPanelState = {
    left: number;
    top: number;
    width: number;
    height: number;
    docked: boolean;
  };
  const PANEL_STORAGE_KEY = '_p';
  // 历史键（更名前真实写盘过），保持原样才能读到旧布局状态
  const LEGACY_PANEL_STORAGE_KEY = 'valmod.panel.state';
  let savedState = $state<SavedPanelState | null>(null);

  function readSavedState(): SavedPanelState | null {
    try {
      let raw = localStorage.getItem(PANEL_STORAGE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_PANEL_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedPanelState;
      if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
        try {
          localStorage.removeItem(LEGACY_PANEL_STORAGE_KEY);
        } catch {}
        return parsed;
      }
    } catch {}
    return null;
  }

  function minimize() {
    const panel = panelEl;
    if (panel) {
      const rect = panel.getBoundingClientRect();
      savedState = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        docked: !panel.style.left || panel.style.left === 'auto',
      };
      try {
        localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(savedState));
      } catch {}
    }
    minimized = true;
  }

  function expand() {
    // 先解除隐藏，再在同一个事件帧内恢复位置/尺寸并撑到内容高度，
    // 保证淡入时高度已是最终值，避免「先恢复旧高度再自动撑高」的二次跳动
    minimized = false;
    applySavedState();
    autoGrowPanel();
    // 每次打开面板都真读一次当前页数据：收起期间变量轮询是暂停的，
    // 作品/脚本可能已经改变了变量值，展开必须直接显示最新而不是收起前的残留。
    refreshPageOnEnter();
  }

  // ===== 悬浮球（FAB）拖动 =====
  const FAB_STORAGE_KEY = '_pf';

  function saveFabState() {
    const fab = fabEl;
    if (!fab) return;
    try {
      const rect = fab.getBoundingClientRect();
      localStorage.setItem(
        FAB_STORAGE_KEY,
        JSON.stringify({ left: rect.left, top: rect.top }),
      );
    } catch {}
  }

  function restoreFabState() {
    const fab = fabEl;
    if (!fab) return;
    try {
      const raw = localStorage.getItem(FAB_STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as { left?: unknown; top?: unknown };
      if (typeof s.left === 'number' && typeof s.top === 'number') {
        fab.style.left = `${s.left}px`;
        fab.style.top = `${s.top}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      }
    } catch {}
  }

  let fabDragRaf = 0;
  let fabMoved = false;
  let fabBaseLeft = 0;
  let fabBaseTop = 0;
  let fabDx = 0;
  let fabDy = 0;
  // 线性跟随：目标位置（鼠标）+ 当前位置（每帧向目标插值）
  let fabTargetX = 0;
  let fabTargetY = 0;
  let fabCurX = 0;
  let fabCurY = 0;
  const FAB_LERP = 0.38;

  function startFabDrag(e: PointerEvent) {
    const fab = fabEl;
    if (!fab) return;
    e.preventDefault();
    e.stopPropagation();
    // 把当前位置固化为 left/top 基准（兼容 right/bottom 布局）
    const rect = fab.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    fabBaseLeft = rect.left;
    fabBaseTop = rect.top;
    fabDx = 0;
    fabDy = 0;
    fabMoved = false;
    fab.style.left = `${fabBaseLeft}px`;
    fab.style.top = `${fabBaseTop}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    // 拖动中：禁用 blur + 过渡，用 transform 合成层移动（丝滑）
    fab.classList.add('svp-fab-dragging');

    const applyMove = () => {
      fabDragRaf = 0;
      const el = fabEl;
      if (!el || !fabMoved) return;
      // 线性插值：每帧向目标位置移动固定比例，始终跟随鼠标但过程平滑完整
      fabCurX += (fabTargetX - fabCurX) * FAB_LERP;
      fabCurY += (fabTargetY - fabCurY) * FAB_LERP;
      if (
        Math.abs(fabTargetX - fabCurX) < 0.5 &&
        Math.abs(fabTargetY - fabCurY) < 0.5
      ) {
        fabCurX = fabTargetX;
        fabCurY = fabTargetY;
      }
      fabDx = fabCurX - fabBaseLeft;
      fabDy = fabCurY - fabBaseTop;
      el.style.transform = `translate3d(${fabDx}px, ${fabDy}px, 0)`;
      // 拖动期间持续 rAF，保证插值过程不中断
      if (dragging) {
        fabDragRaf = requestAnimationFrame(applyMove);
      }
    };

    const move = (ev: PointerEvent) => {
      // 边界 clamp 按实际尺寸留 4px 边距：先前写死 innerWidth-24，
      // 52px 的球右缘会越界 28px（半个球出屏）
      const fw = rect.width || 52;
      const fh = rect.height || 52;
      const x = Math.max(4, Math.min(window.innerWidth - fw - 4, ev.clientX - offsetX));
      const y = Math.max(4, Math.min(window.innerHeight - fh - 4, ev.clientY - offsetY));
      if (!fabMoved) {
        // 位移超过 5px 才算拖动，避免点击误判
        if (Math.hypot(ev.clientX - rect.left - offsetX, ev.clientY - rect.top - offsetY) < 5) {
          return;
        }
        fabMoved = true;
        dragging = true;
        fabCurX = fabBaseLeft;
        fabCurY = fabBaseTop;
      }
      fabTargetX = x;
      fabTargetY = y;
      if (!fabDragRaf) {
        fabDragRaf = requestAnimationFrame(applyMove);
      }
    };

    const up = () => {
      dragging = false;
      const el = fabEl;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (fabDragRaf) {
        cancelAnimationFrame(fabDragRaf);
        fabDragRaf = 0;
      }
      if (el) {
        el.classList.remove('svp-fab-dragging');
        if (fabMoved) {
          // 把 transform 偏移合入 left/top，清空合成层
          el.style.left = `${fabBaseLeft + fabDx}px`;
          el.style.top = `${fabBaseTop + fabDy}px`;
          el.style.transform = 'none';
          // 拖完不触发展开；短暂抑制 click
          suppressFabClick = true;
          setTimeout(() => (suppressFabClick = false), 120);
          saveFabState();
        } else {
          el.style.transform = 'none';
        }
      }
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
  }

  function fabClick() {
    if (suppressFabClick) return;
    expand();
  }

  // 窄屏（移动端）判定：命中时面板由 CSS 强制为「底部全宽抽屉」，
  // 不再套用用户保存的桌面拖拽坐标/尺寸，避免窄屏下错位、溢出视口。
  function isNarrow(): boolean {
    try {
      return window.innerWidth <= 560;
    } catch {
      return false;
    }
  }

  function applySavedState() {
    const panel = panelEl;
    if (!panel) return;
    // 移动端：清掉桌面保存的 inline 坐标/尺寸，交给 CSS 媒体查询接管
    if (isNarrow()) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.width = '';
      panel.style.height = '';
      panel.style.maxHeight = '';
      return;
    }
    const state = savedState ?? readSavedState();
    if (!state) return;
    if (!state.docked) {
      panel.style.left = `${state.left}px`;
      panel.style.top = `${state.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    if (state.width) panel.style.width = `${Math.max(MIN_PANEL_W, state.width)}px`;
    if (state.height) panel.style.height = `${Math.max(MIN_PANEL_H, state.height)}px`;
  }

  // 视口尺寸变化（横竖屏切换 / 移动端地址栏收起）：重新校准面板布局
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      if (minimized) return;
      applySavedState();
      scheduleGrow();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  });

  // 操作元数据刷新节拍：回收站 / 监视器变化后驱动列表重渲染
  let monitorTick = $state(0);
  let trashTick = $state(0);

  // 普通变量搜索（按显示名/原始名/目标名模糊匹配）；
  // 「#SVV# 值」前缀切换为按变量值匹配（大小写不敏感，容忍全宽＃，前缀后可不带空格）
  let varSearch = $state('');
  const VALUE_TAG = '#svv#';
  const splitSearch = (raw: string): { nq: string; vq: string } => {
    const q = raw.trim().toLowerCase().replace(/＃/g, '#');
    if (q.startsWith(VALUE_TAG)) return { nq: '', vq: q.slice(VALUE_TAG.length).trim() };
    return { nq: q, vq: '' };
  };
  // 模板里读这个派生值而不是直接调 splitSearch(varSearch)：避免每次组件更新都重跑一遍解析
  const searchParts = $derived(splitSearch(varSearch));
  const valueText = (v: ScratchVaIMod): string => {
    if (v == null || v.value == null) return '';
    if (Array.isArray(v.value)) return v.value.map(String).join('\n');
    return String(v.value);
  };
  // 变量项引用稳定性由桥接层保证（见 core/scratch-vm.ts 的 getVariables）：值未变的变量
  // 复用上一轮的对象引用，Svelte 的 keyed each 因此直接跳过这些行，只更新真正变化的行。
  // 面板侧不再重复做签名比对 —— 那会在每次击键过滤时对全部行各算一次签名，纯属重复开销。
  const groups = $derived.by(() => {
    void monitorTick;
    const { nq, vq } = splitSearch(varSearch);
    const map = new Map<string, ScratchVaIMod[]>();
    for (const v of variables) {
      // 清洗无效数据：缺 id / 非字符串名 的条目跳过，
      // 避免 keyed each 出现重复/缺失 key 抛异常导致渲染中断
      if (!v || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string') continue;
      if (vq) {
        if (!valueText(v).toLowerCase().includes(vq)) continue;
      } else if (nq) {
        const shown = (displayNames[nameKey(v)] ?? v.name).toLowerCase();
        const hit = shown.includes(nq) || v.name.toLowerCase().includes(nq) || (v.targetName || '').toLowerCase().includes(nq);
        if (!hit) continue;
      }
      const key = v.targetName || '未命名目标';
      const list = map.get(key) ?? [];
      list.push(v);
      map.set(key, list);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
  });

  let unsubscribe: (() => void) | undefined;

  // 显示别名（仅本地显示层）：重命名不改 vm 真实名
  let displayNames = $state(loadDisplayNames());
  const nameKey = (v: ScratchVaIMod) => ['v', v.targetId, v.id].join(':');
  // 是否有变量别名（响应式，控制「一键恢复」按钮显隐）
  const hasVarAliases = $derived(
    Object.values(displayNames).some((n) => typeof n === 'string' && n.length > 0),
  );;

  // ===== 变量页增强：新建变量 / 删除(回收站) / 监视器显隐 =====
  const targetOptions = $derived.by(() => {
    const map = new Map<string, string>();
    for (const v of variables) {
      if (v.targetId && !map.has(v.targetId)) map.set(v.targetId, v.targetName || v.targetId);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  });

  const vmTrashCount = $derived.by(() => {
    void trashTick;
    return trashCount('vm');
  });

  // 监视器当前状态映射（一次性读取，模板按变量 id 查询；缺项 = 无监视器块）
  const monitorMap = $derived.by(() => {
    void monitorTick;
    void status;
    if (bridge.getStatus() !== BridgeStatus.Connected) return new Map<string, boolean>();
    return bridge.monitorStates();
  });
  function monitorOnOf(v: ScratchVaIMod): boolean | null {
    return monitorMap.get(v.id) ?? null;
  }

  function toggleMonitor(v: ScratchVaIMod) {
    const cur = monitorOnOf(v);
    if (cur === null) {
      // 该变量没有舞台监视器块：VaIMod 不尝试自动创建（ccw 无此能力），直接提示
      showToast(`「${v.name}」该变量不支持启用监视器`, 'err');
      return;
    }
    secureAction(
      'write',
      `monitor:${v.id}`,
      () => {
        const ok = bridge.setMonitorVisible(v.id, !cur);
        if (ok) {
          monitorTick = monitorTick + 1;
          showToast(`已${!cur ? '显示' : '隐藏'}「${v.name}」的监视器`, 'ok');
        } else {
          showToast('监视器切换失败', 'err');
        }
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  function trashVariable(v: ScratchVaIMod) {
    if (v.targetName === '安全变量') {
      showToast('安全变量不支持删除', 'err');
      return;
    }
    if (v.isCloud) {
      showToast('云变量请到「云数据」页删除', 'err');
      return;
    }
    secureAction(
      'write',
      `trash:${v.id}`,
      () => {
        const raw = bridge.readVariableValue(v.id, v.targetId);
        const value = raw === null ? '' : raw;
        const alias = displayNames[nameKey(v)];
        // 解锁再删：锁定器不会再写回
        if (bridge.isVariableLocked(v.id)) bridge.unlockVariable(v.id);
        const ok = bridge.deleteVariableEntry(v.id, v.targetId);
        if (!ok) {
          showToast(`「${v.name}」删除失败`, 'err');
          return;
        }
        trashAdd({
          key: v.id,
          name: v.name,
          kind: v.kind,
          value,
          scope: 'vm',
          targetId: v.targetId,
          targetName: v.targetName,
          isCloud: v.isCloud,
          displayName: alias && alias !== v.name ? alias : undefined,
        });
        if (alias) {
          delete displayNames[nameKey(v)];
          removeDisplayName(nameKey(v));
        }
        trashTick = trashTick + 1;
        showToast(`「${v.name}」已移入回收站（可一键还原）`, 'ok');
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  // 新建普通变量行
  let creatingVar = $state(false);
  let newVarName = $state('');
  let newVarKind = $state<'variable' | 'list'>('variable');
  let newVarTarget = $state('');
  let newVarValue = $state('');
  let newVarBusy = $state(false);

  function startCreateVar() {
    newVarName = '';
    newVarValue = '';
    newVarKind = 'variable';
    newVarTarget = targetOptions[0]?.id ?? '';
    creatingVar = true;
  }

  function cancelCreateVar() {
    creatingVar = false;
  }

  function coerceNewValue(kind: 'variable' | 'list', raw: string): VaIModValue | VaIModValue[] {
    if (kind === 'list') {
      const t = raw.trim();
      if (t.startsWith('[')) {
        try {
          const arr = JSON.parse(t) as unknown;
          if (Array.isArray(arr)) return arr.map((x) => String(x));
        } catch {
          /* 落回逗号 */
        }
      }
      return stringToListValue(raw);
    }
    const t = raw.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
    return raw;
  }

  function doCreateVar() {
    if (newVarBusy) return;
    if (bridge.getStatus() !== BridgeStatus.Connected) {
      showToast('请先连接到项目', 'err');
      return;
    }
    const name = newVarName.trim();
    if (!name) {
      showToast('变量名不能为空', 'err');
      return;
    }
    if (!newVarTarget) {
      showToast('请选择目标', 'err');
      return;
    }
    const dup = bridge.nameTakenInTarget(name, newVarKind, newVarTarget);
    if (dup) {
      showToast(`「${name}」已存在于 ${dup}`, 'err');
      return;
    }
    secureAction(
      'write',
      `create-var:${name}`,
      () => {
        const init = coerceNewValue(newVarKind, newVarValue);
        newVarBusy = true;
        const r = bridge.createRuntimeVariable(
          name,
          newVarKind,
          newVarTarget,
          Array.isArray(init) ? init : (init as VaIModValue),
        );
        newVarBusy = false;
        if (!r.ok) {
          showToast(r.message ?? '新建失败', 'err');
          return;
        }
        creatingVar = false;
        // 立即刷新列表，让新变量马上出现在面板（不依赖下轮轮询/节流）
        variables = decodeVariables(bridge.getVariables());
        showToast(`已新建变量「${name}」`, 'ok');
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  function goSystem() {
    activeTab = 'system';
    userSized = false;
    editing = false;
  }

  // 面板输入框按键不冒泡到页面（防全局键盘监听干扰）
  function keyboardGuard(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
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

  // 遮罩层解密：core 下发的变量值均经 XOR 编码，UI 端统一解码显示。
  //
  // 变量读链路返回明文（遮罩层加解密只在真正出网的封包层 veil-chain 做），
  // 因此这里不再需要解码。历史上这里做过 XOR 解码，但 xorDecode 非幂等，
  // 而 bridge.getVariables() 每次返回全新对象、面板又有 4 条独立读取路径
  // （切页 / 变量事件 / 刷新 / 导入回读），只要有两条路径对同一份数据各解一次
  // 就会把明文二次异或成乱码。改为 core 端不再编码后，这类 bug 从根上消失。
  // 保留本函数作为单一收口点（顺带保证返回数组、补齐锁定间隔）。
  function decodeVariables(payload: ScratchVaIMod[]): ScratchVaIMod[] {
    if (!Array.isArray(payload)) return [];
    return payload;
  }

  /**
   * 给锁定条目补上 lockInterval（导出配置需要「锁定 + 间隔」完整信息）。
   * 解码后的对象是缓存的同一份，就地补齐即可，不必每帧都跑。
   */
  function hydrateLockIntervals(list: ScratchVaIMod[]): ScratchVaIMod[] {
    if (!Array.isArray(list) || list.length === 0) return list;
    if (!list.some((v) => v && v.isLocked && v.lockInterval === undefined)) return list;
    const map = new Map(bridge.getLockedVariables().map((l) => [l.variableId, l.interval]));
    for (const v of list) {
      if (v && v.isLocked && v.lockInterval === undefined) v.lockInterval = map.get(v.id) ?? 0;
    }
    return list;
  }

  // 性能：变量事件 rAF 合并——高频变量变化（聊天室/计分板等）时，
  // 多次事件在下一帧合并为一次解码+渲染（渲染频率 ≤ 帧率，主线程减负）；
  // 面板收起（minimized）时跳过解码只存最新 payload，展开时一次性解码。
  let pendingVars: ScratchVaIMod[] | null = null;
  let pendingRaf: number | null = null;

  function scheduleVariables(payload: ScratchVaIMod[]) {
    pendingVars = payload;
    if (minimized) return;
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      const p = pendingVars;
      pendingVars = null;
      if (p && !editing) variables = decodeVariables(p);
    });
  }

  // 展开时若有挂起的变量数据，立即解码渲染（取消未执行的 rAF）
  $effect(() => {
    if (minimized || !pendingVars) return;
    const p = pendingVars;
    pendingVars = null;
    if (pendingRaf !== null) {
      cancelAnimationFrame(pendingRaf);
      pendingRaf = null;
    }
    if (!editing) variables = decodeVariables(p);
  });

  $effect(() => {
    status = bridge.getStatus();
    errorMsg = bridge.getStatusInfo();
    variables = decodeVariables(bridge.getVariables());

    const listener: BridgeListener = (event) => {
      if (event.type === 'status') {
        status = event.payload.status;
        errorMsg =
          event.payload.status === BridgeStatus.Error ? event.payload.info ?? '未知错误' : '';
      } else if (event.type === 'variables') {
        scheduleVariables(event.payload);
      } else {
        errorMsg = event.payload.message;
      }
    };
    unsubscribe = bridge.subscribe(listener);
    return () => {
      unsubscribe?.();
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
      pendingRaf = null;
      pendingVars = null;
    };
  });

  $effect(() => {
    if (minimized || !panelEl) return;
    applySavedState();
  });

  // 悬浮球绑定后恢复上次拖动的位置
  $effect(() => {
    if (fabEl) restoreFabState();
  });

  // 面板收起时暂停变量轮询，展开时恢复：避免后台持续占用主线程导致角色卡顿
  $effect(() => {
    if (minimized) bridge.pausePolling();
    else bridge.resumePolling();
  });

  const MAX_PANEL_HEIGHT = 560;
  // 最小缩放限制：宽度 400 保证飞书页底部按钮排、标题 + 导入/导出/刷新/收起图标不被挤压错位，高度 300 保证内容可读。
  // 组件级常量：拖拽、自动撑高、状态恢复三处共用，保证面板任何路径都不会小于该尺寸。
  const MIN_PANEL_W = 400;
  const MIN_PANEL_H = 300;
  // 底部留白：自动撑高时内容与面板底边之间留出间隙，避免贴边拥挤
  const BOTTOM_GAP = 10;

  function autoGrowPanel() {
    if (minimized || dragging) return;
    // 移动端：面板尺寸由 CSS（max-height: 86vh / 全宽抽屉）接管，不做自适应，
    // 否则每次内容变化都会重设 inline 尺寸，与媒体查询互相打架造成抖动
    if (isNarrow()) return;
    const panel = panelEl;
    const body = bodyEl;
    if (!panel || !body) return;
    const content = contentEl;
    const maxH = Math.min(MAX_PANEL_HEIGHT, window.innerHeight * 0.8);
    // 等待 vm / 错误等无内容块状态：以面板自身自然高度收缩，
    // 避免「获取VM时框被撑得很大」；有内容块时才按内容高度撑高。
    // 用 body.scrollHeight（而非 content.scrollHeight）：body 上下 padding 一并计入，
    // 撑高后底部自动留出 padding 间隙，不再贴边/被截断。
    const naturalH = content
      ? panel.offsetHeight - body.clientHeight + body.scrollHeight + BOTTOM_GAP
      : panel.scrollHeight;
    // 下限钳制 MIN_PANEL_H：等待 vm / 空内容等自然高度很小时的兜底，
    // 面板不会缩到不可读/图标被压；上限 maxH 防超出视口
    const target = Math.max(MIN_PANEL_H, Math.min(naturalH, maxH));
    // 注意：宽度自适应绝不在这里调用——RO 高度循环里写 width 会让内容
    // 折行数变化 → 内容高度再变 → RO 再触发，高度/宽度互相激荡成持续
    // 微振荡（面板永不稳定，覆盖层内点击 actionability 全部超时）。
    // 宽度只在 Tab 集合变化时由专门 effect 驱动（见 scheduleFitWidth）。
    const cur = panel.offsetHeight;
    if (Math.abs(cur - target) < 2 && Math.abs(lastGrowTarget - target) < 2) return;
    // 用户手动拖过尺寸：只在内容超出时撑大，不强行缩小
    if (userSized && target < cur) return;
    lastGrowTarget = target;
    panel.classList.add('svp-grow');
    panel.style.height = `${target}px`;
  }

  // 宽度自适应：面板宽度 ≥ 标签栏自然宽度（每个 Tab 的 scrollWidth 是
  // ellipsis 压缩下的完整文本宽，flex 压缩不丢信息），标签多时自动撑宽。
  // 用户手动定宽后完全尊重用户（userSized）；右缘按视口收口防溢出。
  // 仅由「Tab 集合变化」驱动，绝不进内容 RO 高度循环（防高度/宽度振荡）。
  function autoFitWidth(panel: HTMLElement) {
    if (userSized || minimized || dragging) return;
    if (isNarrow()) return;
    const tabsEl = panel.querySelector('.svp-tabs') as HTMLElement | null;
    if (!tabsEl) return;
    const tabEls = tabsEl.querySelectorAll('.svp-tab');
    if (tabEls.length === 0) return;
    let sum = 0;
    tabEls.forEach((t) => {
      sum += (t as HTMLElement).scrollWidth;
    });
    const cs = getComputedStyle(tabsEl);
    const gaps = (tabEls.length - 1) * parseFloat(cs.columnGap || cs.gap || '0') || 0;
    const natural = sum + gaps + parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0') + 6;
    const curW = panel.offsetWidth;
    if (natural <= curW + 1) return; // 已足够宽：不动（不缩）
    // 右缘收口：面板左锚定时防止加宽溢出视口；docked（右锚定）向左伸展无溢出
    const rect = panel.getBoundingClientRect();
    const room = window.innerWidth - rect.left - 8;
    const targetW = Math.min(Math.max(Math.ceil(natural), curW), Math.max(MIN_PANEL_W, room));
    if (targetW <= curW + 1) return;
    panel.classList.add('svp-grow');
    panel.style.width = `${targetW}px`;
  }

  function scheduleGrow() {
    cancelAnimationFrame(growRaf);
    growRaf = requestAnimationFrame(autoGrowPanel);
  }

  // 状态切换（等待 vm / 错误 / 就绪）时按当前内容重新自适应高度：
  // 进入等待状态立即收缩到小高度，避免框被撑大
  $effect(() => {
    void status;
    scheduleGrow();
  });

  // 用 ResizeObserver 监听内容高度变化来自动撑高面板（rAF 合并 + 防抖），
  // 面板收起或拖拽中不处理，避免展开/伸缩时强制重排卡顿闪烁。
  $effect(() => {
    if (minimized || !contentEl || !panelEl) return;
    const ro = new ResizeObserver(() => scheduleGrow());
    ro.observe(contentEl);
    scheduleGrow();
    return () => ro.disconnect();
  });

  // 标签数量/文本变化（装卸插件、启停开关）→ 重新自适应宽度。
  // 与高度 RO 链严格解耦：宽度只跟 Tab 集合走，签名去重避免重复触发
  let lastTabSig = '';
  $effect(() => {
    const sig = visibleTabs.map((t) => t.id).join(',');
    if (sig === lastTabSig) return;
    lastTabSig = sig;
    if (minimized || !panelEl) return;
    requestAnimationFrame(() => {
      const panel = panelEl;
      if (panel) autoFitWidth(panel);
    });
  });

  async function connect() {
    errorMsg = '';
    try {
      // 连接/重连属豁免期动作：不经 SDP 层（凭证由 connect 成功后颁发），遮罩层照常校验
      await secureAction('connect', 'connect', () => bridge.connect());
    } catch {}
  }

  /** 统一写回漏斗：面板 UI 与插件 ctx.write 共用（安全栈 → 补丁拦截 → 锁同步 → vm 写） */
  function writeViaFunnel(
    meta: { id: string; name: string; targetId: string; isCloud: boolean; kind: 'variable' | 'list' },
    value: VaIModValue,
  ) {
    // 点击经统一多层安全栈（遮罩→SDP→审核→多层封印，层间安全传递）后执行
    secureAction(
      'write',
      `update:${meta.id}`,
      () => {
        let newValue: ScratchValue = meta.kind === 'list' ? stringToListValue(String(value)) : (value as ScratchValue);
        // 补丁管道：已安装的 type:'patch' 插件可在此改写/拦截写回
        //（无补丁钩子时零开销快路径）；拒绝时提示且不写 vm
        const patched = applyVariableWritePatches(newValue, {
          id: meta.id,
          name: meta.name,
          targetId: meta.targetId,
          isCloud: meta.isCloud,
          kind: meta.kind,
        });
        if (patched.rejected) {
          showToast(`「${meta.name}」写入被安全补丁拦截`, 'err');
          return;
        }
        newValue = patched.value;
        bridge.updateLockedVariableValue(meta.id, newValue);
        const ok = bridge.setVariable(meta.id, newValue, meta.targetId);
        if (!ok) {
          errorMsg = `${meta.kind === 'list' ? '列表' : '变量'} ${meta.name} 不存在`;
        }
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  /** 插件专用写入口：按 id 解析变量元数据（安全变量无需 targetId）后走统一漏斗 */
  function writeById(variableId: string, value: unknown, targetId?: string) {
    const v = variables.find((x) => x.id === variableId);
    const meta = v
      ? { id: v.id, name: v.name, targetId: v.targetId, isCloud: v.isCloud, kind: v.kind }
      : {
          id: variableId,
          name: variableId,
          targetId: targetId ?? '',
          isCloud: false,
          kind: 'variable' as const,
        };
    writeViaFunnel(meta, value as VaIModValue);
  }

  function updateVaIMod(variable: ScratchVaIMod, value: VaIModValue) {
    writeViaFunnel(variable, value);
  }

  function renameVaIMod(variable: ScratchVaIMod, name: string) {
    secureAction(
      'write',
      `rename:${variable.id}`,
      () => {
        const trimmed = name.trim();
        if (!trimmed) {
          showToast('变量名不能为空', 'err');
          return;
        }
        if (trimmed.includes('\x23BVM\x23') || trimmed === '\x23VMDBS\x23') {
          showToast('变量名不合法', 'err');
          return;
        }
        // 只改本地显示别名，不动 vm 真实名（对项目零影响）
        displayNames[nameKey(variable)] = trimmed;
        setDisplayName(nameKey(variable), trimmed);
        showToast('已重命名', 'ok');
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  // 恢复单个变量原始名（删除该显示别名）
  function restoreVaIModName(variable: ScratchVaIMod) {
    secureAction(
      'write',
      `restore:${variable.id}`,
      () => {
        const key = nameKey(variable);
        if (!displayNames[key]) return;
        delete displayNames[key];
        removeDisplayName(key);
        showToast('已恢复原始名', 'ok');
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  // 一键恢复全部变量原始名（仅清变量域 v: 前缀，云数据别名不受影响）
  function restoreAllNames() {
    secureAction(
      'write',
      'restore-all',
      () => {
        if (!hasDisplayNames('v')) {
          showToast('没有自定义名称', 'err');
          return;
        }
        for (const k of Object.keys(displayNames)) {
          if (k.startsWith('v:')) delete displayNames[k];
        }
        clearDisplayNames('v');
        showToast('已全部恢复原始名', 'ok');
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  function toggleLock(v: ScratchVaIMod) {
    secureAction(
      'lock',
      v.id ? `lock:${v.id}` : 'lock',
      () => {
        if (bridge.isVariableLocked(v.id)) {
          bridge.unlockVariable(v.id);
        } else {
          bridge.lockVariable(v.id, v.value, v.targetId, 0);
        }
      },
      { alive: () => bridge.getStatus() === BridgeStatus.Connected },
    );
  }

  function startDrag(e: MouseEvent) {
    const panel = panelEl;
    if (!panel || (e.target as HTMLElement).closest('button')) return;
    // 移动端面板是底部全宽抽屉，拖动窗口位置没有意义，直接禁用
    if (isNarrow()) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const baseX = rect.left;
    const baseY = rect.top;
    const offX = e.clientX - baseX;
    const offY = e.clientY - baseY;
    // 跟手位移走 transform: translate3d —— 合成层位移零 layout/paint；
    // 直写 left/top 每帧强制整面板重排（掉帧根因）。
    // left/top 固化延迟到首次实际移动（纯点击不解除停靠状态）
    let dx = 0;
    let dy = 0;
    let moved = false;
    let raf = 0;
    const apply = () => {
      raf = 0;
      panel.style.transform = `translateZ(0) translate3d(${dx}px, ${dy}px, 0)`;
    };
    const move = (ev: MouseEvent) => {
      // clamp 等价原 left/top ≥0 逻辑：dx = max(-baseX, clientX - startX)
      dx = Math.max(-baseX, ev.clientX - offX - baseX);
      dy = Math.max(-baseY, ev.clientY - offY - baseY);
      if (!moved) {
        moved = true;
        panel.style.left = `${baseX}px`;
        panel.style.top = `${baseY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.classList.add('svp-panel-dragging');
        dragging = true; // 门控 autoGrow / fitH，拖拽中不让高度伸缩插手
      }
      if (!raf) raf = requestAnimationFrame(apply); // 高频鼠标合帧到每帧一次
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
      if (!moved) return; // 纯点击：什么都没动，保持停靠状态
      // 落位：transform 位移写回 left/top，inline transform 清空恢复 CSS 控制。
      // 【关键时序】所有「值变化」必须在 dragging 类（transition:none）仍在的
      // 这一帧完成；类延迟到下一帧（rAF）再移除——若同帧写值又删类，浏览器的
      // 样式批处理会让 transition:none 从未生效，显示态的 transform 0.2s 过渡
      // 捕捉到「translate3d(dx,dy) → 无位移」的变化 → 面板飞出整个拖距再滑回（抽搐）。
      // 下一帧移除类时所有属性值均无变化 → 不触发任何过渡。
      panel.style.left = `${Math.max(0, baseX + dx)}px`;
      panel.style.top = `${Math.max(0, baseY + dy)}px`;
      panel.style.transform = '';
      requestAnimationFrame(() => {
        panel.classList.remove('svp-panel-dragging');
        dragging = false;
        document.body.style.cursor = '';
      });
    };
    document.body.style.cursor = 'grabbing';
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('mouseup', up);
  }

  function startResize(e: MouseEvent) {
    const panel = panelEl;
    if (!panel) return;
    // 移动端面板全宽固定，禁用右下角拖拽缩放（改为可下拉的手势区，见 CSS）
    if (isNarrow()) return;
    e.preventDefault();
    e.stopPropagation();
    // 手动拉伸不设上限（inline 覆盖 CSS max-height）；自动拉伸仍由 autoGrow 限制
    panel.style.maxHeight = 'none';
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = panel.offsetWidth;
    const startHeight = panel.offsetHeight;
    dragging = true;
    userSized = true;
    panel.classList.remove('svp-grow');
    // 面板自身也标记 resizing，确保拖拽期间禁用一切过渡（跟手）
    panel.classList.add('svp-resizing');
    const root = panel.closest('.svp');
    root?.classList.add('svp-resizing');

    let px = 0;
    let py = 0;
    let raf = 0;
    const move = (ev: MouseEvent) => {
      px = Math.max(MIN_PANEL_W, startWidth + (ev.clientX - startX));
      py = Math.max(MIN_PANEL_H, startHeight + (ev.clientY - startY));
      if (!raf) raf = requestAnimationFrame(apply); // 高频鼠标合帧到每帧一次
    };
    const apply = () => {
      raf = 0;
      panel.style.width = `${px}px`;
      panel.style.height = `${py}px`;
    };
    const up = () => {
      dragging = false;
      if (raf) cancelAnimationFrame(raf);
      panel.classList.remove('svp-resizing');
      root?.classList.remove('svp-resizing');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    document.body.style.cursor = 'nwse-resize';
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('mouseup', up);
  }

  function startEdit() {
    editing = true;
  }

  function endEdit() {
    editing = false;
    variables = decodeVariables(bridge.getVariables());
  }

  // ===== 刷新：任何 Tab 都做「真刷新」+ 动画 =====
  // 真刷新 = 绕过缓存，重新从数据源取一次（vm 变量 / 云数据镜像 / 各子面板自身状态），
  // 而不是只播旋转动画。动画与数据重取解耦：动画快（400ms 反馈），
  // 数据重取按各 Tab 的真实路径走，未就绪时等待就绪再取。
  function spinFeedback() {
    refreshing = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => (refreshing = false), REFRESH_SPIN_MS);
  }

  /** 等待 vm 就绪（连接中）后执行；已就绪立即执行；出错则放弃 */
  function whenReady(fn: () => void) {
    if (bridge.getStatus() === BridgeStatus.Connected) {
      fn();
      return;
    }
    if (bridge.getStatus() === BridgeStatus.Error) return;
    let tries = 0;
    const wait = setInterval(() => {
      const st = bridge.getStatus();
      if (st === BridgeStatus.Connected) {
        clearInterval(wait);
        fn();
      } else if (st === BridgeStatus.Error || ++tries > 75) {
        clearInterval(wait);
        refreshing = false;
      }
    }, 200);
  }

  /**
   * Promise 版「等 vm 就绪」——供插件 async.load / async.waitVm 使用
   * （runPluginBoot 是 await 语义，需要明确结论，不能像 whenReady 那样静默放弃）。
   *
   * 与 whenReady 的分工：whenReady 是「就绪后做某事」的回调式（面板自身刷新用，
   * 超时就悄悄收工）；这里必须 resolve 一个布尔值——true=就绪、false=超时/桥接出错，
   * 插件侧据此决定是否执行 code（见 runPluginBoot 的契约）。
   *
   * timeoutMs <= 0（插件清单里 timeout: 0 = 不限制）时按 VM_WAIT_MAX_MS 兜底：
   * 桥接从未就绪时无限挂起会留下永不清理的定时器，这里给一个「实际等于不限制、
   * 但一定会终止」的上限。
   */
  function waitVm(timeoutMs: number): Promise<boolean> {
    if (bridge.getStatus() === BridgeStatus.Connected) return Promise.resolve(true);
    if (bridge.getStatus() === BridgeStatus.Error) return Promise.resolve(false);
    const limit = timeoutMs > 0 ? timeoutMs : VM_WAIT_MAX_MS;
    return new Promise<boolean>((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const st = bridge.getStatus();
        if (st === BridgeStatus.Connected) {
          clearInterval(timer);
          resolve(true);
        } else if (st === BridgeStatus.Error || Date.now() - startedAt >= limit) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  }

  /**
   * 进入某页时的「数据真刷新」——静默版（不转圈、不重播动画）。
   *
   * 面板从收起状态展开、或切换到某个标签页时调用。之所以必须真读 vm：
   * 收起 / 离开期间变量轮询是暂停的，页面里的作品脚本可能已经改变了变量值，
   * 沿用面板里那份旧数组就会显示过期数据。
   *
   * 未连接时直接返回 —— 此时 getVariables() 只会给出空数组，
   * 用它覆盖会把当前列表清空（比显示旧数据更糟）。
   */
  function refreshPageOnEnter() {
    if (activePlugin) {
      // 插件页：执行插件声明的 refresh 钩子（未定义则 no-op）
      pluginTabRef?.refresh();
      return;
    }
    if (activeTab === 'ccw') {
      ccwPanel?.animateRefresh();
      return;
    }
    if (bridge.getStatus() !== BridgeStatus.Connected) return;
    // forceRefresh 清掉桥接层变更摘要并立即重发列表（真读 vm，非缓存）
    bridge.forceRefresh();
    variables = decodeVariables(bridge.getVariables());
    if (activeTab === 'tools') toolsPanel?.refresh();
    else if (activeTab === 'feishu') feishuPanel?.refresh();
    else if (activeTab === 'system') systemPanel?.refresh();
  }

  function refresh() {
    // 点击经统一多层安全栈执行（refresh 为豁免期动作：连接中可点，等 vm 就绪后取变量）
    secureAction('refresh', 'refresh', () => {
      if (refreshing) return;
      // 主动复位 editing：输入框可能残留聚焦，会挡住刷新触发与变量回写
      editing = false;
      spinFeedback();

      if (activePlugin) {
        // 插件页：执行插件声明的 refresh 钩子（未定义则仅旋转反馈）。
        // 注意不增 bodyAnimKey——那会把插件页整个重挂载（销毁插件运行状态），
        // 钩子自己负责数据重取/重渲染，才是插件语义下的真刷新。
        pluginTabRef?.refresh();
        return;
      }

      // 每个 Tab 都重播进入动画（内容重取后视觉上有明确反馈）
      bodyAnimKey = bodyAnimKey + 1;

      if (activeTab === 'ccw') {
        // 云数据：直接调面板自身的真刷新（force 模式，不重建组件、不重置子标签）
        ccwPanel?.animateRefresh();
        return;
      }

      if (activeTab === 'vars') varsAnimKey = varsAnimKey + 1;
      // 变量 / 工具 / 飞书 / 系统：数据源都是 vm 变量 + 本地存储，
      // 统一走一次真实重取（变量列表刷新 + 子面板自刷新），而非空转动画。
      whenReady(refreshPageOnEnter);
    });
  }

  function toggleGroup(name: string) {
    const next = new Set(expandedGroups);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    expandedGroups = next;
    saveExpandedGroups(next);
  }

  function switchTab(t: TabId) {
    // 点当前 Tab 也算「打开该标签页」→ 走一次完整刷新（转圈 + 进入动画 + 真读 vm），
    // 不再像以前那样直接 return（否则想手动刷新当前页只能去找右上角刷新按钮）。
    if (t === activeTab) {
      if (tabLoading) return; // 正在挂载中，忽略重复点击
      refresh();
      return;
    }
    // 切换内容后让面板按新内容自适应，重置手动尺寸标记
    userSized = false;
    // 变量输入框可能正在聚焦：切 Tab 时组件卸载不会触发 blur，
    // 主动复位 editing，避免变量轮询被永久冻结
    editing = false;
    // 每次切页都重播内容进入动画（任意页面都有动画，不只是变量/云数据）
    bodyAnimKey = bodyAnimKey + 1;
    // 挂载目标 Tab：切到变量页时自动重读一次最新变量——
    // 离开期间脚本/作品可能已改值，回来要显示最新，不能依赖旧缓存
    const mountTab = () => {
      activeTab = t;
      tabLoading = false;
      // 进入任意页都真读一次最新变量（离开期间作品/脚本可能已改值），而不是只对变量页重读。
      // 这里不调各子面板的 refresh 钩子：body 由 {#key `${activeTab}:${bodyAnimKey}`} 整体重建，
      // 此刻 bind:this 拿到的仍是即将销毁的旧实例，调它没有意义（新实例挂载时会自己取数）。
      // 未连接时跳过 —— 否则 getVariables() 的空数组会把当前列表清空。
      if (bridge.getStatus() === BridgeStatus.Connected) {
        bridge.forceRefresh();
        variables = decodeVariables(bridge.getVariables());
      }
    };
    if (settings.loadMode === 'sync') {
      mountTab();
      return;
    }
    // 异步加载（默认）：先渲染一帧 loading 再挂载内容，避免变量/云数据面板
    // 同步重挂载 + 解码造成的切页卡顿。双 rAF 保证 loading 至少可见一帧，
    // setTimeout 兜底（无头/后台 rAF 不触发也不卡住）。
    tabLoading = true;
    let mounted = false;
    const mount = () => {
      if (mounted) return;
      mounted = true;
      mountTab();
    };
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(() => raf(mount));
      setTimeout(mount, 40);
    } else {
      setTimeout(mount, 0);
    }
  }

  // 设置面板改动回调：同步到各面板 + 持久化
  function onSettingsChange(next: Settings) {
    // 过一遍 normalizeSettings（带已安装插件标记）：剔除已卸载插件的僵尸 Tab、
    // 补齐新装插件缺的 Tab —— 但「此处」的改动来自用户操作，不能反过来
    // 把用户刚关掉的插件 Tab 又自动打开，因此仅做僵尸剔除 + 内置补齐。
    const known = tabEligiblePlugins.map((p) => `plug:${p.def.id}`);
    const knownSet = new Set(known);
    const cleaned = next.tabs.filter(
      (t) => !pluginIdOfTab(t.id) || knownSet.has(t.id),
    );
    const merged: Settings = cleaned.length > 0 ? { ...next, tabs: cleaned } : next;
    settings = merged;
    // 当前 Tab 被隐藏/卸载 → 自动切到第一个仍启用的 Tab（保证逻辑自洽）
    const enabledIds = merged.tabs.filter((t) => t.enabled).map((t) => t.id);
    if (!enabledIds.includes(activeTab)) {
      const fallback = enabledIds[0];
      if (fallback) activeTab = fallback;
    }
  }

  // 插件安装/卸载/启停后：Tab 列表与插件集合保持一致 ——
  //   新装 → 补进列表（默认启用）；卸载 → 剔除僵尸 Tab；
  //   禁用插件 → 对应 Tab 一并隐藏（显隐随插件启停，避免「关了插件页还挂着」）。
  // 补丁类插件（type:'patch'）不注册标签页，不参与本对齐。
  // 只在集合/对齐状态真变化时才写设置；写完再跑一次即满足早退条件，不会自激。
  $effect(() => {
    void plugVer;
    const list = tabEligiblePlugins;
    const knownSet = new Set(list.map((p) => `plug:${p.def.id}`));
    const enabledMap = new Map(list.map((p) => [`plug:${p.def.id}`, p.enabled] as const));
    const cur = settings.tabs;
    const hasZombie = cur.some((t) => pluginIdOfTab(t.id) && !knownSet.has(t.id));
    const missing = list
      .map((p) => `plug:${p.def.id}`)
      .filter((id) => !cur.some((t) => t.id === id));
    const misaligned = cur.some((t) => {
      const pid = pluginIdOfTab(t.id);
      if (!pid) return false;
      const en = enabledMap.get(`plug:${pid}`);
      return en !== undefined && en !== t.enabled;
    });
    if (!hasZombie && missing.length === 0 && !misaligned) return;
    const kept = cur
      .filter((t) => !pluginIdOfTab(t.id) || knownSet.has(t.id))
      .map((t) => {
        const pid = pluginIdOfTab(t.id);
        const en = pid ? enabledMap.get(`plug:${pid}`) : undefined;
        return en === undefined ? t : { ...t, enabled: en };
      });
    for (const id of missing) kept.push({ id: id as TabId, enabled: true });
    const next: Settings = { ...settings, tabs: kept };
    saveSettings(next);
    settings = next;
  });

  type ConfigVariable = {
    name: string;
    targetName: string;
    kind: 'variable' | 'list';
    value: ScratchValue;
    isLocked: boolean;
    lockInterval?: number;
  };
  type VaIModConfig = {
    app: 'VaIMod';
    project: string;
    exportedAt: string;
    variables: ConfigVariable[];
  };

  let toast = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let fileInputEl: HTMLInputElement | undefined = $state();

  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    toast = { text, kind };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2500);
  }

  function getProjectOid(): string | null {
    // 与 ops-meta.currentOid / official-cloud.resolveProjectOid 同规则：覆盖
    // detail/creation/p/project/work 路径且要求 16 位以上 hex —— 旧实现只认 /detail/
    // 且不限长度，非 detail 路径导出会报「无法获取 oid」，短片段又可能被误当 oid。
    try {
      const m = window.location.pathname.match(
        /\/(?:detail|creation|p|project|work)\/([0-9a-fA-F]{16,})/,
      );
      return m ? m[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function exportConfig() {
    // 导出 = 读操作：统一安全栈（遮罩→SDP read→审核→多层封印）通过后才读取并生成 JSON
    return secureAction('read', 'export-config', () => {
      const oid = getProjectOid();
      if (!oid) {
        showToast('无法从当前网址获取项目 oid', 'err');
        return;
      }
      // 用面板已解码的明文变量导出（bridge.getVariables() 返回的是密文，不可直出）
      const bundle = exportVaIModBundle({
        variables: hydrateLockIntervals(variables),
        project: oid,
        cloudProject: ccwDataStore.ready
          ? (ccwDataStore.project.toJSON() as Record<string, unknown>)
          : {},
        cloudUser: ccwDataStore.ready
          ? (ccwDataStore.user.toJSON() as Record<string, unknown>)
          : {},
        // 机器人不传：由 bundle 层从本地登记表读取，保证导出即完整备份
        settings,
        // 项目原始值基线（连接后首次读取时由桥接层记下）→ 用于导出「哪些变量被改过、原值多少」
        origins: bridge.getOriginValues(),
      });
      // 插件源码 / 装机清单 / 各插件自己的设置由 bundle 层从 registry 现读，导出即完整备份
      const sum = summarizeBundle(bundle);
      showToast(`已导出配置 · ${summaryText(sum)}`);
    });
  }

  function importConfig() {
    // 不强制要求已连接：配置包里的设置/别名/快照/回收站/机器人都能离线导入，
    // 变量部分在未连接时会记为「未匹配」并在结果里如实汇报。
    fileInputEl?.click();
  }

  function toScratchValue(kind: 'variable' | 'list', raw: unknown): ScratchValue {
    if (kind === 'list') {
      return Array.isArray(raw) ? (raw as ScratchValue) : stringToListValue(String(raw));
    }
    if (Array.isArray(raw)) return String(raw[0] ?? '');
    return normalizeValue(raw);
  }

  async function onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        showToast('文件不是合法 JSON，请确认导出来源', 'err');
        return;
      }
      // 先识别格式（完整包 / 旧版仅变量 / 无法识别），再决定如何应用
      const kind = detectBundleKind(raw);
      if (kind === 'unknown') {
        showToast('无法识别该配置文件：既不是 VaIMod 完整配置包，也不是变量配置', 'err');
        return;
      }
      const bundle = importVaIModBundle(raw);
      if (!bundle) {
        showToast('配置文件内容为空或格式不正确', 'err');
        return;
      }
      const currentOid = getProjectOid();
      // 大小写不敏感比较：历史导出包可能存的是大写 hex，不能让格式差异挡掉合法导入
      if (
        bundle.project &&
        currentOid &&
        bundle.project.toLowerCase() !== currentOid.toLowerCase()
      ) {
        showToast(`该配置属于其他项目（${bundle.project}），不能导入到当前项目`, 'err');
        return;
      }
      const sum = summarizeBundle(bundle);
      // 导入前预览确认：让用户明确知道将写入什么，避免误覆盖
      const legacyTip = kind === 'legacy-vars' ? '\n（识别为旧版「仅变量」配置，仅导入变量）' : '';
      const wildTip = sum.wildcard > 0
        ? `\n（含 ${sum.wildcard} 条通配「*」条目：将自动套用到当前项目的所有变量）`
        : '';
      const plugTip = sum.plugins > 0 ? `\n（含 ${sum.plugins} 个插件：将自动解析安装，已存在的相同插件跳过）` : '';
      // 「仅插件包」（设置页导出全部插件）：只装插件，其余字段是空占位，
      // 绝不能拿它去覆盖变量 / 别名 / 云数据 / 快照 / 回收站 / 设置。
      if (bundle.pluginsOnly === true) {
        if (
          !confirm(
            `即将导入插件包：\n${summaryText(sum)}${plugTip}\n\n` +
              '仅安装插件并还原插件设置与启用态，不改动变量 / 别名 / 云数据 / 还原点 / 回收站 / 设置，是否继续？',
          )
        ) {
          showToast('已取消导入');
          return;
        }
        await secureAction('write', 'import-apply', async () => {
          const local = applyVaIModBundleLocal(bundle);
          const plugDetail = pluginInstallDetail(bundle);
          const parts: string[] = [`插件 ${local.plugins}`];
          if (local.pluginSettings) parts.push(`插件设置 ${local.pluginSettings}`);
          if (local.pluginState) parts.push(`启用态 ${local.pluginState}`);
          if (plugDetail.skipped) parts.push(`跳过重复 ${plugDetail.skipped}`);
          if (plugDetail.failed.length > 0) parts.push(`插件失败 ${plugDetail.failed.length}`);
          showToast(
            `已导入 · ${parts.join(' · ')}`,
            plugDetail.failed.length > 0 ? 'err' : 'ok',
          );
        });
        return;
      }
      if (
        !confirm(
          `即将导入配置：\n${summaryText(sum)}${legacyTip}${wildTip}${plugTip}\n\n` +
            '变量/别名/还原点/回收站/机器人/设置/插件(含插件设置与启用态)将被覆盖，是否继续？',
        )
      ) {
        showToast('已取消导入');
        return;
      }
      // 应用写入段整体过统一多层安全栈（遮罩→SDP write→审核→多层封印）
      await secureAction('write', 'import-apply', async () => {
      const current = bridge.getVariables();
      // 变量落地：具名条目精确匹配 + 通配「*」条目自动套用到其余全部变量
      // （因此作品里新增的变量无需改配置也会被纳入锁定/默认值策略）
      const { writes, unmatched: missed } = resolveBundleVariables(
        bundle.variables,
        current.map((v) => ({
          id: v.id,
          name: v.name,
          kind: v.kind,
          isCloud: v.isCloud,
          targetId: v.targetId,
          targetName: v.targetName,
        })),
      );
      let matched = 0;
      let wildApplied = 0;
      for (const w of writes) {
        const value = toScratchValue(w.kind, w.value);
        bridge.updateLockedVariableValue(w.variableId, value);
        bridge.setVariable(w.variableId, value, w.targetId);
        if (w.isLocked) {
          bridge.lockVariable(w.variableId, value, w.targetId, w.lockInterval ?? 0);
        } else {
          bridge.unlockVariable(w.variableId);
        }
        matched++;
        if (w.from === 'wildcard') wildApplied++;
      }
      const unmatched = missed.length;
      // 2. 其它本地配置（别名 / 机器人 / 快照 / 回收站 / 设置 / 插件）全量覆盖
      const local = applyVaIModBundleLocal(bundle);
      const plugDetail = pluginInstallDetail(bundle);
      // 3. 云数据镜像：写入 ccwDataStore 本地 Map（不触发 setValue，避免回源）
      let cloudWritten = 0;
      if (ccwDataStore.ready) {
        for (const [k, v] of Object.entries(bundle.cloudProject)) {
          ccwDataStore.project.set(k, v);
          cloudWritten++;
        }
        for (const [k, v] of Object.entries(bundle.cloudUser)) {
          ccwDataStore.user.set(k, v);
          cloudWritten++;
        }
      }
      // 4. 设置：写入 localStorage + 同步面板
      saveSettings(bundle.settings);
      onSettingsChange(bundle.settings);
      // 5. 刷新本地变量列表（真读 vm）
      variables = decodeVariables(bridge.getVariables());
      const parts: string[] = [`变量 ${matched}`];
      if (local.plugins) parts.push(`插件 ${local.plugins}${plugDetail.skipped ? `（跳过重复 ${plugDetail.skipped}）` : ''}`);
      if (local.pluginSettings) parts.push(`插件设置 ${local.pluginSettings}`);
      if (local.pluginState) parts.push(`启用态 ${local.pluginState}`);
      if (wildApplied) parts.push(`通配套用 ${wildApplied}`);
      if (unmatched) parts.push(`未匹配 ${unmatched}`);
      if (local.displayNames > 0) parts.push(`别名 ${local.displayNames}`);
      if (cloudWritten) parts.push(`云数据 ${cloudWritten}`);
      if (local.robots) parts.push(`机器人 ${local.robots}`);
      if (local.markers) parts.push(`还原点 ${local.markers}`);
      if (local.trash) parts.push(`回收站 ${local.trash}`);
      if (plugDetail.failed.length > 0) parts.push(`插件失败 ${plugDetail.failed.length}`);
      showToast(
        `已导入 · ${parts.join(' · ')}`,
        unmatched > 0 || plugDetail.failed.length > 0 ? 'err' : 'ok',
      );
      });
    } catch (err) {
      showToast(
        `导入失败：${err instanceof Error ? err.message : String(err)}`,
        'err',
      );
    }
  }
</script>

<div class="svp" style:--svp-primary={settings.accentColor}>
  <button
    bind:this={fabEl}
    class="svp-fab"
    class:svp-fab-hidden={!minimized}
    onclick={fabClick}
    onpointerdown={startFabDrag}
    aria-label="展开面板"
  >
    {@html icon}
  </button>
  <section
    bind:this={panelEl}
    class="svp-panel"
    class:svp-panel-hidden={minimized}
  >
      <header
        role="toolbar"
        tabindex="0"
        class="svp-header"
        onmousedown={startDrag}
        ondblclick={(e) => {
          // 双击按钮（快速连点刷新/收起等）不触发整栏收起，避免误关面板
          if ((e.target as HTMLElement).closest('button')) return;
          minimize();
        }}
      >
        <span class="svp-title">
          <span class="svp-title-icon">{@html icon}</span>
          VaIMod
        </span>
        <div class="svp-actions">
          <button
            class="svp-icon-btn"
            onclick={importConfig}
            aria-label="导入配置"
          >
            {@html uploadIcon}
          </button>
          <button
            class="svp-icon-btn"
            onclick={exportConfig}
            aria-label="导出配置"
          >
            {@html downloadIcon}
          </button>
          <input
            bind:this={fileInputEl}
            class="svp-file-input"
            type="file"
            accept=".json,application/json"
            tabindex="-1"
            onchange={onFileSelected}
          />
          <button
            class="svp-icon-btn"
            class:svp-spin={refreshing}
            onclick={refresh}
            aria-label="刷新"
          >
            {@html refreshIcon}
          </button>
          <!-- 设置入口（条件显隐）：VM 未就绪 或 系统标签页被隐藏 时出现。
               已连接且系统页可见时不显示 —— 系统页右下角已有同源入口，
               重复放置会让 Header 多占一格，也可能被误当成「面板出问题」。 -->
          {#if headerSettingsVisible}
            <button
              class="svp-icon-btn svp-icon-enter"
              class:svp-icon-on={showSettings}
              onclick={() => (showSettings = !showSettings)}
              aria-label="设置"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          {/if}
          <button class="svp-icon-btn" onclick={minimize} aria-label="收起">
            {@html closeIcon}
          </button>
        </div>
      </header>

      <!-- 只剩一个可见 Tab 时整条标签栏没有信息量，直接隐藏让内容更干净 -->
      {#if visibleTabs.length > 1}
        <div class="svp-tabs">
          {#each visibleTabs as t (t.id)}
            <button
              class="svp-tab"
              class:svp-tab-active={activeTab === t.id}
              onclick={() => switchTab(t.id)}
            >
              {tabName(t.id)}
            </button>
          {/each}
        </div>
      {/if}

      <div bind:this={bodyEl} class="svp-body">
        {#if toast}
          <div class="svp-toast" class:svp-toast-err={toast.kind === 'err'} out:fly={{ y: -8, duration: 140 }}>
            {toast.text}
          </div>
        {/if}
        {#if status === BridgeStatus.Error}
          <div class="svp-error">
            <p>{errorMsg}</p>
            <button class="svp-btn" onclick={connect}>重新获取</button>
          </div>
        {:else if status === BridgeStatus.Connecting || status === BridgeStatus.Disconnected}
          <div class="svp-loading">等待获取vm</div>
        {:else}
          <div class="svp-body-content" bind:this={contentEl}>
            {#if tabLoading}
              <div class="svp-loading">加载中…</div>
            {:else}
            {#key `${activeTab}:${bodyAnimKey}`}
              {#if activeTab === 'vars'}
                {#if creatingVar}
                  <div class="svp-var-create">
                    <div class="svp-field svp-row2">
                      <input
                        class="svp-input"
                        type="text"
                        bind:value={newVarName}
                        placeholder="变量名"
                        spellcheck="false"
                        use:keyboardGuard
                      />
                      <select class="svp-input svp-select" bind:value={newVarKind}>
                        <option value="variable">变量</option>
                        <option value="list">列表</option>
                      </select>
                    </div>
                    <div class="svp-field svp-row2">
                      <select class="svp-input svp-select" bind:value={newVarTarget}>
                        {#each targetOptions as t}
                          <option value={t.id}>{t.name}</option>
                        {/each}
                      </select>
                      <input
                        class="svp-input"
                        type="text"
                        bind:value={newVarValue}
                        placeholder="初始值（列表填 JSON 或逗号分隔）"
                        spellcheck="false"
                        use:keyboardGuard
                        onkeydown={(e) => {
                          if (e.key === 'Enter') doCreateVar();
                        }}
                      />
                    </div>
                    <div class="svp-btnrow">
                      <button class="svp-btn svp-btn-sm" onclick={doCreateVar} disabled={newVarBusy || !newVarName.trim()}>
                        {newVarBusy ? '创建中…' : '创建'}
                      </button>
                      <button class="svp-btn svp-btn-ghost svp-btn-sm" onclick={cancelCreateVar}>取消</button>
                    </div>
                  </div>
                {/if}
                <div class="svp-actionbar">
                  <button class="svp-new-cloud" onclick={() => (creatingVar ? (creatingVar = false) : startCreateVar())}>
                    {creatingVar ? '收起新建' : '＋ 新建变量'}
                  </button>
                  {#if vmTrashCount > 0}
                    <button class="svp-trashbar-go svp-inline" onclick={goSystem}>
                      回收站 {vmTrashCount} ›
                    </button>
                  {/if}
                </div>
                <div class="svp-searchbar">
                  <input
                    class="svp-input"
                    type="text"
                    bind:value={varSearch}
                    placeholder="搜索变量或值…"
                    spellcheck="false"
                    aria-label="搜索变量"
                    use:keyboardGuard
                  />
                  {#if varSearch}
                    <button class="svp-search-clear" onclick={() => (varSearch = '')} aria-label="清除搜索">×</button>
                  {/if}
                </div>
                {#if searchParts.vq}
                  <div class="svp-search-mode">按变量值匹配</div>
                {/if}
                {#key varsAnimKey}
                  {#if hasVarAliases}
                    <div class="svp-actionbar">
                      <button class="svp-restore-all" onclick={restoreAllNames}>
                        一键恢复原始名
                      </button>
                    </div>
                  {/if}
                  {#each groups as g, gidx (g.name)}
                    <div
                      class="svp-group svp-group-enter"
                      style:animation-delay={`${Math.min(gidx * 55, 330)}ms`}
                    >
                      <button
                        type="button"
                        class="svp-group-title"
                        class:svp-group-collapsed={!expandedGroups.has(g.name)}
                        aria-expanded={expandedGroups.has(g.name)}
                        onclick={() => toggleGroup(g.name)}
                      >
                        <span
                          class="svp-caret"
                          class:svp-caret-open={expandedGroups.has(g.name)}
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </span>
                        <span class="svp-group-name">{g.name}</span>
                        <em>{g.items.length}</em>
                      </button>
                      {#if expandedGroups.has(g.name)}
                        <div class="svp-group-items">
                          {#each g.items as v (`${v.targetId}:${v.id}`)}
                            <VaIModItem
                              variable={v}
                              displayName={displayNames[nameKey(v)]}
                              onupdate={updateVaIMod}
                              ontoggleLock={toggleLock}
                              onrename={renameVaIMod}
                              onrestore={restoreVaIModName}
                              canRename={v.targetName !== '\u5b89\u5168\u53d8\u91cf'}
                              ondelete={trashVariable}
                              canDelete={v.targetName !== '\u5b89\u5168\u53d8\u91cf' && !v.isCloud}
                              onmonitor={toggleMonitor}
                              monitorOn={monitorOnOf(v)}
                              oneditstart={startEdit}
                              oneditend={endEdit}
                            />
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}

                  {#if groups.length === 0}
                    <div class="svp-empty">当前项目没有可修改的变量</div>
                  {/if}
                {/key}
              {/if}
              {#if activeTab === 'ccw'}
                <CcwDataPanel active={!minimized} bind:selected={ccwSelected} bind:this={ccwPanel} onOpenSystem={goSystem} />
              {/if}
              {#if activeTab === 'tools'}
                <ToolsPanel bridge={bridge} variables={variables} bind:this={toolsPanel} />
              {/if}
              {#if activeTab === 'feishu'}
                <FeishuPanel variables={variables} bind:this={feishuPanel} />
              {/if}
              {#if activeTab === 'system'}
                <SystemPanel bind:this={systemPanel} bridge={bridge} variables={variables} active={!minimized} {settings} onOpenSettings={() => (showSettings = true)} showSettingsEntry={!headerSettingsVisible} />
              {/if}
              {#if activePlugin}
                <!-- 键只含插件 id：其它插件的注册表事件（安装/启停）不重建本页；
                     同 id 升级时 registry.get 返回新对象 → plugin prop 替换 → 组件内部 effect 重建 -->
                {#key activePlugin.def.id}
                  <PluginTab bind:this={pluginTabRef} plugin={activePlugin} {variables} {projectApi} {waitVm} defer={settings.loadMode !== 'sync'} onToast={showToast} onWrite={writeById} />
                {/key}
              {:else if !isBuiltinTab(activeTab)}
                <p class="svp-empty">该插件已卸载或未启用。</p>
              {/if}
            {/key}
            {/if}
          </div>
        {/if}
      </div>
      <!-- 常驻扩展（async.lazy === false）：headless 实例不产生任何 DOM，
           放在内容区之外，连接状态变化/标签页切换都不会卸载它们。 -->
      {#each headlessPlugins as hp (hp.def.id)}
        <PluginTab plugin={hp} {variables} {projectApi} {waitVm} headless onToast={showToast} onWrite={writeById} />
      {/each}
      <button class="svp-resize-handle" onmousedown={startResize} aria-label="拖拽调整面板大小"></button>
      {#if showSettings}
        <SettingsOverlay
          {settings}
          onChange={onSettingsChange}
          onClose={() => (showSettings = false)}
        />
      {/if}
    </section>
</div>
