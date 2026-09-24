<script lang="ts">
  // ===== 插件页渲染器 =====
  // 每个插件对应一个动态 Tab；本组件负责：
  //   ① 把插件 css 限定作用域注入（只影响本容器）
  //   ② 渲染插件 html
  //   ③ 执行插件 code，并注入受控 ctx（store / settings / variables / toast）
  //   ④ 设置项变化时重建（settings 作为 ctx 的输入，变化即重跑 code）
  import { onDestroy, untrack } from 'svelte';
  import type { InstalledPlugin, PluginContext, PluginProjectApi } from '../core/plugins';
  import { runPluginBoot, runPluginRefresh, makePluginStore, pluginRegistry } from '../core/plugin-registry';
  import { createPluginUI } from '../core/plugin-ui';
  import { scopeCss } from '../core/plugin-css';
  import {
    getAliasConfig,
    setAliasConfig,
    exportAliasConfig,
    clearAliasConfig,
    setAliasEnabled,
    aliasStats,
    subscribeAliasConfig,
  } from '../core/alias-config';
  import {
    firewallMode,
    firewallStats,
    firewallHits,
    firewallRules,
    addFirewallRule,
    removeFirewallRule,
    subscribeFirewall,
  } from '../core/net-firewall';
  import type { ScratchVaIMod } from '../core';

  let {
    plugin,
    variables,
    defer = true,
    projectApi,
    onToast,
    onWrite,
    waitVm,
    headless = false,
  }: {
    plugin: InstalledPlugin;
    variables: ScratchVaIMod[];
    /** 异步挂载（默认，对齐全局 loadMode）：html 注入 + code 执行挪出切页关键路径 */
    defer?: boolean;
    /** 作品能力面（bridge 背书的窄面：导出/捕获） */
    projectApi: PluginProjectApi;
    onToast?: (text: string, kind: 'ok' | 'err') => void;
    onWrite?: (variableId: string, value: unknown, targetId?: string) => void;
    /**
     * 等 vm 就绪（供插件 async.waitVm 使用）；true=就绪、false=超时/出错。
     * 未注入时声明了 waitVm 的插件按加载失败处理（宁可不跑，也不带着空数据产生副作用）。
     */
    waitVm?: (timeoutMs: number) => Promise<boolean>;
    /**
     * 常驻无界面模式（供 async.lazy === false 的扩展使用）：不渲染宿主节点、
     * 不注入 html/css，root 用游离 div —— code 照常执行（订阅 / 定时器 / 写变量
     * 都走同一套 ctx 通道），只是没有可见界面。
     */
    headless?: boolean;
  } = $props();

  let hostEl: HTMLElement | undefined = $state();
  let runtimeFailed = $state('');
  /** 异步装载中（async.waitVm / async.load 阶段）：标签页内显示等待态而非空面板 */
  let pluginBooting = $state(false);
  // headless：root 是游离节点（不进文档树），因此不产生任何面板 DOM。
  // 用 $derived 包一层：headless 是 props 常量，这样做只是避免在模块初始化期就读 props。
  const headlessRoot = $derived(headless ? document.createElement('div') : undefined);

  /**
   * 净化插件 HTML（防御性）：插件 html 可能来自分享的配置包 / 被篡改的 localStorage，
   * 属于不可信输入。这里剥掉「自带执行能力」的部分——脚本类元素、`on*` 事件属性、
   * `javascript:` / `data:text/html` URL——只保留静态标记与样式属性。
   * 契约：插件 html 是声明式结构，交互一律写进 code（ctx.ui / addEventListener）。
   * 用 DOMParser 解析而不是正则拼接，避免属性畸形被绕过。
   */
  /**
   * 插件 HTML 清洗（纵深防御）。
   *
   * 清洗结果**直接返回节点**、由调用方搬运进面板，不再回写 innerHTML 字符串：
   * 「解析 → 取 innerHTML → 再赋给 innerHTML」会让浏览器把序列化结果重新解析一遍，
   * 这一轮往返可能把原本是文本的内容重新解读成标记（mXSS），使上一步已删除的标签/属性
   * 复活。搬运节点没有这次重新解析，该类绕过从根上不成立。
   *
   * 注：插件本就可通过 code/refresh 执行任意代码（见 plugin-registry 的说明），
   * 因此这里是**纵深防御**（挡住内联事件与脚本标签带来的意外执行），不是插件沙箱边界。
   */
  function sanitizePluginHtml(html: string): DocumentFragment | null {
    if (!html) return null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // 可执行脚本 / 可加载外部资源 / 可改写文档结构 的标签一律移除
      for (const el of Array.from(
        doc.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,link,meta,base,form,portal,noscript'),
      )) {
        el.remove();
      }
      // 属性清洗：on* 事件处理器全删；承载「可执行协议」的 URL 属性按值过滤
      const BAD_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:application\/xhtml)/i;
      const URL_ATTRS = new Set([
        'href',
        'src',
        'xlink:href',
        'action',
        'formaction',
        'poster',
        'background',
        'dynsrc',
        'lowsrc',
        'ping',
        'srcdoc',
        'data',
      ]);
      for (const el of Array.from(doc.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          const n = attr.name.toLowerCase();
          if (n.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }
          if (URL_ATTRS.has(n) && BAD_URL.test(attr.value)) el.removeAttribute(attr.name);
        }
      }
      const frag = doc.createDocumentFragment();
      frag.append(...Array.from(doc.body.childNodes));
      return frag;
    } catch {
      return null;
    }
  }

  // 设置值快照：设置页改动 → registry 通知 → 这里重算 → 触发重建。
  // 注册表任意事件都会广播（其它插件安装/启停等），这里按「本插件设置签名」过滤：
  // 只有本插件设置真变化才 settingsVer++，无关事件零重建。
  let settingsVer = $state(0);
  const settingsSig = (): string => JSON.stringify(pluginRegistry.settingsOf(plugin.def.id));
  let lastSettingsSig = settingsSig();
  const unsubRegistry = pluginRegistry.subscribe(() => {
    const sig = settingsSig();
    if (sig === lastSettingsSig) return;
    lastSettingsSig = sig;
    settingsVer = settingsVer + 1;
  });
  const pluginSettings = $derived.by(() => {
    void settingsVer;
    return pluginRegistry.settingsOf(plugin.def.id);
  });

  // 变量变化 → 直接通知插件订阅者。
  // ⚠️ 不要拆成「A 读 variables 写 varVer + B 读 varVer 通知」两段 effect：
  //    varVer 会被同一 effect 读+写形成自我依赖，Svelte 5 下无限自激，
  //    抛 effect_update_depth_exceeded 并打死面板局部响应式（round12 排查结论）。
  const varListeners = new Set<() => void>();
  $effect(() => {
    void variables;
    for (const fn of [...varListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  });

  // ---------- 插件 CSS 作用域限定 ----------
  // 实现抽到 core/plugin-css.ts（设置页的 settingsCss 也走同一套前缀与 at-rule 规则，
  // 两处若各留一份拷贝，修了一处漏一处 —— 那正是上一版 @media 后门的成因）。


  // 作用域 id 跟随插件定义（插件被同 id 升级替换时跟着变，强制重建样式）
  // 注意：scopeCss 已给每条选择器加 #scopeId 前缀，这里绝不能再包一层
  // `#scopeId{...}`——会变成 CSS 嵌套规则（#scopeId{#scopeId .go{…}}），解析失败全丢。
  const scopeId = $derived(`vmp-${plugin.def.id}`);
  const scopedCss = $derived(scopeCss(plugin.def.css, `#${scopeId}`));

  // 插件样式注入：绝不能用 Svelte <style> 块（编译器把组件 <style> 提取为
  // 编译期静态 CSS，动态表达式进去是死文本 → 规则全丢；且会注入 document.head
  // 泄露到页面）。改为运行时手动 <style> 元素挂在 .svp-plugin-host 内
  // （Shadow DOM 内部不泄露），随组件销毁 / css 变更重建。
  let wrapEl: HTMLElement | undefined = $state();
  let styleEl: HTMLStyleElement | null = null;
  $effect(() => {
    const w = wrapEl;
    if (!w) return;
    const css = scopedCss;
    if (!styleEl || !styleEl.isConnected) {
      styleEl?.remove();
      styleEl = document.createElement('style');
      w.appendChild(styleEl);
    }
    styleEl.textContent = css;
    return () => {
      styleEl?.remove();
      styleEl = null;
    };
  });

  // ---------- 运行插件 code ----------
  let cleanupFn: (() => void) | null = null;
  // 本次 boot 是否仍然有效：async code 可能在 teardown 之后才落定，
  // 那时它再注册的订阅若被接受，就会挂进已清空的 varListeners 并操作已销毁的 DOM。
  let alive = false;
  // boot 时的 ctx：refresh 钩子复用同一实例（ctx.variables() 等读取是实时的，
  // 返回的是当前 prop 快照）。文档约定：refresh 里不要重新订阅。
  let bootCtx: PluginContext | null = null;
  // 插件对本体 ctx 能力面（本地重命名 / 网络防火墙）的订阅：随 teardown 统一退订，
  // 插件忘了退也不泄漏。
  const ctxUnsubs = new Set<() => void>();

  function buildCtx(root: HTMLElement): PluginContext {
    return {
      root,
      store: makePluginStore(plugin.def.id),
      settings: pluginSettings,
      onSettings(cb) {
        // teardown 之后（异步 code 迟到落定）不再接受新订阅
        if (!alive) return () => {};
        // 独立签名跟踪（不复用主订阅的 lastSettingsSig：监听顺序不保证），
        // 只有本插件设置真变化才回调，注册表无关广播（其它插件启停）不打扰插件
        let last = settingsSig();
        return pluginRegistry.subscribe(() => {
          const sig = settingsSig();
          if (sig === last) return;
          last = sig;
          cb(pluginRegistry.settingsOf(plugin.def.id));
        });
      },
      variables() {
        // untrack：code 运行期读变量只是「取快照」，不应把重建 effect 绑死在
        // 变量轮询上（否则每次轮询都整页重建插件 DOM）；变更通知走 onVariables。
        return untrack(() =>
          variables.map((v) => ({
            id: v.id,
            name: v.name,
            kind: v.kind,
            value: v.value,
            isCloud: v.isCloud,
            targetId: v.targetId,
            targetName: v.targetName,
            isLocked: v.isLocked,
          })),
        );
      },
      onVariables(cb) {
        // 同上：teardown 后拒绝注册（否则监听器活在已清空的集合外，永久泄漏）
        if (!alive) return () => {};
        varListeners.add(cb);
        return () => varListeners.delete(cb);
      },
      write(variableId, value, targetId) {
        onWrite?.(variableId, value, targetId);
      },
      // 作品能力面：bridge 背书的窄面（sb3/sprite3 导出、角色打包、loadProject 捕获）
      project: projectApi,
      // 本地重命名配置（仅显示层）：插件可以按自己的字典生成中文名配置并导入，
      // 但拿不到任何写变量/改变量名的通道 —— 语义上就不可能「新建变量」。
      alias: {
        get: () => getAliasConfig(),
        stats: () => aliasStats(),
        importConfig: (raw: unknown) => setAliasConfig(raw),
        exportConfig: () => exportAliasConfig(),
        clear: () => clearAliasConfig(),
        setEnabled: (on: boolean) => setAliasEnabled(on),
        subscribe(cb) {
          // teardown 后拒绝注册，避免异步 code 迟到落定时挂进已销毁的上下文
          if (!alive) return () => {};
          const unsub = subscribeAliasConfig(cb);
          ctxUnsubs.add(unsub);
          return () => {
            ctxUnsubs.delete(unsub);
            unsub();
          };
        },
      },
      // 网络防火墙：观察面 + 管理用户自己的域名规则（不含「直接放行/拦截」开关）
      firewall: {
        mode: () => firewallMode(),
        stats: () => firewallStats(),
        hits: () => firewallHits(),
        rules: () => firewallRules(),
        addRule: (h: string, k: 'block' | 'allow') => addFirewallRule(h, k),
        removeRule: (h: string, k: 'block' | 'allow') => removeFirewallRule(h, k),
        subscribe(cb: () => void) {
          if (!alive) return () => {};
          const unsub = subscribeFirewall(cb);
          ctxUnsubs.add(unsub);
          return () => {
            ctxUnsubs.delete(unsub);
            unsub();
          };
        },
      },
      // UI 样式接口：组件工厂 + 面板内确认框（挂在面板所在 ShadowRoot）
      ui: createPluginUI({
        toast: (text, kind = 'ok') => onToast?.(text, kind === 'info' ? 'ok' : kind),
        getOverlayHost: () => root.getRootNode(),
      }),
      toast(text, kind = 'ok') {
        onToast?.(text, kind);
      },
      id: plugin.def.id,
      extra: plugin.def.extra,
    };
  }

  function teardown() {
    alive = false;
    // 必须复位：本组件在 `{#key activeTab:bodyAnimKey}` 里，插件被同 id 升级替换 /
    // 切换标签页都会走 teardown → 新 boot 若走同步路径就不再回调 onBooting，
    // 「插件加载中…」会永久挂在页面上（code 其实已经在跑）。
    pluginBooting = false;
    if (cleanupFn) {
      try {
        cleanupFn();
      } catch {
        /* ignore */
      }
      cleanupFn = null;
    }
    bootCtx = null;
    varListeners.clear();
    for (const unsub of ctxUnsubs) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    ctxUnsubs.clear();
  }

  /**
   * 面板「刷新」按钮触发（父组件经 bind:this 调用）：
   * 执行插件声明的 refresh 钩子；未定义则 no-op（面板自身照旧重播进入动画）。
   */
  export function refresh(): void {
    if (bootCtx) runPluginRefresh(plugin.def, bootCtx);
  }

  // 挂载/设置变化/插件替换时：重建内容并重跑 code
  $effect(() => {
    // 依赖：宿主元素、插件定义、设置快照
    const el = headless ? headlessRoot : hostEl;
    void plugin.def;
    void pluginSettings;
    if (!el) return;
    teardown();
    runtimeFailed = '';
    const boot = () => {
      // 搬运清洗后的节点（不经过 innerHTML 字符串回写，见 sanitizePluginHtml 说明）。
      // headless 模式没有可见界面，html 一律不注入（只跑 code）。
      const frag = headless ? null : sanitizePluginHtml(plugin.def.html || '');
      el.replaceChildren();
      if (frag) el.appendChild(frag);
      alive = true;
      try {
        const ctx = buildCtx(el);
        bootCtx = ctx;
        // 异步加载定义（def.async：waitVm → load → code）。未声明 async 时
        // runPluginBoot 内部直接走 runPluginCode，时序与旧版完全一致（不引入异步边界）。
        cleanupFn = runPluginBoot(plugin.def, ctx, {
          waitVm,
          onBooting(booting) {
            // teardown 之后（迟到落定）不再改 UI 状态
            if (!alive) return;
            pluginBooting = booting;
          },
          onFail(msg) {
            if (!alive) return;
            runtimeFailed = msg;
          },
        });
      } catch (err) {
        runtimeFailed = err instanceof Error ? err.message : String(err);
      }
    };
    if (!defer) {
      boot();
      return () => teardown();
    }
    // 异步挂载（defer，对齐 switchTab 双 rAF + 40ms 兜底）：插件的 html 注入与
    // code 执行挪出切页关键路径，重插件的同步初始化不再卡住标签页切换动画。
    // 兜底先到先执行（rAF 在无头/后台可能长时间不触发），done 保证只跑一次。
    let done = false;
    let raf1 = 0;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bootOnce = () => {
      if (done) return;
      done = true;
      boot();
    };
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf1 = raf(() => {
        raf2 = raf(bootOnce);
      });
      timer = setTimeout(bootOnce, 40);
    } else {
      timer = setTimeout(bootOnce, 0);
    }
    return () => {
      done = true;
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (timer !== undefined) clearTimeout(timer);
      teardown();
    };
  });

  onDestroy(() => {
    unsubRegistry();
    teardown();
  });
</script>

{#if !headless}
  <div class="svp-plugin-host" id={scopeId} bind:this={wrapEl}>
    {#if runtimeFailed}
      <p class="svp-plugin-fail">插件运行失败：{runtimeFailed}</p>
    {:else if pluginBooting}
      <p class="svp-plugin-loading">插件加载中…</p>
    {/if}
    <div bind:this={hostEl} class="svp-plugin-root"></div>
  </div>
{/if}
