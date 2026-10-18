// ===== VM 环境反检测（vm-antidetect，BA.js v0.1.7 七组钩子移植）=====
// 拦截页面侧常见虚拟机环境检测点：GPU/WebGL 渲染器指纹、Canvas 指纹、音频指纹、
// navigator 硬件特征、屏幕分辨率、时区、自动化与焦点行为分析。
//
// 与 BA.js 原版的差异（VaIMod 硬约束适配）：
//  1. toString 伪装不重复安装——dom-utils 已有全局 Function.prototype.toString
//     白名单层，这里统一走 markNative（双层 toString hook 会白白加深调用链）。
//  2. Canvas 零残留：BA 原版把扰动永久写进画布（putImageData 不还原），
//     会改变游戏后续像素读取逻辑 → 这里扰动→导出→还原原像素，指纹稳定
//     （位置确定性：同画布多次导出结果一致）且对宿主零副作用。
//  3. GPU 池选择改 per-context 确定性：BA 原版按调用次数轮换，同一 context
//     两次查询返回不同渲染器——这本身就是「指纹不稳定」可疑特征 →
//     WeakMap 按 context 首次命中时固定一台 GPU，此后恒定。
//  4. document.hidden/visibilityState 伪装后，VaIMod 自身的后台暂停优化
//     （scratch-vm 轮询 / main.ts VPN 巡检）改走 trueHidden() 读真实状态，
//     页面侧读到恒 visible、内部生命周期语义不变。
//  5. 新增 Date.prototype.getTimezoneOffset 口（BA 原版只盖了 Intl，
//     检测器常用 offset===0 判 UTC，两口必须同口径）。
//
// 原则：条件式伪装——仅当前值命中虚拟机特征时才改写，正常环境零改动。
import { markNative } from '../dom-utils';

export interface VmAntiStats {
  installed: boolean;
  /** 各组命中计数（webgl/canvas/audio/nav/screen/tz/behavior） */
  hits: Record<string, number>;
  /** 最近日志（环形，最多 20 条） */
  logs: string[];
}

const GPU_POOL = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
];
const GPU_BAD =
  /(swiftshader|llvmpipe|softpipe|vmware|virtualbox|vbox|parallels|qemu|bochs|hyper-v|basic render|svga)/i;

const hits: Record<string, number> = {
  webgl: 0,
  canvas: 0,
  audio: 0,
  nav: 0,
  screen: 0,
  tz: 0,
  behavior: 0,
};
const logs: string[] = [];
let installed = false;

function log(m: string): void {
  logs.push(m);
  if (logs.length > 20) logs.shift();
}
function bump(k: string): void {
  hits[k] = (hits[k] ?? 0) + 1;
}

export function vmAntiStatus(): VmAntiStats {
  return { installed, hits: { ...hits }, logs: [...logs] };
}

// ---- 原始状态读取口（VaIMod 内部生命周期用；页面侧只能读到伪装值）----
// 实现迁移至零依赖的 page-visibility.ts：原始 getter 在模块求值时抓取
// （早于本模块任何伪装安装），此处仅 re-export 保持既有 import 路径不变。
export { trueHidden, trueVisible } from './page-visibility';

type NativeFn = (...args: unknown[]) => unknown;

function wrapProto(proto: object, name: string, wrapped: NativeFn): boolean {
  const holder = proto as unknown as Record<string, unknown>;
  if (typeof holder[name] !== 'function') return false;
  markNative(wrapped, name);
  try {
    holder[name] = wrapped;
    return true;
  } catch {
    return false;
  }
}

/** 实例属性条件改写：仅当 real 命中谓词时才上伪装 getter（否则完全不动） */
function defPropIf(
  obj: object,
  key: string,
  real: unknown,
  should: (v: unknown) => boolean,
  val: unknown
): boolean {
  if (!should(real)) return false;
  try {
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: true,
      get() {
        return val;
      },
    });
    markNative(Object.getOwnPropertyDescriptor(obj, key)?.get as object, `get ${key}`);
    return true;
  } catch {
    return false;
  }
}

// ---- ① GPU/WebGL 指纹：虚拟机 GPU 字符串命中才替换（per-context 确定性选池）----
const ctxGpu = new WeakMap<object, number>();
function gpuFor(ctx: object): number {
  let i = ctxGpu.get(ctx);
  if (i === undefined) {
    i = Math.floor(Math.random() * GPU_POOL.length);
    ctxGpu.set(ctx, i);
  }
  return i;
}
function hookWebGL(): void {
  const protos = [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext];
  for (const C of protos) {
    const proto = C?.prototype as unknown as Record<string, unknown> | undefined;
    const origGet = proto?.getParameter as NativeFn | undefined;
    if (!proto || typeof origGet !== 'function') continue;
    const hooked = function (this: object, p: number): unknown {
      const v = origGet.apply(this, arguments as unknown as unknown[]);
      try {
        // 条件式：真实值是虚拟机 GPU 字符串才替换；真机原样返回（零改动）
        if (typeof v === 'string' && GPU_BAD.test(v)) {
          // 37445/37446 = UNMASKED_VENDOR/RENDERER；7936/7937 = VENDOR/RENDERER
          // （GL_VERSION=7938 不动：含真实驱动号反而正常）
          if (p === 37445 || p === 7936) {
            bump('webgl');
            return 'Google Inc. (NVIDIA)';
          }
          if (p === 37446 || p === 7937) {
            bump('webgl');
            return GPU_POOL[gpuFor(this)];
          }
        }
      } catch {
        /* ignore */
      }
      return v;
    };
    wrapProto(proto, 'getParameter', hooked as NativeFn);
  }
}

// ---- ② Canvas 指纹：导出前确定性稀疏 LSB 扰动，导出后还原原像素（零残留）----
// 位置确定性：同画布多次导出走同一 seed → 结果一致（指纹稳定）；
// 每次都从「原始像素」重新扰动 → 游戏后续读像素拿到的是未扰动原图。
const SESSION_SEED = (Math.random() * 0xffffffff) >>> 0;
function noisify(arr: Uint8ClampedArray, step: number): void {
  const s = SESSION_SEED;
  for (let i = s % step; i < arr.length; i += step) {
    arr[i] = (arr[i] ^ 1) as number; // LSB 翻转，肉眼不可见
  }
}
function hookCanvas(): void {
  const cvProto = globalThis.HTMLCanvasElement?.prototype as unknown as
    | Record<string, NativeFn>
    | undefined;
  if (!cvProto) return;
  for (const mn of ['toDataURL', 'toBlob'] as const) {
    const orig = cvProto[mn];
    if (typeof orig !== 'function') continue;
    const wrapped = function (this: HTMLCanvasElement): unknown {
      let saved: ImageData | null = null;
      try {
        const w = this.width;
        const h = this.height;
        // 超大画布不折腾（成本/收益不划算）；WebGL 画布 getContext('2d') 返回 null 自然跳过
        if (w > 0 && h > 0 && w * h <= 2_500_000) {
          const ctx = this.getContext('2d') as CanvasRenderingContext2D | null;
          if (ctx) {
            const img = ctx.getImageData(0, 0, w, h);
            const noised = new Uint8ClampedArray(img.data);
            noisify(noised, 4096);
            ctx.putImageData(new ImageData(noised, w, h), 0, 0);
            saved = img; // orig 读完后还原
          }
        }
      } catch {
        saved = null; // tainted 画布等 → 直接走原始导出
      }
      const out = orig.apply(this, arguments as unknown as unknown[]);
      if (saved) {
        try {
          (this.getContext('2d') as CanvasRenderingContext2D).putImageData(saved, 0, 0);
          bump('canvas');
        } catch {
          /* ignore */
        }
      }
      return out;
    };
    wrapProto(cvProto, mn, wrapped as NativeFn);
  }
}

// ---- ③ 音频指纹：只 hook 读取出口（copyFromChannel/getFloatFrequencyData），不碰播放链 ----
function noisifyF(arr: Float32Array, step: number): void {
  const s = SESSION_SEED;
  for (let i = s % step; i < arr.length; i += step) {
    arr[i] = arr[i] + ((i + s) & 1 ? 1e-7 : -1e-7);
  }
}
function hookAudio(): void {
  const abProto = globalThis.AudioBuffer?.prototype as unknown as
    | Record<string, NativeFn>
    | undefined;
  const origCopy = abProto?.copyFromChannel as NativeFn | undefined;
  if (abProto && typeof origCopy === 'function') {
    const hooked = function (this: AudioBuffer, dest: Float32Array): void {
      origCopy.apply(this, arguments as unknown as unknown[]);
      try {
        if (dest && dest.length) noisifyF(dest, 997);
      } catch {
        /* ignore */
      }
    };
    wrapProto(abProto, 'copyFromChannel', hooked as NativeFn);
  }
  const anProto = globalThis.AnalyserNode?.prototype as unknown as
    | Record<string, NativeFn>
    | undefined;
  const origFd = anProto?.getFloatFrequencyData as NativeFn | undefined;
  if (anProto && typeof origFd === 'function') {
    const hooked = function (this: AnalyserNode, arr: Float32Array): void {
      origFd.apply(this, arguments as unknown as unknown[]);
      try {
        if (arr && arr.length) noisifyF(arr, 31);
      } catch {
        /* ignore */
      }
    };
    wrapProto(anProto, 'getFloatFrequencyData', hooked as NativeFn);
  }
}

// ---- ④ navigator 硬件特征：仅命中 VM 特征值时改写（VM 常见 1-2 核 / ≤2GB / 空语言表）----
function hookNav(): void {
  const nav = navigator as unknown as Record<string, unknown>;
  const proto = Navigator.prototype as unknown as Record<string, unknown>;
  const readReal = (key: string): unknown => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d?.get) return d.get.call(navigator);
      return nav[key];
    } catch {
      return undefined;
    }
  };
  if (
    defPropIf(nav, 'hardwareConcurrency', readReal('hardwareConcurrency'), (v) => typeof v === 'number' && v > 0 && v < 4, 8)
  )
    bump('nav');
  if (
    defPropIf(nav, 'deviceMemory', readReal('deviceMemory'), (v) => typeof v === 'number' && v > 0 && v <= 2, 8)
  )
    bump('nav');
  if (
    defPropIf(nav, 'languages', readReal('languages'), (v) => Array.isArray(v) && v.length === 0, Object.freeze(['zh-CN', 'zh', 'en']))
  )
    bump('nav');
  // webdriver：无头/自动化环境最常探测的反机器人信号。正常浏览恒为 false/undefined，
  // 仅真值（自动化驱动注入）时伪装为 false —— 条件式伪装，正常环境零改动。
  if (defPropIf(nav, 'webdriver', readReal('webdriver'), (v) => v === true, false)) bump('nav');
}

// ---- ⑤ 屏幕分辨率：VM 常见 <1024x700 才伪装为常见桌面分辨率 ----
function hookScreen(): void {
  const s = screen as unknown as Record<string, unknown>;
  const proto = Screen.prototype as unknown as Record<string, unknown>;
  const readReal = (key: string): unknown => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d?.get) return d.get.call(screen);
      return s[key];
    } catch {
      return undefined;
    }
  };
  const w = readReal('width');
  const h = readReal('height');
  if (typeof w !== 'number' || typeof h !== 'number') return;
  if (w >= 1024 && h >= 700) return; // 正常桌面分辨率：零改动
  const pairs: Array<[string, number]> = [
    ['width', 1920],
    ['height', 1080],
    ['availWidth', 1920],
    ['availHeight', 1040],
  ];
  let any = false;
  for (const [k, v] of pairs) {
    if (defPropIf(s, k, readReal(k), () => true, v)) any = true;
  }
  if (any) bump('screen');
}

// ---- ⑥ 时区特征：VM 默认 UTC → 报常见本地时区（仅 UTC 时触发；Intl + Date 双口径）----
function hookTZ(): void {
  const rProto = Intl.DateTimeFormat.prototype as unknown as Record<string, NativeFn>;
  const origResolved = rProto.resolvedOptions;
  if (typeof origResolved === 'function') {
    const hooked = function (this: Intl.DateTimeFormat): unknown {
      const r = origResolved.apply(this, arguments as unknown as unknown[]) as Intl.ResolvedDateTimeFormatOptions;
      try {
        if (r && (r.timeZone === 'UTC' || r.timeZone === 'Etc/UTC')) {
          bump('tz');
          return Object.assign({}, r, { timeZone: 'Asia/Shanghai' });
        }
      } catch {
        /* ignore */
      }
      return r;
    };
    wrapProto(rProto, 'resolvedOptions', hooked as NativeFn);
  }
  // Date 口：getTimezoneOffset()===0 即 UTC（检测器常走这条），同口径报 +08:00
  const dProto = Date.prototype as unknown as Record<string, NativeFn>;
  const origOffset = dProto.getTimezoneOffset;
  if (typeof origOffset === 'function') {
    const hooked = function (this: Date): number {
      const v = origOffset.apply(this, arguments as unknown as unknown[]) as number;
      if (v === 0) {
        bump('tz');
        return -480; // Asia/Shanghai (UTC+8)
      }
      return v;
    };
    wrapProto(dProto, 'getTimezoneOffset', hooked as NativeFn);
  }
}

// ---- ⑦ 行为分析：自动化标记（webdriver）与焦点/可见性行为（失焦检测类）----
function hookBehavior(): void {
  try {
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      enumerable: true,
      get: () => false,
      set: () => {
        /* 吞掉自动化框架的显式赋值 */
      },
    });
    markNative(Object.getOwnPropertyDescriptor(navigator, 'webdriver')?.get as object, 'get webdriver');
  } catch {
    /* ignore */
  }
  try {
    // 伪装前无需再保存原始 getter：page-visibility.ts 已在模块求值时抓走
    // （早于本模块），trueHidden/trueVisible 从那里读真值。
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    const hasFocus = function hasFocus(): boolean {
      return true;
    };
    markNative(hasFocus, 'hasFocus');
    (document as unknown as Record<string, unknown>).hasFocus = hasFocus;
    bump('behavior');
    log('behavior 钩子已安装');
  } catch (e) {
    log('behavior 钩子部分失败: ' + String(e));
  }
}

// ---- 安装入口（document-start 同步生效，先于页面任何脚本）----
export function installVmAntidetect(): void {
  if (installed) return;
  installed = true;
  hookWebGL();
  hookCanvas();
  hookAudio();
  hookNav();
  hookScreen();
  hookTZ();
  hookBehavior();
  log('VM 反检测钩子已安装（7 组）');
}
