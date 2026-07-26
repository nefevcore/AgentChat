// ============================================================
// update_agent_profile 工具 —— 更新自己的 Agent 人物档案
//
// 安全约束：
//   1. agent_id 由拦截器 agent_profile 自动注入，LLM 无法伪造
//   2. 仅允许更新自己的档案（args.from === config.agent_id）
//   3. 禁止修改 agent_id 字段
//   4. 可更新的字段：name, description, persona, system_prompt, avatar, tags
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { meta } from './meta';

// ---- 允许更新的字段 ----

const ALLOWED_FIELDS = new Set([
  'name',
  'description',
  'persona',
  'system_prompt',
  'avatar',
  'tags',
  // 插件与工具清单（用于 AgentChat 自我更新）
  'tools',
  'pre_hooks',
  'post_hooks',
]);

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_agent_profile',
      description:
        '更新自己的 Agent 人物档案。可以修改名称、描述、人物设定、系统提示词、头像、标签，以及插件/工具清单（tools、pre_hooks、post_hooks）。严禁修改其他 Agent 的档案。agent_id 由系统自动注入，无需（也禁止）手动传入。',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description: '要更新的字段键值对。支持：name, description, persona, system_prompt, avatar, tags, tools, pre_hooks, post_hooks。agent_id 不能通过此工具修改。',
            properties: {
              name: { type: 'string', description: 'Agent 的昵称/显示名称' },
              description: { type: 'string', description: 'Agent 的简短描述' },
              persona: { type: 'string', description: 'Agent 的人物设定/性格描述' },
              system_prompt: { type: 'string', description: 'Agent 的系统提示词' },
              avatar: { type: 'string', description: 'Agent 的头像 URL' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Agent 的标签列表' },
              tools: { type: 'array', items: { type: 'string' }, description: '启用的工具名称列表（如 ["read","write","bash","web_search"]）。清空数组可禁用所有工具。' },
              pre_hooks: { type: 'array', items: { type: 'string' }, description: '启用的前置钩子名称列表（如 ["agent-prompt","agent-memory"]）' },
              post_hooks: { type: 'array', items: { type: 'string' }, description: '启用的后置钩子名称列表（如 ["agent-memory","agent-session"]）' },
            },
          },
        },
        required: ['fields'],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const callerId = args.from as string;
    if (!callerId) {
      return '[update_agent_profile] 错误：无法确定调用方 Agent ID（缺少 from 字段）。';
    }

    const fields = args.fields as Record<string, any> | undefined;
    if (!fields || Object.keys(fields).length === 0) {
      return '[update_agent_profile] 错误：fields 参数不能为空。';
    }

    // 检查是否有不允许的字段
    const invalidFields = Object.keys(fields).filter(f => !ALLOWED_FIELDS.has(f));
    if (invalidFields.length > 0) {
      return `[update_agent_profile] 错误：不允许修改以下字段：${invalidFields.join(', ')}。只能修改：${[...ALLOWED_FIELDS].join(', ')}。`;
    }

    const agentsDir = getGlobalConfig().agentsDir;
    if (!fs.existsSync(agentsDir)) {
      return `[update_agent_profile] 错误：Agent 目录不存在 (${agentsDir})`;
    }

    // 查找自己的 config.json
    let configPath: string | null = null;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id === callerId) {
          configPath = cfgPath;
          break;
        }
      } catch { /* skip */ }
    }

    if (!configPath) {
      return `[update_agent_profile] 错误：未找到 Agent "${callerId}" 的配置文件。`;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);

      // 安全校验：确保是更新自己的档案
      if (config.agent_id !== callerId) {
        return `[update_agent_profile] 拒绝：agent_id 不匹配。配置文件中为 "${config.agent_id}"，但调用方为 "${callerId}"。你只能更新自己的档案。`;
      }

      // 合并更新
      const updated = { ...config };
      const changed: string[] = [];
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const oldVal = JSON.stringify(config[key]);
        const newVal = JSON.stringify(value);
        if (oldVal !== newVal) {
          changed.push(key);
        }
        updated[key] = value;
      }

      if (changed.length === 0) {
        return '[update_agent_profile] 没有字段发生变化，档案无需更新。';
      }

      // 写入文件
      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

      return `[update_agent_profile] 成功更新了自己的档案。已修改字段：${changed.join(', ')}。`;
    } catch (err: any) {
      return `[update_agent_profile] 更新失败：${err.message}`;
    }
  },
};
