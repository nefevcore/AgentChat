// ============================================================
// src/plugins/builtin/namespaces.ts —— 内置插件配置命名空间常量
//
// 命名空间 = 配置文件中含 "." 的顶层键（<agent>/config.json 或全局 config.json），
// 经 getNamespaceConfig(config, ns) 读取（读取函数在 L2 agents/config.ts）。
//
// 命名规则（2026-08-07 定稿）：
//   · agent.*     —— Agent 领域配置（原 extension.*，消除已废弃的 "extension" 概念）
//   · tool.*      —— 工具配置（仅保留有真实读取点的工具）
//   · security    —— 核心安全配置（无前缀，突出核心地位；路径穿透白名单）
//
// 归属说明：放 builtin mod 内（而非 L1/L2/L3 公共层）——
//   · 常量是 builtin 插件自身的配置领域知识，所有消费方在 builtin（hooks/tools）
//   · L2 不消费任何命名空间常量（getNamespaceConfig 接受字符串参数；
//     getAllowedPaths 归 builtin tools/shared.ts），与 L2 无关
//   · L1 保持纯净（引擎依赖根不携带插件配置领域知识）
//   · 其他插件/层如需引用，按需从 builtin 导入
//
// 依赖方向：仅依赖本层（无 import），可被 builtin 及上层引用。
// ============================================================

/** 核心安全配置（路径穿透白名单；write/edit/bash 共享管控） */
export const NS_SECURITY = 'security';

/** Agent 领域：MCP 工具发现与注册（mcp / mcpFile / cacheTtlMs） */
export const NS_AGENT_MCP = 'agent.mcp';

/** Agent 领域：提示词装配开关（guidelines / skills / systemEnv / conversationPartner） */
export const NS_AGENT_PROMPT = 'agent.prompt';

/** Agent 领域：日期注入开关（enabled；agent-datetime 插件 runStart 追加日期行到 system prompt） */
export const NS_AGENT_DATETIME = 'agent.datetime';

/** Agent 领域：记忆注入预算（memoryBudgetTokens） */
export const NS_AGENT_MEMORY = 'agent.memory';

/** Agent 领域：会话上下文管理（maxContextTokens / archiveTokenRatio / keepRecentRatio / ...） */
export const NS_AGENT_SESSION = 'agent.session';

/** 工具配置：bash 命令管控（defaultTimeout / maxTimeout / outputMaxLen / maxBuffer） */
export const NS_TOOL_BASH = 'tool.bash';

/** 工具配置：web_search（provider / apiKey） */
export const NS_TOOL_WEB_SEARCH = 'tool.web_search';

// ============================================================
// 执行 meta 键（CurrentContext.meta 的语义化键；放本层供 builtin 及上层引用）
// ============================================================

/**
 * 归档整理 run 标记（值 true / { reason? }）。
 * L1 只声明通用 meta 字典，不解释键——此常量是 builtin 归档功能的约定。
 */
export const META_ARCHIVE_REVIEW = 'archive-review';
