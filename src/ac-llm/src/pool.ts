// ============================================================
// ac-llm/src/pool.ts —— 池配置词汇（cr-319 自 ac-llm-pool 归位）
//
// config.llmProviders（连接池 = 唯一事实源）的条目形状与读侧解析纯
// 函数：注册行 ac-llm-pool（diff 重挂）与投递/物化消费方（router/
// subagent/archive/agent-admin/presets/web-api）共源——域 owning 词汇，
// refs.ts 同款纯函数形态。PROTOCOLS 协议注册表住注册行（协议实现
// 归属分层，llm-protocol-extensibility §2.2）。
// ============================================================

/** 池条目 sessionHeader 字段形状（头值派生与注入住注册行 ac-llm-pool） */
export type SessionHeaderSpec =
  | false // 强制关闭（连 preset 匹配也不发）
  | { name: string }; // 显式指定头名（值仍按会话派生）

/** 池条目 v2 形状（连接定义；model 键为旧别名条目容错读取） */
export interface LlmPoolEntry {
  /**
   * 连接协议（cr-39 多态扩展）：'openai-compat'（缺省，存量零迁移）/
   * 'anthropic' / 'gemini' / 'ollama'——值域即注册行 ac-llm-pool 的 PROTOCOLS 键集（D5 单源，
   * 未知值注册时 fail-loud〔boot〕/ 跳过〔热更〕，D4）。
   */
  protocol?: string;
  /** 连接 base URL（连接必要条件；语义随协议——Anthropic 根址、Gemini
   * 根址、Ollama /api 前根址） */
  base_url?: string;
  /** 该连接的默认模型（Agent 创建未显式选模型时的物化兜底） */
  defaultModel?: string;
  /** /models 发现缓存（宽容双形态：裸名 string 或 {model, vision?, hidden?}；
   *  读侧经 normalizePoolModels 归一——裸名进路由清单，vision/hidden 是
   *  能力元数据：vision 并集进物化门控，hidden 过滤前端下拉显示） */
  models?: Array<string | PoolModelEntry>;
  /**
   * 视觉模型清单（多模态一期：精确 > 前缀 `m-`/`m/` > 通配 `*`）：
   * 命中的模型把 user 消息 attachments 物化为 image_url content 块；
   * 未配置/未命中一律剥离（非视觉模型收到图片块会 400，fail-closed）。
   * 例：['deepseek-v4-flash-vision-exp', 'glm-4v', 'glm-4.5v'] 或整条
   * 视觉专用连接直接 ['*']。与 models[].vision 探测标志取并集生效。
   */
  visionModels?: string[];
  /**
   * 单次请求无进展超时毫秒（D3 透传协议层 timeoutMs）：建连/响应头/
   * 每条 SSE data 事件刷新计时——活跃长生成不限总时长，静默流窗口内
   * 中止。正有限数才生效，其余忽略（回落协议层缺省 180s）。
   */
  timeout_ms?: number;
  /**
   * 接口格式（2026-09-10 Responses 扩展，对齐 DSH/pi-ai 的 api 键）：
   * 'responses' = POST {base}/responses（OpenAI 新模型 / xAI 等支持的
   * 格式）；缺省/其余值 = chat/completions。仅换线格式——messages 进 /
   * chunks 出的域契约不变，Agent/路由/loop 零感知。
   */
  api?: 'completions' | 'responses';
  /**
   * 自定义请求头（D3：部分网关需非标鉴权头）：并入每条 completions
   * 请求，同名覆盖内置 content-type/authorization。仅 string 值项生效
   * （其余静默丢弃——normalizePoolHeaders 唯一解析点）。
   */
  headers?: Record<string, string>;
  /** 鉴权头名（cr-98）：undefined = Bearer；api-key = Azure 形态（透传 openai 协议库） */
  authHeader?: string;
  /**
   * 会话亲和头（2026-09-24 连通性复查）：部分托管网关要求每会话稳定的
   * session 头（如 opencode.ai 的 x-opencode-session，缺发即 400
   * MissingSessionID）。缺省 = 按内置事实清单自动匹配 base_url；
   * { name: '<头名>' } 显式指定；false 强制关闭。头值始终按会话
   * 确定性派生（详见注册行 ac-llm-pool 的 session-affinity）。
   */
  sessionHeader?: SessionHeaderSpec;
  /** 全局默认连接标记（ac-agent-presets / ac-agent-admin 消费） */
  default?: boolean;
  /** 旧别名条目残留（provider+model 形态；迁移后消失） */
  provider?: string;
  model?: string;
}

/** 模型能力元数据（models 数组对象形态；vision = 探测确认收图，
 *  hidden = 前端下拉隐藏显示——路由不受影响，纯 UI 呈现语义；
 *  manual = 手工新增条目——/models 发现刷新时保留〔端点不暴露清单
 *  只能手工加的场景〕，仅参与合并语义，不进门控/签名） */
export interface PoolModelEntry {
  model: string;
  vision?: true;
  hidden?: true;
  manual?: true;
  /**
   * 上下文窗口容量（cr-99 缺口②窄版）：手配声明（发现端点不暴露容量时；
   * 正整数才收）。观测面消费（溢出预警/会话估算），不参与路由与门控。
   */
  contextWindow?: number;
}

/**
 * models 数组宽容归一（读侧唯一解析点）：裸名 string / 对象
 * {model, vision?, hidden?} 双形态 → 统一对象形态；非法项丢弃、按名去重
 * （首个胜）。web-api 模型清单回写消费；webui 下拉过滤走 poolApi 同口径副本。
 */
export function normalizePoolModels(raw: unknown): PoolModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PoolModelEntry[] = [];
  for (const m of raw) {
    let entry: PoolModelEntry | undefined;
    if (typeof m === 'string' && m) entry = { model: m };
    else if (m !== null && typeof m === 'object' && typeof (m as { model?: unknown }).model === 'string' && (m as { model: string }).model) {
      const o = m as { model: string; vision?: unknown; hidden?: unknown; manual?: unknown; contextWindow?: unknown };
      entry = {
        model: o.model,
        ...(o.vision === true ? { vision: true } : {}),
        ...(o.hidden === true ? { hidden: true } : {}),
        ...(o.manual === true ? { manual: true } : {}),
        ...(typeof o.contextWindow === 'number' && Number.isInteger(o.contextWindow) && o.contextWindow > 0 ? { contextWindow: o.contextWindow } : {}),
      };
    }
    if (entry === undefined || seen.has(entry.model)) continue;
    seen.add(entry.model);
    out.push(entry);
  }
  return out;
}

/**
 * 连接默认模型（per-entry 解析单源，cr-313）：
 *   · v2 条目 → defaultModel；
 *   · 旧别名条目 → entry.model；
 *   · 缺省 → models 缓存可见清单的"最新"一项（降序字典序首项，跳过
 *     hidden——与 PoolManager「读取清单后自动取第一个」同一语义。自定义
 *     提供方常只填连接不选默认模型，2026-09-10 反馈：该形态做默认连接时
 *     「默认/继承全局」物化失败致建 Agent 报错）；
 *   · 无任何可物化模型 → undefined。
 */
function poolEntryDefaultModel(entry: LlmPoolEntry): string | undefined {
  if (typeof entry.defaultModel === 'string' && entry.defaultModel) return entry.defaultModel;
  if (typeof entry.model === 'string' && entry.model) return entry.model;
  return newestVisibleModel(entry);
}

/** models 缓存可见清单的降序首项（≈ 命名最新；hidden = 旧模型归档标记跳过） */
function newestVisibleModel(entry: LlmPoolEntry): string | undefined {
  const visible = normalizePoolModels(entry.models).filter((m) => m.hidden !== true);
  return [...visible].sort((a, b) => b.model.localeCompare(a.model))[0]?.model;
}

/**
 * 默认池连接（ac-agent-presets / ac-agent-admin 物化口共源——P5 口径统一）：
 * `default:true` 优先，缺省第一条（非 $ 前缀对象条目）。
 *   · v2 条目（base_url/defaultModel）→ provider = 条目名，model = defaultModel；
 *   · 旧别名条目（provider+model）→ provider = entry.provider，model = entry.model；
 *   · 无任何可物化模型 → undefined。
 */
export function defaultPoolConnection(
  pool: Record<string, unknown> | undefined,
): { provider: string; model: string } | undefined {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return undefined;
  const entries = Object.entries(pool).filter(
    ([k, v]) => !k.startsWith('$') && v !== null && typeof v === 'object' && !Array.isArray(v),
  ) as Array<[string, LlmPoolEntry]>;
  const def = entries.find(([, v]) => v.default === true) ?? entries.at(0);
  if (!def) return undefined;
  const [name, entry] = def;
  const model = poolEntryDefaultModel(entry);
  if (!model) return undefined;
  const provider =
    typeof entry.provider === 'string' && entry.provider && !entry.base_url
      ? entry.provider // 旧别名条目：指向另一 provider 名
      : name;
  return { provider, model };
}

/**
 * 模型缺省回落单源（cr-313 第四态语义补全）：provider 显式 + model 空 →
 * 该连接的默认模型（引用语义——连接换默认模型即跟随，永不物化）；provider
 * 未声明 → 全局默认连接。消费方：router 投递 / agent-admin 预览 / subagent
 * 派生 / archive 整理判定（四处此前各持复制回落）。条目非对象/无条目时该
 * 连接无默认 → 回落全局默认连接（fail-open，投递侧 roster 校验兜底）。
 */
export function poolFallbackRef(
  pool: Record<string, unknown> | undefined,
  provider: string | undefined,
): { provider: string; model: string } | undefined {
  const entry = provider && pool !== undefined && !provider.startsWith('$')
    ? pool[provider]
    : undefined;
  if (provider && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const model = poolEntryDefaultModel(entry as LlmPoolEntry);
    if (model) return { provider, model };
  }
  return defaultPoolConnection(pool);
}
