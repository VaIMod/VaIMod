// VaIMod 插件 · 外挂元素护盾（补丁版）
// ============================================================================
// 「外挂元素护盾」的 **patch（安全补丁）形态**，与 docs/plugin-foreign-shield.js
// （扩展形态，带完整标签页 UI）同源同策略，差别只在交互载体：
//
//   · type:'patch' → headless 常驻，面板挂载即运行，**完全不依赖 VM**
//     （变量/云数据有没有都无所谓，不需要等待获取 vm）；
//   · 没有标签页：在页面左下角注入一枚**盾牌小按钮**，点击即开启 / 关闭保护；
//   · 开启 = 扫描当前页面其它外挂注入的顶层元素一键套上同等保护 + 装载
//     CSense 拦截器反制三板斧；关闭 = 全部解除（比对还原，不拆别人的包装）。
//
// 保护策略与扩展版完全一致（这里是权威说明的摘要，详见扩展版文件头）：
//   ① 样式洗白：rgb()/rgba() → 等值 hex、box-shadow 的 inset 挪到层尾——
//      渲染逐像素不变，CSense 的 style 文本扫描选择器永远命中不了；
//      洗白后挂 style 观察器就地重洗，「逐声明比对、没变绝不写回」保证收敛。
//   ② 自动纳管：武装期间新注入的顶层外挂元素自动接住（观察器，非轮询）。
//   ③ CSense 反制兜底：网络咽喉（fetch/XHR/sendBeacon 黑名单端点假成功）+
//      跳转三层（Navigation API / Location.prototype.assign/replace /
//      window.open 假窗桩）+ .csense-window 遮罩即时清除。
//
// 安全底线（对齐本体与扩展版）：
//   1. 默认未武装：按钮没点过就零钩子、零观察器、零开销。
//   2. 包装过的原生方法一律过 ctx.net.markNative；卸载先比对再还原。
//   3. 按钮自身也是「注入的外挂元素」：内联样式只用 hex 色值（不用 rgb/inset，
//      自己先过自己的扫描面），随武装一并纳入洗白与自动纳管。
//   4. 补丁 cleanup（禁用/卸载/升级）= 解除全部保护 + 撤按钮，无残留。
// ============================================================================

VaIMod.plugin({
  type: 'patch',
  id: 'foreign-shield-patch',
  name: '外挂元素护盾·补丁',
  version: '1.0.0',
  author: 'VaIMod',
  desc: '页面角落盾牌按钮一键为其它外挂元素做同等保护（样式洗白 + 自动纳管 + CSense 反制）；不依赖 VM',
  priority: 500,
  market: {
    category: '安全',
    tags: ['防护', '反制', 'CSense', '补丁'],
    icon: '🧿',
    license: 'MIT',
  },

  code(ctx) {
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

    const store = ctx.store;
    const toast = (text, kind) => {
      try {
        ctx.toast(text, kind || 'ok');
      } catch (e) {
        /* ignore */
      }
    };

    // ------------------------------------------------------------------
    // CSense 专属端点（与本体 csense-guard 同一口径，窄口径）
    // ------------------------------------------------------------------
    const REPORT_RE = /https?:\/\/dcynsppfvlkdtbaleefw\.supabase\.co\/rest\/v1\/csense_detections/i;
    const REDIRECT_RE = /https?:\/\/d\.chen-jin\.dpdns\.org\/csdetected/i;
    const isCsenseUrl = (raw) => {
      try {
        return REPORT_RE.test(String(raw)) || REDIRECT_RE.test(String(raw));
      } catch (e) {
        return false;
      }
    };

    // ------------------------------------------------------------------
    // 样式洗白核心（与扩展版逐字一致：hex 转换 + inset 挪尾 + 收敛保证）
    // ------------------------------------------------------------------
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

    /** 返回 null = 无需改动（绝不写回 → 观察器链路必收敛） */
    const launderStyleText = (text) => {
      if (!text) return null;
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

    const launderEl = (el) => {
      try {
        const orig = el.getAttribute('style') || '';
        if (!orig) return;
        const next = launderStyleText(orig);
        if (next !== null && next !== orig) el.setAttribute('style', next);
      } catch (e) {
        /* ignore */
      }
    };

    // ------------------------------------------------------------------
    // 受保护元素登记 + 自动纳管
    // ------------------------------------------------------------------
    const guarded = new Map(); // el -> styleMo
    const guardedSet = new WeakSet();

    const unguardEl = (el) => {
      const mo = guarded.get(el);
      if (mo) {
        try {
          mo.disconnect();
        } catch (e) {
          /* ignore */
        }
        guarded.delete(el);
      }
      guardedSet.delete(el);
    };

    const guardEl = (el) => {
      if (!el || guardedSet.has(el)) return false;
      try {
        if (!el.isConnected) return false;
        launderEl(el);
        const styleMo = new MutationObserver(() => launderEl(el));
        styleMo.observe(el, { attributes: true, attributeFilter: ['style'] });
        guarded.set(el, styleMo);
        guardedSet.add(el);
        return true;
      } catch (e) {
        return false;
      }
    };

    const unguardAll = () => {
      for (const el of Array.from(guarded.keys())) unguardEl(el);
    };

    // 顶层候选分类（与扩展版同口径：脚本类跳过；空且不悬浮的隐身宿主跳过）
    const SKIP_TAGS = {
      SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1,
      TEMPLATE: 1, BASE: 1, TITLE: 1, BR: 1, HEAD: 1,
    };
    const classify = (el) => {
      if (!el || SKIP_TAGS[el.tagName]) return null;
      let fixedish = false;
      try {
        const cs = getComputedStyle(el);
        fixedish = cs.position === 'fixed' || cs.position === 'absolute';
      } catch (e) {
        /* ignore */
      }
      const emptyish = el.childElementCount === 0 && !String(el.textContent || '').trim();
      if (emptyish && !fixedish) return null;
      return { el: el };
    };

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

    let armed = store.get('armed', false) === true;

    // ------------------------------------------------------------------
    // CSense 反制兜底（武装态生效；与本体 csense-guard 叠装无害）
    // ------------------------------------------------------------------
    const saved = [];
    let chokeInstalled = false;
    let navHandler = null;
    let overlayMo = null;
    let topMo = null;

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

    const fakeWindowStub = () => ({
      closed: false,
      close: () => undefined,
      focus: () => undefined,
      blur: () => undefined,
      print: () => undefined,
      postMessage: () => undefined,
      opener: null,
    });

    const installChoke = () => {
      if (chokeInstalled) return;
      chokeInstalled = true;

      if (typeof window.fetch === 'function') {
        hook(window, 'fetch', (origFetch) =>
          function (input, init) {
            try {
              let url = '';
              if (typeof input === 'string') url = input;
              else if (typeof URL !== 'undefined' && input instanceof URL) url = input.href;
              else if (input) url = input.url;
              if (url && isCsenseUrl(url)) return fakeOkResponse();
            } catch (e) {
              /* ignore */
            }
            return origFetch.call(this, input, init);
          },
        );
      }

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

      try {
        if (typeof Navigator !== 'undefined' && typeof Navigator.prototype.sendBeacon === 'function') {
          hook(Navigator.prototype, 'sendBeacon', (origBeacon) =>
            function (url, data) {
              try {
                if (isCsenseUrl(typeof url === 'string' ? url : url && url.href)) return true;
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

      try {
        const nav = window.navigation;
        if (nav && typeof nav.addEventListener === 'function') {
          navHandler = (e) => {
            try {
              if (e.destination && isCsenseUrl(e.destination.url)) e.preventDefault();
            } catch (err) {
              /* ignore */
            }
          };
          nav.addEventListener('navigate', navHandler);
        }
      } catch (e) {
        /* ignore */
      }

      try {
        const LP = Location.prototype;
        if (typeof LP.assign === 'function') {
          hook(LP, 'assign', (origAssign) =>
            function (url) {
              if (isCsenseUrl(String(url))) return undefined;
              return origAssign.call(this, url);
            },
          );
        }
        if (typeof LP.replace === 'function') {
          hook(LP, 'replace', (origReplace) =>
            function (url) {
              if (isCsenseUrl(String(url))) return undefined;
              return origReplace.call(this, url);
            },
          );
        }
      } catch (e) {
        /* ignore */
      }

      if (typeof window.open === 'function') {
        hook(window, 'open', (origOpen) =>
          function (url) {
            if (url !== undefined && url !== null && isCsenseUrl(String(url))) return fakeWindowStub();
            return origOpen.apply(this, arguments);
          },
        );
      }

      if (typeof MutationObserver !== 'undefined') {
        overlayMo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of m.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              try {
                const list = node.matches && node.matches('.csense-window')
                  ? [node]
                  : node.querySelectorAll ? Array.from(node.querySelectorAll('.csense-window')) : [];
                for (const el of list) el.remove();
              } catch (e) {
                /* ignore */
              }
            }
          }
        });
        try {
          overlayMo.observe(document.documentElement, { childList: true });
        } catch (e) {
          /* ignore */
        }
        if (document.body) {
          try {
            overlayMo.observe(document.body, { childList: true });
          } catch (e) {
            /* ignore */
          }
        }
      }
    };

    const uninstallChoke = () => {
      if (!chokeInstalled) return;
      chokeInstalled = false;
      while (saved.length) {
        const item = saved.pop();
        try {
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

    // ------------------------------------------------------------------
    // 武装 / 解除
    // ------------------------------------------------------------------
    const installTopMo = () => {
      if (topMo || typeof MutationObserver === 'undefined') return;
      topMo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            const p = n.parentNode;
            if (p === document.documentElement || p === document.body) {
              try {
                if (classify(n)) guardEl(n);
              } catch (e) {
                /* ignore */
              }
            }
          }
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

    const arm = () => {
      armed = true;
      store.set('armed', true);
      for (const el of scanTops()) {
        const c = classify(el);
        if (c) guardEl(el);
      }
      installTopMo();
      installChoke();
    };

    const disarm = () => {
      armed = false;
      store.set('armed', false);
      unguardAll();
      uninstallTopMo();
      uninstallChoke();
    };

    // ------------------------------------------------------------------
    // 盾牌按钮（页面左下角；内联样式只用 hex 色值——自己先过自己的扫描面）
    // ------------------------------------------------------------------
    let btn = null;

    const paintBtn = () => {
      if (!btn) return;
      // 未武装：低调半透明；武装中：绿色描边呼吸感（纯 CSS 过渡，无动画循环）
      btn.style.borderColor = armed ? '#3fb95066' : '#8a909933';
      btn.style.color = armed ? '#3fb950' : '#8a9099';
      btn.style.opacity = armed ? '0.95' : '0.45';
      btn.title = armed ? '外挂元素护盾：保护中（点击解除）' : '外挂元素护盾：点击开启保护';
    };

    const installBtn = () => {
      if (btn && btn.isConnected) {
        paintBtn();
        return;
      }
      btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '🧿';
      // 可访问性与防误触：无品牌字样、无 class 指纹，事件只挂这一处
      btn.setAttribute('aria-label', '外挂元素护盾');
      btn.setAttribute(
        'style',
        'position:fixed;left:14px;bottom:14px;z-index:2147483646;width:34px;height:34px;' +
          'border-radius:50%;border:1px solid #8a909933;background:#0d1117cc;color:#8a9099;' +
          'font-size:16px;line-height:1;cursor:pointer;padding:0;box-shadow:none;' +
          'transition:opacity .18s,border-color .18s,color .18s;pointer-events:auto;',
      );
      btn.addEventListener('click', () => {
        try {
          if (armed) {
            disarm();
            toast('外挂元素护盾已解除');
          } else {
            arm();
            toast('外挂元素护盾已开启：外挂元素已纳入同等保护 + CSense 反制');
          }
        } catch (e) {
          toast('外挂元素护盾切换失败', 'err');
        }
        paintBtn();
      });
      const mount = () => {
        try {
          if (document.body && !btn.isConnected) document.body.appendChild(btn);
        } catch (e) {
          /* ignore */
        }
        paintBtn();
      };
      if (document.body) mount();
      else document.addEventListener('DOMContentLoaded', mount, { once: true });
    };

    const uninstallBtn = () => {
      if (btn) {
        try {
          btn.remove();
        } catch (e) {
          /* ignore */
        }
        btn = null;
      }
    };

    // ------------------------------------------------------------------
    // 启动：按钮常驻（补丁不需要 VM，面板挂载即就绪）；持久化武装态自动恢复
    // ------------------------------------------------------------------
    installBtn();
    if (armed) arm();
    // body 晚于补丁代码出现的情况：按钮挂载走 DOMContentLoaded 分支后，
    // 若持久化武装态在 body 就绪前就已生效，顶层观察器已就位，无需补扫。

    return function cleanup() {
      disarm();
      uninstallBtn();
    };
  },
});
