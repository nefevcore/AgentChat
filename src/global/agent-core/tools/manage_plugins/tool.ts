// ============================================================
// manage_plugins 工具 —— 注册/卸载自己的扩展与工具清单
//
// v0.4.0 从 update_agent_profile 拆分：档案 = 身份信息；
// 插件（tools/pre_hooks/post_hooks）= 能力清单，职责分离。
//
// 操作：
//   tools      —— 工具名数组（整体替换，含 read/write/edit/bash 等）
//   pre_hooks  —— 前置扩展名数组
//   post_hooks —— 后置扩展名数组
//   agent_id   —— 目标 Agent（可选，仅 admin 可用，管理其他 Agent 的工具/插件）
// 任一字段缺省 = 保持原样；传 [] = 清空。
// 安全约束：agent_id 由拦截器注入；非 admin 调用方传 agent_id 会被拦截器拒绝。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { getAppState } from '@core/app-state';
import { scanGlobalPlugins } from '@discovery/agent-loader';
import { meta } from './meta';

// 角色层级表（与 agent-loader.ts loadOne 保持一致）
const ROLE_RANK = { user: 1, developer: 2, admin: 3 } as const;
const LEVEL_RANK = { basic: 1, tool: 1, dev: 2, admin: 3 } as const;

/** 读取指定 Agent 的 config.json（不存在返回 null） */
function readAgentConfig(agentsDir: string, agentId: string): Record<string, any> | null {
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) return cfg;
    } catch { /* skip */ }
  }
  return null;
}

/** 解析 Agent 能力标签（tags 优先，否则 role 兼容映射，与 agent-loader 一致） */
function resolveTags(cfg: Record<string, any> | null): string[] {
  if (!cfg) return [];
  if (Array.isArray(cfg.tags) && cfg.tags.length > 0) return cfg.tags as string[];
  const roleToTags: Record<string, string[]> = { user: [], developer: ['dev'], admin: ['admin', 'dev'] };
  return roleToTags[(cfg.role as string) ?? 'user'] ?? [];
}

/**
 * 模拟装配校验：返回被剔除的工具列表（含原因）。
 * 与 agent-loader.ts loadOne 的角色过滤逻辑保持一致。
 */
function checkAssembly(
  configuredTools: string[],
  role: string | undefined,
  toolLevels: Map<string, 'basic' | 'tool' | 'dev' | 'admin'>,
): Array<{ name: string; reason: string }> {
  const rank = ROLE_RANK[role as keyof typeof ROLE_RANK] ?? 1;
  const dropped: Array<{ name: string; reason: string }> = [];
  for (const name of configuredTools) {
    const lv = toolLevels.get(name);
    if (!lv) {
      dropped.push({ name, reason: '未找到该工具（可能已移除或不存在）' });
      continue;
    }
    const needRank = LEVEL_RANK[lv] ?? 1;
    if (needRank > rank) {
      dropped.push({ name, reason: `无权使用 ${lv} 层工具（当前角色 ${role ?? 'user'}，需 ${lv === 'dev' ? 'developer' : 'admin'}）` });
    }
  }
  return dropped;
}

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'manage_plugins',
      description:
        '注册/卸载扩展（pre_hooks/post_hooks）与工具清单（tools）。与 update_agent_profile 分离：档案=身份，插件=能力。省略字段保持不变；传 [] 清空。管理员（admin 标签）可传 agent_id 管理其他 Agent 的工具/插件。',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array', items: { type: 'string' },
            description: '工具名数组（整体替换，如 ["read","write","edit","bash"]）',
          },
          pre_hooks: {
            type: 'array', items: { type: 'string' },
            description: '前置扩展名数组（如 ["agent-prompt","agent-memory"]）',
          },
          post_hooks: {
            type: 'array', items: { type: 'string' },
            description: '后置扩展名数组（如 ["agent-session"]）',
          },
          agent_id: {
            type: 'string',
            description: '目标 Agent ID（可选，仅 admin 可用，管理其他 Agent 的工具/插件）',
          },
        },
      },
    },
  },

  extractLabel: (args: Record<string, any>) => {
    const n = (args.tools?.length ?? 0) + (args.pre_hooks?.length ?? 0) + (args.post_hooks?.length ?? 0);
    return `⚙ 插件更新 (${n} 项)`;
  },

  execute: async (args: Record<string, any>): Promise<string> => {
    const callerId = args.from as string;
    if (!callerId) return '[manage_plugins] 错误：无法确定 Agent ID';

    const agentsDir = getGlobalConfig().agentsDir;

    // 目标 Agent：默认自己；传 agent_id 时需 admin 权限（拦截器已校验）
    const targetId = (args.agent_id as string | undefined) || callerId;

    // 找到目标 config.json
    let configPath: string | null = null;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id === targetId) { configPath = cfgPath; break; }
      } catch { /* skip */ }
    }
    if (!configPath) return `[manage_plugins] 错误：未找到 Agent "${targetId}" 的配置文件。`;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.agent_id !== targetId) {
        return `[manage_plugins] 拒绝：agent_id 不匹配（${config.agent_id} ≠ ${targetId}）。`;
      }

      // 非目标自己时，确认调用方是 admin（拦截器已校验，此处兜底）
      if (targetId !== callerId) {
        const callerCfg = readAgentConfig(agentsDir, callerId);
        const callerTags = resolveTags(callerCfg);
        if (!callerTags.includes('admin')) {
          return `[manage_plugins] 拒绝：仅 admin 可管理其他 Agent 的工具/插件。你（${callerId}）无 admin 权限。`;
        }
      }

      const changes: string[] = [];
      if (args.tools !== undefined) {
        if (!Array.isArray(args.tools) || args.tools.some(t => typeof t !== 'string')) {
          return '[manage_plugins] tools 必须是字符串数组';
        }
        config.tools = args.tools;
        changes.push(`tools=[${args.tools.join(',')}]`);
      }
      if (args.pre_hooks !== undefined) {
        if (!Array.isArray(args.pre_hooks) || args.pre_hooks.some(h => typeof h !== 'string')) {
          return '[manage_plugins] pre_hooks 必须是字符串数组';
        }
        config.pre_hooks = args.pre_hooks;
        changes.push(`pre_hooks=[${args.pre_hooks.join(',')}]`);
      }
      if (args.post_hooks !== undefined) {
        if (!Array.isArray(args.post_hooks) || args.post_hooks.some(h => typeof h !== 'string')) {
          return '[manage_plugins] post_hooks 必须是字符串数组';
        }
        config.post_hooks = args.post_hooks;
        changes.push(`post_hooks=[${args.post_hooks.join(',')}]`);
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      // ---- 装配校验：返回被剔除的工具（角色无权/不存在）----
      let droppedTools: Array<{ name: string; reason: string }> = [];
      try {
        const state = getAppState();
        const srcRoot = state.srcRoot as string | undefined;
        if (srcRoot) {
          const { toolLevels } = scanGlobalPlugins(path.join(srcRoot, 'global'));
          droppedTools = checkAssembly(config.tools ?? [], config.role, toolLevels);
        }
      } catch (err: any) {
        // 校验失败不阻塞保存，仅记录
        console.warn(`[manage_plugins] 装配校验失败: ${err.message}`);
      }

      // 提示生效方式：
      //   · tools 变更 → 调用 reload(self) 立即生效（performReload 重装装配清单）
      //   · 扩展变更 → 需 reload(scope=global) 或重启生效
      const needReload = args.pre_hooks !== undefined || args.post_hooks !== undefined;
      const hint = needReload
        ? '扩展变更需 reload(scope=global) 或重启后生效'
        : '工具变更已保存，调用 reload(self) 立即生效（或下次会话自动生效）';

      return JSON.stringify({
        status: 'ok',
        data: {
          agent_id: callerId,
          updated: changes,
          note: hint,
          ...(droppedTools.length > 0
            ? {
                dropped_tools: droppedTools,
                warning: `${droppedTools.length} 个工具装配失败（角色无权或不存在）：` +
                  droppedTools.map(d => `"${d.name}"（${d.reason}）`).join('；'),
              }
            : {}),
        },
      });
    } catch (err: any) {
      return `[manage_plugins] 更新失败：${err.message}`;
    }
  },
};
