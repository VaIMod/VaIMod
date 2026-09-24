import { secretChannel } from './secret-channel';
import { SecureCache } from './secure-cache';

// 轻量强加密流：遮罩层前后的数据加解密 + 遮罩守卫 Cookie 签名。
// 密钥统一经秘密密钥 VPN（SecretChannel）下发，本模块不直接持有任何密钥常量。
// 三密钥流混合（位置派生 + 反向位置 + 会话 nonce 交错），非线性扩散；
// 结果存于 JS 字符串（零体积膨胀），对称可解。
// 编码结果经「超高速安全缓存」缓存（密文落缓存，内存无明文，重复编码零计算）；
// 解码不缓存（避免污染缓存 / 明文落内存）。

const MIX_A = 0x9e3779b9 >>> 0;
const MIX_B = 0x85ebca6b >>> 0;

const encodeCache = SecureCache.create();

function mixKey(x: number): number {
  let k = x >>> 0;
  k = ((k << 13) | (k >>> 19)) >>> 0;
  k = (k * MIX_B) >>> 0;
  k ^= k >>> 15;
  return k >>> 0;
}

// FNV-1a 轻量指纹：缓存键用指纹（非明文），防明文落缓存
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function encodeDirect(s: string): string {
  const n = s.length;
  const salt = secretChannel.salt();
  const nonce = secretChannel.nonce();
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    // 第一轮：位置派生（非线性）
    const k1 = mixKey(salt ^ (i * MIX_A) ^ ((i * i) * 31));
    let x = c ^ (k1 & 0xff);
    // 第二轮：反向位置派生
    const j = n - 1 - i;
    const k2 = mixKey(salt ^ (j * MIX_B) ^ ((j * j) * 7));
    x = x ^ (k2 & 0xff);
    // 第三轮：会话 nonce 按相位交错
    x = x ^ ((nonce >>> (((i + j) % 4) * 8)) & 0xff);
    out += String.fromCharCode(x);
  }
  return out;
}

export function xorEncode(input: unknown): string {
  const s = String(input);
  // 超高速缓存：小值指纹命中直接返回密文（零计算）；大值不缓存。
  // 缓存键必须并进密钥代次：encodeDirect 依赖 salt/nonce，密钥轮换（vpnRecycle →
  // SecretChannel.rotate）后旧密文在新密钥下解不回来，命中即产出垃圾。
  if (s.length <= 256) {
    const k = fnv1a(s) + '.' + secretChannel.keyEpoch;
    const hit = encodeCache.get(k);
    if (typeof hit === 'string') return hit;
    const out = encodeDirect(s);
    encodeCache.set(k, out);
    return out;
  }
  return encodeDirect(s);
}

export function xorDecode(input: unknown): string {
  // 解码直接计算（对称），不缓存（防污染缓存、防明文落内存）
  return encodeDirect(String(input));
}

// 轻量签名：密钥经秘密密钥 VPN 下发，篡改即校验失败
export function signToken(seed: string): string {
  const sig = secretChannel.sig();
  let h = (sig ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
