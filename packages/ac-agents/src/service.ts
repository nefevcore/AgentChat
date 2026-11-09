// ============================================================
// ac-agents/src/service.ts —— Agent 注册中心（cordis Service）
//
// 本包是 Agent 域服务的 owning package：AgentsService 注册中心 +
// 门禁词汇纯函数。AgentConfig 契约 owning 在 ac-agents-core（cr-953
// 起单源 re-export——本包历史双份定义已随 tags 退役批并源，消灭
// tools/tags 旧词形漂移面）。
//
// 关键认知：Agent 是【数据】不是插件（迁移研究映射表 #12/#15）。
// ctx.agents 只做注册表；两类注册方：
//   · 插件行（预设 Agent）：fiber 归属，随行卸载自动回收；
//   · 数据驱动（根/运行期 API）：同一 register，disposer 留给调用方手动撤。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { deepMerge } from 'ac-config-merge';
import {
  ACCESS_RANK,
  type AccessLevel,
  type AgentConfig,
  type ToolMode,
  accessOf,
  displayNameOf,
  effectiveAccessOf,
  toolModeOf,
} from 'ac-agents-core';

export type { AgentConfig, AccessLevel, ToolMode } from 'ac-agents-core';

export {
  ACCESS_RANK,
  accessOf,
  displayNameOf,
  effectiveAccessOf,
  toolModeOf,
  resolveToolNames,
} from 'ac-agents-core';

// ============================================================
// 门禁词汇（cr-953：requiredTags 能力词门禁退役——授权 = 行装载
// 单闸；档位/模式判定换轨结构化字段；levels 行内档位唯一载体）
// ============================================================

/**
 * per-call 档位判定（工具行基线共用单源，cr-363 收编四处同构）：
 * agents 注册表软依赖读取 + ToolCall.access 归一化 + effectiveAccessOf
 * 一体——fs-search / fs-tools / str-replace-editor / shell-tools 原各持
 * 一份档位归一化三行，换新档位词时四处同改。access 类型宽于契约
 * （unknown 透传容错，见 effectiveAccessOf 宽容缺省 base）；旧字段名
 * elevation 读兼容（cr-947 前名——过渡期双读，全链换净后拆）。
 */
export function effectiveAccessOfCall(
  call: { agentId?: string; access?: unknown; elevation?: unknown },
  agentsOf: () => { get(id: string): AgentConfig | undefined } | undefined,
): AccessLevel {
  const agent = call.agentId !== undefined ? agentsOf()?.get(call.agentId) : undefined;
  const raw = call.access ?? call.elevation;
  return effectiveAccessOf(
    agent,
    raw === 'full-access' ? 'full-access' : raw === 'sandbox-access' ? 'sandbox-access' : undefined,
  );
}

/**
 * 有效能力集（cr-953 缩减：能力词门禁退役——tags 轴整段删除；合成 =
 * {'base', 'agent:<id>'} ∪ levels 行内档位合成词（browser 层级 / collab
 * admin / dev-tools）∪ settings 行内档位回滚兼容线。无身份（宿主直调）
 * = {'base'}。工具可见性门禁随 requiredTags 退役——本函数仅剩 browser
 * 分层门禁（web-tools 行内）与 UI 诊断面消费）。
 */
export function capabilitySetOf(
  ctx: Pick<Context, 'agents'>,
  agentId: string | undefined,
): Set<string> {
  const caps = new Set<string>(['base']);
  if (agentId === undefined) return caps;
  caps.add(`agent:${agentId}`);
  const agent = ctx.agents.get(agentId);
  // 行内档位合成（cr-906 批4 X1 回滚 + cr-953：levels 赢——行内档位唯一
  // 载体；settings 行内档位为回滚兼容线，settingsOf 两层合成口）
  const settingsOf = (name: string): Record<string, unknown> | undefined => {
    const merged = ctx.agents.settingsOf(agentId, name);
    return merged !== null && typeof merged === 'object' && !Array.isArray(merged)
      ? (merged as Record<string, unknown>)
      : undefined;
  };
  const levels = agent?.levels ?? {};
  const browserLevel = levels.browser;
  if (typeof browserLevel === 'string') {
    // 装配档位词（层级：observe < manipulate < inject——高层含全部低层 + web）
    if (levelQuotaOk(browserLevel)) {
      caps.add('web');
      caps.add('observe');
      if (browserLevel !== 'observe') caps.add('manipulate');
      if (browserLevel === 'inject') caps.add('inject');
    }
  } else {
    const browser = settingsOf('browser');
    if (browser !== undefined) {
      // 层级布尔：任一 true 即含 web + 全部低层
      if (browser.observe === true || browser.manipulate === true || browser.inject === true) {
        caps.add('web');
        caps.add('observe');
      }
      if (browser.manipulate === true) caps.add('manipulate');
      if (browser.inject === true) caps.add('inject');
    }
  }
  const collabLevel = levels.collab;
  if (collabLevel === 'admin' || collabLevel === true) caps.add('admin');
  else if (settingsOf('collab')?.admin === true) caps.add('admin');
  const devLevel = levels['dev-tools'];
  if (devLevel === true || devLevel === 'dev') caps.add('dev');
  else if (settingsOf('dev-tools')?.enabled === true) caps.add('dev');
  return caps;
}

function levelQuotaOk(level: string): boolean {
  return level === 'observe' || level === 'manipulate' || level === 'inject';
}

/**
 * 会话维度的有效能力集（capabilitySetOf + 会话覆盖授权注入）。
 * 2026-09-26 browserTier 可见性事故：会话实验档（conv-settings 注册键的
 * grants 声明）此前只作用于 web-tools 动作门禁——无层级的 Agent 在
 * 工具可见面就看不到 browser，会话授权到不了执行层。此包装在【可见性
 * 合成点】统一注入：settings 覆盖值 → 键定义 grants 标签并入 caps。
 * 受限调用方兼容：agents/convSettings 均经 ctx.get(name, false) 软取
 * （受限 ctx 上直接属性访问会抛 without-inject——run_code 等工具行
 * 场景）；面缺席 = 退化为 base 集（与 capabilitySetOf 等价或更窄）。
 * LLM 工具面的决定点（router execute / agents tool-defs / list_tools /
 * run_code 投影 / subagent 装配）统一换用本函数。
 */
export function sessionCapsOf(
  ctx: { get?: (name: string, strict?: boolean) => unknown },
  agentId: string | undefined,
  conversationId: string | undefined,
): Set<string> {
  const softGet = (name: string): unknown =>
    typeof ctx.get === 'function' ? ctx.get(name, false) : undefined;
  const agents = softGet('agents') as Context['agents'] | undefined;
  const caps = agentId === undefined || !agents
    ? new Set<string>(['base'])
    : capabilitySetOf({ agents }, agentId);
  if (conversationId === undefined) return caps;
  const convSettings = softGet('convSettings') as
    | { get(conversationId: string): Record<string, string>; listKeys?: () => Array<{ key: string; grants?: Record<string, string[]> }> }
    | undefined;
  if (!convSettings || typeof convSettings.listKeys !== 'function') return caps;
  const settings = convSettings.get(conversationId);
  for (const def of convSettings.listKeys()) {
    for (const tag of def.grants?.[settings[def.key]] ?? []) caps.add(tag);
  }
  return caps;
}

/**
 * 工具对能力集的可见性判定（cr-953：requiredTags 门禁退役——授权 =
 * 行装载单闸，工具面已由行集派生收口；本函数恒 true，仅保消费面
 * 零改动的过渡期形状。随消费面清零后一并删除）。
 */
export function toolAllowedFor(
  _def: { requiredTags?: string[] } | undefined,
  _caps: Set<string>,
): boolean {
  return true;
}

/**
 * 会话形态词（工具交互轴 ToolDefinition.requiresInteraction 的判定输入）：
 * 'self' 自会话（对角线桶 a~a——机制 run 落点，无人值守）。conversationFormOf
 * 单源判定，router / list_tools / run_code 交互面共用。
 * （2026-09-21 语义收窄：'single' 独立会话词退役——excludeForms 轴整体
 * 撤销，工具交互性改经 requiresInteraction 布尔声明，self 会话自动排除。）
 */
export type ConversationForm = 'self';

/**
 * conversationId → 会话形态（交互轴单源，2026-02-00 'self'）：对角线对桶
 * （恰两段且相等——Agent id 禁 `~`（assertAgentId），词法判定构造性
 * 可靠）= 'self'；其余 = null（有用户参与的会话）。纯查询零会话状态。
 */
export function conversationFormOf(
  ctx: Pick<Context, 'get'>,
  conversationId: string | undefined,
): ConversationForm | null {
  if (!conversationId) return null;
  const parts = conversationId.split('~');
  return parts.length === 2 && parts[0] !== '' && parts[0] === parts[1] ? 'self' : null;
}

/**
 * 工具是否被会话交互性裁剪（requiresInteraction 命中判定——list_tools /
 * run_code 等复制点与 router 同口径的方便入口；router 先解析
 * include/exclude 再终滤，故本函数只做单工具判定）：
 * requiresInteraction && self 会话（无人值守）→ 裁剪（等待用户应答的
 * 工具在机制 run 里永无回音）。
 */
export function formDeniedBy(
  ctx: Pick<Context, 'get'>,
  def: { requiresInteraction?: boolean },
  conversationId: string | undefined,
): boolean {
  if (def.requiresInteraction !== true) return false;
  return conversationFormOf(ctx, conversationId) === 'self';
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
 * 归一（推理档位统一，2026-09-03「Agent 面模型设置简化」）：
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
 *（pairKey(a,b) 排序连接），Agent id 若也含 `~` 会与对键撞键、破坏
 * runAddress 从右解析的歧义性——故 id 禁 `~`、路径分隔/遍历与空白
 *（预设 id 如 `__standard__` 合法）。注册中心唯一执法点。
 */
export function assertAgentId(id: string): void {
  if (!id || id.includes('~') || id.includes('/') || id.includes('\\') || id.includes('..') || /\s/.test(id)) {
    throw new Error(
      `Agent id "${id}" 非法（非空，禁 ~ / 路径分隔 / .. / 空白——对键桶模型承重墙）`,
    );
  }
}

/**
 * 生效工具调用模式：会话覆盖（conv-settings toolMode）?? toolModeOf(agent)。
 * 单源合成（2026-09-18 估算失真修复）：router / system-prompt 干跑 /
 * agents/tool-defs 估算面三处共用——「LLM 面按模式收窄」的判定输入
 * 必须与真实 run 同口径，否则估算（工具 schema 数 + 系统提示词门控块
 * + run_code SDK 投影块）随会话开关漂移。
 */
export interface EffectiveToolModeEnv {
  /** conv-settings 会话覆盖读取（ctx.get('convSettings', false) 面） */
  convSettings?: { get(conversationId: string): { toolMode?: ToolMode } } | undefined;
}
export function effectiveToolMode(
  agent: AgentConfig | undefined,
  conversationId: string | undefined,
  env: EffectiveToolModeEnv = {},
): ToolMode {
  const override = conversationId ? env.convSettings?.get(conversationId).toolMode : undefined;
  return override ?? toolModeOf(agent);
}

/**
 * 工具调用模式收窄（形态轴合成，injection:'mode' 工具的注入点）：
 *   · tc-programmatic → mode 工具集（defs 中 injection==='mode' 的工具，
 *     行在装即合成）；无 mode 工具（对应行未装）= 空面
 *     （warn 归调用方——形同 tc-none，不回落常规面：程序化档悄悄变
 *     常规档是语义突变）；
 *   · tc-none → []；
 *   · tc-base → 原面（mode 工具不进常规工具面——router/估算面在能力面
 *     过滤时按 injection 分流排除，本函数的原面里天然无 mode 工具）。
 * 入参 defs = 注册面全量（只读 injection 标记）；tools = 已过能力面/
 * include/形态面的名字清单——mode 工具不经 tools 过滤（它们不在常规面），
 * 直接从 defs 合成。
 * 消费方：router dispatch（真实 run）+ system-prompt 干跑 /
 * agents/tool-defs（估算面——与真实 run 同口径的修复点）。
 */
export function narrowToolsByMode(
  tools: string[],
  defs: ReadonlyArray<{ name: string; injection?: 'capability' | 'mode' }>,
  mode: ToolMode,
): string[] {
  if (mode === 'tc-programmatic') {
    return defs.filter((d) => d.injection === 'mode').map((d) => d.name);
  }
  if (mode === 'tc-none') return [];
  return tools;
}

/**
 * 请求面是否恰为 mode 工具集（程序化互斥形态判定——run_code SDK 投影
 * 注入的既有口径，2026-09-21 提升为单源）：request.tools 与注册面
 * injection:'mode' 工具集互为子集且非空。系统提示各门控行
 *（system-prompt 指引块 / fs-tools @引用 / session-query #引用 /
 * collab-tools @名称）在 PTC 模式下请求面已被 router 收窄成 ['run_code']，
 * 若按请求面判「工具在场」会误伤全部基线段——本函数是「这是程序化
 * run 吗」的判别入口。
 */
export function isModeToolFace(
  requested: ReadonlyArray<string> | undefined,
  modeToolNames: ReadonlyArray<string>,
): boolean {
  if (requested === undefined || modeToolNames.length === 0) return false;
  if (requested.length === 0) return false;
  const mode = new Set(modeToolNames);
  const req = new Set(requested);
  if (req.size !== requested.length) return false; // 重复 = 非合成面
  return requested.every((n) => mode.has(n)) && modeToolNames.every((n) => req.has(n));
}

/**
 * 门控用工具名合成（请求面 → 能力面展开，2026-09-21 PTC 基线段丢失修复）：
 * 系统提示门控行按「工具能力在场」注入指引，但 PTC 模式下 request.tools
 * 已收窄为 ['run_code']——直读会让模型明明能经 tools.read 调 read 却
 * 学不到对应基线（@/# 引用约定、宿主环境、产出物引用等）。本函数在
 * 程序化 run（isModeToolFace 判定）时把门控依据换成能力面直取的展开
 * 面（形态面终滤——与 run_code 投影源同口径，跳过 include/exclude 的
 * LLM 直调面收窄）；常规面照旧原样返回请求面。消费方只做「有没有某
 * 工具」的成员判定，不消费执行面语义——门控宽度 fail-safe（声明了
 * 没授权的工具顶多多教一段指引）。
 * cr-953：requiredTags 门禁退役——能力面 = 注册面（行装载单闸），
 * toolAllowedFor 恒 true，caps 仅用于 browser 分层门禁（web-tools
 * 行内）与会话 grants 注入，不再过滤工具可见性。
 */
export function widenToolsForGating(
  ctx: Pick<Context, 'get'>,
  agentId: string | undefined,
  conversationId: string | undefined,
  requested: ReadonlyArray<string> | undefined,
): string[] {
  // ctx.get 走 root-traced 无限制解析（受限调用方纪律：消费方插件行不
  // inject tools 也能取；缺席 = 空注册面）
  const tools = ctx.get('tools', false) as
    | { list(): Array<{ name: string; injection?: 'capability' | 'mode'; requiresInteraction?: boolean }> }
    | undefined;
  const all = tools ? tools.list() : [];
  const modeToolNames = all.filter((d) => d.injection === 'mode').map((d) => d.name);
  if (!isModeToolFace(requested, modeToolNames)) {
    // 常规面：request.tools ?? 注册面全量（原门控口径不变）
    return requested !== undefined ? [...requested] : all.map((t) => t.name);
  }
  // 程序化 run：注册面直取（行装载单闸——与 run_code 投影源同链；
  // mode 工具自身与 requiresInteraction 终滤一起排除——门控只关心能力）
  return all
    .filter((t) => t.injection !== 'mode' && !formDeniedBy(ctx, t, conversationId))
    .map((t) => t.name);
}

export class AgentsService extends Service {
  private configs = new Map<string, AgentConfig>();

  constructor(ctx: Context) {
    super(ctx, 'agents');
  }

  /**
   * 双向名册校验（cr-4 撞形防线②反向卡位）：Agent id 撞已存在群 id →
   * 拒（gid~member 成员流键会与 1v1 对桶争用同一会话桶）。group 为可选
   * 能力——未装载时无群可撞。register（插件行/目录扫描）与 reassign
   *（管理面写/预设热更）共用——写口归一，防第三口绕过
   *（cr-351：管理面 create/update 走 reassign 此前不校验）。
   */
  private assertNoGroupCollision(id: string): void {
    const group = this.ctx.get('group', false) as { get(id: string): unknown } | undefined;
    if (group !== undefined && group.get(id) !== undefined) {
      throw new Error(`Agent id "${id}" 与已存在群同名（成员流键 gid~member 会与 1v1 对桶撞形——先删群或换 id）`);
    }
  }

  /**
   * 注册/覆盖 Agent（同 id 后者覆盖前者）。
   * fiber 归属：从插件行调用时随该行卸载自动回收。
   * @returns effect disposer（数据驱动场景可手动调用撤注册）
   */
  register(config: AgentConfig) {
    if (!config.id) throw new Error('Agent 注册缺少 id');
    assertAgentId(config.id);
    this.assertNoGroupCollision(config.id);
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
   *   · 预设 / 未知 id：回落全局层（差异层取空）；
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
    this.assertNoGroupCollision(config.id);
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
