// VaIMod 插件 · 网络防火墙
// ============================================================================
// 把「页面 / 作品往站外发东西」这件事变得**可见、可控**。
//
// ⛔ 它就是一个普通插件：**不导入就完全没有这个功能**（本体里既没有网络钩子、
//    也没有任何防火墙相关的设置项或界面）。导入 → 标签栏出现「网络防火墙」→
//    常驻工作（不打开这个标签页也在审计，因为 async.lazy = false）。
//
// 安全底线（这些是刻意的设计约束，别为了「更强」而破坏）：
//   1. 默认 `off` —— 不安装任何钩子、零开销、不改变站点任何行为；
//      切到 `watch` 只记录一律放行；只有 `enforce` 才可能真的拒绝请求。
//   2. 同源 / 站点同族域名（ccw.site 及其全部子域）**不进判定链**，
//      一次字符串前缀比较即返回 —— 零日志、零判定开销。
//   3. 绝不 hook `img.src` / `script` / `link`（统计像素、CDN 会大量误伤）；
//      WebSocket 只观察 `send`，不替换构造器（替换会改变 instanceof / toString 特征）。
//   4. 本体自己发的请求（云数据直写等）用 `ctx.net.isInternalXhr` 认出来直接透传，
//      否则用户拉黑某域名后会连带把本体的后台请求也拦掉（自伤）。
//   5. 包装过的原生方法一律过 `ctx.net.markNative` —— 否则
//      `Function.prototype.toString.call(XMLHttpRequest.prototype.send)`
//      会直接把包装源码吐给反作弊。
//   6. 判定期任何异常都**放行**：防火墙绝不能成为站点的故障点。
//
// ⛔ 引擎必须是**单例**（挂在 window 的 Symbol 键上）。原因：
//    常驻实例（lazy:false 的 headless 实例）与标签页实例是两个独立的插件实例，
//    切换时一装一卸。如果各自装一套钩子，卸载顺序稍有不巧（新实例先装、旧实例后卸）
//    旧实例就会把新实例的包装「还原」成原生 —— 钩子静默失效。
//    单例 + 引用计数让「装」永远只发生一次，「卸」只在最后一个实例离开时发生。
//
// 判定分类（非站点请求）：
//   allow  用户白名单 —— 记录但不拦
//   block  用户黑名单 —— enforce 模式下拒绝
//   exfil  疑似把变量/存档数据外传 —— enforce + 已开启外传拦截时拒绝
//   third  其它第三方出网 —— 仅记录
// ============================================================================

VaIMod.plugin({
  type: 'ext',
  id: 'net-firewall',
  name: '网络防火墙',
  version: '1.0.0',
  author: 'VaIMod',
  desc: '审计页面与作品发往站外的请求，支持域名黑/白名单与外传拦截',
  // 常驻：不打开这个标签页也在工作（网络审计必须在请求发生时就装好钩子）。
  // 常驻实例是 headless 的（不渲染任何面板 DOM），打开标签页时才渲染界面。
  async: { lazy: false },
  market: {
    category: '安全',
    tags: ['网络安全', '审计', '拦截', '出网'],
    icon: '🛡️',
    license: 'MIT',
  },

  css: `
    .nf-wrap { display: flex; flex-direction: column; gap: 12px; }
    .nf-stat { font-size: 12px; color: #8a9099; line-height: 1.6; }
    .nf-rules { display: flex; flex-direction: column; gap: 6px; }
    .nf-rule { display: flex; align-items: center; gap: 8px;
               padding: 6px 9px; border-radius: 8px;
               background: rgba(255, 255, 255, .05); }
    .nf-rule-host { flex: 1; min-width: 0; font-family: Consolas, "Courier New", monospace;
                    font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nf-del { flex-shrink: 0; width: 22px; height: 22px; border: none; border-radius: 6px;
              background: transparent; color: #8a9099; cursor: pointer; font-size: 15px;
              line-height: 1; padding: 0; }
    .nf-del:hover { color: #ff9d9d; background: rgba(255, 90, 90, .14); }
    .nf-log { display: flex; flex-direction: column; gap: 8px; }
    .nf-hit { display: flex; flex-direction: column; gap: 5px;
              padding: 8px 10px; border-radius: 9px;
              background: rgba(255, 255, 255, .04);
              border: 1px solid rgba(255, 255, 255, .08); }
    .nf-hit-blocked { background: rgba(255, 89, 60, .08);
                      border-color: rgba(255, 89, 60, .4);
                      box-shadow: inset 3px 0 0 0 rgba(255, 89, 60, .8); }
    .nf-hit-head { display: flex; align-items: center; gap: 8px; }
    .nf-host { flex: 1; min-width: 0; font-family: Consolas, "Courier New", monospace;
               font-size: 12.5px; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; }
    .nf-kind { flex-shrink: 0; font-size: 11px; color: #8a9099; }
    .nf-path { font-family: Consolas, "Courier New", monospace; font-size: 11px;
               line-height: 1.5; color: #8a9099; word-break: break-all;
               user-select: text; -webkit-user-select: text; }
    .nf-note { font-size: 11.5px; color: #ffd08a; }
    .nf-btns { display: flex; gap: 7px; flex-wrap: wrap; }
    .nf-empty { font-size: 12px; color: #8a9099; }
    .nf-msgbox { padding: 6px 10px; border-radius: 7px; font-size: 12.5px;
                 line-height: 1.45; word-break: break-word;
                 background: rgba(48, 209, 88, .12); color: #7ee2a0;
                 border: 1px solid rgba(48, 209, 88, .28); }
    .nf-msgbox-err { background: rgba(255, 90, 90, .12); color: #ff9d9d;
                     border-color: rgba(255, 90, 90, .3); }
  `,

  code(ctx) {
    // ------------------------------------------------------------------
    // 兼容兜底：老版本本体没有 ctx.net（这两个能力是跨边界必需的，缺了要降级）
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
    const isInternalXhr = typeof net.isInternalXhr === 'function' ? net.isInternalXhr : () => false;

    const ui = ctx.ui;
    const LIMITS = {
      maxHosts: 300,
      maxRules: 500,
      maxHostLen: 253,
      maxUrlLen: 300,
      maxNoteLen: 64,
    };
    /** host 合法字符：字母数字、点、连字符、下划线、通配 *、端口 :（支持 `*.example.com`） */
    const HOST_RE = /^(?:\*\.?)?[a-z0-9](?:[a-z0-9._\-:*]*[a-z0-9*])?$/i;
    const KEY = { mode: 'mode', rules: 'rules', exfil: 'exfil' };

    /**
     * 实例交接宽限期（ms）。
     *
     * `lazy === false` 的插件同时存在两个实例：常驻 headless ＋ 可见标签页。
     * 切标签页 = 一个卸载、一个挂载，**每一次都会出现 refs === 0**。而宿主是
     * **异步挂载**插件的（双 rAF + 40ms 兜底，见 PluginTab 的 defer 分支），
     * 所以「旧的下、新的上」之间有几十毫秒的空档 —— 实测新实例在 ~30~50ms 后才到。
     *
     * 因此销毁必须等过一个宽限期，不能同步做、也不能只等一个宏任务：
     * 同步/短延时会每切一次标签页就重建引擎、清空出网日志，
     * 而「切走这期间的命中」恰恰是常驻审计唯一有价值的部分。
     *
     * 宽限期取 600ms：远大于宿主 40ms 的挂载兜底，又短到「停用插件」在用户
     * 感知上仍是即时的（且停用发生在设置页，页面上不会有并发请求）。
     */
    const HANDOFF_GRACE_MS = 600;

    // ==================================================================
    // 引擎（单例，挂在 window 的 Symbol 键上）
    // ==================================================================
    const GKEY = Symbol.for('vaimod.net-firewall');

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
      // ---------- 配置（存 ctx.store：随插件启用状态保留；卸载插件会连它一起清掉） ----------
      const sanitizeHost = (raw) => {
        if (typeof raw !== 'string') return null;
        const s = raw
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[/?#].*$/, '');
        if (!s || s.length > LIMITS.maxHostLen) return null;
        if (!HOST_RE.test(s)) return null;
        if (s.indexOf('..') >= 0) return null;
        return s;
      };

      const sanitizeList = (raw) => {
        if (!Array.isArray(raw)) return [];
        const out = [];
        const seen = {};
        for (let i = 0; i < raw.length && out.length < LIMITS.maxRules; i++) {
          const h = sanitizeHost(raw[i]);
          if (!h || seen[h]) continue;
          seen[h] = 1;
          out.push(h);
        }
        return out;
      };

      const storedMode = ctx.store.get(KEY.mode, 'off');
      let mode = storedMode === 'watch' || storedMode === 'enforce' ? storedMode : 'off';
      const storedRules = ctx.store.get(KEY.rules, { block: [], allow: [] }) || {};
      let rules = { block: sanitizeList(storedRules.block), allow: sanitizeList(storedRules.allow) };
      let blockExfil = ctx.store.get(KEY.exfil, false) === true;

      // ---------- 站点上下文（同源 / 同族域名一律不进判定链） ----------
      const pageHost = location.hostname || '';
      const pageFamily = (() => {
        const p = pageHost.split('.');
        return p.length >= 2 ? p.slice(-2).join('.') : pageHost;
      })();
      const pageFamilyIsDomain = /[a-z]/i.test(pageFamily);
      const originPrefix = location.origin === 'null' ? '' : location.origin;

      const quickSkip = (url) => {
        const c = url.charCodeAt(0);
        if (c === 47 /* / */ || c === 35 /* # */ || c === 63 /* ? */) return true;
        if (originPrefix && url.indexOf(originPrefix) === 0) return true;
        if (c === 100 /* d */ && url.indexOf('data:') === 0) return true;
        if (c === 98 /* b */ && (url.indexOf('blob:') === 0 || url.indexOf('about:') === 0)) return true;
        return false;
      };

      const safeHost = (url) => {
        try {
          return new URL(url, location.href).hostname || '';
        } catch (e) {
          return '';
        }
      };

      /** 规则匹配：`example.com` 含子域；`*.example.com` 仅子域 */
      const domainMatch = (host, rule) => {
        const h = host.toLowerCase();
        const r = String(rule).trim().toLowerCase().replace(/^\.+/, '');
        if (!r) return false;
        if (r.slice(0, 2) === '*.') {
          const base = r.slice(2);
          return h.length > base.length && h.lastIndexOf('.' + base) === h.length - base.length - 1;
        }
        if (r.charAt(0) === '*') {
          const tail = r.slice(1);
          return h.length >= tail.length && h.lastIndexOf(tail) === h.length - tail.length;
        }
        return h === r || (h.length > r.length && h.lastIndexOf('.' + r) === h.length - r.length - 1);
      };

      const inList = (host, list) => {
        for (let i = 0; i < list.length; i++) if (domainMatch(host, list[i])) return true;
        return false;
      };

      const fmtBytes = (n) =>
        n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

      /**
       * 数据外传启发式：返回特征说明（空串 = 无特征）。
       * 只做「够用就好」的廉价判断 —— 不解析 JSON 树、不做正则回溯，单次开销是几次字符比较。
       */
      const exfilNote = (url, body) => {
        let size = 0;
        let raw = '';
        if (typeof body === 'string') {
          raw = body;
          size = body.length;
        } else if (
          body &&
          typeof body === 'object' &&
          typeof body.size === 'number' &&
          isFinite(body.size)
        ) {
          size = body.size;
        }
        if (size >= 8192) return '批量上传 ' + fmtBytes(size);
        if (size < 16) {
          const qi = url.indexOf('?');
          if (qi < 0 || url.length - qi < 48) return '';
        }
        const q = url.indexOf('?');
        const probe =
          (raw.length > 2048 ? raw.slice(0, 2048) : raw) + (q >= 0 ? url.slice(q, q + 512) : '');
        if (probe.length < 24) return '';
        if (/"(?:variables?|cloud[_-]?data|snapshot|saveData|save_data)"\s*:/i.test(probe))
          return '结构疑似变量/存档数据';
        if (/(?:^|[?&"'])(?:variable|variables|snapshot|dump|export|saveData)=/i.test(probe))
          return '参数疑似变量数据';
        return '';
      };

      // ---------- 命中日志（环形缓冲，绝不无限增长） ----------
      const log = [];
      const index = {};
      let hitSeq = 1;
      let blockedCount = 0;
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

      const record = (url, host, method, kind, body, d) => {
        let path = '';
        try {
          path = new URL(url, location.href).pathname;
        } catch (e) {
          path = url.slice(0, 64);
        }
        const k = host + '\u0000' + method + '\u0000' + path + '\u0000' + kind;
        let size = 0;
        if (typeof body === 'string') size = body.length;
        else if (body && typeof body === 'object' && typeof body.size === 'number' && isFinite(body.size))
          size = body.size;

        const existing = index[k];
        if (existing) {
          existing.count += 1;
          existing.bytes += size;
          existing.lastAt = Date.now();
          if (d.blocked) {
            existing.blocked = true;
            blockedCount += 1;
          }
          emitSoon();
          return;
        }
        if (log.length >= LIMITS.maxHosts) {
          const old = log.pop();
          if (old) delete index[old.key];
        }
        const hit = {
          id: hitSeq++,
          host: host,
          url: url.length > LIMITS.maxUrlLen ? url.slice(0, LIMITS.maxUrlLen) : url,
          method: method,
          kind: kind,
          verdict: d.verdict,
          count: 1,
          bytes: size,
          firstAt: Date.now(),
          lastAt: Date.now(),
          blocked: d.blocked,
          note: d.note.length > LIMITS.maxNoteLen ? d.note.slice(0, LIMITS.maxNoteLen) : d.note,
          key: k,
        };
        log.unshift(hit);
        index[k] = hit;
        if (d.blocked) blockedCount += 1;
        emitSoon();
      };

      /** 统一入口：判定 + 记录，返回是否应放行 */
      const inspect = (url, method, body, kind) => {
        try {
          if (!url || quickSkip(url)) return true;
          const host = safeHost(url);
          if (!host) return true;
          // 站点本域与同族（ccw.site 及其全部子域）一律放行且不记录
          if (host === pageHost) return true;
          if (
            pageFamilyIsDomain &&
            host.length > pageFamily.length &&
            host.lastIndexOf('.' + pageFamily) === host.length - pageFamily.length - 1
          )
            return true;
          if (mode === 'off') return true;

          const note = exfilNote(url, body);
          const enforce = mode === 'enforce';
          let decision;
          if (inList(host, rules.allow)) decision = { verdict: 'allow', note: note, blocked: false };
          else if (inList(host, rules.block))
            decision = { verdict: 'block', note: note, blocked: enforce };
          else if (note) decision = { verdict: 'exfil', note: note, blocked: enforce && blockExfil };
          else decision = { verdict: 'third', note: '', blocked: false };

          record(url, host, method, kind, body, decision);
          return !decision.blocked;
        } catch (e) {
          return true; // 判定期任何异常都放行 —— 防火墙绝不能成为站点的故障点
        }
      };

      // ---------- 装钩子 / 卸钩子（单例：装只有一次） ----------
      const saved = [];
      let installed = false;

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

      const install = () => {
        if (installed || mode === 'off') return;
        installed = true;

        // ① fetch
        if (typeof window.fetch === 'function') {
          hook(window, 'fetch', (origFetch) =>
            function (input, init) {
              try {
                let url = '';
                let method = 'GET';
                let body = null;
                if (typeof input === 'string') url = input;
                else if (typeof URL !== 'undefined' && input instanceof URL) url = input.href;
                else if (input) {
                  url = input.url;
                  method = input.method || 'GET';
                }
                if (init) {
                  if (init.method) method = init.method;
                  if (init.body != null) body = init.body;
                }
                if (!inspect(url, method, body, 'fetch')) {
                  return Promise.reject(new TypeError('VaIMod 防火墙：请求已被拦截'));
                }
              } catch (e) {
                /* ignore */
              }
              return origFetch.call(this, input, init);
            },
          );
        }

        // ② XMLHttpRequest：open 记地址，send 带载荷
        const XP = XMLHttpRequest.prototype;
        const meta = new WeakMap();
        hook(XP, 'open', (origOpen) =>
          function (method, url) {
            try {
              meta.set(this, {
                m: String(method || 'GET'),
                u: typeof url === 'string' ? url : String(url),
              });
            } catch (e) {
              /* ignore */
            }
            return origOpen.apply(this, arguments);
          },
        );
        hook(XP, 'send', (origSend) =>
          function (body) {
            // 本体自己发的请求（云数据直写等）直接透传：不记录、不拦截
            if (!isInternalXhr(this)) {
              try {
                const info = meta.get(this);
                if (info && !inspect(info.u, info.m, body == null ? null : body, 'xhr')) {
                  const xhr = this;
                  // 拒绝：合成一次失败事件。必须走 dispatchEvent ——
                  // 只调 onerror / onreadystatechange 这两个 IDL 属性回调时，
                  // 用 `xhr.addEventListener('error'|'readystatechange'|'loadend', …)`
                  // 注册的调用方（axios 的 XHR adapter、大量手写库）完全收不到通知，
                  // 其 Promise 永不 settle = 请求永久悬挂。
                  // （dispatchEvent 会同时触发 IDL 属性回调，故不必再手动调一次。）
                  setTimeout(() => {
                    try {
                      Object.defineProperty(xhr, 'readyState', { configurable: true, value: 4 });
                      Object.defineProperty(xhr, 'status', { configurable: true, value: 0 });
                      xhr.dispatchEvent(new Event('readystatechange'));
                      xhr.dispatchEvent(new ProgressEvent('error'));
                      xhr.dispatchEvent(new ProgressEvent('loadend'));
                    } catch (e) {
                      /* ignore */
                    }
                  }, 0);
                  return undefined;
                }
              } catch (e) {
                /* ignore */
              }
            }
            return origSend.apply(this, arguments);
          },
        );

        // ③ navigator.sendBeacon（页面关闭时的常见外传通道）
        try {
          const NP = Navigator.prototype;
          if (typeof NP.sendBeacon === 'function') {
            hook(NP, 'sendBeacon', (origBeacon) =>
              function (url, data) {
                try {
                  const u = typeof url === 'string' ? url : url.href;
                  if (!inspect(u, 'POST', data == null ? null : data, 'beacon')) return false;
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

        // ④ WebSocket.send（只观察：绝不替换构造器 —— 替换会改变 instanceof / toString 特征）
        try {
          const SP = WebSocket.prototype;
          if (typeof SP.send === 'function') {
            hook(SP, 'send', (origSend) =>
              function (data) {
                try {
                  const u = this.url;
                  // 已建立的长连接无法安全「拒绝单条消息」（会把连接搞成半死状态）→ 只记不拦
                  if (u) inspect(u, 'WS', data == null ? null : data, 'ws');
                } catch (e) {
                  /* ignore */
                }
                return origSend.apply(this, arguments);
              },
            );
          }
        } catch (e) {
          /* ignore */
        }
      };

      const uninstall = () => {
        if (!installed) return;
        installed = false;
        while (saved.length) {
          const item = saved.pop();
          try {
            // 只在「当前还是我装的那个」时才还原：别的脚本后叠的包装不该被我抹掉
            if (item[0][item[1]] === item[3]) item[0][item[1]] = item[2];
          } catch (e) {
            /* ignore */
          }
        }
      };

      // ---------- 对外 API ----------
      return {
        getMode: () => mode,
        setMode(next) {
          mode = next === 'watch' || next === 'enforce' ? next : 'off';
          ctx.store.set(KEY.mode, mode);
          // off → watch/enforce：钩子还没装则补装；off 不必卸钩子
          // （判定期 mode==='off' 直接放行；卸了再装反而会丢掉别的模块叠加的包装层）
          if (mode !== 'off') install();
          emitSoon();
        },
        getBlockExfil: () => blockExfil,
        setBlockExfil(on) {
          blockExfil = on === true;
          ctx.store.set(KEY.exfil, blockExfil);
          emitSoon();
        },
        readRules: () => ({ block: rules.block.slice(), allow: rules.allow.slice() }),
        sanitizeHost,
        addRule(host, kind) {
          const h = sanitizeHost(host);
          if (!h) return 'bad-host';
          const other = kind === 'block' ? rules.allow : rules.block;
          const oi = other.indexOf(h);
          if (oi >= 0) other.splice(oi, 1); // 黑白互斥：加一边就从另一边移除
          if (rules[kind].indexOf(h) < 0) {
            if (rules[kind].length >= LIMITS.maxRules) return 'full';
            rules[kind].push(h);
          }
          ctx.store.set(KEY.rules, { block: rules.block.slice(), allow: rules.allow.slice() });
          emitSoon();
          return 'ok';
        },
        removeRule(host, kind) {
          const i = rules[kind].indexOf(host);
          if (i < 0) return;
          rules[kind].splice(i, 1);
          ctx.store.set(KEY.rules, { block: rules.block.slice(), allow: rules.allow.slice() });
          emitSoon();
        },
        clearRules() {
          rules = { block: [], allow: [] };
          ctx.store.set(KEY.rules, { block: [], allow: [] });
          emitSoon();
        },
        importRules(raw) {
          let obj = raw;
          if (typeof raw === 'string') {
            try {
              obj = JSON.parse(raw);
            } catch (e) {
              throw new Error('不是合法的 JSON');
            }
          }
          let next;
          if (Array.isArray(obj)) next = { block: sanitizeList(obj), allow: [] };
          else if (obj && typeof obj === 'object') {
            if (!('block' in obj) && !('allow' in obj)) throw new Error('缺少 block / allow 字段');
            next = { block: sanitizeList(obj.block), allow: sanitizeList(obj.allow) };
          } else throw new Error('规则格式无法识别');
          rules = next;
          ctx.store.set(KEY.rules, { block: rules.block.slice(), allow: rules.allow.slice() });
          emitSoon();
          return { block: rules.block.length, allow: rules.allow.length };
        },
        exportRules() {
          return JSON.stringify(
            { name: 'VaIMod 防火墙规则', version: 1, block: rules.block, allow: rules.allow },
            null,
            2,
          );
        },
        readHits: () => log.slice().sort((a, b) => b.lastAt - a.lastAt),
        stats() {
          let hosts = 0;
          for (const k in index) if (Object.prototype.hasOwnProperty.call(index, k)) hosts++;
          return {
            mode: mode,
            hosts: hosts,
            hits: log.length,
            blocked: blockedCount,
            blockRules: rules.block.length,
            allowRules: rules.allow.length,
            installed: installed,
          };
        },
        clearLog() {
          log.length = 0;
          for (const k in index) if (Object.prototype.hasOwnProperty.call(index, k)) delete index[k];
          blockedCount = 0;
          emitSoon();
        },
        subscribe(fn) {
          listeners.push(fn);
          return () => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
        install,
        destroy() {
          if (emitTimer !== null) {
            clearTimeout(emitTimer);
            emitTimer = null;
          }
          listeners.length = 0;
          uninstall();
        },
      };
    }

    // ==================================================================
    // 视图（每个实例一份：常驻实例也有，只是它的 root 不在文档里）
    // ==================================================================
    const MODES = [
      { value: 'off', label: '关闭' },
      { value: 'watch', label: '监视' },
      { value: 'enforce', label: '拦截' },
    ];
    const HINT = {
      off: '不安装任何网络钩子，零开销。',
      watch: '记录发往站外的请求，一律放行。',
      enforce: '命中黑名单的请求会被拒绝。',
    };
    const VERDICT = { block: '黑名单', exfil: '疑似外传', allow: '白名单', third: '第三方' };
    const VERDICT_TONE = { block: 'err', exfil: 'warn', allow: 'ok', third: 'default' };
    const KIND = { fetch: 'FETCH', xhr: 'XHR', beacon: '信标', ws: 'WS' };
    const LOG_SHOWN = 20;

    const hhmmss = (ts) => {
      const d = new Date(ts);
      const p = (n) => (n < 10 ? '0' + n : String(n));
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };

    function createView(eng) {
      let newHost = '';
      const dyn = {};

      const say = (text, err) => {
        if (!dyn.msg) return;
        dyn.msg.textContent = text || '';
        dyn.msg.className = 'nf-msgbox' + (err ? ' nf-msgbox-err' : '');
        dyn.msg.style.display = text ? '' : 'none';
      };

      const renderStats = () => {
        if (!dyn.stat) return;
        const s = eng.stats();
        dyn.stat.textContent =
          '观察 ' + s.hosts + ' 个站外域名 · 规则 ' + s.blockRules + ' 黑 / ' + s.allowRules +
          ' 白 · 已拦截 ' + s.blocked + ' 次';
      };

      const renderRules = () => {
        if (!dyn.rules) return;
        dyn.rules.textContent = '';
        const r = eng.readRules();
        const rows = [];
        for (let i = 0; i < r.block.length; i++) rows.push(['block', r.block[i]]);
        for (let i = 0; i < r.allow.length; i++) rows.push(['allow', r.allow[i]]);
        if (!rows.length) {
          const p = document.createElement('div');
          p.className = 'nf-empty';
          p.textContent = '还没有域名规则：把可疑域名加进黑名单即可在「拦截」模式下拒绝。';
          dyn.rules.appendChild(p);
          return;
        }
        for (const row of rows) {
          const kind = row[0];
          const host = row[1];
          const el = document.createElement('div');
          el.className = 'nf-rule';
          const span = document.createElement('span');
          span.className = 'nf-rule-host';
          span.textContent = host;
          const del = document.createElement('button');
          del.className = 'nf-del';
          del.type = 'button';
          del.textContent = '×';
          del.setAttribute('aria-label', '移除规则');
          del.onclick = () => {
            eng.removeRule(host, kind);
            renderAll();
          };
          el.append(ui.badge(kind === 'block' ? '黑名单' : '白名单', kind === 'block' ? 'err' : 'ok'), span, del);
          dyn.rules.appendChild(el);
        }
      };

      const renderLog = () => {
        if (!dyn.log) return;
        dyn.log.textContent = '';
        const hits = eng.readHits();
        if (!hits.length) {
          const p = document.createElement('div');
          p.className = 'nf-empty';
          p.textContent = '暂无站外请求（站点自身与同族域名不进日志）。';
          dyn.log.appendChild(p);
          return;
        }
        const shown = hits.slice(0, LOG_SHOWN);
        for (const h of shown) {
          const box = document.createElement('div');
          box.className = 'nf-hit' + (h.blocked ? ' nf-hit-blocked' : '');
          const head = document.createElement('div');
          head.className = 'nf-hit-head';
          const host = document.createElement('span');
          host.className = 'nf-host';
          host.textContent = h.host;
          const kind = document.createElement('span');
          kind.className = 'nf-kind';
          kind.textContent = (KIND[h.kind] || h.kind) + ' · ' + h.count + ' 次';
          head.append(
            ui.badge(VERDICT[h.verdict] || h.verdict, VERDICT_TONE[h.verdict] || 'default'),
            host,
            kind,
          );

          const path = document.createElement('div');
          path.className = 'nf-path';
          path.textContent =
            h.method + ' ' + h.url + (h.bytes > 0 ? ' · ' + (h.bytes < 1024 ? h.bytes + ' B' : (h.bytes / 1024).toFixed(1) + ' KB') : '') +
            (h.blocked ? ' · 已拦截' : '') + ' · ' + hhmmss(h.lastAt);

          box.append(head, path);
          if (h.note) {
            const note = document.createElement('div');
            note.className = 'nf-note';
            note.textContent = h.note;
            box.appendChild(note);
          }
          const btns = document.createElement('div');
          btns.className = 'nf-btns';
          btns.append(
            ui.button({
              text: '拉黑',
              kind: 'danger',
              onclick: () => {
                eng.addRule(h.host, 'block');
                say('已拉黑：' + h.host);
                renderAll();
              },
            }),
            ui.button({
              text: '放行',
              kind: 'ghost',
              onclick: () => {
                eng.addRule(h.host, 'allow');
                say('已放行：' + h.host);
                renderAll();
              },
            }),
          );
          box.appendChild(btns);
          dyn.log.appendChild(box);
        }
        if (hits.length > shown.length) {
          const more = document.createElement('div');
          more.className = 'nf-stat';
          more.textContent = '仅显示最近 ' + shown.length + ' 条，共 ' + hits.length + ' 个域名';
          dyn.log.appendChild(more);
        }
      };

      const renderAll = () => {
        renderStats();
        renderRules();
        renderLog();
        if (dyn.hint) dyn.hint.textContent = HINT[eng.getMode()] || '';
      };

      // ---------- 构建 ----------
      const wrap = document.createElement('div');
      wrap.className = 'nf-wrap';

      const hint = document.createElement('div');
      hint.className = 'nf-stat';
      dyn.hint = hint;

      const exfilSw = ui.switch({
        checked: eng.getBlockExfil(),
        label: '拦截数据外传',
        onchange: (on) => eng.setBlockExfil(on),
      });

      const input = ui.input({
        placeholder: 'example.com 或 *.example.com',
        oninput: (v) => {
          newHost = v;
        },
        onenter: () => submit('block'),
      });

      const submit = (kind) => {
        const r = eng.addRule(newHost, kind);
        if (r === 'bad-host') say('域名格式不合法（可写 example.com 或 *.example.com）', true);
        else if (r === 'full') say('规则已达上限（' + LIMITS.maxRules + ' 条）', true);
        else {
          say('已' + (kind === 'block' ? '加入黑名单' : '加入白名单') + '：' + newHost.trim().toLowerCase());
          newHost = '';
          input.value = '';
        }
        renderAll();
      };

      const stat = document.createElement('div');
      stat.className = 'nf-stat';
      dyn.stat = stat;

      const rulesBox = document.createElement('div');
      rulesBox.className = 'nf-rules';
      dyn.rules = rulesBox;

      const logBox = document.createElement('div');
      logBox.className = 'nf-log';
      dyn.log = logBox;

      const msgBox = document.createElement('div');
      msgBox.className = 'nf-msgbox';
      msgBox.style.display = 'none';
      dyn.msg = msgBox;

      const fileEl = document.createElement('input');
      fileEl.type = 'file';
      fileEl.accept = '.json,application/json';
      fileEl.style.display = 'none';
      fileEl.onchange = async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
          say('文件过大（' + Math.round(f.size / 1024) + ' KB），上限 2 MB', true);
          return;
        }
        try {
          const r = eng.importRules(await f.text());
          say('已导入：黑名单 ' + r.block + ' 条、白名单 ' + r.allow + ' 条');
          renderAll();
        } catch (e) {
          say(e && e.message ? e.message : '导入失败', true);
        }
      };

      wrap.append(
        ui.card({
          title: '出网策略',
          children: [
            ui.radioGroup({
              value: eng.getMode(),
              options: MODES,
              onchange: (v) => {
                eng.setMode(v);
                renderAll();
              },
            }),
            hint,
            exfilSw,
          ],
        }),
        ui.card({
          title: '域名规则',
          children: [
            ui.row(
              input,
              ui.button({ text: '加黑名单', kind: 'danger', onclick: () => submit('block') }),
              ui.button({ text: '加白名单', kind: 'ghost', onclick: () => submit('allow') }),
            ),
            rulesBox,
            ui.row(
              ui.button({ text: '导入规则', kind: 'ghost', onclick: () => fileEl.click() }),
              ui.button({
                text: '导出规则',
                kind: 'ghost',
                onclick: () => {
                  const blob = new Blob([eng.exportRules()], { type: 'application/json;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'vaimod-net-firewall-' + Date.now() + '.json';
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                  say('规则已导出为 JSON');
                },
              }),
              ui.button({
                text: '清空规则',
                kind: 'danger',
                onclick: () => {
                  eng.clearRules();
                  say('已清空全部域名规则');
                  renderAll();
                },
              }),
            ),
            fileEl,
          ],
        }),
        ui.card({
          title: '出网日志',
          children: [
            stat,
            logBox,
            ui.row(
              ui.button({
                text: '清空日志',
                kind: 'danger',
                onclick: () => {
                  eng.clearLog();
                  renderAll();
                },
              }),
            ),
          ],
        }),
        msgBox,
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
    // 实例生命周期：拿单例引擎 → 建视图 → 退订 + 引用计数归零时销毁
    // ==================================================================
    const G = slot();
    // 上一个实例刚走、销毁还挂在延后队列里？新实例接管 → 撤掉那次销毁。
    // （标签页切换必然产生一次 refs 归零，见 cleanup 里的说明。）
    if (G.pending) {
      clearTimeout(G.pending);
      G.pending = 0;
    }
    if (!G.engine) G.engine = createEngine();
    const eng = G.engine;
    G.refs++;

    // headless 常驻实例的 root 不在文档里：UI 建出来也看不见，
    // 但它照样能工作（渲染函数写进游离 DOM），所以不做区分 —— 逻辑只有一条路径。
    const view = createView(eng);
    eng.install(); // 幂等：mode==='off' 时不装任何钩子

    const unsub = eng.subscribe(() => view.render());

    // refresh 段与 code 段不共享闭包：把重渲染入口挂在 root 上给它用
    ctx.root.__nfRender = () => view.render();

    return function cleanup() {
      unsub();
      view.destroy();
      try {
        delete ctx.root.__nfRender;
      } catch (e) {
        /* ignore */
      }
      G.refs--;
      if (G.refs > 0) return;
      G.refs = 0;
      // ⛔ 绝不在这里**同步**销毁引擎（原因见 HANDOFF_GRACE_MS 的注释）：
      // 切标签页必然产生一次 refs === 0，而新实例是异步挂载的、几十毫秒后才到。
      // 同步销毁 → 每切一次页就重建引擎、清空出网日志。
      //
      // 等过宽限期再销毁：新实例若已接管（撤掉这次计时器），引擎与日志原样续上；
      // 真正停用/卸载插件时没有新实例，宽限期一到就照常卸钩子、清引擎。
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
    const fn = ctx.root && ctx.root.__nfRender;
    if (typeof fn === 'function') fn();
  },
});
