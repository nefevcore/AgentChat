// ============================================================
// config.ts —— AgentConfig 契约 + 词汇纯函数（M2.1）
//
// AgentConfig 契约 owning 迁 preview 轨（现状 owning = src/ac-agents；
// cutover 时随行集归并退役）。词汇函数语义平移：tierOf / toolModeOf /
// displayNameOf / resolveToolNames —— 唯一换轨：tools 条目词 = 精确工具名
// ∨ 行引用（A9/A10：tag 词汇全链退役；'tag:<t>' 不再是合法词形）。
// settingsOf 纯函数化：全局默认层 ∪ 本差异层合成（deepMerge 语义见注释）。
// ============================================================

/** Agent 配置（Agent 是数据：注册进注册表，而非挂成插件行） */
export interface AgentConfig {
  id: string;
  /** 模型名。virtual Agent（如 user）可省略——virtual 只记事件不跑 loop */
  model?: string;
  /** 虚拟 Agent 标志：不驱动 LLM 循环的会话参与方（如 user） */
  virtual?: boolean;
  /** 预设 Agent 标志：独立会话选用目标；不进名册、不收协作消息、不可管理面改 */
  preset?: boolean;
  provider?: string;
  system?: string;
  /**
   * 暴露给模型的工具面声明（A10 声明面 = 行集引用）：
   *   · string[] —— 点名清单（精确工具名 ∨ 行名——行集谓词：点名工具 ∨ 引用行）
   *   · {include?, exclude?} —— include 白名单 / exclude 增量停用
   * 缺省 = 行集全集。tag 引用（'tag:<t>'）已随 tag 机制解体退役（cr-484）。
   */
  tools?: string[] | { include?: string[]; exclude?: string[] };
  /** LLM 采样参数白名单透传（temperature/max_tokens/…——无法覆盖保留键） */
  llmParams?: Record<string, unknown>;
  /** 最大步数（>0 = trigger 上限；缺省/0 = 不限） */
  maxSteps?: number;
  /** 显示名（单源；回退链 name ?? description） */
  name?: string;
  /** 一句话简介（LLM 工具面词汇；不是显示名） */
  description?: string;
  /**
   * 能力标签：档位词（full-access / sandbox-access，缺省 base-access）与
   * 模式词（tc-none / tc-programmatic，缺省 tc-base）——tierOf / toolModeOf
   * 单源判定。能力 tag 语义已随 tag 机制解体退役（行集引用替代）。
   */
  tags?: string[];
  /** 具名扩展设置：键 = 稳定单元名，值 = 该插件在本 Agent 上的配置 */
  settings?: Record<string, unknown>;
}

/** 端点显示名单源解析（回退链 name ?? description；空白视同缺省） */
export function displayNameOf(config: AgentConfig | undefined): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config.name === 'string' && config.name.trim() !== '') return config.name;
  if (typeof config.description === 'string' && config.description.trim() !== '') return config.description;
  return undefined;
}

/** 访问档位（access-tier §四）：tags 档位词判定 */
export type AccessTier = 'full-access' | 'sandbox-access' | 'base-access';

/** 档位强度序（base < sandbox < full） */
export const TIER_RANK: Record<AccessTier, number> = {
  'base-access': 0,
  'sandbox-access': 1,
  'full-access': 2,
};

/** 档位判定单源：full 优先；未注册 → base（fail-closed 方向） */
export function tierOf(agent: AgentConfig | undefined): AccessTier {
  const tags = agent?.tags;
  if (!tags) return 'base-access';
  if (tags.includes('full-access')) return 'full-access';
  if (tags.includes('sandbox-access')) return 'sandbox-access';
  return 'base-access';
}

/** 工具调用模式（tc-* 标签轴）：none 优先（无工具是最强约束，fail-closed） */
export type ToolMode = 'tc-none' | 'tc-base' | 'tc-programmatic';

export function toolModeOf(agent: AgentConfig | undefined): ToolMode {
  const tags = agent?.tags;
  if (!tags) return 'tc-base';
  if (tags.includes('tc-none')) return 'tc-none';
  if (tags.includes('tc-programmatic')) return 'tc-programmatic';
  return 'tc-base';
}

/**
 * 解析 AgentConfig.tools 为生效工具面清单（行集谓词求值半边：条目词
 * = 精确工具名 ∨ 行名——行名由 ac-rowset-core 换行集清单再展工具，
 * 本函数只做词形归一与 include/exclude 合成）。
 *   · undefined → undefined（= 行集全集；调用方语义）
   *   · string[]  → 原样清单
   *   · {include} → include；{exclude} → undefined（全集减法由调用方持全集）
   *   · {include,exclude} → include 减 exclude
 */
export function resolveToolNames(
  tools: AgentConfig['tools'],
): string[] | undefined {
  if (tools === undefined) return undefined;
  if (Array.isArray(tools)) return [...tools];
  const include = Array.isArray(tools.include) ? [...tools.include] : undefined;
  const exclude = Array.isArray(tools.exclude) ? new Set(tools.exclude) : new Set<string>();
  if (include === undefined) return undefined;
  return include.filter((n) => !exclude.has(n));
}

/**
 * 具名设置合成（settingsOf 纯函数化）：全局默认层 ∪ 本差异层——
 * 本层键覆盖全局层同名键，深层对象递归合并（现状 deepMerge 语义，
 * 纯函数内联实现——零外部依赖）。
 */
export function settingsOf(
  globalSettings: Record<string, unknown> | undefined,
  agentSettings: Record<string, unknown> | undefined,
  unit: string,
): unknown {
  const g = globalSettings?.[unit];
  const a = agentSettings?.[unit];
  if (a === undefined) return g;
  if (g === undefined || typeof g !== 'object' || typeof a !== 'object' || g === null || a === null) {
    return a;
  }
  return deepMerge(g as Record<string, unknown>, a as Record<string, unknown>);
}

/** 深合并（本层覆盖全局层；数组与原生值不深并——覆盖语义） */
export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    if (typeof b === 'object' && b !== null && !Array.isArray(b)
      && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
