// VaIMod 设置存储：跨面板共享的轻量配置（localStorage 持久化）。
// 加载模式：async（默认，Tab 切换先给反馈再异步挂载内容）/ sync（立即挂载）。
export type LoadMode = 'async' | 'sync';

/** 面板 Tab 标识：内置固定 5 个，插件页用 `plug:<id>` 形式的动态标识 */
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

export interface Settings {
  loadMode: LoadMode;
  /** 快照还原时，缺失目标/变量自动新建补齐 */
  applyCreateOnRestore: boolean;
  /** 主色调（hex，驱动 --svp-primary） */
  accentColor: string;
  /** 标签页顺序与显隐（数组顺序即显示顺序） */
  tabs: TabPref[];
}

const KEY = 'vaimod_settings_v1';

/** 默认显示的内置标签页：只开 变量/云数据/系统（飞书和工具默认关闭，可在设置页手动开启） */
const DEFAULT_ENABLED_TABS: ReadonlySet<BuiltinTabId> = new Set(['vars', 'ccw', 'system']);

export function defaultTabs(): TabPref[] {
  return ALL_TAB_IDS.map((id) => ({ id, enabled: DEFAULT_ENABLED_TABS.has(id) }));
}

export function defaultSettings(): Settings {
  return {
    loadMode: 'async',
    applyCreateOnRestore: true,
    accentColor: PRESET_COLORS[0].value, // 默认晴空蓝
    tabs: defaultTabs(),
  };
}

function isTabId(x: unknown): x is TabId {
  if (typeof x !== 'string') return false;
  if ((ALL_TAB_IDS as string[]).includes(x)) return true;
  // 插件页：plug:<插件 id>（id 规则与 plugins.ts 的 ID_RE 对齐）
  return /^plug:[a-z0-9][a-z0-9_-]{1,47}$/.test(x);
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
      if (!kept.some((t) => t.id === b)) kept.push({ id: b, enabled: true });
    }
    tabs = kept;
  }
  return {
    loadMode: parsed.loadMode === 'sync' ? 'sync' : 'async',
    applyCreateOnRestore: parsed.applyCreateOnRestore !== false,
    accentColor:
      typeof parsed.accentColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(parsed.accentColor)
        ? parsed.accentColor
        : d.accentColor,
    tabs,
  };
}

/** 读取（向后兼容：旧设置缺字段时用默认补齐；tabs 缺失/损坏时重建） */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return normalizeSettings(parsed);
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
    return normalizeSettings(parsed, pluginTabs);
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
