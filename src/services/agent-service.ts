// ============================================================
// AgentService —— Agent 管理服务（v0.5.0 P3）
//
// 收回 webui/api/agents.ts 重复实现的核心逻辑：
//   创建 LLM / 保存配置（含凭据剥离）/ 热重载 / 差异配置计算
// webui / TUI / Desktop 统一通过此服务管理 Agent。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { OpenAIChatLLM } from '@llm/openai';
import { DeepSeekChatLLM } from '@llm/deepseek';
import type { AgentRegistry } from '@routing/registry';
import type { AgentLoader } from '@discovery/agent-loader';
import { Agent } from '@core/agent';
import { getGlobalConfig } from '@core/config';
import type { AgentRouter } from '@routing/router';
import { getCredential, setCredential } from '@infra/credential-store';
import { computeDiff, deepMerge } from '@core/config-diff';
import { logger } from '@utils/logger';
import type { LLMConfig } from '@discovery/config-types';
import type { AgentInfo } from '@shared/types';
import { timerManager } from '@core/timer';
import type { TimerEntry } from '@core/types';

export type { TimerEntry };

/** 全局专属字段，不能写入 Agent 差异配置 */
const GLOBAL_ONLY_KEYS = [
  'llmProviders', 'searchProviders', 'workspaceDir', 'agentsDir',
  'sessionsDir', 'groupsDir', 'maxHops', 'messageQueryDefaultLimit',
];

export class AgentService {
  constructor(
    private registry: AgentRegistry,
    private loader?: AgentLoader,
  ) {}

  /** 构建全局配置基线（Agent 差异配置计算用）：排除 $ 内部字段，展平 namespaces */
  buildGlobalBase(): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    const raw = getGlobalConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!key.startsWith('$') && key !== 'namespaces') base[key] = raw[key];
    }
    const ns = raw.namespaces as Record<string, Record<string, unknown>> | undefined;
    if (ns) for (const [k, v] of Object.entries(ns)) base[k] = v;
    return base;
  }

  /** 创建 LLM 实例（从凭据存储注入 api_key） */
  createLLM(agentId: string, llmCfg: LLMConfig): DeepSeekChatLLM | OpenAIChatLLM {
    llmCfg = { ...llmCfg };
    llmCfg.api_key = getCredential(agentId, llmCfg.provider ?? '')
      || getCredential('__global__', llmCfg.provider ?? '') || llmCfg.api_key || '';
    const b = { apiKey: llmCfg.api_key, baseURL: llmCfg.base_url, model: llmCfg.model,
      temperature: llmCfg.temperature, maxTokens: llmCfg.max_tokens, topP: llmCfg.top_p,
      responseFormat: llmCfg.response_format, stop: llmCfg.stop };
    if (llmCfg.provider === 'deepseek') {
      return new DeepSeekChatLLM({ ...b, reasoningEffort: llmCfg.reasoning_effort as any,
        thinking: llmCfg.thinking, logprobs: llmCfg.logprobs, topLogprobs: llmCfg.top_logprobs,
        toolChoice: llmCfg.tool_choice });
    }
    return new OpenAIChatLLM(b);
  }

  /** 写入 Agent 差异配置（剥离密钥到凭据存储、计算 diff） */
  saveAgentConfig(agentId: string, agentDir: string, config: Record<string, unknown>): void {
    const configPath = path.join(agentDir, 'config.json');
    const oldProvider: string | undefined = (() => {
      try { return (JSON.parse(fs.readFileSync(configPath, 'utf-8')).llm as any)?.provider; } catch { return undefined; }
    })();

    const llm = config.llm as Record<string, unknown> | undefined;
    if (llm?.api_key !== undefined) {
      setCredential(agentId, (llm.provider as string) || 'deepseek', llm.api_key as string);
      delete llm.api_key;
    }
    if (!llm && oldProvider) setCredential(agentId, oldProvider, '');

    for (const key of GLOBAL_ONLY_KEYS) delete config[key];
    config.agent_id = agentId;
    const diff = computeDiff(config, this.buildGlobalBase());
    fs.writeFileSync(configPath, JSON.stringify(diff, null, 2) + '\n', 'utf-8');
    logger.info(`[AgentService] Agent "${agentId}" 差异配置已保存 (${Object.keys(diff).length} 项)`);
  }

  /** 写入 Markdown 文件（空内容则删除） */
  writeMDFile(agentDir: string, filename: string, content: string): void {
    const filePath = path.join(agentDir, filename);
    if (content.trim()) { fs.writeFileSync(filePath, content, 'utf-8'); }
    else if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
  }

  /** 热重载 Agent：重新加载配置/工具/扩展/LLM */
  hotReloadAgent(agentId: string, agentDir: string): void {
    if (!this.loader) return;
    const agent = this.registry.getAgent(agentId);
    if (!agent) return;
    if (this.registry.isVirtual(agentId)) {
      (agent as any).config = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf-8'));
      return;
    }
    const loaded = this.loader.loadOne(agentDir);
    (agent as any).reload(loaded);

    let llmCfg = loaded.llmConfig;
    if (!llmCfg) {
      const gCfg = getGlobalConfig() as any;
      if (gCfg.llm?.provider) llmCfg = { ...gCfg.llm } as LLMConfig;
    }
    if (llmCfg) (agent as any).setLLM(this.createLLM(agentId, llmCfg));
    logger.info(`[AgentService] Agent "${agentId}" 已热重载`);
  }

  /**
   * 热加载新 Agent 到运行时（对齐 bootstrap 流程）：
   * 创建 Agent 实例 + LLM（凭据注入）+ 工具/拦截器/hooks + 注册到 registry。
   * @returns 是否成功（LLM 缺失时抛错由调用方处理）
   */
  createAgentRuntime(agentDir: string, agentRouter?: AgentRouter): void {
    if (!this.loader || !agentRouter) return;
    const loaded = this.loader.loadOne(agentDir);
    const agent = new Agent(loaded.config);
    agent.setEventBus(agentRouter);

    // LLM 配置：优先 Agent 自身，回退全局
    if (!loaded.llmConfig) {
      const gCfg = getGlobalConfig() as any;
      if (gCfg.llm?.provider) {
        loaded.llmConfig = { ...gCfg.llm } as LLMConfig;
        logger.info(`[AgentService] Agent "${loaded.config.agent_id}" 使用全局 LLM 配置: ${loaded.llmConfig.provider}`);
      }
    }
    if (!loaded.llmConfig) {
      throw new Error(`Agent "${loaded.config.agent_id}" 缺少 llm 配置，且全局配置中也没有默认值。`);
    }
    loaded.llmConfig.api_key = getCredential(loaded.config.agent_id, loaded.llmConfig.provider ?? '')
      || getCredential('__global__', loaded.llmConfig.provider ?? '')
      || loaded.llmConfig.api_key;

    agent.setLLM(this.createLLM(loaded.config.agent_id, loaded.llmConfig));

    // 注册工具/拦截器/hooks
    if (loaded.tools.length > 0) agent.registerTools(loaded.tools);
    for (const interceptor of loaded.interceptors) agent.useToolInterceptor(interceptor);
    for (const hook of loaded.preHooks) agent.usePreHook(hook);
    for (const hook of loaded.postHooks) agent.usePostHook(hook);

    this.registry.register(loaded.config.agent_id, agent);
    logger.info(`[AgentService] Agent "${loaded.config.agent_id}" 已热加载到运行时`);
  }

  /**
   * 获取 Agent 有效配置：全局基础 + 差异合并，删除全局专属键，回填 api_key。
   */
  getEffectiveConfig(agentId: string, agentDiff: Record<string, unknown>): Record<string, unknown> {
    const effective = deepMerge(this.buildGlobalBase(), agentDiff);
    effective.agent_id = agentId;
    for (const key of GLOBAL_ONLY_KEYS) delete effective[key];
    const effLlm = effective.llm as Record<string, unknown> | undefined;
    if (effLlm?.provider) {
      const key = getCredential(agentId, effLlm.provider as string)
        || getCredential('__global__', effLlm.provider as string);
      if (key) effLlm.api_key = key;
    }
    return effective;
  }

  /** 列出所有 Agent（含虚拟） */
  list(): AgentInfo[] {
    const ids = this.registry.listIds();
    return ids.map((id: string) => {
      const agent = this.registry.getAgent(id);
      const virtual = this.registry.isVirtual(id);
      const info: AgentInfo = {
        agent_id: id,
        name: agent?.name ?? id,
        virtual,
      };
      const cfg = (agent as any)?.config;
      if (cfg) {
        if (cfg.description) info.description = cfg.description;
        if (cfg.avatar) info.avatar = cfg.avatar;
        if (cfg.tags) info.tags = cfg.tags;
        if (cfg.llm) info.llm = typeof cfg.llm === 'string' ? { provider: cfg.llm } : { provider: cfg.llm.provider, model: cfg.llm.model };
      }
      return info;
    });
  }

  /**
   * 获取指定 Agent 的定时任务（v0.5.0 收敛：webui 不再直接 import @core/timer）。
   * 委托核心 TimerManager。
   */
  getAgentTimers(agentId: string): TimerEntry[] {
    return timerManager.getEntries(agentId);
  }

  /** 保存指定 Agent 的定时任务 */
  saveAgentTimers(agentId: string, entries: TimerEntry[]): void {
    timerManager.saveEntries(agentId, entries);
  }

  /**
   * 获取 Agent 的 System Prompt 预览（v0.5.0 收敛：webui ws 不再直接 import @core/agent）。
   * 仅真 Agent（非虚拟）可预览，否则抛错。
   */
  async getAgentSystemPrompt(agentId: string): Promise<string> {
    const agent = this.registry.getAgent(agentId);
    if (!agent || !(agent instanceof Agent)) {
      throw new Error(`Agent "${agentId}" 未找到`);
    }
    return (agent as Agent).assembleSystemPrompt(getGlobalConfig().viewerId);
  }

  /**
   * 获取 Agent 的工具定义预览（供 webui WS 预览 tool_defs）。
   */
  getAgentToolDefs(agentId: string): Array<Record<string, unknown>> {
    const agent = this.registry.getAgent(agentId);
    if (!agent || !(agent instanceof Agent)) {
      throw new Error(`Agent "${agentId}" 未找到`);
    }
    return (agent as Agent).getToolDefinitions() as unknown as Array<Record<string, unknown>>;
  }
}
