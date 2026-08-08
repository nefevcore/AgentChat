// ============================================================
// src/ui/llm-schemas.ts —— LLM 配置 UI Schema（表单元数据）
//
// 从 src/core 迁出（2026-08-06）：ConfigField 与 *_LLM_SCHEMA 本质属于
// UI 层（供前端动态生成配置表单），L1 引擎运行时不消费。
//
// 注意：本文件属于 UI 层，可依赖上层类型；L1（src/core）不可反向引用。
// ============================================================

/** 基础元数据 */
export interface Meta {
  /** 唯一标识 */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /** 条件显示：当同级其他字段的值匹配时才显示此字段 */
  showWhen?: Record<string, string | number | boolean>;
}

export interface TextFieldMeta extends Meta {
  type: 'text';
  default?: string;
}

export interface PasswordFieldMeta extends Meta {
  type: 'password';
  default?: string;
}

export interface NumberFieldMeta extends Meta {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
}

export interface RatioFieldMeta extends Meta {
  type: 'ratio';
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  /** 显示模式：'number'=原始数值, 'percent'=百分比 */
  display?: 'number' | 'percent';
}

export interface CheckboxFieldMeta extends Meta {
  type: 'checkbox';
  default?: boolean;
}

export interface SelectFieldMeta extends Meta {
  type: 'select';
  default?: string | number;
  options: Array<{ label: string; value: string | number }>;
}

export interface FileFieldMeta extends Meta {
  type: 'file';
  default?: string;
  /** 文件过滤扩展名（如 ".mcp"），逗号分隔多个 */
  accept?: string;
}

/** 配置字段类型（判别联合） */
export type ConfigField =
  | TextFieldMeta
  | PasswordFieldMeta
  | NumberFieldMeta
  | RatioFieldMeta
  | CheckboxFieldMeta
  | SelectFieldMeta
  | FileFieldMeta;

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
