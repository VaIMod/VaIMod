// VaIMod 统一配置包：覆盖变量、显示别名、双方云数据、飞书机器人、
// 快照、回收站、设置面板的所有本地/桥接配置，一次导出即可完整备份 / 还原。
import type { ScratchValue, ScratchVariable, VariableValue } from './types';
import type { ScratchVM } from './scratch-vm';
import type { FeishuRobot } from './feishu';
import type { MarkerEntry, TrashEntry, TrashScope } from './ops-meta';
import {
  loadAllMarkers,
  saveAllMarkers,
  loadAllTrash,
  saveAllTrash,
} from './ops-meta';
import { saveDisplayNames, loadDisplayNames } from './display-names';
import { robotList, setRobots } from './feishu';
import { normalizeSettings, type Settings } from './settings';
import { pluginRegistry } from './plugin-registry';

const BUNDLE_VERSION = 'vaimod-bundle-v1';

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

/** 完整配置包：覆盖 VaIMod 全部可导出项 */
export interface VaIModBundle {
  app: 'VaIMod';
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  project: string;
  variables: BundleVariable[];
  displayNames: Record<string, string>;
  cloudProject: Record<string, unknown>;
  cloudUser: Record<string, unknown>;
  robots: FeishuRobot[];
  markers: MarkerEntry[];
  trash: TrashEntry[];
  settings: Settings;
  /** 已安装插件的源码（导入时自动解析安装；代码完全一致则跳过） */
  plugins: string[];
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
  // 新品牌包 + 旧 VaIMod 品牌包（更名前导出的文件）都识别为 bundle
  if (
    o.app === 'VaIMod' ||
    o.app === 'VaIMod' ||
    (typeof o.version === 'string' &&
      (String(o.version).startsWith('vaimod-bundle') || String(o.version).startsWith('vaimod-bundle')))
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
    cloudProject: {},
    cloudUser: {},
    robots: [],
    markers: [],
    trash: [],
    settings: normalizeSettings(undefined),
    plugins: pluginRegistry.exportSources(),
    pluginsOnly: true,
  };
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
    pluginsOnly: obj.pluginsOnly === true,
  };
}

export interface BundleApplyResult {
  displayNames: number;
  cloudProject: number;
  cloudUser: number;
  robots: number;
  markers: number;
  trash: number;
  plugins: number;
}

/** 把 bundle 写回各本地存储（云数据镜像由调用方用 applyCloudMirror 写入 ccwDataStore） */
export function applyVaIModBundleLocal(bundle: VaIModBundle): BundleApplyResult {
  // 「仅插件包」：包内其余字段是空占位，不能拿它们全量覆盖设备上已有的本地数据
  // （否则导入一次「全部插件」就会清空别名 / 快照 / 回收站 / 机器人）。
  if (bundle.pluginsOnly === true) {
    const only = pluginRegistry.installMany(bundle.plugins);
    return {
      displayNames: 0,
      cloudProject: 0,
      cloudUser: 0,
      robots: 0,
      markers: 0,
      trash: 0,
      plugins: only.installed + only.upgraded,
    };
  }

  // 显示别名：全量覆盖
  saveDisplayNames(bundle.displayNames);

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

  return {
    displayNames: Object.keys(bundle.displayNames).length,
    cloudProject: 0, // 由调用方填入
    cloudUser: 0,
    robots: bundle.robots.length,
    markers: bundle.markers.length,
    trash: bundle.trash.length,
    plugins: pluginResult.installed + pluginResult.upgraded,
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
  cloudProject: number;
  cloudUser: number;
  robots: number;
  markers: number;
  trash: number;
  plugins: number;
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
}): VaIModBundle {
  const lockIntervalMap = new Map(args.variables.map((v) => [v.id, v.lockInterval ?? 0]));
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
    cloudProject: args.cloudProject,
    cloudUser: args.cloudUser,
    // 机器人：默认从本地登记表读，保证「导出即完整备份」
    robots: args.robots ?? robotList(),
    markers: loadAllMarkers(),
    trash: loadAllTrash(),
    settings: args.settings,
    // 插件源码一并带走：换设备导入即自动安装（指纹相同则跳过）
    plugins: pluginRegistry.exportSources(),
  };
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
    cloudProject: Object.keys(b.cloudProject).length,
    cloudUser: Object.keys(b.cloudUser).length,
    robots: b.robots.length,
    markers: b.markers.length,
    trash: b.trash.length,
    plugins: b.plugins.length,
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
  if (s.cloudProject) parts.push(`作品云 ${s.cloudProject}`);
  if (s.cloudUser) parts.push(`用户云 ${s.cloudUser}`);
  if (s.robots) parts.push(`机器人 ${s.robots}`);
  if (s.markers) parts.push(`快照 ${s.markers}`);
  if (s.trash) parts.push(`回收站 ${s.trash}`);
  if (s.plugins) parts.push(`插件 ${s.plugins}`);
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