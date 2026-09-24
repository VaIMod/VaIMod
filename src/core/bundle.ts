// VaIMod 统一配置包：覆盖变量、显示别名、双方云数据、飞书机器人、
// 快照、回收站、设置面板的所有本地/桥接配置，一次导出即可完整备份 / 还原。
import type { ScratchValue, ScratchVariable, VariableValue } from './types';
import type { FeishuRobot } from './feishu';
import type { MarkerEntry, TrashEntry, TrashScope } from './ops-meta';
import {
  loadAllMarkers,
  saveAllMarkers,
  loadAllTrash,
  saveAllTrash,
} from './ops-meta';
import { saveDisplayNames, loadDisplayNames } from './display-names';
import { getAliasConfig, setAliasConfig, normalizeAliasConfig, type AliasConfig } from './alias-config';
import {
  firewallRules as getFirewallRules,
  importFirewallRules,
  type FwRules,
} from './net-firewall';
import { robotList, setRobots } from './feishu';
import { normalizeSettings, type Settings } from './settings';
import { pluginRegistry } from './plugin-registry';

// v2 相对 v1 新增：pluginState / pluginSettings / modified。
// 解析端对缺字段一律给默认值，因此 **v1 的老包依旧能正常导入**（不需要迁移脚本）。
const BUNDLE_VERSION = 'vaimod-bundle-v2';

/**
 * 变量条目的「自动检测」占位。
 *
 * 用户需求：配置里的变量部分可以只写 `"name": "*"`，表示**不绑定具体变量名**，
 * 导入时按当前项目动态加载 —— 即「凡是当前项目里存在的变量/列表，全部套用
 * 这份配置的锁定策略与默认值」。
 *
 * 语义约定：
 *   - `name: "*"`  → 通配所有变量（该条目的 value/isLocked 作为「模板」套到每个变量上）
 *   - `targetName: "*"` → 不限目标
 *   - 若同时存在通配条目与具名条目：具名条目优先生效（更具体），通配仅补齐未命中的变量。
 */
export const WILDCARD = '*';

export interface BundleVariable {
  name: string;
  targetName: string;
  kind: 'variable' | 'list';
  value: ScratchValue;
  isLocked: boolean;
  lockInterval?: number;
}

/**
 * 已安装插件清单（插件相关元信息；源码另见 VaIModBundle.plugins）。
 * 与源码分开存的原因：源码用于「自动安装」，本清单用于「还原启用态与装机信息」——
 * 只带着源码导入会得到一堆默认启用的插件，用户之前关掉的那些会被重新打开。
 */
export interface BundlePluginState {
  id: string;
  name: string;
  version: string;
  type: 'patch' | 'ext';
  enabled: boolean;
  installedAt: number;
  /** 源码指纹：与 plugins 里的源码一一对应 */
  sig: string;
}

/**
 * 「被本工具改过的变量 → 对应哪个变量」。
 *
 * 与 variables 的区别：variables 是**配置层面**要施加的目标值（含通配模板），
 * 本数组是**运行事实**——当前项目里确实与原始值不同、或正被锁定强制写回的变量，
 * 并尽量带上项目里的原始值，便于「按变量还原」而不必整包回滚。
 */
export interface BundleModified {
  name: string;
  targetName: string;
  kind: 'variable' | 'list';
  /** VaIMod 当前施加的值 */
  value: ScratchValue;
  /** 施加来源：lock=锁定持续写回；changed=被本工具改过 */
  origin: 'lock' | 'changed';
  /** 项目里的原始值（连接后首次读取时记下的基线；未知则缺省） */
  original?: ScratchValue;
  lockInterval?: number;
}

/** 完整配置包：覆盖 VaIMod 全部可导出项 */
export interface VaIModBundle {
  app: 'VaIMod';
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: string;
  variables: BundleVariable[];
  displayNames: Record<string, string>;
  /**
   * 本地重命名规则表（按**真实变量名**匹配，见 core/alias-config.ts）。
   * 可选：更早期的包没有这个字段；缺省时导入方保持设备上现有配置不动。
   */
  aliasConfig?: AliasConfig;
  /**
   * 网络防火墙域名规则（见 core/net-firewall.ts）。
   * 可选：更早期的包没有这个字段；缺省时导入方保持设备上现有规则不动。
   */
  firewallRules?: FwRules;
  cloudProject: Record<string, unknown>;
  cloudUser: Record<string, unknown>;
  robots: FeishuRobot[];
  markers: MarkerEntry[];
  trash: TrashEntry[];
  settings: Settings;
  /** 已安装插件的源码（导入时自动解析安装；代码完全一致则跳过） */
  plugins: string[];
  /** 已安装插件清单（启用态 / 版本 / 装机信息） */
  pluginState: BundlePluginState[];
  /**
   * 每个插件自己的设置：键 = 插件 id，值 = **该插件在清单里定义的格式**，原样存取。
   * VaIMod 不解释这些内容（只做 JSON 序列化），因此插件加字段无需改本体。
   */
  pluginSettings: Record<string, unknown>;
  /** 被本工具改过的变量（含原始值），用于「按变量还原」与导出报告 */
  modified: BundleModified[];
  /**
   * 只含插件的包（设置页「导出全部插件」产物）。
   * 置真时导入方**只安装插件**，其余字段（变量/别名/云数据/机器人/快照/回收站/设置）
   * 一律视为「包里没有」而跳过，避免空字段把设备上已有的本地数据整份覆盖掉。
   */
  pluginsOnly?: boolean;
}

/** 拼装完整配置包（需要调用方传入**已解码**的变量列表，见 buildVaIModBundleFromVars） */
export function buildVaIModBundle(args: {
  variables: ScratchVariable[];
  project: string;
  cloudProject: Record<string, unknown>;
  cloudUser: Record<string, unknown>;
  robots?: FeishuRobot[];
  settings: Settings;
}): VaIModBundle {
  return buildVaIModBundleFromVars(args);
}

/** 配置包类型识别结果（导入前先判断是什么，再决定怎么应用） */
export type BundleKind = 'bundle' | 'legacy-vars' | 'unknown';

/** 识别一段 JSON 是完整配置包 / 旧版仅变量配置 / 无法识别 */
export function detectBundleKind(raw: unknown): BundleKind {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
  const o = raw as Record<string, unknown>;
  // 新品牌包 + 更名前导出的旧品牌包都识别为 bundle
  // （`ValMod` / `valmod-bundle` 是**兼容字面量**，必须原样保留：改了老用户的备份包就导不进来）
  if (
    o.app === 'VaIMod' ||
    o.app === 'ValMod' ||
    (typeof o.version === 'string' &&
      (String(o.version).startsWith('vaimod-bundle') || String(o.version).startsWith('valmod-bundle')))
  ) {
    return 'bundle';
  }
  // 旧版：只有 { project, variables }（没有 app 标记）
  if (Array.isArray(o.variables)) return 'legacy-vars';
  // 再宽松一点：一个非空对象且含 version/exportedAt 之一 +
  // variables 为对象/数组都视作旧版变量配置
  if (o.variables && typeof o.variables === 'object') return 'legacy-vars';
  return 'unknown';
}

/** 触发浏览器下载完整配置包为 JSON 文件（variables 必须是已解码明文） */
export function exportVaIModBundle(args: {
  variables: ScratchVariable[];
  project: string;
  cloudProject: Record<string, unknown>;
  cloudUser: Record<string, unknown>;
  robots?: FeishuRobot[];
  settings: Settings;
  /** 项目原始值基线（键 = `targetId:id`），用于导出「改过哪些变量」 */
  origins?: ReadonlyMap<string, ScratchValue>;
}): VaIModBundle {
  const bundle = buildVaIModBundle(args);
  const body = JSON.stringify(bundle, null, 2);
  const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  // 游离锚点：a 节点不进页面 DOM（stealth），click() 照常触发下载
  const a = document.createElement('a');
  a.href = url;
  a.download = `VaIMod-bundle-${args.project}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return bundle;
}

/**
 * 仅含插件源码的配置包（设置页「导出全部」批量导出用）。
 * 复用 vaimod-bundle 格式：导入走常规「导入配置」通道即可自动安装，
 * 其余字段留空 + `pluginsOnly` 标记 → 导入方只装插件，不覆盖设备上已有的
 * 变量/别名/快照/回收站/设置。
 */
export function buildPluginsOnlyBundle(): VaIModBundle {
  return {
    app: 'VaIMod',
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: '',
    variables: [],
    displayNames: {},
    // 仅插件包：别名与本地重命名都是空占位，导入时整块跳过（见 applyVaIModBundleLocal）
    aliasConfig: { version: 1, name: '', source: '', enabled: true, rules: [] },
    firewallRules: { block: [], allow: [] },
    cloudProject: {},
    cloudUser: {},
    robots: [],
    markers: [],
    trash: [],
    settings: normalizeSettings(undefined),
    plugins: pluginRegistry.exportSources(),
    // 「导出全部插件」也算插件备份：装机清单与各插件自己的设置一并带走
    pluginState: pluginStateSnapshot(),
    pluginSettings: settingsOfAllPlugins(),
    modified: [],
    pluginsOnly: true,
  };
}

/** 已安装插件清单快照（装机信息 + 启用态），两处导出共用同一份映射避免走样 */
function pluginStateSnapshot(): BundlePluginState[] {
  return pluginRegistry.list().map((p) => ({
    id: p.def.id,
    name: p.def.name,
    version: p.def.version,
    type: p.def.type,
    enabled: p.enabled,
    installedAt: p.installedAt,
    sig: p.sig,
  }));
}

/** 收集所有已安装插件自己的设置（键 = 插件 id，值原样保留插件定义的格式） */
function settingsOfAllPlugins(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pluginRegistry.list()) out[p.def.id] = pluginRegistry.settingsOf(p.def.id);
  return out;
}

/** 校验并规整单条变量条目（容错：脏数据直接丢弃而非整体失败） */
function sanitizeVariable(raw: unknown): BundleVariable | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name === '') return null;
  const kind: 'variable' | 'list' = o.kind === 'list' ? 'list' : 'variable';
  // 通配条目（name === '*'）：value 允许缺省（导入时按各变量实际情况决定），
  // 这里仍按 kind 规整一次，作为「模板值」使用
  let value: ScratchValue;
  if (kind === 'list') {
    value = Array.isArray(o.value) ? (o.value as ScratchValue) : String(o.value ?? '');
  } else {
    value = (typeof o.value === 'number' || typeof o.value === 'string'
      ? o.value
      : o.value == null
        ? ''
        : String(o.value)) as ScratchValue;
  }
  const interval = typeof o.lockInterval === 'number' && Number.isFinite(o.lockInterval)
    ? Math.max(0, o.lockInterval)
    : undefined;
  return {
    name: o.name,
    targetName: typeof o.targetName === 'string' ? o.targetName : '',
    kind,
    value,
    isLocked: o.isLocked === true,
    lockInterval: interval,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** 值规整（v2 新字段用）：列表→数组，标量→number|string；脏数据一律回落成字符串 */
function coerceValue(raw: unknown, kind: 'variable' | 'list'): ScratchValue {
  if (kind === 'list') return Array.isArray(raw) ? (raw as ScratchValue) : String(raw ?? '');
  if (typeof raw === 'number' || typeof raw === 'string') return raw as ScratchValue;
  return String(raw ?? '') as ScratchValue;
}

function sanitizePluginState(raw: unknown): BundlePluginState[] {
  return asArray<unknown>(raw)
    .map((r): BundlePluginState | null => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== 'string' || o.id === '') return null;
      return {
        id: o.id,
        name: typeof o.name === 'string' ? o.name : o.id,
        version: typeof o.version === 'string' ? o.version : '1.0.0',
        type: o.type === 'patch' ? 'patch' : 'ext',
        enabled: o.enabled !== false,
        installedAt:
          typeof o.installedAt === 'number' && Number.isFinite(o.installedAt)
            ? o.installedAt
            : Date.now(),
        sig: typeof o.sig === 'string' ? o.sig : '',
      };
    })
    .filter((x): x is BundlePluginState => x !== null);
}

function sanitizeModified(raw: unknown): BundleModified[] {
  return asArray<unknown>(raw)
    .map((r): BundleModified | null => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
      const o = r as Record<string, unknown>;
      if (typeof o.name !== 'string' || o.name === '') return null;
      const kind: 'variable' | 'list' = o.kind === 'list' ? 'list' : 'variable';
      const interval =
        typeof o.lockInterval === 'number' && Number.isFinite(o.lockInterval)
          ? Math.max(0, o.lockInterval)
          : undefined;
      return {
        name: o.name,
        targetName: typeof o.targetName === 'string' ? o.targetName : '',
        kind,
        value: coerceValue(o.value, kind),
        origin: o.origin === 'lock' ? 'lock' : 'changed',
        original: o.original === undefined ? undefined : coerceValue(o.original, kind),
        lockInterval: interval,
      };
    })
    .filter((x): x is BundleModified => x !== null);
}

/**
 * 解析配置包（宽容模式）：
 * - 完整 bundle → 全字段解析（变量条目逐条校验，脏条目丢弃）；
 * - 旧版「仅变量」JSON → 自动升级为 bundle（variables 部分 + 默认设置）；
 * - 无法识别 → 返回 null。
 */
export function importVaIModBundle(raw: unknown): VaIModBundle | null {
  const kind = detectBundleKind(raw);
  if (kind === 'unknown') return null;
  const obj = raw as Partial<VaIModBundle> & Record<string, unknown>;

  if (kind === 'legacy-vars') {
    // 旧版升级：只取变量，其余给默认值（不覆盖用户现有别名/快照/回收站/设置）
    const vars = asArray<unknown>(obj.variables)
      .map(sanitizeVariable)
      .filter((v): v is BundleVariable => v !== null);
    return {
      app: 'VaIMod',
      version: BUNDLE_VERSION,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
      project: typeof obj.project === 'string' ? obj.project : '',
      variables: vars,
      displayNames: {},
      cloudProject: {},
      cloudUser: {},
      robots: [],
      markers: [],
      trash: [],
      settings: normalizeSettings(undefined),
      plugins: [],
      pluginState: [],
      pluginSettings: {},
      modified: [],
    };
  }

  const vars = asArray<unknown>(obj.variables)
    .map(sanitizeVariable)
    .filter((v): v is BundleVariable => v !== null);

  return {
    app: 'VaIMod',
    version: BUNDLE_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    project: typeof obj.project === 'string' ? obj.project : '',
    variables: vars,
    displayNames: asRecord(obj.displayNames) as Record<string, string>,
    aliasConfig: normalizeAliasConfig(obj.aliasConfig) ?? undefined,
    firewallRules: sanitizeFwRules(obj.firewallRules),
    cloudProject: asRecord(obj.cloudProject),
    cloudUser: asRecord(obj.cloudUser),
    robots: asArray<FeishuRobot>(obj.robots).filter(
      (r) => r && typeof r.token === 'string' && r.token.length > 0,
    ),
    markers: asArray<MarkerEntry>(obj.markers).filter((m) => m && typeof m.id === 'string'),
    trash: asArray<TrashEntry>(obj.trash).filter(
      (t) => t && typeof t.scope === 'string' && (t.scope as TrashScope),
    ),
    settings: normalizeSettings(obj.settings as Partial<Settings>),
    // 插件源码：只收非空字符串；重复源码交由 registry 依指纹去重
    plugins: asArray<unknown>(obj.plugins).filter(
      (s): s is string => typeof s === 'string' && s.trim() !== '',
    ),
    pluginState: sanitizePluginState(obj.pluginState),
    // 插件设置：内容格式由各插件自己定义，本体不解释，只保证是个对象
    pluginSettings: asRecord(obj.pluginSettings),
    modified: sanitizeModified(obj.modified),
    pluginsOnly: obj.pluginsOnly === true,
  };
}

/** 防火墙规则容错解析：认不出返回 undefined，导入方据此「保持设备现状」而不是清空 */
function sanitizeFwRules(raw: unknown): FwRules | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.block) && !Array.isArray(o.allow)) return undefined;
  const strList = (x: unknown): string[] =>
    asArray<unknown>(x).filter((s): s is string => typeof s === 'string');
  return { block: strList(o.block), allow: strList(o.allow) };
}

export interface BundleApplyResult {
  displayNames: number;
  /** 写入的本地重命名规则条数（包里没有该字段时为 0，且不动设备上现有配置） */
  aliasRules: number;
  /** 写入的防火墙规则总数（黑 + 白；包里没有该字段时为 0，且不动设备上现有规则） */
  firewallRules: number;
  cloudProject: number;
  cloudUser: number;
  robots: number;
  markers: number;
  trash: number;
  plugins: number;
  /** 写入的插件设置条数（每个插件一份） */
  pluginSettings: number;
  /** 被还原启用态的插件数 */
  pluginState: number;
}

/** 按装机清单还原插件启用态；只对确实已安装且状态不同的插件动手 */
function applyPluginEnabledState(states: BundlePluginState[]): number {
  if (states.length === 0) return 0;
  const byId = new Map(pluginRegistry.list().map((p) => [p.def.id, p.enabled]));
  let n = 0;
  for (const s of states) {
    const cur = byId.get(s.id);
    if (cur === undefined || cur === s.enabled) continue;
    pluginRegistry.setEnabled(s.id, s.enabled);
    n++;
  }
  return n;
}

/** 把 bundle 写回各本地存储（云数据镜像由调用方用 applyCloudMirror 写入 ccwDataStore） */
export function applyVaIModBundleLocal(bundle: VaIModBundle): BundleApplyResult {
  // 「仅插件包」：包内其余字段是空占位，不能拿它们全量覆盖设备上已有的本地数据
  // （否则导入一次「全部插件」就会清空别名 / 快照 / 回收站 / 机器人）。
  if (bundle.pluginsOnly === true) {
    const only = pluginRegistry.installMany(bundle.plugins);
    // 「仅插件包」的范围含插件自身的东西：设置与启用态一并还原
    const ps = pluginRegistry.applySettings(bundle.pluginSettings);
    const pst = applyPluginEnabledState(bundle.pluginState);
    return {
      displayNames: 0,
      aliasRules: 0,
      firewallRules: 0,
      cloudProject: 0,
      cloudUser: 0,
      robots: 0,
      markers: 0,
      trash: 0,
      plugins: only.installed + only.upgraded,
      pluginSettings: ps,
      pluginState: pst,
    };
  }

  // 显示别名：全量覆盖
  saveDisplayNames(bundle.displayNames);

  // 本地重命名规则表：全量覆盖；包里没有该字段 → 保持设备上现有配置不动
  // （更早期导出的包不该把用户新写的规则清掉）
  let aliasRules = 0;
  if (bundle.aliasConfig) {
    const cfg = setAliasConfig(bundle.aliasConfig);
    aliasRules = cfg.rules.length;
  }

  // 防火墙规则：全量覆盖；包里没有该字段 → 保持设备上现有规则不动（与本地重命名同一约定）
  let firewallCount = 0;
  if (bundle.firewallRules) {
    const r = importFirewallRules(bundle.firewallRules);
    firewallCount = r.block + r.allow;
  }

  // 飞书机器人：全量覆盖
  setRobots(bundle.robots);

  // 快照：全量覆盖
  saveAllMarkers(bundle.markers);

  // 回收站：按 scope 全量覆盖
  const trashByScope: Record<TrashScope, TrashEntry[]> = { 'vm': [], 'cloud:p': [], 'cloud:u': [] };
  for (const t of bundle.trash) {
    const scope = t.scope as TrashScope;
    if (trashByScope[scope]) trashByScope[scope].push(t);
  }
  saveAllTrash('vm', trashByScope['vm']);
  saveAllTrash('cloud:p', trashByScope['cloud:p']);
  saveAllTrash('cloud:u', trashByScope['cloud:u']);

  // 插件：自动解析安装。指纹相同的跳过（已有的插件若代码一模一样便不会重复安装），
  // 单条失败不影响其余（返回失败列表供调用方汇报）
  const pluginResult = pluginRegistry.installMany(bundle.plugins);

  // 插件设置（格式由插件自己定义，本体只做搬运）+ 启用态还原。
  // 顺序必须在 installMany 之后：新装的插件此时才存在，设置与启用态才有落点。
  const settingsApplied = pluginRegistry.applySettings(bundle.pluginSettings);
  const stateApplied = applyPluginEnabledState(bundle.pluginState);

  return {
    displayNames: Object.keys(bundle.displayNames).length,
    aliasRules,
    firewallRules: firewallCount,
    cloudProject: 0, // 由调用方填入
    cloudUser: 0,
    robots: bundle.robots.length,
    markers: bundle.markers.length,
    trash: bundle.trash.length,
    plugins: pluginResult.installed + pluginResult.upgraded,
    pluginSettings: settingsApplied,
    pluginState: stateApplied,
  };
}

/** 插件安装明细（导入汇报用） */
export function pluginInstallDetail(bundle: VaIModBundle) {
  return pluginRegistry.installMany(bundle.plugins);
}

/** 配置包内容摘要（用于导入前预览 / 导出后提示，让「包里有什么」一目了然） */
export interface BundleSummary {
  project: string;
  exportedAt: string;
  variables: number;
  wildcard: number;
  locked: number;
  lists: number;
  displayNames: number;
  /** 本地重命名规则条数 */
  aliasRules: number;
  /** 防火墙域名规则总数（黑 + 白） */
  firewallRules: number;
  cloudProject: number;
  cloudUser: number;
  robots: number;
  markers: number;
  trash: number;
  plugins: number;
  /** 带设置数据的插件数 */
  pluginSettings: number;
  /** 装机清单条目数（含启用态） */
  pluginState: number;
  /** 被本工具改过的变量数 */
  modified: number;
  /** 变量值已锁定（会被持续写回）的数量 */
  modifiedLocked: number;
  settings: boolean;
}

/**
 * 从「面板已解码的变量列表」拼装配置包。
 *
 * ⚠️ 不要改用 `bridge.getVariables()`：对外下发的值经过 XOR 遮罩编码，
 * 直接导出会把密文写进 JSON（导入回来又解一次 → 永久乱码）。
 * 面板持有的 `variables` 是唯一已解码的明文来源，导出必须走这里。
 */
export function buildVaIModBundleFromVars(args: {
  variables: ScratchVariable[];
  project: string;
  cloudProject: Record<string, unknown>;
  cloudUser: Record<string, unknown>;
  robots?: FeishuRobot[];
  settings: Settings;
  /** 项目原始值基线（键 = `targetId:id`）：由桥接层连接后首次读取时记下，用于「改过哪些变量」 */
  origins?: ReadonlyMap<string, ScratchValue>;
}): VaIModBundle {
  const lockIntervalMap = new Map(args.variables.map((v) => [v.id, v.lockInterval ?? 0]));

  // 插件相关：源码 + 装机清单（启用态）+ 每个插件自己的设置（格式由插件定义，原样带走）
  const pluginState = pluginStateSnapshot();
  const pluginSettings = settingsOfAllPlugins();

  // 「改过的变量 → 对应哪个变量」：与原始基线不同，或正被锁定持续写回
  const modified: BundleModified[] = [];
  for (const v of args.variables) {
    const original = args.origins?.get(v.targetId + ':' + v.id);
    const differs = original !== undefined && !sameBundleValue(original, v.value);
    if (!v.isLocked && !differs) continue;
    modified.push({
      name: v.name,
      targetName: v.targetName,
      kind: v.kind,
      value: Array.isArray(v.value) ? (v.value.slice() as VariableValue[]) : v.value,
      origin: v.isLocked ? 'lock' : 'changed',
      original:
        original === undefined
          ? undefined
          : Array.isArray(original)
            ? (original.slice() as VariableValue[])
            : original,
      lockInterval: v.isLocked ? (lockIntervalMap.get(v.id) ?? 0) : undefined,
    });
  }

  return {
    app: 'VaIMod',
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: args.project,
    variables: args.variables.map((v) => ({
      name: v.name,
      targetName: v.targetName,
      kind: v.kind,
      // 已解码的明文值（列表为数组原样保留）
      value: Array.isArray(v.value) ? (v.value.slice() as VariableValue[]) : v.value,
      isLocked: v.isLocked,
      lockInterval: v.isLocked ? (lockIntervalMap.get(v.id) ?? 0) : undefined,
    })),
    displayNames: loadDisplayNames(),
    aliasConfig: getAliasConfig(),
    firewallRules: getFirewallRules(),
    cloudProject: args.cloudProject,
    cloudUser: args.cloudUser,
    // 机器人：默认从本地登记表读，保证「导出即完整备份」
    robots: args.robots ?? robotList(),
    markers: loadAllMarkers(),
    trash: loadAllTrash(),
    settings: args.settings,
    // 插件源码一并带走：换设备导入即自动安装（指纹相同则跳过）
    plugins: pluginRegistry.exportSources(),
    pluginState,
    pluginSettings,
    modified,
  };
}

/** 值等价判定（导出「改过的变量」用）：标量严格相等，列表逐项比对 */
function sameBundleValue(a: ScratchValue, b: ScratchValue): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function summarizeBundle(b: VaIModBundle): BundleSummary {
  return {
    project: b.project,
    exportedAt: b.exportedAt,
    variables: b.variables.filter((v) => v.name !== WILDCARD).length,
    wildcard: b.variables.filter((v) => v.name === WILDCARD).length,
    locked: b.variables.filter((v) => v.isLocked).length,
    lists: b.variables.filter((v) => v.kind === 'list').length,
    displayNames: Object.keys(b.displayNames).length,
    aliasRules: b.aliasConfig?.rules?.length ?? 0,
    firewallRules: (b.firewallRules?.block?.length ?? 0) + (b.firewallRules?.allow?.length ?? 0),
    cloudProject: Object.keys(b.cloudProject).length,
    cloudUser: Object.keys(b.cloudUser).length,
    robots: b.robots.length,
    markers: b.markers.length,
    trash: b.trash.length,
    plugins: b.plugins.length,
    pluginSettings: Object.keys(b.pluginSettings ?? {}).length,
    pluginState: (b.pluginState ?? []).length,
    modified: (b.modified ?? []).length,
    modifiedLocked: (b.modified ?? []).filter((m) => m.origin === 'lock').length,
    settings: !!b.settings,
  };
}

/** 摘要转成一行可读文本（toast 用） */
export function summaryText(s: BundleSummary): string {
  const parts: string[] = [`变量 ${s.variables}`];
  if (s.wildcard) parts.push(`通配 ${s.wildcard}`);
  if (s.locked) parts.push(`锁定 ${s.locked}`);
  if (s.lists) parts.push(`列表 ${s.lists}`);
  if (s.displayNames) parts.push(`别名 ${s.displayNames}`);
  if (s.aliasRules) parts.push(`重命名规则 ${s.aliasRules}`);
  if (s.firewallRules) parts.push(`防火墙规则 ${s.firewallRules}`);
  if (s.cloudProject) parts.push(`作品云 ${s.cloudProject}`);
  if (s.cloudUser) parts.push(`用户云 ${s.cloudUser}`);
  if (s.robots) parts.push(`机器人 ${s.robots}`);
  if (s.markers) parts.push(`还原点 ${s.markers}`);
  if (s.trash) parts.push(`回收站 ${s.trash}`);
  if (s.plugins) parts.push(`插件 ${s.plugins}`);
  if (s.pluginSettings) parts.push(`插件设置 ${s.pluginSettings}`);
  if (s.modified) parts.push(`改过 ${s.modified}${s.modifiedLocked ? `(锁定 ${s.modifiedLocked})` : ''}`);
  return parts.join(' · ');
}

// ---------- 变量 "｜*｜" 通配展开 ----------

/** 导入时的目标变量视图（由 VaIModPanel 从 bridge 取到后传入） */
export interface ResolvableVariable {
  id: string;
  name: string;
  kind: 'variable' | 'list';
  isCloud: boolean;
  targetId: string;
  targetName: string;
}

/** 一条展开后的写入指令 */
export interface ResolvedWrite {
  variableId: string;
  targetId: string;
  kind: 'variable' | 'list';
  value: ScratchValue;
  isLocked: boolean;
  lockInterval?: number;
  /** 该条目来源：具名条目 / 通配条目 */
  from: 'named' | 'wildcard';
}

/**
 * 把配置里的变量条目「落地」到当前项目的真实变量上。
 *
 * 规则（用户需求：变量部分用 `"*"` 占位表示自动检测动态加载）：
 *   1. 具名条目（name !== '*'）：按 kind + name（+ targetName 优先）精确匹配；
 *      匹配不到则记为「未匹配」。
 *   2. 通配条目（name === '*'）：作为模板，套用到**所有尚未被具名条目命中的变量**，
 *      以及**所有新出现的变量**（因此新增变量天然被覆盖，无需改配置）。
 *   3. 通配条目的 targetName 也可为 '*'（不限目标）；若是具体目标名则只套该目标下的变量。
 *
 * 返回「写入指令 + 未匹配统计」，由调用方执行实际写入。
 */
export function resolveBundleVariables(
  entries: BundleVariable[],
  current: ResolvableVariable[],
): { writes: ResolvedWrite[]; unmatched: { name: string; targetName: string }[] } {
  const writes: ResolvedWrite[] = [];
  const unmatched: { name: string; targetName: string }[] = [];
  const named = entries.filter((e) => e.name !== WILDCARD);
  const wildcards = entries.filter((e) => e.name === WILDCARD);
  const hit = new Set<string>(); // 已命中的变量 key：targetId + '\u0001' + id

  // 1) 具名条目
  for (const item of named) {
    const kind = item.kind === 'list' ? 'list' : 'variable';
    const byName = current.filter((v) => v.kind === kind && v.name === item.name);
    const candidates = byName.length > 0 ? byName : current.filter((v) => v.name === item.name);
    const exact = item.targetName
      ? candidates.filter((v) => v.targetName === item.targetName)
      : candidates;
    const targets = exact.length > 0 ? exact : candidates;
    if (targets.length === 0) {
      unmatched.push({ name: item.name, targetName: item.targetName });
      continue;
    }
    for (const v of targets) {
      hit.add(v.targetId + '\u0001' + v.id);
      writes.push({
        variableId: v.id,
        targetId: v.targetId,
        kind: v.kind,
        value: item.value,
        isLocked: item.isLocked,
        lockInterval: item.lockInterval,
        from: 'named',
      });
    }
  }

  // 2) 通配条目：套到所有未被具名命中的变量
  if (wildcards.length > 0) {
    for (const v of current) {
      const key = v.targetId + '\u0001' + v.id;
      if (hit.has(key)) continue;
      // 通配条目按 kind 匹配（'*' 条目若声明 kind 则只套同类；未声明视为 variable 已规整，
      // 因此这里以「kind 相同」为准，列表条目需显式 kind: 'list'）
      const wc = wildcards.find(
        (w) =>
          w.kind === v.kind &&
          (!w.targetName || w.targetName === WILDCARD || w.targetName === v.targetName),
      );
      if (!wc) continue;
      hit.add(key);
      writes.push({
        variableId: v.id,
        targetId: v.targetId,
        kind: v.kind,
        value: wc.value,
        isLocked: wc.isLocked,
        lockInterval: wc.lockInterval,
        from: 'wildcard',
      });
    }
  }

  return { writes, unmatched };
}