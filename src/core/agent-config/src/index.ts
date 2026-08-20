// ============================================================
// @agentchat/agent-config —— 单 Agent 配置契约（零运行时依赖）
//
// 从 @agentchat/agents 拆出：AgentConfig / AgentPlugin / HookNames /
// getNamespaceConfig / collectToolNames / collectHookNames。
// 只描述"一个 Agent 的设置"，不包含 AgentAssembly 与 createAgentContext。
//
// 铁律：仅类型与纯函数，不 import 任何运行时服务。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { LLMConfig } from '@agentchat/llm';
import { GROUP_CONTRACT_TEXT } from '@agentchat/contracts';

export * from './manifest';
export * from './contracts';

/** 七类钩子的名字集合（与 L1 钩子一一对齐，零映射） */
export interface HookNames {
  /** 整次执行开始钩子名（L1 runStartHook ↔ chat.start） */
  runStart?: string[];
  /** 整次执行结束钩子名（L1 runEndHook ↔ chat.end） */
  runEnd?: string[];
  /** 步骤开始钩子名（L1 stepStartHook ↔ chat.step.start） */
  stepStart?: string[];
  /** 步骤结束钩子名（L1 stepEndHook ↔ chat.step.end） */
  stepEnd?: string[];
  /** 工具执行前钩子名（L1 toolExecutionStartHook ↔ chat.tool_execution.start） */
  toolExecutionStart?: string[];
  /** 工具执行后钩子名（L1 toolExecutionEndHook ↔ chat.tool_execution.end） */
  toolExecutionEnd?: string[];
  /** 兜底钩子名（L1 fallbackHook，失败路径兜底） */
  fallback?: string[];
}

/** 七类钩子的禁用集合（仅作旧契约兼容输入；新契约停用 = 从 hooks 顺序表移除） */
export type HookDisabled = Partial<Record<keyof HookNames, string[]>>;

// ============================================================
// 工具能力标签（requires 受控词汇表）
// ============================================================

/** 基础能力层：默认对所有真实 Agent 开放（不是权限门禁，而是“默认可用性层”） */
export const CAPABILITY_BASE = 'base';
/** 开发调试能力 */
export const CAPABILITY_DEV = 'dev';
/** 平台管理能力 */
export const CAPABILITY_ADMIN = 'admin';
/** 编排/调度能力 */
export const CAPABILITY_CONDUCTOR = 'conductor';

/** 工具能力标签受控词汇表（requires / Agent tags 使用；顺序 = UI 展示顺序） */
export const TOOL_CAPABILITIES = [
  CAPABILITY_BASE,
  CAPABILITY_DEV,
  CAPABILITY_ADMIN,
  CAPABILITY_CONDUCTOR,
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** 旧标签名 → 新标签名（v0.6.2 前 agent 既是实体又是能力层，现统一为 base） */
export const LEGACY_TAG_ALIASES: Record<string, ToolCapability> = {
  agent: CAPABILITY_BASE,
};

/** 判断字符串是否为受控工具能力标签 */
export function isToolCapability(value: string): value is ToolCapability {
  return (TOOL_CAPABILITIES as readonly string[]).includes(value);
}

/** 归一化单个标签（旧 agent → base；其余原样） */
export function normalizeCapabilityTag(tag: string): string {
  return LEGACY_TAG_ALIASES[tag] ?? tag;
}

/** 归一化 Agent 标签数组（去重、旧 agent → base） */
export function normalizeCapabilityTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const canonical = normalizeCapabilityTag(tag);
    if (!seen.has(canonical)) { seen.add(canonical); out.push(canonical); }
  }
  return out;
}

/** 解析器视角的 Agent 有效能力标签：隐式包含 base（旧 agent 别名兼容） */
export function effectiveCapabilityTags(tags: string[] | undefined): Set<string> {
  return new Set([CAPABILITY_BASE, ...normalizeCapabilityTags(tags)]);
}

/** 工具级意图覆盖：include 显式启用，exclude 显式停用（exclude > include > 默认） */
export interface ToolOverrides {
  /** 显式启用（默认关闭的工具，如 requires 为空，只能在此启用） */
  include?: string[];
  /** 显式停用（覆盖默认启用与 include） */
  exclude?: string[];
}

/** 新契约 tools 字段：对象形态；string[] 为旧契约显式清单（兼容输入，写盘时迁移为对象） */
export type ToolSelection = ToolOverrides | string[];

/**
 * 插件装配单元 —— 聚合工具与各阶段钩子的名字声明。
 *
 * 替代旧的扁平字段（tools / pre_hooks / post_hooks）：
 * 每个插件 = 一组工具 + 各阶段钩子，装配时按插件聚合。
 * 字段值为名字（字符串数组），由 L3 插件层按名解析为实例。
 */
export interface AgentPlugin extends HookNames {
  /** 插件名（可选，日志/审计用；纯分组声明，不参与装配） */
  name?: string;
  /** 该插件提供的工具名列表 */
  tools?: string[];
}

/**
 * 旧契约钩子名 → 新契约规范名（L4 拆域后兼容已落盘的 plugins 声明）。
 *
 * 2026-08-15 v0.6.2：钩子实现从单一 builtin 聚合拆分为 agent-prompt/
 * agent-skill/agent-session/agent-memory/agent-mcp/security/hooks 各域，
 * 注册名从 `builtin.*` 改为 `<域>.*`。存量 Agent 配置仍使用旧名，
 * 若直接透传会导致 HooksService 查不到注册（save-session 不落盘等）。
 * 因此在聚合入口统一归一化；未命中的名字原样返回（保留插件自定义名）。
 */
export const LEGACY_HOOK_ALIASES: Record<string, string> = {
  'builtin.open-mcp': 'agent-mcp.open-mcp',
  'builtin.discovered_skills': 'agent-skill.discovered_skills',
  'builtin.build-system-prompt': 'agent-prompt.build-system-prompt',
  'builtin.load-memory': 'agent-memory.load-memory',
  'builtin.load-history': 'agent-session.load-history',
  'builtin.security-check': 'security.security-check',
  'builtin.log-tool': 'hooks.log-tool',
  'builtin.save-session': 'agent-session.save-session',
  'builtin.update-memory': 'agent-memory.update-memory',
  'builtin.idle-reset': 'agent-session.idle-reset',
  'builtin.archive-session': 'agent-session.archive-session',
  'builtin.log-usage': 'agent-session.log-usage',
};

/** 旧契约钩子名 → 新契约规范名（未命中原样返回） */
export function normalizeHookName(name: string): string {
  return LEGACY_HOOK_ALIASES[name] ?? name;
}

/** 读取 Agent 配置的命名空间（缺省返回空对象） */
export function getNamespaceConfig(config: AgentConfig, ns: string): Record<string, unknown> {
  const v = config[ns];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * 群聊行为契约文本（可配置）：agent.group.groupContractText 覆盖，
 * 空串/缺省/非字符串回落正典 GROUP_CONTRACT_TEXT（@agentchat/contracts，I11 锚定）。
 * 消费方：agent-session.group-contract 钩子（notify 模式）与 router legacy hint——
 * 用户可自行实验更优文案（对照观察沉默率/回复质量），默认文本受快照测试保护。
 * 独立命名空间 agent.group（非 agent.session）：group-contract 钩子弹窗只显示本域字段。
 */
export function groupContractTextOf(config: AgentConfig | undefined): string {
  if (!config) return GROUP_CONTRACT_TEXT;
  const v = getNamespaceConfig(config, 'agent.group').groupContractText; // NS_AGENT_GROUP（@agentchat/toolkit）
  return typeof v === 'string' && v.trim() ? v : GROUP_CONTRACT_TEXT;
}

/** 按 agent_id 在 agentsDir 中解析 Agent 目录（读 config.json 匹配，失败返回 null） */
export function resolveAgentDir(agentId: string, agentsDir: string): string | null {
  if (!fs.existsSync(agentsDir)) return null;
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) {
        return path.join(agentsDir, entry.name);
      }
    } catch { /* skip */ }
  }
  return null;
}

/** 聚合所有插件的工具名（去重、保序；无插件返回 undefined） */
export function collectToolNames(plugins: AgentPlugin[] | undefined): string[] | undefined {
  if (!plugins || plugins.length === 0) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of plugins) {
    for (const n of p.tools ?? []) {
      if (!seen.has(n)) { seen.add(n); names.push(n); }
    }
  }
  return names.length > 0 ? names : undefined;
}

/** 聚合所有插件的钩子名（按类型分别合并、去重、保序） */
export function collectHookNames(plugins: AgentPlugin[] | undefined): HookNames {
  const merged: HookNames = {};
  for (const p of plugins ?? []) {
    for (const kind of ['runStart', 'runEnd', 'stepStart', 'stepEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const) {
      const list = p[kind];
      if (!list) continue;
      const acc = (merged[kind] ??= []);
      for (const n of list) {
        const canonical = normalizeHookName(n);
        if (!acc.includes(canonical)) acc.push(canonical);
      }
    }
  }
  return merged;
}

// ============================================================
// 装配意图归一化（旧契约兼容输入 → 新契约对象形态）
// ============================================================

const HOOK_KIND_KEYS = ['runStart', 'runEnd', 'stepStart', 'stepEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const;

/** 安全读取字符串数组（非法值返回 undefined） */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.filter((v): v is string => typeof v === 'string'))];
  return out.length > 0 ? out : undefined;
}

/** 去重合并多个名字列表（保序） */
function mergeNameLists(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const name of list ?? []) {
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

/** 合并钩子顺序表（kind 内按数组顺序拼接、去重） */
function mergeHookOrders(a: HookNames, b: HookNames): HookNames {
  const out: HookNames = {};
  for (const kind of HOOK_KIND_KEYS) {
    const merged = mergeNameLists(a[kind], b[kind]);
    if (merged.length > 0) out[kind] = merged;
  }
  return out;
}

/** 读取旧 HookDisabled（仅兼容输入；非法值忽略） */
function readLegacyHookDisabled(value: unknown): HookDisabled {
  const out: HookDisabled = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const kind of HOOK_KIND_KEYS) {
    const list = asStringList((value as Record<string, unknown>)[kind]);
    if (list) out[kind] = list;
  }
  return out;
}

/** 把 tools 字段归一化为 ToolOverrides（string[] = 旧显式清单 → include） */
export function readToolOverrides(value: unknown): ToolOverrides {
  if (Array.isArray(value)) {
    const include = asStringList(value);
    return include ? { include } : {};
  }
  if (value === null || typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;
  const include = asStringList(obj.include);
  const exclude = asStringList(obj.exclude);
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

/**
 * 解析工具级有效意图：新契约 tools 对象 + 旧 plugins 聚合 + 旧 disabledTools。
 * exclude 优先级最高；include 与旧显式清单合并为一份 include。
 */
export function effectiveToolOverrides(config: Pick<AgentConfig, 'tools' | 'plugins' | 'disabledTools'>): ToolOverrides {
  const overrides = readToolOverrides(config.tools);
  const legacyInclude = collectToolNames(config.plugins);
  const legacyExclude = Array.isArray(config.disabledTools)
    ? config.disabledTools.filter((v): v is string => typeof v === 'string')
    : undefined;
  const include = mergeNameLists(overrides.include, legacyInclude);
  const exclude = mergeNameLists(overrides.exclude, legacyExclude);
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/**
 * 读取钩子顺序表并剔除旧 disabledHooks 中的名字。
 * 新契约：顺序表 = 启用清单，不在数组里即停用，没有第二个数组。
 */
export function readHookOrder(value: unknown, disabledValue?: unknown): HookNames {
  const out: HookNames = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  const disabled = readLegacyHookDisabled(disabledValue);
  for (const kind of HOOK_KIND_KEYS) {
    const list = asStringList((value as Record<string, unknown>)[kind]);
    if (!list) continue;
    const blocked = new Set<string>();
    for (const name of disabled[kind] ?? []) {
      blocked.add(name);
      blocked.add(normalizeHookName(name));
    }
    const active = list.filter((name) => !blocked.has(name) && !blocked.has(normalizeHookName(name)));
    if (active.length > 0) out[kind] = active;
  }
  return out;
}

/** 解析钩子有效意图：新契约 hooks 优先；缺省回退旧 plugins 聚合，并应用旧 disabledHooks */
export function effectiveHookOrder(config: Pick<AgentConfig, 'hooks' | 'plugins' | 'disabledHooks'>): HookNames {
  if (config.hooks !== undefined && config.hooks !== null) {
    return readHookOrder(config.hooks, config.disabledHooks);
  }
  return readHookOrder(collectHookNames(config.plugins), config.disabledHooks);
}

/**
 * 正式 Agent 配置。
 *
 * 只显式声明"配置文件可持久化的设置"字段；运行时装配字段
 * （llm 实例 / tools Map / history / steer / 钩子数组 / emit / 中断处理器等）
 * 不属于配置文件，由 createAgentContext 显式映射进 CurrentContext。
 *
 * 运行时可选参数（deepThink / maxSteps）在配置文件与单次投递输入中
 * 同名复用：input 优先级高于 config。
 *
 * 旧契约 plugins?: AgentPlugin[] 保留为兼容输入（迁移期），
 * createAgentContext 在 presets/tools/hooks 缺省时回退聚合旧 plugins。
 */
export interface AgentConfig {
  /** Agent 唯一标识 */
  agent_id: string;
  /** 昵称 */
  name: string;
  /** 是否为虚拟 Agent（无 LLM，仅作路由端点，如 user） */
  virtual?: boolean;
  /**
   * 是否为预设 Agent（插件提供的内置预设，DSH agent-presets 形态）：
   * 可路由、可被独立会话选用，但不出现在 Agent 列表（/api/agents 等过滤）。
   * 由预设物化方（server）置位，不由配置文件声明。
   */
  preset?: boolean;
  /** 能力标签（受控词汇表 base/dev/admin/conductor；base 隐式，旧 agent 自动归一化） */
  tags?: string[];
  /** 头像文件名（位于 agents/<目录>/ 下） */
  avatar?: string;
  /** LLM 设置：池引用字符串 / 内嵌配置 / 引用+覆盖 */
  llm?: LLMConfig | string;
  /** 是否启用深度思考（DeepSeek thinking）；单次投递 input.deepThink 优先 */
  deepThink?: boolean;
  /** 最大 ReAct 步数（trigger 模式防失控；单次投递 input.maxSteps 优先） */
  maxSteps?: number;
  /** 启用哪些插件（cordis 插件 name 列表 = 候选范围过滤器；顺序无意义） */
  presets?: string[];
  /** 工具级意图覆盖：include 显式启用 / exclude 显式停用（旧 string[] 显式清单为兼容输入） */
  tools?: ToolSelection;
  /** @deprecated 旧契约工具停用集合：读入时并入 tools.exclude，写盘时移除 */
  disabledTools?: string[];
  /** 全局钩子顺序表 = 启用清单（顺序即执行顺序；不在数组里 = 停用） */
  hooks?: HookNames;
  /** @deprecated 旧契约钩子禁用集合：读入时从 hooks 剔除，写盘时移除 */
  disabledHooks?: HookDisabled;
  /** @deprecated 旧插件装配单元（迁移期兼容输入，新配置请用 presets/tools/hooks） */
  plugins?: AgentPlugin[];
  /**
   * 扩展/工具/安全命名空间配置。
   *   工具/扩展：  "tool.bash": { "defaultTimeout": 30000 }
   *   路径沙箱：   "security": { "allowedPaths": ["/tmp/scratch/"] }
   *                （write/edit/bash 三个内置工具共享管控，见 getNamespaceConfig）
   */
  [key: string]: any;
}
