// ===== 伪装浏览器指纹 + 反调试/反检测（anti-fp） =====
// 全部通过「原型/实例 getter 重定义 + 原生方法包装」实现，不修改站点源代码；
// 与 stealth（DOM 遮蔽/vpn 链/蜜罐）正交：只影响「指纹读取 / 高精度计时 / 控制台 / 调试器」这一层表面。
//
// 设计约束（重性能）：
//  - 所有包装器内部只做 O(1) 判断（读 live.cfg 一个布尔），热路径零分配；
//  - Canvas/WebGL/Audio 加噪 = 每次读取只翻转「几十字节以内」的像素低位，人眼不可察；
//  - performance.now 模糊 = 一次乘法取整（单调保持），不破坏 rAF/游戏计时；
//  - 配置经 localStorage 持久化（键名无明文特征），UI 切换即时生效（包装器实时读 live.cfg）。
//
// 注意：本模块在 @run-at document-start 的主世界内执行（@grant none），
//       对 Navigator/Canvas/performance 等原型的篡改能真实作用到页面。
import { markNative } from '../dom-utils';

export interface FpConfig {
  ua: boolean; // 通用 Windows/Chrome 画像（UA/platform/CPU核数/内存/languages）
  webdriver: boolean; // navigator.webdriver -> false
  canvas: boolean; // 2D 画布指纹加噪（toDataURL/getImageData）
  webgl: boolean; // WebGL readPixels 加噪（vendor 伪冒并入 ua）
  audio: boolean; // AudioBuffer.getChannelData 微噪（仅对「非共享底层」的安全读取场景生效）
  time: boolean; // performance.now 抖动 + 量化（破坏微秒级侧信道/指纹，单调保持）
  screen: boolean; // 清除 outer/inner 尺寸差指纹（DevTools 检测法）
  webrtc: boolean; // 强制 ICE relay（过滤 host/srflx，防止内网 IP 经 WebRTC 泄漏）
  debug: boolean; // 控制台条件静默（error/warn 恒透传）+ RegExp 超长探测 + 开发者键拦截
  fnGuard: boolean; // [实验性] 全局 Function 构造器替换以剔除 debugger 语句——语义差异面大，默认关
}

export const FP_DEFAULTS: FpConfig = {
  ua: false,
  webdriver: true,
  canvas: false, // 默认关：toDataURL 二次导出 + 同步读回会对高频导出（缩略图/自动保存）造成 GPU flush 卡顿，个别站或触发异常
  webgl: false, // 默认关：readPixels 结果被改会使「读取舞台像素」类积木得到错误颜色（影响作品逻辑而非仅指纹）
  audio: false, // 默认关：个别站点会向 getChannelData 返回值写入 PCM（程序化合成），加噪会丢写入
  time: false, // 默认关：performance.now 被全局量化/抖动会干扰帧计时语义，某些平台（CCW 类）因此白屏或卡死
  screen: false,
  webrtc: false, // 默认关：强制 relay 且无 TURN 时会使 P2P 连不通（防泄漏有代价，交用户决定）
  debug: false, // 默认关：console 静默会吞掉站点错误导致白屏时不可排查；需要时再开（error/warn 仍透传）
  fnGuard: false, // 实验性，默认关
};

const NS_CFG = ['v', 'm', 'f', 'p'].join('');
const NS_VER = ['v', 'm', 'f', 'p', 'v'].join(''); // 配置结构版本标记
const CFG_VER = '2'; // v2：CCW 白屏修复——风险项默认收敛为关

/** 一次性迁移：旧版（1.x）存档可能开着 time/canvas/webgl/debug/ua 等风险项，
 *  白屏即由此类项引起 → 新版本首次启动强制收敛为关，此后用户可逐项自行重开。 */
function migrateCfgOnce(): void {
  try {
    if (localStorage.getItem(NS_VER) === CFG_VER) return;
    const cur = readFpConfig(); // 旧存档 + 默认合并
    const risk: Array<keyof FpConfig> = ['ua', 'canvas', 'webgl', 'time', 'debug', 'fnGuard'];
    for (const k of risk) cur[k] = false;
    persistCfg(cur);
    localStorage.setItem(NS_VER, CFG_VER);
  } catch {
    /* 隐私模式等静默 */
  }
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function readFpConfig(): FpConfig {
  const out = { ...FP_DEFAULTS };
  try {
    const raw = localStorage.getItem(NS_CFG);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const k of Object.keys(FP_DEFAULTS) as (keyof FpConfig)[]) {
        if (isBool(parsed[k])) out[k] = parsed[k];
      }
    }
  } catch {
    /* 回退默认 */
  }
  return out;
}

function persistCfg(cfg: FpConfig): void {
  try {
    localStorage.setItem(NS_CFG, JSON.stringify(cfg));
  } catch {
    /* 容量/隐私模式静默 */
  }
}

/** 实时配置：包装器每次调用读它（一个对象属性读），切换配置即时生效，无需重新安装 */
const live: { cfg: FpConfig } = { cfg: FP_DEFAULTS };

export function getFpConfig(): FpConfig {
  return { ...live.cfg };
}

/** 合并保存 + 即时生效（供 UI 切换调用） */
export function setFpConfig(patch: Partial<FpConfig>): FpConfig {
  const next = { ...live.cfg, ...patch };
  for (const k of Object.keys(next) as (keyof FpConfig)[]) {
    if (!isBool(next[k])) next[k] = FP_DEFAULTS[k];
  }
  live.cfg = next;
  persistCfg(next);
  return { ...next };
}

export interface FpStats {
  installed: boolean;
  cfg: FpConfig;
  patched: Record<string, boolean>;
}
const patched: Record<string, boolean> = {};
let installed = false;
export function fpStats(): FpStats {
  return { installed, cfg: getFpConfig(), patched: { ...patched } };
}

// ---------------- 通用小工具 ----------------
let frame = 0;
/** 确定性整数哈希（噪声位置/抖动；同输入同输出） */
function rngStep(s: number): number {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

/** 8 位像素缓冲微噪声：翻转 n 个字节低位（±1..3），n 随长度平缓增长，上限 40 */
function addNoise8(arr: Uint8Array | Uint8ClampedArray, seed: number): void {
  const len = arr.length;
  if (len < 8) return;
  const n = Math.min(40, 4 + (len >>> 17)); // len>>>17 → /131072
  const step = 1 + (((len / n) | 0) | 1);
  let s = (seed ^ len) >>> 0;
  let i = rngStep(s) % len;
  for (let k = 0; k < n; k++) {
    if ((i & 3) !== 3) {
      // 跳过 alpha 通道，避免透明度改变
      const d = ((rngStep((s + (k << 8)) >>> 0) & 7) - 3) | 0; // -3..3
      arr[i] = (arr[i] + d) as number;
    }
    i = (i + step) % len;
  }
}

type NativeFn = (...args: unknown[]) => unknown;

function installWrapper(proto: object, name: string, wrapped: NativeFn): boolean {
  const holder = proto as unknown as Record<string, NativeFn>;
  if (typeof holder[name] !== 'function') return false;
  markNative(wrapped, name);
  try {
    holder[name] = wrapped;
    patched[name] = true;
    return true;
  } catch {
    return false;
  }
}

// 包装原型上的 getter。host 必须是「真实实例」——Navigator/Window 的 IDL getter 有内部 slot
// 品牌检查，以 prototype 为 this 调用会抛 Illegal invocation → real 取不到 → 包装 getter 把属性
// 变成 undefined → 页面 UA 检测（.match/.toLowerCase）直接白屏。取不到真实值就「不 patch」保原生。
function patchGetter(
  host: object | undefined,
  proto: object,
  name: string,
  mk: (real: unknown) => () => unknown
): boolean {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(proto, name);
  } catch {
    desc = undefined;
  }
  if (!desc) return false;
  let real: unknown;
  const origGet = desc.get;
  if (typeof origGet === 'function') {
    try {
      real = origGet.call(host); // this 必须是实例
    } catch {
      return false; // 取不到真实值 → 放弃本次 patch（宁缺毋滥，绝不 undefined 化）
    }
  } else {
    try {
      real = (proto as Record<string, unknown>)[name];
    } catch {
      real = undefined;
    }
  }
  const wrapped = mk(real);
  markNative(wrapped, name);
  try {
    Object.defineProperty(proto, name, {
      configurable: desc.configurable !== false,
      enumerable: Boolean(desc.enumerable),
      get: wrapped,
    });
    patched[name] = true;
    return true;
  } catch {
    return false;
  }
}

// ---------------- 1. navigator 画像 ----------------
interface NavigatorPreset {
  ua: string;
  platform: string;
  cores: number;
  memory: number;
  languages: string[];
}
const preset: NavigatorPreset = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  platform: 'Win32',
  cores: 8,
  memory: 8,
  languages: ['zh-CN', 'zh', 'en-US', 'en'],
};

function installNavigatorPatches(): void {
  if (typeof Navigator === 'undefined') return;
  const host = (typeof navigator !== 'undefined' ? navigator : undefined) as object | undefined;
  const np = Navigator.prototype;
  // UA 画像（开启后 platform/核数/内存/languages 一并统一为「另一台通用 Windows 设备」）
  patchGetter(host, np, 'userAgent', (real) => () => (live.cfg.ua ? preset.ua : (real as string)));
  patchGetter(host, np, 'platform', (real) => () => (live.cfg.ua ? preset.platform : (real as string)));
  patchGetter(host, np, 'hardwareConcurrency', (real) => () => (live.cfg.ua ? preset.cores : (real as number)));
  patchGetter(host, np, 'deviceMemory', (real) => () => (live.cfg.ua ? preset.memory : (real as number)));
  patchGetter(host, np, 'languages', (real) => {
    const spoof = [...preset.languages];
    return () => {
      if (!live.cfg.ua) {
        const r = real as readonly string[];
        return Array.isArray(r) ? [...r] : spoof;
      }
      return [...spoof];
    };
  });
  // webdriver 恒 false（独立于画像；默认开启）
  patchGetter(host, np, 'webdriver', (real) => () => (live.cfg.webdriver ? false : Boolean(real)));
}

// ---------------- 2. 高精度计时器模糊化 ----------------
const perfObj = globalThis.performance;
const NOW_ORIG = typeof perfObj?.now === 'function' ? perfObj.now.bind(perfObj) : null;
let lastNowOut = -1;
function fuzzNow(): number {
  const t = NOW_ORIG ? NOW_ORIG() : Date.now();
  if (!live.cfg.time) return t;
  // 抖动 ±0.5ms（确定性：源自时间自身的哈希），再量化到 0.5ms 粒度
  const jitter = ((rngStep(Math.floor(t * 4096)) & 15) - 8) / 16;
  let y = Math.round((t + jitter) * 2) / 2;
  if (y <= lastNowOut) y = lastNowOut + 0.5; // 严格单调，避免负 delta 破坏动画/游戏循环
  lastNowOut = y;
  return y;
}
function installTimePatches(): void {
  if (!NOW_ORIG) return;
  try {
    const wrapped = fuzzNow as unknown as () => number;
    markNative(wrapped, 'now');
    Object.defineProperty(perfObj, 'now', {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    patched['now'] = true;
  } catch {
    /* ignore */
  }
}

// ---------------- 3. 屏幕/窗口尺寸（DevTools 差值检测清除） ----------------
function installScreenPatches(): void {
  const host = (typeof window !== 'undefined' ? window : undefined) as object | undefined;
  if (typeof Window === 'undefined' || !host) return;
  const wp = Window.prototype;
  const screenPatch = (name: 'outerWidth' | 'outerHeight') => {
    patchGetter(host, wp, name, (real) => () => {
      if (!live.cfg.screen) return real as number;
      // 恒等于内尺寸 → outer-inner 差值恒为 0，DevTools 差值检测法失效
      return name === 'outerWidth' ? (host as Window).innerWidth : (host as Window).innerHeight;
    });
  };
  screenPatch('outerWidth');
  screenPatch('outerHeight');
}

// ---------------- 4. Canvas / WebGL 加噪 ----------------
function installCanvasPatches(): void {
  const canvasProto = globalThis.HTMLCanvasElement?.prototype;
  if (canvasProto) {
    const toDataUrlOrig = canvasProto.toDataURL as NativeFn;
    if (typeof toDataUrlOrig === 'function') {
      const wrapped = function (this: HTMLCanvasElement, ...a: unknown[]): unknown {
        const out = toDataUrlOrig.apply(this, a);
        if (!live.cfg.canvas) return out;
        const w = this.width;
        const h = this.height;
        if (!(w > 0 && h > 0) || w * h > 2_500_000) return out; // 超大画布不做（成本/收益不划算）
        try {
          const ctx = this.getContext('2d');
          if (!ctx) return out;
          const seed = (rngStep(w * 131 + h * 17 + frame) ^ 0x9e3779b9) >>> 0;
          const n = 1 + (rngStep(seed) & 1); // 1~2 个噪声点
          frame++;
          const spots: Array<{ x: number; y: number }> = [];
          ctx.save();
          for (let k = 0; k < n; k++) {
            const x = rngStep(seed + k * 0x9e37) % w;
            const y = rngStep(seed + k * 0x85eb + 0x1234) % h;
            spots.push({ x, y });
            const r = rngStep(seed + k + 0x2000) & 255;
            const g = rngStep(seed + k + 0x3000) & 255;
            const b = rngStep(seed + k + 0x4000) & 255;
            const a = (1 + (rngStep(seed + k + 0x5000) & 3)) / 255; // ~0.4%..1.6% 透明度，肉眼不可察
            ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
            ctx.fillRect(x, y, 1, 1);
          }
          const noisy = toDataUrlOrig.apply(this, a);
          // 原位恢复原始像素（同步完成，页面/肉眼感知不到扰动）
          for (const s of spots) {
            try {
              const img = ctx.getImageData(s.x, s.y, 1, 1);
              ctx.putImageData(img, s.x, s.y);
            } catch {
              /* ignore */
            }
          }
          ctx.restore();
          if (typeof noisy === 'string') return noisy;
          return out;
        } catch {
          return out; // tainted / WebGL 画布等异常场景直接返回原始导出
        }
      };
      installWrapper(canvasProto, 'toDataURL', wrapped);
    }
  }

  const ctxProto = globalThis.CanvasRenderingContext2D?.prototype;
  if (ctxProto) {
    const giOrig = ctxProto.getImageData as NativeFn;
    if (typeof giOrig === 'function') {
      const wrapped = function (this: CanvasRenderingContext2D, ...a: unknown[]): unknown {
        const img = giOrig.apply(this, a) as ImageData;
        if (!live.cfg.canvas) return img;
        try {
          addNoise8(img.data, rngStep((img.data.length >>> 2) + (frame++ << 5)));
          return img;
        } catch {
          return img;
        }
      };
      installWrapper(ctxProto, 'getImageData', wrapped);
    }
  }

  const glProto = globalThis.WebGLRenderingContext?.prototype;
  if (glProto) {
    const rpOrig = glProto.readPixels as NativeFn;
    if (typeof rpOrig === 'function') {
      const wrapped = function (this: WebGLRenderingContext, ...a: unknown[]): unknown {
        const out = rpOrig.apply(this, a);
        if (!live.cfg.webgl) return out;
        try {
          const type = a[5] as number | undefined;
          if (type !== undefined && type !== 0x1401) return out; // 0x1401 = UNSIGNED_BYTE
          const pixels = a[6] as Uint8Array | undefined;
          if (pixels && pixels.length > 0) {
            addNoise8(pixels, rngStep((pixels.length >>> 2) + (frame++ << 9)));
          }
          return out;
        } catch {
          return out;
        }
      };
      installWrapper(glProto, 'readPixels', wrapped);
    }
    const gpOrig = glProto.getParameter as NativeFn;
    if (typeof gpOrig === 'function') {
      const wrapped = function (this: WebGLRenderingContext, ...a: unknown[]): unknown {
        const p = a[0] as number;
        // vendor/renderer 伪冒随「通用画像」开启（GL_VENDOR/GL_RENDERER + UNMASKED 扩展）
        if (live.cfg.ua && (p === 0x1f00 || p === 0x9245)) {
          return 'Google Inc. (NVIDIA)';
        }
        if (live.cfg.ua && (p === 0x1f01 || p === 0x9246)) {
          return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        return gpOrig.apply(this, a);
      };
      installWrapper(glProto, 'getParameter', wrapped);
    }
  }
}

// ---------------- 5. 音频指纹扰乱 ----------------
const audioSharedCache = new WeakMap<object, boolean>();
function installAudioPatches(): void {
  const abProto = globalThis.AudioBuffer?.prototype;
  if (!abProto) return;
  const gcdOrig = abProto.getChannelData as (this: AudioBuffer, ch: number) => Float32Array;
  if (typeof gcdOrig !== 'function') return;  const wrapped = function (this: AudioBuffer, channel: number): Float32Array {
    const data = gcdOrig.call(this, channel);
    if (!live.cfg.audio || !data || data.length < 64) return data;
    // 每 buffer 探测一次「返回值是否与底层共享」：
    //  - 共享（写入即播放）→ 直接返回原数组，绝不加噪（保护程序化合成/播放）；
    //  - 独立副本（纯读取型指纹）→ 返回微噪副本，破坏音频指纹。
    let known = audioSharedCache.get(this);
    if (known === undefined) {
      try {
        const probe0 = data[0];
        data[0] = probe0 === 0 ? 1e-7 : probe0 * 1.0000001;
        const second = gcdOrig.call(this, channel);
        known = second[0] === data[0];
        data[0] = probe0; // 复原（共享底层时此复原同步回写真实值）
      } catch {
        known = false;
      }
      audioSharedCache.set(this, known);
    }
    if (known) return data;
    try {
      const copy = new Float32Array(data);
      const n = Math.min(24, 2 + (copy.length >>> 18));
      let s = rngStep((copy.length >>> 0) + (frame++ << 13)) >>> 0;
      for (let k = 0; k < n; k++) {
        const idx = rngStep(s + k * 2654435761) % copy.length;
        copy[idx] = copy[idx] + ((rngStep(s + k) & 15) - 8) * 1e-6;
      }
      return copy;
    } catch {
      return data;
    }
  };
  installWrapper(abProto, 'getChannelData', wrapped as unknown as NativeFn);
}

// ---------------- 6. WebRTC：内网 IP 防泄漏 ----------------
let RC_BACKUP: typeof RTCPeerConnection | null = null;
function installWebRtcPatches(): void {
  if (!live.cfg.webrtc) return; // 默认关 = 完全不替换 RTCPeerConnection（类替换有身份语义差异面，开启需刷新）
  const RC = globalThis.RTCPeerConnection as typeof RTCPeerConnection;
  if (typeof RC !== 'function') return;
  const FpRC = class extends RC {
    constructor(init?: RTCConfiguration) {
      const base = init ?? {};
      if (live.cfg.webrtc) {
        // 强制 relay：不收集 host/srflx → 内网/公网 IP 不进候选（无 TURN 时 P2P 不通，属预期）
        super(Object.assign({}, base, { iceTransportPolicy: 'relay' as RTCIceTransportPolicy }));
        return;
      }
      super(base);
    }
  };
  markNative(FpRC, 'RTCPeerConnection');
  RC_BACKUP = RC;
  try {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: FpRC,
    });
    patched['RTCPeerConnection'] = true;
  } catch {
    RC_BACKUP = null;
    /* ignore */
  }
}

/** 熔断/降级时热回滚 WebRTC 类替换 */
function resetWebRtc(): void {
  if (!RC_BACKUP) return;
  try {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: RC_BACKUP,
    });
  } catch {
    /* ignore */
  }
  RC_BACKUP = null;
  patched['RTCPeerConnection'] = false;
}

// ---------------- 7. console 条件静默 ----------------
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
const consoleRing: string[] = [];
function installConsolePatches(): void {
  const csl = console as unknown as Record<string, unknown>;
  for (const name of CONSOLE_METHODS) {
    const fn = csl[name];
    if (typeof fn !== 'function') continue;
    const wrapped = function (this: unknown, ...args: unknown[]): void {
      if (!live.cfg.debug) {
        (fn as (...a: unknown[]) => void).apply(this, args);
        return;
      }
      // error / warn 恒透传——白屏/异常时控制台必须可排查（静默只针对 log/info/debug/trace 等探测面）
      if (name === 'error' || name === 'warn') {
        (fn as (...a: unknown[]) => void).apply(this, args);
        return;
      }
      // 静默：保留内部环形缓冲（排障期可复盘）；仅 vaimod_debug=1 时透传真控制台
      let line = name + ':';
      try {
        const brief = args.map((a) => {
          try {
            if (typeof a === 'string') return a.length > 300 ? a.slice(0, 300) + '…' : a;
            const s = JSON.stringify(a);
            return s && s.length > 300 ? s.slice(0, 300) + '…' : (s ?? String(a));
          } catch {
            return String(a);
          }
        });
        line += brief.join(' ');
      } catch {
        line += '?';
      }
      if (consoleRing.length >= 60) consoleRing.shift();
      consoleRing.push(line);
      try {
        if (localStorage.getItem('vaimod_debug') === '1') {
          (fn as (...a: unknown[]) => void).apply(this, args);
        }
      } catch {
        /* ignore */
      }
    };
    markNative(wrapped, name);
    try {
      Object.defineProperty(csl, name, { configurable: true, writable: true, value: wrapped });
      patched['console.' + name] = true;
    } catch {
      /* ignore */
    }
  }
}
export function fpConsoleRing(): string[] {
  return [...consoleRing];
}

// ---------------- 8. RegExp 超长探测 / Function debugger 反制 / 开发者键 ----------------
const RE_LIMIT = 5_000_000; // 5MB 级才当「超长探测」拦截——正常站点正则处理几百 KB~数 MB 文本（大 XML/长代码）不得误伤
function patchRegExp(): void {
  const rp = RegExp.prototype;
  const testOrig = rp.test as NativeFn;
  if (typeof testOrig === 'function') {
    const wrapped = function (this: RegExp, ...a: unknown[]): unknown {
      if (live.cfg.debug) {
        const input = a[0];
        if (typeof input === 'string' && input.length > RE_LIMIT) return false; // 超长探测直接否定
      }
      return testOrig.apply(this, a);
    };
    installWrapper(rp, 'test', wrapped);
  }
  const execOrig = rp.exec as NativeFn;
  if (typeof execOrig === 'function') {
    const wrapped = function (this: RegExp, ...a: unknown[]): unknown {
      if (live.cfg.debug) {
        const input = a[0];
        if (typeof input === 'string' && input.length > RE_LIMIT) return null;
      }
      return execOrig.apply(this, a);
    };
    installWrapper(rp, 'exec', wrapped);
  }
}

// —— 实验性：全局 Function 替换（剔除构造串里的 debugger 语句）——
// 风险面大：任何页面深度自校验（toString 解析参数名 / 构造器身份比对 / 栈帧检查）
// 都可能因此行为异常 → 白屏。故默认不安装（fnGuard=false 时 install 直接跳过，零残留）；
// 需要时在 UI 开启并「刷新页面」才真正替换。
let FN_BACKUP: typeof Function | null = null;
function installFunctionGuard(): void {
  if (!live.cfg.fnGuard) return; // 默认关 = 完全不替换全局 Function
  const FN_ORIG = Function;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (live.cfg.fnGuard && args.length > 0) {
      const body = args[args.length - 1];
      if (typeof body === 'string' && body.length > 0 && body.length < 8192) {
        if (body.indexOf('debugger') >= 0) {
          // 剔除调试器语句，其余语义原样保留（构造型函数串常见于反调试/自校验）
          args[args.length - 1] = body.replace(/\bdebugger\b(?![\w$])/g, '');
        }
      }
    }
    if (new.target) {
      return Reflect.construct(FN_ORIG, args, FN_ORIG);
    }
    return (FN_ORIG as (...a: unknown[]) => unknown).apply(undefined, args);
  };
  markNative(wrapped, 'Function');
  // markNative 会删除 .prototype；必须恢复指向原生 Function.prototype，
  // 否则页面一切 `x instanceof Function` 都会因 RHS.prototype 缺失抛 TypeError。
  try {
    Object.defineProperty(wrapped, 'prototype', {
      configurable: false,
      writable: false,
      value: (FN_ORIG as { prototype: unknown }).prototype,
    });
  } catch {
    /* ignore */
  }
  FN_BACKUP = FN_ORIG;
  try {
    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    patched['Function'] = true;
  } catch {
    FN_BACKUP = null;
    /* ignore */
  }
}

/** 熔断/降级时热回滚：把全局 Function 还原为原生（仅当 fnGuard 曾安装才需要） */
function resetFunctionGuard(): void {
  if (!FN_BACKUP) return;
  try {
    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      writable: true,
      value: FN_BACKUP,
    });
  } catch {
    /* ignore */
  }
  FN_BACKUP = null;
  patched['Function'] = false;
}

function installDevKeyGuard(): void {
  const onKey = (e: KeyboardEvent): void => {
    if (!live.cfg.debug) return;
    const k = e.key;
    const ctrl = e.ctrlKey;
    const shift = e.shiftKey;
    let hit = false;
    if (k === 'F12' || e.code === 'F12') hit = true;
    else if (ctrl && shift && (k === 'I' || k === 'J' || k === 'C')) hit = true;
    else if (ctrl && k === 'U') hit = true;
    if (hit) {
      // 阻断页面级「开发者工具探测/反调试」逻辑；浏览器自身快捷键先于页面处理，不受影响
      e.stopPropagation();
      try {
        e.preventDefault();
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  patched['devkeys'] = true;
}

// ---------------- 启动期崩溃熔断（白屏自愈） ----------------
// 页面注入后短窗口内错误爆发（白屏/崩溃典型信号）→ 自动把高风险伪装项全部降级并持久化。
// 当前标签页多半已崩无法自救，但降级配置已写入 localStorage：用户刷新即以安全配置启动 → 自动痊愈。
// 误触发代价低（只是关掉伪装，功能本体不受影响）；现场留痕便于复盘。
const INCIDENT_KEY = ['v', 'm', 'f', 'i'].join('');
const RISKY_KEYS: Array<keyof FpConfig> = ['ua', 'canvas', 'webgl', 'audio', 'time', 'screen', 'debug', 'fnGuard'];
function installCrashBreaker(): void {
  let errors = 0;
  let firstAt = 0;
  let tripped = false;
  const cleanup = (): void => {
    window.removeEventListener('error', onErr, true);
    window.removeEventListener('unhandledrejection', onErr, true);
  };
  const onErr = (): void => {
    if (tripped) return;
    const now = Date.now();
    if (!firstAt) firstAt = now;
    errors++;
    if (now - firstAt < 3000 && errors >= 4) {
      tripped = true;
      try {
        const prev = getFpConfig();
        const next: FpConfig = { ...prev };
        for (const k of RISKY_KEYS) next[k] = false;
        setFpConfig(next); // live.cfg 即时降级 + 持久化（包装器读 live.cfg，立即回归原生透传）
        if (!next.fnGuard) resetFunctionGuard();
        if (!next.webrtc) resetWebRtc();
        try {
          localStorage.setItem(INCIDENT_KEY, JSON.stringify({ at: now, from: prev }));
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
      cleanup();
    }
  };
  window.addEventListener('error', onErr, true);
  window.addEventListener('unhandledrejection', onErr, true);
  setTimeout(cleanup, 4000); // 仅观察启动窗口
}

// ---------------- 安装入口 ----------------
export function installAntiFp(): void {
  if (installed) return;
  installed = true;
  migrateCfgOnce(); // CCW 白屏修复：旧存档开启的风险项一次性收敛为关（此后用户可逐项自开）
  live.cfg = readFpConfig(); // 持久化配置（默认值 + 上次用户选择）
  installNavigatorPatches();
  installTimePatches();
  installScreenPatches();
  installCanvasPatches();
  installAudioPatches();
  installWebRtcPatches();
  installConsolePatches();
  patchRegExp();
  installFunctionGuard(); // 默认不安装（fnGuard=false 直接跳过，零残留）
  installDevKeyGuard();
  installCrashBreaker(); // 启动窗口崩溃熔断：误伤站点时自动降级，刷新即自愈
}
