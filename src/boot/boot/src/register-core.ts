// ============================================================
// @agentchat/boot/src/register-core.ts —— 核心服务/能力注册（装配共享）
//
// 把核心服务（ctx.llm/ctx.tools/ctx.hooks）与能力插件挂到给定 ctx。
// 行模块一律取自 bundle-rows.gen（源 = composition.base.yml +
// composition.web-app.yml（web 表面行），pnpm gen:bundle-rows 再生）
// ——与组合路径单一事实来源，无手写 import 双轨。
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
import { bundleRow } from './bundle-rows.gen';


/** 挂载核心服务行 + 能力插件行（await 各插件激活完成；与 cordis.yml 同构） */
export async function registerCoreServices(ctx: Context): Promise<void> {
  await ctx.plugin(bundleRow('agent-loop').module as any);    // → ctx.agentLoop
  await ctx.plugin(bundleRow('llm').module as any);          // → ctx.llm
  await ctx.plugin(bundleRow('llm-deepseek').module as any);  // 适配器：deepseek（inject: llm）
  await ctx.plugin(bundleRow('llm-glm').module as any);       // 适配器：glm（inject: llm）
  await ctx.plugin(bundleRow('llm-openai').module as any);    // 适配器：openai + default（inject: llm）
  await ctx.plugin(bundleRow('tools').module as any);        // → ctx.tools
  await ctx.plugin(bundleRow('plugin-host').module as any);   // → ctx.pluginHost（动态插件装载器服务行，先于 dev 工具行）
  await ctx.plugin(bundleRow('market').module as any);       // → ctx.market（市场发现/暂存/安装；构造零网络）
  await ctx.plugin(bundleRow('durable-interaction').module as any); // → ctx.durableInteraction（通用持久化交互，无依赖）
  await ctx.plugin(bundleRow('fs-tools').module as any);           // 工具领域行（inject: tools）
  await ctx.plugin(bundleRow('shell-tools').module as any);
  await ctx.plugin(bundleRow('web-tools').module as any);
  await ctx.plugin(bundleRow('dev-tools').module as any);
  await ctx.plugin(bundleRow('dev-admin-tools').module as any);      // 插件管理工具行（register_tool/register_plugin/…，admin）
  await ctx.plugin(bundleRow('session-tools').module as any);
  await ctx.plugin(bundleRow('restart').module as any);
  await ctx.plugin(bundleRow('interaction').module as any);
  await ctx.plugin(bundleRow('hooks').module as any);        // → ctx.hooks
  await ctx.plugin(bundleRow('agent-prompt').module as any);  // 扩展域行（inject: hooks）
  await ctx.plugin(bundleRow('agent-skill').module as any);   // 技能注入行（inject: hooks）
  await ctx.plugin(bundleRow('agent-session').module as any);
  await ctx.plugin(bundleRow('agent-memory').module as any);
  await ctx.plugin(bundleRow('agent-mcp').module as any);
  await ctx.plugin(bundleRow('security').module as any);
  await ctx.plugin(bundleRow('agent-tools').module as any);   // 协作工具（inject: tools）
  await ctx.plugin(bundleRow('timer-tools').module as any);        // timer 工具（inject: tools）
  await ctx.plugin(bundleRow('subagent-tools').module as any);     // subagent 工具（inject: tools）
  await ctx.plugin(bundleRow('math-tools').module as any);         // math 共享工具（inject: tools）
}
