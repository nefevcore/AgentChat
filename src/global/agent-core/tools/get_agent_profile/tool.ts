// ============================================================
// get_agent_profile 工具 —— 获取 Agent 人物档案
//
// 无需 agent_id 参数：调用方由拦截器 agent_profile 自动注入。
// agent_id 可选传入：可查看其他 Agent 的公开档案。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { meta } from './meta';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_agent_profile',
      description:
        '获取指定 Agent 的人物档案（config.json 中的公开信息，包括名称、描述、人物设定等）。不传 agent_id 则默认获取自己的档案。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '目标 Agent 的 ID（可选）。不填则获取调用方自己的档案。',
          },
        },
        required: [],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    let targetId = (args.agent_id as string) || (args.from as string);
    if (!targetId) {
      return '[get_agent_profile] 错误：无法确定目标 Agent ID。';
    }

    const agentsDir = getGlobalConfig().agentsDir;
    if (!fs.existsSync(agentsDir)) {
      return `[get_agent_profile] 错误：Agent 目录不存在 (${agentsDir})`;
    }

    // 遍历查找目标 Agent 的 config.json
    let configPath: string | null = null;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.agent_id === targetId) {
          configPath = cfgPath;
          break;
        }
      } catch { /* skip */ }
    }

    if (!configPath) {
      return `[get_agent_profile] 未找到 Agent "${targetId}" 的配置文件。`;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const profile = JSON.parse(raw);

      // 返回公开档案（排除敏感字段如 api_key）
      const publicProfile: Record<string, any> = {};
      const publicFields = ['agent_id', 'name', 'description', 'avatar', 'tags', 'llm'];
      for (const key of publicFields) {
        if (profile[key] !== undefined) {
          // llm 字段脱敏：移除 api_key
          if (key === 'llm' && typeof profile[key] === 'object') {
            publicProfile[key] = { ...profile[key], api_key: '***' };
          } else {
            publicProfile[key] = profile[key];
          }
        }
      }

      // persona 和 system_prompt 从 AGENT.md / SYSTEM.md 读取（config.json 中已废弃）
      const agentDir = path.dirname(configPath);
      const agentMdPath = path.join(agentDir, 'AGENT.md');
      if (fs.existsSync(agentMdPath)) {
        const agentContent = fs.readFileSync(agentMdPath, 'utf-8');
        const lines = agentContent.split('\n');
        const body = lines.slice(1).join('\n').replace(/^\n+/, '').trim();
        publicProfile.persona = body || '(空)';
      }
      const sysMdPath = path.join(agentDir, 'SYSTEM.md');
      if (fs.existsSync(sysMdPath)) {
        publicProfile.system_prompt = fs.readFileSync(sysMdPath, 'utf-8').trim();
      }

      // 附加提示
      let result = JSON.stringify(publicProfile, null, 2);
      if (targetId === args.from) {
        result = `[你自己的档案]\n\n${result}`;
      } else {
        result = `[Agent "${targetId}" 的公开档案]\n\n${result}`;
      }

      return result;
    } catch (err: any) {
      return `[get_agent_profile] 读取配置失败：${err.message}`;
    }
  },
};
