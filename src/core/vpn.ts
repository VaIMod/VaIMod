import { SecureVm } from './secure-vm';
import { trackVpn, untrackVpn } from './vpn-registry';

// ===== VPN 动态通道（VM 通道 VPN）=====
// 每个 ScratchVM 实例拥有独立 VPN 通道：vm 引用只存在于通道实例内部（闭包私有字段），
// 通道可动态创建/销毁、数量不限、可并行操作；每次创建生成随机调用标识，
// 增加静态分析与特征检测难度。页面即使拿到 ScratchVM 实例也拿不到 vm（实例零 vm 字段）。
// 通道内承载「VaIMod 安全 VM 架构」（SecureVm）：内部控制面（raw）与对外沙盒面（proxy）
// 双面隔离，规则同安全遮罩与 VaIModVPN。
// 加强：调用审计（seq）、token 轮换（rotate）、健康检查（health）、自动注册到 VPN 汇总层。
export class VpnChannel {
  private secureVm: SecureVm | null = null;
  private token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private seq = 0;
  private static readonly instances = new Set<VpnChannel>();

  static create(): VpnChannel {
    const ch = new VpnChannel();
    VpnChannel.instances.add(ch);
    trackVpn('vm', ch);
    return ch;
  }

  private constructor() {}

  /** 绑定 vm（连接成功后调用）：构建安全 VM 架构（原生面 + 沙盒面） */
  bind(vm: unknown): void {
    this.secureVm = new SecureVm(vm);
  }

  /** 内部控制面：原生 vm 引用（VaIMod 控制层经审核/零信任使用；页面无法触及本通道） */
  getVm(): unknown {
    this.seq++;
    return this.secureVm?.raw ?? null;
  }

  /** 受限沙盒面：只读 + 方法 bound + 双向代理（供「沙盒到项目」的对外交互，防逃逸） */
  getSandboxedVm(): unknown {
    this.seq++;
    return this.secureVm?.proxy ?? null;
  }

  /** 安全 VM 架构实例（结构感知快照/定位等安全封装） */
  getSecureVm(): SecureVm | null {
    return this.secureVm;
  }

  /** 销毁通道：释放引用并从活跃池移除 */
  destroy(): void {
    this.secureVm = null;
    VpnChannel.instances.delete(this);
    untrackVpn('vm', this);
  }

  /** 当前存活通道数（VPN 数量不限、同时存在） */
  static activeCount(): number {
    return VpnChannel.instances.size;
  }

  /** 随机调用标识：每次创建不同，防静态特征 */
  get callToken(): string {
    return this.token;
  }

  /** 加强：调用审计计数（通道被访问次数，可查痕迹） */
  get callCount(): number {
    return this.seq;
  }

  /** 加强：token 轮换（随机调用标识动态更新，增大检测破解难度） */
  rotate(): void {
    this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** 加强：健康检查——vm 是否就位、沙盒面是否就绪 */
  health(): { ok: boolean; bound: boolean; sandboxed: boolean; calls: number } {
    return {
      ok: this.secureVm !== null && this.secureVm.alive,
      bound: this.secureVm !== null,
      sandboxed: this.secureVm !== null,
      calls: this.seq,
    };
  }
}
