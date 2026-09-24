<script lang="ts">
  // 全局设置覆盖层：任意 Tab 可见时由 Header 齿轮触发打开；
  // 即使系统标签页被隐藏也能进入设置并恢复。
  import {
    saveSettings,
    resetSettings,
    PRESET_COLORS,
    isBuiltinTab,
    pluginIdOfTab,
    TAB_LABELS,
    type Settings,
    type TabId,
  } from '../core/settings';
  import { pluginRegistry } from '../core/plugin-registry';
  import { clearDisplayNames } from '../core/display-names';
  import {
    aliasStats,
    exportAliasConfig,
    setAliasConfig,
    setAliasEnabled,
    clearAliasConfig,
  } from '../core/alias-config';
  import PluginManager from './PluginManager.svelte';
  import { fly } from 'svelte/transition';

  let {
    settings,
    onChange,
    onClose,
    aliasHits = 0,
  }: {
    settings: Settings;
    onChange: (next: Settings) => void;
    onClose: () => void;
    /** 当前被规则表改名的变量条数（由面板统计，设置层只展示） */
    aliasHits?: number;
  } = $props();

  // ===== 本地重命名配置（仅显示层，不新建/不改名作品里的变量） =====
  let aliasTick = $state(0);
  let aliasFileEl: HTMLInputElement | undefined = $state();
  let aliasMsg = $state('');
  let aliasMsgErr = $state(false);
  const aliasInfo = $derived.by(() => {
    void aliasTick;
    return aliasStats();
  });

  function aliasSay(text: string, err = false) {
    aliasMsg = text;
    aliasMsgErr = err;
  }

  async function onAliasFile(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const cfg = setAliasConfig(text);
      aliasTick = aliasTick + 1;
      aliasSay(`已导入 ${cfg.rules.length} 条规则${cfg.name ? `（${cfg.name}）` : ''}`, false);
    } catch (e) {
      aliasSay(e instanceof Error ? e.message : '导入失败：文件不是合法 JSON', true);
    }
  }

  function onAliasExport() {
    if (!aliasInfo.rules) {
      aliasSay('当前没有可导出的规则', true);
      return;
    }
    const blob = new Blob([exportAliasConfig()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaimod-alias-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    aliasSay('已导出为 JSON', false);
  }

  function onAliasClear() {
    clearAliasConfig();
    aliasTick = aliasTick + 1;
    aliasSay('已清空本地重命名规则', false);
  }

  function onAliasToggle(on: boolean) {
    setAliasEnabled(on);
    aliasTick = aliasTick + 1;
    aliasSay(on ? '已启用本地重命名' : '已停用本地重命名', false);
  }

  function updateSetting(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    saveSettings(next);
    onChange(next);
  }

  function toggleSetting(key: keyof Settings) {
    if (key === 'loadMode') {
      updateSetting({ loadMode: settings.loadMode === 'async' ? 'sync' : 'async' });
      return;
    }
    if (key === 'applyCreateOnRestore') {
      updateSetting({ applyCreateOnRestore: !settings.applyCreateOnRestore });
      return;
    }
  }

  function setAccentColor(color: string) {
    updateSetting({ accentColor: color });
  }

  /**
   * 切换某 Tab 显隐（保证至少保留一个可见 Tab）。
   * 插件 Tab 的行开关不直接改 tabs：插件启用状态才是唯一状态源（面板对齐
   * effect 会强制「插件启停 ⇒ Tab 显隐」同步），在这里改 tabs 下一拍就被弹回，
   * 表现为「点了没反应」。因此行开关直接启停插件，两边永远一致。
   */
  function toggleTabVisible(id: TabId) {
    const pid = pluginIdOfTab(id);
    if (pid) {
      const p = pluginRegistry.get(pid);
      if (p) {
        pluginRegistry.setEnabled(pid, !p.enabled);
        return;
      }
    }
    const tabs = settings.tabs.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : { ...t }));
    if (tabs.filter((t) => t.enabled).length === 0) return;
    updateSetting({ tabs });
  }

  // ===== 拖拽排序（对齐鸿蒙 / 安卓列表拖拽交互） =====
  // 原生列表拖拽分四阶段，这里逐条对齐：
  //   ① 提起（pick-up）：位移超过阈值后该行「拾起」——跟手 + 轻微放大 + 边缘抬起阴影，
  //      起手用弹簧曲线（轻微过冲）而不是线性，这是鸿蒙/安卓拖拽最明显的辨识点。
  //   ② 跟手（follow）：位移完全由指针决定，且该行禁用 transform 过渡（零滞后）。
  //      移动越快放大越明显一点（速度感知），手指停住则回落到常态放大，
  //      这是 Material 的「动态海拔」手感。
  //   ③ 让位（shift）：其余行按跨越的槽位平滑挪一格（0.13s 缓出，不是瞬间跳）。
  //   ④ 落位（settle）：松手后**先原地不动**写下与松手瞬间完全一致的屏幕位移，
  //      提交新顺序后立刻改写成「新基准下的等价位移」，两者在同一帧内完成，
  //      因此渲染位置前后**逐像素相同**（不会闪）；随后该行缓出滑进槽位
  //      （无过冲、不弹跳——用户明确要求去掉落位回弹）。
  //
  // ⚠️ 闪烁的根因（历史 bug）：旧实现松手时把 dragDy 归零、settleDy 直接写成
  //    「finalDy - dragDy + overshoot」，行在同一帧里从 dragDy 跳到另一个值 ——
  //    即使屏幕位置数值上等价，也因为「元素基准位置已被重排改变」而必须靠补偿量
  //    重新对齐；一旦补偿量算错或 lifted（承载 transition 的类）同帧被移除，
  //    就会看到「闪一下然后才动」。现在落位期间始终保持 lifted 态 + 位移恒定，
  //    只让过渡去完成「滑进槽位」的最后一段。
  let dragIdx = $state(-1); // 正在拖拽的行下标（-1 = 无）
  let overIdx = $state(-1); // 磁吸目标槽位
  let dragDy = $state(0); // 被拖行的实时纵向位移
  let dragLift = $state(0); // 提起强度 0~1：驱动缩放/阴影（弹簧起手）
  // 落位补偿：松手后到 DOM 重排为最终顺序之前，让被拖行「原地不动」的位移量。
  let settleIdx = $state(-1); // 落位行在原数组中的下标（-1 = 无）
  let settleDy = $state(0); // 落位行需要保持的位移
  let rowEls: HTMLElement[] = [];

  // 行元素登记（use 指令比 bind:this 数组形式更稳：数组下标写入在 Svelte 5
  // 的 each 块里不保证按 index 落位，而 use 一定在元素挂载时精确回调）
  function trackRow(node: HTMLElement, i: number) {
    rowEls[i] = node;
    return {
      // keyed 重排后同一节点会换下标：清掉旧槽位写新槽位，保持 rowEls 与
      // DOM 顺序一致 —— 松手补偿要按「当前顺序」读行元素，映射过期会读错行
      update(newI: number) {
        for (const k of Object.keys(rowEls)) {
          const ki = Number(k);
          if (rowEls[ki] === node && ki !== newI) delete rowEls[ki];
        }
        rowEls[newI] = node;
      },
      destroy() {
        for (const k of Object.keys(rowEls)) {
          if (rowEls[Number(k)] === node) delete rowEls[Number(k)];
        }
      },
    };
  }

  /** 行的当前实时 translateY：getComputedStyle 返回过渡中的插值（真实屏幕位移），
   *  不是状态目标值。松手补偿用真实位移计算，快速松手（让位过渡还在半路）时
   *  让位行/被拖行都能逐像素连续，不会出现松手帧突跳。 */
  function currentTranslateY(el: HTMLElement | undefined): number {
    if (!el) return 0;
    try {
      const t = getComputedStyle(el).transform;
      if (!t || t === 'none') return 0;
      const m = /matrix(?:3d)?\(([^)]+)\)/.exec(t);
      if (!m) return 0;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      // matrix(a..f) 的 ty 是第 6 项；matrix3d 的 ty 是第 14 项
      return parts.length === 16 ? (parts[13] ?? 0) : (parts[5] ?? 0);
    } catch {
      return 0;
    }
  }

  // 行高一次性量取（渲染期读 offsetHeight 会强制回流；拖拽中读数又会被 transform 干扰）
  let rowH = $state(48);

  // 位移阈值：区分「点击开关」与「拖拽排序」；比鼠标略大以适应触屏抖动
  const DRAG_THRESHOLD = 4;
  // 提起延迟：按下后先「按住」一小会儿才允许拖拽，避免点开关时误触发（触屏友好）。
  // 鼠标（pointerType=mouse）不延迟，保持桌面端即时响应。
  const HOLD_MS = 0;
  const TOUCH_HOLD_MS = 180;

  // 动效参数（与 CSS 中的过渡时长保持一致）
  const MOTION = {
    settle: 130, // 落位滑入时长，对齐 CSS .svp-tab-row 的 0.13s（松手 1 帧后即开始滑入，无冻结期）
    liftScale: 0.03, // 提起最大放大 1.03
    maxTilt: 0, // 倾角：列表拖拽不加旋转（保持整齐），预留为 0
  } as const;

  /** 量取行高（含行间距），仅在拖拽开始时调用一次 */
  function measureRowHeight(): number {
    const a = rowEls[0];
    const b = rowEls[1];
    if (a && b) {
      const d = b.offsetTop - a.offsetTop;
      if (d > 0) return d;
    }
    if (a) return a.offsetHeight;
    return 48;
  }

  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  function startTabDrag(e: PointerEvent, idx: number) {
    // 行内开关按钮不参与拖拽（点开关只切显隐）
    if ((e.target as HTMLElement).closest('.svp-toggle')) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();

    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const startY = e.clientY;
    let started = false;
    let armed = !isTouch; // 触屏需要「按住」一小会儿才解锁拖拽
    let raf = 0;
    let pendingY = startY;
    let lastY = startY;
    let lastT = performance.now();
    let speed = 0; // px/ms，用于速度感知的提起强度
    const h = measureRowHeight();
    rowH = h;
    const from = idx;

    if (!armed) {
      holdTimer = setTimeout(() => {
        armed = true;
      }, TOUCH_HOLD_MS);
    }

    const apply = () => {
      raf = 0;
      const dy = pendingY - startY;
      dragDy = dy;
      // 磁吸目标槽位：按位移跨越的行数换算，用行高吸附（磁吸感来源）
      const steps = Math.round(dy / h);
      overIdx = Math.max(0, Math.min(settings.tabs.length - 1, from + steps));
      // 速度感知：跟手速度越快，提起略强（上限 1），停住后自然回落
      const lift = Math.min(1, speed / 2.2);
      dragLift = 0.72 + 0.28 * lift;
    };

    const move = (ev: PointerEvent) => {
      pendingY = ev.clientY;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      // 指数平滑，避免瞬时抖动让缩放跳变
      speed = speed * 0.72 + (Math.abs(pendingY - lastY) / dt) * 0.28;
      lastY = pendingY;
      lastT = now;
      if (!started) {
        if (!armed) return;
        if (Math.abs(pendingY - startY) < DRAG_THRESHOLD) return;
        started = true;
        dragIdx = from;
        overIdx = from;
        dragDy = 0;
        dragLift = 0.72;
      }
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
      }
      if (raf) cancelAnimationFrame(raf);
    };

    const up = () => {
      cleanup();
      const to = overIdx;
      // 松手瞬间的屏幕位移：这是「落位必须从这里继续」的唯一真值。
      // 后面所有补偿量都围绕它计算，保证渲染位置在重排前后逐像素不变。
      const releasedDy = dragDy;
      if (!started || to < 0) {
        dragIdx = -1;
        overIdx = -1;
        dragDy = 0;
        dragLift = 0;
        return;
      }
      if (to === from) {
        // 没跨过任何槽位：从松手位置缓出落回原位（不重排，基准未变）
        settleIdx = from;
        settleDy = releasedDy;
        dragIdx = -1;
        overIdx = -1;
        dragDy = 0;
        dragLift = 0;
        scheduleSettleEnd();
        return;
      }
      // 落位（关键）：被拖行移交给 settle 通道，补偿量 = 松手位移 − 基准跳变，
      // 缓出过渡把它从松手位置平滑收进槽位（无过冲、无弹跳）。
      // ⚠️ settleIdx 必须标记 **新下标 to**（不是 from）：重排后被拖行位于 to，
      //    写 from 会把补偿与提起态落到占据旧槽位的无辜行上（被拖行丢落位补偿、
      //    无辜行被顶起并闪 lifted —— round12 B 组探针实证）。
      // ⚠️ 同帧所有让位行的基准位置（DOM 顺序）跳变，transform 若带过渡必然
      //    整行闪跳（探针实测 ~44px）。因此：
      //    ① snapFrame 单帧关过渡；
      //    ② releaseDys 给每个让位行写入「当前实时动画位移 − 基准跳变」——读
  //       getComputedStyle 的过渡中值（不是状态目标值）：快速松手时让位行
  //       还在 0.13s 过渡半路，旧实现按状态值补偿会让 snap 帧突跳到终点
      //       （即「被拖拽行的上一行弹一下」的根因）；按实时值补偿则逐像素连续。
      //       下一帧清除补偿并恢复过渡，行从当前位置平滑滑进新槽位。
      const finalDy = (to - from) * h;
      const ids = settings.tabs.map((t) => t.id);
      const arranged = [...ids];
      const movedId = arranged.splice(from, 1)[0];
      arranged.splice(to, 0, movedId);
      releaseDys = arranged.map((id, j) => {
        if (id === movedId) return 0; // 被拖行走 settle 通道（settleIdx = to）
        const oi = ids.indexOf(id);
        return currentTranslateY(rowEls[oi]) - (j - oi) * rowH;
      });
      snapFrame = true;
      settleIdx = to;
      settleDy = releasedDy - finalDy;
      reorderTab(from, to);
      dragIdx = -1;
      overIdx = -1;
      dragDy = 0;
      dragLift = 0;
      scheduleSettleEnd();
    };

    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** 把第 from 行移动到第 to 行（数组顺序即显示顺序，直接持久化） */
  function reorderTab(from: number, to: number) {
    const arr = settings.tabs.map((t) => ({ ...t }));
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    updateSetting({ tabs: arr });
  }

  /** 其余行让位位移：拖拽起点与目标之间的行整体上/下移一格（带过渡 → 磁吸） */
  function shiftOf(i: number): number {
    if (dragIdx < 0 || overIdx < 0 || i === dragIdx) return 0;
    if (dragIdx < overIdx && i > dragIdx && i <= overIdx) return -rowH;
    if (dragIdx > overIdx && i < dragIdx && i >= overIdx) return rowH;
    return 0;
  }

  /** 落位补偿结束：清掉位移与过渡，交回 CSS 常态（此刻 DOM 已是最终顺序） */
  // 松手重排帧：全行过渡瞬时关闭——让位行的基准位置（DOM 顺序）与被拖行槽位
  // 同帧跳变，transform 若还带 0.13s 过渡必然整行闪跳（round12 B 组探针实证 ~44px）。
  let snapFrame = $state(false);
  // 松手帧各「新下标」行的瞬时补偿位移（旧屏幕位移 − 基准跳变）；
  // 下一帧清除并恢复过渡，行从补偿量平滑滑进新槽位（逐像素连续）。
  let releaseDys = $state<number[] | null>(null);

  function endSettle() {
    settleIdx = -1;
    settleDy = 0;
    rowSettling = false;
    dragLift = 0;
    snapFrame = false;
    releaseDys = null;
  }

  let rowSettling = $state(false);
  const settleTimers: ReturnType<typeof setTimeout>[] = [];
  /**
   * 安排落位收尾。时序要求很严：
   *   frame N   ：settle 位移 + transition:none 已写入（等价的屏幕位置，不动）
   *   frame N+1 ：放开过渡（rowSettling = true），同时把落位目标归零（settleDy = 0）
   *               —— transform 计算值从补偿位移变为 0，滑入过渡此刻才真正开始
   *   +MOTION.settle 后：清空提起态（缩放/阴影经常态过渡收回）
   *
   * ⚠️ frame N+1 必须同时改 transform 值：CSS 过渡只在「计算值变化」时触发，
   *    只挂过渡类不改值，行会原地冻结 MOTION.settle 毫秒、直到 endSettle 清零
   *    才突然开始滑 —— 松手后「顿一下再落位」的根因（不丝滑不连贯）。
   * 用 rAF 等一个绘制帧，确保浏览器先「看到」settle 的定位值，再放开过渡；
   * 否则同帧写入会被合并成一次样式计算，过渡不会触发（表现为直接跳过去）。
   */
  function scheduleSettleEnd() {
    rowSettling = false;
    for (const t of settleTimers.splice(0)) clearTimeout(t);
    requestAnimationFrame(() => {
      settleTimers.push(
        setTimeout(() => {
          rowSettling = true;
          // 放开过渡的同一帧把落位目标归零：被拖行从松手等价位置开始滑进槽位，
          // 与让位行（releaseDys 清除）同帧起步，两套动作同步、连贯。
          settleDy = 0;
          snapFrame = false;
          releaseDys = null;
          settleTimers.push(setTimeout(endSettle, MOTION.settle));
        }, 0),
      );
    });
  }

  // 行的最终 transform：
  //   拖拽中   → 跟手位移
  //   其余行   → 让位位移（磁吸挪一格）
  //   落位行   → 补偿位移（保证屏幕位置与松手瞬间连续）
  function rowTransform(i: number): string {
    let y = 0;
    if (dragIdx === i) y = dragDy;
    else if (dragIdx >= 0) y = shiftOf(i);
    if (settleIdx === i) y = settleDy;
    else if (releaseDys && Number.isFinite(releaseDys[i])) y = releaseDys[i];
    return `translate3d(0, ${y}px, 0)`;
  }

  // 提起缩放：跟手行按提起强度放大；落位行保持「半提起」，收尾时再收回 1，
  // 避免缩放从 1.03 突跳回 1（那也是「闪一下」的来源之一）。
  function rowScale(i: number): number {
    if (dragIdx === i) return 1 + MOTION.liftScale * dragLift;
    if (settleIdx === i) return 1 + MOTION.liftScale * 0.5;
    return 1;
  }

  // 是否处于「提起态」（承载抬起阴影 + 弹簧过渡的那套样式）。
  // 落位全程保持提起，直到 endSettle 才交回常态 —— 中途撤掉会让阴影/背景/
  // 过渡属性同帧变化，视觉上就是「闪一下」。
  function rowLifted(i: number): boolean {
    return dragIdx === i || settleIdx === i;
  }

  // 行是否处于「无过渡」状态：
  //   跟手行 —— 位移完全由指针决定，任何补间都是滞后。
  //   落位行 —— 只在「写入与松手等价位移」的那一帧需要瞬时定位；scheduleSettleEnd
  //             会在下一帧把 rowSettling 置真，从而放开过渡，让弹簧把最后一段跑完。
  function rowNoTransition(i: number): boolean {
    return dragIdx === i || snapFrame || (settleIdx === i && !rowSettling);
  }

  function resetAllSettings() {
    const next = resetSettings();
    onChange(next);
  }

  let clearedPulse = $state(false);

  // ---------- 插件 ----------
  // 插件列表变化（安装/卸载）时刷新 Tab 名称与设置区
  let plugVer = $state(0);
  // 用 $effect 包裹订阅：返回值即退订函数，覆盖层销毁时自动退订
  // （裸 subscribe 会在每次开关覆盖层时累积泄漏监听器）
  $effect(() => pluginRegistry.subscribe(() => (plugVer = plugVer + 1)));
  const pluginNames = $derived.by(() => {
    void plugVer;
    const m: Record<string, string> = {};
    for (const p of pluginRegistry.list()) m[p.def.id] = p.def.name;
    return m;
  });
  /** Tab 显示名：内置查表；插件页查已安装插件名（插件已卸载时回退到 id） */
  function labelOf(id: TabId): string {
    if (isBuiltinTab(id)) return TAB_LABELS[id];
    const pid = id.startsWith('plug:') ? id.slice(5) : id;
    return pluginNames[pid] ?? pid;
  }
  /** 插件的设置页样式（作用域限定到该插件卡片） */
  const pluginSettingsCss = $derived.by(() => {
    void plugVer;
    return pluginRegistry
      .list()
      .filter((p) => p.def.settingsCss)
      .map((p) => `/* plugin:${p.def.id} */\n${p.def.settingsCss}`)
      .join('\n');
  });

  function clearLocalData() {
    if (
      !confirm(
        '确定清空全部本地记忆？将删除：飞书机器人记录、快照、回收站、变量显示别名、本地重命名规则、分组展开记忆。\n（不影响作品本体与云端数据）',
      )
    )
      return;
    try {
      localStorage.removeItem(['vai', 'mod', '_fs_robots'].join(''));
      localStorage.removeItem(['vai', 'mod', '_marks'].join(''));
      localStorage.removeItem(['vai', 'mod', '_trash'].join(''));
      // 走模块 API 而不是直接删 key：display-names 有模块级缓存，
      // 只删 localStorage 会让旧别名留在内存里，下一次改名又把它整份写回（清不掉）。
      clearDisplayNames();
      // 同理：本地重命名配置也有模块缓存，必须走 API
      clearAliasConfig();
      aliasTick = aliasTick + 1;
      localStorage.removeItem(['vai', 'mod', '_grp_exp'].join(''));
      clearedPulse = true;
      setTimeout(() => (clearedPulse = false), 800);
    } catch {
      /* ignore */
    }
  }
</script>

<div class="svp-settings-overlay" transition:fly={{ y: 12, duration: 200 }}>
  <div class="svp-settings-head">
    <span class="svp-settings-title">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      设置
    </span>
    <button class="svp-settings-close" onclick={onClose} aria-label="关闭">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12"></path>
      </svg>
    </button>
  </div>
  <div class="svp-settings-body">
    <div class="svp-setting-group">通用</div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">异步加载</div>
        <div class="svp-setting-desc">切页时先给反馈再挂载内容，更跟手</div>
      </div>
      <button
        class="svp-toggle"
        class:svp-toggle-on={settings.loadMode === 'async'}
        onclick={() => toggleSetting('loadMode')}
        role="switch"
        aria-checked={settings.loadMode === 'async'}
        aria-label="异步加载"
      >
        <span class="svp-toggle-dot"></span>
      </button>
    </div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">快照还原自动新建</div>
        <div class="svp-setting-desc">还原快照时缺失的变量自动重新创建补齐</div>
      </div>
      <button
        class="svp-toggle"
        class:svp-toggle-on={settings.applyCreateOnRestore}
        onclick={() => toggleSetting('applyCreateOnRestore')}
        role="switch"
        aria-checked={settings.applyCreateOnRestore}
        aria-label="快照还原自动新建"
      >
        <span class="svp-toggle-dot"></span>
      </button>
    </div>

    <div class="svp-setting-group">外观</div>
    <div class="svp-setting-item svp-color-row">
      <div class="svp-setting-text">
        <div class="svp-setting-name">主色调</div>
        <div class="svp-setting-desc">按钮、高亮与激活态的统一配色</div>
      </div>
      <div class="svp-color-swatches">
        {#each PRESET_COLORS as c}
          <button
            class="svp-color-swatch"
            class:svp-color-on={settings.accentColor === c.value}
            style:background={c.value}
            onclick={() => setAccentColor(c.value)}
            aria-label={c.label}
          ></button>
        {/each}
      </div>
    </div>

    <div class="svp-setting-group">标签页</div>
    <div class="svp-tab-list" class:svp-tab-dragging={dragIdx >= 0}>
      {#each settings.tabs as t, i (t.id)}
        <div
          class="svp-setting-item svp-tab-row"
          class:svp-tab-lifted={rowLifted(i)}
          class:svp-tab-follow={dragIdx === i}
          class:svp-tab-settling={settleIdx === i && rowSettling}
          style:transform={rowTransform(i)}
          style:--svp-row-scale={rowScale(i)}
          style:transition={rowNoTransition(i) ? 'none' : undefined}
          use:trackRow={i}
          onpointerdown={(e) => startTabDrag(e, i)}
          role="listitem"
        >
          <span class="svp-drag-handle" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <circle cx="9" cy="6" r="1.7"></circle>
              <circle cx="15" cy="6" r="1.7"></circle>
              <circle cx="9" cy="12" r="1.7"></circle>
              <circle cx="15" cy="12" r="1.7"></circle>
              <circle cx="9" cy="18" r="1.7"></circle>
              <circle cx="15" cy="18" r="1.7"></circle>
            </svg>
          </span>
          <span class="svp-tab-row-name">{labelOf(t.id)}</span>
          <button
            class="svp-toggle"
            class:svp-toggle-on={t.enabled}
            onclick={() => toggleTabVisible(t.id)}
            role="switch"
            aria-checked={t.enabled}
            aria-label={pluginIdOfTab(t.id)
              ? t.enabled
                ? '停用此插件'
                : '启用此插件'
              : t.enabled
                ? '隐藏此标签页'
                : '显示此标签页'}
          >
            <span class="svp-toggle-dot"></span>
          </button>
        </div>
      {/each}
    </div>

    <div class="svp-setting-group">插件</div>
    {#if pluginSettingsCss}
      <style>{pluginSettingsCss}</style>
    {/if}
    <PluginManager onChanged={() => (plugVer = plugVer + 1)} />

    <div class="svp-setting-group">本地重命名</div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">启用本地重命名</div>
        <div class="svp-setting-desc">
          按配置里的「真实变量名 → 显示名」改面板显示。只改显示：不新建变量、不改作品里的变量名，
          对项目与云端零影响。
        </div>
      </div>
      <button
        class="svp-toggle"
        class:svp-toggle-on={aliasInfo.enabled}
        onclick={() => onAliasToggle(!aliasInfo.enabled)}
        role="switch"
        aria-checked={aliasInfo.enabled}
        aria-label="启用本地重命名"
      >
        <span class="svp-toggle-dot"></span>
      </button>
    </div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">
          规则 {aliasInfo.rules} 条 · 已生效 {aliasHits} 个变量
        </div>
        <div class="svp-setting-desc">
          {aliasInfo.name || '未命名配置'}｜支持 rules / variables（cave-vars.json 可直接导入）/ displayNames / 扁平表四种格式
        </div>
      </div>
    </div>
    <div class="svp-alias-bar">
      <button class="svp-btn svp-btn-sm" onclick={() => aliasFileEl?.click()}>导入 JSON</button>
      <button
        class="svp-btn svp-btn-ghost svp-btn-sm"
        onclick={onAliasExport}
        disabled={aliasInfo.rules === 0}
      >
        导出 JSON
      </button>
      <button
        class="svp-btn svp-btn-red-ghost svp-btn-sm"
        onclick={onAliasClear}
        disabled={aliasInfo.rules === 0}
      >
        清空
      </button>
      <input
        bind:this={aliasFileEl}
        class="svp-file-input svp-alias-file"
        type="file"
        accept=".json,application/json"
        tabindex="-1"
        onchange={onAliasFile}
      />
    </div>
    {#if aliasMsg}
      <div class="svp-alias-msg" class:svp-alias-msg-err={aliasMsgErr}>{aliasMsg}</div>
    {/if}

    <div class="svp-setting-group">还原系统</div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">恢复默认设置</div>
        <div class="svp-setting-desc">配色、标签页顺序与显隐、加载模式回到初始</div>
      </div>
      <button
        class="svp-icon-act svp-icon-act-warn"
        onclick={resetAllSettings}
        aria-label="恢复默认设置"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
          <path d="M3 3v5h5"></path>
        </svg>
      </button>
    </div>
    <div class="svp-setting-item">
      <div class="svp-setting-text">
        <div class="svp-setting-name">清空本地记忆</div>
        <div class="svp-setting-desc">删除机器人记录、快照、回收站、显示别名、重命名规则、分组记忆</div>
      </div>
      <button
        class="svp-icon-act svp-icon-act-danger"
        class:svp-icon-act-ok={clearedPulse}
        onclick={clearLocalData}
        aria-label="清空本地记忆"
      >
        {#if clearedPulse}
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
            <path d="M10 11v6M14 11v6"></path>
          </svg>
        {/if}
      </button>
    </div>
  </div>
</div>
