// ============================================================
// src/ui/llm-schemas.ts —— LLM / 搜索 Provider 配置 UI Schema（表单元数据）
//
// ConfigField 类型族已下沉至 src/plugins/schema.ts（插件配置 Schema 契约，
// 工具/钩子在自己模块内声明配置项，后端动态收集）。本文件仅保留
// 非插件化的 Provider 池 Schema（LLM / 搜索引擎）。
//
// 注意：本文件属于 UI 层，可依赖上层类型；L1（src/core）不可反向引用。
// ============================================================

import type { ConfigField } from '@agentchat/tools';

export type { ConfigField, Meta } from '@agentchat/tools';

/** OpenAI 兼容提供商的配置表单 Schema */
export const OPENAI_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: 'API Key（支持 ${ENV_VAR} 环境变量引用）', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'OpenAI 兼容 API 端点', type: 'text', default: 'https://api.openai.com/v1' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 gpt-4o', type: 'text', default: 'gpt-4o' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'ratio', min: 0, max: 2, step: 0.1, display: 'number' },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number' },
  { name: 'top_p', label: 'Top P', description: '核采样参数 (0-1)，留空使用默认值', type: 'ratio', min: 0, max: 1, step: 0.05, display: 'number' },
  { name: 'response_format', label: '输出格式', description: 'text=普通文本, json_object=强制JSON', type: 'select', options: [{ label: 'text', value: 'text' }, { label: 'JSON', value: 'json_object' }] },
  { name: 'stop', label: '停止词', description: '遇到即停止输出，逗号分隔多个', type: 'text' },
];

/** DeepSeek 提供商的配置表单 Schema */
export const DEEPSEEK_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: 'API Key（支持 ${ENV_VAR} 环境变量引用）', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'DeepSeek API 端点', type: 'text', default: 'https://api.deepseek.com' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 deepseek-v4-flash', type: 'text', default: 'deepseek-v4-flash' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'ratio', min: 0, max: 2, step: 0.1, display: 'number' },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number' },
  { name: 'top_p', label: 'Top P', description: '核采样参数 (0-1)，留空使用默认值', type: 'ratio', min: 0, max: 1, step: 0.05, display: 'number' },
  { name: 'response_format', label: '输出格式', description: 'text=普通文本, json_object=强制JSON', type: 'select', options: [{ label: 'text', value: 'text' }, { label: 'JSON', value: 'json_object' }] },
  { name: 'stop', label: '停止词', description: '遇到即停止输出，逗号分隔多个', type: 'text' },
  { name: 'reasoning_effort', label: '思考强度', description: '深度思考模式强度', type: 'select', default: 'high', options: [{ label: 'High', value: 'high' }, { label: 'Max', value: 'max' }] },
  { name: 'thinking', label: '思考模式', description: '是否默认开启深度思考', type: 'checkbox', default: true },
  { name: 'logprobs', label: '对数概率', description: '是否返回每个 token 的对数概率', type: 'checkbox', default: false },
  { name: 'top_logprobs', label: 'Top Logprobs', description: '返回 top N 概率 token 的对数概率 (0-20)', type: 'number' },
  { name: 'tool_choice', label: '工具选择', description: 'none=不调用, auto=自动, required=必须调用', type: 'select', options: [{ label: 'auto', value: 'auto' }, { label: 'none', value: 'none' }, { label: 'required', value: 'required' }] },
];

/** Ollama（本地）提供商的配置表单 Schema */
export const OLLAMA_LLM_SCHEMA: ConfigField[] = [
  { name: 'base_url', label: 'API 地址', description: 'Ollama API 端点', type: 'text', default: 'http://localhost:11434' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 qwen2.5:14b', type: 'text', default: 'qwen2.5:14b' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'ratio', min: 0, max: 2, step: 0.1, display: 'number' },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number' },
  { name: 'thinking', label: '思考模式', description: '是否默认开启思考', type: 'checkbox', default: false },
];

// ============================================================
// 搜索引擎 Provider Schema（GET /api/plugins/search-schemas）
// ============================================================

const RESULTS_FIELD: ConfigField = { name: 'defaultResults', label: '默认结果数', description: '单次搜索返回结果条数', type: 'number', default: 5, min: 1, max: 20 };

/** 搜索引擎各 Provider 的配置表单 Schema */
export const SEARCH_PROVIDER_SCHEMAS: Record<string, ConfigField[]> = {
  tavily: [
    { name: 'tavilyApiKey', label: 'Tavily API Key', description: 'Tavily API Key（留空则用环境变量）', type: 'password', default: '' },
    RESULTS_FIELD,
    { name: 'defaultDepth', label: '搜索深度', description: 'basic=快速摘要, advanced=深度检索', type: 'select', default: 'advanced', options: [{ label: 'basic', value: 'basic' }, { label: 'advanced', value: 'advanced' }] },
    { name: 'defaultTopic', label: '默认主题', description: '搜索主题范围', type: 'select', default: 'general', options: [
      { label: 'general', value: 'general' }, { label: 'news', value: 'news' }, { label: 'finance', value: 'finance' }, { label: 'academic', value: 'academic' },
    ] },
    { name: 'rawContentMaxLen', label: '原始内容截断', description: '网页正文最大保留长度', type: 'number', default: 2000 },
  ],
  serpapi: [
    { name: 'serpapiApiKey', label: 'SerpAPI Key', description: 'SerpAPI API Key', type: 'password', default: '' },
    RESULTS_FIELD,
    { name: 'location', label: '地区', description: '搜索地区（如 china）', type: 'text', default: 'china' },
  ],
  brave: [
    { name: 'braveApiKey', label: 'Brave Search API Key', description: 'Brave Search API Key', type: 'password', default: '' },
    RESULTS_FIELD,
    { name: 'country', label: '国家代码', description: 'ISO 3166 国家代码（如 CN）', type: 'text', default: 'CN' },
  ],
  duckduckgo: [
    RESULTS_FIELD,
    { name: 'region', label: '地区', description: '搜索结果地区（如 cn-zh）', type: 'text', default: 'cn-zh' },
  ],
};
