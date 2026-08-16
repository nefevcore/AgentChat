// ============================================================
// src/plugins/define-tool.ts —— 工具开发工厂（简化工具定义）
//
// LLM 视角工具只有两样：definition（模型看）+ execute（可调用）。
// defineTool 自动补全 definition，工具作者只写「参数 + execute」。
// 工具按功能集中定义（不按工具名分子目录隔离），最终导出 Tool[]。
//
// 依赖方向：仅依赖 src/core 类型（相对导入）。
// ============================================================

import type { Tool } from '@agentchat/agent-loop';
import type { ToolDefinition } from '@agentchat/types';

/** 工具定义输入（defineTool 自动补全 definition） */
export interface DefineToolInput {
  /** 工具名（= definition.function.name，LLM 调用名） */
  name: string;
  /** 显示标签（UI） */
  label: string;
  /** 命名空间（配置读取键，如 "tool.bash" → config["tool.bash"]；可选，仅真实配置点设置） */
  ns?: string;
  /** 能力标签要求（受控词汇表 base/dev/admin/conductor；AND 语义：全部命中才可用；缺省 = 默认关闭，只能 include 显式启用） */
  requires?: string[];
  /** 描述（给 LLM 看） */
  description: string;
  /** JSON Schema 参数 */
  parameters: Record<string, any>;
  /** 执行逻辑 */
  execute: Tool['execute'];
  /** 从参数提取简短标签（可选，UI 用） */
  extractLabel?: (args: Record<string, any>) => string;
}

/** 工具工厂：自动补全 definition */
export function defineTool(input: DefineToolInput): Tool {
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: input.name,
      description: input.description,
      parameters: input.parameters,
    },
  };
  return {
    name: input.name,
    label: input.label,
    ...(input.ns ? { ns: input.ns } : {}),
    ...(input.requires ? { requires: input.requires } : {}),
    description: input.description,
    definition,
    execute: input.execute,
    ...(input.extractLabel ? { extractLabel: input.extractLabel } : {}),
  };
}
