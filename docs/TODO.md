# VaIMod 待办清单

> 更新于 2026-09-22。做完一项就在标题后标 `[已完成 <commit>]`，别删条目。
> 相关文档：`配置文件说明.md`（配置包格式）、`插件开发文档.md`（插件 API）、`cave-vars.json`（cave 逆向字典）。

---

## P0 · 面板宽度棘轮修复的补充复验 `[已完成]`

**代码已改并提交，但只复验了「不再变宽」这一半。**

### 根因（已确认）

`.svp-tab { flex: 1 }` 会把每个 Tab 拉伸填满整行 → 此时 `scrollWidth === 被拉伸后的宽度`。
而 `autoFitWidth` 原来拿 `Σ tab.scrollWidth` 当「标签栏自然宽度」，于是：

```
natural ≡ 面板当前宽度 + 常量(≈4px)
```

判定 `natural > curW + 1` **恒成立** → 每跑一次就把面板写宽 3~5px，而且写完更宽、下次算出来又更大 →
**永不收敛的棘轮**。触发点：任何改变 Tab 集合的操作（切 Tab 显隐、装卸插件、「恢复默认设置」把 Tab 恢复成默认 3 个）。

实测（修复前，`diag-reset-width2.mjs`）：

```
T1 显示标签页 → 407    T2 隐藏 → 410    T3 显示 → 415    T4 隐藏 → 419
```

### 已做的修复

- `src/ui/VaIModPanel.svelte`：
  - 新增 `textWidth()` —— canvas `measureText` + 逐 Tab 的 padding/border 相加，**零 DOM 零布局**地算出真实文本宽
  - `autoFitWidth` 改用该度量；`natural` 现在对同一组 Tab 是**常量**
  - 新增 `lastAutoFitW` + `canShrink` 门控：只有「当前宽度确实是上一次自动适配写的值」才允许回缩；
    用户手动拉过的宽度（`userSized` / 落盘恢复 / 拖拽手柄）一律只增不减
  - 拖拽手柄起手处 `lastAutoFitW = 0`（用户接管宽度）

### 复验与后续发现（2026-09-24）

补验多 Tab 撑宽路径时又挖出**两个真 bug**，都已修：

1. **右停靠面板永远撑不宽**：`room` 只算了「面板左缘到视口右边」的空间，
   而默认面板是 `right:18px` 右锚定（宽度增加向左伸展）→ `room ≈ 面板自身宽度` →
   `want` 恒等于当前宽度 → 判定「已够宽」直接 return。
   现象：装到第 9~10 个 Tab 后标签栏被挤爆，面板死也不撑宽（`inline=(empty)`）。
   修法：按**锚定侧**取空间 —— 右锚定用 `rect.right - 8`，左锚定用 `innerWidth - rect.left - 8`。
2. **`flex: 1` 等分导致长名 Tab 文字溢出**：`flex:1` = `1 1 0%`，每个 Tab 分到**完全相同**的宽度，
   与文字长短无关 → 10 个 Tab 挤在 535px 里每个只有 49px，而「变量批量重命名助手」需要 121px
   （实测 3/10 溢出，同时短名 Tab 留着大片空白）。
   修法：`.svp-tab { flex: 1 1 auto; white-space: nowrap }` —— 以自身内容宽为基准再均分剩余空间。

### 复验结果（全过）

- `diag-reset-width2.mjs`：反复点「恢复默认设置」4 次 + 反复切 Tab 显隐 4 次 →
  `offset` 恒 400、`inline=(empty)` → 棘轮消失。
- `diag-autofit-wide.mjs` **9/9**：5 内置 Tab → 装 5 插件到 10 Tab →
  面板 400 → 476 → **535 = natural**，`over=0/10`（无 Tab 文字溢出）；
  切 Tab 显隐反复来回宽度收敛不棘轮；同时审计 `canvas vs DOM span`：**每一条 canvas/dom = 1.00**
  （证明 canvas 度量与浏览器真实排版一字不差，不是偏小才导致截断）。
- `probe-ui-guard.mjs` 26/26、`probe-paneldrag.mjs` 8/8。

### 补正项（仍待做，当前不触发）

若以后给 `.svp-tab` 加 `letter-spacing`，canvas 度量**不含**字距 →
需按 `letterSpacing × 字符数` 补进 `textWidth()`。当前无 letter-spacing，不需要。

**排查陷阱**：`diag-autofit-wide.mjs` 最初一直「Tab 都点得动但宽度不变」，
真因是**面板默认是收起态（悬浮球）**：`minimized=true` 时 `autoFitWidth` 全程早退，
而合成事件在隐藏元素上照样生效 → 造成「功能正常但不撑宽」的假象。
任何涉及面板几何的探针都必须**先点 `.svp-fab` 展开面板**再测量。

---

## P1 · JSON 配置系统：本地重命名（用户明确要求）`[已完成]`

> 用户原话：「你写的安全变量JSON 应该是本地重命名变量不是新建！完善一下 JSON 配置系统」

### 语义（不能走偏）

配置 JSON 表达的是**本地显示重命名规则**：
**绝不新建变量、绝不改作品里的变量名** —— 对项目零影响，也不会被敌扩展的改名/新建检测盯上。

### 现状盘点（已查证）

| 事实 | 位置 |
|---|---|
| 已有本地别名存储 | `src/core/display-names.ts`，键 = **`v:<targetId>:<变量id>`**（按 id，不是按名） |
| 变量页已支持显示别名 + 「恢复原名」 | `src/ui/VaIModItem.svelte` 的 `displayName` prop |
| 配置包里的 `displayNames` 直接搬这个 store | `src/core/bundle.ts`（导出 `loadDisplayNames()`、导入 `saveDisplayNames()`） |
| **文档写错了** | `docs/配置文件说明.md` 第一节写 `displayNames: { "真实变量名": "显示名" }`，实际键是 `v:<targetId>:<id>` → 要改文档 |

**结论**：配置 JSON 必须能**按真实变量名**写（人可读、可手改、加载时机早于拿到 id），
所以要在 `display-names` 之前加一层「按名匹配的规则表」。

### 设计（已定，照此实现）

- 新模块 **`src/core/alias-config.ts`**
  - 存储键运行时拼接（对齐 `display-names.ts` 的 stealth 习惯）：`['vai','mod','_alias','cfg'].join('')`
  - 结构：
    ```json
    {
      "version": 1,
      "name": "cave.io 中文变量名",
      "source": "plugin-cave-helper",
      "rules": [{ "match": "n95~]F1M+?", "label": "实体血量表", "scope": "Stage", "note": "…" }]
    }
    ```
  - `normalizeAliasConfig(raw)` 兼容四种输入：
    ① 原生 `rules`
    ② **`cave-vars.json` 的 `{ variables: [{ name, label, scope, … }] }`**（直接可导）
    ③ `{ displayNames: { … } }`
    ④ 扁平 `{ "真实名": "本地名" }`
  - `resolveAlias(realName, targetName)`：按 `scope`（`Stage` / `player` / `any`）匹配，exact 优先
  - `loadAliasConfig / setAliasConfig / clearAliasConfig / aliasStats / subscribeAliasConfig`
  - 净化：非字符串键值一律丢弃（对齐 `display-names.ts` 踩过的坑：
    非字符串别名流入 `(x ?? name).toLowerCase()` 会抛 TypeError 直接中断列表渲染）
  - **本模块只读不写 vm**：不 import 任何 vm/bridge，从类型层面杜绝「新建变量」
- 显示优先级：**手动别名（按 id）> 规则表（按名）> 原名**
- 变量页搜索：同时命中别名与真实名；`#svv# 值`搜索不受影响
- 「恢复原名」按钮：需同时清掉按 id 的手动别名与规则表命中（或标明来源）

### UI

- 设置覆盖层新增「本地重命名」区：启用开关 / 导入 JSON / 导出 JSON / 清空 / 命中条数
  （导入走系统页既有的 `fileInputEl` 手法；文件名与来源在提示里说明）
- 变量页显示名落地在 `VaIModPanel.svelte` 的 `displayName={…}` 一处

### cave 插件联动

`docs/plugin-cave-helper.js` 新增按钮「把变量名本地改中文」：
用自带的 37 条 `VARS` 字典生成 alias JSON 并导入 → 用户直接在变量页读中文名。
（同理可把 `docs/cave-vars.json` 当配置文件直接导入验证两种格式都吃）

### 探针 `probe-alias-config.mjs`（关键断言）

1. 导入配置后变量**显示名**变化
2. **作品里的变量真实名 / 变量个数 / 变量 id 完全未变**（证明只是本地显示，没新建、没改名）
3. 搜索命中别名
4. 清空后恢复原名
5. 非法输入（数组、null、非字符串值、超长字段）被拒且不污染存储
6. 导出 → 再导入往返一致

### 文档

- `docs/配置文件说明.md`：修正 `displayNames` 的键形态；新增「本地重命名配置」章节（含从 `cave-vars.json` 导入的示例）

---

## P2 · 「优化所有 UI + 增强安全性 + 优化性能」（进行中）

### 性能（已完成，结论 + 证据如下，别再从头猜）

**方法论纠错（最重要的产出）**：「主线程停顿计」（10ms 定时器实测间隔）在本无头环境**不可作为判据** ——
它把布局/绘制/软件光栅化也算成停顿。三条证据：

- 打开 `prefers-reduced-motion` 关掉切页进入动画后，停顿几乎不变（64/44/43ms → 62/36/33ms）；
- 同期 CDP CPU profiler 显示真 JS 只有 ~5ms（94% idle）；
- `Performance.getMetrics` 里 `Task − Script` 恒有 30~60ms（差额就是非 JS 部分）。

**曾因此误判**「系统页自动初始快照冻结主线程」并追了两轮 —— 是幻影。
已把 `probe-snapshot-freeze.mjs` 换成 `probe-tab-switch-cost.mjs`：判据改为 CDP `ScriptDuration` 增量，
停顿计只作参考输出，文件头写明这段教训。

**真实分布**（900 变量，本机 Edge headless，CDP ScriptDuration）：

| 场景 | 真 JS |
|---|---|
| 后台基线（1500ms 空窗，不点任何东西） | **3~14ms** → 常驻轮询不是元凶 |
| 重复切页 | 变量 ~38ms ｜ 云数据 ~14ms ｜ 系统 ~31ms |
| 面板首次展开（变量页首挂载） | 36~62ms（一次性） |

→ **变量页最重、且随变量数增长**，就是「面板有时卡一下」的主要来源。

**已落地的三处削减**：

1. **切页不再把变量表建两遍**（`VaIModPanel.svelte`）：原来 `forceRefresh()` + `getVariables()` 两连击，
   前者内部已重建并 emit 过整份列表，后者又建一遍（6000 变量实测 20ms + 18ms）。
   新增 `ScratchVM.forceRefreshList()` 一次调用带回列表，面板直接复用（返回 null 时保留旧列表，不用空数组覆盖）。
2. **快照取值改整表回读**（`ScratchVM.readVmLiveValues()` + `SystemPanel.captureSnapshot()`）：
   原来逐条 `readVariableValue`，每条都要付 ztna 校验 + `getSecureVm` + 扫 targets 的固定开销 × 变量数。
   实测 2854 变量时 **3.9x** 提速（`diag-snapshot-cost.mjs`），并逐条**对拍两条路径取值一致**（优化未改语义）。
   注：首次测出的「65.6ms / 占 74%」是**冷 JIT 假象**，暖机后只有 11ms —— 教训：性能数字必须暖机后取。
   同时去掉快照里冗余的 `cloneJson`：值出自入站清洗（数组已复制、标量不可变），再深拷一轮是白付。
3. **初始快照移出交互帧**（`SystemPanel.svelte`）：原用 `queueMicrotask`，它在当前任务后、**绘制前**执行，
   正好卡切页首帧；改为 `scheduleIdle`（rIC + setTimeout 双保险，无头环境 rIC 可能不触发）。
   语义不变（同样只在无标记时建一次），只是不抢帧。
4. **滚动/缩放事件合并**（`ui-guard.ts`，2026-09-24）：原来 `scroll`/`resize`/`orientationchange`
   每个事件都跑一次全量巡检 —— 而巡检含 `getBoundingClientRect`（强制布局）+ `elementsFromPoint`
   （命中测试）+ 逐元素 `getComputedStyle`（强制样式重算），一次滚动可上百个事件。改为 ≤80ms 合并，
   **尾随用 `setTimeout` 而不是 rAF**：无头/后台环境 rAF 可能永不触发，丢掉尾随调用会让最后一次
   滚动再也补不上（可见性守卫留缺口）。同批还有 `dom-utils` 的 TreeWalker 包装改为「迭代时判空集」，
   空集是 O(1)，有宿主才付逐节点 `isProtected` 的代价（原来干脆不包装 = 隐藏缺口）。

**本轮改动后的基线重采**（`probe-perf.mjs`，2026-09-24）：

```
{"hiddenReads":0,"hiddenScriptMs":14.9,"hiddenTaskMs":103.3,"hiddenBusyPct":1.29,"catchUpReads":2,
 "idle":{"n":181,"p50":16.7,"p95":16.8,"max":16.8,"janky":0},
 "tab":{"n":36,"p50":16.7,"p95":16.7,"max":16.8,"janky":0},
 "drag":{"n":125,"p50":16.7,"p95":16.8,"max":16.8,"janky":0}}
```

隐藏 8s 内**变量表读取 0 次**（可见性门控有效）+ 主线程忙 1.29% + 空闲/切页/拖拽三场景 **0 掉帧**。

**已排除（别再重复排查）**：

- 常驻轮询（ui-guard 1s / ext-watch 2s / dom-utils 4s / veil-manager 5s）：后台基线仅 3~14ms/1500ms。
- 切页进入动画：只动 `transform` + `opacity`，真机走合成层；无头停顿是软件光栅化伪影。
- 读链规模曲线（`diag-readpath-scale.mjs`）：900→6000 变量 2.5→18ms，且 6s 轮询期间 0 掉帧（摘要未变时提前返回）。
- `ops-meta` 的 JSON.parse（系统页一次挂载 8 次）：实测收益 <20ms，不值当加缓存冒一致性风险。

### 安全性（已完成）

1. ✅ **网络防火墙** `src/core/net-firewall.ts`（见下「网络防火墙」段）
2. 配置导入的规模限制（深度 / 条数 / 字节数）—— `alias-config.ts` 已有 `ALIAS_LIMITS`（规则 5000 / 键 256 / JSON 2MB），
   防火墙规则另有限额；**JSON 深度限制仍缺**（当前靠 `JSON.parse` 原生栈保护）
3. `resolveAlias()` 结果进入模板前当纯文本（已确认走 Svelte 文本插值，无 `innerHTML`）
4. 原型污染键 `__proto__` / `constructor` / `prototype`：`alias-config.ts` 扁平表形态已拒；防火墙规则表同

### 网络防火墙（已完成 · 形态已改为「独立补丁」）

`src/core/net-firewall.ts` + `src/ui/FirewallSection.svelte` + `probe-firewall.mjs`（47/47）。

**形态（用户明确要求：防火墙应该是单独补丁，不是系统内置）**：

- **不是内置 Tab**，不占面板位置 —— 默认面板只有「变量 / 云数据」
- **默认关闭**（`settings.firewall = 'off'`）：关闭态不安装任何网络钩子，零开销、零行为变化
- 配置与日志挂在**设置覆盖层**的「网络防火墙 · 独立补丁」分区里（三态分段 + 外传拦截 + 黑白名单 + 最近 20 条日志）
- 一次性迁移（`TABS_SCHEMA_VER` 2）：旧配置里的 `firewall` Tab 条目被剔除、模式强制归位到 `off`
  —— 旧版的 `watch` 是「内置能力默认打开」的产物，不是用户的显式选择；归位只发生一次

其余能力：

- document-start 钩 `fetch` / `XHR(open+send)` / `sendBeacon` / `WebSocket.send`（只观察，不替换构造器以保住 `instanceof`）
- 三态：关闭（不装任何钩子，零开销）/ 监视（只记录全放行）/ 拦截（仅黑名单命中拒绝）
- 日志天然是「站外」视图：同源、站点同族域名、VaIMod 自身请求都不进日志
- 四种判定：`third` / `block` / `exfil`（疑似变量数据外传）/ `allow`
- 规则可随配置包导出导入（`firewallRules`，缺省时导入不动设备现有规则）
- 插件侧经 `ctx.firewall` 访问（只读统计 + 规则读写，**无任何直通网络的能力**）

### UI

等用户给**具体现象**（用户偏好具体反馈，泛泛「优化 UI」容易白做）。
本轮已附带：变量页 Tab `flex: 1 1 auto` + `nowrap`（长名 Tab 不再溢出）、防火墙分区复用 `.svp-fs-*` 样式族保持视觉一致、
设置页「本地重命名」区文案去修饰（格式说明从常驻正文挪到「导入 JSON」按钮的 `title`，出错时才由错误信息说清）、
防火墙日志在设置页里只列最近 20 条（设置页不是全量审计工具）。

---

## P4 · 默认面板收敛 + 本地重命名默认启用（2026-09-24，已完成）

**用户要求**：默认面板只有「变量」和「云数据」；系统/防火墙/工具/飞书都不是默认面板；本地重命名要处于启用状态。

### 默认面板

- `DEFAULT_ENABLED_TABS` 收敛为 `{vars, ccw}`（原为 vars/ccw/firewall/system）
- `firewall` 从 `BuiltinTabId` 移除 → 旧配置里的该条目会被 `isTabId` 过滤掉
- **新加的内置 Tab 一律默认关闭**（原来「新增内置 Tab 自动补齐并启用」，会让默认面板随版本悄悄变形）
- 一次性迁移 `TABS_SCHEMA_VER = 2` + `tabsVer` 字段：
  - 只重置**内置** Tab 的显隐；插件 Tab 条目与全部条目的相对顺序原样保留（用户拖出来的顺序不该被抹掉）
  - 旧版把 `firewall` 默认开成 `watch`，一并归位为 `off`
  - 迁移结果在 `loadSettings` / `loadSettingsFor` 里顺手落盘，只跑一次（用户后来手动开回来的不会被覆盖）
- 探针 `probe-default-tabs.mjs`（22/22）：全新安装 / 旧配置迁移 / 迁移只做一次 / 自定义顺序保留 / 缺条目默认关闭 / 本地重命名开关

### 本地重命名「启用」语义（真 bug）

`aliasStats().enabled` 原来返回 `c.enabled && c.rules.length > 0` —— 规则为 0 条时开关显示成**关闭**，
看起来像「功能没启用」，实际只是还没导入规则。改为：

- `enabled` = **用户的开关意图**（驱动设置页那个 toggle）
- 新增 `active` = 是否真的在改显示（`enabled && rules > 0`）

### 顺带的安全 / 性能

- **安全**：导入配置文件先看字节数再读内容（> 2MB 直接拒，配置来自任意来源）；规则数超限改为**整份拒绝**而非截断
  （截断会静默留下「半份配置生效」的中间态，最难排查 —— 原注释声明如此但实现是 `break`，属注释与实现不符）
- **性能**：`resolveAlias()` 建**匹配索引**（精确名走 Map O(1)，通配规则单独成表），
  并把 `canonTarget(targetName)` 从「每规则一次」降为「每变量一次 + 单槽记忆」——
  它是每个变量都会走的热路径，5000 条规则 × 900 变量的线性扫描会让变量页卡住
- **性能**：防火墙默认 `off` → 不装钩子（原本 `watch` 会钩住 fetch/XHR/beacon/WS 四个通道）

### 探针基建教训（踩坑记录）

- **`addInitScript` 每次导航都会重放（含 `reload`）**：预置 localStorage 时不加「只播一次」门控，
  reload 后会把预置值又写回去 —— 看起来像「产品把用户的设置改回去了」，实际是自己把盘覆盖了。
  统一做法：`if (!localStorage.getItem('__vaimod_seed')) { …预置…; localStorage.setItem('__vaimod_seed','1'); }`
  （页面级对象如 `window.__ossCalls` 仍要每次导航重设，它们无副作用）
- **默认面板收敛会级联打破多套老探针**：凡是依赖「系统页/飞书页默认可见」的断言，
  都必须在预置里显式开启对应 Tab + 写 `tabsVer:2`，否则会误报成产品 bug


---

## P5 · 全项目审计：已修 / 未修清单（2026-09-24）

对全仓 `src/` 做了逐文件审计（性能 / 安全 / UI / 插件与配置系统），**已修如下**：

| 缺陷 | 位置 | 性质 |
| --- | --- | --- |
| `settingsCss` 不做作用域限定 + 不过滤 `@import` | `SettingsOverlay.svelte` | **安全**：插件可改写整个设置页样式、拉外部样式表 |
| `@media` 内规则整块不加前缀 = 作用域后门 | `plugin-css.ts`（新） | **安全**：一条 `@media{ .svp-header{} }` 就能改全局面板样式 |
| 顶层多余 `}` 把配对深度压成负数 → 整段错位（逃逸块因此生效、`@keyframes` 整段丢失） | `plugin-css.ts` | **安全 + 功能** |
| `getOwnPropertyDescriptor` 违反 Proxy 不变量（冻结/不可写属性上 trap 自抛 TypeError） | `vm-sandbox.ts` | **功能** |
| 匿名函数 / async 箭头被误当「方法简写」→ 拼出 `function function(...)` 语法错误 | `plugins.ts` | **功能**：这类插件 code 完全不执行 |
| `UI_TARGET_CLASSES` 丢了前导点 → 变成标签选择器，class 形态第三方 UI 回滚恒失效 | `secure-guard.ts` | **安全** |
| `MutationObserver.takeRecords()` 未过滤 = 完整旁路（可同步拿到宿主） | `dom-utils.ts` | **安全（隐身）** |
| TreeWalker/NodeIterator 在宿主创建前包装时直接返回 → 早期创建的 walker 永不过滤 | `dom-utils.ts` | **安全（隐身）** |
| 密钥轮换后编码缓存未失效 → 命中旧密钥密文（解出来是垃圾） | `cipher.ts` / `secret-channel.ts` | **正确性** |
| `replaceWith` 可把宿主摘出文档且调用后不回看 → 最长 1s 不可见窗口 | `ui-guard.ts` | **UI 防篡改** |
| 蜜罐 window 陷阱只挡数据属性 → 覆盖页面同名 getter 且 `configurable:false` 永不可恢复 | `honeypot-guard.ts` | **破坏宿主** |
| 蜜罐 `#id` 诱饵造成重复 id（站点 `getElementById` 会拿到我们的隐形节点） | `honeypot-guard.ts` + 两个 guard 消费侧 | **破坏宿主** |
| 拒绝 XHR 只调 IDL 回调 → `addEventListener` 调用方永久挂起（违反自述承诺） | `feishu-guard.ts` | **功能** |
| `wrappedVms.add` 先于安装成功 → 安装失败时 bridge 跳过自己的 tap，捕获链永久为空 | `capture-early.ts` | **功能** |
| `loadProject` 包装未登记 markNative → `Function.prototype.toString.call` 暴露包装源码 | `lp-guard.ts` | **安全（隐身）** |
| `getOwnPropertyDescriptor`… 完整性校验失败的条目被 `persist()` 静默删盘 | `plugin-registry.ts` | **数据**：注释/UI 承诺「保留可修复」 |
| 删除键前缀用 `_` 作分隔符，id 又允许 `_` → 跨插件串写 / 误删 | `plugin-registry.ts` | **数据**（未修，见下） |
| 设置页别名表无变更通知 → 导入配置/清空记忆后已挂载面板留旧名 | `display-names.ts` | **UI 一致性** |
| `ui.check()` 省略 `checked` 时默认勾选（复选框语义反了） | `plugin-ui.ts` | **语义** |
| `pluginBooting` 不在 teardown 复位 → 永久显示「插件加载中…」 | `PluginTab.svelte` | **UI** |
| 角色限定的 `match:'*'` 记 0 分 → 与不限角色同分，由遍历顺序决定 | `alias-config.ts` | **语义** |
| 滚动/缩放每事件全量巡检（命中测试 + getComputedStyle + 布局查询） | `ui-guard.ts` | **性能**：合并到 ≤80ms（setTimeout 尾随，不用 rAF） |

**定位手段**：`probe-plugin-css-scope.mjs`（新，11/11）+ `fixture-css-scope.plugin.js` 是对抗样本，
改 `scopeCss` / 设置页样式注入后**必须**跑它。其余靠既有 256 项基线。

### 未修 → 已收敛（2026-09-24 收尾轮）

首轮列了 9 条「已知识别、暂不触发」，收尾轮**清掉 6 条**，剩 3 条：

**已修（6 条）**

| 原条目 | 修法 | 护栏 |
| --- | --- | --- |
| `PluginManager` 对同一份源码 `parsePluginSource` 两次（顶层副作用跑两遍） | registry 新增 `installParsed(def, src)`；`onFiles` 解析一次后把 def 交回去（`install` 保留原语义，内部改走 `installDef`） | `plugin-test` / `probe-plugin-persist` |
| `ui.confirm` / `ui.modal` 浮层不随插件卸载清理（残留遮罩挡死面板） | `createPluginUI` 登记自己创建的全部浮层，暴露 `dispose()`；`PluginTab.teardown` 统一收（未决 confirm 按「取消」落定，不留 pending Promise） | **新增 `probe-plugin-overlay.mjs` 11/11** + `fixture-overlay.plugin.js`（故意「开了就不关」的坏插件） |
| `secure-cache.enc` 每次读 `secretChannel.salt()`，密钥轮换后已存条目解不回来 | 构造时取一次通道材料，再与本实例 `token` 哈希混合 → 对实例恒定、随实例唯一 | `tsc` + 全量探针无回归 |
| `hookRegister` 无幂等标记，`window.Scratch` 每次赋值再包一层 | 加 `hookedRegisters: WeakSet<object>`，包装失败时撤标记 | `probe-anticheat` 16/16 |
| `functionCodeToString` 的 `load` 段一致性 | `load` 已与 `code`/`refresh` 共用同一函数、同批修好；确认无遗留 | `plugin-test` |
| `probe-perf` 基线未重采 | 已重采：隐藏 8s 变量表读取 **0 次**（回前台 1.5s 补 +2）、主线程忙 **1.75%**、idle/切页/拖拽三场景 **janky = 0**（p95 16.7–16.8ms） | — |

**剩下 3 条（故意不动，各有理由）**

1. **插件私有存储命名空间**：`makePluginStore` 用 `vaimod_plug_${id}_`，`_` 既是分隔符又是
   id 合法字符（`/^[a-z0-9][a-z0-9_-]{1,47}$/`）。`foo` 与 `foo_bar` 两个插件会串写同一条
   key，卸载 `foo` 还会把 `foo_bar` 的私有数据整块删掉。
   修法要动命名空间 = 老用户插件私有数据会丢，**必须先设计「读旧前缀 + 写新前缀」的迁移**再动。
   缓解已落地：文档与 skill 明确要求**插件 id 用 `-` 不用 `_`**。
2. **`sig-guard.purgeMaskStyle` 观察者只订 `attributes:style`**：走 CSSOM（`sheet.insertRule`）
   注入隐藏规则的路径不触发；`secure-guard` 侧同理只订 `childList`（仍有 1s 巡检兜底，存在窗口）。
3. **`dom-utils` 的 live 集合语义**：`children` / `childNodes` / `getElementsBy*` 一旦命中受保护
   节点就返回**静态快照**（且 `childElementCount` 仍按 live 重算 → 两者可能不一致）。
   站点若缓存 `el.children` 再增删后按索引访问会踩到。修法是返回 live facade 代理，属于较大改造。

---

## P3 · 阻塞：GitHub Pages（等用户拍板）

CI 自诊断实测：`VaIMod/VaIMod` 为私有组织仓库、`has_pages=false`、`POST /repos/.../pages` → **403**。
Free 套餐的组织私有仓不能开 Pages → `https://VaIMod.github.io/VaIMod/VaIMod.user.js` 必然 404，与构建无关。
出路：① 转 public ② 升 Team ③ 换托管（CF Pages / Vercel / Netlify）。**等用户拍板，不得自作主张改可见性。**

---

## 已完成

- **2026-09-22 · 面板宽度棘轮**：根因 + 修复 + 复验（见 P0）。`src/ui/VaIModPanel.svelte`
- **2026-09-22 · cave 逆向配置**：`docs/cave-vars.json`（37 条变量 / 数据模型 / 指令协议 / 一键操作映射），与插件 `VARS` 逐条比对 0 冲突
- **2026-09-22 · cave 外挂插件**：`docs/plugin-cave-helper.js` + `probe-cave-plugin.mjs` 27/27
