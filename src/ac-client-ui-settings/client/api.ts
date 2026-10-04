// ============================================================
// settings/api.ts —— 类型化 API 层（阶段二第二梯：Port B 直连）
//
// 全部端点已迁 preview 词汇（rpc/call 方法名直转）。M22 P2 后插件域
// 直消费 preview 形状（agents/assembly、plugin/extension-catalog、
// plugin/dev-scan），src AssemblyView/HookKind 适配层已退场；
// 市场为 preview 无面（M22 D8 摘除）；原生文件对话框显式降级。
//
// M29 P1-3 数据面归域：插件域全套（catalog/library/market/staging/
// approve/uninstall/patch/会话装载/事件链与描述）已迁
// ac-client-ui-plugin-registry/client/pluginApi.ts（rpc 必传）；
// agent CRUD → ui-agents（rosterApi 同宿）、timer → ui-timer、
// llm/search pool → ui-llm-pool。本文件留守：全局配置 + 池读写（P1-3d
// 前过渡）+ schema 引擎 + assembly + 全局默认层 + event policy
//（治理配置——M29 开工裁决定留守）。
// ============================================================

import type {
  FieldMeta,
  PoolData,
  AssemblyData,
  AssemblyPatch,
} from './types.ts';
import { defaultRpc as wireRpc } from './rpcDefault.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ── 全局配置 ──

export function getGlobalConfig(rpc: Rpc = wireRpc): Promise<{ config: Record<string, any> }> {
  return rpc.call('config/get');
}

export function saveGlobalConfig(config: Record<string, any>, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  return rpc.call('config/save', { config });
}

export function getPools(rpc: Rpc = wireRpc): Promise<PoolData> {
  // preview 无专用池端点：config/get 白名单域（llmProviders/searchProviders 键）
  return rpc.call<{ config: Record<string, any> }>('config/get').then((r) => ({
    llmProviders: (r.config.llmProviders ?? r.config.llm ?? {}) as PoolData['llmProviders'],
    searchProviders: (r.config.searchProviders ?? {}) as PoolData['searchProviders'],
  }));
}

//（M29 P1-3d：池写/探测面（savePoolDomain/deleteLlmPoolCredential/probeLlmModels/probeLlmVision）已归 ui-llm-pool/client/poolApi.ts）

// ── Schema（LLM/search 内置字段表合成；namespace 仍空表 = FieldMeta 归一化容忍） ──

/**
 * LLM provider 内置字段表（AgentPane 模型页签表单数据源）。
 * llm-provider-model-plan P5：连接字段（api_key/base_url）收敛进 Provider
 * 连接定义（设置 → 模型管理 / PoolManager）——Agent 面只选 provider+model
 * 与采样参数（logprobs/top_logprobs/tool_choice 由 AgentPane 的
 * HIDDEN_LLM_KEYS 过滤不展示）。
 * · model 字段：AgentPane 以 key === 'model' 特判渲染为纯下拉——
 *   「默认」+ 所选连接的模型清单（进页签/换连接自动读取 /models 发现，
 *   不再有手输与「读取」按钮）。
 * · reasoning_effort：下拉档位（与会话输入框同词汇：默认/无/low/high/max）——
 *   「默认」= 不覆盖（不发送推理参数，跟随服务商缺省）；「无」('none')
 *   由后端 filterLlmParams 翻译为 thinking disabled（显式关闭思考输出，
 *   替代原「思考输出」勾选）。
 */
/** 推理力度档位（与会话输入框同词汇）。'' = 默认：不发送推理参数、
 *  跟随服务商缺省（DeepSeek/GLM 默认开启思考）；'none' = 显式关闭思考 */
const EFFORT_FIELD_OPTIONS = [
  { label: '默认（跟随服务商）', value: '' },
  { label: '无', value: 'none' },
  { label: 'low', value: 'low' },
  { label: 'high', value: 'high' },
  { label: 'max', value: 'max' },
];

const BUILTIN_LLM_SCHEMA: FieldMeta[] = [
  { key: 'model', label: '模型 ID', description: '「默认」= 按全局设置的默认模型处理；清单来自所选连接的模型发现', type: 'text' },
  { key: 'reasoning_effort', label: '推理力度', description: '默认 = 不发送推理参数（跟随服务商，DeepSeek/GLM 默认开启思考）；无 = 关闭思考输出；low / high / max = 强度档位', type: 'select', options: EFFORT_FIELD_OPTIONS },
  { key: 'temperature', label: '温度', description: '采样发散度（0-2）', type: 'number', min: 0, max: 2, step: 0.1 },
  { key: 'top_p', label: 'top_p', description: '核采样阈值（0-1）', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'max_tokens', label: '最大输出 Token', type: 'number' },
  { key: 'stop', label: '停止词', description: '生成命中该词即终止（单个停止词）', type: 'text' },
  { key: 'response_format', label: '输出格式', description: '如 json_object', type: 'text' },
  { key: 'logprobs', label: 'logprobs', type: 'checkbox' },
  { key: 'top_logprobs', label: 'top_logprobs', type: 'number' },
  { key: 'tool_choice', label: 'tool_choice', type: 'text' },
];

/** Provider 连接模板（PoolManager「+ 添加」预设——模板出默认 base_url/
 *  defaultModel，用户只需起名 + 填 API Key；名称与模板解耦：同名即该
 *  provider 的引用名，多账号可另起名（如 ds-work / ds-personal）） */
export interface LlmProviderTemplate {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel?: string;
  /** 连接协议（cr-39 多态）：缺省 openai-compat；anthropic/gemini/ollama
   *  = 原生协议模板（PoolManager 保存时随条目落 protocol 字段） */
  protocol?: string;
  /** 鉴权头名（cr-98 云部署型）：缺省 undefined = 标准 Bearer；'api-key'
   *  = Azure resource key 头（裸 key 值，无 Bearer 前缀）。key 值经凭据库
   *  （pool:<名>）注入，绝不进 headers 字段（明文落盘纪律） */
  authHeader?: string;
}

export const LLM_PROVIDER_TEMPLATES: LlmProviderTemplate[] = [
  // 按 id 字母序维护（cr-183）。扩容沿革：2026-09-10 对齐 DSH（pi-ai）
  // provider 目录的 OpenAI 兼容面——原生协议非 OpenAI 兼容的厂商取其
  // 官方 OpenAI 兼容端点；2026-10-01 二次扩容（对齐 pi-ai 2026-07-25
  // 目录）新增 12 提供方，pi-ai 走 anthropic-messages 且 API key 可用
  // 的网关（Kimi 编程套餐/GitHub Copilot/Vercel 网关）以原生协议模板
  // 收录（protocol 字段，cr-39 多态）；占位符 URL（Cloudflare）与
  // OAuth-only（openai-codex）不收录，云托管部署型初批不收录（cr-98
  // 后 Bedrock/Azure 补入，见条目分注）。2026-10-04 品牌对齐更名
  // glm→zai、glm-coding-plan→zai-coding-cn，并移除 glm-coding（Coding
  // Plan 订阅唯一：国际/国内端点同订阅，见 zai-coding-cn 条注）。套餐/
  // 厂商且多变——不设 defaultModel，填 Key 读清单后自选（服务端默认
  // 物化亦有清单回落）。
  { id: 'ant-ling', label: '蚂蚁 Ling 开放平台', baseUrl: 'https://api.ant-ling.com/v1', defaultModel: 'Ling-2.6-flash' },
  { id: 'anthropic', label: 'Anthropic Claude（OpenAI 兼容端点）', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-5' },
  // ↓ 云部署型 API key 化端点（cr-98，裁决见 src/docs/cloud-provider-api-key-adoption.md）：
  // Azure v1 统一路由（免 deployment 拼路径）+ api-key 头（authHeader 池
  // 字段）；Bedrock /openai/v1 兼容面 + Bearer（控制台生成的短期 API
  // key）。Vertex Express 缓收录（AI Studio 模板已覆盖 key 化面）。
  // region/资源名因用户而异——baseUrl 占位说明，用户按账号改写。
  { id: 'azure-openai', label: 'Azure OpenAI（v1 统一路由）', baseUrl: 'https://<资源名>.openai.azure.com/openai/v1', authHeader: 'api-key' },
  { id: 'bedrock', label: 'Amazon Bedrock（OpenAI 兼容端点）', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1' },
  { id: 'cerebras', label: 'Cerebras（极速推理）', baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'gpt-oss-120b' },
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-flash' },
  { id: 'fireworks', label: 'Fireworks AI（模型聚合）', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { id: 'gemini', label: 'Google Gemini（OpenAI 兼容端点）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-flash-latest' },
  { id: 'github-copilot', label: 'GitHub Copilot（Anthropic 协议）', baseUrl: 'https://api.individual.githubcopilot.com', protocol: 'anthropic' },
  { id: 'groq', label: 'Groq（极速推理）', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b' },
  { id: 'huggingface', label: 'Hugging Face（Inference Providers 聚合）', baseUrl: 'https://router.huggingface.co/v1' },
  { id: 'kimi-coding', label: 'Kimi 编程套餐（Anthropic 协议）', baseUrl: 'https://api.kimi.com/coding', protocol: 'anthropic' },
  { id: 'minimax', label: 'MiniMax 开放平台', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3' },
  { id: 'mistral', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest' },
  { id: 'moonshot', label: '月之暗面 Kimi（开放平台）', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3' },
  { id: 'moonshotai', label: '月之暗面 Kimi 国际版', baseUrl: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k3' },
  { id: 'nvidia', label: 'NVIDIA NIM（模型聚合）', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { id: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  // opencode.ai 域由 session-affinity preset 自动注入 x-opencode-session（粘性路由）
  { id: 'opencode', label: 'OpenCode Zen（订阅聚合）', baseUrl: 'https://opencode.ai/zen/v1' },
  { id: 'opencode-go', label: 'OpenCode Go（编程订阅）', baseUrl: 'https://opencode.ai/zen/go/v1' },
  { id: 'openrouter', label: 'OpenRouter（模型聚合）', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'qwen', label: '阿里云百炼 Qwen（按量付费）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.8-max' },
  { id: 'qwen-coding-plan', label: '阿里 Qwen 套餐（订阅制端点）', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
  { id: 'together', label: 'Together AI（模型聚合）', baseUrl: 'https://api.together.ai/v1' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway（模型聚合，Anthropic 协议）', baseUrl: 'https://ai-gateway.vercel.sh', protocol: 'anthropic' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.5' },
  { id: 'xiaomi', label: '小米 MiMo 开放平台', baseUrl: 'https://api.xiaomimimo.com/v1', defaultModel: 'mimo-v2.5-pro' },
  { id: 'xiaomi-token-plan-cn', label: '小米 MiMo 套餐（订阅制端点）', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
  { id: 'zai', label: '智谱 GLM 开放平台', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3' },
  // ZAI Coding Plan（编程套餐独立端点）——套餐模型集与开放平台不同，
  // 不设 defaultModel：填 Key 读取清单后自动取第一个。同一订阅国际/
  // 国内两入口（cr-185）：需国际端点时把 base_url 改为
  // https://api.z.ai/api/coding/paas/v4（原 glm-coding 模板已并入）
  { id: 'zai-coding-cn', label: '智谱 GLM Coding Plan（编程套餐）', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
];

/** 模板 → 字段默认值（getLlmSchemas 的 model 默认同源） */
const LLM_PROVIDER_DEFAULTS: Record<string, Record<string, unknown>> = Object.fromEntries(
  LLM_PROVIDER_TEMPLATES.map((t) => [t.id, { base_url: t.baseUrl, ...(t.defaultModel ? { model: t.defaultModel } : {}) }]),
);

/** 字段表按 provider 默认值表打 default（浅拷贝不改基表；避开 Vue 宏同名） */
function applyFieldDefaults(base: FieldMeta[], defaults: Record<string, unknown>): FieldMeta[] {
  return base.map((f) => (f.key in defaults ? { ...f, default: defaults[f.key] } : f));
}

export async function getLlmSchemas(): Promise<Record<string, any[]>> {
  const table: Record<string, any[]> = {};
  for (const [provider, defaults] of Object.entries(LLM_PROVIDER_DEFAULTS)) {
    table[provider] = applyFieldDefaults(BUILTIN_LLM_SCHEMA, defaults);
  }
  return table;
}

// ── 搜索 provider 内置字段表（2026-09-08 收敛：仅 tavily/deepseek——与
// ac-web-search-core PROVIDER_REGISTRY 同口径；未实测的三家不保证能用，
// 注册表与池页下拉一并摘除）──
// 此前 getSearchSchemas 恒返回空表：PoolManager 的 providerOptions 为空、
// 字段集为空——「+ 添加」弹窗只有一个空下拉和零字段，搜索引擎根本无法
// 新增。deepseek 配置项只保留 api_key——端点（anthropic/v1 端点）/模型
// （deepseek-v4-flash）/搜索次数（5）由 ac-web-search-core 内置缺省接管，
// 调优字段（深度/主题）deepseek 不消费，均不再暴露（存量 config 键运行时
// 兼容读取）；tavily 只读 api_key + 调优字段（默认值与 ac-web-tools 缺省
// 一致：5 条 / advanced / general / 截断 2000）。池 default 条目 =
// web_search 的缺省源（行侧 defaultSearchPool 接线）。

/** 搜索调优公共字段（键 = 搜索池条目 / settings['web-tools'] 词汇） */
const SEARCH_TUNING_FIELDS: FieldMeta[] = [
  { key: 'defaultResults', label: '默认结果数', type: 'number', default: 5 },
  { key: 'defaultDepth', label: '默认深度', type: 'select', options: [{ label: 'basic', value: 'basic' }, { label: 'advanced', value: 'advanced' }], default: 'advanced' },
  { key: 'defaultTopic', label: '默认主题', type: 'select', options: [{ label: 'general', value: 'general' }, { label: 'news', value: 'news' }, { label: 'finance', value: 'finance' }], default: 'general' },
  { key: 'rawContentMaxLen', label: '原文截断长度', description: 'raw_content 超长截断（字符）', type: 'number', default: 2000 },
];

const BUILTIN_SEARCH_SCHEMAS: Record<string, FieldMeta[]> = {
  tavily: [
    { key: 'api_key', label: 'API Key', description: 'Tavily 密钥；可前往 app.tavily.com 免费获取（每月 1000 次）。加密存于凭据库，不入 config.json', type: 'password', sensitive: true },
    ...SEARCH_TUNING_FIELDS,
  ],
  deepseek: [
    { key: 'api_key', label: 'API Key', description: '与 DeepSeek 模型共用同一 Key（platform.deepseek.com）。加密存于凭据库，不入 config.json；端点/模型/搜索次数等参数走内置默认', type: 'password', sensitive: true },
  ],
};

export async function getSearchSchemas(): Promise<Record<string, any[]>> {
  return BUILTIN_SEARCH_SCHEMAS;
}

export async function getNamespaceSchemas(): Promise<{ namespaces: Record<string, any[]>; extensions?: any; tools?: any }> {
  return { namespaces: {} };
}

// ── Agent 装配视图（M29 P1-3 留守 settings——保存编排的组成部分） ──

/** ① Agent 装配视图（agents/assembly 直连；M22 P2 起无适配层，仅容忍缺省；
 *  M24 X1：hooks → settings 线格式同批原子切换） */
export async function getAssembly(agentId: string, rpc: Rpc = wireRpc): Promise<{ assembly: AssemblyData }> {
  const r = await rpc.call<{ assembly?: Record<string, unknown> }>('agents/assembly', { agentId });
  const a = (r.assembly ?? {}) as Partial<AssemblyData>;
  return {
    assembly: {
      agentId: a.agentId ?? agentId,
      settings: {
        enabled: a.settings?.enabled ?? [],
        configs: a.settings?.configs ?? {},
      },
      tools: {
        include: a.tools?.include ?? [],
        exclude: a.tools?.exclude ?? [],
        enabled: a.tools?.enabled ?? [],
        catalog: a.tools?.catalog ?? [],
      },
    },
  };
}

/** ① 保存装配（agents/assembly/update：settings per-name 浅合并 / null 删除——
 *  合并语义在服务端（M22 D5），前端不再 read-modify-write（B8 竞态消除）） */
export async function saveAssembly(agentId: string, patch: AssemblyPatch, rpc: Rpc = wireRpc): Promise<{ assembly: AssemblyData }> {
  await rpc.call('agents/assembly/update', { agentId, patch: patch as unknown as Record<string, unknown> });
  return getAssembly(agentId, rpc);
}

// ── ③d 全局默认层（M24 A1：config settings 域单键读写） ──

/** 读全局默认层全量（config.get → settings） */
export async function getGlobalSettings(rpc: Rpc = wireRpc): Promise<Record<string, any>> {
  const r = await rpc.call<{ config?: Record<string, any> }>('config/get');
  return (r.config?.settings ?? {}) as Record<string, any>;
}

/** 写一个插件的全局默认层（config/set → settings.<configNs>；value null = 删除） */
export async function setGlobalSetting(
  configNs: string,
  value: Record<string, unknown> | null,
  rpc: Rpc = wireRpc,
): Promise<void> {
  if (value === null) {
    await rpc.call('config/delete', { key: `settings.${configNs}` });
    return;
  }
  await rpc.call('config/set', { key: `settings.${configNs}`, value });
}

// ── ⑨ 事件治理面（M25 P2；M29 P1-3 开工裁决定留守 settings——全局治理
//    配置与全局默认层同性质，不随插件库视图走） ──

/** 治理停用集（events/policy-list；行未装载 → 空呈现） */
export async function getEventPolicy(rpc: Rpc = wireRpc): Promise<{ disabled: string[]; live: string[] }> {
  const r = await rpc
    .call<{ disabled?: string[]; live?: string[] }>('events/policy-list')
    .catch(() => ({}) as { disabled?: string[]; live?: string[] });
  return { disabled: r.disabled ?? [], live: r.live ?? [] };
}

/** 写一条治理键（events/policy-set；返回更新后的停用集与影响提示） */
export async function setEventPolicy(
  key: string,
  disabled: boolean,
  rpc: Rpc = wireRpc,
): Promise<{ disabledList: string[]; note?: string }> {
  const r = await rpc.call<{ disabledList?: string[]; note?: string }>('events/policy-set', { key, disabled });
  return { disabledList: r.disabledList ?? [], ...(r.note ? { note: r.note } : {}) };
}

// ── 杀手锏兜底（preview 无原生文件对话框：显式失败，SettingField 走手输路径） ──

export async function browseFile(_accept?: string, _title?: string): Promise<{ success: boolean; path?: string }> {
  return { success: false };
}
