# VaIMod 待办清单

> 更新于 2026-09-22。做完一项就在标题后标 `[已完成 <commit>]`，别删条目。
> 相关文档：`配置文件说明.md`（配置包格式）、`插件开发文档.md`（插件 API）、`cave-vars.json`（cave 逆向字典）。

---

## P0 · 面板宽度棘轮修复的补充复验

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

### 复验结果（已过）

`diag-reset-width2.mjs`：反复点「恢复默认设置」4 次 + 反复切 Tab 显隐 4 次 →
`offset` 恒 400、`inline=(empty)`（不再写 inline 宽度）→ 棘轮消失。

### 待做

1. **多 Tab 撑宽路径要复验**（新度量若偏小就会回归成「Tab 被 ellipsis 截断」）：
   造 6~8 个插件 Tab，确认面板仍会按真实自然宽撑开、Tab 文字不被截断。
   可跑 `probe-ui-guard.mjs` C 组，或把 `diag-reset-width2.mjs` 的预置设置改成 8 个 tab。
2. **补正项**：若以后给 `.svp-tab` 加 `letter-spacing`，canvas 度量**不含**字距 →
   需按 `letterSpacing × 字符数` 补进 `textWidth()`（当前无 letter-spacing，暂不需要）。
3. 跑 `probe-ui-guard` + `probe-paneldrag`，再跑全量回归（256 项基线）。

---

## P1 · JSON 配置系统：本地重命名（用户明确要求）

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

## P2 · 「优化所有 UI + 增强安全性 + 优化性能」（用户提出，未开工）

**性能**：先拿数字再动手（项目铁律：不许凭感觉优化）。

1. `node probe-perf.mjs` 取基线（隐藏 8s / 空闲 / 切 Tab / 拖拽四场景 + `PERF-JSON`）
2. 候选热点（待实测确认，别先改）：
   - 设置覆盖层打开时的重排（插件列表 + Tab 列表一次性挂载）
   - 大变量表滚动（几百行）
   - 飞书拦截日志列表增长
   - Tab 切换挂载

**安全性**：已有 `secure-guard` 系列覆盖反作弊对抗，待补的审计点：

1. 配置导入的 JSON 规模限制（深度 / 条数 / 字节数）—— 防超大文件卡死面板
2. `resolveAlias()` 的结果进入模板前必须当**纯文本**，绝不 `innerHTML`（别名来自任意 JSON）
3. 插件 `ctx.ui.*` 传入字符串的转义审计
4. `displayNames` / alias 配置的存储篡改（非字符串值、原型污染键 `__proto__`）

**UI**：等用户给**具体现象**（用户偏好具体反馈，泛泛「优化 UI」容易白做）

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
