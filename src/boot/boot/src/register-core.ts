// ============================================================
// @agentchat/boot/src/register-core.ts —— 核心服务/能力注册（装配共享）
//
// 把核心服务（ctx.llm/ctx.tools/ctx.hooks）与能力插件（tools/ext/
// timer/subagent/math）挂到给定 ctx。统一形态：全部经插件行挂载
// （与 cordis.yml 的行一一对应），不再手工 new Service + 嵌套 ctx.plugin。
//
// ⚠ 关键：ctx.plugin() 必须传【模块对象】（namespace import），不能传裸 apply
//   函数 —— 裸函数会丢失 inject 声明（cordis 从传入对象读 plugin.inject），
//   兄弟行提供的服务将无法解析（cannot get property without inject）。
//
// 两个调用方共享此逻辑（避免重复）：
//   · plugin.ts（cordis 装配插件，Loader 场景）：服务已由各行提供 → 跳过
//   · bootstrap.ts（惰性 ctx）：无 ctx 时自建 root Context 后调用
//
// 注意：ctx.plugin() 为异步激活（返回 Fiber & PromiseLike），
// 必须 await 保证 apply 同步完成（注册生效）后再继续装配。
// ============================================================
import type { Context } from '@agentchat/cordis';
import * as agentLoopPlugin from '@agentchat/agent-loop/src/plugin';
import * as llmPlugin from '@agentchat/llm/src/plugin';
import * as llmDeepseekPlugin from '@agentchat/llm-deepseek/src/plugin';
import * as llmOpenaiPlugin from '@agentchat/llm-openai/src/plugin';
import * as toolsPlugin from '@agentchat/tools/src/plugin';
import * as pluginHostPlugin from '@agentchat/plugins/src/plugin';
import * as durableInteractionPlugin from '@agentchat/durable-interaction/src/plugin';
import * as fsPlugin from '@agentchat/fs/src/plugin';
import * as shellPlugin from '@agentchat/shell/src/plugin';
import * as webPlugin from '@agentchat/web/src/plugin';
import * as devPlugin from '@agentchat/dev/src/plugin';
import * as devAdminPlugin from '@agentchat/dev/src/plugin-admin';
import * as sessionToolsPlugin from '@agentchat/session-tools/src/plugin';
import * as restartPlugin from '@agentchat/restart/src/plugin';
import * as interactionPlugin from '@agentchat/interaction/src/plugin';
import * as hooksPlugin from '@agentchat/hooks/src/plugin';
import * as agentPromptPlugin from '@agentchat/agent-prompt/src/plugin';
import * as agentSkillPlugin from '@agentchat/agent-skill/src/plugin';
import * as agentSessionPlugin from '@agentchat/agent-session/src/plugin';
import * as agentMemoryPlugin from '@agentchat/agent-memory/src/plugin';
import * as agentMcpPlugin from '@agentchat/agent-mcp/src/plugin';
import * as securityPlugin from '@agentchat/security/src/plugin';
import * as agentToolsPlugin from '@agentchat/agent-tools/src/plugin';
import * as timerPlugin from '@agentchat/timer/src/plugin';
import * as subagentPlugin from '@agentchat/subagent/src/plugin';
import * as mathPlugin from '@agentchat/math/src/plugin';

/** 挂载核心服务行 + 能力插件行（await 各插件激活完成；与 cordis.yml 同构） */
export async function registerCoreServices(ctx: Context): Promise<void> {
  await ctx.plugin(agentLoopPlugin);    // → ctx.agentLoop
  await ctx.plugin(llmPlugin);          // → ctx.llm
  await ctx.plugin(llmDeepseekPlugin);  // 适配器：deepseek（inject: llm）
  await ctx.plugin(llmOpenaiPlugin);    // 适配器：openai + default（inject: llm）
  await ctx.plugin(toolsPlugin);        // → ctx.tools
  await ctx.plugin(pluginHostPlugin);   // → ctx.pluginHost（动态插件装载器服务行，先于 dev 工具行）
  await ctx.plugin(durableInteractionPlugin); // → ctx.durableInteraction（通用持久化交互，无依赖）
  await ctx.plugin(fsPlugin);           // 工具领域行（inject: tools）
  await ctx.plugin(shellPlugin);
  await ctx.plugin(webPlugin);
  await ctx.plugin(devPlugin);
  await ctx.plugin(devAdminPlugin);      // 插件管理工具行（register_tool/register_plugin/…，admin）
  await ctx.plugin(sessionToolsPlugin);
  await ctx.plugin(restartPlugin);
  await ctx.plugin(interactionPlugin);
  await ctx.plugin(hooksPlugin);        // → ctx.hooks
  await ctx.plugin(agentPromptPlugin);  // 扩展域行（inject: hooks）
  await ctx.plugin(agentSkillPlugin);   // 技能注入行（inject: hooks）
  await ctx.plugin(agentSessionPlugin);
  await ctx.plugin(agentMemoryPlugin);
  await ctx.plugin(agentMcpPlugin);
  await ctx.plugin(securityPlugin);
  await ctx.plugin(agentToolsPlugin);   // 协作工具（inject: tools）
  await ctx.plugin(timerPlugin);        // timer 工具（inject: tools）
  await ctx.plugin(subagentPlugin);     // subagent 工具（inject: tools）
  await ctx.plugin(mathPlugin);         // math 共享工具（inject: tools）
}
