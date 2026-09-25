// VaIMod 设置存储：跨面板共享的轻量配置（localStorage 持久化）。
// 加载模式：async（默认，Tab 切换先给反馈再异步挂载内容）/ sync（立即挂载）。
export type LoadMode = 'async' | 'sync';

/**
 * 面板 Tab 标识：内置固定 5 个，插件页用 `plug:<id>` 形式的动态标识。
 *
 * 网络防火墙**既不是内置 Tab、也不在本体内** —— 它是一个可分发的扩展插件
 * （`docs/plugin-net-firewall.js`）：不导入就完全没有这个功能，
 * 导入后自带一个标签页。
 */
export type BuiltinTabId = 'vars' | 'ccw' | 'tools' | 'feishu' | 'system';
export type TabId = BuiltinTabId | `plug:${string}`;

export const TAB_LABELS: Record<BuiltinTabId, string> = {
  vars: '变量',
  ccw: '云数据',
  tools: '工具',
  feishu: '飞书',
  system: '系统',
};

/** Tab 偏好：顺序（数组下标）即显示顺序；enabled=false 隐藏该 Tab */
export interface TabPref {
  id: TabId;
  enabled: boolean;
}

export const ALL_TAB_IDS: BuiltinTabId[] = ['vars', 'ccw', 'tools', 'feishu', 'system'];

/** 判断是否内置 Tab */
export function isBuiltinTab(id: string): id is BuiltinTabId {
  return (ALL_TAB_IDS as string[]).includes(id);
}

/** 从插件 Tab 标识中取出插件 id（非插件 Tab 返回 null） */
export function pluginIdOfTab(id: string): string | null {
  return id.startsWith('plug:') ? id.slice(5) : null;
}

/** 取得任意 Tab 的显示名（内置查表，插件页由调用方另行传入插件名） */
export function tabLabel(id: TabId, pluginNames?: Record<string, string>): string {
  if (isBuiltinTab(id)) return TAB_LABELS[id];
  const pid = pluginIdOfTab(id);
  if (pid && pluginNames?.[pid]) return pluginNames[pid];
  return pid ?? String(id);
}

/** 主色调预设（用户可选的几个好看主题色） */
export const PRESET_COLORS: { id: string; label: string; value: string }[] = [
  { id: 'blue', label: '晴空蓝', value: '#4da3ff' },
  { id: 'green', label: '薄荷绿', value: '#30d158' },
  { id: 'purple', label: '紫罗兰', value: '#9b6cff' },
  { id: 'pink', label: '樱花粉', value: '#ff7eb3' },
  { id: 'orange', label: '活力橙', value: '#ff9f0a' },
  { id: 'cyan', label: '湖水青', value: '#34c9d8' },
];

/**
 * 飞书 Webhook 拦截模式：
 * - off      不拦截（默认，零行为变化）
 * - manual   命中即排队，等面板里点「允许 / 拒绝」
 * - allowAll 只记录放行（审计用）
 * - blockAll 命中一律拒绝（连带记录）
 */
export type FeishuInterceptMode = 'off' | 'manual' | 'allowAll' | 'blockAll';

export interface Settings {
  loadMode: LoadMode;
  /** 快照还原时，缺失目标/变量自动新建补齐 */
  applyCreateOnRestore: boolean;
  /** 主色调（hex，驱动 --svp-primary） */
  accentColor: string;
  /** 标签页顺序与显隐（数组顺序即显示顺序） */
  tabs: TabPref[];
  /** 飞书消息请求拦截模式 */
  feishuIntercept: FeishuInterceptMode;
  /** manual 模式下无人应答（超时）时的兜底动作 */
  feishuOnTimeout: 'allow' | 'block';
  /** manual 模式下等待应答的毫秒数（0 = 不等待，直接用兜底动作） */
  feishuTimeoutMs: number;
  /** 内置 Tab 显隐方案的版本号：用于一次性迁移（见 TABS_SCHEMA_VER） */
  tabsVer?: number;
}

const KEY = 'vaimod_settings_v1';

/**
 * 内置 Tab 显隐方案版本。
 * v1 → v2：默认面板从「变量/云数据/系统/防火墙」收敛为**只有变量和云数据**。
 * 系统、防火墙、工具、飞书都改为默认关闭（在设置页里随时可开），
 * 因为它们要么是低频运维入口、要么是重型安全组件，不该占默认面板的位置。
 */
const TABS_SCHEMA_VER = 2;

/** 默认显示的内置标签页：只有变量与云数据（其余内置 Tab 默认关闭，可在设置页手动开启） */
const DEFAULT_ENABLED_TABS: ReadonlySet<BuiltinTabId> = new Set(['vars', 'ccw']);

export function defaultTabs(): TabPref[] {
  return ALL_TAB_IDS.map((id) => ({ id, enabled: DEFAULT_ENABLED_TABS.has(id) }));
}

export function defaultSettings(): Settings {
  return {
    loadMode: 'async',
    applyCreateOnRestore: true,
    accentColor: PRESET_COLORS[0].value, // 默认晴空蓝
    tabs: defaultTabs(),
    feishuIntercept: 'off', // 默认不拦截：不改变任何既有行为
    feishuOnTimeout: 'allow',
    feishuTimeoutMs: 30000,
    tabsVer: TABS_SCHEMA_VER,
  };
}

function isTabId(x: unknown): x is TabId {
  if (typeof x !== 'string') return false;
  if ((ALL_TAB_IDS as string[]).includes(x)) return true;
  // 插件页：plug:<插件 id>（id 规则与 plugins.ts 的 ID_RE 对齐）
  return /^plug:[a-z0-9][a-z0-9_-]{1,47}$/.test(x);
}

/**
 * 内置 Tab 显隐的一次性迁移（方案版本落后时执行）。
 *
 * 只重置**内置** Tab 的显隐：插件 Tab 条目、以及全部条目的相对顺序原样保留
 * （用户拖拽出来的顺序是他花力气调过的，不该被迁移抹掉）。
 * 因为有 `tabsVer` 门控，只跑一次 —— 迁移后用户再手动开回来的选择不会被反复覆盖。
 */
function migrateTabs(tabs: TabPref[], ver: unknown): TabPref[] {
  if (typeof ver === 'number' && ver >= TABS_SCHEMA_VER) return tabs;
  return tabs.map((t) =>
    isBuiltinTab(t.id) ? { ...t, enabled: DEFAULT_ENABLED_TABS.has(t.id) } : t,
  );
}

/**
 * 把任意（可能残缺/旧版）的 settings 对象规整为完整 Settings。
 *
 * `knownPluginTabs`：当前已安装插件对应的 Tab 标识集合。传入时会把
 * 「插件已卸载但 tabs 里还留着」的僵尸条目剔除，并把「新装插件但 tabs 里还没有」
 * 的条目按插件安装顺序追加到末尾（默认启用）。不传则保持宽松（仅做格式校验）。
 */
export function normalizeSettings(
  parsed: Partial<Settings> | null | undefined,
  knownPluginTabs?: string[],
): Settings {
  const d = defaultSettings();
  if (!parsed || typeof parsed !== 'object') return d;
  let tabs = defaultTabs();
  if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
    const seen = new Set<string>();
    const list = parsed.tabs
      .filter((t): t is TabPref => !!t && isTabId(t.id) && !seen.has(t.id) && (seen.add(t.id), true))
      .map((t) => ({ id: t.id, enabled: t.enabled !== false }));
    if (list.length > 0) tabs = list;
  }
  // 内置 Tab 补齐：tabs 数组只会记录「用户见过的内置 Tab」（UI 只能切显隐、不能删条目），
  // 因此数组里完全缺席的内置 Tab = 本次版本新加的 → 追加到末尾，但**默认关闭**。
  // 为什么要默认关闭：内置 Tab 里混着低频运维入口（系统）与重型安全组件（防火墙），
  // 自动冒出来会挤掉用户真正要用的面板，也让「默认面板」随版本悄悄变形。
  for (const b of ALL_TAB_IDS) {
    if (!tabs.some((t) => t.id === b)) tabs.push({ id: b, enabled: false });
  }
  if (knownPluginTabs) {
    const known = new Set(knownPluginTabs);
    // 剔除已卸载插件留下的僵尸 Tab（保留内置）
    const kept = tabs.filter((t) => isBuiltinTab(t.id) || known.has(t.id));
    // 补齐未登记的插件 Tab（新装插件），保持插件安装顺序
    const present = new Set<string>(kept.map((t) => t.id as string));
    for (const pid of knownPluginTabs) {
      if (!present.has(pid)) {
        kept.push({ id: pid as TabId, enabled: true });
        present.add(pid);
      }
    }
    // 内置 Tab 若被剔除（理论上不会）则补回，保证面板恒有内容
    for (const b of ALL_TAB_IDS) {
      if (!kept.some((t) => t.id === b)) kept.push({ id: b, enabled: false });
    }
    tabs = kept;
  }
  tabs = migrateTabs(tabs, parsed.tabsVer);
  const mode = parsed.feishuIntercept;
  return {
    loadMode: parsed.loadMode === 'sync' ? 'sync' : 'async',
    applyCreateOnRestore: parsed.applyCreateOnRestore !== false,
    accentColor:
      typeof parsed.accentColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(parsed.accentColor)
        ? parsed.accentColor
        : d.accentColor,
    tabs,
    feishuIntercept:
      mode === 'manual' || mode === 'allowAll' || mode === 'blockAll' ? mode : 'off',
    feishuOnTimeout: parsed.feishuOnTimeout === 'block' ? 'block' : 'allow',
    feishuTimeoutMs:
      typeof parsed.feishuTimeoutMs === 'number' && Number.isFinite(parsed.feishuTimeoutMs)
        ? Math.max(0, Math.min(300000, Math.floor(parsed.feishuTimeoutMs)))
        : d.feishuTimeoutMs,
    tabsVer: TABS_SCHEMA_VER,
  };
}

/** 配置是否落后于当前的 Tab 方案版本（需要在读取时顺手落盘，避免每次启动都重跑迁移） */
function tabsVerStale(ver: unknown): boolean {
  return !(typeof ver === 'number' && ver >= TABS_SCHEMA_VER);
}

/** 读取（向后兼容：旧设置缺字段时用默认补齐；tabs 缺失/损坏时重建） */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const next = normalizeSettings(parsed);
    if (tabsVerStale(parsed.tabsVer)) saveSettings(next);
    return next;
  } catch {
    return defaultSettings();
  }
}

/**
 * 读取设置并按「当前已安装插件」校准 Tab 列表（插件安装/卸载后调用）。
 * `pluginTabs` 形如 `['plug:my-tool']`。
 */
export function loadSettingsFor(pluginTabs: string[]): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const d = defaultSettings();
      const tabs = [...d.tabs];
      for (const id of pluginTabs) tabs.push({ id: id as TabId, enabled: true });
      return { ...d, tabs };
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const next = normalizeSettings(parsed, pluginTabs);
    if (tabsVerStale(parsed.tabsVer)) saveSettings(next);
    return next;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** 恢复默认设置并返回（供「还原系统」使用） */
export function resetSettings(): Settings {
  const d = defaultSettings();
  saveSettings(d);
  return d;
}
