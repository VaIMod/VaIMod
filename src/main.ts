import { mount } from 'svelte';
import { ScratchVM } from './core';
import { createStealthHost, installStealth, getProtectedHosts, trueElementsFromPoint } from './dom-utils';
import { installXssGuard } from './core/xss-guard';
import { installVeilGuard, VEIL_CSS, getVeilChannel } from './core/veil-manager';
import { hookOfficialCloudApi } from './core/official-cloud';
import { installSecureGuardFront, getSecureGuard } from './core/secure-guard';
import { installSigGuardFront, getSigGuard } from './core/sig-guard';
import { vpnRecycle, vpnHealthCheck, vpnReport } from './core/vpn-registry';
import { ztna } from './core/ztna';
import { decoyRegistry } from './core/decoy';
import { installHoneypotGuard, honeypotReport } from './core/honeypot-guard';
import { installEarlyCaptureWatch } from './core/capture-early';
import { installFeishuGuard, feishuMode, feishuHits, feishuPendingCount, feishuRules } from './core/feishu-guard';
import { installUiGuard, uiGuardReport } from './core/ui-guard';
import {
  getAliasConfig,
  setAliasConfig,
  exportAliasConfig,
  clearAliasConfig,
  aliasStats,
  subscribeAliasConfig,
} from './core/alias-config';
import { migrateBrandKeys } from './core/brand-migrate';
import VaIModPanel from './ui/VaIModPanel.svelte';
import globalCss from './styles/global.css?inline';

// 品牌更名数据迁移（更名前的旧键 → VaIMod 新键）：必须在任何模块读存储之前
migrateBrandKeys();

// 引用障眼模块（不可达代码，与业务一同被混淆；仅阻止 tree-shaking，零运行开销）
void decoyRegistry;

// ===== 加载横幅（脚本注入即输出，标识 fork 作者） =====
console.log(
  '%c Maxkore %c & %c NekoYoAE ',
  'background: rgba(100, 180, 255, 0.2); backdrop-filter: blur(8px); color: #8B3A62; padding: 3px 10px; border-radius: 4px 0 0 4px; font-weight: 575; font-size: 13px; font-style: italic; border: 1px solid rgba(100, 180, 255, 0.25); font-family: "优设标黑体", "YouSheBiaoHei", sans-serif;',
  'background: rgba(100, 180, 255, 0.15); backdrop-filter: blur(8px); color: #8B3A62; padding: 3px 6px; font-weight: 575; font-size: 13px; font-style: italic; border-top: 1px solid rgba(100, 180, 255, 0.25); border-bottom: 1px solid rgba(100, 180, 255, 0.25); font-family: "优设标黑体", "YouSheBiaoHei", sans-serif;',
  'background: rgba(100, 180, 255, 0.2); backdrop-filter: blur(8px); color: #005A8C; padding: 3px 10px; border-radius: 0 4px 4px 0; font-weight: 575; font-size: 13px; font-style: italic; border: 1px solid rgba(100, 180, 255, 0.25); font-family: "优设标黑体", "YouSheBiaoHei", sans-serif;'
);

// ===== 全局安全功能启动（document-start 即全部生效，不依赖 vm 连接） =====
installSecureGuardFront(); // ⓪ 反作弊扩展反制前置（最先：签名放行 + register 拦截 + UI 隐藏免疫）
installSigGuardFront(); // ⓪′ 数字签名扩展反制（实例净化 + 双注册咽喉 + 变量名保护）
installStealth(); // ① stealth 防检测（DOM/遍历/MO/toString 全套）
installXssGuard(); // ② XSS 速执行拦截（document.write / 字符串定时器）
hookOfficialCloudApi(); // ③ 官方云 API 通道（fetch 观察，随时捕获 endpoint）
installFeishuGuard(); // ③′ 飞书消息请求拦截（document-start 占住 fetch/XHR，默认 off 零影响）
installHoneypotGuard(); // ④ 蜜罐陷阱防检测（假修改器 UI 诱饵 + window 假 vm 陷阱，攻击即轮换）
installEarlyCaptureWatch(); // ④′ 早期作品捕获（25ms 盯 window.vm，抢在站点初始 loadProject 前包装）
installUiGuard(); // ⑤′ UI 防篡改（宿主不可移除/搬走/隐藏 + 层级恒定最顶层）

let booted = false;

// 受控调试入口：仅当显式开启（localStorage `vaimod_debug=1`）才暴露，默认零特征。
// 提供沙盒面 / 安全快照 / VPN 汇总 / 零信任状态的只读检查，供「沙盒接入调试」验证：
//   __vaimod_debug.sandbox()    → 沙盒面（只读 + 双向代理，验证防逃逸）
//   __vaimod_debug.snapshot()   → SecureVm 结构感知快照（验证读链路走沙盒）
//   __vaimod_debug.sandboxCalls() → 沙盒方法调用审计计数
//   __vaimod_debug.vpn()        → VPN 汇总报告
//   __vaimod_debug.ztna()       → 零信任隔离态 + 各操作访问统计
function installDebug(bridge: ScratchVM): void {
  try {
    if (localStorage.getItem('vaimod_debug') !== '1') return;
    const handle = {
      sandbox: () => bridge.sandboxedVM,
      snapshot: () => bridge.getSecureSnapshot(),
      sandboxCalls: () => bridge.getSandboxCalls(),
      vpn: () => vpnReport(),
      ztna: () => ({ isolated: ztna.isolatedState, stats: ztna.accessStats() }),
      secure: () => ({
        adopted: getSecureGuard().size,
        vars: getSecureGuard().list(),
      }),
      sig: () => ({
        detected: getSigGuard().detected,
      }),
      honey: () => honeypotReport(),
      uiGuard: () => uiGuardReport(),
      // 调试专用：宿主在 light DOM 被 stealth 全部查询 API 过滤掉，只能从登记表直接取
      hosts: () => getProtectedHosts(),
      trueHitTest: (x: number, y: number) => trueElementsFromPoint(x, y),
      /**
       * 诊断：给变量读链路分段计时（毫秒）。
       * 刻意不返回变量数据本身 —— 让它经 CDP 序列化回来会把测量对象本身的开销
       * 算进结果里（几百个变量的对象图序列化比被测代码还慢）。
       * 用途：把「切页停顿」拆成 核心读链 / 渲染 两半，决定优化哪一侧。
       */
      timeRead: () => {
        const t0 = performance.now();
        bridge.getVariables();
        const t1 = performance.now();
        bridge.forceRefresh();
        const t2 = performance.now();
        return {
          getVariables: +(t1 - t0).toFixed(2),
          forceRefresh: +(t2 - t1).toFixed(2),
        };
      },
      /**
       * 诊断：把「系统页自动初始快照」的取值成本拆成两段并**对拍两条读路径**。
       *
       * 背景：快照原本逐条 bridge.readVariableValue，在 900 变量下就能造出 ~38ms 长任务，
       * 但 CPU profiler 反复抓不到那段工作（长任务观察器在无头环境时有时无）。
       * 于是不复用 profiler，直接把两段单独计时：
       *   perVarRead = 旧路径（逐条回读，固定开销 × 变量数）
       *   tableRead  = 新路径（整表一次回读）
       * 并且逐条比对两次取到的值 —— 若不一致说明「优化」动了语义，探针必须拦下来。
       * 只读：不写 marker、不落盘。
       */
      snapshotCost: () => {
        const all = bridge.getVariables().filter((v) => !v.isCloud);
        const t0 = performance.now();
        const raws = all.map((v) => bridge.readVariableValue(v.id, v.targetId));
        const t1 = performance.now();
        const live = bridge.readVmLiveValues();
        const t2 = performance.now();
        let hit = 0;
        let mismatch = 0;
        for (let i = 0; i < all.length; i++) {
          const v = all[i];
          const b = live.get(v.targetId + '\u0000' + v.id);
          if (b !== undefined) hit++;
          const a = raws[i];
          if (a === null) {
            if (b !== undefined) mismatch++;
          } else if (b === undefined || JSON.stringify(a) !== JSON.stringify(b)) {
            mismatch++;
          }
        }
        const t3 = performance.now();
        return {
          n: all.length,
          perVarRead: +(t1 - t0).toFixed(2),
          tableRead: +(t2 - t1).toFixed(2),
          compare: +(t3 - t2).toFixed(2),
          hit,
          mismatch,
        };
      },
      feishu: () => ({
        mode: feishuMode(),
        hits: feishuHits().length,
        pending: feishuPendingCount(),
        rules: feishuRules(),
      }),
      // 本地重命名配置（仅显示层）：探针据此断言「只改显示、不动 vm」
      alias: {
        get: () => getAliasConfig(),
        stats: () => aliasStats(),
        importConfig: (raw: unknown) => setAliasConfig(raw),
        exportConfig: () => exportAliasConfig(),
        clear: () => clearAliasConfig(),
        subscribe: (cb: () => void) => subscribeAliasConfig(cb),
      },
    };
    Object.defineProperty(window, '__vaimod_debug', {
      value: handle,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    /* ignore */
  }
}

type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number };
type IdleHost = {
  requestIdleCallback?: (cb: (d: IdleDeadline) => void, opt: { timeout: number }) => number;
};

// 空闲调度：把「面板/桥接等非安全关键工作」从 document-start 同步路径挪到主线程
// 空闲时段执行——页面解析与首帧不被 VaIMod 自身初始化阻塞；网络快时 idle 在首帧
// 后立刻触发，观感与同步挂载无差别。
// 双保险：requestIdleCallback（部分环境 timeout 不生效，如无头浏览器）+ setTimeout
// 兜底，保证最迟 ~250ms 内挂载（FAB 仍在页面加载早期出现），两种来源只执行一次。
function onIdle(fn: () => void, idleTimeout = 250): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  try {
    const g = globalThis as unknown as IdleHost;
    if (typeof g.requestIdleCallback === 'function') {
      g.requestIdleCallback(run, { timeout: idleTimeout });
      // 兜底：rIC 在无头/后台标签可能长时间不触发 → 定时器保证上限
      setTimeout(run, idleTimeout);
      return;
    }
  } catch {
    /* 走兜底 */
  }
  setTimeout(run, 30);
}

function boot(): void {
  if (booted) return;
  booted = true;

  // 同一 stealth 宿主承载：透明遮罩（先，层级低）+ VaIMod 面板（后，层级高）
  const { root } = createStealthHost(globalCss + '\n' + VEIL_CSS);
  // ⑤ 遮罩 + 加密 Cookie 守卫（被移除/篡改自动重建）—— 遮罩 VPN 独立管辖实例
  installVeilGuard(root);

  // ⑥ UI 异步挂载：安全守卫（上方，同步、最先）与页面关键解析互不阻塞，
  //    Svelte 初始化 + 首帧渲染放到空闲调度，站点加载期间不被 VaIMod 拖慢。
  onIdle(() => {
    const mountEl = document.createElement('div');
    root.appendChild(mountEl);

    // 变量变化由 vm 事件即时驱动，轮询仅作兜底（1200ms），主线程占用趋近于零
    const bridge = new ScratchVM({ pollInterval: 1200 });

    // VPN 汇总巡检：每 10s 全量健康检查；遮罩异常即重建，密钥/通道周期轮换。
    // 后台标签跳过巡检（veil-guard 内部有自己的常驻守卫兜底），回前台立即补一次——
    // 后台零巡检开销，安全性由独立守卫与回前台首查保证。
    let vpTick: number | null = null;
    const vpnPatrol = (): void => {
      try {
        // 零信任：隔离态 → 自动重连（connect 会重新颁发 SDP 凭证解除隔离）
        if (ztna.isolatedState) {
          bridge.connect().catch(() => {});
          return;
        }
        const health = vpnHealthCheck();
        if (!health.allOk) vpnRecycle();
        else {
          // 周期轮换（防密钥/标识静态化）
          const veil = getVeilChannel();
          if (veil) veil.ensure();
        }
      } catch {
        /* ignore */
      }
    };
    const syncVpnPatrol = (): void => {
      if (document.hidden) {
        if (vpTick) {
          clearInterval(vpTick);
          vpTick = null;
        }
        return;
      }
      if (!vpTick) vpTick = window.setInterval(vpnPatrol, 10_000);
      vpnPatrol(); // 回前台立即巡检一次
    };
    vpTick = window.setInterval(vpnPatrol, 10_000);
    document.addEventListener('visibilitychange', syncVpnPatrol);

    installDebug(bridge);

    mount(VaIModPanel, {
      target: mountEl,
      props: { bridge },
    });

    bridge.connect().catch(() => {
    });
  });
}

// 立即 boot（@run-at document-start）：守卫最先注入生效；UI 经空闲调度异步挂载，
// 页面转圈加载时既不被阻塞，也不阻塞站点自身脚本
boot();
