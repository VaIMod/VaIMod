// ===== VaIMod 安全 VM 架构 =====
// 结合 GandiVM（scratch-vm：runtime.targets 结构、virtual-machine 事件）与
// secure-vm（iframe 干净环境 + 双 Proxy 双向代理）两者设计：
// - GandiVM 结构感知：按 scratch-vm 真实结构（runtime.targets / variables Map / isCloud）
//   提供标准化的安全快照与定位 API，保证与平台 VM 精确兼容；
// - secure-vm 双代理隔离：所有对外访问面都是只读沙盒代理（见 vm-sandbox.ts），
//   原生对象永不跨界；内部控制面（raw）仅 VaIMod 自身经通道 + 审核 + 零信任使用。
// 架构分层：
//   [页面/外部] → SecureVm.proxy（沙盒面：只读 + 方法审计 + 双向代理）
//              → VpnChannel（闭包持有 SecureVm，实例零暴露）
//              → ScratchVM 控制面（writeVariable 审核 + ztna 验证）
//              → SecureVm.raw（原生 vm，仅内部可达）
import { sandboxVm, getSandboxCallCount } from './vm-sandbox';
import { auditInbound } from './vpn-audit';
import { normalizeValue } from './utils';
import type { ScratchValue } from './types';

interface TargetLike {
  id?: string;
  getName?: () => string;
  variables?: Map<string, VariableLike> | Record<string, VariableLike>;
}

interface VariableLike {
  name?: string;
  value?: unknown;
  isCloud?: boolean;
}

/** 安全快照条目（纯数据，可安全跨面传递） */
export interface SecureVariableSnapshot {
  id: string;
  name: string;
  value: ScratchValue;
  isCloud: boolean;
  targetId: string;
  targetName: string;
}

export class SecureVm {
  private readonly rawVm: unknown;
  private readonly proxyRef: unknown;

  constructor(raw: unknown) {
    this.rawVm = raw;
    this.proxyRef = sandboxVm(raw);
  }

  /** 内部原生面：仅 VaIMod 控制层经 VpnChannel 访问（页面无法触及本类实例） */
  get raw(): unknown {
    return this.rawVm;
  }

  /** 沙盒面：只读 + 方法审计 + 双向代理的受限视图（对外交互入口） */
  get proxy(): unknown {
    return this.proxyRef;
  }

  /** 审计：经沙盒面的 vm 方法调用次数 */
  get callCount(): number {
    return getSandboxCallCount();
  }

  /** 判断原始引用是否仍存在（链路健康参考） */
  get alive(): boolean {
    return this.rawVm !== null && this.rawVm !== undefined;
  }

  /**
   * GandiVM 结构感知快照：安全遍历 runtime.targets，返回纯数据变量列表。
   * 只读不修改 vm；值经 auditInbound 清洗（防污染注入）。
   */
  snapshotVariables(): SecureVariableSnapshot[] {
    const vm = this.rawVm as {
      runtime?: { targets?: TargetLike[] };
    } | null;
    const targets = vm?.runtime?.targets;
    if (!targets) return [];
    const out: SecureVariableSnapshot[] = [];
    for (const target of targets) {
      if (!target?.variables) continue;
      const targetId = target.id ?? '';
      const targetName = target.getName?.() ?? '';
      const vars = target.variables;
      const push = (id: string, variable: VariableLike) => {
        if (!variable || typeof variable.name !== 'string') return;
        out.push({
          id,
          name: variable.name,
          value: auditInbound(normalizeValue(variable.value)),
          isCloud: Boolean(variable.isCloud),
          targetId,
          targetName,
        });
      };
      if (vars instanceof Map) {
        for (const [id, variable] of vars) push(id, variable);
      } else {
        for (const [id, variable] of Object.entries(vars)) push(id, variable);
      }
    }
    return out;
  }

  /** 安全定位变量（按 id + targetId），返回纯数据或 null（GandiVM 结构） */
  findVariable(variableId: string, targetId: string): SecureVariableSnapshot | null {
    const vm = this.rawVm as {
      runtime?: {
        targets?: TargetLike[];
      };
    } | null;
    const targets = vm?.runtime?.targets;
    if (!targets) return null;
    for (const target of targets) {
      if (!target?.variables || (targetId && target.id !== targetId)) continue;
      const vars = target.variables;
      const get = (id: string): VariableLike | undefined =>
        vars instanceof Map ? vars.get(id) : (vars as Record<string, VariableLike>)[id];
      const variable = get(variableId);
      if (variable) {
        return {
          id: variableId,
          name: typeof variable.name === 'string' ? variable.name : '',
          value: auditInbound(normalizeValue(variable.value)),
          isCloud: Boolean(variable.isCloud),
          targetId: target.id ?? '',
          targetName: target.getName?.() ?? '',
        };
      }
    }
    return null;
  }
}
