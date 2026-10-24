/**
 * 作品加载加速层。
 *
 * 两个手段（全部零功能代价）：
 *  1. 资产域预连接：document-start 就对 CCW 关键资产域发起 DNS + TCP + TLS
 *     握手（<link rel="preconnect">），作品/云数据请求到达时连接已就绪，
 *     首次请求省 100~300ms（跨域握手不与页面渲染争抢，纯网络层并行化）。
 *  2. 作品加载窗口：vm.loadProject 执行期（含异步反序列化）置全局加载标志，
 *     重型周期任务（扩展全量枚举、VPN 巡检等 2~10s 级 tick）查标志让路——
 *     作品反序列化是主线程最重的单笔工作，避免周期任务恰好在其中间落棒。
 */

// CCW 平台实际使用的资产域（源码与部署产物中出现过，全部同站群）：
//   ccw.site / www.ccw.site            —— 站点本体与 API
//   m.ccw.site                         —— 上传/静态资源（gandi/Maxkore/Safe 等）
//   community-web-cloud-database.ccw.site —— 云数据库（云数据/多人同步）
//   zhishi.oss-cn-beijing.aliyuncs.com —— 作品 sb3 版本存储
const PRECONNECT_HOSTS = [
  'https://ccw.site',
  'https://www.ccw.site',
  'https://m.ccw.site',
  'https://community-web-cloud-database.ccw.site',
  'https://zhishi.oss-cn-beijing.aliyuncs.com',
];

let installed = false;
export function installLoadAccel(): void {
  if (installed) return;
  installed = true;
  try {
    const doc = document;
    const head = doc.head || doc.documentElement;
    if (!head) return;
    for (const href of PRECONNECT_HOSTS) {
      try {
        // 去重：站点自身可能已注入同域 preconnect
        if (head.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
        const link = doc.createElement('link');
        link.rel = 'preconnect';
        link.href = href;
        link.crossOrigin = 'anonymous';
        head.appendChild(link);
      } catch {
        /* 单域失败不影响其余 */
      }
    }
  } catch {
    /* ignore */
  }
}

// ---------- 作品加载窗口 ----------
let loadingDepth = 0;

/** loadProject 进入时调用（可嵌套） */
export function markProjectLoading(): void {
  loadingDepth++;
}

/** loadProject 结束（含异步决议/拒绝）时调用 */
export function clearProjectLoading(): void {
  if (loadingDepth > 0) loadingDepth--;
}

/** 重型周期任务查询：true = 作品正在加载，本轮让路 */
export function isProjectLoading(): boolean {
  return loadingDepth > 0;
}

/**
 * 包装任意 loadProject 实现：进入置加载标志，同步返回值若为 thenable
 * 则在决议/拒绝后解除（作品反序列化是异步的，只看同步返回会提前解除）。
 * 返回原样转发，不吞不改任何结果。
 */
export function withProjectLoadingWindow<T extends (...args: never[]) => unknown>(orig: T): T {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    markProjectLoading();
    try {
      const r = (orig as unknown as (...a: unknown[]) => unknown).apply(this, args);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).then(
          () => clearProjectLoading(),
          () => clearProjectLoading(),
        );
        return r;
      }
      clearProjectLoading();
      return r;
    } catch (e) {
      clearProjectLoading();
      throw e;
    }
  } as unknown as T;
  return wrapped;
}
