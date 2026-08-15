// ============================================================
// @agentchat/tools —— 工具注册中心 + 契约（迁移自 src/plugins/builtin/tools）
//
// 领域拆分（一切皆插件）：
//   · 工具领域包独立成行：fs/shell/web/dev/session-tools/app-tools（各自 plugin.ts）
//   · edit 引擎 → @agentchat/edit（hashline DSL + 增量 diff + 快照）
//   · 工具基础 → @agentchat/toolkit（defineTool/表单 Schema/命名空间/沙箱/文本）
//   · 本包保留：ToolsService + ToolContext/PluginServices 契约
//     以及从 toolkit 的兼容 re-export（迁移期平滑；新代码直接用 @agentchat/toolkit）
// ============================================================

export * from './contracts';
export * from './service';
export * from './paths';
// 兼容 re-export（NS_*/defineTool/ConfigField/shared 函数已迁 @agentchat/toolkit）
export * from '@agentchat/toolkit';
