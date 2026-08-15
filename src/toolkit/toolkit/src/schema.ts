// ============================================================
// src/plugins/schema.ts —— 插件配置 Schema 契约（L3 扩展层）
//
// 配置表单元数据（ConfigField）从 src/ui/llm-schemas.ts 下沉至此：
//   工具（Tool 的 config / PluginDefinition.configs）与钩子（hook catalog）
//   在自己的模块内声明配置项，PluginRegistry.listConfigSchemas() 动态收集，
//   经 /api/plugins/schemas 提供给 UI 渲染表单 —— 出了插件层无硬编码。
//
// 依赖方向：纯类型，无任何 import，可被 L3 各领域模块与 UI 层引用。
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
