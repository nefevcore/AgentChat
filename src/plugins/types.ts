// ============================================================
// 插件契约类型（v0.5.0 架构修正：插件自有契约从 discovery/config-types 迁入）
//
// 职责：插件清单声明（plugin.json）与加载元数据的类型契约。
//   · PluginMeta       —— 加载后元数据（跨端共享，来自 @shared/types）
//   · PluginManifest   —— plugin.json 容器声明（白名单模式）
//   · PluginEntry      —— manifest 条目声明
//   · HasConfig        —— meta.ts 提取配置信息的形状
//
// 依赖：只依赖 @core/types 类型（ConfigField）与 @shared/types（PluginMeta）。
// 分层：plugins 是 hook/工具/服务实现层，依赖核心接口类型是允许方向。
// ============================================================

import type { ConfigField } from '@core/types';

/**
 * 插件元数据（加载后，跨端共享）—— 单一来源在 @shared/types。
 * getAllPlugins() / getAgentPlugins() 返回此形状（getAgentPlugins 附加 enabled）。
 */
export type { PluginMeta } from '@shared/types';

/**
 * PluginManifest —— 插件打包容器（纯容器类型，不合并 Extension/Tool 类型）。
 *
 * 每个插件在 plugins/<plugin-name>/ 下放置 plugin.json。
 * plugin.json 显式声明要加载的扩展/工具/拦截器白名单，
 * 只加载列表中声明的条目，不在列表中的即使文件存在也会被忽略。
 */
export interface PluginManifest {
  /** 插件唯一名称 */
  name: string;
  /** 版本号 */
  version?: string;
  /** 显示标签 */
  label?: string;
  /** 描述 */
  description?: string;
  /** 要加载的扩展列表（白名单，为空则不加载任何扩展） */
  extensions?: PluginEntry[];
  /** 要加载的工具列表（白名单，为空则不加载任何工具） */
  tools?: PluginEntry[];
  /** 要加载的拦截器列表（白名单，为空则不加载任何拦截器） */
  interceptors?: PluginEntry[];
}

/** 插件条目声明 */
export interface PluginEntry {
  /** 条目名称（对应子目录名） */
  name: string;
  /**
   * 工具层级（兼容旧字段）：
   *   - "basic": 基础工具（autoInject 给所有 Agent）
   *   - "tool": 工具层（按需配置）
   *   - "dev": 开发工具（仅含 dev 标签 Agent 可配置）
   *   - "admin": 管理工具（仅含 admin 标签 Agent，不可被发现）
   * 推荐用 requires 声明精确标签要求。
   */
  level?: 'basic' | 'tool' | 'dev' | 'admin';
  /**
   * 能力标签要求（推荐，替代 level）：AND 语义——Agent 需包含全部 requires 标签才可用。
   * 如 ["dev"]=开发工具、["admin"]=管理工具、["sap","dev"]=SAP 开发专用。
   * requires 优先于 level；未配置时由 level 映射。
   */
  requires?: string[];
  /**
   * 是否自动注入到所有 Agent（无需在 config.json 中配置）。
   * 适用于内置多 Agent 协作工具（如 list_agents、send_agent 等）。
   */
  autoInject?: boolean;
  /**
   * 是否隐藏（不参与 list_tools 发现流程）。
   * 隐藏条目仍可被加载（config.tools 显式配置），但不在工具池/发现结果中展示。
   * 默认 false（v0.4.4+：admin 层工具不再自动 hidden，参与发现但按 requires 过滤）。
   */
  hidden?: boolean;
  /**
   * 条目子目录路径（相对于 plugin.json 所在目录）。
   * 省略时默认使用 {type}s/{name} 路径（如 tools/bash、extensions/agent-session）。
   */
  path?: string;
}

/** loader 提取配置信息用 */
export interface HasConfig {
  ns: string;
  label: string;
  description?: string;
  configuration?: ConfigField[];
}
