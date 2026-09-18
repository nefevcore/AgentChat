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
   * 条目词形（两形态通用）：精确工具名，或 **tag 引用** `'tag:<tag>'`
   * ——展开为 requiredTags 含该 tag 的全部工具（resolveToolNames 信封构建
   * 时按注册面展开；工具集增删自动跟随，预设/Agent 不必点名）。tag 引用
   * 与精确名可混排；无 defs 的消费面（纯名字数组）不展开，引用条目静默
   * 落空。信封构建（router）时解析为 string[]——loop 契约不变。
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
  /**
   * 显示名（单源）：名册 / 群聊 / 对话信息等一切显示点的 Agent 名称。
   * 与 description（一句话简介）分工——Agent 经 update_agent_profile 改
   * description 不再连带改显示名（历史缺陷：description 曾兼任显示名，
   * UI 创建/昵称编辑均写入 description；src 轨道本有独立 name 字段，
   * 迁移时被压进 description）。存量档由 ac-agent-store 读边界惰性拷贝
   * description → name 物化。显示名解析一律经 displayNameOf（回退链
   * name ?? description——未物化的内存注册/预设兼容）。
   */
  name?: string;
  /**
   * 一句话简介：给其他 Agent 与用户看的自我/他人描述（LLM 工具面
   * list_agents / read_agent_info / update_agent_profile 词汇）。
   * 不是显示名——显示名单源是 name。
   */
  description?: string;
  /**
   * 能力标签（src tags 平移；Port B P6）：工具 requires 门禁的判定词表
   * （ac-tools 注册的 requires + ac-security 等门禁行消费），UI 侧驱动
   * 徽章与工具启停（canAddTool）。'base' 为内建基础标签（UI 恒视作具备）。
   * 2026-12（access-tier §四）新增档位词汇：'full-access' /
   * 'sandbox-access'（缺省 = base-access）——tierOf 单源判定，驱动权限轴
   * 门禁（needPermission 工具的档位矩阵）；档位标签不进任何工具的
   * requiredTags（AND 语义天然不误匹配）。
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
 * 端点显示名单源解析（回退链 name ?? description；空白视同缺省）：
 * 一切后端显示点（对话信息 labelOf、群成员显示名、预设目录）共用本函数，
 * 未注册/两者皆无 → undefined，由调用方回退端点 id。
 * description 回退仅服务未物化的存量/内存注册——读边界
 * （ac-agent-store.getAgent）已把存量 description 拷贝进 name。
 */
export function displayNameOf(config: AgentConfig | undefined): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config.name === 'string' && config.name.trim() !== '') return config.name;
  if (typeof config.description === 'string' && config.description.trim() !== '') return config.description;
  return undefined;
}

/**
 * 基础族标签（全量标签化 2026-09-16）。历史上有过读边界自动补齐迁移
 * （normalizeUniversalTags，含一次性标记 _migratedUniversalTags），后经
 * 用户裁决**整体移除**：tags 完全以用户/预设配置为准，框架不做任何自动
 * 补齐——新建 Agent 由创建面（UI/预设）负责声明基础族；存量 Agent 由
 * 用户手工补（用户基数小，明确知情优于隐式改写）。此注释是移除前的
 * 语义存档（2026-09-16 终态），防止后人"顺手恢复"。
 */
const UNIVERSAL_TAGS = ['fs', 'collab', 'infra'] as const;

export { UNIVERSAL_TAGS };

/**
 * 解析 AgentConfig.tools 为生效工具名清单（router 构建 LoopRunRequest /
 * list_tools 展示实际生效集共用）。
 *   · undefined      → undefined（= 全部已注册；调用方语义）
 *   · string[]       → 原样白名单（tag 引用见下）
 *   · {include}      → include 白名单
 *   · {exclude}      → all 减 exclude（增量停用）
 *   · {include,exclude} → include 减 exclude
 * tag 引用（条目词形 `'tag:<tag>'`，两形态通用）：universe 传工具定义
 * （{name, requiredTags?}）时展开为 requiredTags 含该 tag 的全部工具名
 * ——工具集增删自动跟随（预设不必点名工具）。universe 传纯名字数组时
 * 无 tag 信息，引用条目展开为空（不落字面名——它不是合法工具名）。
 * 空展开告警（2026-09-16，fail-fast；前置修复 #2 扩展）：universe 有
 * defs 时两类落空都回调——
 *   · tag: 引用展开为空 = 点名了不存在的标签（拼写错/标签未注册/工具行
 *     未装载）——静默落空正是 tag:fs 事故的形态；
 *   · 字面名不在 universe = 点名了不可见/不存在/已改名的工具（如平台
 *     拆分后 Windows 上的存量 'bash'，或拼写错）。
 * 回调由调用方挂 logger（纯函数不持 ctx）。字面名透传不变（留待执行
 * 面报「未知工具」——可见性判定不在此层），但配置错误从静默变可观测。
 */
export function resolveToolNames(
  tools: AgentConfig['tools'],
  all: readonly (string | { name: string; requiredTags?: string[] })[],
  onEmptyTagExpand?: (tag: string) => void,
  onUnknownLiteral?: (name: string) => void,
): string[] | undefined {
  if (tools === undefined) return undefined;
  // tag 展开表：tag → requiredTags 含该 tag 的工具名（仅 defs 条目贡献）
  const byTag = new Map<string, string[]>();
  const known = new Set<string>();
  let hasDefs = false;
  for (const entry of all) {
    if (typeof entry === 'string') {
      known.add(entry);
      continue;
    }
    hasDefs = true;
    known.add(entry.name);
    for (const t of entry.requiredTags ?? []) {
      const list = byTag.get(t);
      if (list) list.push(entry.name);
      else byTag.set(t, [entry.name]);
    }
  }
  const expand = (names: readonly string[]): string[] =>
    names.flatMap((n) => {
      if (!n.startsWith('tag:')) {
        if (hasDefs && !known.has(n) && onUnknownLiteral) onUnknownLiteral(n);
        return [n];
      }
      const tag = n.slice(4);
      const expanded = byTag.get(tag) ?? [];
      if (expanded.length === 0 && hasDefs && onEmptyTagExpand) onEmptyTagExpand(tag);
      return expanded;
    });
  if (Array.isArray(tools)) return expand(tools);
  const include = Array.isArray(tools.include) ? expand(tools.include) : undefined;
  const exclude = Array.isArray(tools.exclude) ? new Set(expand(tools.exclude)) : new Set<string>();
  const base = include ?? all.map((e) => (typeof e === 'string' ? e : e.name));
  return base.filter((name) => !exclude.has(name));
}

/**
 * 访问档位（access-tier §四）：AgentConfig.tags 新增词汇
 * `full-access` / `sandbox-access`；缺省（无任一档位标签）= base-access。
 * 档位只认 tags（人工书写、无合成空间）；编辑面 = agentAdmin 管理面。
 */
export type AccessTier = 'full-access' | 'sandbox-access' | 'base-access';

/**
 * 档位强度序（唆使防御梯度判定用：tierOf(sender) 严格低于 tierOf(接收方)
 * 才注入 notice）。base < sandbox < full。
 */
export const TIER_RANK: Record<AccessTier, number> = {
  'base-access': 0,
  'sandbox-access': 1,
  'full-access': 2,
};

/**
 * 档位判定单源（access-tier §四）：tags 含 'full-access' → full；含
 * 'sandbox-access' → sandbox；否则 base（full 优先）。未注册 Agent
 * （undefined，如存量 sub_* 合成身份）→ base（唆使防御"宁多注不漏注"的
 * fail-closed 方向）。纯函数住 AgentConfig owning 包——ac-security 加严层
 * 与工具行基线共用，防复检与基线漂移。
 */
export function tierOf(agent: AgentConfig | undefined): AccessTier {
  const tags = agent?.tags;
  if (!tags) return 'base-access';
  if (tags.includes('full-access')) return 'full-access';
  if (tags.includes('sandbox-access')) return 'sandbox-access';
  return 'base-access';
}

/**
 * effectiveTier（access-tier §3.2）：call.elevation（机制分支临时提权/
 * 有人桶审批注入）?? tierOf(agent)。工具行基线与 ac-security 加严层共用
 * 本单源——防"复检与基线漂移"（同 agentSpaceRoots 的纪律）。
 */
export function effectiveTierOf(
  agent: AgentConfig | undefined,
  elevation: 'sandbox-access' | 'full-access' | undefined,
): AccessTier {
  if (elevation === 'full-access' || elevation === 'sandbox-access') return elevation;
  return tierOf(agent);
}

/**
 * 工具调用模式（2026-09-17 统一重构：tc-* 标签轴——与提权档位 access-tier
 * 同构的第三条轴）：AgentConfig.tags 新增词汇 tc-none / tc-programmatic；
 * 缺省（无任一模式词）= tc-base。模式词经 toolModeOf 单源判定，router
 * / ac-subagent 按「会话覆盖（conv-settings toolMode）?? toolModeOf(agent)」
 * 收窄 LLM 工具面：tc-programmatic ⇒ ['run_code']、tc-none ⇒ 空面纯聊天、
 * tc-base ⇒ 不收窄（逐个直调）。
 *
 * 与档位词的差别：tc-programmatic 是唯一进 requiredTags 的非能力词
 * （run_code 挂它——标签即授权：含该词 ⇒ run_code 可见 + 程序化档；
 * code-exec 标签已随之移除）。tc-none / tc-base 与档位词同款不进 requiredTags
 * （tag-registry assert 白名单外的非能力词禁入）。
 */
export type ToolMode = 'tc-none' | 'tc-base' | 'tc-programmatic';

/** 模式词表（tags 中合法的 tc-* 词；判定序 = 数组序——tc-none 优先） */
export const TOOL_MODE_TAGS: readonly ToolMode[] = ['tc-none', 'tc-programmatic'];

/**
 * 工具调用模式判定单源（对标 tierOf）：tags 含 'tc-none' → none；
 * 含 'tc-programmatic' → programmatic；否则 base（none 优先——无工具
 * 是最强约束，fail-closed 方向）。未注册 Agent（undefined，如存量
 * sub_* 合成身份）→ base。纯函数住 AgentConfig owning 包，router /
 * ac-subagent / 前端展示共用。
 */
export function toolModeOf(agent: AgentConfig | undefined): ToolMode {
  const tags = agent?.tags;
  if (!tags) return 'tc-base';
  if (tags.includes('tc-none')) return 'tc-none';
  if (tags.includes('tc-programmatic')) return 'tc-programmatic';
  return 'tc-base';
}

/**
 * 生效工具调用模式：会话覆盖（conv-settings toolMode）?? toolModeOf(agent)。
 * 单源合成（2026-12 估算失真修复）：router / system-prompt 干跑 /
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
 * 工具调用模式收窄（router dispatch 语义的单源平移——行为原样）：
 *   · tc-programmatic → ['run_code']（工具面含它时；不含则惰性忽略该档
 *     ——warn 归调用方，本函数返回原面）；
 *   · tc-none → []；
 *   · tc-base → 原面。
 * 消费方：router dispatch（真实 run）+ system-prompt 干跑 /
 * agents/tool-defs（估算面——与真实 run 同口径的修复点）。
 */
export function narrowToolsByMode(tools: string[], mode: ToolMode): string[] {
  if (mode === 'tc-programmatic') {
    return tools.includes('run_code') ? tools.filter((name) => name === 'run_code') : tools;
  }
  if (mode === 'tc-none') return [];
  return tools;
}

/**
 * 有效能力集（与 ac-security 执行门禁同款合成——工具【可见面】过滤的
 * 单源，2026-09-02 反馈 #1：requiredTags 缺标签的工具此前只在执行时 veto，
 * LLM 仍能在工具清单里看到并浪费一轮调用）：
 *   {'base', 'agent:<id>'} ∪ AgentConfig.tags（tags 单源——capabilities
 *   覆盖层已随 access-tier §9.4 删除）。
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
  return caps;
}

/**
 * 工具定义对能力集的可见性判定（requiredTags AND；无 requiredTags 恒可见）。
 * 2026-09-16 全量标签化：无 requiredTags 显式等价为 ['base'] 门禁（caps
 * 恒含 base，行为不变）——契约从"默认开放"改写为"base 解锁"，幽灵标签
 * 变真实锚点。出厂工具已全量挂标签（fs/collab/infra/shell/...），此分支
 * 仅覆盖动态插件等未声明 requiredTags 的注册面。
 */
export function toolAllowedFor(
  def: { requiredTags?: string[] } | undefined,
  caps: Set<string>,
): boolean {
  const required = def?.requiredTags?.length ? def.requiredTags : ['base'];
  return required.every((t) => caps.has(t));
}

/**
 * 会话形态词（工具形态轴 ToolDefinition.excludeForms 的判定输入）：
 * 'single' 独立会话（singles 注册表命中）/ 'self' 自会话（对角线桶
 * a~a——机制 run 落点）。conversationFormOf 单源判定，router /
 * list_tools / run_code 形态面共用。
 */
export type ConversationForm = 'single' | 'self';

/**
 * conversationId → 会话形态（形态轴单源，2026-12 'single' / 2026-02
 * 'self'）：singles 可选能力命中 = 'single'；对角线对桶（恰两段且相等
 * ——Agent id 禁 `~`（assertAgentId），词法判定构造性可靠）= 'self'；
 * 其余 = null（无形态约束）。纯查询零会话状态。
 */
export function conversationFormOf(
  ctx: Pick<Context, 'get'>,
  conversationId: string | undefined,
): ConversationForm | null {
  if (!conversationId) return null;
  const singles = ctx.get('singles', false) as { get(sid: string): unknown } | undefined;
  if (singles && singles.get(conversationId)) return 'single';
  const parts = conversationId.split('~');
  return parts.length === 2 && parts[0] !== '' && parts[0] === parts[1] ? 'self' : null;
}

/**
 * 工具是否被会话形态裁剪（excludeForms 命中判定——list_tools /
 * run_code 等复制点与 router formAllowed 同口径的方便入口；router
 * 先解析 include/exclude 再终滤，故本函数只做单工具判定）。
 */
export function formDeniedBy(
  ctx: Pick<Context, 'get'>,
  def: { excludeForms?: string[] },
  conversationId: string | undefined,
): boolean {
  const form = conversationFormOf(ctx, conversationId);
  return form !== null && (def.excludeForms ?? []).includes(form);
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
