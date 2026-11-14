// ============================================================
// plugin-guard.ts —— 动态插件装载边界硬闸（cr-1074 批3 切片一）
//
// 背景（cr-1073 定级）：fiber 名 = 插件源码自选字段（Plugin.Base.name
// ——cordis 类型原文「display name used for fiber diagnostics」），与
// manifest.name 相互独立且无校验。批 1 简化信任面按 fiber 名 ac- 前缀
// 判可信——恶意插件源码 export const name = 'ac-fs-tools' 即骗过前缀
// 判定，其 risk 自评被采信（恒 allow 直通）。manifest 层封禁堵不住
//（名字两套独立），硬闸必须在装载边界（ctx.plugin 之前）。
//
// 两件事：
//   ① 官方命名空间守卫——动态插件模块 name 落官方命名空间（ac- 前缀 /
//      官方特例行名 / IMPORTED_ROWS 键）即拒载（fail-closed，代码不进
//      进程，早失败）。冒名顶替在装载边界死，信任面前缀判定自此可信。
//   ② fiber 名钉死——动态插件模块无名（技能教的最小形态 export
//      function apply）时 fiber.name 继承装载方祖先名（cordis Fiber.name
//      getter：最近命名祖先，否则 'root'）——工具 owner 会错挂到
//      shell-plugin-dev-row / root 名下。装载方以 { ...mod, name:
//      manifest.name } 显式钉死：归属确定（owner = manifest.name），
//      D11 门行查 grants（切片三）才有稳定键。
// ============================================================
import type { Plugin } from '@agentchat/cordis';
import { isReservedPluginName } from 'ac-plugin-core';

/**
 * 名字是否冒充官方（cr-1075：判定单源在 ac-plugin-core，安装期
 * validatePluginManifest 同一谓词——本闸是装载期硬闸的另一半，防
 * manifest 事后被改写/绕过安装器）。
 */
export function isOfficialFiberName(name: string): boolean {
  return isReservedPluginName(name);
}

/**
 * 装载边界守卫：校验动态插件模块并钉死 fiber 名。
 * @param mod 安装目录入口模块（dynamic import 产物）
 * @param manifestName manifest.name（fiber 名钉死目标——归属确定性单源）
 * @throws 模块 name 冒充官方命名空间（fail-closed 拒载——代码不进进程）
 */
export function guardPluginModule(mod: Plugin, manifestName: string): Plugin {
  // 校验两处（缺一即洞）：钉死目标是 manifest.name，若只查模块名，
  // manifest 叫 ac-evil 的插件钉死后 fiber 名照样骗过门行前缀判定
  const impersonator = isOfficialFiberName(manifestName)
    ? manifestName
    : typeof (mod as { name?: unknown }).name === 'string' && isOfficialFiberName((mod as { name: string }).name)
      ? (mod as { name: string }).name
      : null;
  if (impersonator !== null) {
    throw new Error(
      '插件名 "' + impersonator + '" 冒充官方命名空间（ac- / shell- 前缀、root）——拒绝装载。'
      + '插件 name 必须用自己的标识（推荐 <你的id>-<名> 规约），请改名后重新安装。',
    );
  }
  // 函数/构造器插件：包装为对象插件钉名（cordis Plugin.Function/Constructor
  // 形态的 name 在函数属性上，不可枚举展开复制——统一收编为 Object 形态）
  if (typeof mod === 'function') {
    return { name: manifestName, apply: (ctx: unknown, config: unknown) => (mod as (ctx: unknown, config: unknown) => unknown)(ctx, config) } as unknown as Plugin;
  }
  return { ...(mod as unknown as Record<string, unknown>), name: manifestName } as unknown as Plugin;
}
