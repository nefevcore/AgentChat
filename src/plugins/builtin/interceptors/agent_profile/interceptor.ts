// ============================================================
// agent_profile 拦截器 —— Agent 档案工具的强制约束
//
// 功能：
//   1. get_agent_profile / update_agent_profile 自动注入调用方 agentId
//   2. update_agent_profile 强制校验：
//      · 非 admin：只能更新自己的档案（agent_id 强制为自己的 ID）
//      · admin：可指定 agent_id 更新其他 Agent 的档案（v0.4.4+，与 manage_plugins 对齐）
//   3. 拦截任何可能编辑 Agent 配置目录的危险操作（write/edit/bash）
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { ToolInterceptor } from '@core/types';
import { getGlobalConfig } from '@agents/config';

// ---- 被拦截的工具名 ----
const PROFILE_TOOLS = new Set(['read_agent_info', 'update_agent_profile']);

// ---- 可能编辑 Agent 配置的危险工具 ----
const DANGEROUS_TOOLS = new Set(['write', 'edit', 'bash']);

/**
 * 判断路径是否指向 Agent 配置目录（agents/ 下的子目录或文件）。
 * 这包括 agents/ 根目录下的 config.json 以及各 Agent 子目录下的所有文件。
 *
 * 例外：当前 Agent 自己的 tools/ 目录放行 —— 系统支持 Agent 自举开发工具
 * （meta.ts/tool.ts 热加载），tools/ 是工具源码而非档案。
 */
function isAgentConfigPath(targetPath: string, selfAgentId?: string): boolean {
  const agentsDir = path.resolve(getGlobalConfig().agentsDir);
  const resolved = path.resolve(targetPath);
  if (selfAgentId) {
    const selfToolsDir = path.join(agentsDir, selfAgentId, 'tools');
    if (resolved.startsWith(selfToolsDir + path.sep)) return false;
  }
  return resolved.startsWith(agentsDir + path.sep) || resolved === agentsDir;
}

/**
 * 提取 write/edit 的全部目标路径：
 *  - 顶层 filePath / file_path / path
 *  - edits[] 数组中每个条目的 filePath（JSON 旧格式）
 *  - input DSL 字符串中的 [path#TAG]（Hashline 新格式）
 *
 * 必须全部检查，否则可绕过拦截（如只查顶层 filePath 而实际目标在 edits 内）。
 */
function extractTargetPaths(args: Record<string, any>): string[] {
  const result: string[] = [];
  for (const k of ['filePath', 'file_path', 'path']) {
    if (typeof args[k] === 'string' && args[k].length > 0) result.push(args[k]);
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      if (e && typeof e.filePath === 'string' && e.filePath.length > 0) result.push(e.filePath);
    }
  }
  if (typeof args.input === 'string') {
    const m = args.input.match(/^\[([^#\]]+)/m);
    if (m) result.push(m[1]);
  }
  return result;
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

/**
 * 解析调用方 Agent 的能力标签（tags 驱动；v0.4.6 移除 role 兼容映射）。
 * 用于 manage_plugins / update_agent_profile 的 admin 权限判断（拦截器层）。
 */
function resolveCallerTags(agentId: string): string[] {
  try {
    const agentsDir = path.resolve(getGlobalConfig().agentsDir);
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) {
        return Array.isArray(cfg.tags) ? (cfg.tags as string[]) : [];
      }
    }
  } catch { /* 解析失败视为无权限 */ }
  return [];
}

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  // ---- 1. 档案工具：自动注入 from + 身份校验 ----
  if (PROFILE_TOOLS.has(toolName)) {
    // 自动注入调用方 agentId
    if (!ctx.args.from) {
      ctx.args = { ...ctx.args, from: ctx.agentId };
    }

    // update_agent_profile 权限校验：非 admin 禁止指定他人；admin 可管理他人档案
    if (toolName === 'update_agent_profile') {
      const target = ctx.args.agent_id;
      if (target && target !== ctx.agentId) {
        // 指定了其他 Agent：需 admin 权限
        const callerTags = resolveCallerTags(ctx.agentId);
        if (!callerTags.includes('admin')) {
          return {
            allow: false,
            reason: `仅管理员（admin 标签）可更新其他 Agent 的档案。你（${ctx.agentId}）无 admin 权限，只能更新自己的档案（不传 agent_id）。`,
            args: ctx.args,
          };
        }
      } else {
        // 未指定或指定自己：强制注入自己的 agent_id，防止 LLM 伪造
        ctx.args = { ...ctx.args, agent_id: ctx.agentId };
      }

      // 校验清单字段格式（防止注入非法数据）
      const fields = ctx.args.fields as Record<string, any> | undefined;
      if (fields) {
        const listFields = ['tools', 'pre_hooks', 'post_hooks', 'tags'] as const;
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

        // 非 admin 禁止给自己打 admin 标签（拦截器层强制，工具层兜底）
        if (Array.isArray(fields.tags) && fields.tags.includes('admin')) {
          const callerTags = resolveCallerTags(ctx.agentId);
          if (!callerTags.includes('admin')) {
            return {
              allow: false,
              reason: `非管理员不能给自己打 admin 标签（防提权）。如需管理员权限请联系管理员。`,
              args: ctx.args,
            };
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
          reason: `检测到 bash 命令可能操作 Agent 配置目录 (${getGlobalConfig().agentsDir})。严禁通过任何手段编辑 Agent 档案。如需查看档案，请使用 read_agent_info 工具；如需更新自己的档案，请使用 update_agent_profile 工具。`,
          args: ctx.args,
        };
      }
    }

    if (toolName === 'write' || toolName === 'edit') {
      // 提取全部目标路径（顶层 + edits[] + input DSL），逐一检查
      const targets = extractTargetPaths(ctx.args);
      const blocked = targets.find(fp => isAgentConfigPath(fp, ctx.agentId));
      if (blocked) {
        return {
          allow: false,
          reason: `严禁编辑 Agent 配置目录下的文件 (${blocked})。Agent 档案只能通过 read_agent_info 和 update_agent_profile 工具访问；如需开发自己的工具请写入 ${path.join(getGlobalConfig().agentsDir, ctx.agentId, 'tools')} 目录。`,
          args: ctx.args,
        };
      }
    }
  }

  return { allow: true, args: ctx.args };
};
