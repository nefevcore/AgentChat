// ============================================================
// 模型 Schemas —— 各模型的 UI 配置项定义
//
// 导出 *_LLM_SCHEMA 供 API 自动扫描，前端无需硬编码。
// ============================================================

import type { ConfigField } from '@core/types';

export { OPENAI_LLM_SCHEMA } from './openai';
export { DEEPSEEK_LLM_SCHEMA } from './deepseek';

export const OLLAMA_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: '本地部署通常无需设置', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'Ollama 服务端点', type: 'text', default: 'http://localhost:11434/v1' },
  { name: 'model', label: '模型名称', description: '本地模型名，如 llama3', type: 'text', default: 'llama3' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'ratio', default: undefined, min: 0, max: 2, step: 0.1, display: 'number' },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number', default: undefined },
];
