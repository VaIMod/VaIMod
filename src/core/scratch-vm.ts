import {
  BridgeStatus,
  type BridgeOptions,
  type NameLockOptions,
  type ScratchValue,
  type ScratchVariable,
  type VariableLockInfo,
  type VariableValue,
} from './types';
import { findVmViaFiber, findVmViaRedux, isVMLike, normalizeValue, sleep, stringToListValue } from './utils';
import { markNative } from '../dom-utils';
import { ccwDataStore } from './ccwdata';
import { installLoadProjectTap } from './lp-guard';
import { getSecureGuard, SECURE_PREFIX } from './secure-guard';
import { getSigGuard } from './sig-guard';
import { VpnChannel } from './vpn';

import { auditOutbound } from './vpn-audit';
import { ztna } from './ztna';
import {
  captureFromLoadInput,
  exportProjectSb3 as exportSb3Impl,
  exportSpriteSb3 as exportSpriteImpl,
  exportSpritesZip as exportSpritesZipImpl,
  listSprites as listSpritesImpl,
} from './project-export';
import {
  earlyWrapped,
  markBridgeWrapped,
  markEarlyHarvested,
  onEarlyCaptured,
  setEarlyCaptureEnabled,
  takeEarlyEntries,
} from './capture-early';
import type { SecureVariableSnapshot } from './secure-vm';

interface LockEntry {
  targetId: string;
  value: ScratchValue;
  interval: number;
  lastWrite: number;
}

/**
 * 访问器级变量锁状态（butterAny f41 同款）：对 variable.value 上 defineProperty
 * 访问器，冻结期外部写入直接被拒（无竞态窗口），解锁恢复原 descriptor（可逆）。
 * 与轮询写回叠加：写回负责面板显示语义，访问器负责真正的值钉死。
 * accessorSet 保存自家 setter 引用：巡检比对 descriptor.set 是否仍为自家函数，
 * 外部 delete / defineProperty 绕锁时立即重新上锁（防绕过自愈）。
 */
interface FrozenVarState {
  variable: Record<string, unknown>;
  variableId: string;
  entry: LockEntry;
  origDesc: PropertyDescriptor | null;
  accessorSet: (nv: unknown) => void;
}

export type BridgeEvent =
  | { type: 'status'; payload: { status: BridgeStatus; info?: string } }
  | { type: 'variables'; payload: ScratchVariable[] }
  | { type: 'error'; payload: Error };

export type BridgeListener = (event: BridgeEvent) => void;

/** 轮询发现通道 id（bind 为事件驱动兜底通道，不在此列） */
type VmChannelId = 'redux' | 'fiber' | 'globals' | 'eureka' | 'iframe' | 'globalscan';

/** 通道评分统计（自动选择的数据源） */
interface ChannelStat {
  /** 命中次数 */
  wins: number;
  /** 被调用次数（含未命中轮） */
  tries: number;
  /** 命中耗时累计（ms，用于速度因子） */
  latencySum: number;
  /** 最近一次命中时间戳 */
  lastWin: number;
}

export class ScratchVM {
  readonly options: Required<Pick<BridgeOptions, 'pollInterval' | 'connectTimeout'>> &
    Omit<BridgeOptions, 'pollInterval' | 'connectTimeout'>;

  private status: BridgeStatus = BridgeStatus.Disconnected;
  private statusInfo = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollWorker: Worker | null = null;
  private tickUrl: string | null = null;
  private snapshot = '';
  private listeners = new Set<BridgeListener>();

  private locks = new Map<string, LockEntry>();
  // 访问器级锁登记表（键 = variable 对象）：解锁按对象恢复 descriptor，不依赖 vm 引用
  private frozenVars = new WeakMap<object, FrozenVarState>();
  // 反向索引（variableId → variable 对象）：WeakMap 不可枚举，按 id 解锁/全清要靠它
  private frozenIndex = new Map<string, object>();
  // 上一轮下发的变量对象（键 = targetId:id），用于引用复用，见 getVariables()
  private varRefCache = new Map<string, ScratchVariable>();
  // 项目原始值基线（键 = targetId:id）：连接后首次读取时快照一次
  private originValues = new Map<string, ScratchValue>();
  private originCaptured = false;
  // 独立 VPN 通道：vm 引用只存于通道实例内，页面无法触及；可动态重建、多实例并行
  private channel: VpnChannel = VpnChannel.create();
  // 安全变量扩展对抗：白名单标记 + 防 VM 泄露检测 + 安全变量可读写
  private secureGuard = getSecureGuard();
  private bindOrig: typeof Function.prototype.bind | null = null;
  private bindHookInstalled = false;
  private bindHookTried = false;

  // ---- VM 劫持安全加固（防检查/防删除/防修改 + 看门狗自愈） ----
  // window.vm / window._vm / Scratch.vm 赋值陷阱是否已装（事件驱动第 8 通道）
  private vmTrapsInstalled = false;
  // vm 引用健康看门狗定时器（连接后每 3s 验证，失效自动重建通道）
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // 上次通道重建时间戳（防风暴：两次重建至少间隔 5s）
  private lastRebuild = 0;
  // 发现循环计数（诊断：waitForVM 每轮 +1，验证重连循环是否存活）
  private discoverTries = 0;
  // ---- 通道自动选择（评分制）：每轮发现前按得分动态排名 ----
  private channelStats = new Map<VmChannelId, ChannelStat>();
  // 最近一次命中的通道（诊断展示；真正决定尝试顺序的是 rankChannels()）
  private lastWinner: VmChannelId | null = null;

  // ---- 作品捕获（loadProject 包装，环形缓冲，纯内存、无持久化） ----
  private captureEnabled = true;
  private captureSeq = 0;
  private captured: Array<{ id: number; time: number; size: number; name: string; blob: Blob }> = [];
  private captureListeners = new Set<(e: { id: number; time: number; size: number; name: string }) => void>();
  private captureWrapped = new WeakSet<object>();
  private earlyHarvestDone = false;
  private static readonly CAPTURE_CAP = 8;

  private static readonly LOCK_FALLBACK_MS = 100;
  private static readonly EMIT_MIN_INTERVAL = 100;
  private static readonly BIND_HOOK_DELAY_MS = 3000;

  private suppressWriteback = new Set<string>();
  private lockTickerTimer: ReturnType<typeof setTimeout> | null = null;
  private vmChangeHookInstalled = false;
  private paused = false;
  private emitScheduled = false;
  private lastEmitAttempt = 0;
  private connectInFlight: Promise<void> | null = null;

  constructor(options: BridgeOptions = {}) {
    this.options = {
      pollInterval: 1200,
      connectTimeout: 60_000,
      ...options,
    };
    // 零信任隔离回调：连续验证失败触发隔离时，把连接状态打回未连接（UI 可重连）
    ztna.onIsolate(() => this.handleZtnaIsolate());
    // 早期捕获盯梢**不在这里停**：构造时 vm 多半还没出现，此时停掉轮询，
    // 「vm 出现 → 极快 loadProject（缓存命中秒载）」会落在空窗里丢初始捕获。
    // 真正的停点在 installProjectCapture：桥接给 vm 挂上 tap 后 markBridgeWrapped()。
  }

  // 零信任隔离处理：停止轮询/锁定、销毁通道、清快照、状态回 Disconnected
  private handleZtnaIsolate(): void {
    try {
      this.stopPolling();
      this.stopLockTicker();
      this.clearAllLocks();
      this.channel.destroy();
      this.channel = VpnChannel.create();
      this.snapshot = '';
      this.setStatus(BridgeStatus.Disconnected, '安全边界异常，请重新连接');
    } catch {
      /* ignore */
    }
  }

  get connected(): boolean {
    return this.status === BridgeStatus.Connected;
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  getStatusInfo(): string {
    return this.statusInfo;
  }

  get rawVM(): unknown {
    return this.channel.getVm();
  }

  /**
   * VM 沙盒面（防逃逸）：只读 + 方法 bound 的受限视图，规则同安全遮罩与 VaIModVPN。
   * 供「沙盒到项目」的对外交互使用；页面/其它脚本拿到也无法绕过 VaIMod 控制。
   */
  get sandboxedVM(): unknown {
    // SDP 不可见性：未通过验证时不暴露沙盒面存在性（返回 null 而非抛错，防探测）
    if (!ztna.verify('sandbox')) return null;
    return this.channel.getSandboxedVm();
  }

  /** 沙盒安全快照（调试 / 健康检查）：结构感知 + 入站清洗后的纯数据变量列表 */
  getSecureSnapshot(): SecureVariableSnapshot[] {
    return this.channel.getSecureVm()?.snapshotVariables() ?? [];
  }

  /** 沙盒调用审计计数（经沙盒面的 vm 方法调用次数） */
  getSandboxCalls(): number {
    return this.channel.getSecureVm()?.callCount ?? 0;
  }

  subscribe(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 连接（幂等 + 并发合并）。
   * 错误态连点「重新获取」，或零信任隔离的自动重连与用户点击同时触发时，
   * 两条 connect 会各建一条 VPN 通道 —— 后建的覆盖 this.channel，旧通道永不
   * destroy（残留在静态实例池里），bindVM / ztna.issue 也会重复执行。
   * 因此进行中的连接只保留一条 promise，重复调用直接复用它。
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectInFlight) return this.connectInFlight;
    const p = this.doConnect();
    this.connectInFlight = p;
    try {
      await p;
    } finally {
      if (this.connectInFlight === p) this.connectInFlight = null;
    }
  }

  private async doConnect(): Promise<void> {
    this.setStatus(BridgeStatus.Connecting, '等待获取vm');
    try {
      const vm = await this.waitForVM();
      this.restoreBindHook();
      // 每次连接重建 VPN 通道（随机新建/销毁、动态调用）
      this.channel = VpnChannel.create();
      this.channel.bind(vm);
      this.startPolling();
      this.bindVM();
      // 安装云数据 hook（csense 运行时拦截算法，按作品/用户分库，无需开发者验证）
      ccwDataStore.install(vm);
      this.setStatus(BridgeStatus.Connected, '已获取vm');
      this.secureGuard.init(vm);
      // 数字签名扩展反制：实例净化 + 双注册咽喉 + 变量名保护。
      // 注意：绝不做 vm.loadProject 实例级伪装（会吞掉站点对 loadProject 的合法
      // 赋值导致 Cave 等无法运行，见 sig-guard.ts 头部注释）。
      getSigGuard().init(vm);
      const sg = getSigGuard();
      const found = sg.find(vm);
      if (found) sg.adopt(found);
      // SDP 单包授权：连接建立后颁发一次性访问凭证（此后所有访问须持续验证）
      ztna.issue();
      // vm 引用健康看门狗：连接期间持续验证，失效自动重建通道（vm 自愈闭环）
      this.startVmWatchdog();
      window.addEventListener('visibilitychange', this.onVisibilityChange);
      this.emitVariables();
    } catch (err) {
      this.restoreBindHook();
      this.channel.destroy();
      this.emit({ type: 'error', payload: err instanceof Error ? err : new Error(String(err)) });
      this.setStatus(BridgeStatus.Error, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  disconnect(): void {
    window.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopVmWatchdog();
    this.restoreBindHook();
    this.unbindVM();
    this.stopPolling();
    this.stopLockTicker();
    this.clearAllLocks();
    ccwDataStore.reset();
    this.channel.destroy();
    this.snapshot = '';
    // 换作品 / 断连：原始值基线与对象缓存都失去意义，清掉以便下次连接重新记录
    this.originValues.clear();
    this.originCaptured = false;
    this.varRefCache.clear();
    // 吊销 SDP 凭证：断开后所有访问一律拒绝（零信任）
    ztna.reset();
    this.setStatus(BridgeStatus.Disconnected);
  }

  getVariables(): ScratchVariable[] {
    // 零信任持续验证：凭证失效/隔离态直接拒绝（不泄露数据）
    if (!ztna.verify('read')) return [];
    // 安全 VM 架构：读链路统一走 SecureVm 结构感知快照（入站清洗 + 防注入），
    // 替代手写 targets 遍历——沙盒安全快照在此真正进入核心读路径。
    const secureVm = this.channel.getSecureVm();
    if (!secureVm) return [];
    const result: ScratchVariable[] = [];
    // 只保留本轮出现过的键：被删除的变量自然淘汰，缓存不会无限增长
    const nextCache = new Map<string, ScratchVariable>();
    for (const s of secureVm.snapshotVariables()) {
      const lock = this.locks.get(s.id);
      const isList = Array.isArray(s.value);
      const kind: ScratchVariable['kind'] = isList ? 'list' : 'variable';
      const value = lock ? lock.value : s.value;
      const targetName = s.targetName || '舞台';
      const isLocked = Boolean(lock);
      const ck = s.targetId + ':' + s.id;
      const prev = this.varRefCache.get(ck);
      // 渲染相关字段逐项比对；列表内容按值比对（引用必然不同），标量直接比引用
      if (
        prev &&
        prev.name === s.name &&
        prev.kind === kind &&
        prev.isCloud === s.isCloud &&
        prev.targetId === s.targetId &&
        prev.targetName === targetName &&
        prev.isLocked === isLocked &&
        ScratchVM.sameValue(prev.value, value)
      ) {
        nextCache.set(ck, prev);
        result.push(prev);
        continue;
      }
      const fresh: ScratchVariable = {
        id: s.id,
        name: s.name,
        kind,
        value,
        isCloud: s.isCloud,
        targetId: s.targetId,
        targetName,
        isLocked,
      };
      nextCache.set(ck, fresh);
      result.push(fresh);
    }
    this.varRefCache = nextCache;
    // 记录项目原始值基线（仅首次，见 captureOrigin 说明）
    this.captureOrigin(result);
    // 合并安全变量（安全扩展的加密存储，解密后展示，可直接修改）
    const secure = this.secureGuard.list();
    if (secure.length > 0) result.push(...secure);
    // 返回明文：遮罩层加解密只发生在真正的传输边界（veil-chain 出网封包），
    // 变量读链路不再编码——否则 UI 必须对每次都新建的对象做有状态解码，
    // 一旦多条读取路径（切页 / 事件 / 刷新 / 导入）交错就会重复解码出乱码。
    return result;
  }

  setVariable(variableId: string, value: ScratchValue, targetId: string): boolean {
    // 安全变量：走安全扩展加密存储（不写入 vm 普通变量）
    if (typeof variableId === 'string' && variableId.startsWith(SECURE_PREFIX)) {
      const ok = this.secureGuard.set(variableId, value);
      if (ok) this.scheduleEmit();
      return ok;
    }
    const ok = this.writeVariable(variableId, value, targetId);
    if (!ok) {
      this.emit({
        type: 'error',
        payload: new Error(`设置变量失败：${variableId}`),
      });
    }
    return ok;
  }

  /**
   * 重命名变量（Scratch 积木按 id 引用变量，改名不影响脚本执行）。
   * 违规名（含 #BVM# 或等于 #VMDBS#）返回 false；安全变量不支持改名。
   */
  renameVariable(variableId: string, newName: string, targetId: string): boolean {
    if (typeof variableId === 'string' && variableId.startsWith(SECURE_PREFIX)) return false;
    // 零信任：改名属写类操作
    if (!ztna.verify('write')) return false;
    const name = String(newName).trim();
    if (!name || name.includes('\x23BVM\x23') || name === '\x23VMDBS\x23') return false;
    const vm = this.channel.getVm() as {
      runtime?: {
        getTargetById?: (tid: string) =>
          | {
              variables?:
                | Map<string, { name?: string }>
                | Record<string, { name?: string }>;
            }
          | undefined;
        requestUpdate?: () => void;
      };
    } | null;
    if (!vm) return false;
    try {
      const target = vm.runtime?.getTargetById?.(targetId);
      const variables = target?.variables;
      if (!variables) return false;
      const variable =
        variables instanceof Map
          ? variables.get(variableId)
          : (variables as Record<string, { name?: string }>)[variableId];
      if (!variable) return false;
      variable.name = name;
      vm.runtime?.requestUpdate?.();
      this.scheduleEmit();
      return true;
    } catch {
      return false;
    }
  }

  lockVariable(
    variableId: string,
    value: ScratchValue,
    targetId: string,
    interval = 0,
  ): boolean {
    // 安全变量不支持锁定（存储不在 vm 内）
    if (typeof variableId === 'string' && variableId.startsWith(SECURE_PREFIX)) return false;
    // 零信任：锁定为写类操作，须通过持续验证
    if (!ztna.verify('lock')) return false;
    if (!this.channel.getVm() || !targetId) return false;
    this.unlockVariable(variableId);
    const entry: LockEntry = {
      targetId,
      value: this.snapshotValue(value),
      interval: Math.max(0, interval),
      lastWrite: 0,
    };
    this.locks.set(variableId, entry);
    this.installVariableChangeHook();
    this.freezeVariableAccessor(variableId, entry);
    this.writeLockValue(variableId, entry);
    this.startLockTicker();
    this.scheduleEmit();
    return true;
  }

  unlockVariable(variableId: string): void {
    if (!this.locks.delete(variableId)) return;
    this.thawVariable(variableId);
    this.scheduleEmit();
  }

  clearAllLocks(): void {
    if (this.locks.size === 0) return;
    this.locks.clear();
    this.thawAllVariables();
    this.scheduleEmit();
  }

  isVariableLocked(variableId: string): boolean {
    return this.locks.has(variableId);
  }

  getLockedVariableIds(): string[] {
    return [...this.locks.keys()];
  }

  getLockedVariables(): VariableLockInfo[] {
    return [...this.locks.entries()].map(([variableId, e]) => ({
      variableId,
      targetId: e.targetId,
      value: e.value,
      interval: e.interval,
    }));
  }

  updateLockedVariableValue(variableId: string, value: ScratchValue): void {
    const entry = this.locks.get(variableId);
    if (entry) entry.value = this.snapshotValue(value);
  }

  lockVariablesByName(options: NameLockOptions): number {
    const { names, value, interval = 30 } = options;
    const nameSet = new Set(names);
    let count = 0;
    for (const v of this.getVariables()) {
      if (!nameSet.has(v.name) || this.locks.has(v.id)) continue;
      if (this.lockVariable(v.id, value, v.targetId, interval)) count++;
    }
    return count;
  }

  unlockVariablesByIds(ids: string[]): void {
    for (const id of ids) this.unlockVariable(id);
  }

  private writeVariable(variableId: string, value: ScratchValue, targetId: string): boolean {
    // 零信任持续验证：凭证失效/隔离态拒绝写入（不泄露通道存在性）
    if (!ztna.verify('write')) {
      this.emit({
        type: 'error',
        payload: new Error('通道验证失败，写入被拒绝'),
      });
      return false;
    }
    // VPN 审核系统：写往 vm 的数据必须通过安全审核（类型/长度/防逃逸对象），失败即拦截
    const audit = auditOutbound(value);
    if (!audit.ok) {
      this.emit({
        type: 'error',
        payload: new Error('VPN 审核拦截：' + audit.reason),
      });
      return false;
    }
    const vm = this.channel.getVm() as {
      setVariableValue?: (targetId: string, variableId: string, value: ScratchValue) => boolean | void;
      runtime?: {
        getTargetById?: (tid: string) =>
          | {
              variables?: Map<string, { value: unknown }> | Record<string, { value: unknown }>;
            }
          | undefined;
        requestUpdate?: () => void;
      };
    } | null;
    if (!vm) return false;

    if (typeof vm.setVariableValue === 'function') {
      try {
        if (vm.setVariableValue(targetId, variableId, value) !== false) {
          return true;
        }
      } catch {}

    }

    try {
      const target = vm.runtime?.getTargetById?.(targetId);
      const variables = target?.variables;
      if (variables) {
        const variable =
          variables instanceof Map ? variables.get(variableId) : variables[variableId];
        if (variable) {
          variable.value = value;
          vm.runtime?.requestUpdate?.();
          return true;
        }
      }
    } catch {}
    return false;
  }

  /**
   * 记录「项目原始值」基线：连接后**首次**读到变量时快照一次，之后不再更新。
   *
   * 用途：导出配置时回答「哪些变量被本工具改过、原值是什么」，从而支持按变量还原。
   * 必须只在首次记录 —— 若每次读取都刷新，用户改完值再读一次，基线就被改后的值
   * 覆盖，差异永远算不出来（等于没记）。
   */
  private captureOrigin(vars: ScratchVariable[]): void {
    if (this.originCaptured) return;
    this.originCaptured = true;
    for (const v of vars) {
      this.originValues.set(
        v.targetId + ':' + v.id,
        Array.isArray(v.value) ? (v.value.slice() as VariableValue[]) : v.value,
      );
    }
  }

  /** 项目原始值基线（键 = `targetId:id`）；未连接 / 未记录时返回空表 */
  getOriginValues(): ReadonlyMap<string, ScratchValue> {
    return this.originValues;
  }

  /**
   * 变量值等价判定（引用复用专用）：标量走严格相等；列表逐项比对内容
   * —— 快照每次都会 clone 数组，列表只能比内容。列表数量远少于标量，成本可接受。
   */
  private static sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private snapshotValue(value: ScratchValue): ScratchValue {
    return Array.isArray(value) ? (value.slice() as VariableValue[]) : value;
  }

  private writeLockValue(variableId: string, entry: LockEntry): boolean {
    return this.writeVariable(variableId, this.snapshotValue(entry.value), entry.targetId);
  }

  /** 解析 vm 内的 variable 对象（Map / Record 双形态） */
  private getVariableObject(variableId: string, targetId: string): Record<string, unknown> | null {
    try {
      const vm = this.channel.getVm() as {
        runtime?: {
          getTargetById?: (tid: string) =>
            | { variables?: Map<string, unknown> | Record<string, unknown> }
            | undefined;
        };
      } | null;
      if (!vm) return null;
      const target = vm.runtime?.getTargetById?.(targetId);
      const variables = target?.variables;
      if (!variables) return null;
      const v = variables instanceof Map ? variables.get(variableId) : variables[variableId];
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * 上访问器锁（butterAny f41 同款，可逆）：冻结期 setter 只放行「与锁定值相等」
   * 的写入（自家写回 / 编辑锁定值后的写回恰好命中），其余写入静默拒绝——
   * 相比纯轮询写回，彻底消除两次写回之间的竞态窗口。
   */
  private freezeVariableAccessor(variableId: string, entry: LockEntry): void {
    const variable = this.getVariableObject(variableId, entry.targetId);
    if (!variable) return;
    const existing = this.frozenVars.get(variable);
    if (existing) {
      existing.entry = entry;
      this.frozenIndex.set(variableId, variable);
      return;
    }
    let cur = variable.value;
    const self = this;
    // setter 引用留存：巡检比对 descriptor.set 判定访问器是否被外部绕过
    const accessorSet = (nv: unknown): void => {
      const st = self.frozenVars.get(variable);
      if (!st) {
        cur = nv; // 状态已清理（防御：descriptor 残留），放行恢复原语义
        return;
      }
      if (self.valuesEqual(nv, st.entry.value)) {
        cur = nv; // 自家写回 / 同值写入放行
      }
      // 其余写入：冻结，拒绝（值保持锁定值）
    };
    const state: FrozenVarState = {
      variable,
      variableId,
      entry,
      origDesc: Object.getOwnPropertyDescriptor(variable, 'value') ?? null,
      accessorSet,
    };
    try {
      Object.defineProperty(variable, 'value', {
        configurable: true,
        enumerable: state.origDesc ? state.origDesc.enumerable !== false : true,
        get: () => cur,
        set: accessorSet,
      });
      this.frozenVars.set(variable, state);
      this.frozenIndex.set(variableId, variable);
    } catch {
      /* 个别宿主对象不可重定义 → 退化为纯轮询写回 */
    }
  }

  /** 解除访问器锁：恢复原 descriptor（butterAny 同款可逆还原） */
  private thawVariable(variableId: string): void {
    // WeakMap 不可枚举 → 登记时同步维护一份反向索引
    const obj = this.frozenIndex.get(variableId);
    if (!obj) return;
    this.frozenIndex.delete(variableId);
    const state = this.frozenVars.get(obj);
    if (!state) return;
    this.frozenVars.delete(obj);
    try {
      if (state.origDesc) Object.defineProperty(obj, 'value', state.origDesc);
      else delete (obj as Record<string, unknown>).value;
    } catch {
      /* ignore */
    }
  }

  private thawAllVariables(): void {
    for (const variableId of [...this.frozenIndex.keys()]) {
      this.thawVariable(variableId);
    }
  }

  private peekVariable(variableId: string, targetId: string): unknown {
    try {
      const vm = this.channel.getVm() as {
        getVariableValue?: (targetId: string, variableId: string) => unknown;
        runtime?: {
          getTargetById?: (
            tid: string,
          ) =>
            | {
                variables?:
                  | Map<string, { value: unknown }>
                  | Record<string, { value: unknown }>;
              }
            | undefined;
        };
      } | null;
      if (!vm) return undefined;
      if (typeof vm.getVariableValue === 'function') {
        return vm.getVariableValue(targetId, variableId);
      }
      const target = vm.runtime?.getTargetById?.(targetId);
      const variables = target?.variables;
      if (variables) {
        const variable =
          variables instanceof Map ? variables.get(variableId) : variables[variableId];
        return variable?.value;
      }
    } catch {}
    return undefined;
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    return a === b;
  }

  private startLockTicker(): void {
    if (this.lockTickerTimer !== null) return;
    this.lockTickerTimer = setTimeout(this.tickLocks, ScratchVM.LOCK_FALLBACK_MS);
  }

  private stopLockTicker(): void {
    if (this.lockTickerTimer !== null) {
      clearTimeout(this.lockTickerTimer);
      this.lockTickerTimer = null;
    }
  }

  private tickLocks = (): void => {
    this.lockTickerTimer = null;
    if (this.locks.size === 0) return;
    // 访问器锁防绕过自愈：外部 delete / defineProperty 覆盖访问器是唯一的绕锁路径
    // （configurable:true 是可逆还原的必要代价），每拍校验 + 即时重装，绕锁窗口 ≤ 一拍
    if (this.frozenIndex.size > 0) this.repairAccessorLocks();
    const now = Date.now();
    for (const [id, entry] of this.locks) {
      if (entry.interval > 0 && now - entry.lastWrite < entry.interval) continue;
      const current = this.peekVariable(id, entry.targetId);
      if (!this.valuesEqual(current, entry.value)) {
        this.suppressWriteback.add(id);
        try {
          this.writeLockValue(id, entry);
        } finally {
          this.suppressWriteback.delete(id);
        }
      }
      entry.lastWrite = now;
    }
    this.lockTickerTimer = setTimeout(this.tickLocks, ScratchVM.LOCK_FALLBACK_MS);
  };

  private onVariableChange = (variable?: unknown): void => {
    const v = variable as { id?: unknown } | null;
    if (!v || typeof v.id !== 'string') return;
    if (this.suppressWriteback.has(v.id)) return;
    const entry = this.locks.get(v.id);
    if (!entry || entry.interval > 0) return;
    this.suppressWriteback.add(v.id);
    try {
      this.writeLockValue(v.id, entry);
    } finally {
      this.suppressWriteback.delete(v.id);
    }
  };

  private installVariableChangeHook(): void {
    if (this.vmChangeHookInstalled) return;
    const vm = this.channel.getVm() as { on?: (event: string, cb: (variable?: unknown) => void) => void };
    vm.on?.('variableChange', this.onVariableChange);
    this.vmChangeHookInstalled = true;
  }

  private removeVariableChangeHook(): void {
    if (!this.vmChangeHookInstalled) return;
    const vm = this.channel.getVm() as { off?: (event: string, cb: (variable?: unknown) => void) => void };
    vm.off?.('variableChange', this.onVariableChange);
    this.vmChangeHookInstalled = false;
  }

  private scheduleEmit(): void {
    if (this.status !== BridgeStatus.Connected || this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emitVariables();
    });
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
    if (event.type === 'status') {
      this.options.onStatusChange?.(event.payload.status, event.payload.info);
    } else if (event.type === 'variables') {
      this.options.onVariablesChange?.(event.payload);
    } else {
      this.options.onError?.(event.payload);
    }
  }

  private setStatus(status: BridgeStatus, info = ''): void {
    this.status = status;
    this.statusInfo = info;
    this.emit({ type: 'status', payload: { status, info } });
  }

  private async waitForVM(): Promise<unknown> {
    // 事件驱动钩子先行：window.vm / _vm / Scratch.vm 赋值陷阱在轮询前就位，
    // 站点赋值瞬间即捕获（快于任何轮询周期一个节拍以上）
    this.installVmSetterTraps();
    // 不设超时：持续等待直到真正发现 vm（用户要求「直到获取到 vm 才隐藏」）。
    // 前 2 秒快速轮询（100ms），配合多通道优先级发现（redux/fiber/window/
    // eureka/iframe/globals + bind 事件兜底），之后降为 300ms——
    // 网络/环境差时也能尽快拿到 vm。
    const startedAt = Date.now();
    const hookAt = startedAt + ScratchVM.BIND_HOOK_DELAY_MS;
    const fastUntil = startedAt + 2000;
    let bindTried = false;
    for (;;) {
      this.discoverTries++;
      const chained = this.channel.getVm();
      if (chained) return chained;
      const vm = this.discoverVM();
      if (vm) return vm;
      if (!bindTried && Date.now() >= hookAt) {
        bindTried = true;
        this.installBindHook();
      }
      await sleep(Date.now() < fastUntil ? 100 : 300);
    }
  }

  private discoverVM(): unknown {
    // 通道优先级基线：redux store → React fiber → window.vm（三全局）
    // → Eureka → iframe → 全局扫描。bind 为事件驱动兜底（延迟 3s 安装
    // Function.prototype.bind 劫持，见 waitForVM / installBindHook），不在轮询链内。
    // 自动选择（评分制）：每轮发现前按「成功率 × 速度 × 新鲜度」实时重排名，
    // 当前环境表现最好的通道自动排到最前；环境变化（站点重建走别的挂载路径）
    // 时旧通道连续扑空 → 分数衰减 → 新优胜通道自动上位，无需任何手动指定。
    const cycleStart = Date.now();
    const order = this.rankChannels();
    for (const id of order) {
      const t0 = Date.now();
      const vm = this.runChannel(id);
      this.markChannelTried(id);
      if (isVMLike(vm)) {
        this.markChannelWin(id, Date.now() - t0);
        return vm;
      }
      if (Date.now() - cycleStart > 1500) break; // 单轮发现预算：超时保底下轮再来
    }
    return null;
  }

  // ---- 通道自动选择：评分制排名（成功率 × 速度 × 新鲜度） ----

  private channelStat(id: VmChannelId): ChannelStat {
    let st = this.channelStats.get(id);
    if (!st) {
      st = { wins: 0, tries: 0, latencySum: 0, lastWin: 0 };
      this.channelStats.set(id, st);
    }
    return st;
  }

  private markChannelTried(id: VmChannelId): void {
    this.channelStat(id).tries++;
  }

  private markChannelWin(id: VmChannelId, latency: number): void {
    const st = this.channelStat(id);
    st.wins++;
    st.latencySum += latency;
    st.lastWin = Date.now();
    this.lastWinner = id;
  }

  /** 通道得分：Laplace 平滑成功率 × 速度因子 × 新鲜度因子 */
  private scoreOf(st: ChannelStat): number {
    const rate = (st.wins + 1) / (st.tries + 2);
    const avg = st.wins > 0 ? st.latencySum / st.wins : Number.POSITIVE_INFINITY;
    // 速度：50ms 为参考量级（本地属性读取远快于 iframe 递归），越快分越高
    const speed = Number.isFinite(avg) ? 1 / (1 + avg / 50) : 1;
    // 新鲜度：10 分钟没赢过开始衰减（长会话中环境切换后旧冠军自然让位）
    const age = Date.now() - st.lastWin;
    const recency = st.lastWin > 0 ? 1 / (1 + age / 600_000) : 1;
    return rate * speed * recency;
  }

  /**
   * 通道排名：有战果的通道按得分降序在前；从没赢过的按固定基线居中；
   * 试过但从未命中的垫底（仍是兜底，只是排最后）。每轮发现前重算。
   */
  private rankChannels(): VmChannelId[] {
    const base: VmChannelId[] = ['redux', 'fiber', 'globals', 'eureka', 'iframe', 'globalscan'];
    const proven = base
      .filter((id) => (this.channelStats.get(id)?.wins ?? 0) > 0)
      .sort(
        (a, b) =>
          this.scoreOf(this.channelStat(b)) - this.scoreOf(this.channelStat(a)) ||
          base.indexOf(a) - base.indexOf(b),
      );
    const dead = base.filter((id) => {
      const st = this.channelStats.get(id);
      return !!st && st.wins === 0 && st.tries > 0;
    });
    const rest = base.filter((id) => !proven.includes(id) && !dead.includes(id));
    return [...proven, ...rest, ...dead];
  }

  /** 单通道执行（统一异常隔离：任一通道抛错只损失该通道，不断发现链） */
  private runChannel(id: VmChannelId): unknown {
    try {
      switch (id) {
        case 'redux':
          return findVmViaRedux();
        case 'fiber':
          return findVmViaFiber();
        case 'globals': {
          // window.vm / window._vm / window.Scratch?.vm（butterAny 三全局同款）
          const w = window as unknown as { vm?: unknown; _vm?: unknown; Scratch?: { vm?: unknown } };
          if (isVMLike(w.vm)) return w.vm;
          if (isVMLike(w._vm)) return w._vm;
          return w.Scratch?.vm;
        }
        case 'eureka':
          return this.findVMEureka();
        case 'iframe':
          return this.findVMInIframes();
        case 'globalscan':
          return this.findVMInGlobals();
      }
    } catch {
      /* 单通道异常按无处理 */
    }
    return null;
  }

  /**
   * 事件驱动 VM 捕获通道（第 8 通道）：对 window.vm / window._vm / Scratch.vm
   * 上 defineProperty 赋值陷阱。站点脚本赋值瞬间即判定形状并捕获——
   * 相比轮询，早一个完整节拍；陷阱属性非枚举、赋值语义原样转发，
   * 行为与普通属性无差别（防检查：descriptor 形态差异是已知最小痕迹，
   * 换取事件驱动捕获，且轮询通道仍全程兜底，陷阱被移除不影响可用性）。
   */
  private installVmSetterTraps(): void {
    if (this.vmTrapsInstalled) return;
    this.vmTrapsInstalled = true;
    const self = this;
    const trapWindowKey = (key: string): void => {
      try {
        const w = window as unknown as Record<string, unknown>;
        const desc = Object.getOwnPropertyDescriptor(w, key);
        // 不可配置：无法重定义，放弃陷阱（轮询通道仍覆盖）
        if (desc && desc.configurable === false) return;
        let cur: unknown = desc && 'value' in desc ? desc.value : undefined;
        Object.defineProperty(w, key, {
          configurable: true,
          enumerable: desc ? desc.enumerable : false,
          get: () => cur,
          set: (nv: unknown) => {
            cur = nv;
            try {
              // 未连接时才采纳（已连接场景由看门狗统一管理，避免误切换通道）
              if (!self.channel.getVm() && nv && typeof nv === 'object') {
                if (isVMLike(nv)) self.adoptVmCandidate(nv);
                else if (self.isVmShaped(nv)) self.adoptVmCandidate(nv);
              }
            } catch {
              /* ignore */
            }
          },
        });
      } catch {
        /* ignore */
      }
    };
    trapWindowKey('vm');
    trapWindowKey('_vm');
    // Scratch.vm 嵌套一层：Scratch 对象已存在且 vm 属性可配置时同样上陷阱
    try {
      const s = (window as unknown as { Scratch?: unknown }).Scratch;
      if (s && typeof s === 'object') {
        const sd = Object.getOwnPropertyDescriptor(s as object, 'vm');
        if (!sd || sd.configurable !== false) {
          let cur2: unknown = sd && 'value' in sd ? sd.value : undefined;
          Object.defineProperty(s as object, 'vm', {
            configurable: true,
            enumerable: sd ? sd.enumerable : true,
            get: () => cur2,
            set: (nv: unknown) => {
              cur2 = nv;
              try {
                if (!self.channel.getVm() && nv && typeof nv === 'object' && isVMLike(nv)) {
                  self.adoptVmCandidate(nv);
                }
              } catch {
                /* ignore */
              }
            },
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** vm 引用是否健康（isVMLike + runtime.targets 可达）——看门狗/加固巡检共用 */
  vmRefHealthy(): boolean {
    try {
      const vm = this.channel.getVm();
      if (!isVMLike(vm)) return false;
      const targets = (vm as { runtime?: { targets?: unknown } }).runtime?.targets;
      return targets !== undefined && targets !== null;
    } catch {
      return false;
    }
  }

  /** VM 钩子通道状态报告（调试通道 / 加固巡检用，只读） */
  hookReport(): {
    setterTrapsInstalled: boolean;
    bindHookInstalled: boolean;
    watchdogActive: boolean;
    connected: boolean;
    vmHealthy: boolean;
    lockedVars: number;
    status: string;
    statusInfo: string;
    discoverTries: number;
    /** 自动选择：最近一次命中的通道 */
    activeChannel: VmChannelId | null;
    /** 自动选择：当前得分最高的通道（下一轮发现将最先尝试它） */
    bestChannel: VmChannelId | null;
    /** 各通道累计命中次数（channelScores 的便捷视图） */
    channelWins: Record<string, number>;
    /** 通道评分明细：wins / tries / score / avgLatency */
    channelScores: Record<string, { wins: number; tries: number; score: number; avgLatency: number }>;
  } {
    return {
      setterTrapsInstalled: this.vmTrapsInstalled,
      bindHookInstalled: this.bindHookInstalled,
      watchdogActive: this.watchdogTimer !== null,
      connected: this.connected,
      vmHealthy: this.vmRefHealthy(),
      lockedVars: this.locks.size,
      status: String(this.status),
      statusInfo: this.statusInfo,
      discoverTries: this.discoverTries,
      activeChannel: this.lastWinner,
      bestChannel: this.rankChannels()[0] ?? null,
      channelWins: Object.fromEntries(
        [...this.channelStats].filter(([, s]) => s.wins > 0).map(([id, s]) => [id, s.wins]),
      ),
      channelScores: Object.fromEntries(
        [...this.channelStats].map(([id, s]) => [
          id,
          {
            wins: s.wins,
            tries: s.tries,
            score: Math.round(this.scoreOf(s) * 1000) / 1000,
            avgLatency: s.wins > 0 ? Math.round(s.latencySum / s.wins) : -1,
          },
        ]),
      ),
    };
  }

  /**
   * VM 引用健康看门狗：连接期间每 3s 验证通道里的 vm 仍可达。
   * 站点重建 vm（重开作品/切页导致旧实例被 GC）时旧引用静默失效——
   * 读链路会一直读旧实例的残留 targets（数据陈旧）或空列表。
   * 看门狗发现失效即自动重建通道（保留锁定：锁定按 variableId 继续在新 vm 上钉值）。
   */
  private startVmWatchdog(): void {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      try {
        if (!this.connected) {
          this.stopVmWatchdog();
          return;
        }
        if (!this.vmRefHealthy()) this.rebuildChannel();
      } catch {
        /* ignore */
      }
    }, 3000);
  }

  private stopVmWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * 通道重建（vm 失效自愈）：销毁旧通道 → 新建 → 重新发现并绑定。
   * 保留锁定与原始值基线（variableId 在新 vm 上通常不变，锁定值继续钉）。
   * 防风暴：两次重建至少间隔 5s。
   */
  rebuildChannel(): void {
    const now = Date.now();
    if (now - this.lastRebuild < 5000) return;
    this.lastRebuild = now;
    try {
      this.stopPolling();
      this.unbindVM(); // 必须在 destroy 前：unregister 事件用的是旧 vm 引用
      this.channel.destroy();
    } catch {
      /* ignore */
    }
    this.channel = VpnChannel.create();
    this.setStatus(BridgeStatus.Connecting, 'VM 引用失效，自动重建通道');
    void this.connect().catch(() => {
      /* 重连失败：状态已是 Error，用户可手动重连；看门狗在连接态外不动作 */
    });
  }

  /** 访问器锁完整性：全部登记锁的 descriptor 仍是自家访问器（未被子外部覆盖/删除） */
  locksIntact(): boolean {
    for (const [, obj] of this.frozenIndex) {
      const st = this.frozenVars.get(obj);
      if (!st) continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, 'value');
        if (!desc || typeof desc.set !== 'function' || desc.set !== st.accessorSet) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** 修复被绕过的访问器锁：重装全部失守锁（返回修复数） */
  repairAccessorLocks(): number {
    let repaired = 0;
    for (const [variableId, obj] of [...this.frozenIndex]) {
      const st = this.frozenVars.get(obj);
      if (!st) continue;
      let broken = false;
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, 'value');
        broken = !desc || typeof desc.set !== 'function' || desc.set !== st.accessorSet;
      } catch {
        broken = true;
      }
      if (!broken) continue;
      const entry = this.locks.get(variableId);
      if (!entry) continue;
      // 清登记后重装（freezeVariableAccessor 对已登记对象只更新 entry，需先摘牌）
      this.frozenVars.delete(obj);
      this.frozenIndex.delete(variableId);
      this.freezeVariableAccessor(variableId, entry);
      this.writeLockValue(variableId, entry);
      repaired++;
    }
    return repaired;
  }

  /** 重新安装作品捕获 tap（加固巡检修复用；内部幂等） */
  reinstallProjectCapture(): void {
    this.installProjectCapture();
  }

  /** Eureka 引擎通道：eureka 对象及其 loader 上查找 vm（多通道并行发现的一路） */
  private findVMEureka(): unknown {
    try {
      const e = (window as unknown as Record<string, unknown>).eureka;
      if (!e || typeof e !== 'object') return null;
      if (isVMLike(e)) return e;
      const direct = (e as Record<string, unknown>).vm;
      if (isVMLike(direct)) return direct;
      const loader = (e as Record<string, unknown>).loader;
      if (loader && typeof loader === 'object') {
        const lvm = (loader as Record<string, unknown>).vm;
        if (isVMLike(lvm)) return lvm;
      }
      // 浅遍历一层：vm 常挂在 eureka 内部字段
      const probe = (obj: unknown): unknown => {
        if (!obj || typeof obj !== 'object') return null;
        for (const v of Object.values(obj as Record<string, unknown>)) {
          if (v && typeof v === 'object' && isVMLike(v)) return v;
        }
        return null;
      };
      const hit = probe(e);
      if (hit) return hit;
      return loader && typeof loader === 'object' ? probe(loader) : null;
    } catch {
      return null;
    }
  }

  /** 递归遍历同域 iframe（含嵌套），查找 window.vm */
  private findVMInIframes(): unknown {
    try {
      const seen = new Set<Window>();
      const scan = (win: Window): unknown => {
        if (seen.has(win)) return null;
        seen.add(win);
        try {
          const v = (win as unknown as { vm?: unknown }).vm;
          if (isVMLike(v)) return v;
        } catch {
          /* 跨域 iframe 访问抛错，忽略 */
        }
        try {
          for (let i = 0; i < win.frames.length; i++) {
            const r = scan(win.frames[i] as Window);
            if (r) return r;
          }
        } catch {
          /* ignore */
        }
        return null;
      };
      return scan(window);
    } catch {
      return null;
    }
  }

  /** 遍历 window 可枚举全局，找 vm-like 对象（预算限制，避免卡顿） */
  private findVMInGlobals(): unknown {
    try {
      let budget = 300;
      const w = window as unknown as Record<string, unknown>;
      for (const k of Object.keys(w)) {
        if (budget-- <= 0) break;
        if (k === 'vm' || k === 'parent' || k === 'frames' || k === 'top' || k === 'self' || k === 'window' || k === 'document') continue;
        try {
          const v = w[k];
          if (v && typeof v === 'object' && isVMLike(v)) return v;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private installBindHook(): void {
    if (this.bindHookInstalled || this.bindHookTried) return;
    this.bindHookTried = true;
    this.bindOrig = Function.prototype.bind;
    const self = this;
    const hooked = function (this: Function, self2: unknown, ...args: unknown[]): unknown {
      const bound = self.bindOrig?.call(this, self2, ...args);
      if (!self.channel.getVm() && self2 && typeof self2 === 'object' && self.isVmShaped(self2)) {
        self.adoptVmCandidate(self2);
      }
      return bound;
    };
    markNative(hooked, 'bind');
    (Function.prototype as unknown as { bind: typeof Function.prototype.bind }).bind = hooked;
    this.bindHookInstalled = true;
  }

  /**
   * VM 形状判定（butterAny f96 同款四路，宽松口径只用于「要不要盯一下」）：
   * ① 完整 isVMLike ② start+loadProject 双函数 ③ own editingTarget+runtime 双属性
   * ④ constructor.name 含 'VM'。前三路有 runtime/方法对兜底，误报率可控。
   */
  private isVmShaped(o: object): boolean {
    if (isVMLike(o)) return true;
    const v = o as Record<string, unknown> & { constructor?: { name?: string } };
    if (typeof v.start === 'function' && typeof v.loadProject === 'function') return true;
    const hasOwn = (k: string): boolean => Object.prototype.hasOwnProperty.call(v, k);
    if (hasOwn('editingTarget') && hasOwn('runtime')) return true;
    return typeof v.constructor?.name === 'string' && v.constructor.name.includes('VM');
  }

  /**
   * 候选采纳：形状齐全直接入通道；只命中宽松形状（CCW 在构造期间 bind，runtime
   * 还没挂 targets）时短暂盯梢（40ms × 最多 5s），形状齐了再入通道。
   */
  private adoptVmCandidate(o: object): void {
    if (isVMLike(o)) {
      this.channel.bind(o);
      this.restoreBindHook();
      return;
    }
    if (this.adoptPolling) return;
    this.adoptPolling = true;
    const started = Date.now();
    const timer = setInterval(() => {
      if (this.channel.getVm() || Date.now() - started > 5000) {
        clearInterval(timer);
        this.adoptPolling = false;
        return;
      }
      if (isVMLike(o)) {
        clearInterval(timer);
        this.adoptPolling = false;
        this.channel.bind(o);
        this.restoreBindHook();
      }
    }, 40);
  }

  private adoptPolling = false;

  private restoreBindHook(): void {
    if (!this.bindHookInstalled || !this.bindOrig) return;
    (Function.prototype as unknown as { bind: typeof Function.prototype.bind }).bind =
      this.bindOrig;
    this.bindHookInstalled = false;
  }

  /** 暂停变量轮询（面板收起时调用，降低后台主线程占用，缓解卡顿） */
  pausePolling(): void {
    this.paused = true;
    this.stopPolling();
  }

  /**
   * 强制刷新并**返回刚重建的变量列表**（未连接 / vm 不可读时返回 null）。
   *
   * 之所以要返回列表：面板切页时原本是「forceRefresh() + getVariables()」两连击，
   * 而 forceRefresh 内部已经重建过一遍列表并 emit 了 —— 第二次纯属重复构建。
   * 6000 变量实测 getVariables≈18ms、forceRefresh≈20ms，合并后切页只跑一遍。
   * 返回 null 的语义：本轮没有可下发的新列表（未连接 / 无 vm targets），
   * 调用方应保留现有列表，**不要**用空数组覆盖（那比显示旧数据更糟）。
   */
  forceRefreshList(): ScratchVariable[] | null {
    if (!this.connected) return null;
    this.snapshot = ''; // 清掉变更摘要 → 必然重建列表并下发
    this.lastEmitAttempt = 0; // 绕过 EMIT_MIN_INTERVAL 节流
    return this.emitVariablesList();
  }

  /**
   * 强制真实刷新：无视「摘要未变化」缓存，立即重扫 vm 状态并重发变量列表。
   * 面板刷新按钮 / 切回页面时调用——保证用户看到的一定是最新值，
   * 而不是上次轮询留下的快照（这是「刷新按钮只转圈不真刷新」的根因）。
   * 返回本次是否真的读到了 vm（未连接时返回 false，由调用方决定提示）。
   */
  forceRefresh(): boolean {
    return this.forceRefreshList() !== null;
  }

  /** 恢复变量轮询（面板展开时调用） */
  resumePolling(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.connected) this.startPolling();
  }

  private startPolling(): void {
    if (this.paused) return;
    this.stopPolling();
    const interval = this.options.pollInterval;
    // 优先用 Worker 独立线程节拍器：定时器在 Worker 线程运行，
    // 即使页面/主线程被长任务卡死，节拍依然准点，主线程一恢复立即补轮询；
    // 卡死期间面板动效走 CSS 合成层，不受影响。Worker 不可用（CSP 等）时降级 setInterval。
    const tw = ScratchVM.createTickWorker();
    if (tw) {
      this.tickUrl = tw.url;
      const worker = tw.worker;
      worker.onmessage = () => this.emitVariables();
      worker.postMessage('start:' + interval);
      this.pollWorker = worker;
      return;
    }
    this.pollTimer = setInterval(() => this.emitVariables(), interval);
  }

  private stopPolling(): void {
    if (this.pollWorker) {
      this.pollWorker.onmessage = null;
      try {
        this.pollWorker.postMessage('stop');
      } catch {
        /* ignore */
      }
      this.pollWorker.terminate();
      this.pollWorker = null;
    }
    // 释放节拍器 Worker 的 blob URL（每次 startPolling 新建，不及时 revoke 会累积泄漏）
    if (this.tickUrl !== null) {
      URL.revokeObjectURL(this.tickUrl);
      this.tickUrl = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // （审核逻辑已并入 VPN 审核系统 vpn-audit.ts：类型/长度 + 防逃逸对象检测）

  // 创建独立线程节拍器：一个只跑 setInterval 的极简 Worker
  private static createTickWorker(): { worker: Worker; url: string } | null {
    try {
      const script =
        'self.onmessage=function(e){var m=String(e.data);if(m.indexOf("start:")===0){var ms=parseInt(m.slice(6),10)||500;if(self._t)clearInterval(self._t);self._t=setInterval(function(){self.postMessage("tick");},ms);}else if(m==="stop"){if(self._t){clearInterval(self._t);self._t=null;}}};';
      const blob = new Blob([script], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.addEventListener(
        'error',
        () => {
          worker.terminate();
          URL.revokeObjectURL(url);
        },
        { once: true },
      );
      return { worker, url };
    } catch {
      return null;
    }
  }

  private bindVM(): void {
    const vm = this.channel.getVm() as { on?: (event: string, cb: () => void) => void };
    vm.on?.('targetsUpdate', this.emitVariables);
    vm.on?.('PROJECT_RUN_START', this.emitVariables);
    this.installVariableChangeHook();
    this.installProjectCapture(); // 捕获包装随 vm 绑定即时挂上
  }

  private unbindVM(): void {
    this.removeVariableChangeHook();
    const vm = this.channel.getVm() as { off?: (event: string, cb: () => void) => void };
    vm.off?.('targetsUpdate', this.emitVariables);
    vm.off?.('PROJECT_RUN_START', this.emitVariables);
  }

  // ==================== 作品导出（官方 VM API 优先） ====================

  /** 当前作品导出为 .sb3（vm.saveProjectSb3 原生可用直接用，否则 polyfill） */
  async exportProjectSb3(): Promise<Blob> {
    const vm = this.channel.getVm();
    if (!vm) throw new Error('VM 未连接');
    return exportSb3Impl(vm as Parameters<typeof exportSb3Impl>[0]);
  }

  /** 单个角色导出为 .sprite3 */
  async exportSpriteSb3(targetId: string): Promise<Blob> {
    const vm = this.channel.getVm();
    if (!vm) throw new Error('VM 未连接');
    return exportSpriteImpl(vm as Parameters<typeof exportSpriteImpl>[0], targetId);
  }

  /** 全部角色打包为 zip（每角色一个 .sprite3） */
  async exportSpritesZip(): Promise<Blob> {
    const vm = this.channel.getVm();
    if (!vm) throw new Error('VM 未连接');
    return exportSpritesZipImpl(vm as Parameters<typeof exportSpritesZipImpl>[0]);
  }

  /** 角色清单（id/名称/造型数/声音数，不触资产数据） */
  listSprites(): Array<{ id: string; name: string; costumeCount: number; soundCount: number }> {
    const vm = this.channel.getVm();
    return vm ? listSpritesImpl(vm as Parameters<typeof listSpritesImpl>[0]) : [];
  }

  // ==================== 作品捕获（loadProject 包装） ====================

  /**
   * 给 vm.loadProject 装捕获包装（幂等：WeakSet 防重复）。
   * 安装位置交给 lp-guard：挂 vm 的直接原型而不是实例 —— 实例包装（哪怕
   * defineProperty 非枚举）会被数字签名家的 _checkEnv 用 hasOwnProperty 判成
   * 「loadProject 被篡改」→ stopAll + while(true) 死循环。原型包装下实例无自有属性，
   * 且 vm.loadProject 恰等于原型链上第一个同名方法 → 环境判定恒为「未篡改」。
   * 伪装细节仍由 lp-guard 保证：非枚举 / name 保持 / toString 返回原源码。
   * 捕获本身零 UI、纯内存环形缓冲（cap 8），仅在启用时记录。
   */
  private installProjectCapture(): void {
    this.ensureEarlyHarvest();
    const vm = this.channel.getVm() as { loadProject?: unknown } | null;
    if (!vm || typeof vm !== 'object' || typeof vm.loadProject !== 'function' || this.captureWrapped.has(vm)) return;
    if (earlyWrapped(vm)) {
      // 早期盯梢（capture-early）已装 tap：不叠加第二个 tap，仅登记避免重复检查
      this.captureWrapped.add(vm);
      markBridgeWrapped(vm); // 早期轮询完成使命，停掉（防与 bridge 长期双跑）
      return;
    }
    if (installLoadProjectTap(vm, (input) => this.recordCapture(input))) {
      this.captureWrapped.add(vm);
      // 桥接 tap 就位：登记 + 停早期轮询。登记进 wrappedVms 后，早期轮询即使
      // 还在跑也不会对这个 vm 重复包装（wrapVmLoadProjectEarly 幂等拒绝）。
      markBridgeWrapped(vm);
    }
  }

  /**
   * 收割早期捕获（capture-early）：只做一次。
   * 存量条目合并进捕获列表（重排 id、保持时间序），之后订阅增量实时接续——
   * 站点初始 loadProject 发生在桥接轮询发现 vm 之前的那部分记录由这里补上。
   */
  private ensureEarlyHarvest(): void {
    if (this.earlyHarvestDone) return;
    this.earlyHarvestDone = true;
    try {
      for (const e of takeEarlyEntries()) {
        const id = ++this.captureSeq;
        this.captured.push({ id, time: e.time, size: e.size, name: e.name, blob: e.blob });
      }
      while (this.captured.length > ScratchVM.CAPTURE_CAP) this.captured.shift();
      markEarlyHarvested();
      onEarlyCaptured((e) => {
        if (!this.captureEnabled) return;
        const id = ++this.captureSeq;
        const entry = { id, time: e.time, size: e.size, name: e.name, blob: e.blob };
        this.captured.push(entry);
        while (this.captured.length > ScratchVM.CAPTURE_CAP) this.captured.shift();
        for (const l of [...this.captureListeners]) {
          try {
            l({ id: entry.id, time: entry.time, size: entry.size, name: entry.name });
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  private recordCapture(input: unknown): void {
    if (!this.captureEnabled) return;
    const made = captureFromLoadInput(input);
    if (!made || made.size <= 0) return;
    const id = ++this.captureSeq;
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const name = `project-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.sb3`;
    const entry = { id, time: d.getTime(), size: made.size, name, blob: made.blob };
    this.captured.push(entry);
    while (this.captured.length > ScratchVM.CAPTURE_CAP) this.captured.shift();
    for (const l of [...this.captureListeners]) {
      try {
        l({ id: entry.id, time: entry.time, size: entry.size, name: entry.name });
      } catch {
        /* ignore */
      }
    }
  }

  /** 自动捕获开关（关闭即清空已捕获条目） */
  setProjectCapture(enabled: boolean): void {
    this.captureEnabled = enabled;
    if (!enabled) this.captured = [];
    setEarlyCaptureEnabled(enabled);
    this.installProjectCapture();
  }

  /** 捕获清单（元信息，不含 Blob） */
  listCaptured(): Array<{ id: number; time: number; size: number; name: string }> {
    return this.captured.map(({ id, time, size, name }) => ({ id, time, size, name }));
  }

  /** 取某条捕获的作品 Blob（已过期的 id 返回 null） */
  getCapturedBlob(id: number): Blob | null {
    return this.captured.find((c) => c.id === id)?.blob ?? null;
  }

  clearCaptured(): void {
    this.captured = [];
  }

  /** 订阅新捕获（返回取消订阅函数） */
  onProjectCaptured(cb: (e: { id: number; time: number; size: number; name: string }) => void): () => void {
    this.captureListeners.add(cb);
    return () => {
      this.captureListeners.delete(cb);
    };
  }

  private emitVariables = (): void => {
    this.emitVariablesList();
  };

  /**
   * emitVariables 的「带返回值」版本：真的重建了列表就把它交出去，
   * 否则返回 null（节流命中 / 摘要未变 / 无 vm targets）。
   * 语义与 emitVariables 完全一致，只是多带一个返回值供面板复用，
   * 避免调用方再走一次 getVariables() 重建同样的列表。
   */
  private emitVariablesList = (): ScratchVariable[] | null => {
    const now = Date.now();
    if (now - this.lastEmitAttempt < ScratchVM.EMIT_MIN_INTERVAL) return null;
    this.lastEmitAttempt = now;
    // vm 实例可能被站点重建（重开作品/切页）：轮询 tick 顺手补挂捕获包装。
    // 已包装时仅一次 WeakSet 命中即返回，零成本。
    this.installProjectCapture();
    // 性能：先直接在 vm 上轻量扫描拼摘要（零对象构造、零 JSON 序列化），
    // 绝大多数轮询 tick 无变化直接返回；只有真正变化才构造变量列表并 emit。
    const key = this.scanVariablesKey();
    if (key === this.snapshot) return null;
    this.snapshot = key;
    const list = this.getVariables();
    this.emit({ type: 'variables', payload: list });
    return list;
  };

  // 变量状态轻量摘要：直接在 vm.targets 上拼 id+值（含锁定覆盖值），
  // 与 getVariables 的展示语义一致，用于判断是否有真实变化。
  private scanVariablesKey(): string {
    const vm = this.channel.getVm() as {
      runtime?: { targets?: unknown[] };
    } | null;
    const targets = vm?.runtime?.targets as
      | Array<{
          variables?:
            | Map<string, { value?: unknown }>
            | Record<string, { value?: unknown }>;
        }>
      | undefined;
    if (!targets) return '';
    // 数组拼接 + 一次性 join：避免字符串 += 的多次中间分配（大列表判重热路径更省 GC）
    const parts: string[] = [];
    for (let t = 0; t < targets.length; t++) {
      const variables = targets[t]?.variables;
      if (!variables) continue;
      if (variables instanceof Map) {
        for (const [id, variable] of variables) {
          parts.push(id, '\u0001');
          const lock = this.locks.get(id);
          const v = lock ? lock.value : variable?.value;
          parts.push(Array.isArray(v) ? (v as unknown[]).join('\u0002') : String(v), '\u001f');
        }
      } else {
        const entries = variables as Record<string, { value?: unknown }>;
        for (const id in entries) {
          parts.push(id, '\u0001');
          const lock = this.locks.get(id);
          const v = lock ? lock.value : entries[id]?.value;
          parts.push(Array.isArray(v) ? (v as unknown[]).join('\u0002') : String(v), '\u001f');
        }
      }
    }
    // 安全变量摘要（数量少，直接拼入判重）
    parts.push(this.secureGuard.key());
    return parts.join('');
  }

  // ===== 运行时变量生命周期（编辑器 / 播放页自动适配） =====

  /**
   * 是否处于「编辑器」模式（有编辑目标、能真正新增积木变量）。
   * 播放页同样有 vm，但无 editingTarget —— 只能建「运行时变量」。
   */
  isEditorMode(): boolean {
    const vm = this.channel.getVm() as {
      runtime?: { _editingTarget?: unknown };
    } | null;
    return Boolean(vm?.runtime?._editingTarget);
  }

  /** 当前编辑/舞台目标 id（编辑器模式可新建变量的落点）；无则返回空 */
  editingTargetId(): string {
    const vm = this.channel.getVm() as {
      runtime?: { _editingTarget?: { id?: string }; getTargetForStage?: () => { id?: string } };
    } | null;
    try {
      return vm?.runtime?._editingTarget?.id ?? vm?.runtime?.getTargetForStage?.()?.id ?? '';
    } catch {
      return '';
    }
  }

  /** 运行时变量名是否已占用（同名同类型，编辑器语义；返回占用所在目标名或 null） */
  nameTakenInTarget(name: string, kind: 'variable' | 'list', targetId: string): string | null {
    const list = this.getVariables();
    for (const v of list) {
      if (v.targetId === targetId && v.kind === kind && v.name === name) return v.targetName || targetId;
    }
    return null;
  }

  /**
   * 新建变量（普通变量）。自动适配：
   * - 编辑器模式：优先走 vm.createVariable（变量区真实出现、可被积木引用）；
   * - 播放页 / 失败降级：runtime.createVariable + 注入目标变量表（运行时变量，可读写）。
   * 返回 {ok, id, mode, message}；新建后同步初始值。
   */
  createRuntimeVariable(
    name: string,
    kind: 'variable' | 'list',
    targetId: string,
    init: ScratchValue,
  ): { ok: boolean; id: string; mode: 'editor' | 'runtime'; message?: string } {
    const id = uidLike();
    const n = String(name).trim();
    if (!n) return { ok: false, id, mode: 'runtime', message: '变量名不能为空' };
    if (n.includes('\x23BVM\x23') || n === '\x23VMDBS\x23') {
      return { ok: false, id, mode: 'runtime', message: '变量名不合法' };
    }
    const audit = auditOutbound(init);
    if (!audit.ok) return { ok: false, id, mode: 'runtime', message: 'VPN 审核拦截：' + audit.reason };
    if (!ztna.verify('write')) return { ok: false, id, mode: 'runtime', message: '通道验证失败，写入被拒绝' };
    const vm = this.channel.getVm() as {
      createVariable?: (id: string, name: string, type: string, isCloud: boolean) => unknown;
      runtime?: {
        createVariable?: (vid: string, vname: string, vtype: string, isCloud: boolean) => unknown;
        getTargetById?: (tid: string) =>
          | { variables?: Map<string, unknown> | Record<string, unknown>; id?: string }
          | undefined;
        requestUpdate?: () => void;
        _editingTarget?: { id?: string };
      };
    } | null;
    if (!vm?.runtime) return { ok: false, id, mode: 'runtime', message: 'vm 未就绪' };
    const runtime = vm.runtime;

    // ① 编辑器模式：真实新建（带变量积木块）；标准 Scratch VM 签名 (id, name, type, isCloud)
    let created = false;
    if (typeof vm.createVariable === 'function' && runtime._editingTarget?.id === targetId) {
      try {
        vm.createVariable(id, n, kind === 'list' ? 'list' : '', false);
        created = this.variableExists(id, targetId);
      } catch {
        created = false;
      }
    }
    // ② 播放页 / 降级：运行时注入目标变量表
    if (!created) {
      try {
        const target = runtime.getTargetById?.(targetId);
        if (!target) return { ok: false, id, mode: 'runtime', message: '目标不存在，无法新建' };
        // 优先走运行时 createVariable；没有该 API 或返回空时，自构造变量对象注入目标变量表
        let variable: unknown;
        if (typeof runtime.createVariable === 'function') {
          try {
            variable = runtime.createVariable(id, n, kind === 'list' ? 'list' : '', false);
          } catch {
            variable = null;
          }
        }
        if (!variable) {
          variable = { id, name: n, value: kind === 'list' ? [] : 0 };
        }
        const variables = target.variables as Map<string, unknown> | Record<string, unknown> | undefined;
        if (variables instanceof Map) {
          variables.set(id, variable);
        } else if (variables && typeof variables === 'object') {
          (variables as Record<string, unknown>)[id] = variable;
        } else {
          return { ok: false, id, mode: 'runtime', message: '目标变量表不可写' };
        }
        created = true;
      } catch {
        created = false;
      }
    }
    if (!created) return { ok: false, id, mode: 'runtime', message: '新建失败（环境不支持）' };

    // ③ 写入初始值 + 广播
    const mode: 'editor' | 'runtime' = typeof vm.createVariable === 'function' && runtime._editingTarget?.id === targetId ? 'editor' : 'runtime';
    const initial: ScratchValue =
      kind === 'list'
        ? Array.isArray(init)
          ? (init as VariableValue[])
          : stringToListValue(String(init))
        : normalizeValue(init);
    if (!this.writeVariable(id, initial, targetId)) {
      // 初始值写入失败不阻断新建：变量已存在，仅提醒
      runtime.requestUpdate?.();
      this.scheduleEmit();
      return { ok: true, id, mode, message: '已新建（初始值写入失败）' };
    }
    runtime.requestUpdate?.();
    this.scheduleEmit();
    return { ok: true, id, mode };
  }

  /** 删除变量条目（先回收站后调用）。编辑器优先真实删除；播放页移除运行时变量条目 */
  deleteVariableEntry(variableId: string, targetId: string): boolean {
    if (typeof variableId === 'string' && variableId.startsWith(SECURE_PREFIX)) return false;
    if (!ztna.verify('write')) return false;
    const vm = this.channel.getVm() as {
      deleteVariable?: (projectId: string, vid: string) => unknown;
      runtime?: {
        getTargetById?: (tid: string) =>
          | { variables?: Map<string, unknown> | Record<string, unknown>; id?: string }
          | undefined;
        requestUpdate?: () => void;
        _editingTarget?: { id?: string };
      };
    } | null;
    if (!vm?.runtime) return false;
    const runtime = vm.runtime;
    if (typeof vm.deleteVariable === 'function' && runtime._editingTarget?.id === targetId) {
      try {
        vm.deleteVariable('', variableId);
        if (!this.variableExists(variableId, targetId)) {
          runtime.requestUpdate?.();
          this.scheduleEmit();
          return true;
        }
      } catch {
        /* 降级到运行时移除 */
      }
    }
    try {
      const target = runtime.getTargetById?.(targetId);
      const variables = target?.variables;
      if (!variables) return false;
      if (variables instanceof Map) {
        variables.delete(variableId);
      } else {
        delete (variables as Record<string, unknown>)[variableId];
      }
      runtime.requestUpdate?.();
      this.scheduleEmit();
      return true;
    } catch {
      return false;
    }
  }

  /** 变量是否仍存在于目标（新建/删除是否生效的判定） */
  variableExists(variableId: string, targetId: string): boolean {
    const vm = this.channel.getVm() as {
      runtime?: { getTargetById?: (tid: string) => { variables?: Map<string, unknown> | Record<string, unknown> } | undefined };
    } | null;
    try {
      const variables = vm?.runtime?.getTargetById?.(targetId)?.variables;
      if (!variables) return false;
      return variables instanceof Map ? variables.has(variableId) : Object.prototype.hasOwnProperty.call(variables, variableId);
    } catch {
      return false;
    }
  }

  /**
   * 全部变量的监视器显隐状态（仅含已存在监视器块的项）。
   * 供面板一次性读取生成 Map，避免每行都走一次 getMonitorState 全量扫描。
   */
  monitorStates(): Map<string, boolean> {
    const out = new Map<string, boolean>();
    try {
      const vm = this.channel.getVm() as {
        runtime?: { getMonitorState?: () => Map<string, { visible: boolean }> | undefined };
      } | null;
      const state = vm?.runtime?.getMonitorState?.();
      if (!state) return out;
      for (const [id, entry] of state) {
        if (entry && typeof entry.visible === 'boolean') out.set(id, entry.visible);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * 监视器显隐（对齐「变量与列表」扩展 changeMonitor*）。
   * 返回 true 表示已设置；没有监视器块的变量返回 false（UI 提示）。
   */
  setMonitorVisible(variableId: string, visible: boolean): boolean {
    const vm = this.channel.getVm() as {
      runtime?: {
        monitorBlocks?: {
          changeBlock?: (arg: { id: string; element: string; value: unknown }, rt: unknown) => unknown;
        };
        getMonitorState?: () => Map<string, { visible: boolean }>;
      };
    } | null;
    const runtime = vm?.runtime;
    try {
      if (!runtime?.getMonitorState?.().has(variableId)) return false;
      runtime.monitorBlocks?.changeBlock?.(
        { id: variableId, element: 'checkbox', value: visible },
        runtime,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 当前监视器是否可见；null=该变量没有监视器 */
  monitorVisible(variableId: string): boolean | null {
    const vm = this.channel.getVm() as {
      runtime?: { getMonitorState?: () => Map<string, { visible: boolean }> | undefined };
    } | null;
    try {
      const state = vm?.runtime?.getMonitorState?.();
      const entry = state?.get(variableId);
      if (!entry) return null;
      return Boolean(entry.visible);
    } catch {
      return null;
    }
  }

  /** 读取变量原始值（列表为真实数组、标量保持类型）；找不到返回 null */
  readVariableValue(variableId: string, targetId: string): ScratchValue | null {
    if (!ztna.verify('read')) return null;
    const secureVm = this.channel.getSecureVm();
    if (!secureVm) return null;
    const snap = secureVm.findVariable(variableId, targetId);
    if (!snap) return null;
    return Array.isArray(snap.value) ? (snap.value.slice() as VariableValue[]) : snap.value;
  }

  /**
   * 批量回读「vm 真实值」（**忽略锁定覆盖值**）——整表快照采集专用。
   *
   * 语义与逐条 readVariableValue 完全一致：同样经 auditInbound/normalizeValue 清洗，
   * 同样对「不存在于 vm 的变量」（安全扩展变量等）**不出现**在结果里。
   * 区别只在遍历次数：逐条调用每条都要过 ztna 校验 + getSecureVm + 扫 targets，
   * 5704 变量实测 65.6ms，占快照总成本 74%；这里整表只走一遍 SecureVm 快照。
   *
   * 为什么不能拿面板列表里的 value（那个是现成的）：
   * getVariables() 会把**锁定变量的覆盖值**写进 value（展示语义），
   * 而快照要存的是 vm 当前真值 —— 还原时锁定会自己再覆盖一次。
   *
   * 键 = `` `${targetId}\u0000${variableId}` ``（\u0000 不在 Scratch id 字符集内，不会碰撞）。
   * 值取自 SecureVm.snapshotVariables()：数组项已由 auditInbound 复制、标量不可变，
   * 因此调用方**不需要**再深拷贝一层。
   */
  readVmLiveValues(): Map<string, ScratchValue> {
    const out = new Map<string, ScratchValue>();
    if (!ztna.verify('read')) return out;
    const secureVm = this.channel.getSecureVm();
    if (!secureVm) return out;
    for (const s of secureVm.snapshotVariables()) {
      out.set(s.targetId + '\u0000' + s.id, s.value);
    }
    return out;
  }

  // 页面隐藏（切后台/最小化）时暂停轮询，回到前台自动恢复：后台零轮询开销
  private onVisibilityChange = (): void => {
    if (document.hidden) this.pausePolling();
    else if (this.connected) this.startPolling();
  };
}

/** 轻量随机变量 id（不依赖外部命名） */
function uidLike(): string {
  try {
    const a = crypto.getRandomValues(new Uint32Array(3));
    return 'v' + a[0].toString(36) + a[1].toString(36) + a[2].toString(36);
  } catch {
    return 'v' + Math.random().toString(36).slice(2, 12);
  }
}

export type { BridgeStatus, ScratchVariable, VariableValue };
