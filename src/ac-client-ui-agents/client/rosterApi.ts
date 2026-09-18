// ============================================================
// ac-client-ui-agents/client/rosterApi.ts —— 名册/池/Token/Agent 配置
// 直连数据面（M28 P1 域资产归位 → M29 P1-3b agent CRUD 归并同宿——
// T3「数据面跟域走」+ agent 数据面双宿主收口：settings/api.ts 的
// createAgent/getAgentConfig/saveAgentConfig 随域迁入，本包成为
// agent 数据面唯一宿主。2026-11 模型发现/池模型归一化面迁出——
// 实为池域词汇，归宿 ui-llm-pool/client/poolApi〔fetchPoolModels/
// poolModelEntries/visibleModelNames〕，消费方换源）
//
// ConversationView 族（TokenGauge 仪表 + AgentHeaderActions 删除 Agent，
//  均经 conversation:header-widget 席位贡献）与 ChatInput（模型菜单）经
// 跨包 import 消费；rpc 必传（RpcClientFace 契约面——
// 原 webui api/roster.ts 门面已退役〔M28 §4.2〕）。其余名册
// 写面（createAgent/头像 HTTP 面/llm providers 等）消费面在 settings/
// sidebar，已随门面退役归本包〔M28 §4.2〕。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import { VIEWER_ID } from 'ac-client-runtime';
import type { AgentConfigViews } from 'ac-client-ui-settings/client/types.ts';

type Rpc = Pick<RpcClientFace, 'call'>;

// ── Agent 配置面（M29 P1-3b 自 settings/api.ts 归并——rpc 必传同宿形态） ──

/** llmParams 透传键全集（与 ac-agents LLM_SAMPLING_KEYS 白名单逐键一致） */
const LLM_SAMPLING_KEYS = [
  'temperature', 'max_tokens', 'top_p', 'response_format', 'stop',
  'reasoning_effort', 'thinking', 'logprobs', 'top_logprobs', 'tool_choice',
] as const;

/** 模型池反查（P5 口径：池条目名 = provider 名——双字段引用无别名形态，
 *  ref 回显只按 provider 名匹配；无匹配 → undefined） */
function llmPoolRefOf(pools: Record<string, any>, provider: unknown): string | undefined {
  if (typeof provider !== 'string' || !provider) return undefined;
  const entry = pools?.[provider];
  return entry && typeof entry === 'object' ? provider : undefined;
}

/** Agent 配置双视图（get-config + SYSTEM/AGENTS.md 双 read-doc 并取 + 池名回显）。
 *  persona 文档双名同义（2026-11 对齐生态事实标准 AGENTS.md）：读序
 *  AGENTS.md 优先、AGENT.md（存量名）回退；保存归一写 AGENTS.md。 */
export async function getAgentConfig(agentId: string, rpc: Rpc): Promise<AgentConfigViews> {
  const agentDoc = await rpc
    .call<{ content?: string }>('agents/read-doc', { agentId, name: 'AGENTS.md' })
    .catch(() => ({ content: undefined }));
  const [cfgR, sysR, agentLegacyR, poolsR] = await Promise.all([
    rpc.call<{ config?: Record<string, any> }>('agents/get-config', { agentId }),
    rpc.call<{ content?: string }>('agents/read-doc', { agentId, name: 'SYSTEM.md' }).catch(() => ({ content: undefined })),
    // AGENT.md 存量回退：仅当 AGENTS.md 未命中时才取（旧名文档不删，读序兼容）
    agentDoc.content === undefined
      ? rpc.call<{ content?: string }>('agents/read-doc', { agentId, name: 'AGENT.md' }).catch(() => ({ content: undefined }))
      : Promise.resolve({ content: undefined }),
    // 池反查（快照语义）：后端 AgentConfig 不存池引用——保存时引用被拆为
    // provider/model 双字段，读回按 provider 名（= 连接条目名）回显 $ref
    // （仅展示定位；池内容后续变更不追踪）。config/get 失败容忍 → 不设 $ref。
    //（同宿 fetchPools 并源——原 settings getPools 跨包导入为迁移残留）
    fetchPools(rpc).catch(() => ({ llmProviders: {} as Record<string, any>, searchProviders: {} as Record<string, any> })),
  ]);
  const c = cfgR.config ?? {};
  const ref = llmPoolRefOf(poolsR.llmProviders, c.provider);
  const view = {
    agent_id: String(c.id ?? agentId),
    name: c.name ?? c.description ?? c.id ?? agentId,
    virtual: c.virtual,
    ...(Array.isArray(c.tags) ? { tags: c.tags } : {}),
    llm: {
      provider: c.provider ?? '',
      ...(c.model ? { model: c.model } : {}),
      ...(typeof c.llmParams === 'object' && c.llmParams ? c.llmParams : {}),
      ...(ref ? { $ref: ref } : {}),
    },
    ...(c.maxSteps !== undefined ? { max_steps: c.maxSteps } : {}),
    // settings.security.allowedPaths 不在此物化（原「安全」页签已移除）：
    // 唯一读写面 = 插件配置页 security 扩展卡片（assembly 契约，raw.settings）
  };
  return {
    agent_id: view.agent_id,
    raw: view,
    effective: view,
    sysContent: sysR.content ?? '',
    agentContent: agentDoc.content ?? agentLegacyR.content ?? '',
  };
}

/** 保存 Agent 配置（patch 映射 + 文档双写）。
 *  连接凭据已退役（P4/D3）：llm.api_key 不再上送——apiKey 归 Provider
 *  连接定义（设置 → 模型管理），Agent 面不可覆盖。 */
export async function saveAgentConfig(
  agentId: string,
  payload: { config: Record<string, any>; sysContent?: string; agentContent?: string },
  rpc: Rpc,
): Promise<{ success?: boolean; error?: string }> {
  const bodyCfg = payload.config ?? {};
  const llm = (bodyCfg.llm ?? {}) as Record<string, any>;
  const patch: Record<string, unknown> = {};
  if (bodyCfg.name !== undefined) patch.name = bodyCfg.name;
  if (llm.provider !== undefined) patch.provider = llm.provider || undefined;
  // model ''/null = 显式清除（「默认」= 按全局设置的默认模型处理）——
  // 服务端 deepMerge 以 null 覆盖落存，投递侧回落默认池连接
  if (llm.model !== undefined) patch.model = llm.model || null;
  const lp: Record<string, unknown> = {};
  for (const k of LLM_SAMPLING_KEYS) {
    if (llm[k] !== undefined) lp[k] = llm[k];
  }
  if (Object.keys(lp).length) patch.llmParams = lp;
  if (bodyCfg.max_steps !== undefined) patch.maxSteps = bodyCfg.max_steps;
  // 能力标签（P6）：AgentPane 徽章编辑写 raw.tags → AgentConfig.tags
  if (bodyCfg.tags !== undefined) patch.tags = bodyCfg.tags;
  // 路径穿透白名单（settings.security.allowedPaths）不在此映射（原「安全」
  // 页签已移除）：唯一写口 = 插件配置页 security 扩展卡片，走 assembly 契约
  await rpc.call('agents/update-config', { agentId, patch });
  // 文档双写：空串=删（sysEnabled off 语义）
  if (typeof payload.sysContent === 'string') {
    await rpc.call('agents/save-doc', { agentId, name: 'SYSTEM.md', content: payload.sysContent }).catch(() => undefined);
  }
  if (typeof payload.agentContent === 'string') {
    await rpc.call('agents/save-doc', { agentId, name: 'AGENTS.md', content: payload.agentContent }).catch(() => undefined);
  }
  return { success: true };
}

/** 会话 Token 用量返回形（session/tokens 归一面——webui 同款） */
export interface SessionTokens {
  tokenCount?: number;
  messageCount?: number;
  maxContextTokens?: number;
  usagePercent?: number;
  avgTokensPerMsg?: number;
  estimatedMsgsRemaining?: number;
  status?: 'low' | 'moderate' | 'high' | 'critical';
  cache?: {
    lastHit?: number;
    lastMiss?: number;
    hit?: number;
    miss?: number;
    lastRunPrompt?: number;
  };
}

/** 会话 Token 用量（session/tokens 全量透传；直答会话键 = pairKey
 *  与后端边界同款推导；独立会话（single）传 opts.conversationId = sid
 *  + opts.agentId = 承载 Agent） */
export async function fetchSessionTokens(
  agentId: string,
  rpc: Rpc,
  opts?: { conversationId?: string; agentId?: string },
): Promise<SessionTokens> {
  const r = await rpc.call<{
    messageCount?: number;
    contextTokens?: number;
    maxContextTokens?: number;
    usagePercent?: number;
    avgTokensPerMsg?: number;
    estimatedMsgsRemaining?: number;
    status?: 'low' | 'moderate' | 'high' | 'critical';
    cache?: {
      lastHit?: number;
      lastMiss?: number;
      hit?: number;
      miss?: number;
      lastRunPrompt?: number;
    };
  }>('session/tokens', {
    conversationId: opts?.conversationId ?? [VIEWER_ID.value, agentId].sort().join('~'),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  });
  return {
    tokenCount: r.contextTokens ?? 0,
    messageCount: r.messageCount ?? 0,
    maxContextTokens: r.maxContextTokens ?? 1_000_000,
    usagePercent: r.usagePercent ?? 0,
    avgTokensPerMsg: r.avgTokensPerMsg ?? 0,
    estimatedMsgsRemaining: r.estimatedMsgsRemaining ?? 0,
    status: r.status ?? 'low',
    ...(r.cache
      ? {
          cache: {
            lastHit: r.cache.lastHit ?? 0,
            lastMiss: r.cache.lastMiss ?? 0,
            hit: r.cache.hit ?? 0,
            miss: r.cache.miss ?? 0,
            lastRunPrompt: r.cache.lastRunPrompt ?? 0,
          },
        }
      : {}),
  };
}

/** 删除 Agent（agents/delete） */
export async function deleteAgent(agentId: string, rpc: Rpc): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('agents/delete', { agentId });
  return { success: true };
}

// ── 能力标签目录（tag-registry P1：AgentPane 徽章编辑数据源） ──

/** 标签目录条目（tags/catalog 线形） */
export interface TagCatalogItem {
  tag: string;
  category: 'base' | 'access-tier' | 'tool-mode' | 'capability' | 'owner' | 'unknown';
  description?: string;
  tools: Array<{ name: string; description?: string; owner?: string }>;
  reserved?: boolean;
  /** 手工声明方（行名） */
  declaredBy?: string;
  /** 独立分组（声明方自组；缺省 = capability 通用组） */
  group?: string;
  /** 目录排序提示（缺省 50，组内升序）——分层族按层级呈现 */
  order?: number;
  /** 分层族标记（低 ⊂ 高：勾选高层含低层全部能力） */
  tier?: boolean;
}

/** 拉取能力标签目录（行未装配 → rpc error，调用方回退本地徽章表） */
export async function fetchTagCatalog(rpc: Rpc): Promise<TagCatalogItem[]> {
  const r = await rpc.call<{ tags?: TagCatalogItem[] }>('tags/catalog');
  return Array.isArray(r.tags) ? r.tags : [];
}

/** Provider 池（config/get 白名单域合成；ChatInput 模型菜单数据源） */
export async function fetchPools(
  rpc: Rpc,
): Promise<{ llmProviders: Record<string, Record<string, unknown>>; searchProviders: Record<string, Record<string, unknown>> }> {
  const r = await rpc.call<{ config?: Record<string, unknown> }>('config/get');
  const cfg = r.config ?? {};
  return {
    llmProviders: (cfg.llmProviders ?? cfg.llm ?? {}) as Record<string, Record<string, unknown>>,
    searchProviders: (cfg.searchProviders ?? {}) as Record<string, Record<string, unknown>>,
  };
}

//（2026-11 模型发现/池模型归一化面迁出：PoolModelMeta/poolModelEntries/
//  visibleModelNames/fetchAgentModels → ui-llm-pool/client/poolApi.ts
//  〔fetchPoolModels——池域词汇语义归位〕，消费方 AgentPane/ChatInput/
//  PoolManager 已换源）
