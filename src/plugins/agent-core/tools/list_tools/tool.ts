// ============================================================
// list_tags 工具 —— 列出 tag → 工具映射，帮 Agent 决定要打什么 tag
//
// 背景（v0.4.10）：工具定义已注入 LLM 提示词（list_tools 的"工具自查"
// 意义不大）。改为展示 tag 体系——Agent 看到"哪些 tag 对应哪些工具"，
// 想要某工具就知道该打什么 tag（用 update_agent_profile 更新 tags）。
//
// 返回：
//   · my_tags        —— 当前 Agent 的 tags
//   · tag_tools      —— tag → [工具] 映射
//   · enabled        —— 当前实际可用的工具（按 tags 注入）
//   · missing        —— 当前未获得但可申请的工具（缺哪个 tag）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import type { AgentRegistry } from '@routing/registry';
import type { Agent } from '@core/agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'list_tags',
      description:
        '列出 tag → 工具映射，方便判断要打什么标签获得对应工具。返回当前 tags、各 tag 对应的工具集、当前可用工具、以及"缺哪个 tag 才能获得某工具"的提示。工具按 requires 匹配 tags 自动注入，想用某工具就用 update_agent_profile 给自己加对应 tag（admin 标签需管理员）。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  extractLabel: () => '🏷️ 标签清单',

  execute: async (args: Record<string, any>) => {
    try {
      const state = getAppState();
      const registry = state.registry as AgentRegistry;
      if (!registry) {
        return JSON.stringify({ status: 'error', data: { message: 'registry 未就绪' } });
      }

      const selfId = args.from as string;
      const self = selfId ? (registry.getAgent(selfId) as Agent | undefined) : undefined;
      const enabledTools = self?.getTools?.() ? [...self.getTools().keys()] : [];
      const myTags = (self?.config?.tags as string[] | undefined) ?? [];

      // 从 PluginLoader.getAllPlugins 拿全部工具 + requires（v0.5.0：插件元数据已移至 pluginLoader）
      let pluginMetas: Array<{ name: string; requires?: string[] }> = [];
      const pluginLoader = state.pluginLoader as any;
      if (pluginLoader?.getAllPlugins) {
        try {
          pluginMetas = (pluginLoader.getAllPlugins() as Array<{ type?: string; name: string; requires?: string[] }>)
            .filter(p => p.type === 'tool');
        } catch { /* fallthrough */ }
      }

      // 构建 tag → tools 映射（工具可能 requires 多 tag，如 ["sap","dev"]）
      const tagTools = new Map<string, string[]>();
      const toolRequires = new Map<string, string[]>();
      for (const p of pluginMetas) {
        const reqs = p.requires?.length ? p.requires : undefined;
        if (reqs) {
          toolRequires.set(p.name, reqs);
          for (const tag of reqs) {
            if (!tagTools.has(tag)) tagTools.set(tag, []);
            tagTools.get(tag)!.push(p.name);
          }
        }
      }

      // 缺失提示：全局工具中当前未启用，且因缺 tag 而不可得
      const missing: Array<{ name: string; needTags: string[]; lacking: string[] }> = [];
      const enabledSet = new Set(enabledTools);
      for (const p of pluginMetas) {
        if (enabledSet.has(p.name)) continue;
        const reqs = toolRequires.get(p.name);
        if (!reqs?.length) continue;
        const lacking = reqs.filter(t => !myTags.includes(t));
        if (lacking.length > 0) {
          missing.push({ name: p.name, needTags: reqs, lacking });
        }
      }

      return JSON.stringify({
        status: 'ok',
        data: {
          self_id: selfId,
          my_tags: myTags,
          tag_tools: Object.fromEntries(
            [...tagTools.entries()].map(([tag, tools]) => [tag, tools.sort()]).sort()
          ),
          enabled_tools: enabledTools.sort(),
          missing_tools: missing.sort((a, b) => a.name.localeCompare(b.name)),
          note: '工具按 requires 匹配 tags 自动注入。想要某工具 → 用 update_agent_profile 给自己加对应 tag（非管理员不能加 admin）。',
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
