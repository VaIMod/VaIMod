// ===== 品牌更名一次性迁移（ValMod → VaIMod） =====
// 更名后所有 localStorage 键换新前缀；此模块在启动最前端把旧键数据搬到新键，
// 保证老用户升级后插件 / 设置 / 别名 / 回收站 / 快照标记 / 分组展开态无缝保留。
// 策略：新键已存在（跑过新版）则不动；旧键保留不删，回滚旧版仍可读。

const KEY_MAP: readonly [string, string][] = [
  // 插件系统
  ['valmod_plugins_v1', 'vaimod_plugins_v1'],
  ['valmod_plugset_v1', 'vaimod_plugset_v1'],
  // 设置
  ['valmod_settings_v1', 'vaimod_settings_v1'],
  // 显示别名
  ['valmod_dispnames', 'vaimod_dispnames'],
  // 飞书机器人 / 面板 UI 态
  ['valmod_fs_robots', 'vaimod_fs_robots'],
  ['valmod_fs_ui', 'vaimod_fs_ui'],
  // 回收站 / 快照标记
  ['valmod_trash', 'vaimod_trash'],
  ['valmod_marks', 'vaimod_marks'],
  // 变量分组展开态
  ['valmod_grp_exp', 'vaimod_grp_exp'],
  // 调试开关
  ['valmod_debug', 'vaimod_debug'],
];

const LEGACY_PLUGIN_STORE_PREFIX = 'valmod_plug_';
const NEW_PLUGIN_STORE_PREFIX = 'vaimod_plug_';

let done = false;

/** 把旧品牌键的数据迁移到新键（幂等，启动时调用一次） */
export function migrateBrandKeys(): void {
  if (done) return;
  done = true;
  try {
    for (const [oldKey, newKey] of KEY_MAP) {
      if (localStorage.getItem(newKey) !== null) continue;
      const v = localStorage.getItem(oldKey);
      if (v !== null) localStorage.setItem(newKey, v);
    }
    // 插件各自的 store（valmod_plug_<id>_<key> → vaimod_plug_<id>_<key>）
    const pairs: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_PLUGIN_STORE_PREFIX)) {
        pairs.push([k, NEW_PLUGIN_STORE_PREFIX + k.slice(LEGACY_PLUGIN_STORE_PREFIX.length)]);
      }
    }
    for (const [oldKey, newKey] of pairs) {
      if (localStorage.getItem(newKey) !== null) continue;
      const v = localStorage.getItem(oldKey);
      if (v !== null) localStorage.setItem(newKey, v);
    }
  } catch {
    /* 存储不可用时静默：与各模块的容错策略一致 */
  }
}
