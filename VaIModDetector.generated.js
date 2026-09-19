/*
 * ============================================================
 *  VaIMod 检测扩展（由生成器自动生成） v1.0.0
 * ============================================================
 *  来源仓库：VaIMod
 *  生成时间：2026/8/24 21:07:11
 *  提取特征：
 *    UI 类名       52 个（svp-fab, svp-fab-hidden, svp-fab-dragging, svp-panel, svp-grow, svp-panel-hidden …）
 *    localStorage  3 个（_p, vaimod.panel.state, _pf）
 *    hook 目标     bind, compilerRegisterExtension
 *  说明：粘贴到 ccw 扩展编辑器保存，或经 Eureka 加载。
 * ============================================================
 */

(function (_Scratch) {
  const { BlockType, translate, extensions, runtime } = _Scratch;

  translate.setup({
    zh: {
      extensionName: 'VaIMod 检测器',
      isVaIModDetected: '检测到 VaIMod？',
    },
    en: {
      extensionName: 'VaIMod Detector',
      isVaIModDetected: 'VaIMod detected?',
    },
  });

  // ===== 生成器提取的特征 =====
  const UI_CLASSES = ["svp-fab","svp-fab-hidden","svp-fab-dragging","svp-panel","svp-grow","svp-panel-hidden","svp-resizing","svp-header","svp-title","svp-title-icon","svp-actions","svp-icon-btn","svp-file-input","svp-toast","svp-toast-err","svp-body","svp-group-title","svp-group-collapsed","svp-group-name","svp-caret","svp-caret-open","svp-group-items","svp-item","svp-item-locked","svp-info","svp-name-row","svp-kind","svp-kind-list","svp-name","svp-controls","svp-input","svp-value-input","svp-lock-btn","svp-lock-on","svp-error","svp-resize-handle","svp-empty","svp-btn","svp-loading","svp-tabs","svp-tab","svp-tab-active","svp-search","svp-actionbar","svp-saveall","svp-ccw-item","svp-ccw-controls","svp-ccw-save","svp-ccw-tabs","svp-ccw-tab","svp-ccw-tab-active","svp-body-content"];
  const STORAGE_KEYS = ["_p","vaimod.panel.state","valmod.panel.state","_pf"];
  const HOOK_TARGETS = ["bind","compilerRegisterExtension"];

  class VaIModDetector {
    constructor(_runtime) {
      this._runtime = _runtime;
      this._detected = false;
      this._vm = null;
      this._vmBaseline = null;
      this._startScan();
    }

    getInfo() {
      return {
        id: 'vaimodDetector',
        color1: '#c62828',
        color2: '#8e1c1c',
        name: translate({ id: 'extensionName' }),
        blocks: [
          {
            opcode: 'isVaIModDetected',
            blockType: BlockType.BOOLEAN,
            text: translate({ id: 'isVaIModDetected' }),
          },
        ],
        menus: {},
      };
    }

    /** 布尔积木：是否检测到 VaIMod */
    isVaIModDetected() {
      return this._detected;
    }

    // ==================== 内部检测 ====================

    _startScan() {
      if (this._scanTimer) return;
      this._scanTimer = setInterval(() => this._scan(), 1000);
      try {
        this._scan();
      } catch {
        /* ignore */
      }
    }

    _docs() {
      const docs = [];
      try {
        const pd = window.parent && window.parent !== window ? window.parent.document : null;
        if (pd) docs.push(pd);
      } catch {
        /* ignore */
      }
      if (typeof document !== 'undefined') docs.push(document);
      return docs;
    }

    _scan() {
      // ① DOM：shadow host 内命中任一提取的 UI 类名
      if (!this._detected) {
        try {
          for (const doc of this._docs()) {
            if (this._findHost(doc)) {
              this._detected = true;
              break;
            }
          }
        } catch {
          /* ignore */
        }
      }
      // ② localStorage：任一提取的键存在
      if (!this._detected) {
        try {
          for (const k of STORAGE_KEYS) {
            if (localStorage.getItem(k) !== null) {
              this._detected = true;
              break;
            }
          }
        } catch {
          /* ignore */
        }
      }
      // ③ vm hook：对比基线
      if (!this._detected) {
        try {
          if (this._checkVmHook()) this._detected = true;
        } catch {
          /* ignore */
        }
      }
      if (this._detected && !this._announced) {
        this._announced = true;
        try {
          console.warn('[VaIModDetector] 检测到 VaIMod 外挂脚本');
        } catch {
          /* ignore */
        }
      }
    }

    _findHost(doc) {
      if (UI_CLASSES.length === 0) return null;
      const selector = UI_CLASSES.map((c) => '.' + c.replace(/[^A-Za-z0-9_-]/g, '\$&')).join(',');
      const probe = (el) => {
        if (!el || typeof el !== 'object') return null;
        try {
          const sr = el.shadowRoot;
          if (sr && sr.querySelector(selector)) return el;
        } catch {
          /* ignore */
        }
        return null;
      };
      try {
        const all = doc.querySelectorAll('div, section, main');
        for (let i = 0; i < all.length; i++) {
          const h = probe(all[i]);
          if (h) return h;
        }
      } catch {
        /* ignore */
      }
      const walk = (node) => {
        if (!node || typeof node !== 'object') return null;
        const h = probe(node);
        if (h) return h;
        try {
          if (node.shadowRoot) {
            const h2 = walk(node.shadowRoot);
            if (h2) return h2;
          }
          if (node.children) {
            const kids = node.children;
            for (let i = 0; i < kids.length; i++) {
              const h3 = walk(kids[i]);
              if (h3) return h3;
            }
          }
        } catch {
          /* ignore */
        }
        return null;
      };
      try {
        return walk(doc.documentElement || doc.body || doc);
      } catch {
        return null;
      }
    }

    _getVms() {
      const vms = [];
      try {
        if (window.vm) vms.push(window.vm);
      } catch {
        /* ignore */
      }
      try {
        if (window.parent && window.parent !== window && window.parent.vm) vms.push(window.parent.vm);
      } catch {
        /* ignore */
      }
      return vms;
    }

    _checkVmHook() {
      if (HOOK_TARGETS.length === 0) return false;
      const vms = this._getVms();
      for (const vm of vms) {
        if (vm === this._vm) {
          try {
            const b = this._vmBaseline;
            if (b) {
              if (b.registerExt && vm.runtime?.compilerRegisterExtension !== b.registerExt) return true;
            }
          } catch {
            /* ignore */
          }
        } else {
          this._vm = vm;
          try {
            this._vmBaseline = {
              registerExt: vm.runtime?.compilerRegisterExtension,
            };
          } catch {
            /* ignore */
          }
        }
      }
      return false;
    }
  }

  extensions.register(new VaIModDetector(runtime));
}(Scratch));
