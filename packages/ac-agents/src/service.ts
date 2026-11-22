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
import type { ToolFaceContext } from 'ac-tools';
import {
  type AgentConfig,
  type ToolMode,
  type ToolModeDef,
  displayNameOf,
  isFullAccess,
  toolModeOf,
} from 'ac-agents-core';
import { parseKey } from 'ac-conv-keys'; // 会话键词法单源（cr-1238 B3）

export type { AgentConfig, AccessLevel, ToolMode } from 'ac-agents-core';

export {
  displayNameOf,
  isFullAccess,
  toolModeOf,
  resolveToolNames,
} from 'ac-agents-core';

// ============================================================
// 门禁词汇（cr-953：requiredTags 能力词门禁退役——授权 = 行装载
// 单闸；档位/模式判定换轨结构化字段；levels 行内档位唯一载体）
// ============================================================

/**
 * per-call 两态判定（cr-1082 批B 简化；cr-363 收编单源沿革）：full 的
 * 唯一来源 = 门注入的 call.access——agents 底座合成随 AgentConfig.access
 * 退役删除。旧字段名 elevation 读兼容（cr-947 前名）与 unknown 宽容
 * 缺省照旧：非 'full-access' 值一律按沙箱态。
 */
export function isFullAccessCall(call: { access?: unknown; elevation?: unknown }): boolean {
  return call.access !== undefined
    ? isFullAccess(call)
    : call.elevation === 'full-access'; // 旧字段名读兼容（cr-947 前名）
}

/**
 * 有效能力集（cr-953 缩减 + cr-1004 批2b：能力词门禁退役——tags 轴整段
 * 删除；合成 = {'base', 'agent:<id>'} ∪ levels 行内档位合成词（browser
 * 层级 / collab admin）∪ settings 行内档位回滚兼容线。dev-tools 键随行
 * 退役。无身份（宿主直调）= {'base'}。工具可见性门禁随 requiredTags
 * 退役——本函数仅剩 browser 分层门禁（web-tools 行内）与 UI 诊断面消费。
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
  // dev-tools 键随行退役（cr-520 行已撤、'dev' 能力词无消费面——cr-1004 批2b）
  return caps;
}

function levelQuotaOk(level: string): boolean {
  return level === 'observe' || level === 'manipulate' || level === 'inject';
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
 * 可靠）= 'self'；其余 = null。纯查询零会话状态。
 * （cr-1079 注意：'self' 只表「机制自会话桶」，不再等价「无人」——人类
 * 参与判定单源已移至 humanPresentOf。）
 */
export function conversationFormOf(
  ctx: Pick<Context, 'get'>,
  conversationId: string | undefined,
): ConversationForm | null {
  if (!conversationId) return null;
  const s = parseKey(conversationId);
  return s.shape === 'pair' && s.left === s.right ? 'self' : null;
}

/**
 * conversationId → 是否有人类参与（cr-1079 权限门 D7 判定单源）：恰两段
 * 且任一段为 'user'（a~user 对桶，两向同判）或
 * 无 '~' 的 singles sid = 有人；self（a~a 机制桶）、agent~agent（self 的
 * 一般化）、g-<gid>~member（群——成员全 Agent，无人）= 无人。
 * Agent id 禁 `~`（assertAgentId），词法判定构造性可靠。纯查询零会话状态。
 */
export function humanPresentOf(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const s = parseKey(conversationId);
  // uuid/plain 单段 = singles sid 或裸桶：用户独立会话，有人
  if (s.shape === 'pair') return s.left === 'user' || s.right === 'user';
  return true;
}

/**
 * 工具是否被会话交互性裁剪（requiresInteraction 命中判定——list_tools /
 * run_code 等复制点与 router 同口径的方便入口；router 先解析
 * include/exclude 再终滤，故本函数只做单工具判定）：
 * requiresInteraction && self 会话（机制 run）→ 裁剪（等待用户应答的
 * 工具在机制 run 里永无回音）。
 * 注意（cr-1079）：本轴**不**换用 humanPresentOf——群/agent~agent 会话里
 * 用户可能在界面上看着（ask_questions 是可回答的），与权限门「无人桶
 * 不弹审批卡」的理由（避免审核风暴）不同轴。两轴各用各的判定。
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
  /**
   * conv-settings 会话覆盖读取（ctx.get('convSettings', false) 面）。读面
   * 统一 effective（cr-1083 conv-scope 批1）：无人桶恒 {}——残留 toolMode
   * 不再压 Agent 配置（toolModeOf 接管）。
   */
  convSettings?: { effective(conversationId: string): { toolMode?: ToolMode } } | undefined;
}
export function effectiveToolMode(
  agent: AgentConfig | undefined,
  conversationId: string | undefined,
  env: EffectiveToolModeEnv = {},
): ToolMode {
  const override = conversationId ? env.convSettings?.effective(conversationId).toolMode : undefined;
  return override ?? toolModeOf(agent);
}

/**
 * 两步投影·第①步（发现，cr-1049）：注册面 → 当前投影上下文下可发现的
 * 工具。discover 缺省 true；谓词 throw 按 false 处理（fail-closed）。
 * 纯函数——估算/预览/快照/真 run 四面同口径的基座。
 */
export function discoverTools(
  defs: ReadonlyArray<{ name: string; discover?: (ctx: ToolFaceContext) => boolean }>,
  face: ToolFaceContext,
): string[] {
  return defs
    .filter((d) => {
      if (d.discover === undefined) return true;
      try {
        return d.discover(face) === true;
      } catch {
        return false;
      }
    })
    .map((d) => d.name);
}

/**
 * 两步投影·第②步（处理，cr-1049——narrowToolsByMode 后继）：
 *   · tc-none → []（恒空——无工具是最强约束，fail-closed）；
 *   · tc-base → baseFace（恒等——缺省档；调用方已做行集收窄）；
 *   · 扩展档 → discovered（第①步全量）中保留显式声明者（discover
 *     在场且当前上下文发现为 true——「入口集」），空集 = 回退 baseFace
 *     + warn 留痕（cr-1021 语义延续：news~news 空面植物人事故裁决——
 *     可用性优先）；词未注册（模式行被摘）同样回退——回退条件统一为
 *     「入口集空」。入口不经行集收窄（原 mode 工具语义：行在装即合成
 *     ——编排壳的授权由子调用逐个过闸，入口本身不吃 include/exclude）。
 * 模式与工具的关联知识唯一落点 = 入口工具的 discover 谓词——本函数
 * 零模式特有分支。消费方：router dispatch（真实 run）+ system-prompt
 * 干跑 / agents/tool-defs（估算面——与真实 run 同口径）。
 */
export function narrowToolsByMode(
  baseFace: string[],
  discovered: string[],
  defs: ReadonlyArray<{ name: string; discover?: (ctx: ToolFaceContext) => boolean }>,
  mode: string,
): string[] {
  if (mode === 'tc-none') return [];
  if (mode === 'tc-base') return baseFace;
  const disc = new Set(discovered);
  const entries = defs
    .filter((d) => d.discover !== undefined && disc.has(d.name))
    .map((d) => d.name);
  // 入口集空 = 回退常规面（cr-1021）：词未注册或入口行被摘。warn 留痕
  // 归调用方（llmToolFace / face-shell 自检）——静默空面 = 植物人重演。
  if (entries.length === 0) return baseFace;
  return entries;
}

/**
 * 请求面是否恰为模式入口集（程序化互斥形态判定——run_code SDK 投影
 * 注入的既有口径，2026-09-21 单源化；cr-1049 载荷从 injection 标记换
 * discover 入口集）：request.tools 与入口集互为子集且非空。系统提示各
 * 门控行（system-prompt 指引块 / fs-tools @引用 / session-query #引用 /
 * collab-tools @名称）在程序化模式下请求面已被收窄成 ['run_code']，
 * 若按请求面判「工具在场」会误伤全部基线段——本函数是「这是模式合成
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
 * 不再过滤工具可见性（cr-1092 grants 注入与 toolAllowedFor 恒 true
 * 链随轴清零）。
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
    | { list(): Array<{ name: string; discover?: unknown; requiresInteraction?: boolean }> }
    | undefined;
  const all = tools ? tools.list() : [];
  // 模式入口集 = discover 在场者（谓词不求值——门控只问「谁是入口」，
  // 当前上下文是否发现由调用方按需求值；此处与 run 面同口径取在场集）
  const modeToolNames = all.filter((d) => d.discover !== undefined).map((d) => d.name);
  if (!isModeToolFace(requested, modeToolNames)) {
    // 常规面：request.tools ?? 注册面全量（原门控口径不变）
    return requested !== undefined ? [...requested] : all.map((t) => t.name);
  }
  // 模式合成 run：注册面直取（行装载单闸——与 run_code 投影源同链；
  // 模式入口与 requiresInteraction 终滤一起排除——门控只关心能力）
  return all
    .filter((t) => t.discover === undefined && !formDeniedBy(ctx, t, conversationId))
    .map((t) => t.name);
}

export class AgentsService extends Service {
  private configs = new Map<string, AgentConfig>();
  /** 扩展模式注册表（cr-1049：纯元数据；核心两档不进表） */
  private toolModes = new Map<string, ToolModeDef>();

  constructor(ctx: Context) {
    super(ctx, 'agents');
  }

  /**
   * 注册扩展工具调用模式（cr-1049）。fiber 归属：从模式行调用时随该行
   * 卸载自动回收（词面/判定随之退场——「模式完全自主装卸」）。
   * @returns effect disposer
   */
  registerToolMode(def: ToolModeDef) {
    if (!def.id || !def.id.startsWith('tc-')) {
      throw new Error('模式词非法（须 tc- 前缀非空串）: ' + JSON.stringify(def.id));
    }
    if (def.id === 'tc-none' || def.id === 'tc-base') {
      throw new Error('核心档位不可注册（保留字）: ' + def.id);
    }
    if (this.toolModes.has(def.id)) {
      throw new Error(`模式 "${def.id}" 已注册`);
    }
    return this.ctx.fiber.effect(() => {
      this.toolModes.set(def.id, def);
      return () => {
        this.toolModes.delete(def.id);
      };
    }, `agents.registerToolMode(${def.id})`);
  }

  /** 已注册扩展档清单（UI 词面 / 词校验 / 扩展档判定用） */
  listToolModes(): ToolModeDef[] {
    return [...this.toolModes.values()];
  }

  /** 模式词是否已注册扩展档（核心两档恒 false——判定语义是「注册制档」） */
  isRegisteredToolMode(id: string): boolean {
    return this.toolModes.has(id);
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
