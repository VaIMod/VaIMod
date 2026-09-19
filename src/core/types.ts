export type VariableValue = string | number | boolean;

export type ListValue = VariableValue[];

export type ScratchValue = VariableValue | ListValue;

export type VariableKind = 'variable' | 'list';

export interface ScratchVariable {
  id: string;
  name: string;
  kind: VariableKind;
  value: ScratchValue;
  isCloud: boolean;
  targetId: string;
  targetName: string;
  isLocked: boolean;
  /** 锁定刷新间隔（秒）；仅 isLocked 时由 UI 从锁定表补齐，供配置导出使用 */
  lockInterval?: number;
}

export interface VariableLockInfo {
  variableId: string;
  targetId: string;
  value: ScratchValue;
  interval: number;
}

export interface NameLockOptions {
  names: string[];
  value: ScratchValue;
  interval?: number;
}

export enum BridgeStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error',
}

export interface BridgeOptions {
  pollInterval?: number;
  connectTimeout?: number;
  onStatusChange?: (status: BridgeStatus, info?: string) => void;
  onVariablesChange?: (variables: ScratchVariable[]) => void;
  onError?: (error: Error) => void;
}
