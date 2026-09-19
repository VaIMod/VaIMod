// ===== 统一多层动态安全栈（Veil Chain 引擎化）=====
// 目标语义：每一次点击/操作 = 按动作类型【动态组装一条多层嵌套的安全链】——
// 各保护措施不是散落各处的单点调用，而是动态实例化为链上的一层层：
//
//   ┌ 用户点击 ─────────────────────────────────────────────┐
//   │  secureAction(kind, ctx, action)                       │
//   │  ① veil 层   遮罩 VPN 就位 + 加密 Cookie 校验（幂等）    │
//   │  ② ztna 层   SDP 单包授权持续验证（按动作类型最小权限）  │
//   │  ③ audit 层  出站载荷审核（O(1)）                       │
//   │  ④ alive 层  存活断言（可选：bridge 已连接、沙盒就绪）   │
//   │  ⑤ seal 层   N 层加密封印：每层独立动态盐，洋葱包裹；    │
//   │             内部逐层解包核对签名，任一篡改即拒绝执行     │
//   └────────────────────────────────────────────────────────┘
//   action(解包后的 ctx) —— 通过全部层才执行；整链随调用销毁。
//
// 设计要点：
// - 动态创建：每次调用即时组装层实例与随机盐/标识，无跨调用静态残留；
// - 多层嵌套：seal 支持任意层数（随机深度 + 按敏感度加强），层层加密签名；
// - 统一覆盖：此前 ensureVeil 只在部分操作调用——现在所有受保护操作一律先过 veil 层；
// - 性能友好：校验层全部 O(1) 零分配；封印仅对短 ctx 做位运算（微秒级）；失败即短路。
import { signToken, xorEncode, xorDecode } from './cipher';
import { ensureVeil, veilAccessValid } from './veil-manager';
import { ztna, type ZtnaKind } from './ztna';
import { auditOutbound } from './vpn-audit';

// 动作类型（决定零信任授权面与默认封印深度）
export type GuardKind =
  | 'read' // 读取变量 / 导出
  | 'write' // 修改变量 / 改名 / 恢复名 / 导入
  | 'lock' // 锁定 / 解锁
  | 'sandbox' // 沙盒访问面
  | 'cloud' // 云数据读写
  | 'connect' // 建立/重连会话（无凭证期豁免 SDP）
  | 'refresh' // 刷新列表（连接中也可等待）
  | 'generic'; // UI 本地操作（不触 vm / 云）

export interface SecureActionOptions {
  /** 跳过遮罩 VPN 层（默认 false，一般不要关） */
  skipVeil?: boolean;
  /** 封印层数范围 [min,max]，默认按动作类型；敏感动作自动加深 */
  depth?: [number, number];
  /** 存活断言：动作执行前必须为 true（如 bridge 已连接）；失败即短路返回 undefined */
  alive?: () => boolean;
  /** 额外固定封印层数（在随机深度上追加，需 0~2） */
  extraSeal?: number;
}

/** 动作 → SDP 授权面：仅触 vm/云的动作需要持续验证；连接/刷新为豁免期动作 */
function ztnaKindFor(kind: GuardKind): ZtnaKind | null {
  if (kind === 'read' || kind === 'write' || kind === 'lock' || kind === 'sandbox' || kind === 'cloud') {
    return kind;
  }
  return null; // connect / refresh / generic
}

/** 动作 → 默认封印深度（写/锁/云等敏感动作自动加深） */
function depthFor(kind: GuardKind): [number, number] {
  switch (kind) {
    case 'write':
    case 'lock':
    case 'cloud':
    case 'sandbox':
      return [3, 5];
    default:
      return [2, 4];
  }
}

/** 动态层标识 / 盐：crypto 强随机（不可预测、不可静态化） */
function rndToken(): string {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

/** seal 层封印：xor 包裹「层签名:动态盐:载荷」。动态盐使每次点击密文唯一（防重放/防模式分析） */
function sealWrap(inner: string, layerId: string): string {
  const salt = rndToken();
  return xorEncode(signToken(layerId + ':' + salt) + ':' + salt + ':' + inner);
}

/** seal 层解封：核对层签名与动态盐，失败返回 null（层被篡改/缺失） */
function sealOpen(packet: string, layerId: string): string | null {
  const dec = xorDecode(packet);
  const i1 = dec.indexOf(':');
  if (i1 < 0) return null;
  const i2 = dec.indexOf(':', i1 + 1);
  if (i2 < 0) return null;
  const sig = dec.slice(0, i1);
  const salt = dec.slice(i1 + 1, i2);
  if (sig !== signToken(layerId + ':' + salt)) return null;
  return dec.slice(i2 + 1);
}

/**
 * 统一受保护动作入口：任何用户交互都在这里被组装成一条动态多层安全链。
 * @param kind   动作类型（决定 SDP 授权面 + 默认封印深度）
 * @param ctx    操作上下文描述（经层间安全 VPN 传递到 action）
 * @param action 处理器（收到通过全部层校验并解封后的 ctx）
 * @param opts   覆盖项：skipVeil / depth / extraSeal / alive
 * @returns action 返回值；任一层校验失败返回 undefined（不泄露内部逻辑）
 */
export function secureAction<T>(
  kind: GuardKind,
  ctx: string,
  action: (ctx: string) => T,
  opts: SecureActionOptions = {},
): T | undefined {
  // ---- ① veil 层：遮罩 VPN 就位（幂等）+ 加密 Cookie 有效 ----
  if (!opts.skipVeil) {
    ensureVeil();
    if (!veilAccessValid()) return undefined;
  }
  // ---- ② ztna 层：SDP 单包授权（触 vm/云的动作才需要） ----
  const zk = ztnaKindFor(kind);
  if (zk && !ztna.verify(zk)) return undefined;
  // ---- ③ audit 层：出站载荷审核（字符串 ctx：O(1)） ----
  const audit = auditOutbound(ctx);
  if (!audit.ok) return undefined;
  // ---- ④ alive 层：存活断言（可选） ----
  if (opts.alive && !opts.alive()) return undefined;

  // ---- ⑤ seal 层：动态多层加密封印（洋葱模型，调用结束随作用域销毁） ----
  const [mn, mx] = opts.depth ?? depthFor(kind);
  const extra = Math.min(Math.max(opts.extraSeal ?? 0, 0), 2);
  const count = mn + ((Math.random() * (mx - mn + 1)) | 0) + extra;
  const layerIds: string[] = [];
  for (let i = 0; i < count; i++) layerIds.push(rndToken().slice(0, 8));

  // 出向：逐层包裹（后包的在最外）
  let packet: string = ctx;
  for (const id of layerIds) packet = sealWrap(packet, id);
  // 入向：自最外逐层解封 + 签名核对——全部通过才执行 action
  let dec: string = packet;
  for (let i = layerIds.length - 1; i >= 0; i--) {
    const d = sealOpen(dec, layerIds[i]);
    if (d === null) return undefined;
    dec = d;
  }
  return action(dec);
}

/**
 * 向后兼容原「动态遮罩链」入口：等价于 secureAction('generic', ctx, action)。
 * UI 新代码建议直接使用 secureAction 并指定动作类型，以获得对应 SDP 授权面与封印深度。
 */
export function interactThroughVeil<T>(ctx: string, action: (ctx: string) => T): T | undefined {
  return secureAction('generic', ctx, action);
}
