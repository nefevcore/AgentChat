// ============================================================
// @agentchat/protocol —— 跨端共享类型契约（零运行时依赖）
//
// webui/TUI/Desktop/后端服务共用的跨端契约。
// 消息来源（MessageSource）等基础域契约由 @agentchat/types 收编，
// 本文件从 @agentchat/types 复用；持久化/DTO 定义在本包。
// ============================================================

import type { MessageSource, PersistedToolCall } from '@agentchat/types';

export type { MessageSource, MessageForm, MessageSourceKind, PersistedToolCall } from '@agentchat/types';
export { isBackgroundRunSource } from '@agentchat/types';

/** 消息角色（持久化格式；与 builtin hooks/session toPersistedRole 对齐，事件消息统一为 event） */
export type PersistedRole = 'agent' | 'system' | 'tool' | 'error' | 'event';

/** 工具调用（OpenAI 原生格式，前后端通用；等价 @agentchat/types.PersistedToolCall） */
export type ToolCall = PersistedToolCall;

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
  /** 消息来源元数据（role='event' 必有；role='agent' 可选） */
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
// UI/Web 插件化 P1 契约（docs/ui-web-pluginization-plan.md §2.2）
// ============================================================

/** 插件权限词汇表（ui = UI 扩展权限；P1 仅类型占位，执行期 gate 在 P5 接入） */
export type PluginPermission = 'fs' | 'network' | 'process' | 'shell' | 'ui';

/** 插件来源：内置 / 已安装 / 开发目录 / 会话级加载 */
export type PluginSource = 'builtin' | 'installed' | 'dev' | 'session';

/** 七类钩子（与 HooksService.HookKind 一一对应） */
export type HookKind =
  | 'runStart' | 'runEnd' | 'stepStart' | 'stepEnd'
  | 'toolExecutionStart' | 'toolExecutionEnd' | 'fallback';

/** manifest.provides 能力声明（声明优先，注册中心反查补漏） */
export interface PluginProvides {
  tools: string[];
  hooks: string[];
}

/** 一个可装载插件（内置 / 已安装 / 开发中 / 会话中） */
export interface PluginInfo {
  name: string;
  label?: string;
  description?: string;
  version?: string;
  source: PluginSource;
  permissions?: PluginPermission[];
  /** installed/session 才有：实际授予的权限快照 */
  grantedPermissions?: PluginPermission[];
  /** 发布者 / 会话归属 Agent */
  owner?: string;
  installedAt?: string;
  entry?: string;
  /** 插件目录（dev 扫描 / 会话加载用；P3 UI 发布/重载需要） */
  dir?: string;
  /** 权威能力声明（manifest.provides 或注册中心反查） */
  provides?: PluginProvides;
}

/** 一个注册钩子（owner 插件 + kind + 元数据） */
export interface HookInfo {
  name: string;
  kind: HookKind;
  label: string;
  description?: string;
  owner: string;
  /** 该 kind 内的推荐顺序（注册顺序，0 起；UI 重新启用/排序用） */
  order: number;
  /** 配置命名空间（UI 弹窗） */
  configNs?: string;
  /** 该钩子实际消费的命名空间字段（弹窗按此过滤；缺省 = 显示命名空间全部字段） */
  fields?: string[];
  /** 只读安全概览 */
  security?: boolean;
  /** 基础设施钩子：自动进入每个 run，前端展示 automatic 徽章并禁止 toggle */
  automatic?: boolean;
}

/** 工具目录条目 */
export interface AgentToolInfo {
  name: string;
  label?: string;
  description?: string;
  requires?: string[];
  ns?: string;
  owner?: string;
}

/** 工具级意图覆盖（与 @agentchat/agent-config ToolOverrides 对齐） */
export interface ToolOverrides {
  /** 显式启用（默认关闭的工具只能在此启用） */
  include?: string[];
  /** 显式停用（优先级最高） */
  exclude?: string[];
}

/** Agent 能力装配快照（presets + hooks 启用清单 + tools 意图覆盖） */
export interface AssemblyView {
  agentId: string;
  /** presets：启用哪些插件（顺序无意义） */
  presets: string[];
  /** 已安装/开发中但未启用的插件 */
  available: PluginInfo[];
  /** hooks：启用清单（顺序即执行顺序）+ 全量目录 */
  hooks: {
    order: Partial<Record<HookKind, string[]>>;
    catalog: HookInfo[];
  };
  /** tools：意图覆盖（include/exclude）+ 全量目录 + 当前生效集合 */
  tools: {
    include: string[];
    exclude: string[];
    enabled: string[];
    catalog: AgentToolInfo[];
  };
  /** 旧契约只读标记，提醒迁移 */
  legacy?: { hasPlugins: boolean };
}

/** PUT assembly 请求体 */
export interface AssemblyUpdate {
  presets?: string[];
  tools?: ToolOverrides;
  hooks?: Partial<Record<HookKind, string[]>>;
}

/** 发布暂存待审条目（含哈希、源目录、授予前权限） */
export interface StagingRecord {
  id: string;
  manifest: { name: string; version: string; entry?: string; permissions?: PluginPermission[] };
  sourceDir: string;
  hash: string;
  owner: string;
  createdAt: string;
  /** 需要宿主显式授予的高危权限（process/shell；P5 起含 ui） */
  requiredGrants: PluginPermission[];
}

/** 插件目录（GET /api/plugins/catalog） */
export interface PluginCatalog {
  plugins: PluginInfo[];
  hooks: HookInfo[];
  tools: AgentToolInfo[];
}

/** 插件库快照（GET /api/plugins/library） */
export interface PluginLibrary {
  installed: PluginInfo[];
  staging: StagingRecord[];
}

/** 权限词汇表（GET /api/plugins/permissions） */
export interface PluginPermissionsView {
  vocabulary: PluginPermission[];
  defaultGranted: PluginPermission[];
  explicitRequired: PluginPermission[];
}

/** 暂存目录文件条目 */
export interface StagingFileInfo {
  path: string;
  size: number;
}

/** 暂存文件内容（人审只读代理） */
export interface StagingFileContent {
  path: string;
  content: string;
}

// ============================================================
// P5 深度 UI 扩展契约（docs/ui-web-pluginization-plan.md §7）
// ============================================================

/** UI slot v1 白名单（宿主先开口，插件后填空） */
export type UISlotId =
  | 'perspective'
  | 'tool-result'
  | 'message-view'
  | 'ws-event'
  | 'settings-tab:global'
  | 'settings-tab:agent'
  | 'sidebar-action'
  | 'global-style';

/** 后端向浏览器下发的 UI 扩展清单 */
export interface UIExtensionDescriptor {
  name: string;
  version: string;
  /** 浏览器入口 URL（/ui-plugin/<name>/...） */
  entry: string;
  /** 额外样式 URL（/ui-plugin/<name>/...） */
  styles: string[];
  /** manifest.ui.slots 声明的白名单 */
  slots: UISlotId[];
  /** iframe 隔离档（P5.5；v1 默认 false） */
  isolated: boolean;
  /** installed = 插件库安装（重启恢复）；session = 会话级（重启即失） */
  status: 'installed' | 'session';
  grantedPermissions: PluginPermission[];
}

/** slot 目录条目（GET /api/ui/slots） */
export interface UISlotInfo {
  id: UISlotId;
  label: string;
  description: string;
}

/** 插件 UI 资源变更事件（WS） */
export interface UIExtensionsChangedEvent {
  name: string;
  reason: 'register' | 'unregister' | 'reload';
}

// ============================================================
// 插件域 WS 事件（复用现有 message 通道 data 字段）
// ============================================================

export const PLUGIN_EVENT = {
  /** 插件库目录变化（stage/approve/reject/uninstall/register/unregister） */
  CATALOG_CHANGED: 'plugin.catalog.changed',
  /** PluginHost watch 重载结果 */
  RELOAD: 'plugin.reload',
  /** Agent 装配视图已保存并热重载 */
  ASSEMBLY_CHANGED: 'agent.assembly.changed',
  /** UI 扩展资源注册/卸载/重载（P5） */
  UI_EXTENSIONS_CHANGED: 'ui.extensions.changed',
} as const;

export type PluginEventName = (typeof PLUGIN_EVENT)[keyof typeof PLUGIN_EVENT];

export interface PluginCatalogChangedEvent {
  kind: 'installed' | 'staging' | 'session';
}

export interface PluginReloadEvent {
  name: string;
  status: 'loaded' | 'replaced' | 'failed';
  error?: string;
}

export interface AgentAssemblyChangedEvent {
  agentId: string;
}

export interface PluginEventMap {
  [PLUGIN_EVENT.CATALOG_CHANGED]: PluginCatalogChangedEvent;
  [PLUGIN_EVENT.RELOAD]: PluginReloadEvent;
  [PLUGIN_EVENT.ASSEMBLY_CHANGED]: AgentAssemblyChangedEvent;
  [PLUGIN_EVENT.UI_EXTENSIONS_CHANGED]: UIExtensionsChangedEvent;
}
