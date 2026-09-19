// ===== 作品导出与捕获（官方 VM API 优先，polyfill 兜底） =====
//
// 「官方 API」= Scratch VM 原生能力：vm.saveProjectSb3 / vm.toJSON /
// target.sprite 的 costumes/sounds 资产。对缺少这些方法的 VM，按社区通用
// polyfill 方案补齐（serializeAssets / _saveProjectZip / saveProjectSb3），
// 打包一律走内置 STORE 打包器（零依赖，见 zip-store.ts）。
// 本模块只拿 vm 引用干活，不碰 window、不注入任何页面元素。

import { makeZip, type ZipEntry } from './zip-store';

export const SB3_MIME = 'application/x.scratch.sb3';
export const SPRITE3_MIME = 'application/x.scratch.sprite3';

export interface ExportSpriteInfo {
  id: string;
  name: string;
  costumeCount: number;
  soundCount: number;
}

interface AssetData {
  assetId?: string;
  dataFormat?: string;
  data?: Uint8Array<ArrayBuffer>;
}

interface AssetDesc {
  fileName: string;
  fileContent: Uint8Array<ArrayBuffer>;
}

type CostumeOrSound = { broken?: { asset?: AssetData }; asset?: AssetData };

export type VmLike = {
  targets?: unknown[];
  getTargetById?: (id: string) => unknown;
  toJSON?: (...args: unknown[]) => unknown;
  saveProjectSb3?: (...args: unknown[]) => unknown;
  runtime?: {
    targets?: unknown[];
    getTargetById?: (id: string) => unknown;
    fontManager?: { serializeAssets?: () => Array<{ assetId: string; dataFormat: string; data?: Uint8Array<ArrayBuffer> }> };
  };
};

function vmTargets(vm: VmLike): Record<string, unknown>[] {
  const t = (vm.targets ?? vm.runtime?.targets ?? []) as Record<string, unknown>[];
  return Array.isArray(t) ? t : [];
}

function findTarget(vm: VmLike, id: string): Record<string, unknown> | null {
  const hit = vmTargets(vm).find((t) => t && t.id === id);
  if (hit) return hit;
  const viaApi = vm.getTargetById?.(id) ?? vm.runtime?.getTargetById?.(id);
  return viaApi && typeof viaApi === 'object' ? (viaApi as Record<string, unknown>) : null;
}

/** 收集目标（或缺省全部目标）的服装/声音资产，命名 md5ext 与 project.json 引用一致 */
function collectAssets(vm: VmLike, kinds: Array<'costumes' | 'sounds'>, targetId?: string): AssetDesc[] {
  const targets = targetId ? [findTarget(vm, targetId)].filter(Boolean) : vmTargets(vm);
  const out: AssetDesc[] = [];
  for (const t of targets) {
    if (!t) continue;
    const sprite = t.sprite as { costumes?: CostumeOrSound[]; sounds?: CostumeOrSound[] } | undefined;
    if (!sprite) continue;
    for (const kind of kinds) {
      for (const d of sprite[kind] ?? []) {
        const a = d?.broken?.asset ?? d?.asset;
        if (a?.assetId && a?.dataFormat && a?.data) {
          out.push({ fileName: `${a.assetId}.${a.dataFormat}`, fileContent: a.data });
        }
      }
    }
  }
  return out;
}

function fontAssets(vm: VmLike): AssetDesc[] {
  try {
    const list = vm.runtime?.fontManager?.serializeAssets?.() ?? [];
    return list
      .filter((a) => a.assetId && a.dataFormat && a.data)
      .map((a) => ({ fileName: `${a.assetId}.${a.dataFormat}`, fileContent: a.data as Uint8Array<ArrayBuffer> }));
  } catch {
    return [];
  }
}

// ---------- polyfill（幂等，WeakSet 防重复安装） ----------

const polyfilled = new WeakSet<object>();

export function ensureSb3Helpers(vm: VmLike): void {
  if (!vm || typeof vm !== 'object' || polyfilled.has(vm)) return;
  polyfilled.add(vm);
  const v = vm as Record<string, unknown> & VmLike;
  if (typeof v.serializeAssets !== 'function') {
    v.serializeAssets = (targetId?: string): AssetDesc[] => [
      ...collectAssets(v, ['costumes', 'sounds'], targetId),
      ...fontAssets(v),
    ];
  }
  if (typeof v._saveProjectZip !== 'function') {
    v._saveProjectZip = function (this: unknown): Blob {
      const self = this as Record<string, unknown> & VmLike;
      const json = typeof self.toJSON === 'function' ? String(self.toJSON()) : '{}';
      const assets = collectAssets(self, ['costumes', 'sounds']).map((a) => ({ name: a.fileName, data: a.fileContent }));
      return makeZip([{ name: 'project.json', data: json }, ...assets], SB3_MIME);
    };
  }
  if (typeof v.saveProjectSb3 !== 'function') {
    v.saveProjectSb3 = async function (this: unknown): Promise<Blob> {
      const make = (this as { _saveProjectZip?: () => Blob })._saveProjectZip;
      if (typeof make !== 'function') throw new Error('sb3 polyfill 未就绪');
      return make.call(this);
    };
  }
}

// ---------- 导出 ----------

/** 导出整个作品为 .sb3。原生 saveProjectSb3 可用则直接用（官方 API），否则 polyfill。 */
export async function exportProjectSb3(vm: VmLike): Promise<Blob> {
  if (!vm) throw new Error('VM 未连接');
  try {
    if (typeof vm.saveProjectSb3 === 'function') {
      const b = (await vm.saveProjectSb3.call(vm)) as Blob | ArrayBuffer | Uint8Array | undefined;
      if (b instanceof Blob) return b;
      if (b instanceof ArrayBuffer) return new Blob([b], { type: SB3_MIME });
      if (b && typeof b === 'object') return new Blob([b as Uint8Array<ArrayBuffer>], { type: SB3_MIME });
    }
  } catch {
    /* 原生导出异常 → 走 polyfill 兜底 */
  }
  ensureSb3Helpers(vm);
  return (vm as { saveProjectSb3: () => Promise<Blob> }).saveProjectSb3();
}

/** 导出单个角色为 .sprite3（sprite.json + 资产）。 */
export async function exportSpriteSb3(vm: VmLike, targetId: string): Promise<Blob> {
  const t = findTarget(vm, targetId);
  if (!t) throw new Error('角色不存在或已销毁');
  let jsonStr = '{}';
  try {
    jsonStr = String(vm.toJSON?.(targetId) ?? '{}');
    const parsed = JSON.parse(jsonStr) as { targets?: Array<{ id?: string }> } | null;
    if (parsed && Array.isArray(parsed.targets)) {
      // 该 VM 的 toJSON 忽略入参（返回整项目）：抽出对应 target 再序列化
      const one = parsed.targets.find((x) => x && x.id === targetId) ?? parsed.targets[1] ?? parsed.targets[0];
      jsonStr = JSON.stringify(one ?? {});
    }
  } catch {
    /* 保留原文 */
  }
  const assets = collectAssets(vm, ['costumes', 'sounds'], targetId).map((a) => ({ name: a.fileName, data: a.fileContent }));
  const entries: ZipEntry[] = [{ name: 'sprite.json', data: jsonStr }, ...assets];
  return makeZip(entries, SPRITE3_MIME);
}

/** 全部角色打包为一个 zip（每个角色一个 .sprite3）。 */
export async function exportSpritesZip(vm: VmLike): Promise<Blob> {
  const sprites = listSprites(vm);
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const s of sprites) {
    const blob = await exportSpriteSb3(vm, s.id);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base = s.name || s.id || 'sprite';
    let name = `${base}.sprite3`;
    let i = 2;
    while (used.has(name)) name = `${base}-${i++}.sprite3`;
    used.add(name);
    entries.push({ name, data: bytes });
  }
  if (entries.length === 0) throw new Error('没有可导出的角色');
  return makeZip(entries);
}

/** 角色清单（供插件 UI 列表渲染；不触资产数据） */
export function listSprites(vm: VmLike): ExportSpriteInfo[] {
  const out: ExportSpriteInfo[] = [];
  for (const t of vmTargets(vm)) {
    if (!t || typeof t !== 'object') continue;
    const sprite = t.sprite as { name?: string; costumes?: unknown[]; sounds?: unknown[] } | undefined;
    if (!sprite) continue;
    const isSprite = typeof t.isSprite === 'function' ? Boolean((t.isSprite as () => boolean).call(t)) : !t.isStage;
    if (!isSprite) continue;
    const name =
      typeof t.getName === 'function' ? (t.getName as () => string).call(t) : String(sprite.name ?? '');
    out.push({
      id: String(t.id ?? ''),
      name,
      costumeCount: Array.isArray(sprite.costumes) ? sprite.costumes.length : 0,
      soundCount: Array.isArray(sprite.sounds) ? sprite.sounds.length : 0,
    });
  }
  return out;
}

// ---------- 捕获（loadProject 入参 → Blob） ----------

export interface CapturedBlob {
  blob: Blob;
  size: number;
}

/** 把 loadProject 的入参规整为可下载 Blob（zip/ArrayBuffer/JSON/字符串通吃）。 */
export function captureFromLoadInput(input: unknown): CapturedBlob | null {
  try {
    if (input instanceof Blob) return { blob: input, size: input.size };
    if (input instanceof ArrayBuffer) {
      const b = new Blob([input], { type: SB3_MIME });
      return { blob: b, size: b.size };
    }
    if (ArrayBuffer.isView(input)) {
      const u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength) as Uint8Array<ArrayBuffer>;
      const b = new Blob([u8], { type: SB3_MIME });
      return { blob: b, size: b.size };
    }
    if (typeof input === 'string') {
      const isJson = input.trimStart().startsWith('{');
      const b = new Blob([input], { type: isJson ? 'application/json' : SB3_MIME });
      return { blob: b, size: b.size };
    }
    if (input && typeof input === 'object') {
      const b = new Blob([JSON.stringify(input)], { type: 'application/json' });
      return { blob: b, size: b.size };
    }
  } catch {
    /* ignore */
  }
  return null;
}
