// ============================================================
// AgentChat 主入口 —— 串联所有模块
//
// 启动流程:
//   1. 创建 Router + Registry（最优先，无任何 Agent 依赖）
//   2. AgentLoader 扫描 agents/ 目录，加载配置
//   3. 实例化 Agent，注入 LLM、工具、扩展、内置多 Agent 工具
//   4. 注册到 AgentRouter
//   5. 创建 MessageQuery（只读查询服务）
//   6. 可选启动 WebUI Server
// ============================================================

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// ---- 加载环境变量（可选：LOG_LEVEL 等运行时配置） ----
const wsName = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
const wsEnvPath = path.resolve(process.cwd(), wsName, '.env');
if (fs.existsSync(wsEnvPath)) {
  dotenv.config({ path: wsEnvPath });
  logger.info(`[Env] 已加载 ${wsName}/.env`);
}

import { Agent } from '@core/agent';
import { VirtualAgent } from '@core/virtual-agent';
import { AgentLoader, LoadedAgent } from '@discovery/agent-loader';
import { LLMConfig } from '@discovery/config-types';
import { OpenAIChatLLM } from '@llm/openai';
import { DeepSeekChatLLM } from '@llm/deepseek';
import { AgentRegistry } from '@routing/registry';
import { AgentRouter } from '@routing/router';
import { GroupManager } from '@routing/group-manager';
import { FileMessageQuery, IMessageQuery } from '@routing/message-query';
import { getGlobalConfig } from '@core/config';
import { setAppState } from '@core/app-state';
import { getCredential } from '@core/credential-store';
import { timerManager } from '@core/timer-manager';
import { logger } from './utils/logger';

// ============================================================
// LLM 工厂 —— 每个 Agent 独立创建
// ============================================================

/** 根据 Agent 的 LLMConfig 创建 LLM 实例，未填字段由各 provider 内部默认值兜底 */
function createLLMFromConfig(llmConfig: LLMConfig): OpenAIChatLLM | DeepSeekChatLLM {
  logger.info(`[LLM Factory] ${llmConfig.provider}/${llmConfig.model ?? '(default)'}`);

  const apiKey = llmConfig.api_key ?? '';

  if (llmConfig.provider === 'deepseek') {
    return new DeepSeekChatLLM({
      apiKey,
      baseURL: llmConfig.base_url,
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      maxTokens: llmConfig.max_tokens,
      topP: llmConfig.top_p,
      responseFormat: llmConfig.response_format,
      stop: llmConfig.stop,
      reasoningEffort: llmConfig.reasoning_effort,
      thinking: llmConfig.thinking,
      logprobs: llmConfig.logprobs,
      topLogprobs: llmConfig.top_logprobs,
      toolChoice: llmConfig.tool_choice,
    });
  }

  return new OpenAIChatLLM({
    apiKey,
    baseURL: llmConfig.base_url,
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    maxTokens: llmConfig.max_tokens,
    topP: llmConfig.top_p,
    responseFormat: llmConfig.response_format,
    stop: llmConfig.stop,
  });
}

// ============================================================
// 工作区初始化
// ============================================================

/** 确保工作区 files/ 目录包含必要的指引文档（不存在时从模板复制） */
function ensureWorkspaceFiles(workspaceDir: string, srcRoot: string): void {
  // 1. 确保 files/ 目录及指引文档存在
  const filesDir = path.join(workspaceDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const templateDir = path.join(srcRoot, 'global', 'agent-core');
  const files: Array<{ name: string; desc: string }> = [
    { name: 'tool-dev-guide.md', desc: '工具开发指引' },
  ];

  for (const { name, desc } of files) {
    const dest = path.join(filesDir, name);
    if (!fs.existsSync(dest)) {
      const src = path.join(templateDir, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        logger.info(`[Bootstrap] 已复制${desc}到工作区: ${dest}`);
      } else {
        logger.warn(`[Bootstrap] ${desc}模板不存在: ${src}`);
      }
    }
  }

  // 2. 确保默认 user agent 配置存在
  const userAgentDir = path.join(workspaceDir, 'agents', 'user');
  const userConfigPath = path.join(userAgentDir, 'config.json');
  if (!fs.existsSync(userConfigPath)) {
    fs.mkdirSync(userAgentDir, { recursive: true });
    const defaultUserConfig = {
      agent_id: 'user',
      name: '用户',
      virtual: true,
      pre_hooks: ['agent-prompt', 'agent-session'],
      post_hooks: ['agent-session'],
    };
    fs.writeFileSync(userConfigPath, JSON.stringify(defaultUserConfig, null, 2), 'utf-8');
    logger.info(`[Bootstrap] 已创建默认 user agent 配置: ${userConfigPath}`);
  }
}

// ============================================================
// 主启动函数
// ============================================================

async function bootstrap(options?: {
  enableWebUI?: boolean;
  webuiPort?: number;
}): Promise<{
  router: AgentRouter;
  registry: AgentRegistry;
  messageQuery: IMessageQuery;
  agents: Map<string, Agent>;
  webui?: any;
}> {
  logger.notice('═══════════════════════════════════════');
  logger.notice('  AgentChat 正在启动…');
  logger.notice('═══════════════════════════════════════\n');

  // 1. 创建注册表与路由器（最优先，不依赖任何 Agent）
  const registry = new AgentRegistry();
  const router = new AgentRouter(registry, getGlobalConfig().maxHops);

  // 1.1 创建 GroupManager 并注入到 Router（群组功能）
  const groupManager = new GroupManager(registry);
  router.setGroupManager(groupManager);

  // 1.2 初始化全局 AppState（供内置工具通过 getAppState() 获取运行时引用）
  setAppState({ registry, router, messageQuery: null });
  logger.notice('[Bootstrap] Router + Registry + GroupManager 已就绪，AppState 已初始化');

  // 2. 加载所有 Agent 配置
  const srcRoot = path.resolve(__dirname);

  // 2.0 初始化工作区：确保必要文件存在（如工具开发指引）
  ensureWorkspaceFiles(getGlobalConfig().workspaceDir, srcRoot);

  const loader = new AgentLoader(srcRoot);
  const loadedAgents = loader.loadAll();

  // 2.0 获取标记为 autoInject 的内置工具（来自 plugin.json）
  const autoInjectTools = loader.getAutoInjectTools();
  logger.info(`[Bootstrap] autoInject 工具：${autoInjectTools.map(t => t.definition.function.name).join(', ')}`);

  if (loadedAgents.length === 0) {
    logger.warn('[Bootstrap] 未找到任何 Agent，请检查是否创建了 config.json 文件');
  }

  // 2.1 实例化并注册虚拟 Agent（如 user）
  // 虚拟 Agent 无 LLM，但创建 VirtualAgent 实例并注入 preHook/postHook，
  // 使其能走完整的 Hook 管道（尤其 agent-session 的 postHook 负责消息持久化）。
  for (const loaded of loadedAgents) {
    if (loaded.config.virtual) {
      const virt = new VirtualAgent(loaded.config);
      virt.setEventBus(router);

      // 注册后置钩子（agent-session 等，负责消息持久化）
      for (const hook of loaded.postHooks) {
        virt.usePostHook(hook);
      }

      // 注册前置钩子（加载历史等）
      for (const hook of loaded.preHooks) {
        virt.usePreHook(hook);
      }

      registry.registerVirtual(virt);
      logger.info(`[Bootstrap] 虚拟 Agent "${loaded.config.agent_id}" 已注册（含 ${loaded.preHooks.length} preHook, ${loaded.postHooks.length} postHook）`);
    }
  }

  // 3. 为每个 Agent 创建独立的 LLM 并实例化
  const agentMap = new Map<string, Agent>();

  for (const loaded of loadedAgents) {
    // 虚拟 Agent 跳过 LLM 初始化
    if (loaded.config.virtual) {
      logger.info(`[Bootstrap] 虚拟 Agent "${loaded.config.agent_id}" — 无 LLM`);
      continue;
    }

    const agent = new Agent(loaded.config);
    agent.setEventBus(router);

    // 从凭据存储注入 api_key，若 Agent 无 llm 则从池自动检测默认
    if (!loaded.llmConfig) {
      // 自动从池中找默认条目
      const pools = getGlobalConfig().llmProviders;
      const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
      const def = entries.find(([_, v]) => v && (v as any).default);
      const poolName = def ? def[0] : entries[0]?.[0];
      if (poolName) {
        const pool = pools[poolName] as Record<string, unknown> | undefined;
        if (pool) {
          loaded.llmConfig = { ...pool, $ref: poolName } as LLMConfig;
          logger.info(`[Bootstrap] Agent "${loaded.config.agent_id}" 使用池默认模型: ${poolName}`);
        }
      }
    }
    if (!loaded.llmConfig) {
      throw new Error(
        `Agent "${loaded.config.agent_id}" 缺少 llm 配置，且全局配置中也没有默认值。`
      );
    }
    loaded.llmConfig.api_key = (loaded.llmConfig.$ref
      ? getCredential(loaded.config.agent_id, `pool:${loaded.llmConfig.$ref}`)
        || getCredential('__global__', `pool:${loaded.llmConfig.$ref}`)
      : getCredential(loaded.config.agent_id, loaded.llmConfig.provider)
        || getCredential('__global__', loaded.llmConfig.provider))
      || loaded.llmConfig.api_key;
    const llm = createLLMFromConfig(loaded.llmConfig);
    agent.setLLM(llm);

    // 注册工具（AgentLoader 按 config.json 筛选）
    if (loaded.tools.length > 0) {
      agent.registerTools(loaded.tools);
    }

    // 注入内置多 Agent 工具（由 plugin.json 的 autoInject 标记控制）
    for (const tool of autoInjectTools) {
      agent.registerTool(tool);
    }

    // 注册全局拦截器（框架强制约束，如 send_agent from 注入、bash 命令审核）
    for (const interceptor of loaded.interceptors) {
      agent.useToolInterceptor(interceptor);
    }

    // 注册前置钩子
    for (const hook of loaded.preHooks) {
      agent.usePreHook(hook);
    }

    // 注册后置钩子
    for (const hook of loaded.postHooks) {
      agent.usePostHook(hook);
    }

    // 注册到路由表
    registry.register(loaded.config.agent_id, agent);
    agentMap.set(loaded.config.agent_id, agent);
  }

  // 5. 创建 MessageQuery（只读查询服务，供 WebUI 历史 API 和 query_history 工具使用）
  const messageQuery = new FileMessageQuery();
  // 注入到 AppState，供 query_history 等工具使用
  setAppState({ registry, router, messageQuery });
  const sessionsDir = getGlobalConfig().sessionsDir;
  logger.info(`[Bootstrap] MessageQuery 已初始化（会话目录：${sessionsDir}）`);

  logger.notice(`\n[Bootstrap] ${registry.size} agents registered: ${registry.listIds().join(', ')}`);

  // 7. 可选：启动 WebUI Server
  let webui: any = undefined;
  if (options?.enableWebUI !== false) {
    try {
      const { WebUIServer } = await import('../webui/server/index.js');
      webui = new WebUIServer({
        router,
        registry,
        messageQuery,
        GroupManager: groupManager,
        loader,
        dataDir: getGlobalConfig().workspaceDir,
        port: options?.webuiPort ?? 3830,
      });
      await webui.start();
    } catch (err: any) {
      logger.warn(`[Bootstrap] WebUI 服务器启动失败：${err.message}`);
    }
  }

  logger.notice('[Bootstrap] [OK] Ready.\n');

  // 启动定时任务管理器
  timerManager.setRouter(router);
  timerManager.reloadAll();

  return { router, registry, messageQuery, agents: agentMap, webui };
}

// ============================================================
// 导出
// ============================================================

export { bootstrap };
export { Agent } from './core/agent';
export { AgentLoader } from './discovery/agent-loader';
export { AgentRegistry } from './routing/registry';
export type { VirtualAgentInfo } from './routing/registry';
export { AgentRouter } from './routing/router';
export { GroupManager } from './routing/group-manager';
export { FileMessageQuery, IMessageQuery } from './routing/message-query';
export type { PersistedMessage } from './global/agent-core/extensions/agent-session/types';
export { OpenAIChatLLM } from './llm/openai';
export * from './core/types';

/**
 * 懒加载 WebUIServer —— 仅在 webui 模块存在时可用
 * 静态 export 会使核心入口强依赖 webui，改为动态 getter 解耦
 */
export async function getWebUIServer(): Promise<any> {
  const mod = await import('../webui/server/index.js');
  return mod.WebUIServer;
}

// ============================================================
// CLI 参数解析
// ============================================================

function parseCLIArgs(): { enableWebUI?: boolean; webuiPort?: number; workspace?: string } {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg === '--no-webui') {
      opts.webui = false;
    } else if (arg.startsWith('--port=')) {
      opts.port = arg.slice(7);
    } else if (arg.startsWith('--workspace=')) {
      opts.workspace = arg.slice(12);
    }
  }
  return {
    enableWebUI: 'webui' in opts ? (opts.webui as boolean) : undefined,
    webuiPort: opts.port ? parseInt(opts.port as string) : undefined,
    workspace: opts.workspace as string | undefined,
  };
}

// ============================================================
// 直接运行时启动（仅在作为主入口运行时触发，被 import 时不执行）
// ============================================================
function isMainModule(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('index.ts') || entry.endsWith('index.js');
}
if (isMainModule()) {
  const cli = parseCLIArgs();
  bootstrap({
    enableWebUI: cli.enableWebUI,
    webuiPort: cli.webuiPort,
  }).catch((err) => {
    logger.error('[Bootstrap] Fatal error:', err);
    process.exit(1);
  });
}
