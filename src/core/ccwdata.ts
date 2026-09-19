import { Database } from './database';
import { markNative } from '../dom-utils';
import {
  hookOfficialCloudApi,
  officialSaveProject,
  officialSaveProjectCloud,
} from './official-cloud';
import { auditOutbound } from './vpn-audit';
import { ztna } from './ztna';
import { removeDisplayName } from './display-names';

export type CloudType = 'project' | 'user';

// 云数据「全局锁定」协议：
// - 锁定位不是本地内存态，而是以特殊保留键写入云端数据库（与数据同库）：
//   键名 = LOCK_PREFIX + 目标名，值 '1'=锁定，'0'/缺失=解锁。
// - 任何 VaIMod 客户端看到该条目为 '1' 都会拒绝写入（提示「当前云变量已锁定」）；
//   解锁（写 '0'）后恢复。这样锁定跨会话、跨客户端（其它 VaIMod 用户）持久生效。
// - 被锁定的条目值被「钉住」：本端 wrapSet 拦截 + 周期钉回（服务器值 ≠ 锁定值
//   时盖回），除非手动解锁否则谁都改不了。
export const LOCK_PREFIX = '#VMLOCK#:';
const LOCK_ON = '1';
const LOCK_OFF = '0';
const lockMetaOf = (name: string): string => LOCK_PREFIX + name;
const isLockMeta = (name: string): boolean => name.startsWith(LOCK_PREFIX);
const lockTargetOf = (meta: string): string => meta.slice(LOCK_PREFIX.length);

export interface LockInfo {
  value: unknown; // 钉住的值（锁定瞬间的云数据值）
  at: number;
  confirmed: boolean; // 已确认云端 marker='1' 持久生效（供其它客户端拒绝写入）
}

// 云数据扩展通道（VPN 同构）：扩展引用只存于模块闭包，实例对象上不暴露任何字段——
// 页面即使拿到 CcwDataStore 实例也触及不到云数据扩展对象。
let cloudChannel: any = null;
// 最近一次 install 的 vm（供云数据扩展未加载时重新捕获）
let retryVm: any = null;

/**
 * ccw.site 云数据访问层。
 *
 * 采用 csense-rev 的算法：直接 hook ccw.site 运行时注册的云数据扩展对象
 * （vm.runtime.compilerRegisterExtension），patch 它的
 * _getValueFromProject / _setValueToProject / _getValueFromUser / _setValueToUser，
 * 把云数据镜像进本地 Database，并按「作品(project) / 用户(user)」分库。
 *
 * 关键点：这是运行时拦截 —— ccw.site 自身的扩展对象已经在运行时被注册，
 * 我们只是拦截它，因此**不需要**走 ccw.site 官方的「开发者验证」门控。
 */

export class CcwDataStore {
  readonly project = new Database();
  readonly user = new Database();

  private captured = new WeakSet<object>();
  private installed = false;
  // 云数据变更订阅：平台扩展写入云数据时通知（节流合并），驱动面板即时刷新
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;

  // 全局锁登记：type → (目标名 → LockInfo)
  private locks: Record<CloudType, Map<string, LockInfo>> = {
    project: new Map(),
    user: new Map(),
  };
  // 原生通道（capture 时绑定），供 marker 读写 / 钉回绕过 wrap 递归
  private origPGet: ((n: string) => Promise<unknown>) | null = null;
  private origPSet: ((n: string, v: unknown) => Promise<unknown>) | null = null;
  private origUGet: ((n: string) => Promise<unknown>) | null = null;
  private origUSet: ((n: string, v: unknown) => Promise<unknown>) | null = null;
  private lockTickerTimer: ReturnType<typeof setTimeout> | undefined;

  /** 目标名是否处于全局锁定 */
  isLocked(type: CloudType, name: string): boolean {
    return this.locks[type].has(name);
  }

  /** 读取云端 marker 判断是否被（本端或远端）锁定 */
  private async readRemoteLock(type: CloudType, name: string): Promise<boolean> {
    const origGet = type === 'project' ? this.origPGet : this.origUGet;
    if (!origGet) return this.isLocked(type, name);
    try {
      const meta = await origGet(lockMetaOf(name));
      return meta === LOCK_ON;
    } catch {
      return this.isLocked(type, name);
    }
  }

  /** 锁定前/保存前的云端确认：被其它 VaIMod 锁定则抛错（提示解锁） */
  async ensureWritable(type: CloudType, name: string): Promise<void> {
    const local = this.locks[type].get(name);
    if (local) throw new Error('当前云变量已锁定，请先解锁再修改');
    if (await this.readRemoteLock(type, name)) {
      // 远端锁定的条目同步进本地登记（本会话同样拒绝写入 + 钉回）
      const db = type === 'project' ? this.project : this.user;
      const v = db.get(name);
      if (v !== undefined) {
        this.locks[type].set(name, { value: v, at: Date.now(), confirmed: true });
        this.tryStartTicker();
      }
      throw new Error('当前云变量已锁定，请先解锁再修改');
    }
  }

  /**
   * 锁定某条云数据：钉住当前值，写入云端 marker（跨会话/跨客户端持久）。
   * 返回确认态（false = 云端 marker 暂未写成功，本端仍生效并自动重试）。
   */
  async lockValue(type: CloudType, name: string): Promise<boolean> {
    // 锁标记自身不允许再加锁（避免嵌套前缀 #VMLOCK#:#VMLOCK#:xxx）
    if (isLockMeta(name)) throw new Error('锁标记不能锁定');
    const db = type === 'project' ? this.project : this.user;
    const value = db.get(name);
    if (value === undefined) throw new Error(`「${name}」不存在，无法锁定`);
    const meta = lockMetaOf(name);
    const had = this.locks[type].has(name);
    if (!had) {
      this.locks[type].set(name, { value, at: Date.now(), confirmed: false });
      db.set(name, value); // 确保本地镜像为钉住值
      this.notifyChanged();
    }
    const lock = this.locks[type].get(name);
    if (!lock) return false;
    const origGet = type === 'project' ? this.origPGet : this.origUGet;
    const origSet = type === 'project' ? this.origPSet : this.origUSet;
    let confirmed = false;
    if (origSet) {
      try {
        await origSet(meta, LOCK_ON);
        if (origGet) {
          const back = await origGet(meta);
          confirmed = back === LOCK_ON;
        } else {
          confirmed = true;
        }
      } catch {
        confirmed = false;
      }
    }
    lock.confirmed = confirmed || lock.confirmed;
    this.tryStartTicker();
    return lock.confirmed;
  }

  /** 解锁：写云端 marker '0' 并清除本地登记（远端 VaIMod 会跟随释放） */
  async unlockValue(type: CloudType, name: string): Promise<void> {
    if (isLockMeta(name)) return; // 锁标记无意义，解锁直接忽略
    this.locks[type].delete(name);
    const origSet = type === 'project' ? this.origPSet : this.origUSet;
    if (origSet) {
      try {
        await origSet(lockMetaOf(name), LOCK_OFF);
      } catch {
        /* ignore：云端 marker 尽力置 0 */
      }
    }
    this.notifyChanged();
  }

  /** 同步远端登记：发现云端 marker='1' 的目标（供其它客户端锁定的条目感知） */
  async syncRemoteLocks(type: CloudType, names: string[]): Promise<number> {
    const origGet = type === 'project' ? this.origPGet : this.origUGet;
    if (!origGet || names.length === 0) return 0;
    const db = type === 'project' ? this.project : this.user;
    let found = 0;
    for (const name of names) {
      if (this.locks[type].has(name)) continue;
      try {
        const meta = await origGet(lockMetaOf(name));
        if (meta === LOCK_ON) {
          const v = db.get(name);
          if (v !== undefined) {
            this.locks[type].set(name, { value: v, at: Date.now(), confirmed: true });
            found++;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (found > 0) this.tryStartTicker();
    return found;
  }

  private tryStartTicker(): void {
    if (this.lockTickerTimer) return;
    const hasAny = this.locks.project.size > 0 || this.locks.user.size > 0;
    if (!hasAny) return;
    const tick = async (): Promise<void> => {
      this.lockTickerTimer = undefined;
      if (this.locks.project.size === 0 && this.locks.user.size === 0) return;
      try {
        await this.tickLocks();
      } catch {
        /* ignore */
      }
      if (this.locks.project.size > 0 || this.locks.user.size > 0) {
        this.lockTickerTimer = setTimeout(() => void tick(), 4000);
      }
    };
    this.lockTickerTimer = setTimeout(() => void tick(), 2000);
  }

  private async tickLocks(): Promise<void> {
    const types: CloudType[] = ['project', 'user'];
    for (const type of types) {
      const map = this.locks[type];
      if (map.size === 0) continue;
      const origGet = type === 'project' ? this.origPGet : this.origUGet;
      const origSet = type === 'project' ? this.origPSet : this.origUSet;
      const db = type === 'project' ? this.project : this.user;
      if (!origGet || !origSet) continue;
      let changed = false;
      for (const [name, lock] of [...map.entries()]) {
        try {
          // ① 未确认的 marker 持续重试写入，直到云端持久生效
          if (!lock.confirmed) {
            await origSet(lockMetaOf(name), LOCK_ON);
            const back = await origGet(lockMetaOf(name));
            if (back === LOCK_ON) {
              lock.confirmed = true;
            } else {
              continue; // 服务端暂不可用，下轮再试
            }
          }
          // ② 远端已解锁（marker 不再是 '1'）→ 本地跟随释放
          const metaNow = await origGet(lockMetaOf(name));
          if (metaNow !== LOCK_ON) {
            map.delete(name);
            changed = true;
            continue;
          }
          // ③ 钉回：服务器值 ≠ 锁定值 → 盖回（防作品/他人篡改）
          const serverVal = await origGet(name);
          if (serverVal !== lock.value) {
            await origSet(name, lock.value);
            db.set(name, lock.value);
          }
        } catch {
          /* 单条失败不中断其余 */
        }
      }
      if (changed) this.notifyChanged();
    }
  }

  get ready(): boolean {
    return cloudChannel !== null;
  }

  get hasData(): boolean {
    return this.project.keys().next().done !== true || this.user.keys().next().done !== true;
  }

  /** 订阅云数据变更（写入触发，300ms 节流合并）；返回退订函数 */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notifyChanged(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      for (const cb of this.listeners) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    }, 300);
  }

  /** 在已拿到 vm 后调用：安装 hook 并立即尝试捕获已注册的云数据扩展 */
  install(vm: any): void {
    if (this.installed) return;
    const runtime = vm?.runtime;
    if (!runtime) return;
    this.installed = true;
    retryVm = vm;
    // 官方正规 API 通道：观察平台扩展自身的云数据库请求，捕获 endpoint 供直写
    hookOfficialCloudApi();

    try {
      this.tryCapture(runtime);
    } catch {
      /* ignore */
    }

    const orig = runtime.compilerRegisterExtension;
    if (typeof orig === 'function') {
      const self = this;
      const hooked = function (this: any, name: string, ext: any) {
        let res: any;
        try {
          res = orig.call(this, name, ext);
        } catch {
          /* ignore */
        }
        try {
          self.tryCapture(runtime);
        } catch {
          /* ignore */
        }
        return res;
      };
      markNative(hooked, 'compilerRegisterExtension');
      runtime.compilerRegisterExtension = hooked;
    }

    // 兜底：云数据扩展可能稍晚于 connect 才注册，短重试确保捕获
    let attempts = 0;
    const retry = setInterval(() => {
      if (cloudChannel || attempts++ > 12) {
        clearInterval(retry);
        return;
      }
      try {
        this.tryCapture(runtime);
      } catch {
        /* ignore */
      }
    }, 500);
  }

  /** vm 断开/切换项目时调用：清空捕获与镜像，下次连接重新捕获 */
  reset(): void {
    cloudChannel = null;
    this.captured = new WeakSet();
    this.installed = false;
    this.project.clear();
    this.user.clear();
  }

  /**
   * 递归扫描 extensionManager / _extensions，找到带云数据方法的扩展对象。
   * 带 visited 防环，避免 extensionManager 的循环引用导致死循环。
   */
  private tryCapture(runtime: any): void {
    const visited = new WeakSet<object>();
    const consider = (obj: any): boolean => {
      if (!obj || typeof obj !== 'object') return false;
      if (visited.has(obj)) return false;
      visited.add(obj);
      if (typeof obj._getValueFromProject === 'function') {
        this.capture(obj);
        return true;
      }
      try {
        if (obj instanceof Map) {
          for (const v of obj.values()) if (consider(v)) return true;
        } else if (Array.isArray(obj)) {
          for (const v of obj) if (consider(v)) return true;
        } else {
          const vals = Object.values(obj) as unknown[];
          for (const v of vals) {
            try {
              if (consider(v)) return true;
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      return false;
    };
    consider(runtime.extensionManager);
    consider(runtime._extensions);
    consider(runtime.extensions);
  }

  private capture(ext: any): void {
    this.captured.add(ext);
    cloudChannel = ext;
    const self = this;

    const origGetP = ext._getValueFromProject.bind(ext);
    const origSetP = ext._setValueToProject.bind(ext);
    const origGetU = ext._getValueFromUser.bind(ext);
    const origSetU = ext._setValueToUser.bind(ext);
    // 存原生引用：全局锁的 marker 读写 / 钉回直接走原生通道，绕开 wrap 防递归
    this.origPGet = origGetP;
    this.origPSet = origSetP;
    this.origUGet = origGetU;
    this.origUSet = origSetU;

    // 读取作品云数据：先回源，写入本地镜像；若本地镜像被改过则回写
    const wrapGetP = async function (this: any, name: string) {
      // 锁标记自身是 VaIMod 的内部簿记，绝不写入本地镜像 / 进入面板
      if (isLockMeta(name)) return origGetP(name);
      const lock = self.locks.project.get(name);
      if (lock) {
        // 全局锁定中：任何来源读到的一律是「钉住值」；ticker 负责把服务端盖回
        self.project.set(name, lock.value);
        return lock.value;
      }
      const v = await origGetP(name);
      self.project.set(name, v);
      const modified = self.project.get(name);
      if (modified !== v) return origSetP(name, modified);
      return modified;
    };
    // 写入作品云数据：先写本地镜像，再回源（全局锁定条目拒绝外部写入）
    const wrapSetP = async function (this: any, name: string, value: unknown) {
      const lock = self.locks.project.get(name);
      if (lock) {
        // 锁定期：不落服务器，钉住值本地保持不变；ticker 周期性把钉住值盖回服务器
        self.project.set(name, lock.value);
        return lock.value;
      }
      self.project.set(name, value);
      const r = await origSetP(name, self.project.get(name));
      self.notifyChanged();
      return r;
    };
    // 读取用户云数据
    const wrapGetU = async function (this: any, name: string) {
      // 锁标记自身是 VaIMod 的内部簿记，绝不写入本地镜像 / 进入面板
      if (isLockMeta(name)) return origGetU(name);
      const lock = self.locks.user.get(name);
      if (lock) {
        self.user.set(name, lock.value);
        return lock.value;
      }
      const v = await origGetU(name);
      self.user.set(name, v);
      const modified = self.user.get(name);
      if (modified !== v) return origSetU(name, modified);
      return modified;
    };
    // 写入用户云数据
    const wrapSetU = async function (this: any, name: string, value: unknown) {
      const lock = self.locks.user.get(name);
      if (lock) {
        self.user.set(name, lock.value);
        return lock.value;
      }
      self.user.set(name, value);
      const r = await origSetU(name, self.user.get(name));
      self.notifyChanged();
      return r;
    };
    // toString 伪装（封装隔离）：让替换函数显示为原生代码
    markNative(wrapGetP, '_getValueFromProject');
    markNative(wrapSetP, '_setValueToProject');
    markNative(wrapGetU, '_getValueFromUser');
    markNative(wrapSetU, '_setValueToUser');
    ext._getValueFromProject = wrapGetP;
    ext._setValueToProject = wrapSetP;
    ext._getValueFromUser = wrapGetU;
    ext._setValueToUser = wrapSetU;
  }

  getEntries(type: CloudType): [string, unknown][] {
    const db = type === 'project' ? this.project : this.user;
    return [...db.entries()];
  }

  async setValue(type: CloudType, name: string, value: unknown): Promise<void> {
    // 锁标记自身不允许写入（防止用户面板泄漏后误改）
    if (isLockMeta(name)) throw new Error('锁标记不能修改');
    // 零信任持续验证：凭证失效/隔离态拒绝云数据写入
    if (!ztna.verify('cloud')) throw new Error('通道验证失败，写入被拒绝');
    if (!cloudChannel) throw new Error('云数据扩展尚未加载');
    // 全局锁定：本端或远端 VaIMod 锁定期间，谁都不能改（除非先解锁）
    await this.ensureWritable(type, name);
    // VPN 审核系统：云数据写入前统一过审（类型/长度/防逃逸对象）
    const audit = auditOutbound(value);
    if (!audit.ok) throw new Error('VPN 审核拦截：' + audit.reason);
    // 作品云变量：官方正规 API 直写 与 原扩展链路【并行双写】——
    // 官方快则后端立即持久化（+vm 同步）；官方未捕获/失败则由扩展链路兜底，
    // 网络差/慢时两边同时跑，取先完成者，感知延迟最低。
    if (type === 'project') {
      let extOk = false;
      let officialOk = false;
      const tasks: Promise<unknown>[] = [
        Promise.resolve(cloudChannel._setValueToProject(name, value)).then((r) => {
          extOk = r !== false;
          return r;
        }),
      ];
      try {
        const official = officialSaveProject(name, value);
        tasks.push(
          official.then((ok) => {
            officialOk = ok === true;
            if (ok) this.writeCloudToVm(name, value);
            return ok;
          }),
        );
      } catch {
        /* 官方通道异常不影响扩展链路 */
      }
      await Promise.allSettled(tasks);
      // 两条通道都失败必须抛出：否则调用方会弹「已保存」，本地镜像与云端不一致，
      // 且「保存全部」下次会把该项当未改动永久跳过（用户无法重试）。
      if (!officialOk && !extOk) {
        throw new Error('云端写入失败（官方通道与扩展通道均不可用）');
      }
      return;
    }
    const userOk = await cloudChannel._setValueToUser(name, value);
    // 扩展通道显式返回 false 视为失败（与 createValue 的判据一致）
    if (userOk === false) throw new Error('云端写入失败（扩展通道返回失败）');
  }

  // 官方直写成功后同步 vm 云变量（项目运行时立即读到新值）；找不到该云变量返回 false
  private writeCloudToVm(name: string, value: unknown): boolean {
    try {
      const vm = retryVm;
      const targets = vm?.runtime?.targets as
        | Array<{
            variables?:
              | Map<string, { isCloud?: boolean; name?: string; value?: unknown }>
              | Record<string, { isCloud?: boolean; name?: string; value?: unknown }>;
          }>
        | undefined;
      if (!targets) return false;
      let found = false;
      for (const t of targets) {
        const vars = t?.variables;
        if (!vars) continue;
        const entries =
          vars instanceof Map
            ? [...vars.entries()]
            : Object.entries(vars as Record<string, { isCloud?: boolean; name?: string; value?: unknown }>);
        for (const [, v] of entries) {
          if (v && v.isCloud && v.name === name) {
            v.value = value;
            found = true;
          }
        }
      }
      if (found) vm.runtime?.requestUpdate?.();
      return found;
    } catch {
      return false;
    }
  }

  async getValue(type: CloudType, name: string): Promise<unknown> {
    if (!cloudChannel) return undefined;
    if (type === 'project') return cloudChannel._getValueFromProject(name);
    return cloudChannel._getValueFromUser(name);
  }

  /**
   * 新建云变量（面板「+ 新建」入口）。
   * - 作品云变量：官方 Cloud Database save API 直写（hardcode 端点，无需扩展捕获/无需 token）
   *   + 若扩展已捕获则并行双写；官方成功即时同步 vm 云变量；
   * - 用户云变量：走扩展通道（官方用户端需 token+用户号，靠扩展会话最可靠）。
   * 全部失败 → 抛出（乐观镜像回滚）。
   */
  async createValue(type: CloudType, name: string, value: unknown): Promise<{ official: boolean }> {
    // 锁标记自身不允许创建
    if (isLockMeta(name)) throw new Error('锁标记不能创建');
    // 零信任持续验证 + VPN 审核（与 setValue 同一安全面）
    if (!ztna.verify('cloud')) throw new Error('通道验证失败，写入被拒绝');
    const audit = auditOutbound(value);
    if (!audit.ok) throw new Error('VPN 审核拦截：' + audit.reason);
    // 目标名已被（本端/远端）锁定则不可新建/覆盖
    await this.ensureWritable(type, name);
    const db = type === 'project' ? this.project : this.user;
    const had = db.has(name);
    // 乐观镜像：先入本地，UI 立即出现
    db.set(name, value);
    try {
      if (type === 'project') {
        // 官方后端直写（永久持久化）优先；扩展通道作为兜底（可能仅内存、刷新丢失）
        let officialOk = false;
        let extOk = false;
        const tasks: Promise<unknown>[] = [];
        if (cloudChannel) {
          tasks.push(
            Promise.resolve(cloudChannel._setValueToProject(name, value)).then((r) => {
              extOk = r !== false;
              return r;
            }),
          );
        }
        tasks.push(
          officialSaveProjectCloud(name, value).then((ok) => {
            officialOk = ok === true;
            if (ok) this.writeCloudToVm(name, value);
            return ok;
          }),
        );
        await Promise.allSettled(tasks);
        if (!officialOk && !extOk) {
          if (!had) db.delete(name);
          throw new Error('云端写入失败（官方通道与扩展通道均不可用）');
        }
        this.notifyChanged();
        return { official: officialOk };
      } else {
        if (!cloudChannel) {
          if (!had) db.delete(name);
          throw new Error('云数据扩展尚未加载，无法新建用户云变量');
        }
        const userOk = await cloudChannel._setValueToUser(name, value);
        // 显式 false 视为失败 → 走 catch 回滚乐观镜像（不再假成功）
        if (userOk === false) throw new Error('云端写入失败（扩展通道返回失败）');
        this.notifyChanged();
        return { official: true };
      }
    } catch (err) {
      // 网络/通道失败：回滚乐观镜像，保持面板与实际云端一致
      if (!had) db.delete(name);
      this.notifyChanged();
      throw err;
    }
  }

  /**
   * 删除云数据条目（先经调用方放入回收站再调本方法）：
   * - 本地镜像删除（面板即时消失）；
   * - 尽力尝试扩展删除接口（方法名带 delete 语义、签名 (name, ...)）；
   * - 不触碰官方后端（无公开删除端点）：云端行保留，脚本若重新读取会再次回源 ——
   *   回收站还原可在任意时刻把它原样写回。
   */
  async removeValue(type: CloudType, name: string): Promise<void> {
    // 锁标记不删除（属于云端簿记）
    if (isLockMeta(name)) return;
    if (!cloudChannel && !this.project.has(name) && !this.user.has(name)) return;
    // 全局锁定条目不可删除（需先解锁）
    await this.ensureWritable(type, name);
    const db = type === 'project' ? this.project : this.user;
    db.delete(name);
    // 清理显示别名（云数据域 c:）
    try {
      removeDisplayName(['c', type, name].join(':'));
    } catch {
      /* ignore */
    }
    if (cloudChannel) {
      const ext = cloudChannel as Record<string, unknown>;
      const candidates =
        type === 'project'
          ? ['_deleteValueFromProject', 'deleteValueFromProject', 'deleteProjectVariable']
          : ['_deleteValueFromUser', 'deleteValueFromUser', 'deleteUserVariable'];
      for (const methodName of candidates) {
        const fn = ext[methodName] as unknown;
        if (typeof fn === 'function') {
          try {
            const r = (fn as (n: string) => unknown).call(ext, name);
            if (r && typeof (r as Promise<unknown>).then === 'function') {
              await (r as Promise<unknown>).catch(() => undefined);
            }
            break;
          } catch {
            /* 尝试下一个候选 */
          }
        }
      }
    }
    this.notifyChanged();
  }

  /** 云数据扩展未加载时重新捕获（面板「重新捕获」按钮调用） */
  retry(): void {
    if (!retryVm) return;
    this.installed = false;
    this.install(retryVm);
  }
}

export const ccwDataStore = new CcwDataStore();
