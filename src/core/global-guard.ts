import { installStealth } from '../dom-utils';
import { installXssGuard } from './xss-guard';
import { installSecureGuardMark } from './secure-guard';
import { hookOfficialCloudApi } from './official-cloud';
import { secretChannel } from './secret-channel';
import { SecureCache } from './secure-cache';
import { VpnChannel } from './vpn';
import { sandboxVm } from './vm-sandbox';

// ===== 全局保护统一入口 =====
// 所有安全功能在 document-start 全局启用调用（幂等）：
// 任一安全模块缺失或顺序错误都会被这里兜住，保证完备性。
let installed = false;

export function installGlobalProtection(): void {
  if (installed) return;
  installed = true;

  // ① 防检测 stealth 全套（shadow DOM + 查询/遍历/MO/toString 过滤等）
  installStealth();
  // ② XSS 速执行拦截（保守版：document.write + 字符串定时器）
  installXssGuard();
  // ③ 安全模块白名单标记（防无限循环卡死/空项目覆盖/导出劫持）
  installSecureGuardMark();
  // ④ 官方云数据 API 捕获通道（观察平台扩展请求，供直写）
  hookOfficialCloudApi();

  // 以下为常驻安全能力：模块初始化即就绪，显式引用确保打包器不剔除、全局可用
  void secretChannel; // 秘密密钥 VPN（加密/签名密钥下发）
  void SecureCache;   // 超高速安全缓存（加密存储）
  void VpnChannel;    // VPN 动态通道（vm 引用闭包 + 多实例）
  void sandboxVm;     // VM 沙盒防逃逸（只读 + bound + 审计）
}
