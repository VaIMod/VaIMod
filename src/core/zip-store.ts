// ===== 极简 STORE 型 zip 打包器（零依赖） =====
//
// sb3 / sprite3 本质是 zip 容器。PNG/WAV 资产本身就是压缩格式，社区导出
// 对资产一律 STORE；project.json 也只有几百 KB。对比打包 JSZip（~100KB）
// 进产物，这里用 ~70 行本地实现（CRC32 + LOCAL/CENTRAL/EOCD 三段手写），
// 产出的 zip 任何标准解压器（含 scratch 官方加载器）都能读。

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(u8: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  // 只读使用：ArrayBufferLike 视图统一按 ArrayBuffer 背书类型断言（满足 BlobPart）
  return typeof data === 'string' ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

/** 生成全部 STORE 条目的合法 zip Blob。条目数上限 65535（本场景远够用）。 */
export function makeZip(entries: ZipEntry[], mime = 'application/zip'): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const now = new Date();
  // DOS 时间格式（zip 规范字段）
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = toBytes(e.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header 签名
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // bit 11：UTF-8 文件名
    lv.setUint16(8, 0, true); // method = STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // STORE 下 compressed = uncompressed
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory 签名
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); // STORE
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // local header 偏移
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD 签名
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true); // central directory 起始偏移 = local 段总长
  return new Blob([...chunks, ...central, eocd], { type: mime });
}
