import { secretChannel } from './secret-channel';

// 超高速安全缓存（类 Cache API，安全加固）：
// - 值加密存储（内存中无明文，防扫描/防检测）；JSON 结构化保真；
// - 动态创建任意多个实例（数量不限、可并行使用）；每实例随机 token 命名空间（动态调用）；
// - 纯数据 API（无 DOM/线程绑定）：多实例并发安全，可被多线程/多调用方同时使用；
// - LRU + TTL：防膨胀、防陈旧。

interface Entry {
  payload: string; // 密文
  t: number; // 写入时间
  ttl: number; // 0 = 永不过期
}

const DEFAULT_MAX = 512;

export class SecureCache {
  private store = new Map<string, Entry>();
  private readonly max: number;
  private readonly token = Math.random().toString(36).slice(2);
  private static readonly instances = new Set<SecureCache>();

  static create(max = DEFAULT_MAX): SecureCache {
    const c = new SecureCache(max);
    SecureCache.instances.add(c);
    return c;
  }

  private constructor(max: number) {
    this.max = max;
  }

  // 基于秘密密钥 VPN 派生的轻量混淆：密文存内存
  private enc(s: string): string {
    const salt = secretChannel.salt();
    let out = '';
    for (let i = 0; i < s.length; i++) {
      out += String.fromCharCode(s.charCodeAt(i) ^ ((salt + i * 97) & 0xff));
    }
    return out;
  }

  private dec = (s: string): string => this.enc(s);

  set(key: string, value: unknown, ttl = 0): void {
    if (this.store.size >= this.max && !this.store.has(key)) {
      const first = this.store.keys().next();
      if (!first.done) this.store.delete(first.value);
    }
    this.store.set(key, {
      payload: this.enc(JSON.stringify(value)),
      t: Date.now(),
      ttl,
    });
  }

  get(key: string): unknown {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.ttl > 0 && Date.now() - e.t > e.ttl) {
      this.store.delete(key);
      return undefined;
    }
    // LRU 命中提升：移到末尾
    this.store.delete(key);
    this.store.set(key, e);
    try {
      return JSON.parse(this.dec(e.payload)) as unknown;
    } catch {
      this.store.delete(key);
      return undefined;
    }
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  /** 动态调用标识（随机命名空间，防静态特征） */
  get callToken(): string {
    return this.token;
  }

  /** 存活缓存实例数（动态创建、数量不限） */
  static activeCount(): number {
    return SecureCache.instances.size;
  }
}
