// ===== 插件 CSS 作用域限定（插件页 / 设置页共用）=====
// 为什么必须自己做：整块 VaIMod 界面（所有内置页 + 所有插件页 + 设置覆盖层）在
// **同一个 closed shadow root** 内。shadow 只保证「不外泄到站点」，
// **不保证「不外泄到面板的其它页面」** —— 插件样式与面板自身的样式在同一棵树上，
// 前缀隔离只能由我们自己做。
//
// 三条规则：
//   ① 普通规则：顶层逗号分隔的每条选择器各自加前缀；`&` 开头表示「接到作用域根上」；
//   ② 含选择器规则的 at-rule（@media / @supports / @layer / @container / @scope）：
//      **递归**加前缀。这里曾经是「整块原样保留」，等于留了一道
//      `@media (min-width:1px){ .svp-header{…} }` 改写整个面板样式的后门
//      （注释还写着「内部规则也会被前缀」，与实现不符 —— 注释与代码不符本身就是隐患）；
//   ③ 其余 at-rule（@keyframes / @font-face / @page / @property…）整块原样保留：
//      给 @keyframes 的 from / to / 百分比加前缀会直接破坏动画语义。
//   @import / @charset / @namespace 一律丢弃：它们能把外部样式表拉进来 /
//   影响文档级环境，插件样式应自包含。

/** 内部含「选择器规则」的 at-rule：要把 body 递归加前缀 */
const AT_RULE_WITH_RULES = /^@(media|supports|layer|container|scope|document)\b/i;
/** 能把外部样式表拉进来 / 影响文档级环境：直接丢弃 */
const AT_RULE_DROP = /^@(import|charset|namespace)\b/i;

/** 剥注释：注释里的 `{` / `}` 会打乱下面的块配对扫描 */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const a = css.indexOf('/*', i);
    if (a < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, a);
    const b = css.indexOf('*/', a + 2);
    if (b < 0) break; // 未闭合注释：丢弃尾部
    i = b + 2;
  }
  return out;
}

/**
 * 按「顶层逗号」切选择器。
 * 不能直接 `split(',')`：分组选择器在函数伪类内部同样用逗号
 * （`:is(.a, .b)` / `:not(.p, .q)` / `[data-v="a,b"]`），直接切会切坏括号，
 * 产出两条非法选择器 → 整条规则被浏览器丢弃。
 */
function splitSelectors(head: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') buf += head[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 顶层 `{}` 配对切分 → [头, 体] 序列。
 * 必须感知字符串/引号：`content:"}"`、`url("data:…{}")` 里的括号不参与配对，
 * 否则 depth 会提前归零，产出残缺 CSS（声明成片失效）。
 * 嵌套时内层 `{` 会随字符原样进入 body，供调用方递归处理。
 */
function splitRules(src: string): Array<[string, string]> {
  const heads: string[] = [];
  const bodies: string[] = [];
  let depth = 0;
  let buf = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') buf += src[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        heads.push(buf.trim());
        bodies.push('');
        buf = '';
        continue;
      }
    } else if (ch === '}') {
      // 顶层多余的 `}` 必须丢弃：不处理会让 depth 变成负数，此后每条规则都判不到
      // 「顶层边界」→ 整段并进同一个 buf，最后被当作无头内容丢掉。
      // 现象极具欺骗性：`} .svp-fab{visibility:hidden}` 这类「先闭合再逃逸」的写法
      // 反而绕过前缀隔离，而它后面的 @keyframes / 正常规则全部消失。
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        bodies[bodies.length - 1] = buf;
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < heads.length; i++) {
    // 无头裸声明块（如 `color:red` 直接出现在顶层）忽略：本就不是合法规则
    if (heads[i]) pairs.push([heads[i], bodies[i] ?? '']);
  }
  return pairs;
}

/**
 * 把 css 里的每条选择器都加上 `scopeSel` 前缀（递归处理含规则的 at-rule）。
 * 注意：返回结果已含前缀，调用方**绝不能再包一层 `#scopeId{…}`**
 * —— 会变成 CSS 嵌套规则（`#scopeId{#scopeId .go{…}}`），解析失败全丢。
 */
export function scopeCss(css: string, scopeSel: string): string {
  const src = stripCssComments(css);
  if (!src.trim()) return '';
  let result = '';
  for (const [head, body] of splitRules(src)) {
    if (head.startsWith('@')) {
      if (AT_RULE_DROP.test(head)) continue;
      const inner = AT_RULE_WITH_RULES.test(head) ? scopeCss(body, scopeSel) : body;
      result += `${head}{${inner}}\n`;
      continue;
    }
    const scoped = splitSelectors(head)
      .map((s) => (s.startsWith('&') ? `${scopeSel}${s.slice(1)}` : `${scopeSel} ${s}`))
      .join(', ');
    result += `${scoped}{${body}}\n`;
  }
  return result;
}
