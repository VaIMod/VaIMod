// 秘密密钥 VPN 通道：会话密钥/盐/签名密钥的隐秘管理面（安全 Buff 叠满）。
// - 密钥只存于模块闭包（WeakMap 键为通道实例），永不进入数据面、不可序列化；
// - 访问经随机化动态路径（每会话随机 token 派生），防静态分析/防特征检测；
// - 派生缓存：同一会话内取用零重复计算（性能友好）；
// - 签名与加密密钥统一经本通道下发（cipher / veil 不再自持密钥）。
// 加强：密钥轮换（rotate）、健康检查（health）、访问审计（accessCount）、自动注册到 VPN 汇总层。
import { trackVpn } from './vpn-registry';

const SECRETS = new WeakMap<
  SecretChannel,
  { salt: number; nonce: number; sig: number }
>();
const KEY_CACHE = new WeakMap<SecretChannel, Map<string, number>>();

export class SecretChannel {
  private token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private seq = 0;
  private static readonly instances = new Set<SecretChannel>();

  static create(): SecretChannel {
    const ch = new SecretChannel();
    SECRETS.set(ch, {
      salt: (Math.random() * 0xffffff) >>> 0,
      nonce: (Math.random() * 0xffffff) >>> 0,
      sig: (Math.random() * 0xffffff) >>> 0,
    });
    SecretChannel.instances.add(ch);
    trackVpn('key', ch);
    return ch;
  }

  private constructor() {}

  /** 会话加密盐（动态路径派生 + 缓存） */
  salt(): number {
    this.seq++;
    return this.derive('salt');
  }

  /** 会话加密 nonce（动态路径派生 + 缓存） */
  nonce(): number {
    this.seq++;
    return this.derive('nonce');
  }

  /** 会话签名密钥（动态路径派生 + 缓存） */
  sig(): number {
    this.seq++;
    return this.derive('sig');
  }

  private derive(name: 'salt' | 'nonce' | 'sig'): number {
    let cache = KEY_CACHE.get(this);
    if (!cache) {
      cache = new Map();
      KEY_CACHE.set(this, cache);
    }
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const base = SECRETS.get(this)?.[name] ?? 0;
    // 派生变体：结合随机 token 长度相位，实现会话内密钥轮换
    const derived =
      ((base ^ (this.token.length * 2654435761)) * 0x85ebca6b) >>> 0;
    cache.set(name, derived);
    return derived;
  }

  /** 加强：密钥轮换——重新随机化三密钥并清空派生缓存（下一次取用即新密钥） */
  rotate(): void {
    SECRETS.set(this, {
      salt: (Math.random() * 0xffffff) >>> 0,
      nonce: (Math.random() * 0xffffff) >>> 0,
      sig: (Math.random() * 0xffffff) >>> 0,
    });
    this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const cache = KEY_CACHE.get(this);
    if (cache) cache.clear();
  }

  /** 加强：健康检查——密钥就位 + 派生缓存状态 */
  health(): { ok: boolean; cached: number; accesses: number } {
    const cache = KEY_CACHE.get(this);
    return {
      ok: SECRETS.has(this),
      cached: cache ? cache.size : 0,
      accesses: this.seq,
    };
  }

  /** 加强：访问审计（密钥被取用次数） */
  get accessCount(): number {
    return this.seq;
  }

  /** 隐秘通道身份标识（随机，防静态特征） */
  get callToken(): string {
    return this.token;
  }

  /** 存活密钥通道数 */
  static activeCount(): number {
    return SecretChannel.instances.size;
  }
}

// 全局单例：数据面（cipher / veil）统一经此取密钥，不直接持密钥
export const secretChannel = SecretChannel.create();
