// ============================================================
// ac-plugin-gates —— 插件装载 gate 策略行
//
// src PluginHost 的权限/契约 gate 半边的 preview 拆行（地图 §3.3）：
//   · owner 手工回收已删除（注册即归属）；gate 本身原样保留——
//     **在 import 之前**拒绝（fail-closed，插件代码不进进程）
//   · 权限 gate：manifest.permissions 超出 call.grants 授予 → 拒绝
//   · 契约 gate：manifest.contracts 与宿主契约版本不兼容 → 拒绝
//     （缺省声明视为兼容——存量插件弃用窗口内不惩罚）
//   · 拆行的意义：安全策略随行组合演进（换 gate 实现 = 换一行，
//     registry 装载管道不动）；yml 缺省装本行
// 消费 seam：plugin/before-load waterfall（ac-plugin-registry 声明）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import {
  HOST_CONTRACTS_VERSION,
  assertPermissionsGranted,
  isContractsCompatible,
} from 'ac-plugin-core';

export const name = 'ac-plugin-gates';

export const inject = ['pluginRegistry'];

export interface PluginGatesRowOptions {
  /** gate 开关（缺省全开；诊断用） */
  enabled?: boolean;
  /**
   * 覆盖宿主契约版本（缺省 HOST_CONTRACTS_VERSION；测试注入）。
   * major 位 = 插件兼容面（破坏性升级升 major）。
   */
  contractsVersion?: string;
}

export function apply(ctx: Context, options: PluginGatesRowOptions = {}) {
  const enabled = options.enabled !== false;
  const hostVersion = options.contractsVersion ?? HOST_CONTRACTS_VERSION;

  ctx.on('plugin/before-load', async (call, next) => {
    if (enabled) {
      // 权限 gate：未授予的高危权限在 import 前拒绝
      try {
        assertPermissionsGranted(call.manifest, call.grants);
      } catch (err) {
        return {
          status: 'rejected' as const,
          name: call.manifest.name,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // 契约 gate：声明的兼容范围不含宿主版本 → 拒绝（代码不进进程）
      if (!isContractsCompatible(call.manifest.contracts, hostVersion)) {
        return {
          status: 'rejected' as const,
          name: call.manifest.name,
          error: `插件 "${call.manifest.name}@${call.manifest.version}" 声明 contracts "${call.manifest.contracts}"，与宿主契约 ${hostVersion} 不兼容（装载被拒绝；代码未进进程）`,
        };
      }
    }
    return next();
  });

  // M23 G5 gates 屏障：本行监听就位后放行 plugin-registry 的 boot 首扫
  // （registry 行先激活，不等则首批装载过空 waterfall——gate 空转）。
  ctx.pluginRegistry.notifyGatesReady();
}
