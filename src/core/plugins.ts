// ===== VaIMod 插件系统 · 格式定义与解析 =====
//
// 插件是一个 **JS 文件**（不是 JSON），内部用一个具名对象字面量描述自己。
// 设计目标是「人能手写、机器能解析、上传即安装」：
//
// ```js
// VaIMod.plugin({
//   id: 'my-tool',                 // 唯一标识（必填，小写字母/数字/短横线）
//   name: '我的工具',               // 标签页标题（必填）
//   version: '1.0.0',              // 版本（可选）
//   author: 'someone',             // 作者（可选）
//   desc: '这个插件做什么',          // 描述（可选）
//
//   css: `...`,                    // 标签页内容区样式（可选；不写用内置默认）
//   html: `...`,                   // 标签页内容相关结构（可选；不写则运行 mount）
//   code(ctx) { ... },             // 标签页功能代码（可选）
//   refresh(ctx) { ... },          // 点击面板「刷新」时执行（可选；未定义则刷新仅重播动画）
//   settingsCss: `...`,            // 该插件在设置页的样式（可选）
//   settings: [                    // 该插件在设置页的功能项（可选）
//     { type: 'toggle', key: 'on', label: '开关', desc: '说明', def: true },
//   ],
//   extra: { ... },                // 其它内容（任意数据，原样交给 code）
// });
// ```
//
// 解析策略：用 `new Function('VaIMod', '<旧全局名>', src)` 把整段源码执行一次（第一个参数是
// 新全局名，第二个是更名前的旧全局名，二者指向同一收集器 —— 更名前写的插件文件不改也能装），
// 由 `VaIMod.plugin(def)` 收集定义（比正则抠字段稳得多：模板字符串 / `${}` / 注释
// 等边界情形都不会解析错）。代价是要如实承认：执行作用域是全局作用域，插件文件
// 属于「与页面脚本同级的可信代码」，**不是**安全沙箱（详见 parsePluginSource 注释）。
// 可信来源由「用户主动上传 + 安装确认」把关，存储态另有完整性指纹校验兜底。

export interface PluginSettingToggle {
  type: 'toggle';
  key: string;
  label: string;
  desc?: string;
  def?: boolean;
}

export interface PluginSettingText {
  type: 'text' | 'number';
  key: string;
  label: string;
  desc?: string;
  def?: string | number;
  placeholder?: string;
}

export interface PluginSettingSelect {
  type: 'select';
  key: string;
  label: string;
  desc?: string;
  def?: string;
  options: { value: string; label: string }[];
}

export type PluginSettingDef = PluginSettingToggle | PluginSettingText | PluginSettingSelect;

/**
 * 插件类型（必须在定义开头声明）：
 *   - 'patch' 补丁：无界面、headless 运行的**安全补丁**——参与 VaIMod 内部管道
 *     （如变量写回拦截），用于沙盒加固、遮罩联动、安全模块拦截器等。
 *     不注册标签页；code 在面板挂载时立即执行一次。
 *   - 'ext'   扩展：即原有插件形态——带标签页 UI（html/css/code）。
 *     code 在用户打开对应标签页时执行。
 * 未声明 type 的旧格式插件按 'ext' 兼容处理。
 */
export type PluginType = 'patch' | 'ext';

/**
 * 异步加载定义 —— 由**插件自己在清单里填写**（`async: {...}`），决定这份插件
 * 什么时候加载、要不要等 vm、以及异步期间怎么表现。
 *
 * 全部字段可选，缺省为「保守同步」：装到就执行、不等待、不超时。
 * 填写示例：
 *   VaIMod.plugin({
 *     ...
 *     async: {
 *       code: true,                     // code 是异步的（返回 Promise）
 *       waitVm: true,                   // 等 vm 就绪（桥接连接）后再执行 code
 *       lazy: true,                      // 打开该标签页时才执行（扩展默认如此）
 *       timeout: 15000,                 // 异步超时（ms），超时按加载失败处理
 *       load: `await fetch(...);`,      // 预加载钩子：在 code 之前执行，可异步
 *     },
 *   });
 * 简写：`async: true` 等价于 `{ code: true }`（只声明 code 是异步的）。
 */
/**
 * 插件市场元信息 —— 同样由**插件自己在清单里填写**，供市场/设置页展示与检索。
 *
 * 优先从 `market: {...}` 对象读取，其次读 `@market.*` 命名空间标签
 * （例：`@market.category 工具`、`@market.tags 变量,批量`）。
 * 未列出的 `@market.xxx` 会原样收进 `extra.marketTags`，市场侧新增字段
 * 不需要改本体代码。
 */
export interface PluginMarketDef {
  /** 上架分类（如 工具 / 视觉 / 数据 / 安全） */
  category: string;
  /** 检索关键词 */
  tags: string[];
  /** 图标：emoji 或图片 URL */
  icon: string;
  /** 项目主页 / 仓库 */
  homepage: string;
  /** 许可协议（如 MIT） */
  license: string;
  /** 要求的最低 VaIMod 版本 */
  minApp: string;
  /** 版本更新说明 */
  changelog: string;
  /** 截图 / 示例链接 */
  screenshots: string[];
}

export interface PluginAsyncDef {
  /** code 是异步的（返回 Promise）。清理函数在 Promise 落定后才接管 */
  code: boolean;
  /** 等到 vm 就绪后再执行 code；未就绪期间标签页显示等待态而不是空面板 */
  waitVm: boolean;
  /** 懒加载：标签页未打开就不执行 code。扩展默认 true；补丁强制 false（必须常驻） */
  lazy: boolean;
  /** 预加载钩子：在 code 之前执行，可异步。用于按需拉取远程资源 / 初始化大依赖 */
  load: string;
  /** 异步加载超时（ms）；0 = 不限制。超时按失败处理并在标签页内提示 */
  timeout: number;
}

/** 解析后的插件定义（可直接用于渲染与执行） */
export interface PluginDef {
  id: string;
  name: string;
  version: string;
  author: string;
  desc: string;
  /** 插件类型：patch=安全补丁（headless）| ext=扩展（标签页） */
  type: PluginType;
  /**
   * 补丁管道优先级（仅 patch 有意义；扩展忽略）。
   * 数值越小越先过管道链，默认 100；允许 0–10000。
   */
  priority: number;
  /** 标签页内容区样式（作用域限定在该插件的内容容器内） */
  css: string;
  /** 标签页内容相关结构（纯 HTML 字符串；不写则由 code 自行构造） */
  html: string;
  /** 标签页功能代码。ctx 提供容器、存储、变量、toast 等能力 */
  code: string;
  /**
   * 刷新钩子：用户点击面板「刷新」按钮且停在本插件标签页时执行。
   * 与 code 拿到同一个 ctx（变量快照读取是实时的）；只做数据重取/重渲染，
   * 不要在 refresh 里重新订阅（onVariables/onSettings 等）——那会造成重复订阅。
   */
  refresh: string;
  /** 该插件在设置页的样式 */
  settingsCss: string;
  /** 该插件在设置页的功能项定义 */
  settings: PluginSettingDef[];
  /** 异步加载定义（插件清单里填写，缺省保守同步；见 PluginAsyncDef） */
  async: PluginAsyncDef;
  /** 市场元信息（插件清单里填写；见 PluginMarketDef） */
  market: PluginMarketDef;
  /** 其它内容（任意 JSON 可序列化数据；原样透传给 code） */
  extra: Record<string, unknown>;
}

/** 已安装插件（定义 + 启用态 + 安装时间） */
export interface InstalledPlugin {
  def: PluginDef;
  enabled: boolean;
  installedAt: number;
  /** 源码指纹（导入配置时用于「代码一模一样则不重复安装」） */
  sig: string;
}

/** 变量写回拦截点的元信息（补丁管道 variable:write） */
export interface PatchWriteMeta {
  id: string;
  name: string;
  targetId: string;
  isCloud: boolean;
  kind: 'variable' | 'list';
}

/**
 * 补丁钩子返回值语义：
 *   - 返回 `false`（严格相等）→ 拒绝本次操作（写回被拦截）
 *   - 返回 undefined        → 放行，值不变
 *   - 返回其它值            → 用返回值替换，继续过后续钩子
 */
export type PatchHookFn = (value: unknown, meta: PatchWriteMeta) => unknown;

/** 补丁专属能力面（仅 type:'patch' 的插件在 ctx.patch 拿到） */
export interface PatchApi {
  /**
   * 注册管道钩子。当前可用管道：
   *   - 'variable:write'：变量写回链（面板内所有变量/列表写回都过此链）
   * 每个补丁在每个管道上只能注册一个钩子（重复注册覆盖旧的）；
   * 全局钩子总数上限 32；钩子抛错自动熔断（连续 3 次错误后禁用）。
   */
  hooks: {
    add(point: 'variable:write', fn: PatchHookFn): boolean;
  };
  /** 注销本补丁注册的全部钩子（清理函数一般用不到它，钩子随补丁生命周期自动管理） */
  hooksRemoveAll(): void;
}

import type { PluginUIApi } from './plugin-ui';

/** 角色清单条目（ctx.project.listSprites） */
export interface PluginSpriteInfo {
  id: string;
  name: string;
  costumeCount: number;
  soundCount: number;
}

/** 捕获条目元信息（ctx.project.listCaptured / onCaptured） */
export interface PluginCapturedInfo {
  id: number;
  time: number;
  size: number;
  name: string;
}

/**
 * 作品能力面（ctx.project）：导出 .sb3 / .sprite3 / 角色打包 + loadProject 捕获。
 * 由宿主（bridge）背书实现；插件拿不到 vm/bridge 本体，只拿到这个窄面。
 */
export interface PluginProjectApi {
  /** 当前作品导出为 .sb3（官方 saveProjectSb3 优先，polyfill 兜底） */
  exportSb3(): Promise<Blob>;
  /** 单个角色导出为 .sprite3 */
  exportSprite(targetId: string): Promise<Blob>;
  /** 全部角色打包为 zip（每角色一个 .sprite3） */
  exportSpritesZip(): Promise<Blob>;
  /** 角色清单（id/名称/造型数/声音数） */
  listSprites(): PluginSpriteInfo[];
  /** 自动捕获开关（关闭即清空已捕获条目） */
  setCapture(enabled: boolean): void;
  /** 捕获清单（时间/大小/文件名，纯内存环形缓冲） */
  listCaptured(): PluginCapturedInfo[];
  /** 取某条捕获的 Blob（过期 id 返回 null） */
  getCapturedBlob(id: number): Promise<Blob | null>;
  /** 清空捕获列表 */
  clearCaptured(): void;
  /** 订阅新捕获（返回取消订阅函数） */
  onCaptured(cb: (e: PluginCapturedInfo) => void): () => void;
}

/** 插件运行上下文：暴露给插件 code 的能力面（受控，不给 DOM 之外的越权面） */
export interface PluginContext {
  /** 该插件自己的内容容器（已挂载 html 之后） */
  root: HTMLElement;
  /** 插件私有存储（localStorage 命名空间隔离，key 自动加前缀） */
  store: {
    get<T>(key: string, def: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
  };
  /** 设置项当前值（读取由设置页写下的值；带默认值兜底） */
  settings: Record<string, unknown>;
  /** 监听设置变化（返回取消订阅函数） */
  onSettings(cb: (values: Record<string, unknown>) => void): () => void;
  /** 取当前变量快照（只读副本；含安全变量，targetId/isLocked 供 write 使用） */
  variables(): ReadonlyArray<{
    id: string;
    name: string;
    kind: 'variable' | 'list';
    value: unknown;
    isCloud: boolean;
    targetId: string;
    targetName: string;
    isLocked: boolean;
  }>;
  /** 订阅变量变化（返回取消订阅函数） */
  onVariables(cb: () => void): () => void;
  /**
   * 写变量（走面板统一写回管道：多层安全栈 + 补丁拦截 + 锁变量同步）。
   * 安全变量无需 targetId（按 id 直接命中加密存储）；列表传值数组或逗号串。
   * 结果经面板 toast 反馈（含拦截/失败原因），无返回值。
   */
  write(variableId: string, value: unknown, targetId?: string): void;
  /**
   * UI 样式接口：与主面板同质感的组件工厂（提示/按钮/开关/框选/输入/卡片/确认框）。
   * 组件类名 .vpu-*，主色自动跟随面板主题（--svp-primary）；
   * 插件也可用 def.css 自定义样式（作用域限定在 #vmp-<id>），两者可混用。
   */
  ui: PluginUIApi;
  /** 面板提示 */
  toast(text: string, kind?: 'ok' | 'err'): void;
  /** 作品能力面：sb3/sprite3 导出、角色打包、loadProject 捕获（bridge 背书的窄面） */
  project: PluginProjectApi;
  /**
   * 本地重命名配置（**仅显示层**，见 core/alias-config.ts）。
   * 注意语义：导入规则只改面板里显示的名字，**绝不新建变量、绝不改作品里的变量名**。
   * 因此这里没有「写变量」能力 —— 只有配置本身的读写。
   */
  alias: {
    /** 当前配置副本 */
    get(): unknown;
    /** 规则条数 / 是否启用 */
    stats(): { rules: number; enabled: boolean; name: string };
    /** 导入配置（兼容 rules / variables / displayNames / 扁平表；非法时抛错） */
    importConfig(raw: unknown): unknown;
    /** 导出为可读 JSON 字符串 */
    exportConfig(): string;
    /** 清空规则 */
    clear(): void;
    /** 启用/停用 */
    setEnabled(on: boolean): void;
    /** 订阅配置变化（返回取消订阅函数） */
    subscribe(cb: () => void): () => void;
  };
  /**
   * 网络防火墙（出网审计 + 域名规则，见 core/net-firewall.ts）。
   * 默认「只观察不拦截」；插件可据此做「这个作品在偷偷外传」之类的告警。
   * 注意：这里只暴露规则与观察面，没有「直接放行/拦截某条请求」的开关 ——
   * 拦截与否统一由用户的模式 + 规则决定，插件不能绕过用户意志。
   */
  firewall: {
    /** 当前模式（off / watch / enforce） */
    mode(): 'off' | 'watch' | 'enforce';
    /** 计数与规则条数 */
    stats(): {
      mode: 'off' | 'watch' | 'enforce';
      hosts: number;
      hits: number;
      blocked: number;
      blockRules: number;
      allowRules: number;
    };
    /** 命中日志（按最近活跃排序） */
    hits(): unknown[];
    /** 当前域名规则 */
    rules(): { block: string[]; allow: string[] };
    /** 加规则（kind = 'block' | 'allow'）；域名非法返回 false */
    addRule(host: string, kind: 'block' | 'allow'): boolean;
    removeRule(host: string, kind: 'block' | 'allow'): void;
    /** 订阅日志/规则变化（返回取消订阅函数） */
    subscribe(cb: () => void): () => void;
  };
  /** 补丁专属能力（仅 type:'patch' 存在；扩展为 undefined） */
  patch?: PatchApi;
  /** 插件标识（日志用） */
  id: string;
  /** 其它内容原样透传 */
  extra: Record<string, unknown>;
}

// ---------- 校验 ----------

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;

export class PluginParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginParseError';
  }
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function normalizeSettingsDefs(raw: unknown): PluginSettingDef[] {
  if (!Array.isArray(raw)) return [];
  const out: PluginSettingDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const key = asString(o.key);
    const label = asString(o.label);
    if (!key || !label || seen.has(key)) continue;
    const type = asString(o.type, 'toggle');
    const desc = asString(o.desc) || undefined;
    if (type === 'toggle') {
      seen.add(key);
      out.push({ type: 'toggle', key, label, desc, def: o.def !== false });
      continue;
    }
    if (type === 'text' || type === 'number') {
      seen.add(key);
      out.push({
        type,
        key,
        label,
        desc,
        def: (o.def as string | number | undefined) ?? (type === 'number' ? 0 : ''),
        placeholder: asString(o.placeholder) || undefined,
      });
      continue;
    }
    if (type === 'select') {
      const opts = Array.isArray(o.options)
        ? o.options
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map((x) => ({ value: asString(x.value), label: asString(x.label, asString(x.value)) }))
            .filter((x) => x.value !== '')
        : [];
      if (opts.length === 0) continue;
      seen.add(key);
      out.push({
        type: 'select',
        key,
        label,
        desc,
        def: asString(o.def, opts[0].value),
        options: opts,
      });
      continue;
    }
  }
  return out;
}

/**
 * 把函数形态的 code 规整为「可在 new Function 体里直接执行并回传返回值」的语句串。
 *
 * 背景：作者常写成方法简写 `code(ctx) { ... }`，String(fn) 得到 "code(ctx) { ... }"
 * —— 这不是合法表达式（缺 function 关键字），直接放进 new Function 体只会成为
 * 一个**从不被调用的函数声明**，插件功能静默失效。这里统一补齐关键字，再包
 * `return (...)(ctx)`，让 code 的返回值（清理函数）能穿透出来。
 */
function functionCodeToString(fn: (...args: unknown[]) => unknown): string {
  const src = String(fn).trim();
  let normalized = src;
  // 已经是函数表达式/箭头函数 → 原样使用。必须先判这一类：`function (ctx){}`、
  // `async (ctx)=>{}` 的 `function`/`async` 本身就是「标识符后跟 (」，
  // 走下面的方法简写分支会被拼成 `function function (ctx){}` / `function async (ctx)=>{}`
  // —— 都是 SyntaxError，插件 code 直接不执行（只留一条运行出错 toast）。
  if (
    /^\(/.test(src) ||
    /^function\b/.test(src) ||
    /^async\s*\(/.test(src) ||
    /^async\s+function\b/.test(src)
  ) {
    normalized = src;
  } else if (/^async\s+[A-Za-z_$][\w$]*\s*\(/.test(src)) {
    // 异步方法简写："async code(ctx) {" → "async function code(ctx) {"
    normalized = src.replace(/^async\s+/, 'async function ');
  } else if (/^[A-Za-z_$][\w$]*\s*\(/.test(src)) {
    // 方法简写 / 具名函数缺关键字："code(ctx) {" → "function code(ctx) {"
    normalized = `function ${src}`;
  }
  return `return (${normalized})(ctx);`;
}

/**
 * 解析插件源码。
 *
 * 关键取舍：**在沙箱里真实执行一次源码**（而不是正则抠字段）。
 * 理由：插件作者的 css/html/code 里会包含反引号、`${}`、`//` 等，
 * 正则/JSON5 式解析极易在边界情形上出错；而 `new Function` 方案下
 * 插件文件就是普通 JS，作者可自由使用模板字符串、字符串拼接、辅助函数，
 * 我们只在执行后从 `VaIMod.plugin()` 拿到**已求值的字符串**。
 *
 * 沙箱边界（如实说明，勿高估）：
 *   - 只传入一只 `VaIMod` 包装对象、`this` 绑定 undefined，**没有 ctx** —— 插件在
 *     解析期拿不到 VaIMod 的能力面（桥接 / 变量 / 面板）。
 *   - 但 `new Function` 的函数体作用域是全局作用域：解析期源码仍可触达
 *     `window` / `document` / `localStorage` / `fetch` 等宿主全局，且可用
 *     `Function` / 原型链绕开任何「不传参数」的限制。因此**解析期不是安全边界**，
 *     真正的边界是「用户主动上传安装」这一动作 + 安装确认。
 *     安全约束由此承担：插件源码被视为与页面脚本同级的可信代码。
 *   - 运行期能力面（ctx）才是受控的：写变量走面板漏斗、DOM 只在自己 root 内。
 *
 * 加固：存储态在 plugin-registry 侧做完整性指纹校验（bodySig），条目被外部
 * 改写或写坏即拒绝加载 —— 阻断「页面脚本直接往 localStorage 塞插件」的注入路径。
 */
/**
 * 剥掉注释装饰，让标签行与块值都能原样取出。
 * 支持 `//  @html`、`/* @html`、` * @html`、纯 `@html` 四种写法。
 */
function stripCommentDecoration(line: string): string {
  return line
    .replace(/^\s*\/\*+\s?/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*+\s?/, '')
    .replace(/^\s*\/\/+\s?/, '');
}

/**
 * 解析插件前的「标签式声明区」（`@key value` / `@key: value`），与
 * `VaIMod.plugin({...})` 对象写法**并存**；两边都写时**对象优先**
 * （对象表达力更强、有类型检查，标签更适合写 `@html` 这类大块内容）。
 *
 * 只扫**文件开头的注释区**，扫到第一行真实代码即停止 —— 这样插件正文里出现的
 * `@`（装饰器、邮箱、字符串）不会被误判成标签。
 *
 * 标签形态：
 *   单行值：`@id my-tool` / `@name: 我的工具`
 *   布尔开关：`@async`（裸写即 true）/ `@async false`
 *   块值：`@html` 之后的每一行都算它的内容，直到下一个 `@` 标签为止（可多行）
 *   未识别的标签原样收进 extra.tags —— 插件可以自行扩展新标签而不必改本体
 */
export function parsePluginTags(src: string): Map<string, string> {
  const tags = new Map<string, string>();
  const lines = src.split(/\r?\n/);
  // 只取开头连续的注释/空行作为声明区
  const region: string[] = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    const isComment = t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
    if (!isComment) break;
    started = true;
    region.push(stripCommentDecoration(line));
  }
  if (!started) return tags;
  let cur: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (cur) tags.set(cur, buf.join('\n').replace(/\s+$/, ''));
    cur = null;
    buf.length = 0;
  };
  for (const line of region) {
    // 允许点号 → 支持 `@market.category` 这类命名空间标签
    const m = /^@([A-Za-z][\w.-]*)\s*:?\s?([\s\S]*)$/.exec(line.trim());
    if (m) {
      flush();
      cur = m[1].toLowerCase();
      buf.push(m[2]);
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return tags;
}

/** 标签布尔值：裸写（无值）视为 true；'false'/'0'/'no'/'off' 视为 false */
function tagBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return undefined;
}

export function parsePluginSource(src: string): PluginDef {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new PluginParseError('插件文件为空');
  }
  if (src.length > 512 * 1024) {
    throw new PluginParseError('插件文件过大（上限 512 KB）');
  }
  let captured: Record<string, unknown> | null = null;
  const registry = {
    plugin(def: unknown) {
      if (!def || typeof def !== 'object') {
        throw new PluginParseError('VaIMod.plugin() 需要一个对象参数');
      }
      captured = def as Record<string, unknown>;
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    // 双全局：新插件用 VaIMod.plugin(...)；更名前写的 <旧全局名>.plugin(...) 依旧可安装。
    // 注意：第二个字面量是**兼容入口**，必须原样保留（改了老插件文件就装不上了）。
    const factory = new Function('VaIMod', 'ValMod', `"use strict";\n${src}\n`);
    factory.call(undefined, registry, registry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PluginParseError(`插件源码执行失败：${msg}`);
  }
  const def = captured as Record<string, unknown> | null;
  if (!def) {
    throw new PluginParseError('插件未调用 VaIMod.plugin({...})，无法识别');
  }

  // 标签式声明作为对象写法的**回退**：对象里写了就用对象（优先），没写才看 @标签。
  // 这样两种格式可以混用，例如对象里写 code、标签里写 @html。
  const tags = parsePluginTags(src);
  const pick = (key: string): unknown => {
    const v = def[key];
    if (v !== undefined && v !== null) return v;
    return tags.has(key) ? tags.get(key) : undefined;
  };

  const id = asString(pick('id')).trim();
  if (!ID_RE.test(id)) {
    throw new PluginParseError('插件 id 缺失或格式非法（要求 2–48 位小写字母/数字/短横线/下划线）');
  }
  const name = asString(pick('name')).trim();
  if (!name) throw new PluginParseError('插件 name（标签页标题）不能为空');

  // 插件类型：缺省按扩展兼容（旧格式插件）；显式声明必须是 'patch' 或 'ext'
  const rawType = pick('type');
  let type: PluginType = 'ext';
  if (rawType !== undefined) {
    if (rawType !== 'patch' && rawType !== 'ext') {
      throw new PluginParseError(`插件 type 非法（"${String(rawType)}"）：只支持 'patch'（安全补丁）或 'ext'（扩展）`);
    }
    type = rawType;
  }
  // 补丁优先级：0–10000，默认 100（越小越先过管道链）
  const rawPriority = pick('priority');
  const priority =
    typeof rawPriority === 'number' && Number.isFinite(rawPriority)
      ? Math.min(10000, Math.max(0, Math.round(rawPriority)))
      : 100;

  // ---------- 标签分区：市场命名空间标签 / 未识别标签 ----------
  // 已知标签一览（其余一律当作用户自定义标签保留，市场侧加字段不必改本体）
  const KNOWN_TAGS = new Set([
    'id', 'name', 'version', 'author', 'desc', 'type', 'priority',
    'css', 'html', 'code', 'refresh', 'settingscss', 'settings',
    'async', 'waitvm', 'lazy', 'timeout', 'load', 'document', 'market',
  ]);
  const marketTags: Record<string, string> = {};
  const otherTags: Record<string, string> = {};
  for (const [k, v] of tags) {
    if (k.startsWith('market.')) {
      marketTags[k.slice('market.'.length)] = v;
      continue;
    }
    if (!KNOWN_TAGS.has(k)) otherTags[k] = v;
  }

  const baseExtra =
    def.extra && typeof def.extra === 'object' && !Array.isArray(def.extra)
      ? (def.extra as Record<string, unknown>)
      : {};
  const extra: Record<string, unknown> = { ...baseExtra };
  // 未识别的 @标签 与全部 @market.* 一并保留：前者便于作者自行扩展，后者便于
  // 市场侧新增字段时无需改本体（已知键在 marketDef 里另有一份规整后的值）。
  if (Object.keys(otherTags).length > 0) extra.tags = otherTags;
  if (Object.keys(marketTags).length > 0) extra.marketTags = marketTags;

  // ---------- 市场元信息：`market: {...}` 对象 + `@market.*` 标签（标签键全小写） ----------
  const rawMarket = pick('market');
  const marketObjLower: Record<string, unknown> = {};
  if (rawMarket && typeof rawMarket === 'object' && !Array.isArray(rawMarket)) {
    for (const [k, v] of Object.entries(rawMarket as Record<string, unknown>)) {
      marketObjLower[k.toLowerCase()] = v;
    }
  }
  const mStr = (key: string): string => {
    const fromObj = marketObjLower[key];
    if (typeof fromObj === 'string') return fromObj;
    if (typeof fromObj === 'number') return String(fromObj);
    const fromTag = marketTags[key];
    return typeof fromTag === 'string' ? fromTag : '';
  };
  const mList = (key: string): string[] => {
    const fromObj = marketObjLower[key];
    if (Array.isArray(fromObj)) return fromObj.filter((x): x is string => typeof x === 'string');
    if (typeof fromObj === 'string') return [fromObj];
    const fromTag = marketTags[key];
    // 标签里用逗号/空格分隔多个值（中英文逗号都认）
    return fromTag ? fromTag.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : [];
  };
  const marketDef: PluginMarketDef = {
    category: mStr('category'),
    tags: mList('tags'),
    icon: mStr('icon'),
    homepage: mStr('homepage'),
    license: mStr('license'),
    minApp: mStr('minapp'),
    changelog: mStr('changelog'),
    screenshots: mList('screenshots'),
  };

  // 异步加载定义（插件清单内填写）：对象写法 + `async: true` 简写。
  // 容错优先：字段类型不对就回落到默认值，不让一份写歪的 async 阻断整个插件安装。
  const rawAsync = pick('async');
  const hasAsyncObj = !!rawAsync && typeof rawAsync === 'object' && !Array.isArray(rawAsync);
  const asyncObj = hasAsyncObj ? (rawAsync as Record<string, unknown>) : {};
  // 标签回退：`@async` / `@waitVm` / `@lazy` / `@timeout` / `@load`
  // （`pick('load')` 已自动覆盖「对象没写、标签写了」的情形）
  const tagAsync = hasAsyncObj ? undefined : tagBool(tags.get('async'));
  const tagTimeout = Number.parseInt((tags.get('timeout') ?? '').trim(), 10);
  const rawLoad = pick('load');
  const asyncDef: PluginAsyncDef = {
    // `async: true` 简写，或 async.code 写成 true / 函数 / 字符串，都视为「code 是异步的」
    code:
      rawAsync === true ||
      tagAsync === true ||
      asyncObj.code === true ||
      typeof asyncObj.code === 'function' ||
      typeof asyncObj.code === 'string',
    waitVm: asyncObj.waitVm === true || tagBool(tags.get('waitvm')) === true,
    // 扩展默认懒加载（本来就是打开标签页才跑）；写 false 可关掉；补丁稍后强制 false
    lazy: asyncObj.lazy !== false && tagBool(tags.get('lazy')) !== false,
    load:
      typeof rawLoad === 'function'
        ? functionCodeToString(rawLoad as (...args: unknown[]) => unknown)
        : asString(rawLoad),
    timeout: Number.isFinite(tagTimeout) && tagTimeout > 0
      ? Math.round(tagTimeout)
      : typeof asyncObj.timeout === 'number' && Number.isFinite(asyncObj.timeout)
        ? Math.max(0, Math.round(asyncObj.timeout))
        : 0,
  };
  if (type === 'patch') {
    // 补丁是 headless 常驻的，不能懒加载
    asyncDef.lazy = false;
  }

  // 内容字段同样「对象优先、@标签回退」——尤其 `@html` / `@css` / `@code` 这类
  // 大块内容写在注释区更好维护（见 parsePluginTags 的块值规则）。
  const rawCode = pick('code');
  const rawRefresh = pick('refresh');
  // `@settingscss` 标签键是全小写的，对象键是 settingsCss，两边对不上，单独取一次
  const rawSettingsCss = def.settingsCss ?? (tags.has('settingscss') ? tags.get('settingscss') : undefined);
  const rawSettings = pick('settings');
  let settingsInput: unknown = rawSettings;
  if (typeof rawSettings === 'string' && rawSettings.trim()) {
    // 标签写法只能是字符串，按 JSON 解析；解析不出来就当作没写（不让一份写歪的
    // @settings 阻断整个插件安装）
    try {
      settingsInput = JSON.parse(rawSettings);
    } catch {
      settingsInput = undefined;
    }
  }

  return {
    id,
    name,
    version: asString(pick('version'), '1.0.0'),
    author: asString(pick('author')),
    desc: asString(pick('desc')),
    type,
    priority,
    css: asString(pick('css')),
    html: asString(pick('html')),
    // 功能代码：允许写成函数（规整为可执行语句串）或字符串（直接用）
    code:
      typeof rawCode === 'function'
        ? functionCodeToString(rawCode as (...args: unknown[]) => unknown)
        : asString(rawCode),
    // 刷新钩子：与 code 同样的规整方式（方法简写自动补 function 关键字）
    refresh:
      typeof rawRefresh === 'function'
        ? functionCodeToString(rawRefresh as (...args: unknown[]) => unknown)
        : asString(rawRefresh),
    settingsCss: asString(rawSettingsCss),
    settings: normalizeSettingsDefs(settingsInput),
    async: asyncDef,
    market: marketDef,
    extra,
  };
}

/**
 * 源码指纹：用于「代码一模一样则不重复安装」的判定。
 * 用 64 位 FNV-1a（双通道拼接），碰撞概率对本场景足够低，且无异步依赖。
 */
export function pluginSignature(src: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 把插件定义重新序列化成可阅读、可再上传的 JS 源码（用于导出配置） */
export function serializePluginDef(def: PluginDef): string {
  const q = (s: string): string => JSON.stringify(s);
  const lines: string[] = [];
  lines.push('// VaIMod 插件（本文件由 VaIMod 导出，可直接再次上传安装）');
  lines.push('VaIMod.plugin({');
  lines.push(`  type: ${q(def.type)}, // 'patch'=安全补丁 | 'ext'=扩展`);
  lines.push(`  id: ${q(def.id)},`);
  lines.push(`  name: ${q(def.name)},`);
  lines.push(`  version: ${q(def.version)},`);
  if (def.type === 'patch') lines.push(`  priority: ${def.priority},`);
  if (def.author) lines.push(`  author: ${q(def.author)},`);
  if (def.desc) lines.push(`  desc: ${q(def.desc)},`);
  lines.push('');
  if (def.css) lines.push(`  css: ${q(def.css)},`);
  if (def.html) lines.push(`  html: ${q(def.html)},`);
  if (def.code) lines.push(`  code: ${q(def.code)},`);
  if (def.refresh) lines.push(`  refresh: ${q(def.refresh)},`);
  if (def.settingsCss) lines.push(`  settingsCss: ${q(def.settingsCss)},`);
  if (def.settings.length > 0) lines.push(`  settings: ${JSON.stringify(def.settings, null, 2)},`);
  // 异步加载定义：只写非默认项，导出的插件源码保持精简且与解析端往返一致
  const a = def.async;
  if (a && (a.code || a.waitVm || a.load || a.timeout > 0 || a.lazy !== (def.type !== 'patch'))) {
    const parts: string[] = [];
    if (a.code) parts.push('code: true');
    if (a.waitVm) parts.push('waitVm: true');
    if (a.lazy !== (def.type !== 'patch')) parts.push(`lazy: ${a.lazy}`);
    if (a.timeout > 0) parts.push(`timeout: ${a.timeout}`);
    if (a.load) parts.push(`load: ${q(a.load)}`);
    lines.push(`  async: { ${parts.join(', ')} },`);
  }
  if (Object.keys(def.extra).length > 0) {
    lines.push(`  extra: ${JSON.stringify(def.extra, null, 2)},`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}
