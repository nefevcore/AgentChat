// ============================================================
// ac-extension-core —— 扩展自述契约（A1 注册制目录；纯库零 cordis 依赖）
//
// 行包在**入口模块**导出 `export const extension: ExtensionMeta` 自述
// per-Agent 配置面与事件监听声明；ac-web-api 扫描 cordis registry
// （runtime.callback.extension）聚合为 plugin/extension-catalog /
// events/descriptions——行装载即条目在、卸载即条目失，消灭手维护的
// 静态表（EXTENSION_CATALOG 退役；M25 ctx.on description 监听器自述的
// 同款"声明即注册"模式，2026-08-30 落地）。
//
// 约定：
// - `name` = AgentConfig.settings[具名] 键锚点——稳定公开承诺，改名 = 破
//   用户配置（历史键不带 ac- 前缀，如 persona / timers）；
// - `fields` = 该行实际消费的 settings[name].* 形状（裸 string 为字段名，
//   对象带字段级描述 + 可选 type/enum 形状提示——UI 渲染控件依据）；
//   `enabled` 是约定键（行为门控，插件自查）；
// - `listeners` = 监听器级声明（M25 P2 形状原样迁入）；事件落点 targets
//   由消费方从 listeners[].event 推导，不再手写；
// - 行包 `import type`（devDependencies）即可，运行时零依赖。
// ============================================================

/** 监听器级声明（M25 P2 形状原样迁入） */
export interface ExtensionListenerMeta {
  /** 事件名（preview 目录词汇） */
  event: string;
  /** 该监听器在此事件上做什么（角色注释——执行链渲染） */
  role?: string;
  /** 事件描述（目录·事件视图；未声明的事件不进描述清单） */
  description?: string;
  /** 行为切面（settings[名][facet].enabled ?? enabled） */
  facet?: string;
  /** 该行是否自查 enabled（缺省 false——UI 注明"停用未必生效"） */
  respectsEnabled?: boolean;
}

/**
 * 字段级声明（settings[name].* 的形状提示——配置弹窗按此渲染控件）。
 * 类型提示是**渲染依据**而非运行时约束：行实现仍按自家缺省解析；
 * 与已存值冲突时前端以现值为准兜底（声明只管"未配置时给什么控件"）。
 */
export interface ExtensionFieldMeta {
  name: string;
  description?: string;
  /** 值类型（缺省 string；text = 多行文本；file = 文件路径——弹窗可选） */
  type?: 'string' | 'text' | 'number' | 'boolean' | 'list' | 'json' | 'file';
  /** 枚举候选（string 类型字段可配——渲染下拉而非自由输入） */
  enum?: string[];
  /** 数字字段下界（type: 'number' 时渲染进 input min） */
  min?: number;
  /** 数字字段上界（type: 'number' 时渲染进 input max） */
  max?: number;
  /** 数字字段步进（type: 'number' 时渲染进 input step；占比类常用 0.05） */
  step?: number;
  /**
   * 缺省值（键缺失时行实现的兜底值——UI 常显"缺省 X"并供"恢复缺省"参照）。
   * 渲染提示而非运行时约束：行实现应与同模块常量单源（声明直接引用实现
   * 兜底常量，防两处漂移）。
   */
  default?: unknown;
}

/** 行包扩展自述（入口模块 `export const extension`） */
export interface ExtensionMeta {
  /** AgentConfig.settings 键锚点（稳定承诺；历史键不带 ac- 前缀） */
  name: string;
  /** 人类可读名（卡片主名） */
  label: string;
  /** 一句话说明 */
  description: string;
  /** 基础设施行：装载即生效，per-Agent 不可关 */
  automatic?: boolean;
  /** per-Agent 参数面字段（settings[name].*；形状由本行实现声明） */
  fields?: Array<string | ExtensionFieldMeta>;
  /** 监听器级声明 */
  listeners?: ExtensionListenerMeta[];
}
