// ============================================================
// shims/@agentchat/protocol.ts —— 协议契约自包含垫片（preview 同源迁移）
//
// src UI 从 '@agentchat/protocol' import 的类型 + 唯一运行时值
// （isBackgroundRunSource）。原包 re-export 自 '@agentchat/types'，
// 此处内联为单文件（零 workspace 依赖；vite alias + tsconfig paths
// 双指向本文件）。内容与 src/sdk/protocol + src/core/types 逐字段
// 一致——src UI 零改动的代价是本文件必须手动跟随上游演化（有
// adapter.test.ts 之外的独立 vigilance：src 轨道冻结，实际风险低）。
// ============================================================

// ---- 内联自 @agentchat/types（MessageSource 契约族） ----

export type MessageSourceKind =
  | 'user'
  | 'agent'
  | 'system'
  | 'timer'
  | 'group'
  | 'subagent'
  | 'continue'
  | 'restart'
  | 'archive';

export type MessageForm =
  | 'prompt'
  | 'hint'
  | 'notice'
  | 'resume'
  | 'relay';

export interface MessageSource {
  kind: MessageSourceKind;
  form?: MessageForm;
  summary?: string;
  message_id?: string;
  legacyRole?: 'trigger';
}

export interface PersistedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 判断一次 run 是否属于"后台/系统注入"会话（src/core/types 原样）。
 * preview 的 ac-ws-bridge 已在桥接侧完成同类过滤——帧到达即可信；
 * 本函数仍被 feed.ts 的 chat.start 处理消费（保持 src 行为等价）。
 */
export function isBackgroundRunSource(source?: MessageSource): boolean {
  if (!source) return false;
  switch (source.form) {
    case 'hint':
    case 'resume':
    case 'notice':
      return true;
    case 'prompt':
    case 'relay':
      return false;
  }
  return source.kind === 'timer'
    || source.kind === 'group'
    || source.kind === 'subagent'
    || source.kind === 'continue'
    || source.kind === 'restart'
    || source.kind === 'archive';
}

// ---- 以下与 @agentchat/protocol（src/sdk/protocol）逐字段一致 ----

export type PersistedRole = 'agent' | 'system' | 'tool' | 'error' | 'event';

export type ToolCall = PersistedToolCall;

export interface PersistedMessage {
  role: PersistedRole;
  content: string | null;
  agent_id?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  label?: string;
  source?: MessageSource;
  message_id?: string;
  timestamp?: string;
}

export interface AgentInfo {
  agent_id: string;
  name: string;
  description?: string;
  avatar?: string;
  tags?: string[];
  virtual?: boolean;
  llm?: { provider?: string; model?: string };
}

export interface GroupInfo {
  group_id: string;
  name: string;
  description?: string;
  participants: string[];
}

export interface SingleSessionInfo {
  id: string;
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

export interface SingleSessionCreateInput {
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  workspaceId?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupPersistedMessage {
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

export interface PluginMeta {
  name: string;
  label: string;
  description?: string;
  type?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export type PluginPermission = 'fs' | 'network' | 'process' | 'shell' | 'ui';

export type PluginSource = 'builtin' | 'installed' | 'dev' | 'session';

/**
 * 供给面声明（M23 E3/G4 对象形状；存量 {tools} 兼容——tools 恒收编为数组，
 * hooks 域已删除）。ui/agents 为预留面（保留字护栏/对账用）。
 * events（M25 P2）：string | {name, description?} 混排（事件视图声明目录）。
 */
export interface PluginProvides {
  tools?: string[];
  llmProviders?: string[];
  events?: Array<string | { name: string; description?: string }>;
  ui?: boolean;
  agents?: string[];
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
  dir?: string;
  provides?: PluginProvides;
  /** 携带非隔离 UI（manifest.ui.isolated === false；M23 F7/F8 如实呈现：
   *  可读会话流、以用户会话身份调全部 RPC 含写口） */
  uiNonIsolated?: boolean;
}

/** 事件落点已知子集（UI 徽章标签映射用；A1 注册制后 wire 面 targets 为
 *  string——落点随行声明自由生长） */
export type ExtensionTarget =
  | 'loop/before-run'
  | 'tool/before-execute'
  | 'tool/transform-result'
  | 'loop/transform-run'
  | 'loop/after-run';

/**
 * 扩展目录条目（plugin/extension-catalog；M22 D4 → A1 注册制）：
 * UI「扩展」单元 = 消费事件的扩展行（行包入口模块自述，registry 聚合）。
 */
export interface ExtensionEntry {
  /** AgentConfig.settings 键（persona/memory/…；动态插件 = manifest.name） */
  name: string;
  /** 装配行包名；可见性 = row ∈ plugin/rows（行摘除 → 条目自动隐藏） */
  row: string;
  label: string;
  description: string;
  /** 事件落点（listeners[].event 派生；空 = 纯能力供给行，如 web-tools 工具行） */
  targets: string[];
  /** 基础设施行：装载即生效，per-Agent 不可关 */
  automatic?: boolean;
  /** 全局默认参数命名空间（= settings 键锚点；M24 P4：插件库·配置弹窗写 config/set → settings.<configNs>） */
  configNs?: string;
  /** per-Agent 参数面字段（settings[name].*；2026-08-30 起携带字段级描述） */
  fields?: Array<string | { name: string; description?: string; type?: 'string' | 'text' | 'number' | 'boolean' | 'list' | 'json' | 'file'; enum?: string[]; min?: number; max?: number; step?: number; default?: unknown }>;
}

/** cordis 装配行（plugin/rows；M18 附 package.json 元数据。M23 F11：origin
 *  增第三态 'dynamic' = Agent 开发/安装的动态插件行（registry.json ∪ listLoaded） */
export interface AssemblyRowInfo {
  name: string;
  fibers: number;
  active: boolean;
  origin: 'package' | 'internal' | 'dynamic';
  description?: string;
  version?: string;
  /** origin='dynamic'：归属 Agent（开发/安装者） */
  owner?: string;
  /** yml/include 树行 id（M24 P4：行偏好层开关锚点——patch 按 id 匹配） */
  entryId?: string;
}

export interface AgentToolInfo {
  name: string;
  label?: string;
  description?: string;
  requiredTags?: string[];
  /** JSON Schema（M24 P4：目录 · 工具视图 schema 弹窗数据源） */
  parameters?: Record<string, unknown>;
  ns?: string;
  /** 注册方行名（tools/list 附带，注册即归属的框架侧事实——目录按来源行分组折叠锚点） */
  owner?: string;
}

export interface ToolOverrides {
  include?: string[];
  exclude?: string[];
}

/**
 * preview agents/assembly 直连形状（M22 P2：src AssemblyView 适配层退场，
 * 前端直消费后端形状）。settings = 具名配置（name → 配置对象），
 * tools = include/exclude 意图 + 全量目录 + 生效集合。
 */
export interface AssemblyData {
  agentId: string;
  settings: { enabled: string[]; configs: Record<string, unknown> };
  tools: {
    include: string[];
    exclude: string[];
    enabled: string[];
    catalog: AgentToolInfo[];
  };
}

/** agents/assembly/update 补丁（settings per-name 浅合并 / null 删除——M22 D5） */
export interface AssemblyPatch {
  tools?: ToolOverrides;
  settings?: Record<string, Record<string, unknown> | null>;
}

/** 开发插件（plugin/dev-scan；M22 D7：<数据根>/plugins/<agentId>/<name>/） */
export interface DevPluginInfo {
  name: string;
  version?: string;
  description?: string;
  owner: string;
  dir: string;
  permissions?: PluginPermission[];
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
  /** cordis 装配行原始清单（插件库「插件目录」页签） */
  rows: AssemblyRowInfo[];
  /** 扩展目录（plugin/extension-catalog ∩ rows） */
  extensions: ExtensionEntry[];
  tools: AgentToolInfo[];
  /** 已装载插件名（plugin/loaded；安装卡片三态徽章用） */
  loaded: string[];
  /** 装载失败记录（plugin/loaded.failed——M22 D6） */
  failed: Array<{ name: string; error: string }>;
  /** 熔断跳过记录（plugin/loaded.skipped——M23 G9 第四态"已熔断"徽章） */
  skipped?: Array<{ name: string; reason: string; count: number }>;
  /** 安全模式（plugin/loaded.safeMode——M23 L8 横幅：动态插件本次全部未装载） */
  safeMode?: boolean;
}

export interface PluginLibrary {
  installed: PluginInfo[];
  staging: StagingRecord[];
  dev: DevPluginInfo[];
  /** 数据根（plugin/dev-scan 透出；dev 路径提示用） */
  root?: string;
}

/**
 * 事件执行链条目（events/listeners；M23 P4）：listeners 数组序 = waterfall
 * 执行序；owner 为裸 fiber 名（M25 聚合为行名 row——治理键仍用 owner 原文）。
 * description = 注册时自述（ctx.on 第三参；2026-08-30 起透出）。
 */
export interface EventChainEntry {
  name: string;
  listeners: Array<{ owner: string; row?: string; prepend: boolean; global: boolean; description?: string }>;
}

/**
 * 事件描述声明条目（events/descriptions；M25 P2）：owning 行目录声明 ∪
 * 动态插件 manifest provides.events。全量事件清单以声明目录为准
 * （events/listeners 天然漏零监听器事件）。description 仅真实声明
 * （2026-08-30 起无模板兜底——未声明时前端不渲染事件描述行）。
 */
export interface EventDescriptionEntry {
  owner: string;
  event: string;
  description?: string;
  role?: string;
  facet?: string;
  respectsEnabled?: boolean;
  source: 'builtin' | 'dynamic';
  automatic?: boolean;
}

/** events/policy-list 形状（M25 P2 治理面） */
export interface EventPolicyView {
  disabled: string[];
  live: string[];
}

/**
 * 行偏好层条目（plugin/patch-list；M23 P3-lite）：cordis.patch.yml 的官方
 * PatchOptions 首期子集 {id, disabled} + 未知键透传。
 */
export interface PluginPatchEntry {
  id: string;
  disabled?: boolean | null;
  [key: string]: unknown;
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

export interface UIExtensionsChangedEvent {
  name: string;
  reason: 'register' | 'unregister' | 'reload';
}

export const PLUGIN_EVENT = {
  CATALOG_CHANGED: 'plugin.catalog.changed',
  RELOAD: 'plugin.reload',
  ASSEMBLY_CHANGED: 'agent.assembly.changed',
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
