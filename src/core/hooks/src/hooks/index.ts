// ============================================================
// @agentchat/hooks/src/hooks —— 内置钩子目录（前端"可用钩子"列表数据源）
//
// 钩子实现已按扩展域拆分到独立包（agent-prompt/agent-session/
// agent-memory/agent-mcp/security/agent-skill）；注册经各域 plugin.ts 完成。
// ============================================================

import type { HookKind } from '../service';

/** 内置钩子目录条目元数据 */
export interface BuiltinHookMeta {
  kind: HookKind;
  label: string;
  description: string;
  /** 该钩子可配置的命名空间（UI 弹窗内编辑该命名空间配置；如 agent.memory / agent.session） */
  configNs?: string;
  /**
   * 该钩子实际消费的字段（configNs 命名空间内的子集；缺省 = 显示全部）。
   * 背景：配置按命名空间（领域）组织，一个命名空间常被多方消费
   * （agent.session = ArchiveService 五字段 + query 工具一字段 + load-history 一字段），
   * 弹窗按命名空间整块渲染会混排无关字段。声明 fields 使弹窗精确显示"本钩子的配置"。
   */
  fields?: string[];
  /** 特殊标记：非表单配置，弹窗展示只读概览（security-check 路径白名单） */
  security?: boolean;
}

/** 内置钩子目录（前端"可用钩子"列表数据源；name → 元数据） */
export const BUILTIN_HOOK_CATALOG: Record<string, BuiltinHookMeta> = {
  'agent-mcp.open-mcp': { kind: 'runStart', label: 'MCP 工具发现', description: '启动 MCP 并注册工具', configNs: 'agent.mcp' },
  'agent-skill.discovered_skills': { kind: 'runStart', label: '技能注入', description: '发现并注入 Agent 技能清单' },
  'agent-persona.persona': { kind: 'runStart', label: '人设注入', description: '把 AGENT.md / config.persona 角色块前置注入 system prompt（SYSTEM.md 存在时跳过——完全覆盖语义；无会话键的子 Agent 不装配）' },
  'agent-prompt.build-system-prompt': { kind: 'runStart', label: '系统提示装配', description: '构建系统提示（角色/标签/指引/存储/对话信息）' },
  'agent-datetime.datetime': { kind: 'runStart', label: '日期注入', description: 'system prompt 尾部追加 [当前时间] 日期行（每 run 一次，日内 KV cache 稳定；独立会话跳过保持全静态提示词）', configNs: 'agent.datetime', fields: ['enabled'] },
  'agent-memory.load-memory': { kind: 'runStart', label: '记忆加载', description: '加载长期记忆', configNs: 'agent.memory' },
  'agent-session.load-history': { kind: 'runStart', label: '历史加载', description: '加载对话历史', configNs: 'agent.session', fields: ['groupLoadLimitTokens'] },
  'agent-session.recover-history': { kind: 'runStart', label: '历史恢复调和', description: '恢复 ask_questions 等中断交互：answered 合成工具结果、pending 保持挂起（automatic）' },
  'agent-session.group-contract': { kind: 'runStart', label: '群聊行为契约', description: '群聊触发（kind=group）时注入行为契约：send_group 回复/直接输出无效/沉默权/不刷屏——位于决策点防注意力稀释；文本可按 Agent 覆盖（agent.group.groupContractText）（automatic）', configNs: 'agent.group', fields: ['groupContractText'] },
  'security.security-check': { kind: 'toolExecutionStart', label: '安全检查', description: '拦截敏感工具（档案权限/危险路径）', security: true },
  'agent-session.tool-persist': { kind: 'toolExecutionStart', label: '工具前持久化', description: '工具副作用执行前把 assistant(tool_calls) 落盘；失败阻止工具执行（automatic）' },
  'security.redact-output': { kind: 'toolExecutionEnd', label: '输出脱敏', description: '工具结果写入前脱敏密钥/敏感值', security: true },
  'hooks.log-tool': { kind: 'toolExecutionEnd', label: '工具日志', description: '工具执行轻量日志' },
  'agent-session.step-persist': { kind: 'stepEnd', label: '步骤持久化', description: '每步结束后增量落盘本步消息（automatic）' },
  'singles.auto-title': { kind: 'stepEnd', label: '会话标题生成', description: '独立会话首个推理步结束时 LLM 自动生成会话标题（automatic；失败回落首条消息截断）' },
  'agent-session.save-session': { kind: 'runEnd', label: '会话持久化', description: 'run 结束最终 flush；step 级增量已由 automatic checkpoint 持续落盘（automatic）' },
  'agent-memory.update-memory': { kind: 'runEnd', label: '记忆更新', description: '会话级记忆审查标记' },
  'agent-session.idle-reset': { kind: 'runEnd', label: '空闲计时重置', description: '重置空闲归档计时器' },
  'agent-session.archive-session': { kind: 'runEnd', label: '超长归档', description: '上下文超长归档', configNs: 'agent.session', fields: ['maxContextTokens', 'archiveTokenRatio', 'keepRecentRatio', 'summaryPreviewLen', 'idleArchiveSec'] },
  'agent-session.log-usage': { kind: 'runEnd', label: 'Token 用量记录', description: '记录 Token 用量' },
};

/**
 * 内置钩子推荐顺序（kind 内 name → 位置；即新建 Agent 的出厂装配顺序）。
 *
 * 消费方：
 *   · 后端 getCatalog 的 HookInfo.order（前端"按推荐顺序排序"按钮、
 *     未启用区排序、开启钩子时的锚点插入都以此为准）；
 *   · 文档 docs/assembly-catalog.md §4（保持同步）。
 *
 * 不在表内的钩子（第三方/未来新增）排在全部收录项之后，按注册顺序兜底。
 * 运行时执行顺序仍由 config.hooks 清单决定（数组序即执行序）——本表只是
 * "推荐"默认值与 UI 排序锚点，不改变 collect 的装配语义。
 */
export const RECOMMENDED_HOOK_ORDER: Record<HookKind, string[]> = {
  runStart: [
    'agent-mcp.open-mcp',
    'agent-skill.discovered_skills',
    'agent-persona.persona',
    'agent-prompt.build-system-prompt',
    'agent-datetime.datetime',
    'agent-memory.load-memory',
    'agent-session.load-history',
    'agent-session.recover-history',
    'agent-session.group-contract',
  ],
  toolExecutionStart: [
    'security.security-check',
    'agent-session.tool-persist',
  ],
  toolExecutionEnd: [
    'security.redact-output',
    'hooks.log-tool',
  ],
  stepStart: [],
  stepEnd: [
    'agent-session.step-persist',
    'singles.auto-title',
  ],
  runEnd: [
    'agent-session.save-session',
    'agent-memory.update-memory',
    'agent-session.idle-reset',
    'agent-session.archive-session',
    'agent-session.log-usage',
  ],
  fallback: [],
};

/** 查询钩子在推荐顺序表中的位置（0 起；不在表内返回 undefined） */
export function recommendedHookOrderIndex(kind: HookKind, name: string): number | undefined {
  const idx = RECOMMENDED_HOOK_ORDER[kind]?.indexOf(name);
  return idx !== undefined && idx >= 0 ? idx : undefined;
}
