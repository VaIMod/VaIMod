export { ScratchVM } from './scratch-vm';
export { Database } from './database';
export { CcwDataStore, ccwDataStore } from './ccwdata';
export type { CloudType } from './ccwdata';
export type { BridgeEvent, BridgeListener } from './scratch-vm';
export { BridgeStatus } from './types';
export type {
  BridgeOptions,
  ListValue,
  NameLockOptions,
  ScratchValue,
  ScratchVariable,
  VariableKind,
  VariableLockInfo,
  VariableValue,
  ScratchVariable as ScratchVaIMod,
  VariableValue as VaIModValue,
} from './types';
export {
  cleanDisplay,
  coerceValue,
  findVmViaFiber,
  isVMLike,
  listValueToString,
  normalizeValue,
  sleep,
  stringToListValue,
} from './utils';
// VPN 汇总层：三 VPN 独立管辖 + 汇总
export {
  trackVpn,
  untrackVpn,
  vpnCounts,
  vpnHealthCheck,
  vpnRecycle,
  vpnReport,
} from './vpn-registry';
export { VpnChannel } from './vpn';
export { SecretChannel, secretChannel } from './secret-channel';
export { ztna } from './ztna';
export { SecureVm, type SecureVariableSnapshot } from './secure-vm';
export {
  interactThroughVeil,
  secureAction,
  type GuardKind,
  type SecureActionOptions,
} from './veil-chain';
export {
  VeilChannel,
  getVeilChannel,
  installVeilGuard,
  ensureVeil,
  veilAccessValid,
} from './veil-manager';
export { installHoneypotGuard, honeypotReport } from './honeypot-guard';
