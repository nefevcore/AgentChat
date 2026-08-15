// ============================================================
// src/shared/types —— 跨端共享类型契约（零依赖，谁都能引）
//
// webui/TUI/Desktop/后端 services 共用的跨端契约，消除"两端各维护
// 一份类型导致漂移"的问题（如 PersistedMessage role 不一致）。
//
// 判断标准：前端已复制一份的类型 = 跨端共享（进这里）；
// 只 src 内部用的核心契约（LLMRequest/AgentContext/hooks）留在 src/core/types。
//
// 铁律：本文件零运行时依赖（不 import 任何模块），仅声明类型。
//       MessageSource 是 core 与 UI 共用的业务来源元数据，放在这里作为
//       另一棵类型依赖根；core/types 仅 type-import 它（编译后无运行时引用）。
// ============================================================

/**
 * 消息来源 kind：回答"谁产生了这条入站消息"。
 * 与角色（role，LLM 传输语义）正交；Agent 间身份仍由 agent_id 表达。
 */
export type MessageSourceKind =
  /** 人类用户输入 */
  | 'user'
  /** 另一个 Agent 发来的消息（send_agent / 群发等） */
  | 'agent'
  /** 运行时/系统注入（通用兜底） */
  | 'system'
  /** 定时器触发 */
  | 'timer'
  /** 群聊事件触发 */
  | 'group'
  /** 子 Agent 输出/通知 */
  | 'subagent'
  /** continue_turn / chat.continue 自我续推 */
  | 'continue'
  /** 重启后自动恢复 */
  | 'restart'
  /** 归档整理轮 */
  | 'archive';

/** 消息来源 form：回答"这是一条什么形态的信息"。 */
export type MessageForm =
  /** 普通对话输入 */
  | 'prompt'
  /** 系统/事件给出的引导提示（原 trigger hint） */
  | 'hint'
  /** 一次性事件通知（后台任务完成等，DSH 式 notice） */
  | 'notice'
  /** 恢复/继续会话的系统信号 */
  | 'resume'
  /** Agent 间转述的消息 */
  | 'relay';

/** 入站消息的来源元数据（前端渲染 / 持久化 / 日志共用）。 */
export interface MessageSource {
  kind: MessageSourceKind;
  form?: MessageForm;
  /** 一行摘要：前端分隔符与活动记录展示用；缺省由 UI 从 content 截断 */
  summary?: string;
  /** 旧 role='trigger' 数据归一化时保留的诊断标记 */
  legacyRole?: 'trigger';
}

/** 消息角色（持久化格式；与 builtin hooks/session toPersistedRole 对齐） */
export type PersistedRole = 'agent' | 'system' | 'tool' | 'error' | 'event';

/** 工具调用（OpenAI 原生格式，前后端通用；arguments 为 JSON 字符串） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 持久化消息（1:1 会话文件 messages.jsonl 的一行） */
export interface PersistedMessage {
  role: PersistedRole;
  content: string | null;
  /** 消息来源 Agent ID（多 Agent 会话中辨识归属） */
  agent_id?: string;
  /** 工具名称（tool 角色消息提供） */
  name?: string;
  /** 工具调用 ID（tool 角色消息，与 assistant.tool_calls 配对） */
  tool_call_id?: string;
  /** 工具调用（assistant 消息，OpenAI 原生格式） */
  tool_calls?: ToolCall[];
  /** 思维链/推理内容（DeepSeek reasoning_content） */
  reasoning_content?: string;
  /** UI 展示标签 */
  label?: string;
  /** 消息来源元数据（event 角色必有；agent 角色可选） */
  source?: MessageSource;
  /** 消息唯一标识（前端定位与删除） */
  message_id?: string;
  /** 原始时间戳（归档时不重写） */
  timestamp?: string;
}

/** Agent 公开信息（列表/档案展示用） */
export interface AgentInfo {
  agent_id: string;
  name: string;
  description?: string;
  avatar?: string;
  tags?: string[];
  /** 虚拟 Agent（user 端点，无 LLM） */
  virtual?: boolean;
  llm?: { provider?: string; model?: string };
}

/** 群组信息 */
export interface GroupInfo {
  group_id: string;
  name: string;
  description?: string;
  participants: string[];
}

/** 群组持久化消息（groups/<id>/messages.jsonl 的一行） */
export interface GroupPersistedMessage {
  /** 所属群组 ID（可选，便于前端聚合） */
  group_id?: string;
  role: PersistedRole;
  content: string;
  agent_id?: string;
  name?: string;
  label?: string;
  message_id?: string;
  timestamp?: string;
  source?: MessageSource;
}

/** 插件元数据（跨端共享；前端 PluginSettings 等展示用） */
export interface PluginMeta {
  /** 插件唯一标识 */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /** 类型（兼容旧字段；新架构统一 'plugin'） */
  type?: string;
  /** 是否启用（getAgentPlugins 返回时附加） */
  enabled?: boolean;
  [key: string]: unknown;
}

// ============================================================
// UI/Web 插件化 P1 契约（与 preview @agentchat/protocol 对齐；
// docs/ui-web-pluginization-plan.md §2.2）。P2 UI 迁移直接消费。
// ============================================================

export type PluginPermission = 'fs' | 'network' | 'process' | 'shell' | 'ui';
export type PluginSource = 'builtin' | 'installed' | 'dev' | 'session';
export type HookKind =
  | 'runStart' | 'runEnd' | 'turnStart' | 'turnEnd'
  | 'toolExecutionStart' | 'toolExecutionEnd' | 'fallback';

export interface PluginProvides {
  tools: string[];
  hooks: string[];
}

export interface PluginInfo {
  name: string;
  label?: string;
  description?: string;
  version?: string;
  source: PluginSource;
  permissions?: PluginPermission[];
  grantedPermissions?: PluginPermission[];
  owner?: string;
  installedAt?: string;
  entry?: string;
  /** 插件目录（dev 扫描 / 会话加载用；P3 UI 发布/重载需要） */
  dir?: string;
  provides?: PluginProvides;
}

export interface HookInfo {
  name: string;
  kind: HookKind;
  label: string;
  description?: string;
  owner: string;
  configNs?: string;
  security?: boolean;
}

export interface AgentToolInfo {
  name: string;
  label?: string;
  description?: string;
  requires?: string[];
  ns?: string;
  owner?: string;
}

export interface AssemblyView {
  agentId: string;
  presets: string[];
  available: PluginInfo[];
  hooks: {
    order: Partial<Record<HookKind, string[]>>;
    catalog: HookInfo[];
  };
  tools: {
    explicit: string[];
    enabled: string[];
    catalog: AgentToolInfo[];
  };
  legacy?: { hasPlugins: boolean };
}

/** PUT /api/plugins/assembly/:agentId 请求体 */
export interface AssemblyUpdate {
  presets?: string[];
  tools?: string[];
  hooks?: Partial<Record<HookKind, string[]>>;
}

export interface StagingRecord {
  id: string;
  manifest: { name: string; version: string; entry?: string; permissions?: PluginPermission[] };
  sourceDir: string;
  hash: string;
  owner: string;
  createdAt: string;
  requiredGrants: PluginPermission[];
}

export interface PluginCatalog {
  plugins: PluginInfo[];
  hooks: HookInfo[];
  tools: AgentToolInfo[];
}

export interface PluginLibrary {
  installed: PluginInfo[];
  staging: StagingRecord[];
}

export interface PluginPermissionsView {
  vocabulary: PluginPermission[];
  defaultGranted: PluginPermission[];
  explicitRequired: PluginPermission[];
}

export interface StagingFileInfo {
  path: string;
  size: number;
}

export interface StagingFileContent {
  path: string;
  content: string;
}

// ============================================================
// P5 深度 UI 扩展契约（与 preview @agentchat/protocol 对齐）
// ============================================================

export type UISlotId =
  | 'perspective'
  | 'tool-result'
  | 'message-view'
  | 'ws-event'
  | 'settings-tab:global'
  | 'settings-tab:agent'
  | 'sidebar-action'
  | 'global-style';

export interface UIExtensionDescriptor {
  name: string;
  version: string;
  entry: string;
  styles: string[];
  slots: UISlotId[];
  isolated: boolean;
  status: 'installed' | 'session';
  grantedPermissions: PluginPermission[];
}

export interface UISlotInfo {
  id: UISlotId;
  label: string;
  description: string;
}
