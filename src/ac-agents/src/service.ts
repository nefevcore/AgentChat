// ============================================================
// ac-agents/src/service.ts —— Agent 注册中心（cordis Service）
//
// 本包同时是 Agent 域契约的 owning package：AgentConfig 定义在
// 本文件并随服务导出（谁提供 ctx.agents，谁声明 AgentConfig）。
//
// 关键认知：Agent 是【数据】不是插件（迁移研究映射表 #12/#15）。
// ctx.agents 只做注册表；两类注册方：
//   · 插件行（预设 Agent）：fiber 归属，随行卸载自动回收；
//   · 数据驱动（根/运行期 API）：同一 register，disposer 留给调用方手动撤。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { deepMerge } from 'ac-config-merge';

/** Agent 配置（Agent 是数据：注册进注册表，而非挂成插件行） */
export interface AgentConfig {
  id: string;
  /**
   * 模型名。virtual Agent（如 user）可省略——router 遇 virtual 只记事件
   * 不跑 loop，model 永不被消费；非 virtual 缺 model 由消费方抛错。
   */
  model?: string;
  /**
   * 虚拟 Agent 标志（M12，src virtual 平移）：不驱动 LLM 循环的会话参与方
   * （如 user）。router.send 对 virtual Agent 只发 router/message-received
   * （入站入账），不投 loop、不发 reply-completed。
   */
  virtual?: boolean;
  /**
   * 预设 Agent 标志（src preset 平移，ac-agent-presets 物化）：独立会话
   * （singles）的选用目标与空 Agent 会话的默认路由目标（如 __standard__）。
   * 不出现在 Agent 名册（agents/list RPC 过滤）、不接收协作消息
   * （send_agent 拒绝——src 防幽灵会话语义）、不可经管理面修改
   * （ac-agent-admin 写口拦截）。
   */
  preset?: boolean;
  provider?: string;
  system?: string;
  /**
   * 暴露给模型的工具名清单；缺省 = 全部已注册工具。两种形态（M15 对账：
   * src include/exclude 对象形态收编）：
   *   · string[]            —— 白名单（原形态）
   *   · {include?, exclude?} —— include 白名单 / exclude 增量停用；
   *     同给 = include 再减 exclude；均缺省 = 全部
   * 信封构建（router）时解析为 string[]——loop 契约不变。
   */
  tools?: string[] | { include?: string[]; exclude?: string[] };
  /**
   * LLM 采样参数（M15 对账：src LLMConfig 的 per-Agent 调参面收编）。
   * 白名单键透传给每次模型调用（temperature/max_tokens/top_p/
   * response_format/stop/reasoning_effort/thinking/logprobs/top_logprobs/
   * tool_choice）；无法覆盖 model/messages/tools 等保留键。
   * 推理档位词汇（filterLlmParams 归一）：`reasoning_effort` 收
   * 'none'|'low'|'high'|'max'——'none' 在投递边界翻译为
   * `thinking:{type:'disabled'}`（关闭思考输出）。
   */
  llmParams?: Record<string, unknown>;
  /** 最大步数（>0 = trigger 上限；缺省/0 = receive 不限；对齐 loop 契约） */
  maxSteps?: number;
  description?: string;
  /**
   * 能力标签（src tags 平移；Port B P6）：工具 requires 门禁的判定词表
   * （ac-tools 注册的 requires + ac-security 等门禁行消费），UI 侧驱动
   * 徽章与工具启停（canAddTool）。'base' 为内建基础标签（UI 恒视作具备）。
   */
  tags?: string[];
  /**
   * 具名扩展设置（settings[具名]，M24 X1——src 轨道 hooks/命名空间配置
   * 的 preview 形态，词汇全链退役为 settings）：键 = 稳定单元名（行名 /
   * 动态插件 manifest.name，如 'persona' / 'memory'），值 = 该插件在本
   * Agent 上的配置（启用开关/参数皆由插件自定义形状——容器零本体承诺）。
   *
   * 分工：行组合（cordis.yml/TREE）决定【装哪些插件】；settings 决定
   * 【已装插件在本 Agent 上的行为】——核心 AgentConfig 不为任何扩展插件
   * 增加专属字段，防提前耦合。扩展插件经 loop/before-run 等事件按
   * request.agent 查询：ctx.agents.settingsOf(id, '<name>')（M24 A1：
   * 全局默认层 ∪ 本差异层合成；直读差异层用 ctx.agents.get(id)?.settings）。
   */
  settings?: Record<string, unknown>;
}

/**
 * 解析 AgentConfig.tools 为生效工具名清单（router 构建 LoopRunRequest /
 * list_tools 展示实际生效集共用）。
 *   · undefined      → undefined（= 全部已注册；调用方语义）
 *   · string[]       → 原样白名单
 *   · {include}      → include 白名单
 *   · {exclude}      → all 减 exclude（增量停用）
 *   · {include,exclude} → include 减 exclude
 */
export function resolveToolNames(
  tools: AgentConfig['tools'],
  all: string[],
): string[] | undefined {
  if (tools === undefined) return undefined;
  if (Array.isArray(tools)) return [...tools];
  const include = Array.isArray(tools.include) ? tools.include : undefined;
  const exclude = Array.isArray(tools.exclude) ? new Set(tools.exclude) : new Set<string>();
  const base = include ?? all;
  return base.filter((name) => !exclude.has(name));
}

/**
 * 有效能力集（与 ac-security 执行门禁同款合成——工具【可见面】过滤的
 * 单源，2026-09-02 反馈 #1：requiredTags 缺标签的工具此前只在执行时 veto，
 * LLM 仍能在工具清单里看到并浪费一轮调用）：
 *   {'base', 'agent:<id>'} ∪ AgentConfig.tags ∪ settings.security.capabilities
 *   （M24 X4：tags 单源，capabilities 为追加覆盖层——只加不减）。
 * 无身份（宿主直调）= {'base'}。
 */
export function capabilitySetOf(
  ctx: Pick<Context, 'agents'>,
  agentId: string | undefined,
): Set<string> {
  const caps = new Set<string>(['base']);
  if (agentId === undefined) return caps;
  caps.add(`agent:${agentId}`);
  const agent = ctx.agents.get(agentId);
  for (const t of agent?.tags ?? []) caps.add(t);
  const security = ctx.agents.settingsOf(agentId, 'security');
  if (security !== null && typeof security === 'object' && !Array.isArray(security)) {
    const overlay = (security as { capabilities?: unknown }).capabilities;
    if (Array.isArray(overlay)) {
      for (const c of overlay) if (typeof c === 'string' && c) caps.add(c);
    }
  }
  return caps;
}

/** 工具定义对能力集的可见性判定（requiredTags AND；无 requiredTags 恒可见） */
export function toolAllowedFor(
  def: { requiredTags?: string[] } | undefined,
  caps: Set<string>,
): boolean {
  if (!def?.requiredTags || def.requiredTags.length === 0) return true;
  return def.requiredTags.every((t) => caps.has(t));
}

/** llmParams 透传白名单（防覆盖 model/messages/tools 等保留键） */
export const LLM_SAMPLING_KEYS = new Set([
  'temperature',
  'max_tokens',
  'top_p',
  'response_format',
  'stop',
  'reasoning_effort',
  'thinking',
  'logprobs',
  'top_logprobs',
  'tool_choice',
]);

/**
 * 过滤 llmParams 为白名单采样键（未知键丢弃——防协议注入）。
 * 归一（推理档位统一，2026-10「Agent 面模型设置简化」）：
 *   · `null`/`''` 值剔除——update-config 的 deepMerge 删除语义落到本键、
 *     及旧自由文本字段存下的空串（显式清除/未设置不透传给协议体）；
 *   · `reasoning_effort: 'none'` → `thinking: {type:'disabled'}`——OpenAI
 *     兼容面关闭思考输出的开关形（DeepSeek/GLM 同形；reasoning_effort
 *     本体只收 low/high/max，'none' 不是合法档位）；
 *   · legacy 布尔 `thinking`（旧 UI「思考输出」勾选存量）→ 结构化
 *     `{type:'enabled'|'disabled'}`（true=开启思考）。
 */
export function filterLlmParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) return {};
  const out: Record<string, unknown> = {};
  for (const key of LLM_SAMPLING_KEYS) {
    const v = params[key];
    if (v !== undefined && v !== null && v !== '') out[key] = v;
  }
  if (out.reasoning_effort === 'none') {
    delete out.reasoning_effort;
    out.thinking = { type: 'disabled' };
  } else if (typeof out.thinking === 'boolean') {
    out.thinking = { type: out.thinking ? 'enabled' : 'disabled' };
  }
  return out;
}

/**
 * Agent id 词法校验（M19 承重墙）：对键桶模型下 conversationId 含 `~`
 * （pairKey(a,b) 排序连接），Agent id 若也含 `~` 会与对键撞键、破坏
 * runAddress 从右解析的歧义性——故 id 禁 `~`、路径分隔/遍历与空白
 * （预设 id 如 `__standard__` 合法）。注册中心唯一执法点。
 */
export function assertAgentId(id: string): void {
  if (!id || id.includes('~') || id.includes('/') || id.includes('\\') || id.includes('..') || /\s/.test(id)) {
    throw new Error(
      `Agent id "${id}" 非法（非空，禁 ~ / 路径分隔 / .. / 空白——对键桶模型承重墙）`,
    );
  }
}

export class AgentsService extends Service {
  private configs = new Map<string, AgentConfig>();

  constructor(ctx: Context) {
    super(ctx, 'agents');
  }

  /**
   * 注册/覆盖 Agent（同 id 后者覆盖前者）。
   * fiber 归属：从插件行调用时随该行卸载自动回收。
   * @returns effect disposer（数据驱动场景可手动调用撤注册）
   */
  register(config: AgentConfig) {
    if (!config.id) throw new Error('Agent 注册缺少 id');
    assertAgentId(config.id);
    return this.ctx.fiber.effect(() => {
      this.configs.set(config.id, config);
      return () => {
        this.configs.delete(config.id);
      };
    }, `agents.register(${config.id})`);
  }

  get(id: string): AgentConfig | undefined {
    return this.configs.get(id);
  }

  /**
   * 具名设置合成口（M24 A1：读取消费侧单点）：
   * `settingsOf(id, name?)` = deepMerge(config.settings[name] ?? {}, agent.settings?.[name] ?? {})
   * —— 与 agents/update-config 同源语义（对象递归合并、数组整体替换、
   * 差异层键优先）。
   *   · config.json `settings` 域 = 全局默认层（`{ '<行名>': { …默认 } }`，
   *     `enabled` 合法——全局软停用，Agent 差异层可覆盖回 true）；
   *   · preset / 未知 id：回落全局层（差异层取空）；
   *   · `get()` 保持差异层原样（本方法不改变 get 语义）；
   *   · 未装 config 行 / 未给 name：差异层直读（接口同形——name 缺省
   *     等价全局层恒空）。
   * 冻结坑守卫（显式测试锁定）：get-config / getAgentConfig 恒返回差异层；
   * 守卫链 `settingsOf 合成 → get-config → update-config 回写` 后差异层
   * 不出现仅存在于全局层的键。
   */
  settingsOf(id: string, name?: string): unknown {
    const agent = this.configs.get(id);
    const config = this.ctx.get('config') as
      | { get<T>(key: string): T | undefined }
      | undefined;
    const globalLayer = (config?.get<Record<string, unknown>>('settings') ?? {}) as Record<string, unknown>;
    const agentLayer = (agent?.settings ?? {}) as Record<string, unknown>;
    if (name === undefined) return deepMerge(globalLayer, agentLayer);
    const g = globalLayer[name];
    const d = agentLayer[name];
    // 非对象差异层值（旧 string 形状 persona 等）：整体生效（与
    // update-config「基本类型/数组：source 覆盖」语义同源；deepMerge 只
    // 处理对象形状——string 会被拆成字符索引，必须前置短路）
    if (d !== undefined && (typeof d !== 'object' || d === null || Array.isArray(d))) {
      return d;
    }
    if (g === undefined || typeof g !== 'object' || g === null || Array.isArray(g)) {
      return (d ?? {}) as Record<string, unknown>;
    }
    const diffLayer = (d ?? {}) as Record<string, unknown>;
    return deepMerge(g as Record<string, unknown>, diffLayer);
  }

  /** 取 Agent 或抛错（路由/诊断用） */
  require(id: string): AgentConfig {
    const config = this.configs.get(id);
    if (!config) throw new Error(`unknown agent: ${id}（已注册：${this.ids().join(', ') || '无'}）`);
    return config;
  }

  has(id: string): boolean {
    return this.configs.has(id);
  }

  list(): AgentConfig[] {
    return [...this.configs.values()];
  }

  ids(): string[] {
    return [...this.configs.keys()];
  }

  /**
   * 数据驱动覆盖注册（M15）：直接替换注册表条目，**不挂 fiber effect**——
   * 生命周期由调用方语义持有（配置已持久化，重启自恢复）。
   * 用于"覆盖既有注册"的场景（update_agent_profile 改档案、管理面热重载）：
   * 若用 register 会把覆盖注册归属到调用行 fiber，行卸载时连原始注册
   * 一并删掉（M15 对账勘误）。旧注册的 effect disposer 不受影响（幂等 delete）。
   */
  reassign(config: AgentConfig): void {
    if (!config.id) throw new Error('Agent reassign 缺少 id');
    assertAgentId(config.id);
    this.configs.set(config.id, config);
    this.ctx.emit('agents/updated', config, 'updated');
  }

  /** 手动撤注册（数据驱动场景；插件行注册随 fiber 自动回收，无需调用） */
  remove(id: string): boolean {
    const config = this.configs.get(id);
    const removed = this.configs.delete(id);
    if (removed && config) this.ctx.emit('agents/updated', config, 'removed');
    return removed;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** Agent 注册中心（ac-agents 提供） */
    agents: AgentsService;
  }
}
