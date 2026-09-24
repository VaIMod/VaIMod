import { signToken, xorEncode } from './cipher';
import { trackVpn, untrackVpn } from './vpn-registry';

// 透明可穿透隔离遮罩样式（与面板共用同一宿主 → 层级可控；z 固定低于面板/FAB）
export const VEIL_CSS = `
.svp-veil {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: transparent;
  opacity: 0;
  pointer-events: none;
  z-index: 2147000000;
}
`;

const DEFAULT_COOKIE = 'svp_tk';
const GUARD_MS = 5000;

/** 页面是否在后台（标签页不可见）；非 DOM 环境按可见处理 */
function pageHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/**
 * 遮罩 VPN 通道（独立管辖）：
 * - 每实例独立 root + 独立 cookie 命名空间（多遮罩互不干扰）
 * - 加密 Cookie（XOR 体 + 签名，密钥经秘密密钥 VPN 下发，篡改即失效自动重写）
 * - 周期自检重建（被删/被改自动恢复）
 * - 健康检查 / 重建 / 销毁 / 自动注册到 VPN 汇总层
 */
export class VeilChannel {
  private root: ShadowRoot | null = null;
  private readonly cookieName: string;
  private timer: number | null = null;
  private visBound = false;
  private seq = 0;
  private divInited = false;

  constructor(cookieName = DEFAULT_COOKIE) {
    this.cookieName = cookieName;
    trackVpn('veil', this);
  }

  /** 绑定宿主并启动自检（installVeilGuard 语义） */
  install(root: ShadowRoot): void {
    this.root = root;
    this.writeCookie();
    this.ensureDiv();
    if (this.timer === null) {
      // 后台标签页不跑：ensure() 要读 document.cookie（整串序列化 + 正则匹配），
      // 没人看界面时纯属空转。定时器照常滴答，回前台由 visibilitychange 立即补一次，
      // 与主链路 vpnPatrol 的「隐藏即停 + 回前台立即巡检」保持一致。
      this.timer = window.setInterval(() => {
        if (pageHidden()) return;
        this.ensure();
      }, GUARD_MS);
    }
    if (!this.visBound) {
      this.visBound = true;
      try {
        document.addEventListener('visibilitychange', () => {
          if (!pageHidden()) this.ensure();
        });
      } catch {
        /* ignore */
      }
    }
  }

  /** 遮罩 VPN 访问面：确保遮罩层就位（Cookie 有效 + 遮罩存在），项目交互前调用 */
  ensure(): void {
    if (!this.cookieValid()) this.writeCookie();
    this.ensureDiv();
  }

  /** 遮罩 VPN 校验：遮罩 Cookie 是否有效（链路完整性参考） */
  accessValid(): boolean {
    return this.cookieValid();
  }

  /** 加强：健康检查 */
  health(): { ok: boolean; installed: boolean; cookieValid: boolean; checks: number } {
    return {
      ok: this.root !== null && this.cookieValid(),
      installed: this.root !== null,
      cookieValid: this.cookieValid(),
      checks: this.seq,
    };
  }

  /** 加强：强制重建（Cookie 重写 + 遮罩重挂） */
  rebuild(): void {
    this.writeCookie();
    this.ensureDiv();
  }

  /** 加强：访问审计（自检/校验次数） */
  get checkCount(): number {
    return this.seq;
  }

  /** 销毁：停自检、摘遮罩、解绑、从汇总层移除 */
  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 旧根里的遮罩节点要一并摘掉，并复位挂载标记——
    // 否则 destroy → 重新 install 到同一个根时，残留节点会被当成「已就位」，
    // 新建的遮罩则留在旧根里无处回收。
    try {
      const old = this.root?.querySelector('.svp-veil');
      if (old && old.parentNode) old.parentNode.removeChild(old);
    } catch {
      /* ignore */
    }
    this.divInited = false;
    this.root = null;
    untrackVpn('veil', this);
  }

  private writeCookie(): void {
    try {
      this.seq++;
      const body = xorEncode('veil:' + Date.now().toString(36));
      const sig = signToken('veil');
      document.cookie =
        this.cookieName +
        '=' +
        encodeURIComponent(body + ':' + sig) +
        '; path=/; max-age=86400; SameSite=Lax';
    } catch {
      /* ignore */
    }
  }

  private cookieValid(): boolean {
    try {
      this.seq++;
      const m = document.cookie.match(
        new RegExp('(?:^|; )' + this.cookieName + '=([^;]*)'),
      );
      if (!m) return false;
      const raw = decodeURIComponent(m[1]);
      const idx = raw.lastIndexOf(':');
      if (idx < 0) return false;
      return raw.slice(idx + 1) === signToken('veil');
    } catch {
      return false;
    }
  }

  private ensureDiv(): void {
    if (!this.root) return;
    // 已挂载过且仍在 → 直接返回（避免每次巡检/交互都 querySelector）
    if (this.divInited && this.root.querySelector('.svp-veil')) return;
    const div = document.createElement('div');
    div.className = 'svp-veil';
    this.root.appendChild(div);
    this.divInited = true;
  }
}

// ===== 全局单例（向后兼容原函数式接口）=====
let veilChannel: VeilChannel | null = null;

export function installVeilGuard(root: ShadowRoot): void {
  if (veilChannel === null) {
    veilChannel = new VeilChannel();
  }
  veilChannel.install(root);
}

/** 遮罩 VPN 访问面：确保遮罩层就位（Cookie 有效 + 遮罩存在），项目交互前调用 */
export function ensureVeil(): void {
  veilChannel?.ensure();
}

/** 遮罩 VPN 校验：遮罩 Cookie 是否有效（链路完整性参考） */
export function veilAccessValid(): boolean {
  return veilChannel?.accessValid() ?? false;
}

/** 汇总层取用全局遮罩通道 */
export function getVeilChannel(): VeilChannel | null {
  return veilChannel;
}
