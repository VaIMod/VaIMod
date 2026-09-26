// VaIMod 插件 · 外挂元素护盾
// ============================================================================
// 把 VaIMod 自己享受的防护**延伸到页面上其它外挂注入的元素**（其它用户脚本 /
// 扩展挂在 light DOM 上的面板、悬浮层、iframe 等），一键武装，含 CSense 拦截器
// 反制。
//
// 背景：VaIMod 本体全部 UI 住在 closed shadow 里，DOM 扫描看不见；但其它外挂
// 的元素裸露在 light DOM 上，会被「CSense 拦截器」v0.1.5a3 的启发式扫描认出：
//   `html>div[style*="rgb"] *`、`body>div:empty[style*="inset"]`、shadow-root、
//   iframe contentWindow → 上报 supabase / 跳转 csdetected / 盖 .csense-window 遮罩。
// 本体 csense-guard 已在 document-start 装好网络/跳转/遮罩三层咽喉（护的是全页，
// 这部分本插件再兜一层底，避免老本体没有它）；本插件补的是本体没做的两块：
//
//   ① 样式洗白（对扫描面的「同等隐身」）：
//      把受保护元素 inline style 里的 `rgb()/rgba()` 全量改写成等值 hex、
//      `box-shadow: inset …` 的 inset 关键字挪到该层阴影末尾（CSS 语义不变、
//      渲染结果逐像素一致），让上面两条**按 style 属性文本匹配**的扫描选择器
//      永远命中不了。洗白后挂 attributeFilter:['style'] 观察器——外挂自己改
//      style 就地重洗，且「算出来没变就绝不适配」保证观察器链路收敛不自杀。
//      ⛔ 刻意**不 hook** querySelector/matches/closest：那会把外挂自己的查询
//      也一起滤掉，等于把人家的 UI 搞坏——洗白只动「扫描器看的特征」，不碰
//      「外挂自己跑的逻辑」。
//
//   ② 防删保活（可选，默认关）：
//      观察受保护元素的父节点，元素被外力移除时按记录的原位（nextSibling）
//      放回。外挂自己销毁 UI 会被放回成僵尸，所以默认关；15 秒内被放回 5 次
//      仍被删的元素自动放弃（对抗删除死循环）。
//
//   ③ CSense 反制兜底：网络咽喉（fetch/XHR/sendBeacon 命中 CSense 专属端点
//      → 本地合成假成功）+ 跳转三层（Navigation API / Location.prototype.
//      assign/replace / window.open 假窗桩）+ 遮罩即时清除（遮罩类名是先
//      插入后赋——childList+class 属性双盯才不漏检）。
//      与本体 csense-guard 叠装无害（双方都是只拦黑名单 URL 的透传过滤器，
//      谁先命中谁吃掉）；卸载时**比对再还原**（last-writer-wins 防护）。
//
//   ④ DOM 惩罚反制：CSense 的惩罚经 iframe.contentWindow 伸进顶层文档
//      （移除节点 / innerHTML 覆写 / display:none 整页隐藏）。武装期：
//      body/html/挂载根的 inline display:none 当场回滚；含 csense 指纹的
//      innerHTML/outerHTML 覆写拒绝；body.removeChild 拒删 SPA 挂载根；
//      body 顶层快照兜底恢复。洗白反噬三振停战（对方立刻回写 rgb 就别互写）。
//
// 安全底线（对齐 net-firewall 的设计约束）：
//   1. 导入后默认「未武装」——零钩子、零观察器、零开销；一键武装才动手。
//   2. 所有包装过的原生方法一律过 `ctx.net.markNative`，toString 白名单兜住。
//   3. 洗白只改 inline style 文本、语义等值；拒绝任何「猜测外挂意图」的改写。
//   4. 扫描识别不出站点的元素绝不动：站点本体元素默认不保护、可手动勾选。
//   5. 引擎单例（window Symbol 键）+ 引用计数 + 600ms 实例交接宽限，
//      对齐 net-firewall——切标签页一卸一装绝不能互相拆钩子。
// ============================================================================

VaIMod.plugin({
  type: 'ext',
  id: 'foreign-shield',
  name: '外挂元素护盾',
  version: '1.0.0',
  author: 'VaIMod',
  desc: '一键为页面上其它外挂注入的元素做同等保护：样式洗白躲扫描、防删保活、CSense 拦截器反制',
  // 常驻：不打开标签页也在工作（武装态必须在元素被注入的瞬间就接住）。
  async: { lazy: false },
  market: {
    category: '安全',
    tags: ['防护', '反制', 'CSense', '隐身'],
    icon: '🧿',
    license: 'MIT',
  },

  css: `
    .fs-wrap { display: flex; flex-direction: column; gap: 12px; }
    .fs-stat { font-size: 12px; color: #8a9099; line-height: 1.6; }
    .fs-list { display: flex; flex-direction: column; gap: 6px; }
    .fs-item { display: flex; align-items: center; gap: 8px;
               padding: 6px 9px; border-radius: 8px;
               background: rgba(255, 255, 255, .05); }
    .fs-item-site { opacity: .55; }
    .fs-desc { flex: 1; min-width: 0; font-family: Consolas, "Courier New", monospace;
               font-size: 12px; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; }
    .fs-empty { font-size: 12px; color: #8a9099; }
    .fs-note { font-size: 11.5px; color: #ffd08a; line-height: 1.6; }
    .fs-sig { font-family: Consolas, "Courier New", monospace; font-size: 11px;
              color: #ff9d9d; word-break: break-all; user-select: text;
              -webkit-user-select: text; }
    .fs-msgbox { padding: 6px 10px; border-radius: 7px; font-size: 12.5px;
                 line-height: 1.45; word-break: break-word;
                 background: rgba(48, 209, 88, .12); color: #7ee2a0;
                 border: 1px solid rgba(48, 209, 88, .28); }
    .fs-msgbox-err { background: rgba(255, 90, 90, .12); color: #ff9d9d;
                     border-color: rgba(255, 90, 90, .3); }
  `,

  code(ctx) {
    // ------------------------------------------------------------------
    // 兼容兜底：老版本本体没有 ctx.net 时降级（markNative 至少把名字伪装好）
    // ------------------------------------------------------------------
    const net = ctx.net || {};
    const markNative =
      typeof net.markNative === 'function'
        ? net.markNative
        : (fn, name) => {
            try {
              Object.defineProperty(fn, 'name', { value: name, configurable: true });
            } catch (e) {
              /* ignore */
            }
          };

    const ui = ctx.ui;
    const KEY = { mode: 'mode', keep: 'keepAlive' };

    /**
     * 实例交接宽限期（ms）——与 net-firewall 同一套理由：lazy:false 的插件
     * 常驻 headless 实例与标签页实例切页一卸一装，宿主异步挂载有几十毫秒空档，
     * refs 归零绝不能同步销毁引擎。
     */
    const HANDOFF_GRACE_MS = 600;

    // ==================================================================
    // CSense 专属端点（与本体 csense-guard 同一口径，刻意窄口径）
    // ==================================================================
    const REPORT_RE = /https?:\/\/dcynsppfvlkdtbaleefw\.supabase\.co\/rest\/v1\/csense_detections/i;
    const REDIRECT_RE = /https?:\/\/d\.chen-jin\.dpdns\.org\/csdetected/i;
    const LS_KEYS = ['__csense-plugins', 'csbv', 'csb3u'];
    const LS_PREFIX_RE = /^ext_csb/;
    const COOKIE_RE = /(?:^|;\s*)(?:csbv|csb3u|__csense[^=]*)=/;

    const isCsenseUrl = (raw) => {
      try {
        return REPORT_RE.test(String(raw)) || REDIRECT_RE.test(String(raw));
      } catch (e) {
        return false;
      }
    };

    // ==================================================================
    // 引擎（单例，挂在 window 的 Symbol 键上）
    // ==================================================================
    const GKEY = Symbol.for('vaimod.foreign-shield');

    function slot() {
      let s = window[GKEY];
      if (!s) {
        s = { refs: 0, engine: null, pending: 0 };
        try {
          Object.defineProperty(window, GKEY, { value: s, enumerable: false, configurable: true });
        } catch (e) {
          window[GKEY] = s;
        }
      }
      return s;
    }

    function createEngine() {
      // ---------- 状态 ----------
      let armed = ctx.store.get(KEY.mode, 'off') === 'armed';
      let keepAlive = ctx.store.get(KEY.keep, false) === true;

      const hits = { launder: 0, rescue: 0, auto: 0, fetch: 0, xhr: 0, beacon: 0, nav: 0, overlay: 0, display: 0, wipe: 0, restore: 0 };
      let lastHit = null;
      let csenseSignals = [];
      let lastScanAt = 0;

      const noteHit = (k) => {
        hits[k] += 1;
        lastHit = Date.now();
      };

      const listeners = [];
      let emitTimer = null;
      const emitSoon = () => {
        if (emitTimer !== null || listeners.length === 0) return;
        emitTimer = setTimeout(() => {
          emitTimer = null;
          for (let i = 0; i < listeners.length; i++) {
            try {
              listeners[i]();
            } catch (e) {
              /* ignore */
            }
          }
        }, 80);
      };

      // ---------- ① 样式洗白 ----------
      /** 引号/括号感知的顶层切分（inline style 不该有嵌套陷阱，但求稳） */
      const splitTop = (s, sep) => {
        const out = [];
        let depth = 0;
        let q = null;
        let cur = '';
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (q) {
            cur += ch;
            if (ch === q && s[i - 1] !== '\\') q = null;
            continue;
          }
          if (ch === '"' || ch === "'") {
            q = ch;
            cur += ch;
            continue;
          }
          if (ch === '(') depth++;
          else if (ch === ')') depth = Math.max(0, depth - 1);
          if (ch === sep && depth === 0) {
            out.push(cur);
            cur = '';
            continue;
          }
          cur += ch;
        }
        if (cur !== '' || out.length) out.push(cur);
        return out;
      };

      const hex2 = (n) => {
        const s = n.toString(16);
        return s.length < 2 ? '0' + s : s;
      };
      const byte = (raw) => {
        let n = parseInt(raw, 10);
        if (isNaN(n)) n = 0;
        return Math.max(0, Math.min(255, n));
      };

      /** rgb()/rgba() → #hex（含可选 alpha，8 位 hex），语义逐值等价 */
      const launderValue = (val) =>
        val.replace(
          /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi,
          (m, r, g, b, a) => {
            let s = '#' + hex2(byte(r)) + hex2(byte(g)) + hex2(byte(b));
            if (a !== undefined) {
              const af = /%$/.test(a) ? Math.round((parseFloat(a) / 100) * 255) : Math.round(parseFloat(a) * 255);
              s += hex2(Math.max(0, Math.min(255, af)));
            }
            return s;
          },
        );

      /**
       * 洗白一整段 inline style 文本。返回 null = 无需改动（绝不写回，
       * 否则自己的写回会再触发自己的观察器 → 死循环）。
       * 判定口径：逐声明重组后与原文比对——语义没变（只是空格差异）的声明
       * 原样保留，绝不为「美观」触发改写。
       */
      const launderStyleText = (text) => {
        if (!text) return null;
        // 快路径：既没有 rgb 也没有 inset（inset 只可能出现在 box-shadow 里）
        if (text.indexOf('rgb') < 0 && text.indexOf('inset') < 0) return null;
        const parts = splitTop(text, ';');
        const out = [];
        let changed = false;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (!p.trim()) {
            out.push(p);
            continue;
          }
          const ci = p.indexOf(':');
          if (ci < 0) {
            out.push(p);
            continue;
          }
          const propRaw = p.slice(0, ci);
          const prop = propRaw.trim();
          let val = launderValue(p.slice(ci + 1));
          // inset 只在 box-shadow 里合法地挪位置（CSS 允许关键字在首或尾，
          // 语义相同）——扫描选择器按 style*="inset" 匹配属性文本
          if (/^box-shadow$/i.test(prop) && /(^|\s)inset(\s|$)/i.test(val)) {
            const shadows = splitTop(val, ',');
            const fixed = [];
            for (let j = 0; j < shadows.length; j++) {
              let sh = shadows[j];
              if (/(^|\s)inset(\s|$)/i.test(sh)) {
                sh = sh.replace(/(^|\s)inset(\s|$)/gi, '$1').replace(/\s{2,}/g, ' ').trim();
                if (sh) sh = sh + ' inset';
              }
              fixed.push(sh.trim());
            }
            // 保留值的前导空格：重组结果必须能和原文逐字比对，语义没变
            // 就原样保留（绝不为「美观」触发改写 → 观察器链路零空转）
            const lead = (/^\s*/.exec(val) || [''])[0];
            val = lead + fixed.join(', ');
          }
          const decl = propRaw + ':' + val;
          if (decl !== p) changed = true;
          out.push(decl !== p ? decl : p);
        }
        if (!changed) return null;
        return out.join(';');
      };

      const styleAttr = (el) => {
        try {
          return el.getAttribute('style') || '';
        } catch (e) {
          return '';
        }
      };

      /** 对单个元素就地洗白（rgb→hex、box-shadow inset 挪尾，语义逐值等价） */
      const launderEl = (el) => {
        try {
          const orig = styleAttr(el);
          if (!orig) return;
          const next = launderStyleText(orig);
          if (next !== null && next !== orig) {
            el.setAttribute('style', next);
            noteHit('launder');
          }
        } catch (e) {
          /* ignore */
        }
      };

      // ---------- 受保护元素登记 ----------
      const guarded = new Map(); // id -> rec
      const guardedSet = new WeakSet();
      let idSeq = 1;

      const RESCUE_WINDOW_MS = 15000;
      const RESCUE_MAX = 5;

      const unguardRec = (rec) => {
        if (rec.styleMo) {
          try {
            rec.styleMo.disconnect();
          } catch (e) {
            /* ignore */
          }
        }
        if (rec.parentMo) {
          try {
            rec.parentMo.disconnect();
          } catch (e) {
            /* ignore */
          }
        }
      };

      const rescueEl = (rec, nextRef) => {
        if (!keepAlive) return;
        const el = rec.el;
        try {
          if (el.isConnected) return;
          const now = Date.now();
          rec.rescues = (rec.rescues || []).filter((t) => now - t < RESCUE_WINDOW_MS);
          rec.rescues.push(now);
          if (rec.rescues.length > RESCUE_MAX) {
            // 对抗删除死循环：放弃这个元素，观察器一并撤掉
            unguardRec(rec);
            guardedSet.delete(el);
            rec.gaveUp = true;
            return;
          }
          const parent = rec.parent;
          if (parent && parent.isConnected) {
            if (nextRef && nextRef.parentNode === parent) parent.insertBefore(el, nextRef);
            else parent.appendChild(el);
            noteHit('rescue');
            launderEl(el); // 移除期间可能被改过 style
          }
        } catch (e) {
          /* ignore */
        }
      };

      const guardEl = (el) => {
        if (!el || guardedSet.has(el)) return false;
        try {
          if (!el.isConnected) return false;
          launderEl(el);
          const rec = {
            el: el,
            id: idSeq++,
            parent: el.parentNode,
            nextRef: el.nextSibling,
            styleMo: null,
            parentMo: null,
            rescues: [],
            gaveUp: false,
            fights: 0,
          };
          // 样式观察器：外挂自己改 style 就地重洗。
          // 自己写回也会进这里——launderEl 算出「无变化就不写」，链路必收敛。
          rec.styleMo = new MutationObserver(() => {
            launderEl(el);
            // 反噬检测：洗白后属性文本仍含 rgb = 对方在跟我们互写。三振停战，
            // 撤观察器——互写死循环烧 CPU，也只会进一步激怒对方的反噬惩罚。
            try {
              if (/rgb\(/i.test(el.getAttribute('style') || '')) {
                rec.fights++;
                if (rec.fights >= 3) {
                  rec.gaveUp = true;
                  unguardEl(rec.id);
                }
              } else {
                rec.fights = 0;
              }
            } catch (e) {
              /* ignore */
            }
          });
          rec.styleMo.observe(el, { attributes: true, attributeFilter: ['style'] });
          // 父节点观察器：防删保活（默认关）；顺带维护原位引用
          if (rec.parent) {
            rec.parentMo = new MutationObserver((muts) => {
              for (let i = 0; i < muts.length; i++) {
                const m = muts[i];
                let removedMe = false;
                for (const n of m.removedNodes) if (n === el) removedMe = true;
                if (removedMe) {
                  rec.nextRef = m.nextSibling; // 变更瞬间的原位
                  rescueEl(rec, m.nextSibling);
                } else if (!el.isConnected) {
                  /* 已被移除且保活放弃：只维护引用，不做别的 */
                } else {
                  rec.nextRef = el.nextSibling;
                }
              }
            });
            try {
              rec.parentMo.observe(rec.parent, { childList: true });
            } catch (e) {
              rec.parentMo = null;
            }
          }
          guarded.set(rec.id, rec);
          guardedSet.add(el);
          return true;
        } catch (e) {
          return false;
        }
      };

      const unguardEl = (id) => {
        const rec = guarded.get(id);
        if (!rec) return false;
        unguardRec(rec);
        guardedSet.delete(rec.el);
        guarded.delete(id);
        return true;
      };

      const unguardAll = () => {
        for (const rec of guarded.values()) unguardRec(rec);
        guarded.clear();
      };

      // ---------- ② 扫描 / 分类 ----------
      const SKIP_TAGS = {
        SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1,
        TEMPLATE: 1, BASE: 1, TITLE: 1, BR: 1, HEAD: 1,
      };
      const SITE_RE = /^(?:app|root|wrap|wrapper|page|main|container|content|layout|__next|__nuxt|q-app|q-layout)/i;
      /** SPA 挂载根 id：不纳管、且绝不允许被第三方 removeChild（React 从不删自己的根） */
      const ROOT_ID_RE = /^(root|app|__next|__nuxt|q-app|mount)$/i;

      const describe = (el) => {
        let s = String(el.tagName || '?').toLowerCase();
        try {
          if (el.id) s += '#' + el.id;
          const cls = typeof el.className === 'string' ? el.className.trim() : '';
          if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
          let dims = '';
          const r = el.getBoundingClientRect();
          if (r && (r.width || r.height)) dims = Math.round(r.width) + '×' + Math.round(r.height);
          const pos = el.parentNode === document.documentElement ? 'html 直挂' : 'body 直挂';
          return s + (dims ? ' · ' + dims : '') + ' · ' + pos;
        } catch (e) {
          return s;
        }
      };

      /**
       * 分类一个顶层元素。返回 null = 不列为候选（脚本类 / 疑似隐身宿主）。
       * siteLike=true = 疑似站点本体（默认不保护，可手动勾）。
       */
      const classify = (el) => {
        if (!el || SKIP_TAGS[el.tagName]) return null;
        // body / SPA 挂载根（#root 等）不列候选：洗站点容器毫无意义且徒增
        // 冲突面。React portal **保留**——洗掉 rgb 指纹正是防止 CSense 扫描
        // 命中后删它、把 React 打崩成白屏的关键。
        if (el === document.body || el === document.documentElement) return null;
        if (ROOT_ID_RE.test(el.id || '')) return null;
        // VaIMod 隐身宿主一类：light DOM 全空且不悬浮 → 没有可描述可保护的
        // 可见面，跳过（真正外挂面板几乎必有 light DOM 子树或 fixed/absolute 定位）
        let fixedish = false;
        try {
          const cs = getComputedStyle(el);
          fixedish = cs.position === 'fixed' || cs.position === 'absolute';
        } catch (e) {
          /* ignore */
        }
        const emptyish = el.childElementCount === 0 && !String(el.textContent || '').trim();
        if (emptyish && !fixedish) return null;
        let siteLike = false;
        try {
          const key = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).trim();
          if (key && SITE_RE.test(key) && el.getElementsByTagName('*').length >= 60) siteLike = true;
        } catch (e) {
          /* ignore */
        }
        return { siteLike: siteLike };
      };

      // 候选表：扫描产物，id 稳定供 UI 引用
      let candidates = new Map(); // id -> {el, desc, siteLike, guarded, cId}
      let candSeq = 1;

      const scanTops = () => {
        const roots = [];
        if (document.documentElement) roots.push(document.documentElement);
        if (document.body) roots.push(document.body);
        const seen = new Set();
        const tops = [];
        for (const r of roots) {
          for (const el of r.children) {
            if (seen.has(el)) continue;
            seen.add(el);
            tops.push(el);
          }
        }
        return tops;
      };

      const scan = () => {
        const next = new Map();
        lastScanAt = Date.now();
        for (const el of scanTops()) {
          const c = classify(el);
          if (!c) continue;
          next.set(candSeq, {
            el: el,
            desc: describe(el),
            siteLike: c.siteLike,
            guarded: guardedSet.has(el),
            cId: candSeq,
          });
          candSeq++;
        }
        candidates = next;
        emitSoon();
      };

      /** 新顶层元素到达（武装态自动纳管） */
      const autoAdopt = (el) => {
        try {
          const c = classify(el);
          if (!c || c.siteLike) return;
          if (guardedSet.has(el)) return;
          if (guardEl(el)) noteHit('auto');
        } catch (e) {
          /* ignore */
        }
      };

      // 顶层注入观察器：武装态常开，接住页面后续注入的外挂元素
      let topMo = null;
      const installTopMo = () => {
        if (topMo || typeof MutationObserver === 'undefined') return;
        topMo = new MutationObserver((muts) => {
          let removed = 0;
          for (const m of muts) {
            removed += m.removedNodes.length;
            for (const n of m.addedNodes) {
              if (!(n instanceof HTMLElement)) continue;
              const p = n.parentNode;
              if (p === document.documentElement || p === document.body) autoAdopt(n);
            }
          }
          // 整页清空 / 挂载根被摘走的兜底恢复（洗白躲扫描是预防，这里是已然后）
          try {
            if (removed >= 2) {
              rescueRoots();
              if (document.body && document.body.childElementCount === 0 && domSnap.length > 2) restoreDomSnapshot();
            }
          } catch (e) {
            /* ignore */
          }
        });
        try {
          topMo.observe(document.documentElement, { childList: true });
        } catch (e) {
          /* ignore */
        }
        if (document.body) {
          try {
            topMo.observe(document.body, { childList: true });
          } catch (e) {
            /* ignore */
          }
        }
      };
      const uninstallTopMo = () => {
        if (topMo) {
          try {
            topMo.disconnect();
          } catch (e) {
            /* ignore */
          }
          topMo = null;
        }
      };

      // ---------- ③ CSense 反制兜底（武装态生效） ----------
      const saved = []; // [target, prop, orig, wrapped]
      let chokeInstalled = false;
      let navHandler = null;
      let overlayMo = null;

      const hook = (target, prop, make) => {
        try {
          const orig = target[prop];
          if (typeof orig !== 'function') return;
          const wrapped = make(orig);
          markNative(wrapped, orig.name || prop);
          target[prop] = wrapped;
          saved.push([target, prop, orig, wrapped]);
        } catch (e) {
          /* ignore */
        }
      };

      const fakeOkResponse = () => {
        try {
          return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        } catch (e) {
          return Promise.resolve(new Response('', { status: 200 }));
        }
      };

      const fakeWindowStub = () => {
        const stub = {
          closed: false,
          close: () => undefined,
          focus: () => undefined,
          blur: () => undefined,
          print: () => undefined,
          postMessage: () => undefined,
          opener: null,
        };
        return stub;
      };

      // ---------- ③′ DOM 惩罚反制（武装期生效） ----------
      // CSense 的惩罚经 iframe.contentWindow 伸进顶层文档打：移除节点 /
      // innerHTML 覆写 / display:none 整页隐藏 / 盖遮罩。洗白躲扫描是预防，
      // 这里是已然后的兜底——白屏 = 内容被打掉，必须当场拒绝与恢复。
      let domUndo = []; // 卸载句柄
      let domSnap = []; // body 顶层子节点快照（arm 时刻）

      const takeDomSnapshot = () => {
        try {
          domSnap = Array.from(document.body ? document.body.children : []);
        } catch (e) {
          domSnap = [];
        }
      };

      /** 清空场景按原序追回快照节点（React 容器被放回后凭 retained 引用可继续工作） */
      const restoreDomSnapshot = () => {
        const body = document.body;
        if (!body || !domSnap.length) return;
        let restored = 0;
        for (const el of domSnap) {
          try {
            if (el.isConnected) continue;
            body.appendChild(el);
            restored++;
          } catch (e) {
            /* ignore */
          }
        }
        if (restored) noteHit('restore');
      };

      /** 快照里的挂载根被单独摘走（body 还剩别的）也要立刻放回 */
      const rescueRoots = () => {
        if (!domSnap.length) return;
        const body = document.body;
        if (!body) return;
        for (const el of domSnap) {
          try {
            if (el.isConnected) continue;
            if (el.nodeType === 1 && ROOT_ID_RE.test(el.id || '')) {
              body.appendChild(el);
              noteHit('rescue');
            }
          } catch (e) {
            /* ignore */
          }
        }
      };

      /**
       * display:none 突袭回滚：第三方把 body / html / 站点根内联隐藏 = 白屏。
       * 只回滚「inline display:none + 当前真的不可见」，站点/本体的 class 隐藏不动。
       */
      const watchDisplay = (target) => {
        if (!target || typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(() => {
          try {
            if (/display\s*:\s*none/i.test(target.getAttribute('style') || '') && getComputedStyle(target).display === 'none') {
              target.style.removeProperty('display');
              noteHit('display');
            }
          } catch (e) {
            /* ignore */
          }
        });
        try {
          mo.observe(target, { attributes: true, attributeFilter: ['style', 'class'] });
          domUndo.push(() => {
            try {
              mo.disconnect();
            } catch (e) {
              /* ignore */
            }
          });
        } catch (e) {
          /* ignore */
        }
      };

      /**
       * 实例级属性影子：只挡「内容含 csense 指纹」的覆写（遮罩 innerHTML），
       * 其余一律放行——绝不成为站点自身的故障点。
       */
      const shadowProp = (target, prop) => {
        try {
          if (Object.getOwnPropertyDescriptor(target, prop)) return;
          let pd = null;
          let proto = Object.getPrototypeOf(target);
          while (proto && !pd) {
            pd = Object.getOwnPropertyDescriptor(proto, prop);
            if (!pd) proto = Object.getPrototypeOf(proto);
          }
          if (!pd || !pd.set || !pd.get) return;
          const shadow = {
            get() {
              return pd.get.call(this);
            },
            set(v) {
              try {
                if (typeof v === 'string' && /csense/i.test(v)) {
                  noteHit('wipe');
                  return undefined;
                }
              } catch (e) {
                /* ignore */
              }
              return pd.set.call(this, v);
            },
            configurable: true,
          };
          Object.defineProperty(target, prop, shadow);
          domUndo.push(() => {
            try {
              delete target[prop];
            } catch (e) {
              /* ignore */
            }
          });
        } catch (e) {
          /* ignore */
        }
      };

      /**
       * body.removeChild 影子：只拒删 SPA 挂载根（#root 等被摘走 = 整页白屏，
       * 且 React 自己从不 removeChild 挂载根）。React portal 的增删是正常
       * 提交流量，绝不能拒——它们的防删由「洗白使其不命中 CSense 扫描」承担。
       */
      const shadowBodyRemoveChild = () => {
        const body = document.body;
        if (!body) return;
        try {
          if (Object.getOwnPropertyDescriptor(body, 'removeChild')) return;
          let pd = null;
          let proto = Object.getPrototypeOf(body);
          while (proto && !pd) {
            pd = Object.getOwnPropertyDescriptor(proto, 'removeChild');
            if (!pd) proto = Object.getPrototypeOf(proto);
          }
          if (!pd || typeof pd.value !== 'function') return;
          const shadow = function (child) {
            try {
              if (child && child.nodeType === 1 && ROOT_ID_RE.test(child.id || '')) {
                noteHit('rescue');
                return child;
              }
            } catch (e) {
              /* ignore */
            }
            return pd.value.apply(this, arguments);
          };
          Object.defineProperty(body, 'removeChild', { value: shadow, writable: true, configurable: true });
          domUndo.push(() => {
            try {
              delete body.removeChild;
            } catch (e) {
              /* ignore */
            }
          });
        } catch (e) {
          /* ignore */
        }
      };

      const installDomGuard = () => {
        takeDomSnapshot();
        if (document.body) watchDisplay(document.body);
        if (document.documentElement) watchDisplay(document.documentElement);
        const rootEl = document.getElementById('root');
        if (rootEl) watchDisplay(rootEl);
        if (document.body) shadowProp(document.body, 'innerHTML');
        if (document.documentElement) {
          shadowProp(document.documentElement, 'innerHTML');
          shadowProp(document.documentElement, 'outerHTML');
        }
        shadowBodyRemoveChild();
      };

      const uninstallDomGuard = () => {
        while (domUndo.length) {
          const fn = domUndo.pop();
          try {
            fn();
          } catch (e) {
            /* ignore */
          }
        }
        domSnap = [];
      };

      const installChoke = () => {
        if (chokeInstalled) return;
        chokeInstalled = true;
        installDomGuard();

        // fetch 咽喉
        if (typeof window.fetch === 'function') {
          hook(window, 'fetch', (origFetch) =>
            function (input, init) {
              try {
                let url = '';
                if (typeof input === 'string') url = input;
                else if (typeof URL !== 'undefined' && input instanceof URL) url = input.href;
                else if (input) url = input.url;
                if (url && isCsenseUrl(url)) {
                  noteHit('fetch');
                  return fakeOkResponse();
                }
              } catch (e) {
                /* ignore */
              }
              return origFetch.call(this, input, init);
            },
          );
        }

        // XHR 咽喉：open 记号（WeakSet）→ send 吞掉并合成假完成。
        // 必须 dispatchEvent 全量派发（readystatechange+load+loadend），否则
        // addEventListener 型调用方（axios 等）永久悬挂。
        try {
          const XP = XMLHttpRequest.prototype;
          const marked = new WeakSet();
          hook(XP, 'open', (origOpen) =>
            function (method, url) {
              try {
                if (isCsenseUrl(String(url))) marked.add(this);
              } catch (e) {
                /* ignore */
              }
              return origOpen.apply(this, arguments);
            },
          );
          hook(XP, 'send', (origSend) =>
            function (body) {
              if (!marked.has(this)) return origSend.apply(this, arguments);
              const self = this;
              noteHit('xhr');
              setTimeout(() => {
                try {
                  Object.defineProperty(self, 'readyState', { configurable: true, value: 4 });
                  Object.defineProperty(self, 'status', { configurable: true, value: 200 });
                  Object.defineProperty(self, 'responseText', { configurable: true, value: '{}' });
                  Object.defineProperty(self, 'response', { configurable: true, value: '{}' });
                  self.dispatchEvent(new Event('readystatechange'));
                  self.dispatchEvent(new ProgressEvent('load'));
                  self.dispatchEvent(new ProgressEvent('loadend'));
                } catch (e) {
                  /* ignore */
                }
              }, 0);
              return undefined;
            },
          );
        } catch (e) {
          /* ignore */
        }

        // sendBeacon 咽喉
        try {
          if (typeof Navigator !== 'undefined' && typeof Navigator.prototype.sendBeacon === 'function') {
            hook(Navigator.prototype, 'sendBeacon', (origBeacon) =>
              function (url, data) {
                try {
                  if (isCsenseUrl(typeof url === 'string' ? url : url && url.href)) {
                    noteHit('beacon');
                    return true; // 假成功，不出网
                  }
                } catch (e) {
                  /* ignore */
                }
                return origBeacon.call(this, url, data);
              },
            );
          }
        } catch (e) {
          /* ignore */
        }

        // 跳转 a：Navigation API（唯一能拦 location.href= 直赋值的钩点）
        try {
          const nav = window.navigation;
          if (nav && typeof nav.addEventListener === 'function') {
            navHandler = (e) => {
              try {
                if (e.destination && isCsenseUrl(e.destination.url)) {
                  e.preventDefault();
                  noteHit('nav');
                }
              } catch (err) {
                /* ignore */
              }
            };
            nav.addEventListener('navigate', navHandler);
          }
        } catch (e) {
          /* ignore */
        }

        // 跳转 b：Location.prototype.assign / replace（location 属性 [Unforgeable]
        // 不可定义，但原型方法可安全包装）
        try {
          const LP = Location.prototype;
          if (typeof LP.assign === 'function') {
            hook(LP, 'assign', (origAssign) =>
              function (url) {
                if (isCsenseUrl(String(url))) {
                  noteHit('nav');
                  return undefined; // 静默吞掉，页面原地不动
                }
                return origAssign.call(this, url);
              },
            );
          }
          if (typeof LP.replace === 'function') {
            hook(LP, 'replace', (origReplace) =>
              function (url) {
                if (isCsenseUrl(String(url))) {
                  noteHit('nav');
                  return undefined;
                }
                return origReplace.call(this, url);
              },
            );
          }
        } catch (e) {
          /* ignore */
        }

        // 跳转 c：window.open 命中返回假窗桩（不返回 null，避免重试分支）
        if (typeof window.open === 'function') {
          hook(window, 'open', (origOpen) =>
            function (url) {
              if (url !== undefined && url !== null && isCsenseUrl(String(url))) {
                noteHit('nav');
                return fakeWindowStub();
              }
              return origOpen.apply(this, arguments);
            },
          );
        }

        // 遮罩即时清除：CSense 的遮罩类名是「先插入 DOM、后赋 className」——
        // childList-only 观察器在插入瞬间看不到 csense-window，必然漏检。
        // 必须 childList+subtree+class 属性变化一起盯，命中即删（含深层嵌套）。
        if (typeof MutationObserver !== 'undefined') {
          overlayMo = new MutationObserver((muts) => {
            for (const m of muts) {
              if (m.type === 'attributes') {
                try {
                  const t = m.target;
                  if (t && t.parentNode && /csense/i.test(String(t.className || ''))) {
                    t.remove();
                    noteHit('overlay');
                  }
                } catch (e) {
                  /* ignore */
                }
                continue;
              }
              for (const node of m.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                try {
                  if (/csense/i.test(String(node.className || ''))) {
                    node.remove();
                    noteHit('overlay');
                    continue;
                  }
                  if (node.querySelectorAll) {
                    const list = node.querySelectorAll('[class*="csense" i]');
                    for (const el of list) {
                      el.remove();
                      noteHit('overlay');
                    }
                  }
                } catch (e) {
                  /* ignore */
                }
              }
            }
          });
          let htmlObserved = false;
          try {
            overlayMo.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class'],
            });
            htmlObserved = true;
          } catch (e) {
            /* ignore */
          }
          if (!htmlObserved && document.body) {
            try {
              overlayMo.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
              });
            } catch (e) {
              /* ignore */
            }
          }
        }
      };

      const uninstallChoke = () => {
        if (!chokeInstalled) return;
        chokeInstalled = false;
        uninstallDomGuard();
        while (saved.length) {
          const item = saved.pop();
          try {
            // 只在「当前还是我装的那个」时才还原：别的脚本后叠的包装不该被我抹掉
            if (item[0][item[1]] === item[3]) item[0][item[1]] = item[2];
          } catch (e) {
            /* ignore */
          }
        }
        if (navHandler) {
          try {
            const nav = window.navigation;
            if (nav && typeof nav.removeEventListener === 'function') nav.removeEventListener('navigate', navHandler);
          } catch (e) {
            /* ignore */
          }
          navHandler = null;
        }
        if (overlayMo) {
          try {
            overlayMo.disconnect();
          } catch (e) {
            /* ignore */
          }
          overlayMo = null;
        }
      };

      // ---------- CSense 特征扫描（只读，武装时执行一次 + 回前台补扫） ----------
      const scanCsense = () => {
        const sig = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (LS_KEYS.indexOf(k) >= 0 || LS_PREFIX_RE.test(k)) sig.push('ls:' + k);
          }
        } catch (e) {
          /* localStorage 不可用 */
        }
        try {
          if (document.querySelector('.csense-window')) sig.push('dom:csense-window');
        } catch (e) {
          /* ignore */
        }
        try {
          if (COOKIE_RE.test(document.cookie)) sig.push('cookie');
        } catch (e) {
          /* ignore */
        }
        csenseSignals = sig;
      };

      const onVis = () => {
        if (document.visibilityState === 'visible') scanCsense();
      };

      // ---------- 对外 API ----------
      const arm = () => {
        if (!armed) {
          armed = true;
          ctx.store.set(KEY.mode, 'armed');
        }
        scan();
        for (const c of candidates.values()) {
          if (!c.siteLike) guardEl(c.el);
        }
        installTopMo();
        installChoke();
        scanCsense();
        try {
          window.addEventListener('visibilitychange', onVis);
        } catch (e) {
          /* ignore */
        }
        emitSoon();
      };

      const disarm = () => {
        armed = false;
        ctx.store.set(KEY.mode, 'off');
        unguardAll();
        uninstallTopMo();
        uninstallChoke();
        try {
          window.removeEventListener('visibilitychange', onVis);
        } catch (e) {
          /* ignore */
        }
        emitSoon();
      };

      return {
        isArmed: () => armed,
        getKeepAlive: () => keepAlive,
        setKeepAlive(on) {
          keepAlive = on === true;
          ctx.store.set(KEY.keep, keepAlive);
          emitSoon();
        },
        scan,
        listCandidates: () => Array.from(candidates.values()),
        protectCandidate(cId) {
          const c = candidates.get(cId);
          if (!c) return;
          guardEl(c.el);
          c.guarded = guardedSet.has(c.el);
          emitSoon();
        },
        unprotectCandidate(cId) {
          const c = candidates.get(cId);
          if (!c) return;
          for (const [id, rec] of guarded) {
            if (rec.el === c.el) unguardEl(id);
          }
          c.guarded = guardedSet.has(c.el);
          emitSoon();
        },
        armAll() {
          arm();
        },
        disarmAll() {
          disarm();
        },
        status() {
          let guardedCount = 0;
          for (const rec of guarded.values()) {
            try {
              if (rec.el.isConnected && !rec.gaveUp) guardedCount++;
            } catch (e) {
              /* ignore */
            }
          }
          return {
            armed: armed,
            keepAlive: keepAlive,
            guarded: guardedCount,
            hits: {
              launder: hits.launder,
              rescue: hits.rescue,
              auto: hits.auto,
              fetch: hits.fetch,
              xhr: hits.xhr,
              beacon: hits.beacon,
              nav: hits.nav,
              overlay: hits.overlay,
              display: hits.display,
              wipe: hits.wipe,
              restore: hits.restore,
            },
            lastHit: lastHit,
            csenseSignals: csenseSignals.slice(),
            lastScanAt: lastScanAt,
          };
        },
        subscribe(fn) {
          listeners.push(fn);
          return () => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
        destroy() {
          if (emitTimer !== null) {
            clearTimeout(emitTimer);
            emitTimer = null;
          }
          listeners.length = 0;
          disarm();
          candidates = new Map();
        },
      };
    }

    // ==================================================================
    // 视图（每个实例一份）
    // ==================================================================
    const hhmmss = (ts) => {
      const d = new Date(ts);
      const p = (n) => (n < 10 ? '0' + n : String(n));
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };

    function createView(eng) {
      const dyn = {};

      const say = (text, err) => {
        if (!dyn.msg) return;
        dyn.msg.textContent = text || '';
        dyn.msg.className = 'fs-msgbox' + (err ? ' fs-msgbox-err' : '');
        dyn.msg.style.display = text ? '' : 'none';
      };

      const renderStats = () => {
        if (!dyn.stat) return;
        const s = eng.status();
        const cs = s.hits.fetch + s.hits.xhr + s.hits.beacon + s.hits.nav + s.hits.overlay;
        const domD = s.hits.display + s.hits.wipe + s.hits.restore;
        dyn.stat.textContent =
          (s.armed ? '保护中 · ' : '未武装 · ') +
          '已保护 ' + s.guarded + ' 个元素 · 洗白 ' + s.hits.launder +
          ' 次 · 自动纳管 ' + s.hits.auto + ' 个 · 救回 ' + s.hits.rescue +
          ' 次 · CSense 吞掉 ' + cs + ' 次' +
          (domD ? ' · DOM 惩罚反制 ' + domD + ' 次（隐藏回滚 ' + s.hits.display + ' / 覆写拒 ' + s.hits.wipe + ' / 恢复 ' + s.hits.restore + '）' : '');
      };

      const renderCsense = () => {
        if (!dyn.csense) return;
        const s = eng.status();
        dyn.csense.textContent = '';
        const line = document.createElement('div');
        line.className = 'fs-stat';
        line.textContent = s.csenseSignals.length
          ? '检测到 CSense 迹象（已纳入反制覆盖）：'
          : '未检测到 CSense 迹象。反制咽喉随武装常开：上报不出网、跳转被取消、遮罩即插即删。';
        dyn.csense.appendChild(line);
        if (s.csenseSignals.length) {
          const sig = document.createElement('div');
          sig.className = 'fs-sig';
          sig.textContent = s.csenseSignals.join('  ');
          dyn.csense.appendChild(sig);
        }
      };

      const renderList = () => {
        if (!dyn.list) return;
        dyn.list.textContent = '';
        const list = eng.listCandidates();
        if (!list.length) {
          const p = document.createElement('div');
          p.className = 'fs-empty';
          p.textContent = '未发现可保护的外挂元素（脚本/样式/空宿主不列入；站点本体元素会标注）。';
          dyn.list.appendChild(p);
          return;
        }
        for (const c of list) {
          const el = document.createElement('div');
          el.className = 'fs-item' + (c.siteLike ? ' fs-item-site' : '');
          const desc = document.createElement('span');
          desc.className = 'fs-desc';
          desc.textContent = c.desc;
          el.appendChild(desc);
          el.appendChild(ui.badge(c.siteLike ? '站点本体' : c.guarded ? '保护中' : '未保护', c.siteLike ? 'default' : c.guarded ? 'ok' : 'warn'));
          if (!c.siteLike) {
            el.appendChild(
              ui.button({
                text: c.guarded ? '解除' : '保护',
                kind: c.guarded ? 'ghost' : 'primary',
                onclick: () => {
                  if (c.guarded) eng.unprotectCandidate(c.cId);
                  else eng.protectCandidate(c.cId);
                  renderAll();
                },
              }),
            );
          }
          dyn.list.appendChild(el);
        }
      };

      const renderAll = () => {
        renderStats();
        renderList();
        renderCsense();
      };

      // ---------- 构建 ----------
      const wrap = document.createElement('div');
      wrap.className = 'fs-wrap';

      const hint = document.createElement('div');
      hint.className = 'fs-note';
      hint.textContent =
        '扫描页面顶层被外挂注入的元素（其它用户脚本 / 扩展的面板、悬浮层、iframe），' +
        '一键给它们做 VaIMod 同等保护：inline style 洗白（rgb→hex、inset 挪尾）让' +
        '「按样式文本扫描」的检测选择器永远命中不了；武装期间新注入的外挂元素自动纳管。' +
        '站点本体元素默认不保护。';

      const stat = document.createElement('div');
      stat.className = 'fs-stat';
      dyn.stat = stat;

      const msgBox = document.createElement('div');
      msgBox.className = 'fs-msgbox';
      msgBox.style.display = 'none';
      dyn.msg = msgBox;

      const list = document.createElement('div');
      list.className = 'fs-list';
      dyn.list = list;

      const csense = document.createElement('div');
      csense.className = 'fs-csense';
      dyn.csense = csense;

      const keepSw = ui.switch({
        checked: eng.getKeepAlive(),
        label: '防删保活（元素被外力删除时按原位放回；默认关，防外挂自身清理出僵尸）',
        onchange: (on) => {
          eng.setKeepAlive(on);
          say(on ? '已开启防删保活' : '已关闭防删保活');
        },
      });

      wrap.append(
        ui.card({
          title: '保护状态',
          children: [
            hint,
            stat,
            keepSw,
            ui.row(
              ui.button({
                text: eng.isArmed() ? '重新扫描并保护' : '一键保护全部外挂元素',
                kind: eng.isArmed() ? 'ghost' : 'primary',
                onclick: () => {
                  eng.armAll();
                  const s = eng.status();
                  say('已武装：保护 ' + s.guarded + ' 个元素；新注入的外挂元素会自动纳管。');
                  renderAll();
                },
              }),
              ui.button({
                text: '仅扫描',
                kind: 'ghost',
                onclick: () => {
                  eng.scan();
                  say('扫描完成');
                  renderAll();
                },
              }),
              ui.button({
                text: '全部解除',
                kind: 'danger',
                onclick: () => {
                  eng.disarmAll();
                  say('已解除全部保护并卸载反制钩子');
                  renderAll();
                },
              }),
            ),
            msgBox,
          ],
        }),
        ui.card({
          title: '页面顶层元素',
          children: [list],
        }),
        ui.card({
          title: 'CSense 拦截器反制',
          children: [csense],
        }),
      );

      ctx.root.appendChild(wrap);
      renderAll();

      return {
        render: renderAll,
        destroy() {
          try {
            wrap.remove();
          } catch (e) {
            /* ignore */
          }
        },
      };
    }

    // ==================================================================
    // 实例生命周期：单例引擎 → 建视图 → 订阅 + 引用计数归零延迟销毁
    // ==================================================================
    const G = slot();
    if (G.pending) {
      clearTimeout(G.pending);
      G.pending = 0;
    }
    if (!G.engine) G.engine = createEngine();
    const eng = G.engine;
    G.refs++;

    const view = createView(eng);
    // 武装态（store 持久）在此实例挂上时立即恢复工作，包括 headless 常驻实例
    if (eng.isArmed()) eng.armAll();

    const unsub = eng.subscribe(() => view.render());

    // refresh 段与 code 段不共享闭包：重渲染入口挂 root 上给它用
    ctx.root.__fsRender = () => view.render();

    return function cleanup() {
      unsub();
      view.destroy();
      try {
        delete ctx.root.__fsRender;
      } catch (e) {
        /* ignore */
      }
      G.refs--;
      if (G.refs > 0) return;
      G.refs = 0;
      // ⛔ 绝不同步销毁引擎：切标签页必然产生一次 refs === 0，而新实例几十毫秒后才到
      G.pending = setTimeout(() => {
        G.pending = 0;
        if (G.refs > 0) return;
        const e = G.engine;
        G.engine = null;
        try {
          e.destroy();
        } catch (err) {
          /* ignore */
        }
      }, HANDOFF_GRACE_MS);
    };
  },

  refresh(ctx) {
    const fn = ctx.root && ctx.root.__fsRender;
    if (typeof fn === 'function') fn();
  },
});
