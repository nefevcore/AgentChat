// ============================================================
// config.ts —— AgentConfig 契约 + 词汇纯函数（M2.1）
//
// AgentConfig 契约 owning 迁 preview 轨（现状 owning = packages/ac-agents；
// cutover 时随行集归并退役）。词汇函数语义平移：accessOf（cr-947 前名
// tierOf）/ toolModeOf / displayNameOf / resolveToolNames —— 唯一换轨：
// tools 条目词 = 精确工具名 ∨ 行引用（A9/A10：tag 词汇全链退役；
// 'tag:<t>' 不再是合法词形）。settingsOf 纯函数化：全局默认层 ∪ 本差异
// 层合成（deepMerge 语义见注释）。
// cr-953：AgentConfig.tags 退役（cr-484 终态收口）——档位/模式词换轨
// 结构化 access / toolMode 字段；能力词门禁随 requiredTags 全链退役
//（授权 = 行装载单闸），browser 层级与 collab admin 归 levels 行内档位；
// 存量 tags 由 readAgentConfig 读侧归一（normalizeLegacyTags 单源）。
// ============================================================

/** Agent 配置（Agent 是数据：注册进注册表，而非挂成插件行） */
export interface AgentConfig {
  id: string;
  /** 模型名。virtual Agent（如 user）可省略——virtual 只记事件不跑 loop */
  model?: string;
  /** 虚拟 Agent 标志：不驱动 LLM 循环的会话参与方（如 user） */
  virtual?: boolean;
  provider?: string;
  system?: string;
  /**
  * 暴露给模型的工具面声明（A10 声明面 = 行集引用；◐b cr-691 字段更名
  * tools→rows——词形以行引用为主，名实相符）：
  *   · string[] —— 点名清单（精确工具名 ∨ 行名——行集谓词：点名工具 ∨ 引用行）
  *   · {include?, exclude?} —— include 白名单 / exclude 增量停用
  * 缺省 = 行集全集。tag 引用（'tag:<t>'）已随 tag 机制解体退役（cr-484）。
  * 盘上旧键 tools 由 readAgentConfig 归一（读时兼容，写恒 rows）。
  */
  rows?: string[] | { include?: string[]; exclude?: string[] };
  /**
  * @deprecated cr-1082 access 轴退役：执行面两态（沙箱常量 | full 唯一
  * 授权态，只能由权限门注入）。Agent 底座档位语义迁移 = permission-gate
  * onAsk=allow。字段仅为读侧兼容保留（存量盘值不再参与任何决策）。
  */
  access?: AccessLevel;
  /**
  * 工具调用模式（cr-953 结构化；缺省/缺席 = tc-base）。toolModeOf 单源
  * 判定；patch 面 = tool-mode 键。cr-1049 起开放词：核心两档之外可填
  * 已注册扩展档（ctx.agents.registerToolMode——UI 词面/回退判定经注册表）。
  */
  toolMode?: ToolMode;
  /** LLM 采样参数白名单透传（temperature/max_tokens/…——无法覆盖保留键） */
  llmParams?: Record<string, unknown>;
  /** 最大步数（>0 = trigger 上限；缺省/0 = 不限） */
  maxSteps?: number;
  /** 显示名（单源；回退链 name ?? description） */
  name?: string;
  /** 一句话简介（LLM 工具面词汇；不是显示名） */
  description?: string;
  /**
  * 行内插件档位（cr-906 批4 切片四 / X1 回滚：档位词全部归装配——
  * levels.browser.{observe,manipulate,inject} / levels.collab('admin')；
  * 键 = 插件单元名，值 = 档位词或布尔。cr-1004 批2b：存储归位 v2 差量
  * 条目 config.level〔agent-assembly §四〕，本字段为组合读投影；
  * dev-tools 键随行退役〔cr-520——'dev' 能力词无消费面〕。
  */
  levels?: Record<string, string | boolean>;
  /** 具名扩展设置：键 = 稳定单元名，值 = 该插件在本 Agent 上的配置 */
  settings?: Record<string, unknown>;
}

/**
 * 预设身份词形（保留字）：__<模板键>__——id 即类属（cr-880 判定单源：模板
 * 物化到保留字 id = 预设；同一模板物化到用户 id = 普通身份。类属出生定型
 * 终身不变，不随 config 可变字段漂移——cr-812 重置事故的断根）。历史 id
 * 冻结下划线键（__dsh_minimal__），字符类吃 _。
 */
const PRESET_ID = /^__([a-z0-9_-]+)__$/;

/** 预设身份判定单源：名册/协作/调度/工作区/记忆全消费面经此（cr-880）。 */
export function isPresetId(id: string): boolean {
  return PRESET_ID.test(id);
}

/**
 * 预设 id → 模板键（_ 归一为 -——历史 id __dsh_minimal__ ↔ 模板目录
 * dsh-minimal；cr-880 修复下划线 miss 暗坑：首启物化与 boot 升级通路的
 * 模板查找口）。非预设 id = undefined。
 */
export function presetTemplateKeyOf(id: string): string | undefined {
  const key = PRESET_ID.exec(id)?.[1];
  return key === undefined ? undefined : key.replaceAll('_', '-');
}

/** 端点显示名单源解析（回退链 name ?? description；空白视同缺省） */
export function displayNameOf(config: AgentConfig | undefined): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config.name === 'string' && config.name.trim() !== '') return config.name;
  if (typeof config.description === 'string' && config.description.trim() !== '') return config.description;
  return undefined;
}

/**
 * 执行边界档位词汇（cr-1082 access 轴退役——两态化）：'sandbox-access' =
 * 缺省执行态常量（所有人的沙箱底座——不再有 per-Agent 配置语义）；
 * 'full-access' = 唯一授权态，合法来源唯一 = 权限门注入（设置链 allow /
 * 弹卡批准 / run 缓存命中）。三档 rank 序与 'base-access' 词随轴退役。
 */
export type AccessLevel = 'full-access' | 'sandbox-access';

/**
 * per-call 两态判定单源（cr-1082 批B）：call.access === 'full-access'。
 * Agent 底座合成（agentsOf 查询）随 AgentConfig.access 退役删除——
 * full 只来自门注入，无第二来源。
 */
export function isFullAccess(call: { access?: unknown }): boolean {
  return call.access === 'full-access';
}

/**
 * 工具调用模式（tc-* 轴，cr-1049 开放词）：核心两档 tc-none（无工具
 * ——最强约束，fail-closed）/ tc-base（缺省恒等投影）硬编码于投影核心；
 * 扩展档开放——由模式行经 ctx.agents.registerToolMode 注册（先例
 * tc-programmatic 住 ac-run-code）。string & {} 保字面量补全。
 */
export type ToolMode = 'tc-none' | 'tc-base' | (string & {});

/**
 * 扩展模式注册（cr-1049 注册制）：纯元数据——不点名工具、不含行为。
 * 词面（UI 抉择组/patch-doc 词校验）与「这是扩展档吗」判定消费；
 * 模式与入口工具的强关联活在入口工具自己的 discover 谓词里（两步投影
 * ·发现步），不在这里。注册面：主线 ctx.agents（AgentsService.
 * registerToolMode）与壳内垫片（AgentsShim 同名面）双实现同构。
 * owning 纯库（主线服务与壳垫片共依赖零环）。
 */
export interface ToolModeDef {
  /** 模式词（tc-* 开放词；核心两档 tc-none/tc-base 为保留字不可注册） */
  id: string;
  /** UI 词面（抉择组标签） */
  label: string;
  /** 抉择组说明 */
  description: string;
}

export function toolModeOf(agent: AgentConfig | undefined): ToolMode {
  return agent?.toolMode ?? 'tc-base';
}

/**
 * 存量 tags 词 → 结构化字段归一（cr-953 单源；读侧一次性——readAgentConfig
 * 的 config.json 旧路径与 patch doc.tags 余词共用）：
 *   · 档位词 full-access/sandbox-access → 丢弃（cr-1082 轴退役——语义已
 *     迁 permission-gate onAsk；保留分支仅为吞掉存量词）；
 *   · 模式词 tc-none/tc-programmatic → toolMode（none 优先，结构化赢）；
 *   · admin → levels.collab='admin'（levels 键缺席时补位）；
 *   · observe/manipulate/inject → levels.browser（取最高，缺席补位）；
 *   · 其余能力词（fs/shell/web/delegation/issue-report/infra/sap-adt/
 *     memory/fs_minimal/harness…）丢弃——requiredTags 门禁随 cr-953 退役，
 *     授权 = 行装载，词无消费面。
 * 纯函数（返回新对象；无 legacy 词可归 = 原样返回）。
 */
export function normalizeLegacyTags(config: AgentConfig): AgentConfig {
  const tags = (config as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return config;
  const { tags: _retired, levels: levelsPrior, ...rest } = config as AgentConfig & { tags?: unknown };
  let toolMode = rest.toolMode;
  const levels = { ...(levelsPrior ?? {}) } as Partial<Record<string, string | boolean>>;
  for (const raw of tags) {
    const tag: string = typeof raw === 'string' ? raw : String(raw);
    if (tag === 'full-access' || tag === 'sandbox-access') {
      // cr-1082 access 轴退役：存量 tags 档位词不再归一进 access——丢弃
      //（Agent 底座语义已迁移 permission-gate onAsk；字段仅为读侧兼容）
    } else if (tag === 'tc-none' || tag === 'tc-programmatic') {
      if (toolMode === undefined || (toolMode !== 'tc-none' && tag === 'tc-none')) toolMode = tag as ToolMode;
    } else if (tag === 'admin' && levels.collab === undefined) {
      levels.collab = 'admin';
    } else if (tag === 'observe' || tag === 'manipulate' || tag === 'inject') {
      const order = { observe: 0, manipulate: 1, inject: 2 } as Record<string, number>;
      const prior = levels.browser;
      if (prior === undefined || (typeof prior === 'string' && (order[tag] ?? -1) > (order[prior] ?? -1))) {
        levels.browser = tag;
      }
    }
  }
  const next: AgentConfig = { ...rest } as AgentConfig;
  if (toolMode !== undefined) next.toolMode = toolMode;
  if (Object.keys(levels).length > 0) next.levels = { ...levels } as Record<string, string | boolean>;
  else delete next.levels;
  return next;
}

/**
 * 解析 AgentConfig.rows 为生效工具面清单（行集谓词求值半边：条目词
 * = 精确工具名 ∨ 行名——行名由 ac-rowset-core 换行集清单再展工具，
 * 本函数只做词形归一与 include/exclude 合成）。
 *   · undefined → undefined（= 行集全集；调用方语义）
 *   · string[]  → 原样清单
 *   · {include} → include；{exclude} → undefined（全集减法由调用方持全集）
 *   · {include,exclude} → include 减 exclude
 */
export function resolveToolNames(
  tools: AgentConfig['rows'],
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
