// ===== VaIMod 插件 UI 样式接口 =====
//
// 给插件 code 提供一套与主面板同质感、开箱即用的 UI 组件工厂（ctx.ui）：
//   提示类  toast / tip / badge
//   按钮类  button（primary / ghost / danger）
//   开关类  switch（滑块开关）
//   框选类  check（复选）/ radioGroup（分段单选）/ tabs（标签页切换）/ select（下拉）
//   输入类  input / textarea
//   反馈类  progress（进度条）/ spinner（加载态）/ divider（分隔线）
//   布局类  card / row / field（带标签的表单字段）
//   弹窗类  confirm（面板内确认框）/ modal（自定义内容弹窗）
//
// 自定义样式（双层）：
//   ① 每个工厂 opts 都支持 `class`（追加类名）与 `style`（内联 style 字符串）。
//      内联 style 是唯一能作用到 ShadowRoot 直下浮层（confirm/modal）的样式通道
//      —— def.css 被 #vmp-<id> 作用域限定，够不到浮层。
//   ② def.css（自动限定 #vmp-<id>）可按 .vpu-* 类名覆写挂进 root 的组件。
//
// 设计原则：
//   - 纯 DOM 工厂，不依赖 Svelte；组件类名 .vpu-*（VaIMod Plugin UI），
//     样式统一在 global.css，随面板样式主题（--svp-primary 主色）自动跟随。
//   - 补丁（patch）ctx 也拿到 ui（toast 可用），但 confirm/modal 无面板挂载点：
//     confirm 退回浏览器原生 confirm；modal 直接抛错（headless 不往页面塞东西）。

export type PluginToastKind = 'ok' | 'err' | 'info';

export interface PluginUIOpts {
  /** 面板级 toast 出口（透传到面板 toast 队列） */
  toast(text: string, kind?: PluginToastKind): void;
  /**
   * 弹窗类挂载点（仅扩展 ctx 提供）：返回插件面板所在的 ShadowRoot。
   * 不提供（补丁 headless）时 confirm 退回原生 confirm、modal 抛错。
   */
  getOverlayHost?(): Node;
}

/** 所有 UI 工厂通用：自定义类名与内联样式 */
export interface PluginUIStyleOpts {
  /** 追加到组件根元素的类名（空格分隔多个） */
  class?: string;
  /** 内联 style 字符串（如 'color:#fff; font-size:13px'）——浮层唯一可用的自定义样式通道 */
  style?: string;
}

export interface PluginUIButtonOpts extends PluginUIStyleOpts {
  text: string;
  kind?: 'primary' | 'ghost' | 'danger';
  onclick?: (ev: MouseEvent) => void;
  ariaLabel?: string;
}

export interface PluginUIInputOpts extends PluginUIStyleOpts {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'password';
  /** 每次输入回调 */
  oninput?: (value: string) => void;
  /** 回车确认回调 */
  onenter?: (value: string) => void;
  ariaLabel?: string;
}

export interface PluginUITextareaOpts extends PluginUIStyleOpts {
  value?: string;
  placeholder?: string;
  rows?: number;
  /** 每次输入回调 */
  oninput?: (value: string) => void;
  ariaLabel?: string;
}

export interface PluginUISwitchOpts extends PluginUIStyleOpts {
  checked?: boolean;
  label?: string;
  onchange?: (on: boolean) => void;
  ariaLabel?: string;
}

export interface PluginUICheckOpts extends PluginUIStyleOpts {
  text: string;
  checked?: boolean;
  onchange?: (on: boolean) => void;
  ariaLabel?: string;
}

export interface PluginUISelectOpts extends PluginUIStyleOpts {
  value?: string;
  options: { value: string; label: string }[];
  onchange?: (value: string) => void;
  ariaLabel?: string;
}

export interface PluginUIRadioOpts extends PluginUIStyleOpts {
  value?: string;
  options: { value: string; label: string }[];
  onchange?: (value: string) => void;
  ariaLabel?: string;
}

export interface PluginUITabsOpts extends PluginUIStyleOpts {
  value?: string;
  options: { value: string; label: string }[];
  onchange?: (value: string) => void;
  ariaLabel?: string;
}

export interface PluginUIProgressOpts extends PluginUIStyleOpts {
  /** 当前值（0–max，缺省 max=100） */
  value?: number;
  max?: number;
  tone?: 'primary' | 'ok' | 'warn' | 'err';
  ariaLabel?: string;
}

export interface PluginUICardOpts extends PluginUIStyleOpts {
  title?: string;
  children?: Node[];
}

export interface PluginUIFieldOpts extends PluginUIStyleOpts {
  label: string;
  children?: Node[];
}

export interface PluginUIConfirmOpts extends PluginUIStyleOpts {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  /** 危险操作（确认键红色） */
  danger?: boolean;
}

export interface PluginUIModalOpts extends PluginUIStyleOpts {
  title?: string;
  message?: string;
  /** 弹窗主体内容节点 */
  children?: Node[];
  /** 底部按钮区（一般是 ui.button 产物） */
  actions?: Node[];
  /** 点遮罩是否关闭（默认 true） */
  maskClosable?: boolean;
}

export interface PluginUIModalHandle {
  /** 整个浮层（ShadowRoot 直下） */
  el: HTMLDivElement;
  /** 弹窗主体框（想改宽度/内边距作用在这里） */
  box: HTMLDivElement;
  /** 关闭弹窗（幂等） */
  close(): void;
}

export type PluginUIProgressEl = HTMLDivElement & {
  /** 更新进度（max 缺省沿用创建时的值） */
  update(value: number, max?: number): void;
};

export interface PluginUIApi {
  /** 面板级提示（toast 队列，自动消失） */
  toast(text: string, kind?: PluginToastKind): void;
  /** 内联提示条（放在内容流里，不自动消失） */
  tip(text: string, kind?: 'info' | 'ok' | 'warn' | 'err', custom?: PluginUIStyleOpts): HTMLDivElement;
  /** 徽标（计数/状态小胶囊） */
  badge(
    text: string,
    tone?: 'default' | 'primary' | 'ok' | 'warn' | 'err',
    custom?: PluginUIStyleOpts,
  ): HTMLSpanElement;
  /** 按钮（primary 主色 / ghost 次级 / danger 危险） */
  button(opts: PluginUIButtonOpts): HTMLButtonElement;
  /** 滑块开关 */
  switch(opts: PluginUISwitchOpts): HTMLLabelElement;
  /** 单行输入框 */
  input(opts: PluginUIInputOpts): HTMLInputElement;
  /** 多行输入框 */
  textarea(opts?: PluginUITextareaOpts): HTMLTextAreaElement;
  /** 下拉选择 */
  select(opts: PluginUISelectOpts): HTMLSelectElement;
  /** 复选框 */
  check(opts: PluginUICheckOpts): HTMLLabelElement;
  /** 分段单选（等宽 grid 胶囊组） */
  radioGroup(opts: PluginUIRadioOpts): HTMLDivElement;
  /** 标签页切换（下划线式，与 radioGroup 视觉区分） */
  tabs(opts: PluginUITabsOpts): HTMLDivElement;
  /** 进度条（返回的元素带 update(value, max?) 方法） */
  progress(opts?: PluginUIProgressOpts): PluginUIProgressEl;
  /** 加载态（旋转圈） */
  spinner(custom?: PluginUIStyleOpts): HTMLSpanElement;
  /** 水平分隔线 */
  divider(custom?: PluginUIStyleOpts): HTMLDivElement;
  /** 带标签的表单字段（label 在上、控件在下） */
  field(opts: PluginUIFieldOpts): HTMLDivElement;
  /** 卡片容器（可选标题） */
  card(opts?: PluginUICardOpts): HTMLDivElement;
  /** 水平行（自动 gap，子元素依次排列） */
  row(...children: Node[]): HTMLDivElement;
  /**
   * 面板内确认框（异步；Promise<boolean>）。
   * 扩展 ctx 下挂在面板 ShadowRoot（带遮罩、动画）；补丁 ctx 退回原生 confirm。
   * opts.class / opts.style 作用在整个遮罩层。
   */
  confirm(opts: PluginUIConfirmOpts): Promise<boolean>;
  /**
   * 自定义内容弹窗（挂 ShadowRoot 直下，带遮罩；Esc / 点遮罩可关）。
   * 返回句柄 { el, box, close }；仅扩展 ctx 可用（补丁无挂载点会抛错）。
   */
  modal(opts: PluginUIModalOpts): PluginUIModalHandle;
  /**
   * 关掉本实例创建的全部浮层（未决的 `confirm` 按「取消」落定），并摘掉它们的 keydown 监听。
   *
   * 宿主面板必须在插件 teardown（切页 / 停用 / 卸载 / 改设置重跑）时调用：浮层是挂在面板
   * ShadowRoot **直下**的（`#vmp-<id>` 作用域之外），插件内容被清掉时它们不会跟着消失 ——
   * 残留的全屏遮罩会一直挡住整个面板，且没有任何 UI 能关掉它。
   */
  dispose(): void;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** 应用通用自定义：追加类名 + 内联 style（浮层唯一可用的自定义样式通道） */
function applyCustom<T extends HTMLElement>(el: T, custom?: PluginUIStyleOpts): T {
  if (!custom) return el;
  if (custom.class) el.classList.add(...custom.class.split(/\s+/).filter(Boolean));
  if (custom.style) el.setAttribute('style', custom.style);
  return el;
}

// 弹窗类全局单例（跨插件实例共享）：ShadowRoot 里同时只保留一个确认框，
// 新确认出现时旧确认自动按「取消」落定（防止多层遮罩叠加互相挡点击）
let activeConfirm: { finish(v: boolean): void } | null = null;

export function createPluginUI(opts: PluginUIOpts): PluginUIApi {
  /** 本实例创建、且尚未关闭的浮层（unmount 时统一收掉，防止遮罩残留挡住面板） */
  const liveOverlays = new Set<{ close(): void }>();

  const toast = (text: string, kind: PluginToastKind = 'ok'): void => {
    try {
      opts.toast(text, kind);
    } catch {
      /* ignore */
    }
  };

  function tip(
    text: string,
    kind: 'info' | 'ok' | 'warn' | 'err' = 'info',
    custom?: PluginUIStyleOpts,
  ): HTMLDivElement {
    const n = applyCustom(make('div', `vpu-tip vpu-tip-${kind}`), custom);
    n.textContent = text;
    n.setAttribute('role', 'note');
    return n;
  }

  function badge(
    text: string,
    tone: 'default' | 'primary' | 'ok' | 'warn' | 'err' = 'default',
    custom?: PluginUIStyleOpts,
  ): HTMLSpanElement {
    const n = applyCustom(make('span', `vpu-badge vpu-badge-${tone}`), custom);
    n.textContent = text;
    return n;
  }

  function button(o: PluginUIButtonOpts): HTMLButtonElement {
    const b = applyCustom(
      make('button', o.kind && o.kind !== 'primary' ? `vpu-btn vpu-btn-${o.kind}` : 'vpu-btn'),
      o,
    );
    b.type = 'button';
    b.textContent = o.text;
    if (o.ariaLabel) b.setAttribute('aria-label', o.ariaLabel);
    if (typeof o.onclick === 'function') b.addEventListener('click', o.onclick);
    return b;
  }

  function input(o: PluginUIInputOpts): HTMLInputElement {
    const i = applyCustom(make('input', 'vpu-input'), o);
    i.type = o.type ?? 'text';
    if (o.value !== undefined) i.value = String(o.value);
    if (o.placeholder) i.placeholder = o.placeholder;
    if (o.ariaLabel) i.setAttribute('aria-label', o.ariaLabel);
    if (typeof o.oninput === 'function') i.addEventListener('input', () => o.oninput!(i.value));
    if (typeof o.onenter === 'function') {
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') o.onenter!(i.value);
      });
    }
    return i;
  }

  function textarea(o: PluginUITextareaOpts = {}): HTMLTextAreaElement {
    const t = applyCustom(make('textarea', 'vpu-input vpu-textarea'), o);
    if (o.value !== undefined) t.value = String(o.value);
    if (o.placeholder) t.placeholder = o.placeholder;
    t.rows = o.rows ?? 3;
    if (o.ariaLabel) t.setAttribute('aria-label', o.ariaLabel);
    if (typeof o.oninput === 'function') t.addEventListener('input', () => o.oninput!(t.value));
    return t;
  }

  function switchCmp(o: PluginUISwitchOpts): HTMLLabelElement {
    const l = applyCustom(make('label', 'vpu-switch'), o);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'vpu-switch-native';
    cb.checked = o.checked !== false;
    if (o.ariaLabel) cb.setAttribute('aria-label', o.ariaLabel);
    const track = make('span', 'vpu-switch-track');
    const dot = make('span', 'vpu-switch-dot');
    track.append(dot);
    l.append(cb, track);
    if (o.label) {
      const t = make('span', 'vpu-switch-label');
      t.textContent = o.label;
      l.append(t);
    }
    cb.addEventListener('change', () => {
      if (typeof o.onchange === 'function') o.onchange(cb.checked);
    });
    return l;
  }

  function check(o: PluginUICheckOpts): HTMLLabelElement {
    const l = applyCustom(make('label', 'vpu-check'), o);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'vpu-check-native';
    // 复选框默认**未勾选**（HTML 语义）。开关（switch）才默认开——那是「功能默认启用」
    // 的语义。两者混用同一个 `checked !== false` 会让 `ui.check({text:'确认删除'})`
    // 一渲染就是勾选态，作者按「默认未选」写的逻辑与界面相反。
    cb.checked = o.checked === true;
    if (o.ariaLabel) cb.setAttribute('aria-label', o.ariaLabel);
    const box = make('span', 'vpu-check-box');
    const mark = make('span', 'vpu-check-mark');
    box.append(mark);
    const t = make('span', 'vpu-check-text');
    t.textContent = o.text;
    l.append(cb, box, t);
    cb.addEventListener('change', () => {
      if (typeof o.onchange === 'function') o.onchange(cb.checked);
    });
    return l;
  }

  function select(o: PluginUISelectOpts): HTMLSelectElement {
    const s = applyCustom(make('select', 'vpu-select'), o);
    if (o.ariaLabel) s.setAttribute('aria-label', o.ariaLabel);
    for (const op of o.options ?? []) {
      const opt = document.createElement('option');
      opt.value = op.value;
      opt.label = op.label;
      opt.textContent = op.label;
      s.append(opt);
    }
    if (o.value !== undefined) s.value = o.value;
    if (typeof o.onchange === 'function') s.addEventListener('change', () => o.onchange!(s.value));
    return s;
  }

  function radioGroup(o: PluginUIRadioOpts): HTMLDivElement {
    const g = applyCustom(make('div', 'vpu-seg'), o);
    if (o.ariaLabel) g.setAttribute('aria-label', o.ariaLabel);
    g.setAttribute('role', 'radiogroup');
    let cur = o.value ?? (o.options?.[0]?.value ?? '');
    const sync = (): void => {
      for (const b of Array.from(g.children) as HTMLButtonElement[]) {
        const on = b.dataset.value === cur;
        b.classList.toggle('vpu-seg-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    for (const op of o.options ?? []) {
      const b = make('button', 'vpu-seg-item');
      b.type = 'button';
      b.dataset.value = op.value;
      b.textContent = op.label;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (cur === op.value) return;
        cur = op.value;
        sync();
        if (typeof o.onchange === 'function') o.onchange(cur);
      });
      g.append(b);
    }
    sync();
    return g;
  }

  function tabs(o: PluginUITabsOpts): HTMLDivElement {
    const g = applyCustom(make('div', 'vpu-tabs'), o);
    if (o.ariaLabel) g.setAttribute('aria-label', o.ariaLabel);
    g.setAttribute('role', 'tablist');
    let cur = o.value ?? (o.options?.[0]?.value ?? '');
    const sync = (): void => {
      for (const b of Array.from(g.children) as HTMLButtonElement[]) {
        const on = b.dataset.value === cur;
        b.classList.toggle('vpu-tab-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    };
    for (const op of o.options ?? []) {
      const b = make('button', 'vpu-tab');
      b.type = 'button';
      b.dataset.value = op.value;
      b.textContent = op.label;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => {
        if (cur === op.value) return;
        cur = op.value;
        sync();
        if (typeof o.onchange === 'function') o.onchange(cur);
      });
      g.append(b);
    }
    sync();
    return g;
  }

  function progress(o: PluginUIProgressOpts = {}): PluginUIProgressEl {
    const max0 = o.max && o.max > 0 ? o.max : 100;
    const p = applyCustom(make('div', 'vpu-progress'), o);
    if (o.ariaLabel) p.setAttribute('aria-label', o.ariaLabel);
    p.setAttribute('role', 'progressbar');
    p.setAttribute('aria-valuemin', '0');
    p.setAttribute('aria-valuemax', String(max0));
    const fill = make('div', `vpu-progress-fill${o.tone && o.tone !== 'primary' ? ` vpu-progress-${o.tone}` : ''}`);
    p.append(fill);
    const update = (value: number, max?: number): void => {
      const m = max && max > 0 ? max : max0;
      const pct = Math.max(0, Math.min(100, (value / m) * 100));
      fill.style.width = pct.toFixed(2) + '%';
      p.setAttribute('aria-valuemax', String(m));
      p.setAttribute('aria-valuenow', String(value));
      p.dataset.value = String(value);
      p.dataset.max = String(m);
    };
    update(o.value ?? 0);
    const el = p as PluginUIProgressEl;
    el.update = update;
    return el;
  }

  function spinner(custom?: PluginUIStyleOpts): HTMLSpanElement {
    return applyCustom(make('span', 'vpu-spinner'), custom);
  }

  function divider(custom?: PluginUIStyleOpts): HTMLDivElement {
    return applyCustom(make('div', 'vpu-divider'), custom);
  }

  function field(o: PluginUIFieldOpts): HTMLDivElement {
    const f = applyCustom(make('div', 'vpu-field'), o);
    const t = make('div', 'vpu-field-label');
    t.textContent = o.label;
    f.append(t);
    if (o.children) for (const n of o.children) f.append(n);
    return f;
  }

  function card(o?: PluginUICardOpts): HTMLDivElement {
    const c = applyCustom(make('div', 'vpu-card'), o);
    if (o?.title) {
      const t = make('div', 'vpu-card-title');
      t.textContent = o.title;
      c.append(t);
    }
    if (o?.children) for (const n of o.children) c.append(n);
    return c;
  }

  function row(...children: Node[]): HTMLDivElement {
    const r = make('div', 'vpu-row');
    for (const n of children) r.append(n);
    return r;
  }

  function confirm(o: PluginUIConfirmOpts): Promise<boolean> {
    // 无面板挂载点（补丁 headless）→ 浏览器原生 confirm
    if (!opts.getOverlayHost) {
      let r = false;
      try {
        r = window.confirm(o.message);
      } catch {
        r = false;
      }
      return Promise.resolve(r);
    }

    if (activeConfirm) activeConfirm.finish(false);

    return new Promise<boolean>((resolve) => {
      let done = false;
      const host = opts.getOverlayHost!();
      // 登记到本实例的浮层集合（dispose 会按「取消」落定它）。
      // token 声明在 finish 之前，避免 finish 里引用它时踩 TDZ。
      const token = { close: (): void => {} };
      liveOverlays.add(token);
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        liveOverlays.delete(token);
        if (activeConfirm === entry) activeConfirm = null;
        try {
          overlay.remove();
        } catch {
          /* ignore */
        }
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const entry = { finish };
      activeConfirm = entry;
      token.close = () => finish(false);
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') finish(false);
        else if (e.key === 'Enter') finish(true);
      };

      const overlay = applyCustom(make('div', 'vpu-confirm'), o);
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const box = make('div', 'vpu-confirm-box');
      if (o.title) {
        const t = make('div', 'vpu-confirm-title');
        t.textContent = o.title;
        box.append(t);
      }
      const msg = make('div', 'vpu-confirm-msg');
      msg.textContent = o.message;
      box.append(msg);

      const btns = make('div', 'vpu-confirm-btns');
      const cancel = make('button', 'vpu-btn vpu-btn-ghost');
      cancel.type = 'button';
      cancel.textContent = o.cancelText || '取消';
      cancel.addEventListener('click', () => finish(false));
      const ok = make('button', o.danger ? 'vpu-btn vpu-btn-danger vpu-confirm-ok' : 'vpu-btn vpu-confirm-ok');
      ok.type = 'button';
      ok.textContent = o.okText || '确定';
      ok.addEventListener('click', () => finish(true));
      btns.append(cancel, ok);
      box.append(btns);
      overlay.append(box);

      // 点遮罩 = 取消
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) finish(false);
      });
      document.addEventListener('keydown', onKey, true);

      try {
        (host as { appendChild(n: Node): void }).appendChild(overlay);
        ok.focus();
      } catch {
        document.removeEventListener('keydown', onKey, true);
        resolve(window.confirm(o.message));
      }
    });
  }

  function modal(o: PluginUIModalOpts): PluginUIModalHandle {
    if (!opts.getOverlayHost) {
      throw new Error('modal 需要面板挂载点（仅扩展插件可用，补丁 headless 环境无 UI）');
    }

    const host = opts.getOverlayHost();
    const overlay = applyCustom(make('div', 'vpu-confirm vpu-modal'), o);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const box = make('div', 'vpu-confirm-box vpu-modal-box');

    let closed = false;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') h.close();
    };

    const h: PluginUIModalHandle = {
      el: overlay,
      box,
      close(): void {
        if (closed) return;
        closed = true;
        liveOverlays.delete(h);
        try {
          overlay.remove();
        } catch {
          /* ignore */
        }
        document.removeEventListener('keydown', onKey, true);
      },
    };
    liveOverlays.add(h);

    if (o.title) {
      const t = make('div', 'vpu-confirm-title');
      t.textContent = o.title;
      box.append(t);
    }
    if (o.message) {
      const m = make('div', 'vpu-confirm-msg');
      m.textContent = o.message;
      box.append(m);
    }
    const body = make('div', 'vpu-modal-body');
    if (o.children) for (const n of o.children) body.append(n);
    box.append(body);

    if (o.actions?.length) {
      const btns = make('div', 'vpu-confirm-btns');
      for (const n of o.actions) btns.append(n);
      box.append(btns);
    }

    overlay.append(box);
    if (o.maskClosable !== false) {
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) h.close();
      });
    }
    document.addEventListener('keydown', onKey, true);

    try {
      (host as { appendChild(n: Node): void }).appendChild(overlay);
    } catch {
      h.close();
      throw new Error('modal 挂载失败：面板宿主不可用');
    }
    return h;
  }

  function dispose(): void {
    // 遍历副本：close 会就地把自己从集合里删掉
    for (const ov of [...liveOverlays]) {
      try {
        ov.close();
      } catch {
        /* ignore */
      }
    }
    liveOverlays.clear();
  }

  return {
    toast,
    tip,
    badge,
    button,
    switch: switchCmp,
    input,
    textarea,
    select,
    check,
    radioGroup,
    tabs,
    progress,
    spinner,
    divider,
    field,
    card,
    row,
    confirm,
    modal,
    dispose,
  };
}
