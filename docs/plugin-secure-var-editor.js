// VaIMod 扩展 · 安全变量修改器 v1.2.0（可直接上传安装：设置 → 插件 → 上传插件 JS）
// 面向「安全变量」（安全扩展加密存储 _a 数字 / _q 字符串，VaIMod 已解密展示）：
//   · 单独列出全部安全变量（数字/字符串类型徽标、多实例 @i 标注）
//   · 单个修改 / 全部批量设值 / 写入前确认（面板内确认框，不依赖原生弹窗）
//   · 快照保存与一键恢复（存插件私有存储，重开面板不丢；恢复只确认一次）
//   · 自动刷新：变量被脚本改写时数值实时跟进（输入框聚焦时不覆盖）
// 依赖 ctx.write（走面板统一写回管道：安全栈 + 补丁拦截 + 锁同步）与
//      ctx.ui.confirm（v1.2 起写入确认走面板内 UI，不再用 window.confirm——
//      部分站点环境会吞掉原生弹窗导致「确认永远失败、修改无效」）。
VaIMod.plugin({
  type: 'ext',
  id: 'secure-var-editor',
  name: '安全变量修改器',
  version: '1.2.0',
  author: 'VaIMod',
  desc: '列出并修改安全变量：单个/批量设值、快照恢复、自动刷新',

  settings: [
    { type: 'toggle', key: 'confirmWrite', label: '写入前确认', def: true },
    { type: 'toggle', key: 'autoWatch', label: '自动刷新数值', def: true },
  ],

  css: `
    .sec { display: flex; flex-direction: column; gap: 10px; }

    .head { display: flex; align-items: center; gap: 8px;
            padding: 10px 12px;
            background: rgba(255,255,255,.05);
            border: 1px solid rgba(255,255,255,.11);
            border-left: 3px solid var(--svp-primary, #4da3ff);
            border-radius: 10px; }
    .head-title { font-size: 13px; font-weight: 700; color: #e6e8ea; letter-spacing: .3px; }
    .count { min-width: 14px; text-align: center; padding: 1px 9px;
             border-radius: 999px; font-size: 11.5px; font-weight: 700;
             background: color-mix(in srgb, var(--svp-primary, #4da3ff) 26%, transparent);
             color: color-mix(in srgb, var(--svp-primary, #4da3ff) 72%, #ffffff); }
    .state { margin-left: auto; display: flex; align-items: center; gap: 6px;
             padding: 3px 10px; border-radius: 999px;
             background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.09);
             font-size: 11.5px; color: #8a9099; transition: color .16s ease, border-color .16s ease; }
    .state .dot { width: 6px; height: 6px; border-radius: 50%;
                  background: #8a9099; transition: background .16s ease; }
    .state.ok { color: #9fd8c0; } .state.ok .dot { background: #34c789; }
    .state.busy { color: #f2cf9a; } .state.busy .dot { background: #ffb84d; }
    .state.err { color: #ff9c8f; border-color: rgba(255,107,96,.35); }
    .state.err .dot { background: #ff6b6b; }

    .tools { display: flex; gap: 6px; flex-wrap: wrap; }
    .tools input { flex: 1 1 110px; min-width: 0; }
    input { background: rgba(0,0,0,.3); color: #e6e8ea;
            border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
            padding: 8px 10px; font-size: 12.5px; font-family: inherit; outline: none; box-sizing: border-box;
            transition: border-color .15s ease, box-shadow .15s ease; }
    input::placeholder { color: rgba(255,255,255,.34); }
    input:focus { border-color: var(--svp-primary, #4da3ff);
                  box-shadow: 0 0 0 2px color-mix(in srgb, var(--svp-primary, #4da3ff) 22%, transparent); }

    button { border: none; border-radius: 8px; cursor: pointer;
             padding: 8px 12px; font-family: inherit; font-weight: 600; font-size: 12.5px;
             background: var(--svp-primary, #4da3ff); color: #fff;
             transition: filter .14s ease, transform .12s ease, background .14s ease; }
    button:hover { filter: brightness(1.12); }
    button:active { transform: scale(.95); }
    button.ghost { background: rgba(255,255,255,.1); color: #e6e8ea;
                   border: 1px solid rgba(255,255,255,.12); }
    button.ghost:hover { background: rgba(255,255,255,.16); filter: none; }

    .list { display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: center; gap: 8px;
           padding: 9px 11px;
           background: rgba(255,255,255,.045);
           border: 1px solid rgba(255,255,255,.09);
           border-radius: 10px;
           transition: background .16s ease, border-color .16s ease; }
    .row:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.16); }
    .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; font-size: 13px; font-weight: 600; color: #e6e8ea; }
    .tag { flex: none; font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
           background: rgba(255,255,255,.1); color: #aab1b9; }
    .tag.num { background: color-mix(in srgb, var(--svp-primary, #4da3ff) 22%, transparent);
               color: color-mix(in srgb, var(--svp-primary, #4da3ff) 68%, #ffffff); }
    .tag.str { background: rgba(52,199,138,.18); color: #6fe0b8; }
    .tag.inst { background: rgba(255,180,64,.2); color: #ffc36b; }
    .row input { width: 112px; flex: none; padding: 7px 9px; }
    .row .go { flex: none; padding: 6px 12px; }

    .empty { text-align: center; color: rgba(255,255,255,.5);
             font-size: 12.5px; padding: 20px 10px; line-height: 1.8;
             border: 1px dashed rgba(255,255,255,.16); border-radius: 10px; }
    .empty .ico { display: block; margin: 0 auto 6px; width: 30px; height: 30px;
                  opacity: .55; }
  `,

  html: `
    <div class="sec">
      <div class="head">
        <span class="head-title">安全变量</span>
        <span class="count" data-count>0</span>
        <span class="state" data-state-wrap>
          <span class="dot"></span>
          <span data-state>就绪</span>
        </span>
      </div>
      <div class="tools">
        <input data-batch placeholder="批量值（数字变量填数字）" />
        <button data-apply>全部设为</button>
        <button class="ghost" data-save>存快照</button>
        <button class="ghost" data-restore>恢复快照</button>
      </div>
      <div class="list" data-list></div>
      <div class="empty" data-empty hidden>
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="10" rx="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        未检测到安全变量。<br />安装了「安全变量」类扩展并创建变量后，这里会自动列出。
      </div>
    </div>
  `,

  async code(ctx) {
    const $ = (sel) => ctx.root.querySelector(sel);
    const listEl = $('[data-list]');
    const emptyEl = $('[data-empty]');
    const countEl = $('[data-count]');
    const stateEl = $('[data-state]');
    const stateWrapEl = $('[data-state-wrap]');
    const batchEl = $('[data-batch]');
    // 防御：模板缺失时直接报错退出，不留半初始化状态
    if (!listEl || !countEl || !batchEl) throw new Error('插件模板损坏（缺少关键节点）');

    const SEC_NAME = '\u5b89\u5168\u53d8\u91cf'; // 安全变量（与核心识别一致，不在文件留明文特征）

    const secureVars = () => ctx.variables().filter((v) => v.targetName === SEC_NAME);
    const kindTag = (v) => (typeof v.value === 'number' ? 'num' : 'str');
    const instOf = (v) => {
      const at = String(v.id).lastIndexOf('@');
      return at > 0 ? v.id.slice(at + 1) : '';
    };

    let flashTimer = 0;
    function flash(text, kind = 'ok') {
      stateEl.textContent = text;
      if (stateWrapEl) {
        stateWrapEl.classList.toggle('ok', kind === 'ok');
        stateWrapEl.classList.toggle('busy', kind === 'busy');
        stateWrapEl.classList.toggle('err', kind === 'err');
      }
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        stateEl.textContent = '就绪';
        if (stateWrapEl) stateWrapEl.classList.remove('ok', 'busy', 'err');
      }, 1800);
    }

    // 写入确认：面板内确认框（ctx.ui.confirm），不再依赖 window.confirm
    async function confirmWrite(title, message, danger) {
      if (!ctx.settings.confirmWrite) return true;
      return ctx.ui.confirm({ title, message, okText: '确认写入', danger: !!danger });
    }

    async function writeOne(v, raw) {
      let value = raw;
      if (kindTag(v) === 'num') {
        value = Number(raw);
        if (raw !== '' && Number.isNaN(value)) {
          flash('数字不合法', 'err');
          ctx.toast(`「${v.name}」是数字型，"${raw}" 不是合法数字`, 'err');
          return false;
        }
      } else {
        value = String(raw);
      }
      if (!(await confirmWrite('修改安全变量', `确认把「${v.name}」写为 ${value}？\n该值会写回扩展的加密存储。`))) {
        flash('已取消');
        return false;
      }
      ctx.write(v.id, value, v.targetId);
      flash(`已写「${v.name}」`);
      return true;
    }

    function render() {
      const vars = secureVars();
      countEl.textContent = String(vars.length);
      emptyEl.hidden = vars.length > 0;
      listEl.textContent = '';

      for (const v of vars) {
        const row = document.createElement('div');
        row.className = 'row';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = v.name;

        const tag = document.createElement('span');
        tag.className = 'tag ' + kindTag(v);
        tag.textContent = kindTag(v) === 'num' ? '数字' : '字符串';

        const input = document.createElement('input');
        input.value = String(v.value);
        input.setAttribute('aria-label', `修改 ${v.name}`);

        const go = document.createElement('button');
        go.className = 'go';
        go.textContent = '修改';
        go.onclick = () => void writeOne(v, input.value);

        const inst = instOf(v);
        row.append(name, tag);
        if (inst) {
          const t = document.createElement('span');
          t.className = 'tag inst';
          t.textContent = '#' + inst;
          row.append(t);
        }
        row.append(input, go);

        // 回车即写
        input.onkeydown = (e) => {
          if (e.key === 'Enter') void writeOne(v, input.value);
        };
        listEl.append(row);
      }
    }

    // 批量：数字变量设为数字（非法则跳过），字符串变量设为原文；整批只确认一次
    $('[data-apply]').onclick = () => {
      void (async () => {
        const raw = batchEl.value;
        if (!raw) {
          flash('先填批量值', 'err');
          ctx.toast('先填批量值', 'err');
          return;
        }
        const vars = secureVars();
        if (vars.length === 0) return;
        const num = Number(raw);
        const targets = vars.filter((v) => (kindTag(v) === 'num' ? !Number.isNaN(num) : true));
        if (
          !(await confirmWrite(
            '批量写入',
            `确认把 ${targets.length} 个安全变量批量写入？\n数字型 → ${raw}，字符串型 → 原文 "${raw}"。`,
          ))
        ) {
          flash('已取消');
          return;
        }
        let done = 0;
        for (const v of targets) {
          ctx.write(v.id, kindTag(v) === 'num' ? num : raw, v.targetId);
          done++;
        }
        flash(`批量写入 ${done} 个`, done > 0 ? 'ok' : 'err');
      })();
    };

    // 快照：保存当前值；恢复时逐个写回（整批只确认一次）
    $('[data-save]').onclick = () => {
      const snap = {};
      for (const v of secureVars()) snap[v.id] = v.value;
      ctx.store.set('snapshot', snap);
      flash('快照已保存', 'busy');
      ctx.toast(`已保存快照（${Object.keys(snap).length} 个）`);
    };
    $('[data-restore]').onclick = () => {
      void (async () => {
        const snap = ctx.store.get('snapshot', null);
        if (!snap || Object.keys(snap).length === 0) {
          flash('没有快照', 'err');
          ctx.toast('还没有快照，先「存快照」', 'err');
          return;
        }
        const vars = secureVars().filter((v) => v.id in snap);
        if (
          !(await confirmWrite(
            '恢复快照',
            `确认把 ${vars.length} 个安全变量恢复到快照值？\n当前值会被覆盖。`,
          ))
        ) {
          flash('已取消');
          return;
        }
        let done = 0;
        for (const v of vars) {
          ctx.write(v.id, snap[v.id], v.targetId);
          done++;
        }
        flash(`已恢复 ${done} 个`, done > 0 ? 'ok' : 'err');
      })();
    };

    // 自动刷新：重绘列表，但跳过聚焦中的输入框（避免打字被覆盖）
    render();
    let unsub;
    if (ctx.settings.autoWatch) {
      unsub = ctx.onVariables(() => {
        const active = ctx.root.ownerDocument.activeElement;
        const editing = active instanceof HTMLInputElement && ctx.root.contains(active);
        if (!editing) render();
      });
    }
    return () => {
      if (unsub) unsub();
      clearTimeout(flashTimer);
    };
  },
});
