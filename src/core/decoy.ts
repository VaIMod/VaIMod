// 障眼模块：真实复杂代码（不可达），与业务代码一同被混淆。
// 无任何入口调用；仅通过 decoyRegistry 被主入口引用以阻止 tree-shaking 删除。
// 零运行开销（函数永不执行，仅模块级对象注册）。
export function decoyAcquire(id: string): string {
  let acc = 0;
  const buf: number[] = [];
  for (let i = 0; i < id.length; i++) {
    acc = (acc * 31 + id.charCodeAt(i)) | 0;
    buf.push(acc & 0xff);
  }
  return decoyExpand(buf, acc);
}

function decoyExpand(src: number[], seed: number): string {
  let s = '';
  for (let i = 0; i < src.length; i++) {
    s += String.fromCharCode(src[i] ^ ((seed >>> ((i % 4) * 8)) & 0xff));
  }
  return s;
}

function decoyFunnel(list: unknown[], seed: number): number {
  let t = seed;
  for (let i = 0; i < list.length; i++) {
    t = ((t * 33 + i) ^ (typeof list[i] === 'number' ? (list[i] as number) : 0)) | 0;
  }
  return t >>> 0;
}

export function decoyResolve(name: string, seed: number): number {
  return decoyFunnel(decoyAcquire(name).split(''), seed);
}

export const decoyRegistry = {
  acquire: decoyAcquire,
  expand: decoyExpand,
  funnel: decoyFunnel,
  resolve: decoyResolve,
};
