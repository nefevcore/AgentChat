// ============================================================
// @agentchat/plugins/src/permissions.ts —— 插件权限授予策略
//
// 词汇表见 agent-config 的 KNOWN_PERMISSIONS：
//   fs / network —— 常用工具能力，默认授予（register_plugin 与发布 approve）
//   process / shell —— 高危（可执行任意进程/命令），必须宿主显式 grants
//   ui —— UI 扩展权限（P1 仅词汇/展示占位；执行期 gate 在 P5 与 manifest.ui 一起接入）
//
// 执行期强制点：
//   · PluginHost.load：manifest.permissions 超出 allowedPermissions → 在 import 前抛错
//     （插件代码根本不会进进程）
//   · 市场安装/人工暂存 approve：需要显式授予的权限必须出现在 grants 参数里，
//     授予快照写入 registry.json，启动扫描按快照恢复。
// ============================================================
import {
  KNOWN_PERMISSIONS,
  type PluginManifest,
  type PluginPermission,
} from '@agentchat/agent-config';

/** 默认授予（无需人工审批）的权限 */
export const DEFAULT_GRANTED_PERMISSIONS: readonly PluginPermission[] = ['fs', 'network'];

/**
 * 执行期强制显式授予的权限（P1）。
 * `ui` 属于词汇/展示层（供 approve 弹窗与权限徽章使用），但执行期 gate
 * 尚未开启（P5 引入 manifest.ui 时再把它纳入强制集合）。
 */
export const EXECUTION_EXPLICIT_REQUIRED: readonly PluginPermission[] = ['process', 'shell'];

/**
 * UI 审查层“需要宿主显式勾选”的权限（所有非默认权限）。
 * P1：process/shell 强制；ui 展示勾选但后端不 gate（P5 切换为强制）。
 */
export const REVIEW_EXPLICIT_REQUIRED: readonly PluginPermission[] = ['process', 'shell', 'ui'];

/** manifest 声明的权限中需要宿主显式授予/审查的集合（去重、保序） */
export function requiredGrants(manifest: PluginManifest): PluginPermission[] {
  const declared = new Set(manifest.permissions ?? []);
  return REVIEW_EXPLICIT_REQUIRED.filter((p) => declared.has(p));
}

/** 默认权限 + 显式 grants 的组合（去重） */
export function grantPermissions(grants: unknown): PluginPermission[] {
  const extra = Array.isArray(grants) ? grants : [];
  const out = new Set<PluginPermission>(DEFAULT_GRANTED_PERMISSIONS);
  for (const g of extra) {
    if (typeof g !== 'string') continue;
    if (!KNOWN_PERMISSIONS.includes(g as PluginPermission)) {
      throw new Error(`未知权限 "${g}"（可选：${KNOWN_PERMISSIONS.join('/')}）`);
    }
    out.add(g as PluginPermission);
  }
  return [...out];
}

/** manifest 声明了但未被授予的执行期强制权限（空数组 = 全部满足） */
export function missingPermissions(manifest: PluginManifest, allowed: Iterable<PluginPermission> | undefined): PluginPermission[] {
  const granted = new Set(allowed ?? []);
  const missing = (manifest.permissions ?? []).filter(
    (p) => EXECUTION_EXPLICIT_REQUIRED.includes(p) && !granted.has(p),
  );
  // P5：manifest.ui 存在时，ui 与 process/shell 同级强制（整包原子装载）
  if (manifest.ui && !granted.has('ui') && !missing.includes('ui')) {
    missing.push('ui');
  }
  return missing;
}

/** 在插件装载前执行权限检查；未通过抛错（列出缺失项） */
export function assertPermissionsGranted(manifest: PluginManifest, allowed: Iterable<PluginPermission> | undefined): void {
  const missing = missingPermissions(manifest, allowed);
  if (missing.length > 0) {
    throw new Error(`插件 "${manifest.name}" 声明了未授予的权限：${missing.join('/')}（请在 register_plugin 的 grants / 市场安装的授予环节中显式授予）`);
  }
}
