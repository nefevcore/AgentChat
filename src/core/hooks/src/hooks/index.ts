// ============================================================
// @agentchat/hooks/src/hooks —— 内置钩子目录（前端"可用钩子"列表数据源）
//
// 钩子实现已按扩展域拆分到独立包（agent-prompt/agent-session/
// agent-memory/agent-mcp/security/agent-skill）；注册经各域 plugin.ts 完成。
// ============================================================

/** 内置钩子目录条目元数据 */
export interface BuiltinHookMeta {
  kind: 'runStart' | 'runEnd' | 'toolExecutionStart' | 'toolExecutionEnd';
  label: string;
  description: string;
  /** 该钩子可配置的命名空间（UI 弹窗内编辑该命名空间配置；如 agent.memory / agent.session） */
  configNs?: string;
  /** 特殊标记：非表单配置，弹窗展示只读概览（security-check 路径白名单） */
  security?: boolean;
}

/** 内置钩子目录（前端"可用钩子"列表数据源；name → 元数据） */
export const BUILTIN_HOOK_CATALOG: Record<string, BuiltinHookMeta> = {
  'agent-mcp.open-mcp': { kind: 'runStart', label: 'MCP 工具发现', description: '启动 MCP 并注册工具', configNs: 'agent.mcp' },
  'agent-skill.discovered_skills': { kind: 'runStart', label: '技能注入', description: '发现并注入 Agent 技能清单' },
  'agent-prompt.build-system-prompt': { kind: 'runStart', label: '系统提示装配', description: '构建系统提示（角色/标签/指引/存储/对话信息）' },
  'agent-memory.load-memory': { kind: 'runStart', label: '记忆加载', description: '加载长期记忆', configNs: 'agent.memory' },
  'agent-session.load-history': { kind: 'runStart', label: '历史加载', description: '加载对话历史' },
  'security.security-check': { kind: 'toolExecutionStart', label: '安全检查', description: '拦截敏感工具（档案权限/危险路径）', security: true },
  'hooks.log-tool': { kind: 'toolExecutionEnd', label: '工具日志', description: '工具执行轻量日志' },
  'agent-session.save-session': { kind: 'runEnd', label: '会话持久化', description: '整次执行唯一写盘' },
  'agent-memory.update-memory': { kind: 'runEnd', label: '记忆更新', description: '会话级记忆审查标记' },
  'agent-session.idle-reset': { kind: 'runEnd', label: '空闲计时重置', description: '重置空闲归档计时器' },
  'agent-session.archive-session': { kind: 'runEnd', label: '超长归档', description: '上下文超长归档', configNs: 'agent.session' },
  'agent-session.log-usage': { kind: 'runEnd', label: 'Token 用量记录', description: '记录 Token 用量' },
};
