// ============================================================
// ac-client-ui-llm-pool/client/poolApi.ts —— Provider 池数据面
//（M29 P1-3d 自 settings/api.ts 归域迁入——T3「数据面跟域走」：
// 视图已随行（PoolManager/Host），数据面随视图归位。2026-09-11 行拆分：
// 原 savePoolDomain 联合域收窄为 llmProviders——searchProviders 写面
// 拆往 ac-client-ui-search-pool/searchPoolApi。2026-09-11 语义归位：
// 模型发现/池模型归一化面自 ui-agents/rosterApi 迁入——原 M29 P1-3b
// 按「名义消费者」误归 agent 面，实为池域词汇〔llm/models RPC +
// llmProviders 发现缓存〕；消费方换源后依赖方向正置为
// agents/conversation → llm-pool。）
//
// 形态：rpc 必传（消费组件经 rpc 契约面 + seam 取用）。池【读取】
// （getPools = config/get 白名单域合成）与 schema 引擎留守 settings
//（全局配置域 + 通用 kit）；此处收【写/探测/发现】面。
// ============================================================

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 模型池定向保存（PoolManager 即时落盘——不再等底部「保存配置」全量保存；
 *  api_key 侧信道语义在服务端 config/set：掩码=不动 / ''=删 / 新值=存） */
export async function saveLlmPoolDomain(
  pools: Record<string, any>,
  rpc: Rpc,
): Promise<void> {
  await rpc.call('config/set', { key: 'llmProviders', value: pools });
}

/** 删除 Provider 连接凭据（pool:<name>）——删除连接条目时必须同步调用，
 *  否则内置种子名的 /models 发现回写会凭残留凭据"复活"已删条目 */
export async function deleteLlmPoolCredential(name: string, rpc: Rpc): Promise<void> {
  await rpc.call('llm/pool-credential', { name, value: '' });
}

/** 连接引用扫描（cr-99 引用完整性）：引用该连接的 Agent 清单（删除/改名
 *  前消费——静默断路变可见决策）。后端 llm/pool-references（agents 名册扫描）。 */
export async function fetchPoolReferences(
  name: string,
  rpc: Rpc,
): Promise<{ agents: Array<{ id: string; name?: string }> }> {
  const r = await rpc.call<{ agents?: Array<{ id: string; name?: string }> }>('llm/pool-references', { name });
  return { agents: r.agents ?? [] };
}

/** 免注册连接探测（新建弹窗"填 Key 即读清单"）：base_url + api_key
 *  [+ protocol] 直调协议清单端点（后端本地代理，不经注册面——保存前
 *  可用；不写缓存）。protocol 缺省 openai-compat（cr-39 协议多态）。 */
export async function probeLlmModels(
  baseUrl: string,
  apiKey: string,
  rpc: Rpc,
  protocol?: string,
): Promise<{ models: string[] }> {
  const r = await rpc.call<{ models?: string[] }>('llm/probe-models', {
    base_url: baseUrl,
    api_key: apiKey,
    ...(protocol && protocol !== 'openai-compat' ? { protocol } : {}),
  });
  return { models: r.models ?? [] };
}

/**
 * 视觉能力探测（模型能力元数据）：逐模型 1×1 图最小请求三态判定
 * （true/false/null=未知）。免注册路径（base_url+api_key，保存前可用）
 * 与注册路径（provider 名——后端附加 pool:<名> 凭据）双形态。
 */
export async function probeLlmVision(
  input: { baseUrl?: string; apiKey?: string; provider?: string; models: string[] },
  rpc: Rpc,
): Promise<{ results: Record<string, boolean | null> }> {
  const r = await rpc.call<{ results?: Record<string, boolean | null> }>('llm/probe-vision', {
    models: input.models,
    ...(input.baseUrl ? { base_url: input.baseUrl, ...(input.apiKey ? { api_key: input.apiKey } : {}) } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  });
  return { results: r.results ?? {} };
}

// ── 池模型元数据与发现面（2026-09-11 自 ui-agents/rosterApi 迁入——语义
//    归位：模型发现/池条目 models 归一化是池域词汇，Agent 面与池管理面
//    共消费；原 fetchAgentModels 更名 fetchPoolModels） ──

/** 模型能力元数据条目（与后端 PoolModelEntry 同形）；manual = 手工新增
 *  （端点不暴露 /models 清单时手工加的模型 id——发现刷新不冲掉） */
export interface PoolModelMeta {
  model: string;
  vision?: true;
  hidden?: true;
  manual?: true;
}

/** 池条目 models 宽容归一（读侧唯一解析点）：裸名 string / 对象
 *  {model, vision?, hidden?, manual?} 双形态 → 统一对象形态。 */
export function poolModelEntries(raw: unknown): PoolModelMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolModelMeta[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    let e: PoolModelMeta | undefined;
    if (typeof m === 'string' && m) e = { model: m };
    else if (m !== null && typeof m === 'object' && typeof (m as { model?: unknown }).model === 'string' && (m as { model: string }).model) {
      const o = m as { model: string; vision?: unknown; hidden?: unknown; manual?: unknown };
      e = { model: o.model, ...(o.vision === true ? { vision: true } : {}), ...(o.hidden === true ? { hidden: true } : {}), ...(o.manual === true ? { manual: true } : {}) };
    }
    if (!e || seen.has(e.model)) continue;
    seen.add(e.model);
    out.push(e);
  }
  return out;
}

/** 下拉可见模型名（hidden 过滤——纯 UI 呈现语义，路由不受影响） */
export function visibleModelNames(raw: unknown): string[] {
  return poolModelEntries(raw).filter((e) => e.hidden !== true).map((e) => e.model);
}

/** 模型发现（llm/models 真 /models 代理：后端附加 pool:<name> 凭据；
 *  refresh = 强制拉取并回写发现缓存——下拉随刷新联动。消费者：
 *  PoolManager〔本行〕+ AgentPane〔ui-agents〕/ ChatInput〔conversation〕） */
export async function fetchPoolModels(
  name: string,
  refresh: boolean,
  rpc: Rpc,
): Promise<{ models: string[] }> {
  const r = await rpc.call<{ name?: string; models?: string[] }>('llm/models', { name, ...(refresh ? { refresh: true } : {}) });
  return { models: r.models ?? [] };
}

/** provider 品牌图标（cr-203 模型菜单）：按 base_url 域名匹配 simple-icons
 *  logo（si- 名住 webui-kit icons.ts）；未命中 undefined——消费方回退 cpu。
 *  映射面与 LLM_PROVIDER_TEMPLATES 同源维护（settings/api.ts）。 */
const PROVIDER_ICON_BY_HOST: Record<string, string> = {
  'api.openai.com': 'si-openai',
  'api.anthropic.com': 'si-anthropic',
  'api.individual.githubcopilot.com': 'si-github-copilot',
  'bedrock-runtime.us-east-1.amazonaws.com': 'si-aws',
  'api.deepseek.com': 'si-deepseek',
  'generativelanguage.googleapis.com': 'si-gemini',
  'router.huggingface.co': 'si-huggingface',
  'api.minimaxi.com': 'si-minimax',
  'api.mistral.ai': 'si-mistral',
  'api.moonshot.cn': 'si-moonshot',
  'api.moonshot.ai': 'si-moonshot',
  'api.kimi.com': 'si-kimi',
  'integrate.api.nvidia.com': 'si-nvidia',
  'opencode.ai': 'si-opencode',
  'openrouter.ai': 'si-openrouter',
  'dashscope.aliyuncs.com': 'si-qwen',
  'maas.aliyuncs.com': 'si-qwen',
  'ai-gateway.vercel.sh': 'si-vercel',
  'api.x.ai': 'si-x',
  'api.xiaomimimo.com': 'si-xiaomi',
  'token-plan-cn.xiaomimimo.com': 'si-xiaomi',
  'open.bigmodel.cn': 'si-zai',
  'api.z.ai': 'si-zai',
};

/** 后缀域键（azure 占位符 <资源名>.openai.azure.com 等子域形态） */
const PROVIDER_ICON_SUFFIX: Array<[string, string]> = [
  ['.openai.azure.com', 'si-azure'],
  ['.amazonaws.com', 'si-aws'],
];

/** 品牌官方色（cr-206，simple-icons 档案 hex）：彩色系双主题同值；
 *  黑白系（openai/github-copilot/opencode/vercel/x）不进表——跟随
 *  currentColor（主题墨色），避免暗色下纯黑不可见。 */
const PROVIDER_ICON_COLOR: Record<string, string> = {
  'si-anthropic': '#D97757',
  'si-aws': '#FF9900',
  'si-azure': '#0078D4',
  'si-deepseek': '#4D6BFE',
  'si-gemini': '#4796E3',
  'si-huggingface': '#FFD21E',
  'si-minimax': '#FF3CEF',
  'si-mistral': '#FA520F',
  'si-moonshot': '#16B2F0',
  'si-kimi': '#16B2F0',
  'si-nvidia': '#76B900',
  'si-openrouter': '#656FF5',
  'si-qwen': '#615CED',
  'si-xiaomi': '#FF6900',
  'si-zai': '#134cff',
};

/** 品牌色（未收录品牌 undefined → 继承 currentColor） */
export function providerIconColor(iconName: string | undefined): string | undefined {
  return iconName ? PROVIDER_ICON_COLOR[iconName] : undefined;
}

export function providerIconOf(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== 'string' || !baseUrl) return undefined;
  // 模板占位符 URL（如 https://<资源名>.openai.azure.com/...）含非法字符，
  // URL 构造器会抛——退化手动取 host 段（// 后到首 / 前，再去端口）
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    const m = baseUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i);
    if (!m) return undefined;
    host = m[1].split(':')[0];
  }
  if (PROVIDER_ICON_BY_HOST[host]) return PROVIDER_ICON_BY_HOST[host];
  return PROVIDER_ICON_SUFFIX.find(([suffix]) => host.endsWith(suffix))?.[1];
} 
