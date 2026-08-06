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

// logger 必须最先 import：.env 加载处使用 logger.info（第 20+ 行），
// 编译成 CJS 后 import 不提升，若 logger 的 require 靠后会在 TDZ 报错
// （"Cannot access 'logger_1' before initialization"）。
import { logger } from '@utils/logger';
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
import { VirtualAgent } from '@agents/virtual-agent';
import { AgentLoader, LoadedAgent, resolveLLMPool } from '@app/loader';
import { PluginLoader } from '@app/plugin-loader';
import { LLMConfig } from '@core/types';
import { OpenAIChatLLM } from '@llm/openai';
import { DeepSeekChatLLM } from '@llm/deepseek';
import { AgentRegistry } from '@agents/registry';
import { AgentRouter } from '@agents/router';
import { GroupManager } from '@agents/group';
import { FileMessageQuery } from '@plugins/builtin/extensions/agent-session/message-query';
import { HistoryService } from '@services/index';
import { ServiceRegistry, AgentService, GroupService, initRuntime } from '@services/index';
import { getGlobalConfig } from '@core/config';
import { setAppState, getAppState } from '@core/app-state';
import { getCredential } from '@agents/credential-store';
import { timerManager } from '@plugins/builtin/src/timer';
import { getSubAgentManager, setSubAgentManager } from '@plugins/builtin/src/sub-agent';
import { InteractionBridge, setInteractionBridge } from '@services/interactions';
import { requestRestart } from './shutdown';

// ============================================================
// 进程级兜底 —— abort 链 / 异步 rejection 不崩溃进程
// ============================================================
// Node 的 AbortSignal 监听器抛错会作为 uncaughtException 全局抛出
// （kHybridDispatch 特殊行为），绕过局部 try-catch。
// 这里兜底：记录日志，不退出进程（abort 中断当前 run 是正常流程）。
process.on('uncaughtException', (err) => {
  logger.error('[Process] uncaughtException（已吞，进程继续）:', err?.message ?? String(err));
  if (err?.stack) logger.error(err.stack.split('\n').slice(0, 6).join('\n'));
});
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] unhandledRejection（已吞，进程继续）:', reason instanceof Error ? reason.message : String(reason));
});

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

/** 确保工作区 files/ 目录包含必要的指引文档（不存在时从模板复制）
 * 返回 true 表示首次运行（需引导：新建 admin + 触发自我介绍）。 */
function ensureWorkspaceFiles(workspaceDir: string, srcRoot: string): boolean {
  // 1. 确保 files/ 目录及指引文档存在
  const filesDir = path.join(workspaceDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const templateDir = path.join(srcRoot, 'plugins', 'builtin');
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
      pre_hooks: ['agent-mcp', 'agent-prompt', 'agent-session'],
      post_hooks: ['agent-session'],
    };
    fs.writeFileSync(userConfigPath, JSON.stringify(defaultUserConfig, null, 2), 'utf-8');
    logger.info(`[Bootstrap] 已创建默认 user agent 配置: ${userConfigPath}`);
  }

  // 3. 首次运行检测：无 admin（role=admin 的 Agent）且无 .initialized 标记 → 首次
  const initializedMark = path.join(workspaceDir, '.initialized');
  const agentsDir = path.join(workspaceDir, 'agents');
  const hasAdmin = (() => {
    if (!fs.existsSync(agentsDir)) return false;
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        // v0.4.6：admin 由 tags 判定（role 字段已废弃）
        if (Array.isArray(cfg.tags) && cfg.tags.includes('admin')) return true;
      } catch { /* skip */ }
    }
    return false;
  })();
  const isFirstRun = !fs.existsSync(initializedMark) && !hasAdmin;

  // 4. 首次运行：创建默认 admin Agent（艾吉模板）
  if (isFirstRun) {
    const adminDir = path.join(agentsDir, 'agent_chat_dev');
    const adminConfigPath = path.join(adminDir, 'config.json');
    if (!fs.existsSync(adminConfigPath)) {
      fs.mkdirSync(adminDir, { recursive: true });
      const defaultAdminConfig = {
        agent_id: 'agent_chat_dev',
        name: '艾吉',
        role: 'admin',
        description: 'AgentChat 平台管理员，负责社区治理与引导新用户',
        tools: ['read', 'write', 'edit', 'bash', 'web_search', 'code_search', 'reload', 'inspect_session', 'browser', 'math'],
        pre_hooks: ['agent-prompt', 'agent-memory', 'agent-session'],
        post_hooks: ['agent-session', 'agent-memory'],
      };
      fs.writeFileSync(adminConfigPath, JSON.stringify(defaultAdminConfig, null, 2), 'utf-8');
      logger.notice(`[Bootstrap] 首次运行：已创建默认 admin Agent（艾吉）: ${adminConfigPath}`);
    }
    // 写首次运行标记（防止重启重复引导）
    try { fs.writeFileSync(initializedMark, new Date().toISOString(), 'utf-8'); }
    catch { /* ignore */ }
  }

  return isFirstRun;
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
  messageQuery: HistoryService;
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
  // 群聊归档触发器注入（插件回调 —— 依赖倒置，agents 不 import plugins）
  groupManager.setGroupArchiveTrigger((groupId: string) => {
    void import('@plugins/builtin/extensions/agent-session/group-archive.js')
      .then((mod) => mod.maybeRequestGroupArchive(groupId))
      .catch((err: any) => logger.warn(`[GroupManager] 群聊归档检测失败: ${err?.message}`));
  });

  // 1.15 初始化交互桥（决策工具 ask_user）：绑定 router 事件总线，
  //      WS handler 监听 chat.interaction 推前端弹窗
  const interactionBridge = new InteractionBridge(router as any);
  setInteractionBridge(interactionBridge);

  // 1.16 创建 ServiceRegistry（v0.5.0 P3：服务注册表，插件/服务自主注册）
  const serviceRegistry = new ServiceRegistry();

  // 1.2 初始化全局 AppState（供内置工具通过 getAppState() 获取运行时引用）
  setAppState({ registry, router, messageQuery: null, serviceRegistry });
  // 交互桥注入 AppState：ask_user 工具经 getAppState().interactionBridge 读取
  // （依赖注入，避免插件直接 import services，保持分层单向）
  getAppState().interactionBridge = interactionBridge;
  // requestRestart 注入 AppState：core/loop 的 restart-requested 经此触发
  // （依赖注入，避免 core 动态 import @app/shutdown）
  getAppState().requestRestart = requestRestart;
  logger.notice('[Bootstrap] Router + Registry + GroupManager 已就绪，AppState 已初始化');

  // 1.3 初始化 SubAgentManager（v0.4.0 里程碑 —— Agent 组织调度）
  const subAgentManager = getSubAgentManager();
  subAgentManager.setEventBus(router);
  setSubAgentManager(subAgentManager);
  logger.notice('[Bootstrap] SubAgentManager 已就绪');

  // 2. 加载所有 Agent 配置
  // L5 app 域：srcRoot 向上取一层（src/app → src），定位 plugins/ 与 core/llm/
  const srcRoot = path.resolve(__dirname, '..');

  // 2.0 初始化工作区：确保必要文件存在（如工具开发指引）；返回是否首次运行
  const isFirstRun = ensureWorkspaceFiles(getGlobalConfig().workspaceDir, srcRoot);
  logger.info(`[Bootstrap] 工作区就绪（${isFirstRun ? '首次运行，需引导' : '已有环境'}）`);

  // 2.05 创建 PluginLoader（插件发现/加载，v0.5.0 架构重构）
  //       注入 AppState（core/agent performReload 经此获取，无编译期依赖）+
  //       服务注册表（webui plugins API 经此获取，单一入口）
  const pluginLoader = new PluginLoader(srcRoot);
  serviceRegistry.register('pluginLoader', pluginLoader);

  const loader = new AgentLoader(pluginLoader);
  const loadedAgents = loader.loadAll();
  // 补充 AppState.loader（供 list_tools 扫描全局工具池）+ pluginLoader（供热重载）
  try {
    getAppState().loader = loader;
    getAppState().pluginLoader = pluginLoader;
  } catch { /* ignore */ }


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
  const llmConfigs = new Map<string, LLMConfig>(); // 保存解析后配置，供 API Key 热更新
  const rawLlmConfigs = new Map<string, LLMConfig | string | undefined>(); // 保存原始 llm 配置（池解析前），供热重载重解析

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
      // 全新环境：用户尚未配置 LLM（全局池为空）。不崩溃——Agent 降级为
      // “待配置”状态（保留工具/钩子/注册），用户配置全局 LLM 后由 API Key 热更新自动生效。
      logger.warn(
        `[Bootstrap] Agent "${loaded.config.agent_id}" 未配置 LLM，且全局无默认。` +
        `启动后配置全局 LLM（WebUI 设置 → 模型管理）即可自动生效。`
      );
      // 仍保存原始 llm 配置（null），供热重载时从池自动补默认
      rawLlmConfigs.set(loaded.config.agent_id, loaded.config.llm);
    } else {
      loaded.llmConfig.api_key = (loaded.llmConfig.$ref
        ? getCredential(loaded.config.agent_id, `pool:${loaded.llmConfig.$ref}`)
          || getCredential('__global__', `pool:${loaded.llmConfig.$ref}`)
        : getCredential(loaded.config.agent_id, loaded.llmConfig.provider || '')
          || getCredential('__global__', loaded.llmConfig.provider || ''))
        || loaded.llmConfig.api_key;
      const llm = createLLMFromConfig(loaded.llmConfig);
      agent.setLLM(llm);
      agent.setLLMConfig(loaded.llmConfig);

      // 保存原始 llmConfig（深拷贝，不含 api_key），供 API Key 热更新时重建 LLM
      const { api_key: _, ...safeConfig } = loaded.llmConfig;
      llmConfigs.set(loaded.config.agent_id, safeConfig as LLMConfig);
      // 保存原始 llm 配置（池解析前的 config.json 值），供热重载重解析池引用
      rawLlmConfigs.set(loaded.config.agent_id, loaded.config.llm);
    }

    // 注册工具（AgentLoader 按 config.json 筛选）
    if (loaded.tools.length > 0) {
      agent.registerTools(loaded.tools);
    }

    // 注入内置多 Agent 工具（已由 loadOne 按 requires 匹配 tags 自动注入，v0.4.10）

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
  const fileMessageQuery = new FileMessageQuery();
  const messageQuery = new HistoryService();
  // 注册为服务（v0.5.0 P3：插件/服务自主注册，webui 经 registry 获取）
  serviceRegistry.register('messageQuery', fileMessageQuery);

  // 5.5 注册 LLM 热重载函数 —— 凭据保存 / 全局模型变更后无需重启即可更新所有 Agent 的 LLM
  const reloadAllLLMs = () => {
    let reloaded = 0;
    for (const [agentId, agent] of agentMap) {
      // 从原始配置重解析池引用（获取最新的全局默认模型 / 池条目变更）
      let cfg: LLMConfig | undefined;
      if (rawLlmConfigs.has(agentId)) {
        const rawLlm = rawLlmConfigs.get(agentId);
        const reResolved = resolveLLMPool(rawLlm);
        if (reResolved) {
          cfg = { ...reResolved } as LLMConfig;
          // 保留 Agent 侧可能有的工具/搜索等非 LLM 字段（resolveLLMPool 只处理 LLM 字段）
          const cached = llmConfigs.get(agentId);
          if (cached) {
            // 池没定义的字段（如 search 配置）保持缓存值
            for (const key of Object.keys(cached)) {
              if (!(key in cfg) && key !== 'api_key') (cfg as any)[key] = (cached as any)[key];
            }
          }
          llmConfigs.set(agentId, cfg);
        }
      }

      if (!cfg) {
        // 回退：用缓存的解析后配置（无池依赖的显式配置 Agent）
        cfg = llmConfigs.get(agentId);
      }

      if (!cfg) {
        // 待配置 Agent（全局池刚配置，重解析应该已 cover；此处兜底）
        continue;
      }

      const fullConfig: LLMConfig = { ...cfg };
      fullConfig.api_key = (fullConfig.$ref
        ? getCredential(agentId, `pool:${fullConfig.$ref}`)
          || getCredential('__global__', `pool:${fullConfig.$ref}`)
        : getCredential(agentId, fullConfig.provider || '')
          || getCredential('__global__', fullConfig.provider || ''))
        || '';
      if (!fullConfig.api_key) continue;
      const llm = createLLMFromConfig(fullConfig);
      agent.setLLM(llm);
      agent.setLLMConfig(fullConfig);
      reloaded++;
    }
    logger.info(`[Bootstrap] LLM 热重载完成：${reloaded}/${agentMap.size} 个 Agent`);
    return reloaded;
  };

  // 注入到 AppState，供 query_history 等工具使用
  // 注：groupManager 在早期 setAppState 后创建，此处补充注入
  setAppState({ registry, router, messageQuery: fileMessageQuery, agentMap, loader, pluginLoader, srcRoot, reloadAllLLMs, GroupManager: groupManager });
  const sessionsDir = getGlobalConfig().sessionsDir;
  logger.info(`[Bootstrap] MessageQuery 已初始化（会话目录：${sessionsDir}）`);

  logger.notice(`\n[Bootstrap] ${registry.size} agents registered: ${registry.listIds().join(', ')}`);

  // 7. 可选：启动 WebUI Server
  let webui: any = undefined;
  if (options?.enableWebUI !== false) {
    try {
      // 7.0 创建 AgentService 并注册（v0.5.0 P3/P5：服务注册 → RPC 映射）
      const agentService = new AgentService(registry, loader, router);
      serviceRegistry.register('agentService', agentService);

      // 7.0b 创建 GroupService 并注册（群组门面，供 groups API 使用）
      const groupService = new GroupService(groupManager);
      serviceRegistry.register('groupService', groupService);

      // 7.0c 运行时门面注入：Router/Registry/GroupManager/requestRestart 经 services 暴露，
      // webui/server 只 import services（设计文档 7.1），不再直连 @agents/@app
      initRuntime({ router, registry, groupManager, requestRestart });

      const { WebUIServer } = await import('../server/index.js');
      webui = new WebUIServer({
        historyService: messageQuery,
        serviceRegistry,
        dataDir: getGlobalConfig().workspaceDir,
        port: options?.webuiPort ?? 3830,
      });
      await webui.start();
    } catch (err: any) {
      logger.warn(`[Bootstrap] WebUI 服务器启动失败：${err.message}`);
    }
  }

  // 7.5 注入 webui / subAgentManager 引用（供 gracefulShutdown 关闭服务器 + 杀子 Agent）
  try {
    const state = getAppState() as any;
    state.webui = webui;
    state.subAgentManager = subAgentManager;
  } catch { /* ignore */ }

  logger.notice('[Bootstrap] [OK] Ready.\n');

  // 启动定时任务管理器
  timerManager.setRouter(router);
  timerManager.reloadAll();

  // 重启后 flush pending 消息（上次 gracefulShutdown 进入重启模式时入队的）
  try {
    const flushed = await router.flushPendingMessages();
    if (flushed > 0) logger.notice(`[Bootstrap] 已重投 ${flushed} 条 pending 消息`);
  } catch (err: any) {
    logger.warn(`[Bootstrap] flush pending 消息失败: ${err.message}`);
  }

  // 首次运行：触发艾吉的自我介绍与引导（引导用户配置 LLM / 创建 Agent）
  if (isFirstRun) {
    try {
      const introHint =
        '这是你（艾吉）在 AgentChat 平台的第一次启动，也是本平台首次运行。\n' +
        '请向用户（user）做一次友好自我介绍，并引导完成以下事项（用 send_agent 发给 user，或直接回复）：\n' +
        '1. 介绍你自己：AgentChat 平台管理员艾吉，Agent 社区的守护者；\n' +
        '2. 引导用户配置全局 LLM（WebUI 左侧「设置」→「模型管理」添加 Provider 并填 API Key）；\n' +
        '3. 引导用户创建一个新 Agent（WebUI「新建 Agent」），体验 Agent 社区；\n' +
        '4. 用户配置完成后，主动与新 Agent 打个招呼，让新 Agent 给用户发条消息，展示社区的活力。\n' +
        '保持热情友好，这是给用户的第一印象。';
      // 异步触发，不阻塞启动完成
      void router.trigger('agent_chat_dev', { hint: introHint, source: 'bootstrap-intro', target: 'user' })
        .then(() => logger.notice('[Bootstrap] 已触发艾吉的首次引导自我介绍'))
        .catch((err: any) => logger.warn(`[Bootstrap] 触发首次引导失败: ${err.message}`));
    } catch (err: any) {
      logger.warn(`[Bootstrap] 首次引导初始化失败: ${err.message}`);
    }
  }

  return { router, registry, messageQuery, agents: agentMap, webui };
}

// ============================================================
// 导出
// ============================================================

export { bootstrap };
export { Agent } from '@core/agent';
export { AgentLoader } from './loader';
export { PluginLoader } from './plugin-loader';
export { AgentRegistry } from '@agents/registry';
export type { VirtualAgentInfo } from '@agents/registry';
export { AgentRouter } from '@agents/router';
export { GroupManager } from '@agents/group';
export { FileMessageQuery, IMessageQuery } from '../plugins/builtin/extensions/agent-session/message-query';
export type { PersistedMessage } from '../plugins/builtin/extensions/agent-session/types';
export { OpenAIChatLLM } from '@llm/openai';
export * from '@core/types';

/**
 * 懒加载 WebUIServer —— 仅在 webui 模块存在时可用
 * 静态 export 会使核心入口强依赖 webui，改为动态 getter 解耦
 */
export async function getWebUIServer(): Promise<any> {
  const mod = await import('../server/index.js');
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
  }).then(() => {
    // 注册优雅关闭信号（Supervisor 模式：42 重启，0 正常退出）
    const { gracefulShutdown } = require('./shutdown');
    process.on('SIGINT', () => { void gracefulShutdown(0, 'SIGINT'); });
    process.on('SIGTERM', () => { void gracefulShutdown(0, 'SIGTERM'); });
  }).catch((err) => {
    logger.error('[Bootstrap] Fatal error:', err);
    process.exit(1);
  });
}
