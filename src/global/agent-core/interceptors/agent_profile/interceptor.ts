// ============================================================
// agent_profile 拦截器 —— Agent 档案工具的强制约束
//
// 功能：
//   1. get_agent_profile / update_agent_profile 自动注入调用方 agentId
//   2. update_agent_profile 强制校验：args.agent_id 必须与调用方一致
//   3. 拦截任何可能编辑 Agent 配置目录的危险操作（write/edit/bash）
// ============================================================

import * as path from 'path';
import { ToolInterceptor } from '@core/types';
import { getGlobalConfig } from '@core/config';

// ---- 被拦截的工具名 ----
const PROFILE_TOOLS = new Set(['get_agent_profile', 'update_agent_profile']);

// ---- 可能编辑 Agent 配置的危险工具 ----
const DANGEROUS_TOOLS = new Set(['write', 'edit', 'bash']);

/**
 * 判断路径是否指向 Agent 配置目录（agents/ 下的子目录或文件）。
 * 这包括 agents/ 根目录下的 config.json 以及各 Agent 子目录下的所有文件。
 */
function isAgentConfigPath(targetPath: string): boolean {
  const agentsDir = path.resolve(getGlobalConfig().agentsDir);
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(agentsDir + path.sep) || resolved === agentsDir;
}

/**
 * 检查 bash 命令是否可能操作 Agent 配置目录。
 * 简单检测：命令中是否包含 agents 目录路径
 */
function bashTouchesAgentConfig(command: string): boolean {
  const agentsDir = path.resolve(getGlobalConfig().agentsDir);
  // 标准化路径分隔符
  const normalizedCmd = command.replace(/\\/g, '/');
  const normalizedDir = agentsDir.replace(/\\/g, '/');
  return normalizedCmd.includes(normalizedDir);
}

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  // ---- 1. 档案工具：自动注入 from + 身份校验 ----
  if (PROFILE_TOOLS.has(toolName)) {
    // 自动注入调用方 agentId
    if (!ctx.args.from) {
      ctx.args = { ...ctx.args, from: ctx.agentId };
    }

    // update_agent_profile 额外强制：禁止指定他人的 agent_id
    if (toolName === 'update_agent_profile') {
      if (ctx.args.agent_id && ctx.args.agent_id !== ctx.agentId) {
        return {
          allow: false,
          reason: `严禁编辑其他 Agent 的档案。你只能更新自己的档案（agent_id="${ctx.agentId}"），不能指定 agent_id="${ctx.args.agent_id}"。请移除 agent_id 参数或使用自己的 ID。`,
          args: ctx.args,
        };
      }
      // 强制注入自己的 agent_id，防止 LLM 伪造
      ctx.args = { ...ctx.args, agent_id: ctx.agentId };

      // 校验清单字段格式（防止注入非法数据）
      const fields = ctx.args.fields as Record<string, any> | undefined;
      if (fields) {
        const listFields = ['tools', 'pre_hooks', 'post_hooks'] as const;
        for (const key of listFields) {
          if (key in fields) {
            const val = fields[key];
            if (val !== null && !Array.isArray(val)) {
              return {
                allow: false,
                reason: `${key} 必须是字符串数组，收到的是 ${typeof val}。`,
                args: ctx.args,
              };
            }
            if (Array.isArray(val) && val.some((v: any) => typeof v !== 'string')) {
              return {
                allow: false,
                reason: `${key} 数组包含非字符串元素，所有元素必须是字符串。`,
                args: ctx.args,
              };
            }
          }
        }
      }
    }

    return { allow: true, args: ctx.args };
  }

  // ---- 2. 危险工具：拦截对 Agent 配置目录的写入/编辑 ----
  if (DANGEROUS_TOOLS.has(toolName)) {
    if (toolName === 'bash') {
      const cmd = (ctx.args.command || ctx.args.cmd || '') as string;
      if (bashTouchesAgentConfig(cmd)) {
        return {
          allow: false,
          reason: `检测到 bash 命令可能操作 Agent 配置目录 (${getGlobalConfig().agentsDir})。严禁通过任何手段编辑 Agent 档案。如需查看档案，请使用 get_agent_profile 工具；如需更新自己的档案，请使用 update_agent_profile 工具。`,
          args: ctx.args,
        };
      }
    }

    if (toolName === 'write' || toolName === 'edit') {
      const filePath = (ctx.args.filePath || ctx.args.file_path || ctx.args.path || '') as string;
      if (filePath && isAgentConfigPath(filePath)) {
        return {
          allow: false,
          reason: `严禁编辑 Agent 配置目录下的文件 (${filePath})。Agent 档案只能通过 get_agent_profile 和 update_agent_profile 工具访问。`,
          args: ctx.args,
        };
      }
    }
  }

  return { allow: true, args: ctx.args };
};
