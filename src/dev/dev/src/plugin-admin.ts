// ============================================================
// @agentchat/dev/src/plugin-admin.ts —— 插件管理工具行
//
// 从 agentchat-dev-tools 拆出的 admin 能力插件：
//   · register_tool      运行时工具注册（自我进化）
//   · register_tool      运行时工具注册（自我进化）
//   · register_plugin    开发插件会话级动态加载
//   · unregister_plugin  卸载会话级插件
//
// 发布不再经 Agent 工具：开发完成 → git 提交挂 topic:agentchat-plugin
// → 宿主经市场安装（人审与 grants 在市场路径统一）。
//
// 插件 id = agentchat-plugin-tools（<domain>-tools 惯例）；
// 四者均 requires:[admin]，标签负责权限、preset 负责装载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { getOrCreatePluginHost } from '@agentchat/plugins';
import { registerPluginAdminTools } from './register';

export const name = 'agentchat-plugin-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  // 复用 ctx.pluginHost（plugins 服务行先挂载）；无该服务时兜底创建（测试/手动装配）
  const host = getOrCreatePluginHost(ctx);
  registerPluginAdminTools(ctx.tools, name, host);
}
