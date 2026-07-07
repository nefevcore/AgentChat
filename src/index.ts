// ============================================================
// AgentChat 主入口 —— 串联所有模块
//
// 启动流程:
//   1. 加载环境变量（根 .env → workspace/.env，后者覆盖前者）
//   2. AgentLoader 扫描 agents/ 目录，加载配置
//   3. 创建 LLM 实例
//   4. 实例化 Agent，注入 LLM、工具、扩展
//   5. 注册到 AgentRouter
//   6. 创建 MessageQuery（只读查询服务）
//   7. 可选启动 WebUI Server
// ============================================================

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// ---- 加载环境变量 ----
const wsName = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
const wsEnvPath = path.resolve(process.cwd(), wsName, '.env');
if (fs.existsSync(wsEnvPath)) {
  dotenv.config({ path: wsEnvPath });
  console.log(`[Env] 已加载 ${wsName}/.env`);
} else {
  console.warn(`[Env] 未找到 ${wsName}/.env，API 密钥将不可用`);
}

import { Agent } from './core/agent';
import { AgentLoader, LoadedAgent } from './discovery/agent-loader';
import { LLMConfig } from './discovery/config-types';
import { OpenAIChatLLM } from './llm/openai';
import { DeepSeekChatLLM } from './llm/deepseek';
import { AgentRegistry } from './routing/registry';
import { AgentRouter } from './routing/router';
import { FileMessageQuery, IMessageQuery } from './routing/message-query';
import { getGlobalConfig } from './core/config';

// ============================================================
// LLM 工厂 —— 每个 Agent 独立创建
// ============================================================

/** 根据 Agent 的 LLMConfig 创建 LLM 实例，未填字段由各 provider 内部默认值兜底 */
function createLLMFromConfig(llmConfig: LLMConfig): OpenAIChatLLM | DeepSeekChatLLM {
  console.log(`[LLM Factory] ${llmConfig.provider}/${llmConfig.model ?? '(default)'}`);

  if (llmConfig.provider === 'deepseek') {
    return new DeepSeekChatLLM({
      apiKey: llmConfig.api_key,
      baseURL: llmConfig.base_url,
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      maxTokens: llmConfig.max_tokens,
      reasoningEffort: llmConfig.reasoning_effort,
      thinking: llmConfig.thinking,
    });
  }

  return new OpenAIChatLLM({
    apiKey: llmConfig.api_key,
    baseURL: llmConfig.base_url,
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    maxTokens: llmConfig.max_tokens,
  });
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
  console.log('═══════════════════════════════════════');
  console.log('  AgentChat 正在启动…');
  console.log('═══════════════════════════════════════\n');

  // 1. 加载所有 Agent 配置
  const srcRoot = path.resolve(__dirname);
  const loader = new AgentLoader(srcRoot);
  const loadedAgents = loader.loadAll();

  if (loadedAgents.length === 0) {
    console.warn('[Bootstrap] 未找到任何 Agent，请检查是否创建了 config.json 文件');
  }

  // 2. 创建注册表与路由器
  const registry = new AgentRegistry();
  const router = new AgentRouter(registry, getGlobalConfig().maxHops);

  // 2.1 预注册虚拟 Agent（如 user）
  for (const loaded of loadedAgents) {
    if (loaded.config.virtual) {
      registry.registerVirtual({
        id: loaded.config.agent_id,
        name: loaded.config.name,
      });
    }
  }

  // 3. 为每个 Agent 创建独立的 LLM 并实例化
  const agentMap = new Map<string, Agent>();

  for (const loaded of loadedAgents) {
    // 虚拟 Agent 跳过 LLM 初始化
    if (loaded.config.virtual) {
      console.log(`[Bootstrap] 虚拟 Agent "${loaded.config.agent_id}" — 无 LLM`);
      continue;
    }

    const agent = new Agent(loaded.config);
    agent.setEventBus(router);

    // 每个非虚拟 Agent 必须配置 llm 块
    if (!loaded.llmConfig) {
      throw new Error(
        `Agent "${loaded.config.agent_id}" 缺少 llm 配置。请在 agents/${loaded.config.agent_id}/config.json 中添加 llm 字段。`
      );
    }
    const llm = createLLMFromConfig(loaded.llmConfig);
    agent.setLLM(llm);

    // 注册工具
    if (loaded.tools.length > 0) {
      agent.registerTools(loaded.tools);
    }

    // 注册前置钩子
    for (const hook of loaded.preHooks) {
      agent.usePreHook(hook);
    }

    // 注册后置钩子
    for (const hook of loaded.postHooks) {
      agent.usePostHook(hook);
    }

    // 设置最大迭代次数
    agent.setMaxIterations(
      loaded.config.max_iterations ?? getGlobalConfig().maxIterations
    );

    // 注册到路由表
    registry.register(loaded.config.agent_id, agent);
    agentMap.set(loaded.config.agent_id, agent);
  }

  // 5. 创建 MessageQuery（只读查询服务，供 WebUI 历史 API 使用）
  const messageQuery = new FileMessageQuery();
  const sessionsDir = getGlobalConfig().sessionsDir;
  console.log(`[Bootstrap] MessageQuery 已初始化（会话目录：${sessionsDir}）`);

  console.log(`\n[Bootstrap] ${registry.size} agents registered: ${registry.listIds().join(', ')}`);

  // 7. 可选：启动 WebUI Server
  let webui: any = undefined;
  if (options?.enableWebUI !== false) {
    try {
      const { WebUIServer } = await import('../webui/server/index.js');
      webui = new WebUIServer({
        router,
        registry,
        messageQuery,
        loader,
        dataDir: getGlobalConfig().workspaceDir,
        port: options?.webuiPort ?? getGlobalConfig().webuiDefaultPort,
      });
      await webui.start();
    } catch (err: any) {
      console.warn(`[Bootstrap] WebUI 服务器启动失败：${err.message}`);
    }
  }

  console.log('[Bootstrap] [OK] Ready.\n');

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
export { FileMessageQuery, IMessageQuery } from './routing/message-query';
export type { PersistedMessage } from './global/extensions/agent-session/types';
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
    console.error('[Bootstrap] Fatal error:', err);
    process.exit(1);
  });
}
