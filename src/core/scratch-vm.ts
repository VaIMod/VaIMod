import {
  BridgeStatus,
  type BridgeOptions,
  type NameLockOptions,
  type ScratchValue,
  type ScratchVariable,
  type VariableLockInfo,
  type VariableValue,
} from './types';
import { findVmViaFiber, isVMLike, normalizeValue, sleep, stringToListValue } from './utils';
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
  markEarlyHarvested,
  onEarlyCaptured,
  setEarlyCaptureEnabled,
  stopEarlyCapturePoll,
  takeEarlyEntries,
} from './capture-early';
import type { SecureVariableSnapshot } from './secure-vm';

interface LockEntry {
  targetId: string;
  value: ScratchValue;
  interval: number;
  lastWrite: number;
}

export type BridgeEvent =
  | { type: 'status'; payload: { status: BridgeStatus; info?: string } }
  | { type: 'variables'; payload: ScratchVariable[] }
  | { type: 'error'; payload: Error };

export type BridgeListener = (event: BridgeEvent) => void;

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
    // 早期捕获盯梢到此为止（此后 vm 出现统一走本桥的 tick 补挂，防双包装）
    stopEarlyCapturePoll();
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
    this.writeLockValue(variableId, entry);
    this.startLockTicker();
    this.scheduleEmit();
    return true;
  }

  unlockVariable(variableId: string): void {
    if (!this.locks.delete(variableId)) return;
    this.scheduleEmit();
  }

  clearAllLocks(): void {
    if (this.locks.size === 0) return;
    this.locks.clear();
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
    // 不设超时：持续等待直到真正发现 vm（用户要求「直到获取到 vm 才隐藏」）。
    // 前 2 秒快速轮询（100ms），配合多通道并行发现（window/fiber/eureka/iframe/globals），
    // 之后降为 300ms——网络/环境差时也能尽快拿到 vm。
    const startedAt = Date.now();
    const hookAt = startedAt + ScratchVM.BIND_HOOK_DELAY_MS;
    const fastUntil = startedAt + 2000;
    let bindTried = false;
    for (;;) {
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
    const windowVM = (window as unknown as { vm?: unknown }).vm;
    if (isVMLike(windowVM)) return windowVM;
    const fiberVM = findVmViaFiber();
    if (isVMLike(fiberVM)) return fiberVM;
    // Eureka 引擎：eureka 对象 / loader 及其内部可能持有 vm（Eureka 也会写 globalThis.vm）
    const eurekaVM = this.findVMEureka();
    if (isVMLike(eurekaVM)) return eurekaVM;
    // iframe 内查找（分享播放页常见：播放器嵌入 iframe，vm 不在主 window）
    const iframeVM = this.findVMInIframes();
    if (isVMLike(iframeVM)) return iframeVM;
    // 全局对象扫描（ccw 可能把 vm 挂在其它全局名而非 window.vm）
    const globalVM = this.findVMInGlobals();
    if (isVMLike(globalVM)) return globalVM;
    return null;
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
      if (
        !self.channel.getVm() &&
        self2 &&
        typeof self2 === 'object' &&
        (self2 as { runtime?: { targets?: unknown } }).runtime?.targets
      ) {
        self.channel.bind(self2);
        self.restoreBindHook();
      }
      return bound;
    };
    markNative(hooked, 'bind');
    (Function.prototype as unknown as { bind: typeof Function.prototype.bind }).bind = hooked;
    this.bindHookInstalled = true;
  }

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
   * 强制真实刷新：无视「摘要未变化」缓存，立即重扫 vm 状态并重发变量列表。
   * 面板刷新按钮 / 切回页面时调用——保证用户看到的一定是最新值，
   * 而不是上次轮询留下的快照（这是「刷新按钮只转圈不真刷新」的根因）。
   * 返回本次是否真的读到了 vm（未连接时返回 false，由调用方决定提示）。
   */
  forceRefresh(): boolean {
    if (!this.connected) return false;
    this.snapshot = ''; // 清掉变更摘要 → emitVariables 必然重建列表并下发
    this.lastEmitAttempt = 0; // 绕过 EMIT_MIN_INTERVAL 节流
    this.emitVariables();
    return true;
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
      return;
    }
    if (installLoadProjectTap(vm, (input) => this.recordCapture(input))) {
      this.captureWrapped.add(vm);
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
    const now = Date.now();
    if (now - this.lastEmitAttempt < ScratchVM.EMIT_MIN_INTERVAL) return;
    this.lastEmitAttempt = now;
    // vm 实例可能被站点重建（重开作品/切页）：轮询 tick 顺手补挂捕获包装。
    // 已包装时仅一次 WeakSet 命中即返回，零成本。
    this.installProjectCapture();
    // 性能：先直接在 vm 上轻量扫描拼摘要（零对象构造、零 JSON 序列化），
    // 绝大多数轮询 tick 无变化直接返回；只有真正变化才构造变量列表并 emit。
    const key = this.scanVariablesKey();
    if (key === this.snapshot) return;
    this.snapshot = key;
    const list = this.getVariables();
    this.emit({ type: 'variables', payload: list });
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
