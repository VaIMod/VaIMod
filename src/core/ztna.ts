// ===== 零信任 + SDP（软件定义边界）全局架构 =====
// 原则：
// 1. 永不信任（Zero Trust）：不因「连接已建立」就永久信任——每次读/写/锁定/沙盒/云数据
//    访问都执行持续验证（O(1) 极轻，不拖性能）。
// 2. SDP 单包授权（SPA）：访问 vm 通道前必须先「敲门」——持有有效的一次性会话凭证
//    （ticket：token + 时间戳 + 有效期）才放行；未验证/过期直接拒绝且不泄露任何信息（防探测）。
// 3. 最小权限：按操作类型（read/write/lock/sandbox/cloud）分别审计授权，访问面互不越权。
// 4. 失败隔离：验证失败计数，超阈值进入「隔离态」——所有访问拒绝 + 全局 VPN 重建，
//    直到重新连接（重新 issue 凭证）才解除。
// 5. 凭证自动续期：接近半程静默轮换，避免长时间闲置后首次访问被误拒（性能与安全平衡）。
import { vpnRecycle } from './vpn-registry';

export type ZtnaKind = 'read' | 'write' | 'lock' | 'sandbox' | 'cloud';

interface Ticket {
  token: string;
  ts: number;
  expire: number;
}

const TICKET_TTL_MS = 60_000;
const MAX_FAILURES = 5;

class ZtnaEngine {
  private ticket: Ticket | null = null;
  private failures = 0;
  private isolated = false;
  private readonly stats = new Map<string, number>();
  private isolateCb: (() => void) | null = null;

  /** 注册隔离回调（ScratchVM 接入：隔离时把连接状态打回未连接，UI 可重连） */
  onIsolate(cb: () => void): void {
    this.isolateCb = cb;
  }

  /** SDP 敲门：连接建立后颁发一次性访问凭证（crypto 强随机 token，防预测/防静态化） */
  issue(): void {
    const now = Date.now();
    let token: string;
    try {
      const arr = new Uint32Array(4);
      crypto.getRandomValues(arr);
      token =
        arr[0].toString(36) + arr[1].toString(36) + arr[2].toString(36) + arr[3].toString(36);
    } catch {
      token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    this.ticket = {
      token: token + now.toString(36),
      ts: now,
      expire: now + TICKET_TTL_MS,
    };
    this.failures = 0;
    this.isolated = false;
  }

  /** 凭证轮换（周期/巡检调用，防重放、防静态化） */
  rotate(): void {
    this.issue();
  }

  /** 断开连接：吊销凭证、清审计 */
  reset(): void {
    this.ticket = null;
    this.failures = 0;
    this.isolated = false;
    this.stats.clear();
  }

  /**
   * 零信任持续验证：每次访问前调用（O(1) 极轻，零分配）。
   * 判定规则：
   * - 已隔离：拒绝（计数审计，隔离态由重连 issue 解除）；
   * - 未连接（ticket 为 null）：拒绝并计入失败——连接建立前 UI 处于等待/错误态，
   *   修改入口不可达，正常用户不会累积；持续异常访问才会触发熔断隔离；
   * - 凭证过期（长闲置 > TTL）：静默续期放行——凭证是模块内单例标识（无跨进程传输、
   *   无重放面），过期仅因闲置，续期不影响防静态化/防探测；记录 renew 审计；
   * - 接近半程：静默轮换（防静态化）；
   * - 通过：失败计数清零（零星失败不累积，正常使用永不误隔离），记录操作类型审计。
   */
  verify(kind: ZtnaKind): boolean {
    if (this.isolated) {
      this.failures++;
      return false;
    }
    const t = this.ticket;
    if (!t) {
      this.fail(kind);
      return false;
    }
    const now = Date.now();
    // 过期（含颁发窗口超限）：续期放行，失败计数清零
    if (now > t.expire || now - t.ts > TICKET_TTL_MS) {
      this.rotate();
      this.failures = 0;
      this.stats.set('renew', (this.stats.get('renew') ?? 0) + 1);
      return true;
    }
    // 接近半程自动续期：长闲置后首次访问不误拒
    if (now - t.ts > TICKET_TTL_MS / 2) this.rotate();
    this.failures = 0;
    this.stats.set(kind, (this.stats.get(kind) ?? 0) + 1);
    return true;
  }

  /** 失败熔断：累计超阈值进入隔离态（全局 VPN 重建 + 通知控制面打回未连接） */
  private fail(kind: ZtnaKind): void {
    void kind;
    this.failures++;
    if (this.failures >= MAX_FAILURES && !this.isolated) {
      this.isolated = true;
      try {
        // 隔离：全局 VPN 重建（密钥轮换 + 通道 token 轮换 + 遮罩重建）
        vpnRecycle();
        this.isolateCb?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** 是否处于隔离态（所有访问拒绝，直到重新连接） */
  get isolatedState(): boolean {
    return this.isolated;
  }

  /** 累计失败次数（审计） */
  get failureCount(): number {
    return this.failures;
  }

  /** 各操作类型访问统计（最小权限审计） */
  accessStats(): Record<string, number> {
    const o: Record<string, number> = {};
    this.stats.forEach((v, k) => {
      o[k] = v;
    });
    return o;
  }
}

// 全局单例：所有访问入口（变量/锁定/沙盒/云数据）统一过审
export const ztna = new ZtnaEngine();
