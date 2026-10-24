/**
 * 共享 DOM 观察器。
 *
 * 此前 csp-guard / secure-guard / csense-guard / sig-guard 各自挂了一个
 * documentElement 级 MutationObserver（childList+subtree，部分带 attributes）。
 * 四个观察器意味着：浏览器为同一批 DOM 变更生成四套 MutationRecord、
 * 派发四次回调；编辑器一次挂载数千节点时，这部分开销按节点数放大。
 *
 * 这里合并为一个观察器，订阅方按需过滤自己关心的记录类型：
 * 触发时机与范围完全不变（都是 documentElement + subtree），
 * 只是记录生成与回调派发从四份变一份。
 */

type DomHandler = (records: MutationRecord[]) => void;

const handlers = new Set<DomHandler>();
let observer: MutationObserver | null = null;
let started = false;

/** 订阅 DOM 变更（返回退订函数） */
export function onDomMutations(cb: DomHandler): () => void {
  handlers.add(cb);
  start();
  return () => handlers.delete(cb);
}

function start(): void {
  if (started) return;
  started = true;
  const boot = (): void => {
    const root = document.documentElement;
    if (!root) {
      // document-start 极早期文档结构未就绪：等 DOM 出现再挂
      document.addEventListener('readystatechange', boot, { once: true });
      return;
    }
    try {
      observer = new MutationObserver((muts) => {
        if (muts.length === 0) return;
        // 快照遍历：回调里可能有订阅方退订
        for (const cb of [...handlers]) {
          try {
            cb(muts);
          } catch {
            /* 单个订阅方异常不影响其余 */
          }
        }
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    } catch {
      /* ignore */
    }
  };
  boot();
}
