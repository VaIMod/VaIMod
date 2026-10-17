/**
 * 页面真实可见性读取口（零依赖，模块求值即抓原始 getter）。
 *
 * 背景：vm-antidetect 把 document.hidden / visibilityState 伪装为「恒可见」
 * （行为分析对抗），页面侧读到的不再是真值。全仓凡用于「后台零开销」门控的
 * 可见性判断（扫描/巡检/自愈节拍）都必须走本模块的 trueHidden()/trueVisible()，
 * 否则伪装生效后门控失效，后台标签照常消耗主线程。
 *
 * 求值时机：本模块被 main.ts import 图在 vm-antidetect 之前求值
 * （dom-utils → page-visibility 先于 installVmAntidetect），因此这里从
 * Document.prototype 抓到的必然是原生 getter；即使某环境把 getter 定义在
 * 实例上，兜底分支也能读到真值。
 */

interface DescHost {
  hidden?: PropertyDescriptor;
  visibilityState?: PropertyDescriptor;
}

// 模块求值（document-start，早于任何伪装安装）抓原生 descriptor
const ORIG: DescHost = (() => {
  try {
    return {
      hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
      visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
    };
  } catch {
    return {};
  }
})();

/** 真实页面隐藏态（绕过 vm-antidetect 伪装）——内部后台暂停逻辑专用 */
export function trueHidden(): boolean {
  try {
    if (ORIG.hidden?.get) return ORIG.hidden.get.call(document) === true;
  } catch {
    /* ignore */
  }
  try {
    if (ORIG.visibilityState?.get) return ORIG.visibilityState.get.call(document) === 'hidden';
  } catch {
    /* ignore */
  }
  // 双原始 getter 均不可得时的最后兜底：读当前值（伪装未安装时即真值）
  try {
    return document.hidden;
  } catch {
    return false;
  }
}

/** 真实页面可见态（trueHidden 的反义口，调用侧语义更直读） */
export function trueVisible(): boolean {
  return !trueHidden();
}
