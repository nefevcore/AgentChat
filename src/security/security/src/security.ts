// ============================================================
// src/plugins/builtin/hooks/security.ts —— 安全拦截钩子（照搬旧 agent_profile 拦截器）
//
// 旧拦截器职责转 toolExecutionStartHook（L1 可拦截 allow=false / 改写 args）：
//   · update_agent_profile 权限校验：非 admin 禁改他人 / 禁打 admin 标签
//   · write/edit/bash 危险路径拦截：禁止编辑 Agent 配置目录
//   · 身份注入（from）已由工具工厂烘焙（config.agent_id），不再需要
//   · 清单字段校验（2026-08-07）：旧 tools/pre_hooks/post_hooks 统一由 plugins（对象数组）声明，
//     tags 仍为字符串数组（能力标签）
//
// 依赖方向：仅依赖 src/core + 本层 shared + Node 内置。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { ToolExecutionStartHook } from '@agentchat/contracts';
import type { ToolExecutionStartResult } from '@agentchat/contracts';
import { workspaceRoot } from '@agentchat/toolkit';

/** 被拦截的工具名 */
const PROFILE_TOOLS = new Set(['read_agent_info', 'update_agent_profile']);

/** 可能编辑 Agent 配置的危险工具 */
const DANGEROUS_TOOLS = new Set(['write', 'edit', 'bash']);

/** 判断路径是否指向 Agent 配置目录（agents/ 下的子目录或文件）；当前 Agent 的 tools/ 放行 */
function isAgentConfigPath(targetPath: string, agentsDir: string, selfAgentId?: string): boolean {
  const resolved = path.resolve(targetPath);
  if (selfAgentId) {
    const selfToolsDir = path.join(agentsDir, selfAgentId, 'tools');
    if (resolved.startsWith(selfToolsDir + path.sep)) return false;
  }
  return resolved.startsWith(agentsDir + path.sep) || resolved === agentsDir;
}

/** 提取 write/edit 的全部目标路径（顶层 + edits[] + input DSL） */
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

/** 检查 bash 命令是否可能操作 Agent 配置目录 */
function bashTouchesAgentConfig(command: string, agentsDir: string): boolean {
  const normalizedCmd = command.replace(/\\/g, '/');
  const normalizedDir = agentsDir.replace(/\\/g, '/');
  return normalizedCmd.includes(normalizedDir);
}

/** 解析调用方 Agent 的能力标签（tags 驱动；读 agents 目录 config.json） */
function resolveCallerTags(agentId: string, agentsDir: string): string[] {
  try {
    if (!agentsDir || !fs.existsSync(agentsDir)) return [];
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

/**
 * 工具执行前安全钩子（承接旧 agent_profile 拦截器）。
 * 创建时经 PluginServices 注入 agentsDir 与 selfId。
 */
export function makeSecurityStartHook(agentsDir: string, selfId: string): ToolExecutionStartHook {
  return async (toolName: string, args: Record<string, any>): Promise<ToolExecutionStartResult> => {
    const dir = agentsDir || path.join(workspaceRoot(), 'agents');

    // ---- 1. 档案工具：身份校验 ----
    if (PROFILE_TOOLS.has(toolName)) {
      // update_agent_profile 权限校验：非 admin 禁止指定他人；admin 可管理他人
      if (toolName === 'update_agent_profile') {
        const target = args.agent_id;
        if (target && target !== selfId) {
          const callerTags = resolveCallerTags(selfId, dir);
          if (!callerTags.includes('admin')) {
            return {
              allow: false,
              reason: `仅管理员（admin 标签）可更新其他 Agent 的档案。你（${selfId}）无 admin 权限，只能更新自己的档案（不传 agent_id）。`,
              args,
            };
          }
        }

        // 校验清单字段格式（防止注入非法数据）
        const fields = args.fields as Record<string, any> | undefined;
        if (fields) {
          // 新契约：tags/presets 为字符串数组；tools 为 { include/exclude } 意图覆盖
          // （旧 string[] 显式清单仍接受为兼容输入）；hooks 为七类启用清单；
          // plugins（旧契约对象数组）保留兼容输入。
          const stringListFields = ['tags', 'presets'] as const;
          const objectListFields = ['plugins'] as const;
          for (const key of stringListFields) {
            if (key in fields) {
              const val = fields[key];
              if (val !== null && !Array.isArray(val)) {
                return { allow: false, reason: `${key} 必须是字符串数组，收到的是 ${typeof val}。`, args };
              }
              if (Array.isArray(val) && val.some((v: any) => typeof v !== 'string')) {
                return { allow: false, reason: `${key} 数组包含非字符串元素，所有元素必须是字符串。`, args };
              }
            }
          }
          for (const key of objectListFields) {
            if (key in fields) {
              const val = fields[key];
              if (val !== null && !Array.isArray(val)) {
                return { allow: false, reason: `${key} 必须是对象数组，收到的是 ${typeof val}。`, args };
              }
              if (Array.isArray(val) && val.some((v: any) => typeof v !== 'object' || v === null)) {
                return { allow: false, reason: `${key} 数组包含非对象元素，所有元素必须是对象。`, args };
              }
            }
          }
          if (fields.tools !== undefined) {
            const tools = fields.tools;
            if (tools === null) {
              return { allow: false, reason: `tools 必须是 { include?: string[], exclude?: string[] } 对象（旧 string[] 亦兼容），收到的是 null。`, args };
            }
            if (Array.isArray(tools)) {
              if (tools.some((v: any) => typeof v !== 'string')) {
                return { allow: false, reason: `tools 数组包含非字符串元素，所有元素必须是字符串。`, args };
              }
            } else if (typeof tools === 'object') {
              for (const side of ['include', 'exclude'] as const) {
                const list = (tools as Record<string, unknown>)[side];
                if (list !== undefined && (!Array.isArray(list) || list.some((v: any) => typeof v !== 'string'))) {
                  return { allow: false, reason: `tools.${side} 必须是字符串数组。`, args };
                }
              }
            } else {
              return { allow: false, reason: `tools 必须是 { include?: string[], exclude?: string[] } 对象（旧 string[] 亦兼容），收到的是 ${typeof tools}。`, args };
            }
          }
          if (fields.hooks !== undefined) {
            const hooks = fields.hooks;
            if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
              return { allow: false, reason: `hooks 必须是对象（七类钩子启用清单），收到的是 ${typeof hooks}。`, args };
            }
            for (const kind of ['runStart', 'runEnd', 'stepStart', 'stepEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const) {
              const list = (hooks as Record<string, unknown>)[kind];
              if (list === undefined || list === null) continue;
              if (!Array.isArray(list) || list.some((v: any) => typeof v !== 'string')) {
                return { allow: false, reason: `hooks.${kind} 必须是字符串数组（钩子启用清单）。`, args };
              }
            }
          }

          // 非 admin 禁止给自己打 admin 标签（防提权）
          if (Array.isArray(fields.tags) && fields.tags.includes('admin')) {
            const callerTags = resolveCallerTags(selfId, dir);
            if (!callerTags.includes('admin')) {
              return {
                allow: false,
                reason: `非管理员不能给自己打 admin 标签（防提权）。如需管理员权限请联系管理员。`,
                args,
              };
            }
          }
        }
      }

      return { allow: true, args };
    }

    // ---- 2. 危险工具：拦截对 Agent 配置目录的写入/编辑 ----
    if (DANGEROUS_TOOLS.has(toolName)) {
      if (toolName === 'bash') {
        const cmd = (args.command || args.cmd || '') as string;
        if (bashTouchesAgentConfig(cmd, dir)) {
          return {
            allow: false,
            reason: `检测到 bash 命令可能操作 Agent 配置目录 (${dir})。严禁通过任何手段编辑 Agent 档案。如需查看档案，请使用 read_agent_info 工具；如需更新自己的档案，请使用 update_agent_profile 工具。`,
            args,
          };
        }
      }

      if (toolName === 'write' || toolName === 'edit') {
        const targets = extractTargetPaths(args);
        const blocked = targets.find(fp => isAgentConfigPath(fp, dir, selfId));
        if (blocked) {
          return {
            allow: false,
            reason: `严禁编辑 Agent 配置目录下的文件 (${blocked})。Agent 档案只能通过 read_agent_info 和 update_agent_profile 工具访问；如需开发自己的工具请写入 ${path.join(dir, selfId, 'tools')} 目录。`,
            args,
          };
        }
      }
    }

    return { allow: true, args };
  };
}
