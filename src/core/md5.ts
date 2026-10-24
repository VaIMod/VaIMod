/**
 * 纯 TypeScript 的 MD5 实现（RFC 1321）。
 *
 * 为什么不用 WebCrypto：`crypto.subtle.digest` 只支持 SHA 系列，**没有 MD5**；
 * 而 ccw 站点的上传协议要求 `contentHash` 必须是文件内容的 MD5 十六进制串
 * （站点自己的实现是 CryptoJS.MD5），后端按该值做内容寻址与去重校验。
 *
 * 为什么不用第三方库：userscript 产物要求零外部依赖（无 npm 运行时依赖），
 * 且本机沙箱内不便新增依赖。MD5 本身约 60 行实现，体积可忽略。
 *
 * 注意：MD5 在此仅用于**内容指纹**（站点上传协议的内容寻址），
 * 不用于任何安全签名场景。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** 每轮使用的 K[i] = floor(abs(sin(i+1)) * 2^32) */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** 计算字节数组的 MD5，返回小写十六进制串 */
export function md5Hex(bytes: Uint8Array): string {
  const len = bytes.length;
  // 填充：0x80 + 若干 0x00，使总长 ≡ 56 (mod 64)，末尾 8 字节存原始比特长度
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  // 长度按小端写入末 8 字节（高 32 位用低 32 位表示，足够覆盖 2^53 字节）
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);

  let hex = '';
  for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
  return hex;
}

/** 计算 Blob / File 的 MD5（返回小写十六进制串） */
export async function md5HexOfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return md5Hex(new Uint8Array(buf));
}
