// ============================================================
// adjust_llm 工具 —— Agent 调节自身 LLM 强度（运行时热更）
//
// 原理：LLMRequest 已支持 per-request 覆盖（temperature/thinking/maxTokens），
// 本工具直接设置 Agent 的运行时覆盖 _llmOverrides，无需重建 LLM 实例。
// 内存态本轮/会话生效；persist=true 时写入 agents/<id>/config.json llm 覆盖字段。
// ============================================================

import { Tool } from '@core/types';
import { getAppState } from '@core/app-state';
import { getGlobalConfig } from '@core/config';
import { meta } from './meta';

export const tool: Tool = {
  ...meta,
  definition: {
    type: 'function',
    function: {
      name: 'adjust_llm',
      description:
        '调节自身 LLM 参数（温度/深度思考/最大输出），灵活控制推理强度与成本。' +
        '任务难时提升强度（开 thinking、温度 0）；闲聊/简单任务降低强度省 token（关 thinking、温度 0.8）。' +
        'persist=true 时写入配置（重启后仍生效）。只设置传入项，未传的保持不变。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID（自动注入）' },
          temperature: { type: 'number', description: '温度 (0-2)：0 精确稳定，0.8 有创意，1.2+ 发散' },
          thinking: { type: 'boolean', description: '深度思考：true 开启（任务难/需要推理），false 关闭（闲聊/省 token）' },
          maxTokens: { type: 'number', description: '最大输出 token 数' },
          persist: { type: 'boolean', description: '是否写入配置持久化（重启后仍生效），默认 false 仅本次会话生效' },
        },
        required: [],
      },
    },
  },
  extractLabel: (args: Record<string, any>) => {
    const parts: string[] = [];
    if (args.temperature !== undefined) parts.push(`温度=${args.temperature}`);
    if (args.thinking !== undefined) parts.push(`思考=${args.thinking ? '开' : '关'}`);
    if (args.maxTokens !== undefined) parts.push(`max=${args.maxTokens}`);
    return `⚙️ 调节LLM${parts.length ? '：' + parts.join(', ') : ''}`;
  },

  execute: async (args: Record<string, any>): Promise<string> => {
    const agentId = args.agent_id || args.from;
    if (!agentId) return '[adjust_llm] 错误：无法确定 Agent ID';

    // 从 appState 拿 Agent 实例
    const state = getAppState();
    const registry = (state as any).registry as { getAgent?: (id: string) => any } | undefined;
    const agent = registry?.getAgent?.(agentId);
    if (!agent || typeof agent.setLLMOverrides !== 'function') {
      return `[adjust_llm] 错误：Agent "${agentId}" 不存在或不可调节 LLM`;
    }

    // 收集要设置的覆盖项
    const overrides: { temperature?: number; thinking?: boolean; maxTokens?: number } = {};
    if (args.temperature !== undefined) {
      const t = Number(args.temperature);
      if (isNaN(t) || t < 0 || t > 2) return '[adjust_llm] 错误：temperature 需在 0-2 之间';
      overrides.temperature = t;
    }
    if (args.thinking !== undefined) overrides.thinking = !!args.thinking;
    if (args.maxTokens !== undefined) {
      const m = Number(args.maxTokens);
      if (isNaN(m) || m <= 0) return '[adjust_llm] 错误：maxTokens 需为正整数';
      overrides.maxTokens = Math.floor(m);
    }

    if (Object.keys(overrides).length === 0) {
      // 未传任何参数：返回当前生效值
      const cur = agent.getLLMOverrides?.() ?? {};
      return `[adjust_llm] 当前 LLM 覆盖：${JSON.stringify(cur)}（未设置项使用配置默认）`;
    }

    agent.setLLMOverrides(overrides);

    // 可选持久化：写入 agents/<id>/config.json 的 llm 覆盖字段
    if (args.persist) {
      try {
        const path = require('path') as typeof import('path');
        const fs = require('fs') as typeof import('fs');
        const agentsDir = getGlobalConfig().agentsDir;
        // 遍历 agents 目录找 agent_id 匹配的 config.json
        for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const cfgPath = path.join(agentsDir, dir.name, 'config.json');
          if (!fs.existsSync(cfgPath)) continue;
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (cfg.agent_id !== agentId) continue;
          cfg.llm = cfg.llm || {};
          if (overrides.temperature !== undefined) cfg.llm.temperature = overrides.temperature;
          if (overrides.thinking !== undefined) cfg.llm.thinking = overrides.thinking;
          if (overrides.maxTokens !== undefined) cfg.llm.maxTokens = overrides.maxTokens;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
          break;
        }
      } catch (err: any) {
        return `[adjust_llm] 已生效（本次会话），但持久化失败: ${err.message}`;
      }
    }

    const cur = agent.getLLMOverrides?.() ?? {};
    const applied = Object.keys(overrides).map(k => `${k}=${overrides[k as keyof typeof overrides]}`).join(', ');
    return `[adjust_llm] ✅ 已${args.persist ? '持久化' : '生效（本次会话）'}: ${applied}。当前覆盖：${JSON.stringify(cur)}`;
  },
};
