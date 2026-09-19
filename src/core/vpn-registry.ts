// ===== VPN 汇总层（三 VPN 独立管辖）=====
// 三类 VPN 各自独立运行、独立管辖（独立实例池、独立生命周期、独立健康检查）：
//   - 'key'  : 秘密密钥 VPN（SecretChannel）—— 密钥/盐/签名管理面
//   - 'vm'   : VM 通道 VPN（VpnChannel）—— vm 引用通道 + 沙盒面
//   - 'veil' : 遮罩 VPN（VeilChannel）—— 透明遮罩 + 加密 Cookie 守卫
// 本模块只做「注册 → 汇总」：不干预各 VPN 内部逻辑（各自独立运行），
// 提供统一状态汇报（report）、全量健康检查（healthCheck）、统一重建/轮换（recycle）。
import type { VpnChannel } from './vpn';
import type { SecretChannel } from './secret-channel';
import type { VeilChannel } from './veil-manager';

export type VpnKind = 'key' | 'vm' | 'veil';

type AnyVpn = VpnChannel | SecretChannel | VeilChannel;

const pools: Record<VpnKind, Set<AnyVpn>> = {
  key: new Set(),
  vm: new Set(),
  veil: new Set(),
};

/** 注册：通道创建时自动调用（各 VPN 独立入池，互不干扰） */
export function trackVpn(kind: VpnKind, ch: AnyVpn): void {
  pools[kind].add(ch);
}

/** 注销：通道销毁时自动调用 */
export function untrackVpn(kind: VpnKind, ch: AnyVpn): void {
  pools[kind].delete(ch);
}

/** 各类 VPN 存活实例数（独立管辖统计） */
export function vpnCounts(): Record<VpnKind, number> {
  return {
    key: pools.key.size,
    vm: pools.vm.size,
    veil: pools.veil.size,
  };
}

function channelHealth(ch: AnyVpn): { ok: boolean; detail: string } {
  try {
    if (typeof (ch as VpnChannel).getVm === 'function') {
      const h = (ch as VpnChannel).health();
      return { ok: h.ok, detail: `bound=${h.bound} sandboxed=${h.sandboxed} calls=${h.calls}` };
    }
    if (typeof (ch as SecretChannel).salt === 'function') {
      const h = (ch as SecretChannel).health();
      return { ok: h.ok, detail: `cached=${h.cached} accesses=${h.accesses}` };
    }
    if (typeof (ch as VeilChannel).accessValid === 'function') {
      const h = (ch as VeilChannel).health();
      return {
        ok: h.ok,
        detail: `installed=${h.installed} cookieValid=${h.cookieValid} checks=${h.checks}`,
      };
    }
  } catch {
    /* ignore */
  }
  return { ok: false, detail: 'unknown' };
}

/** 全量健康检查：逐类逐通道体检，返回汇总结果（三 VPN 独立检查、最后汇总） */
export function vpnHealthCheck(): {
  perKind: Record<VpnKind, { total: number; ok: number; entries: { ok: boolean; detail: string }[] }>;
  allOk: boolean;
} {
  const perKind = {} as Record<
    VpnKind,
    { total: number; ok: number; entries: { ok: boolean; detail: string }[] }
  >;
  let allOk = true;
  (Object.keys(pools) as VpnKind[]).forEach((kind) => {
    const set = pools[kind];
    const entries = [...set].map((ch) => channelHealth(ch));
    const okCount = entries.filter((e) => e.ok).length;
    perKind[kind] = { total: set.size, ok: okCount, entries };
    if (entries.length > 0 && okCount !== entries.length) allOk = false;
    if (entries.length === 0 && kind === 'veil') allOk = false; // 遮罩必须存在
  });
  return { perKind, allOk };
}

/** 统一重建/轮换：密钥轮换 + 通道 token 轮换 + 遮罩重建（各 VPN 独立执行） */
export function vpnRecycle(): void {
  pools.key.forEach((ch) => {
    try {
      (ch as SecretChannel).rotate();
    } catch {
      /* ignore */
    }
  });
  pools.vm.forEach((ch) => {
    try {
      (ch as VpnChannel).rotate();
    } catch {
      /* ignore */
    }
  });
  pools.veil.forEach((ch) => {
    try {
      (ch as VeilChannel).rebuild();
    } catch {
      /* ignore */
    }
  });
}

/** 汇总报告：三 VPN 状态一句话总览 */
export function vpnReport(): string {
  const counts = vpnCounts();
  const health = vpnHealthCheck();
  return [
    `key=${counts.key} vm=${counts.vm} veil=${counts.veil}`,
    `allOk=${health.allOk ? 'yes' : 'no'}`,
  ].join(' | ');
}
