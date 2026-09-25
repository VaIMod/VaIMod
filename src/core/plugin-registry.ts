// ===== VaIMod 插件注册表与运行沙箱 =====
//
// 职责分层：
//   plugins.ts        —— 格式定义、解析、校验、序列化（纯函数，无副作用）
//   plugin-registry.ts —— 安装/卸载/启停/持久化/导出导入（本文件）
//
// 存储：
//   vaimod_plugins_v1  → { [id]: { src, enabled, installedAt, sig } }  仅存源码，不存解析结果
//   vaimod_plugset_v1  → { [id]: { [settingKey]: value } }            插件设置项的值
//
// 只存**源码**是刻意的：插件格式升级后（parsePluginSource 变强/变宽），
// 重启即按新解析器重建定义，不需要数据迁移；指纹也直接对源码算，稳定可比。
import {
  parsePluginSource,
  pluginSignature,
  serializePluginDef,
  PluginParseError,
  type InstalledPlugin,
  type PluginDef,
  type PluginContext,
  type PluginProjectApi,
  type PatchApi,
  type PatchHookFn,
  type PatchWriteMeta,
} from './plugins';
import type { ScratchValue } from './types';
import { createPluginUI } from './plugin-ui';
import {
  getAliasConfig,
  setAliasConfig,
  exportAliasConfig,
  clearAliasConfig,
  setAliasEnabled,
  aliasStats,
  subscribeAliasConfig,
} from './alias-config';
import {
  isInternalXhr,
} from './net-internal';
import { markNative } from '../dom-utils';

const STORE_KEY = 'vaimod_plugins_v1';
const SET_KEY = 'vaimod_plugset_v1';

interface StoredPlugin {
  src: string;
  enabled: boolean;
  installedAt: number;
  sig: string;
  /** 存储态源码（src 字段本身）的指纹：用于识别条目被外部改写/写坏（见 readStore） */
  bodySig?: string;
}

type StoredMap = Record<string, StoredPlugin>;
type SettingMap = Record<string, Record<string, unknown>>;

/**
 * 完整性校验失败的插件 id（源码与存储指纹不符 → 已在盘上被外部改写或写坏）。
 * 由 readStore 填充，UI 据此给出可见提示（不静默丢弃）。
 */
const tamperedIds: string[] = [];
export function tamperedPluginIds(): string[] {
  return [...tamperedIds];
}

/**
 * 「拒绝加载但不许删」的条目原样保留区。
 *
 * 为什么需要：readStore 会把指纹不符的条目排除在返回值之外、ensure 会把解析失败的
 * 条目 catch 掉，而 persist() 只写 this.installed —— 于是这些条目在**本次启动就被
 * 从盘上覆盖删除**。但注释与 UI 都承诺「不静默丢弃 / 保留在盘上 / 重新上传即可修复」，
 * 用户还没拿到修复机会，数据先没了，下次启动告警也消失得无影无踪。
 * 这里存原始记录，persist 时并回；同 id 被重新上传安装时由新记录覆盖（天然自愈）。
 */
let quarantined: StoredMap = {};

// ---------- 底层读写 ----------

function readStore(): StoredMap {
  try {
    quarantined = {};
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: StoredMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      if (typeof o.src !== 'string' || o.src === '') continue;
      // 完整性校验：bodySig 是「存储态源码」的指纹（旧数据没有该字段，跳过校验，
      // 下次落盘补齐）。不符说明 localStorage 里的插件条目被外部脚本改写或写坏了
      // —— 插件源码会被真实执行，宁可不加载也不能带毒启动。
      // 注意 sig 语义不同：那是「用户上传的原始源码」指纹，用于安装去重，
      // 与落盘后的规范化源码天然不同，不能拿来校验。
      const bodySig = typeof o.bodySig === 'string' && o.bodySig ? o.bodySig : '';
      if (bodySig && bodySig !== pluginSignature(o.src)) {
        if (!tamperedIds.includes(id)) tamperedIds.push(id);
        // 原样扣留（含不符的 bodySig：告警要保持可见，直到用户重新上传该插件）
        quarantined[id] = { ...(o as unknown as StoredPlugin), src: o.src };
        continue;
      }
      out[id] = {
        src: o.src,
        enabled: o.enabled !== false,
        installedAt: typeof o.installedAt === 'number' ? o.installedAt : Date.now(),
        sig: typeof o.sig === 'string' && o.sig ? o.sig : pluginSignature(o.src),
        bodySig: bodySig || undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(map: StoredMap): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    /* 配额溢出等：静默，内存态仍生效 */
  }
}

function readSettings(): SettingMap {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SettingMap;
  } catch {
    return {};
  }
}

function writeSettings(map: SettingMap): void {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

// ---------- 注册表 ----------

type Listener = () => void;

class PluginRegistry {
  /** 内存态：id → 已解析插件（parse 结果缓存于此，避免每次读盘重解析） */
  private installed = new Map<string, InstalledPlugin>();
  private settings = new Map<string, Record<string, unknown>>();
  private listeners = new Set<Listener>();
  private loaded = false;
  /** 批量安装中：抑制逐条落盘/广播，由 installMany 结束时统一 flush 一次 */
  private batching = false;

  /** 懒加载：首次访问时才读盘 + 解析（解析失败的单条跳过并记录） */
  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const store = readStore();
    for (const [id, rec] of Object.entries(store)) {
      try {
        const def = parsePluginSource(rec.src);
        // 解析出来的 id 必须与存储 key 一致，否则以定义为准（防止手工改 key 造成错位）
        if (def.id !== id) {
          // 定义自带 id 优先；重新落盘纠正
          this.installed.set(def.id, {
            def,
            enabled: rec.enabled,
            installedAt: rec.installedAt,
            sig: rec.sig,
          });
        } else {
          this.installed.set(id, {
            def,
            enabled: rec.enabled,
            installedAt: rec.installedAt,
            sig: rec.sig,
          });
        }
      } catch {
        // 损坏条目：保留在盘上不删（用户可能想手工修），但内存不加载
        quarantined[id] = rec;
      }
    }
    this.settings = new Map(Object.entries(readSettings()));
    this.persist();
  }

  private persist(): void {
    const store: StoredMap = {};
    // 先铺「扣留区」，再铺内存态：同 id 以内存态为准（重新上传安装即自愈）
    for (const [id, rec] of Object.entries(quarantined)) {
      if (!this.installed.has(id)) store[id] = rec;
    }
    for (const [id, p] of this.installed) {
      const src = serializePluginDef(p.def);
      store[id] = {
        src,
        enabled: p.enabled,
        installedAt: p.installedAt,
        sig: p.sig,
        // 与落盘源码一一对应的指纹（下次启动校验完整性用）
        bodySig: pluginSignature(src),
      };
    }
    writeStore(store);
    const s: SettingMap = {};
    for (const [id, v] of this.settings) s[id] = v;
    writeSettings(s);
  }

  /**
   * 只落设置（不动插件源码）。
   * 设置页里每敲一个键都会走 setSetting —— 若走完整 persist，就要把**全部插件源码**
   * 序列化 + 同步写 localStorage，输入框会明显卡顿。设置表本身很小，单独写即可。
   * （插件源码的持久化由 install/uninstall/setEnabled 等结构变更负责。）
   */
  private persistSettings(): void {
    const s: SettingMap = {};
    for (const [id, v] of this.settings) s[id] = v;
    writeSettings(s);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 全部已安装插件（按安装时间排序，新装的在后） */
  list(): InstalledPlugin[] {
    this.ensure();
    return [...this.installed.values()].sort((a, b) => a.installedAt - b.installedAt);
  }

  /** 已启用的插件（渲染 Tab 用） */
  enabled(): InstalledPlugin[] {
    return this.list().filter((p) => p.enabled);
  }

  get(id: string): InstalledPlugin | undefined {
    this.ensure();
    return this.installed.get(id);
  }

  has(id: string): boolean {
    this.ensure();
    return this.installed.has(id);
  }

  /**
   * 安装插件。
   * @returns 'installed' 新装成功 | 'skipped' 已有同指纹插件（代码一模一样，跳过） | 'upgraded' 同 id 但源码不同（覆盖升级）
   * @throws PluginParseError 源码无法解析
   */
  install(src: string): 'installed' | 'skipped' | 'upgraded' {
    this.ensure();
    const def = parsePluginSource(src); // 先解析校验，失败抛错
    return this.installDef(def, src);
  }

  /**
   * 用**已经解析好的定义**安装，避免二次 parse。
   *
   * `parsePluginSource` 会真实执行整段源码（`new Function`），顶层有副作用的插件会被跑两遍 ——
   * 调用方（如上传前要先看 `type` 决定是否弹「补丁需确认来源」）拿到 def 后应当走这个入口，
   * 而不是再调一次 `install(src)`。
   */
  installParsed(def: PluginDef, src: string): 'installed' | 'skipped' | 'upgraded' {
    this.ensure();
    return this.installDef(def, src);
  }

  private installDef(def: PluginDef, src: string): 'installed' | 'skipped' | 'upgraded' {
    const sig = pluginSignature(src);
    // 用户重新上传安装同一个插件 → 覆盖写入会带上正确的完整性指纹，撤掉旧告警
    const ti = tamperedIds.indexOf(def.id);
    if (ti >= 0) tamperedIds.splice(ti, 1);
    delete quarantined[def.id]; // 扣留记录一并清掉，否则该插件日后被卸载时它会「复活」
    const exist = this.installed.get(def.id);
    if (exist) {
      if (exist.sig === sig) return 'skipped';
      // 同 id 不同源码 → 覆盖升级（保留启用态与显示顺序）
      this.installed.set(def.id, {
        def,
        enabled: exist.enabled,
        installedAt: exist.installedAt,
        sig,
      });
      this.flush();
      return 'upgraded';
    }
    this.installed.set(def.id, { def, enabled: true, installedAt: Date.now(), sig });
    this.flush();
    return 'installed';
  }

  /**
   * 持久化 + 广播：批量导入期间只落一次盘（见 batching）。
   * 单次 persist 要序列化**全部**插件源码，批量装 N 个插件若逐个落盘就是 N 倍开销。
   */
  private flush(): void {
    if (this.batching) return;
    this.persist();
    this.emit();
  }

  /** 按源码批量安装（导入配置用）：返回逐条结果 */
  installMany(
    sources: string[],
  ): { installed: number; skipped: number; upgraded: number; failed: { index: number; message: string }[] } {
    let installed = 0;
    let skipped = 0;
    let upgraded = 0;
    const failed: { index: number; message: string }[] = [];
    this.batching = true;
    try {
      sources.forEach((src, i) => {
        try {
          const r = this.install(src);
          if (r === 'installed') installed++;
          else if (r === 'skipped') skipped++;
          else upgraded++;
        } catch (err) {
          failed.push({
            index: i,
            message: err instanceof PluginParseError ? err.message : String(err),
          });
        }
      });
    } finally {
      this.batching = false;
      this.flush();
    }
    return { installed, skipped, upgraded, failed };
  }

  uninstall(id: string): boolean {
    this.ensure();
    const had = this.installed.delete(id);
    this.settings.delete(id);
    // 被扣留（指纹不符 / 解析失败）的条目不在 installed 里，但同样要能被清掉：
    // 否则它永远留在盘上、告警永远消不掉，用户除了改 localStorage 别无他法。
    const held = id in quarantined;
    if (held) {
      delete quarantined[id];
      const ti = tamperedIds.indexOf(id);
      if (ti >= 0) tamperedIds.splice(ti, 1);
    }
    if (had || held) {
      stopPatch(id); // 补丁即刻下线（清 cleanup + 钩子），不等 UI 同步
      this.persist();
      this.emit();
    }
    return had;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.ensure();
    const p = this.installed.get(id);
    if (!p) return;
    p.enabled = enabled;
    if (!enabled) stopPatch(id); // 禁用补丁即刻下线；启用由 syncPatchPlugins 补跑
    this.persist();
    this.emit();
  }

  /** 导出全部已安装插件的源码（配置包附带，供再次上传自动安装） */
  exportSources(): string[] {
    return this.list().map((p) => serializePluginDef(p.def));
  }

  // ---------- 插件设置项 ----------

  /** 某插件的设置值（已用 def 的默认值补齐缺项） */
  settingsOf(id: string): Record<string, unknown> {
    this.ensure();
    const p = this.installed.get(id);
    if (!p) return {};
    const saved = this.settings.get(id) ?? {};
    const out: Record<string, unknown> = {};
    for (const s of p.def.settings) {
      out[s.key] = saved[s.key] !== undefined ? saved[s.key] : (s.def ?? (s.type === 'toggle' ? true : ''));
    }
    // 透传未被定义但已保存的键（作者换了 settings 定义时不丢数据）
    for (const [k, v] of Object.entries(saved)) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  setSetting(id: string, key: string, value: unknown): void {
    this.ensure();
    const cur = this.settings.get(id) ?? {};
    cur[key] = value;
    this.settings.set(id, cur);
    // 高频路径（输入框每键一次）：只落设置，不重写全部插件源码
    this.persistSettings();
    this.emit();
  }

  resetSettings(id: string): void {
    this.ensure();
    this.settings.delete(id);
    this.persistSettings();
    this.emit();
  }

  /**
   * 批量写入插件设置（导入配置用）：整体替换 + 只落一次盘、只广播一次。
   *
   * 与 setSetting 的分工：那条是 UI 输入框的高频路径（每次击键一次，必须轻）；
   * 导入是一次性批量动作，逐键调 setSetting 会产生 N 次 emit + N 次写 localStorage。
   *
   * 未被插件定义过的键也照收 —— 与 settingsOf 的「透传已保存但未定义的键」对称，
   * 保证「导出→导入」往返不丢数据（作者改了 settings 定义时尤其重要）。
   */
  applySettings(map: Record<string, unknown>): number {
    this.ensure();
    let n = 0;
    for (const [id, v] of Object.entries(map)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      this.settings.set(id, { ...(v as Record<string, unknown>) });
      n++;
    }
    if (n > 0) {
      this.persistSettings();
      this.emit();
    }
    return n;
  }
}

export const pluginRegistry = new PluginRegistry();

// ---------- 补丁钩子管道 ----------

const HOOK_LIMIT = 32; // 全局钩子总数上限（防恶意注册膨胀）
const HOOK_ERR_FUSE = 3; // 钩子连续抛错达到该次数即熔断禁用

interface HookEntry {
  pluginId: string;
  fn: PatchHookFn;
  priority: number;
  errCount: number;
  disabled: boolean;
}

class PatchHookRegistry {
  private points = new Map<string, HookEntry[]>();

  /** 注册钩子（每插件每管道一个，重复注册覆盖旧钩子；全局有上限） */
  add(point: string, pluginId: string, priority: number, fn: PatchHookFn): boolean {
    let list = this.points.get(point);
    if (!list) {
      list = [];
      this.points.set(point, list);
    }
    const prev = list.find((h) => h.pluginId === pluginId);
    if (prev) {
      // 覆盖重注册：保留原槽位，重置熔断计数
      prev.fn = fn;
      prev.priority = priority;
      prev.errCount = 0;
      prev.disabled = false;
      return true;
    }
    if (list.length >= HOOK_LIMIT) return false;
    list.push({ pluginId, fn, priority, errCount: 0, disabled: false });
    list.sort((a, b) => a.priority - b.priority); // 小者优先过链
    return true;
  }

  hasHooks(point: string): boolean {
    const list = this.points.get(point);
    if (!list) return false;
    for (const h of list) if (!h.disabled) return true;
    return false;
  }

  /**
   * 过管道链。返回值语义见 PatchHookFn； rejected=true 表示有钩子拒绝。
   * 快路径：无钩子时直接原值返回（零开销）。
   */
  apply(
    point: string,
    value: unknown,
    meta: PatchWriteMeta,
  ): { value: unknown; rejected: boolean } {
    const list = this.points.get(point);
    if (!list || list.length === 0) return { value, rejected: false };
    let cur = value;
    for (const h of list) {
      if (h.disabled) continue;
      try {
        const r = h.fn(cur, meta);
        if (r === false) return { value: cur, rejected: true };
        if (r !== undefined) cur = r;
      } catch {
        h.errCount++;
        if (h.errCount >= HOOK_ERR_FUSE) h.disabled = true; // 熔断
      }
    }
    return { value: cur, rejected: false };
  }

  removePlugin(pluginId: string): void {
    for (const [point, list] of this.points) {
      const kept = list.filter((h) => h.pluginId !== pluginId);
      if (kept.length !== list.length) {
        if (kept.length === 0) this.points.delete(point);
        else this.points.set(point, kept);
      }
    }
  }
}

const patchHooks = new PatchHookRegistry();

/**
 * 变量写回管道：面板内所有变量/列表写回（updateVaIMod）都过此链。
 * 补丁可改写值、或返回 false 拒绝写入。无钩子时零开销。
 */
export function applyVariableWritePatches(
  value: ScratchValue,
  meta: PatchWriteMeta,
): { value: ScratchValue; rejected: boolean } {
  if (!patchHooks.hasHooks('variable:write')) return { value, rejected: false };
  const r = patchHooks.apply('variable:write', value, meta);
  return { value: r.value as ScratchValue, rejected: r.rejected };
}

// ---------- 运行沙箱 ----------

/** 传给插件 code 的宿主能力（由 VaIModPanel 在挂载时注入） */
export interface PluginHost {
  toast(text: string, kind?: 'ok' | 'err'): void;
  variables(): ReadonlyArray<{
    id: string;
    name: string;
    kind: 'variable' | 'list';
    value: unknown;
    isCloud: boolean;
    targetId: string;
    targetName: string;
    isLocked: boolean;
  }>;
  onVariables(cb: () => void): () => void;
  /** 写变量（面板统一写回管道：安全栈 + 补丁拦截 + 锁同步） */
  write(variableId: string, value: unknown, targetId?: string): void;
  /** 作品能力面（bridge 背书的窄面：导出/捕获） */
  project: PluginProjectApi;
}

/**
 * 执行插件功能代码。
 *
 * 能力面（有意收窄的**接口**，不是安全沙箱）：
 *   - 插件拿得到 ctx（root / store / settings / variables / ui / toast），
 *   - ctx 里没有 vm / bridge / 变量写回通道，写变量只能走 ctx.write（面板漏斗）。
 *   - 允许直接操作自己 root 内的 DOM（这是插件的主要内容能力），root 在 closed
 *     shadow 内，跨插件/跨站点互相影响不到。
 *
 * ⚠️ 如实说明：`new Function('ctx', ...)` 的函数体作用域是全局作用域，插件代码
 * 仍可触达 window/document/globalThis 并由此拿到 vm 之类的全局对象。因此插件的
 * **信任级别等于页面脚本**，「拿不到」指的是「ctx 不提供、也不背书」，不是「技术上
 * 不可达」。安全边界靠「用户主动安装 + 安装确认 + 存储态完整性校验」承担。
 *
 * 返回销毁函数（插件 code 可 return 一个函数，用于清理定时器/监听）。
 */
export function runPluginCode(def: PluginDef, ctx: PluginContext): () => void {
  if (!def.code) return () => {};
  let result: unknown = null;
  try {
    // 参数名与文档一致，作者写 code(ctx) {...} 解构亦可用
    const factory = new Function('ctx', `"use strict";\n${def.code}\n`);
    result = factory.call(undefined, ctx);
  } catch (err) {
    ctx.toast(`插件「${def.name}」运行出错：${err instanceof Error ? err.message : String(err)}`, 'err');
    return () => {};
  }

  // 异步 code（async code(ctx) {...}）：清理函数在 Promise 落定后才到达。
  // holder 中转：同步函数直接可调；Promise 则等 resolve 后替换，reject 记 toast。
  const holder: { fn: unknown } = { fn: result };
  let destroyed = false;
  const runCleanup = (fn: unknown): void => {
    if (typeof fn !== 'function') return;
    try {
      (fn as () => void)();
    } catch {
      /* ignore */
    }
  };
  if (holder.fn && typeof (holder.fn as { then?: unknown }).then === 'function') {
    const pending = holder.fn as PromiseLike<unknown>;
    holder.fn = null;
    void Promise.resolve(pending).then(
      (r) => {
        holder.fn = r;
        // 卸载早于落定（打开插件页后立刻切走/收起）：迟到的清理函数也必须执行，
        // 否则插件注册的定时器/监听器永久泄漏。
        if (destroyed) runCleanup(r);
      },
      (err) => {
        ctx.toast(`插件「${def.name}」运行出错：${err instanceof Error ? err.message : String(err)}`, 'err');
      },
    );
  }
  return () => {
    destroyed = true;
    runCleanup(holder.fn);
    holder.fn = null;
  };
}

/** runPluginBoot 的宿主依赖（由面板注入：只有面板能看到桥接状态与 UI 状态） */
export interface PluginBootDeps {
  /** 等 vm 就绪；resolve(false) = 超时或桥接出错。未注入时 waitVm 定义一律按失败处理 */
  waitVm?: (timeoutMs: number) => Promise<boolean>;
  /** 异步阶段结束、即将执行 code 时回调（面板据此关掉「加载中」提示） */
  onBooting?: (booting: boolean) => void;
  /** 异步装载失败（等待超时 / load 钩子抛错）时回调，由面板显示在标签页内 */
  onFail?: (message: string) => void;
}

/**
 * 按插件的**异步加载定义**（def.async）执行装载：waitVm → load → code。
 *
 * 未声明 async（或只声明了默认值）时与直接调 runPluginCode 完全等价 —— 不引入任何
 * 异步边界，保持既有插件的时序不变。
 *
 * 契约（与 PluginAsyncDef 的注释一致）：
 *   - waitVm：等不到 vm 就绪 → 按**加载失败**处理，不执行 code（面板显示原因）；
 *     这样「我只在有 vm 时才工作」的插件不会带着空数据跑起来产生副作用。
 *   - load：预加载钩子，与 code 同一沙箱边界；抛错同样按失败处理（code 可能依赖它）。
 *   - 返回的清理函数始终可用：code 尚未到达就卸载时，迟到的清理函数也会补执行，
 *     避免插件注册的定时器/监听器泄漏（与 runPluginCode 的处理一致）。
 */
export function runPluginBoot(
  def: PluginDef,
  ctx: PluginContext,
  deps: PluginBootDeps = {},
): () => void {
  const a = def.async;
  if (!a || (!a.waitVm && !a.load)) return runPluginCode(def, ctx);

  let cleanup: (() => void) | null = null;
  let destroyed = false;
  deps.onBooting?.(true);

  void (async () => {
    try {
      if (a.waitVm) {
        const ok = deps.waitVm ? await deps.waitVm(a.timeout) : false;
        if (!ok) {
          throw new Error(`等待 VM 就绪超时（async.timeout = ${a.timeout > 0 ? a.timeout : 15000} ms）`);
        }
        if (destroyed) return;
      }
      if (a.load) {
        const factory = new Function('ctx', `"use strict";\n${a.load}\n`);
        await Promise.resolve(factory.call(undefined, ctx));
        if (destroyed) return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.onBooting?.(false);
      if (deps.onFail) deps.onFail(msg);
      else ctx.toast(`插件「${def.name}」加载失败：${msg}`, 'err');
      return;
    }
    deps.onBooting?.(false);
    if (destroyed) return;
    const fn = runPluginCode(def, ctx);
    if (destroyed) {
      // 卸载早于装载完成：迟到的清理函数立即补执行
      fn();
      return;
    }
    cleanup = fn;
  })();

  return () => {
    destroyed = true;
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  };
}

/**
 * 执行插件刷新钩子（def.refresh，用户点击面板「刷新」且停在该插件页时触发）。
 * 与 runPluginCode 同一沙箱边界；返回 Promise（async refresh）时只接管 rejection
 * 记 toast，不等待落定（刷新按钮不阻塞）。未定义 refresh 时为 no-op。
 */
export function runPluginRefresh(def: PluginDef, ctx: PluginContext): void {
  if (!def.refresh) return;
  let result: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function('ctx', `"use strict";\n${def.refresh}\n`);
    result = factory.call(undefined, ctx);
  } catch (err) {
    ctx.toast(`插件「${def.name}」刷新出错：${err instanceof Error ? err.message : String(err)}`, 'err');
    return;
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result as PromiseLike<unknown>).then(undefined, (err) => {
      ctx.toast(`插件「${def.name}」刷新出错：${err instanceof Error ? err.message : String(err)}`, 'err');
    });
  }
}

/** 构造插件私有存储（localStorage 命名空间隔离） */
export function makePluginStore(id: string): PluginContext['store'] {
  const prefix = `vaimod_plug_${id}_`;
  return {
    get<T>(key: string, def: T): T {
      try {
        const raw = localStorage.getItem(prefix + key);
        if (raw === null) return def;
        return JSON.parse(raw) as T;
      } catch {
        return def;
      }
    },
    set(key: string, value: unknown): void {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
    remove(key: string): void {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** 清理某插件的私有存储（卸载时调用） */
export function clearPluginStore(id: string): void {
  const prefix = `vaimod_plug_${id}_`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

// ---------- 补丁生命周期（headless 执行） ----------

/** 已运行补丁的清理函数与定义引用（id → entry）；同步即「在跑」状态源 */
const patchCleanups = new Map<string, { cleanup: () => void; defRef: PluginDef }>();

/** 补丁宿主能力（由面板注入：toast 出口 + 变量快照/订阅 + 写回管道） */
export interface PatchHost {
  toast(text: string, kind?: 'ok' | 'err'): void;
  variables(): ReadonlyArray<{
    id: string;
    name: string;
    kind: 'variable' | 'list';
    value: unknown;
    isCloud: boolean;
    targetId: string;
    targetName: string;
    isLocked: boolean;
  }>;
  onVariables(cb: () => void): () => void;
  /** 写变量（面板统一写回管道：安全栈 + 补丁拦截 + 锁同步） */
  write(variableId: string, value: unknown, targetId?: string): void;
  /** 作品能力面（bridge 背书的窄面：导出/捕获） */
  project: PluginProjectApi;
}

function stopPatch(id: string): void {
  const entry = patchCleanups.get(id);
  if (entry) {
    try {
      entry.cleanup();
    } catch {
      /* ignore */
    }
    patchCleanups.delete(id);
  }
  patchHooks.removePlugin(id);
}

function runOnePatch(p: InstalledPlugin, host: PatchHost): void {
  const def = p.def;
  stopPatch(def.id); // 升级/重跑：先清旧实例与旧钩子
  const store = makePluginStore(def.id);
  const patchApi: PatchApi = {
    hooks: {
      add(point, fn) {
        if (point !== 'variable:write' || typeof fn !== 'function') return false;
        return patchHooks.add(point, def.id, def.priority, fn);
      },
    },
    hooksRemoveAll: () => patchHooks.removePlugin(def.id),
  };
  const ctx: PluginContext = {
    // 补丁 headless：root 是游离节点（不在面板内），文档明确补丁不要操作 UI
    root: document.createElement('div'),
    store,
    // settings 用 getter 实时读取（补丁不重跑，改设置后 ctx.settings 必须立刻反映新值）
    get settings() {
      return pluginRegistry.settingsOf(def.id);
    },
    onSettings(cb) {
      // 按签名过滤：注册表无关广播（其它插件安装/启停）不触发本补丁回调，
      // 只有本补丁设置真变化才通知（每次独立跟踪 last，多个订阅互不影响）
      let last = JSON.stringify(pluginRegistry.settingsOf(def.id));
      return pluginRegistry.subscribe(() => {
        const sig = JSON.stringify(pluginRegistry.settingsOf(def.id));
        if (sig === last) return;
        last = sig;
        cb(pluginRegistry.settingsOf(def.id));
      });
    },
    variables: () => host.variables(),
    write: (variableId, value, targetId) => host.write(variableId, value, targetId),
    onVariables: (cb) => {
      const unsub = host.onVariables(cb);
      unsubs.push(unsub); // 随补丁生命周期统一退订（插件忘了退也不泄漏）
      return unsub;
    },
    toast: (text, kind) => host.toast(text, kind),
    // 作品能力面：bridge 背书的窄面（导出/捕获）；补丁订阅捕获随生命周期统一退订
    project: {
      ...host.project,
      onCaptured: (cb) => {
        const unsub = host.project.onCaptured(cb);
        unsubs.push(unsub);
        return unsub;
      },
    },
    // UI 样式接口：headless 补丁不传挂载点 → confirm 自动退回原生 confirm
    ui: createPluginUI({ toast: (text, kind) => host.toast(text, kind === 'info' ? 'ok' : kind) }),
    // 本地重命名配置（仅显示层）：给插件「按自己的变量字典生成中文名配置」的能力，
    // 但**不提供任何写变量/改变量名的通道** —— 语义上就不可能「新建」。
    alias: {
      get: () => getAliasConfig(),
      stats: () => aliasStats(),
      importConfig: (raw: unknown) => setAliasConfig(raw),
      exportConfig: () => exportAliasConfig(),
      clear: () => clearAliasConfig(),
      setEnabled: (on: boolean) => setAliasEnabled(on),
      subscribe: (cb: () => void) => {
        const unsub = subscribeAliasConfig(cb);
        unsubs.push(unsub);
        return unsub;
      },
    },
    // 网络类插件的基础设施：本体只提供两件**跨边界必需**的东西。
    //
    // ⛔ 本体不内置任何网络钩子、不认识「防火墙规则」这类业务概念 ——
    //    网络策略（观察/拦截/放行）完全由插件自己决定、自己的 store 自己存。
    //    参考实现：docs/plugin-net-firewall.js
    net: {
      /**
       * 该 XHR 是 VaIMod 本体发出的（云数据直写等）→ 你的网络钩子应当直接放行，
       * 否则用户拉黑某个域名后会连带把本体的后台请求也拦掉（自伤）。
       * 标记用 WeakSet，页面探测不到也伪造不了。
       */
      isInternalXhr: (xhr: unknown) => isInternalXhr(xhr),
      /**
       * 把包装后的函数伪装成原生：登记进本体的 `Function.prototype.toString`
       * 白名单并同步 `name`。**任何包装原生方法的插件都必须调它** ——
       * 否则 `Function.prototype.toString.call(XMLHttpRequest.prototype.send)`
       * 会直接吐出你的包装源码（反作弊最容易查的一处）。
       */
      markNative: (fn: object, name: string) => markNative(fn, name || 'anonymous'),
    },
    patch: patchApi,
    id: def.id,
    extra: def.extra,
  };
  let cleanup: () => void = () => {};
  const unsubs: (() => void)[] = [];
  try {
    cleanup = runPluginCode(def, ctx);
  } catch {
    /* runPluginCode 内部已 toast + 兜底 */
  }
  patchCleanups.set(def.id, {
    cleanup: () => {
      cleanup();
      for (const u of unsubs.splice(0)) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      patchApi.hooksRemoveAll();
    },
    defRef: def,
  });
}

/**
 * 补丁差量同步：面板挂载时与每次插件集合变化后调用。
 * 对比「应运行的已启用补丁」与「在跑集合」，差量启停——
 * 新装/启用 → 运行；禁用/卸载/升级 → 清理重建。幂等。
 */
export function syncPatchPlugins(host: PatchHost): void {
  const shouldRun = new Set<string>();
  for (const p of pluginRegistry.list()) {
    if (p.def.type === 'patch' && p.enabled) shouldRun.add(p.def.id);
  }
  // 停掉不该在跑的（禁用/卸载/类型变更）
  for (const id of [...patchCleanups.keys()]) {
    if (!shouldRun.has(id)) stopPatch(id);
  }
  // 启动应跑未跑的；升级（def 引用变化）→ 清理重建
  for (const p of pluginRegistry.list()) {
    if (!shouldRun.has(p.def.id)) continue;
    const entry = patchCleanups.get(p.def.id);
    if (!entry) {
      runOnePatch(p, host);
    } else if (entry.defRef !== p.def) {
      runOnePatch(p, host); // registry 升级会 set 新 def 对象，引用对比即可感知
    }
  }
}
