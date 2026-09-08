// ============================================================
// settings/types.ts —— 设置面板共享类型
// ============================================================

/** UI/Web 插件化共享契约（与 preview @agentchat/protocol 对齐；M22 后直连 preview 形状） */
export type {
  PluginPermission,
  PluginSource,
  PluginProvides,
  PluginInfo,
  ExtensionTarget,
  ExtensionEntry,
  AssemblyRowInfo,
  AgentToolInfo,
  ToolOverrides,
  AssemblyData,
  AssemblyPatch,
  DevPluginInfo,
  StagingRecord,
  PluginCatalog,
  PluginLibrary,
  PluginPermissionsView,
  StagingFileInfo,
  StagingFileContent,
  UISlotId,
  UIExtensionDescriptor,
  UISlotInfo,
  EventChainEntry,
  EventDescriptionEntry,
  EventPolicyView,
  PluginPatchEntry,
} from '@agentchat/protocol';

/** 字段元数据（归一化后：数组/对象两种 schema 格式统一为数组） */
export interface FieldMeta {
  key: string;
  label: string;
  description?: string;
  type: 'text' | 'password' | 'number' | 'ratio' | 'checkbox' | 'select' | 'file';
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  /** 显示模式：'number'=原始数值, 'percent'=百分比 */
  display?: 'number' | 'percent';
  default?: unknown;
  sensitive?: boolean;
  accept?: string;
  showWhen?: Record<string, unknown>;
}

/** LLM 池条目 */
export interface PoolEntry {
  provider?: string;
  model?: string;
  default?: boolean;
  [k: string]: any;
}

/** Provider 池（模型 / 搜索） */
export interface PoolData {
  llmProviders: Record<string, PoolEntry>;
  searchProviders: Record<string, PoolEntry>;
}

/** Agent 配置双视图（raw=差异编辑 / effective=生效展示） */
export interface AgentConfigViews {
  agent_id: string;
  /** Agent 自身差异配置（编辑底稿，保存只写差异） */
  raw: Record<string, any>;
  /** 全局+Agent 合并后的生效配置（展示用） */
  effective: Record<string, any>;
  sysContent: string;
  agentContent: string;
}

/** 定时任务条目（与后端 TimerEntry 对齐） */
export interface TimerEntry {
  id: string;
  enabled: boolean;
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  time?: string;
  delay?: string;
  delayMin?: string;
  delayMax?: string;
  /** 重复次数：0=永久，N=N次 */
  repeatCount?: number;
  hint: string;
  target?: string;
  source?: string;
  maxSteps?: number;
}
