// ============================================================
// AgentChat 主入口 —— 启动流程（L5，唯一有副作用层）
//
// 启动流程（新架构）：
//   1. 加载环境变量 + 全局配置（workspace/config.json）
//   2. 装配插件（builtin/builtin-math）+ 服务注入 → AgentAssembly
//   3. 创建 Router（内置 Registry + GroupManager）
//   4. 初始化工作区（files 指引 / 默认 user / 首次运行 admin 引导）
//   5. AgentLoader 扫描 agents/ → 有效配置 → 注册到 Router
//   6. L4 门面：AgentService / GroupService（加载磁盘群组）/ HistoryService /
//      ServiceRegistry / RPCBridge / InteractionBridge
//   7. 定时任务启动 / pending flush / 可选 WebUI / 首次引导
//
// 依赖方向：app → services/plugins/agents/core（装配层聚合）。
// ============================================================

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@core/logger';
import { AgentRouter } from '@agents/router';
import { AgentRegistry } from '@agents/registry';
import type { AgentConfig } from '@agents/config';
import { counterpartOfDialog, chatDialogKey } from '@agents/paths';
import { genMessageId } from '@plugins/builtin/hooks/session';
import { PluginRegistry } from '@plugins/registry';
import type { PluginServices } from '@plugins/types';
import type { TimerManager } from '@plugins/builtin/services/timer';
import {
  AgentLoader, loadGlobalConfig, setupPlugins, makeAgentAssembly, makePluginManager,
} from './loader';
import {
  AgentService, GroupService, HistoryService, ServiceRegistry, RPCBridge,
  InteractionBridge, initRuntime, ArchiveService,
} from '@services/index';
import { setInteractionBridge } from '@services/interactions';
import { createBackup } from '@services/backup';
import { gracefulShutdown, requestRestart, setShutdownDeps } from './shutdown';

const logger = createLogger('[app:index]');

// ---- 加载环境变量（可选：LOG_LEVEL 等运行时配置）----
const wsEnvName = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
const wsEnvPath = path.resolve(process.cwd(), wsEnvName, '.env');
if (fs.existsSync(wsEnvPath)) {
  dotenv.config({ path: wsEnvPath });
  logger.info(`[Env] 已加载 ${wsEnvName}/.env`);
}

// ============================================================
// 进程级兜底 —— abort 链 / 异步 rejection 不崩溃进程
// ============================================================
process.on('uncaughtException', (err) => {
  logger.error('[Process] uncaughtException（已吞，进程继续）:', err?.message ?? String(err));
  if (err?.stack) logger.error(err.stack.split('\n').slice(0, 6).join('\n'));
});
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] unhandledRejection（已吞，进程继续）:', reason instanceof Error ? reason.message : String(reason));
});

// ============================================================
// 工作区初始化
// ============================================================

/**
 * 确保工作区 files/ 目录包含必要指引文档；创建默认 user Agent 配置；
 * 首次运行检测并创建默认 admin Agent（艾吉）。
 * @returns true 表示首次运行（需引导）
 */
function ensureWorkspaceFiles(workspaceDir: string, srcRoot: string): boolean {
  // 1. 确保 files/ 目录及指引文档存在
  const filesDir = path.join(workspaceDir, 'files');
  fs.mkdirSync(path.join(filesDir, 'shared'), { recursive: true });

  const templateDir = path.join(srcRoot, 'plugins', 'builtin');
  const files: Array<{ name: string; desc: string }> = [
    { name: 'tool-dev-guide.md', desc: '工具开发指引' },
  ];
  for (const { name, desc } of files) {
    const dest = path.join(filesDir, 'shared', name);
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

  // 2. 确保默认 user（虚拟 Agent）配置存在
  const userAgentDir = path.join(workspaceDir, 'agents', 'user');
  const userConfigPath = path.join(userAgentDir, 'config.json');
  if (!fs.existsSync(userConfigPath)) {
    fs.mkdirSync(userAgentDir, { recursive: true });
    const defaultUserConfig = {
      agent_id: 'user',
      name: '用户',
      virtual: true,
    };
    fs.writeFileSync(userConfigPath, JSON.stringify(defaultUserConfig, null, 2), 'utf-8');
    logger.info(`[Bootstrap] 已创建默认 user agent 配置: ${userConfigPath}`);
  }

  // 3. 首次运行检测：无 admin（tags 含 admin 的 Agent）且无 .initialized 标记 → 首次
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
        if (Array.isArray(cfg.tags) && cfg.tags.includes('admin')) return true;
      } catch { /* skip */ }
    }
    return false;
  })();
  const isFirstRun = !fs.existsSync(initializedMark) && !hasAdmin;

  // 4. 首次运行：创建默认 admin Agent（艾吉模板，新配置形态 plugins）
  if (isFirstRun) {
    const adminDir = path.join(agentsDir, 'agent_chat_dev');
    const adminConfigPath = path.join(adminDir, 'config.json');
    if (!fs.existsSync(adminConfigPath)) {
      fs.mkdirSync(adminDir, { recursive: true });
      const defaultAdminConfig = {
        agent_id: 'agent_chat_dev',
        name: '艾吉',
        description: 'AgentChat 平台管理员，负责社区治理与引导新用户',
        tags: ['admin', 'dev'],
        plugins: [{
          name: 'builtin',
          tools: ['read', 'write', 'edit', 'bash', 'web_search', 'code_search', 'reload', 'inspect_session', 'browser', 'math'],
          runStart: ['builtin.open-mcp', 'builtin.build-system-prompt', 'builtin.load-memory', 'builtin.load-history'],
          toolExecutionStart: ['builtin.security-check'],
          toolExecutionEnd: ['builtin.log-tool'],
          runEnd: ['builtin.save-session', 'builtin.update-memory', 'builtin.idle-reset', 'builtin.archive-session', 'builtin.log-usage'],
        }],
      };
      fs.writeFileSync(adminConfigPath, JSON.stringify(defaultAdminConfig, null, 2), 'utf-8');
      logger.info(`[Bootstrap] 首次运行：已创建默认 admin Agent（艾吉）: ${adminConfigPath}`);
    }
    // 写首次运行标记（防止重启重复引导）
    try { fs.writeFileSync(initializedMark, new Date().toISOString(), 'utf-8'); }
    catch { /* ignore */ }
  }

  return isFirstRun;
}

// ============================================================
// WebUI 启动（server 层重建后可启用；未重建时降级）
// ============================================================

async function tryStartWebUI(opts: {
  port: number;
  dataDir: string;
  serviceRegistry: ServiceRegistry;
}): Promise<any | null> {
  try {
    // server 层未重建时动态路径 import 会失败 → 降级；重建后正常装载
    const modPath: string = '../server/index.js';
    const mod = await import(modPath) as { WebUIServer?: new (o: any) => { start(): Promise<void>; stop(): Promise<void> | void } };
    if (!mod.WebUIServer) {
      logger.warn('[Bootstrap] WebUI 模块存在但缺少 WebUIServer，跳过启动');
      return null;
    }
    const server = new mod.WebUIServer({
      serviceRegistry: opts.serviceRegistry,
      dataDir: opts.dataDir,
      port: opts.port,
    });
    await server.start();
    return server;
  } catch (err: any) {
    logger.warn(`[Bootstrap] WebUI 服务器启动失败（server 层可能尚未重建）: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ============================================================
// 主启动函数
// ============================================================

export interface BootstrapOptions {
  enableWebUI?: boolean;
  webuiPort?: number;
  workspace?: string;
}

export interface BootstrapResult {
  router: AgentRouter;
  registry: AgentRegistry;
  globalConfig: Record<string, any>;
  loader: AgentLoader;
  pluginRegistry: PluginRegistry;
  agentService: AgentService;
  groupService: GroupService;
  historyService: HistoryService;
  serviceRegistry: ServiceRegistry;
  rpc: RPCBridge;
  timer?: TimerManager;
  webui: any;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  logger.info('═══════════════════════════════════════');
  logger.info('  AgentChat 正在启动…');
  logger.info('═══════════════════════════════════════');

  // 1. 全局配置（workspace/config.json + 默认值）
  const globalConfig = loadGlobalConfig(options.workspace);

  // 2. 插件装配（builtin/builtin-math；交互桥在 router 创建后注入）
  const pluginRegistry = new PluginRegistry();
  const services: PluginServices = {}; // router 创建后回填
  const assembly = makeAgentAssembly({
    pluginRegistry,
    getRouter: () => router,
    services,
    globalConfig,
  });

  // 3. 创建 Router（内置 Registry + GroupManager）
  const router = new AgentRouter(assembly);
  const registry = router.getRegistry();

  // 3.1 交互桥（绑定 router 事件总线；插件经 PluginServices.interaction 获取）
  const interactionBridge = new InteractionBridge(router);
  setInteractionBridge(interactionBridge);

  // 3.2 插件服务注入（router/interaction 已就绪；复用第 2 步的 pluginRegistry）
  //     同时复用第 2 步的 services 实例——loader.createLLM 写入的 services.llm/tools
  //     必须与 registry 烘焙的工具（spawn_subagent 等读 services.llm）共享同一对象。
  const srcRoot = path.resolve(__dirname, '..');

  // 归档编排（L4 门面：先整理后归档）。runEnd archive-session 钩子经
  // PluginServices.archiveSession 委托 handleRunEnd（整理轮 / 超阈值统一入口）；
  // idle-reset 钩子委托 resetIdleTimer（空闲归档计时器）。
  const archiveService = new ArchiveService({
    wsRoot: globalConfig.workspaceDir,
    agentsDir: globalConfig.agentsDir,
    router,
    registry,
  });
  services.archiveSession = (ctx, result) => archiveService.handleRunEnd(ctx, result);
  services.idleReset = (dialogId, selfId) => {
    // dialogId → agent/counterpart（1v1 排序共享会话键后需显式 selfId 反推）
    if (!selfId) return;
    try {
      const counterpart = counterpartOfDialog(dialogId, selfId);
      if (!counterpart || counterpart === '?') return;
      archiveService.resetIdleTimer(selfId, counterpart);
    } catch { /* ignore */ }
  };

  const pluginSetup = setupPlugins(globalConfig, {
    router,
    interaction: interactionBridge,
    searchProviders: globalConfig.searchProviders,
    agentsDir: globalConfig.agentsDir,
    backupAll: () => {
      const r = createBackup();
      return { skipped: r.skipped ?? false, file: r.file, size: r.size };
    },
    // 批量归档（__archive_all__ 定时特殊 hint；遍历 sessions/chat~* 逐会话 requestArchive）
    archiveAll: () => archiveService.archiveAllActiveSessions(),
  }, pluginRegistry, services);
  const { timer } = pluginSetup;

  // 4. L4 运行时门面注入（server/ws 只 import services）
  initRuntime({ router, requestRestart, globalConfig });

  // 5. 工作区初始化（返回是否首次运行）
  const isFirstRun = ensureWorkspaceFiles(globalConfig.workspaceDir, srcRoot);
  logger.info(`[Bootstrap] 工作区就绪（${isFirstRun ? '首次运行，需引导' : '已有环境'}）`);

  // 6. 加载 Agents → 注册到 Router
  const loader = new AgentLoader(globalConfig);
  const loadedAgents = loader.loadAll();
  for (const { config } of loadedAgents) {
    registry.register(config);
  }
  if (registry.size === 0) {
    logger.warn('[Bootstrap] 未找到任何 Agent，请检查是否创建了 config.json 文件');
  }
  logger.info(`[Bootstrap] ${registry.size} agents registered: ${registry.listIds().join(', ')}`);

  // 6.5 reload-requested 中断的执行体（对齐旧架构 performReload）：
  //     self/all → 重载触发 Agent（重读磁盘配置重新注册，update_agent_profile 等改动立即生效）；
  //     global/all → 重载全部 Agent。当前 run 的工具集由 createAgentContext 的
  //     performReload 包装在 reload 后重烘焙（新工具本轮即可用），loop 继续推理不戛然而止。
  assembly.performReload = (scope, config) => {
    const reloadAgent = (agentId: string) => {
      try {
        const loaded = loader.loadOne(path.join(globalConfig.agentsDir, agentId));
        registry.register(loaded.config);
        logger.info(`[Reload] Agent "${agentId}" 已热重载`);
      } catch (err: any) {
        logger.warn(`[Reload] Agent "${agentId}" 热重载失败: ${err?.message ?? String(err)}`);
      }
    };
    if (scope === 'self' || scope === 'all') {
      reloadAgent(config.agent_id);
    }
    if (scope === 'global' || scope === 'all') {
      for (const id of registry.listIds()) reloadAgent(id);
    }
  };

  // 6.6 system_restart 工具的 restart-requested 中断 → 请求后端重启
  //     （Supervisor 模式以退出码 42 由父进程拉起；非托管退化为退出）。
  assembly.requestRestart = (reason) => requestRestart(reason);

  // 7. L4 服务装配
  const serviceRegistry = new ServiceRegistry();

  // L3 插件声明服务 → L4 ServiceRegistry 自动发现注册（解耦：L4 统一经注册表
  // 取用插件服务，无需 L5 逐个手动注入 PluginServices / L4 内散落 useService）。
  serviceRegistry.registerPluginServices(pluginRegistry);

  const agentService = new AgentService({
    registry,
    loader,
    agentRouter: router,
    pluginRegistry,
    timer,
    pluginServices: pluginSetup.services,
    // L3 插件服务已批量注册进 serviceRegistry（上方循环），AgentService 统一经注册表取用
    serviceRegistry,
  });
  serviceRegistry.register('agentService', agentService);

  const groupService = new GroupService(router.getGroupManager(), globalConfig.workspaceDir);
  groupService.loadGroupsFromDisk(); // 群组落盘恢复（Agent 已注册）
  serviceRegistry.register('groupService', groupService);

  const historyService = new HistoryService({
    wsRoot: globalConfig.workspaceDir,
    // 手工归档（session.archive / session.compress）→ requestArchive（先整理后归档）
    archive: (agent, counterpart) => archiveService.requestArchive(agent, counterpart),
  });
  serviceRegistry.register('historyService', historyService);

  // RPC 桥（agent/group/history 映射为 RPC 方法，供 WS 层分发）
  const rpc = new RPCBridge(serviceRegistry);
  rpc.registerService('agent', agentService);
  rpc.registerService('group', groupService);
  rpc.registerService('history', historyService);

  // 插件管理适配器（webui /api/plugins 用；替代旧 pluginLoader 服务）
  serviceRegistry.register('pluginManager', makePluginManager(pluginSetup.pluginRegistry, registry));

  // 8. 关闭依赖注入（router 域 → 插件域 → WebUI）
  setShutdownDeps({
    router,
    timer,
    subAgent: pluginSetup.subAgent,
    interaction: interactionBridge,
    webui: null,
  });

  // 9. 定时任务启动（读取 Agent config.json 的 timer 命名空间 + 全局 chime）
  try {
    timer?.reloadAll();
  } catch (err: any) {
    logger.warn(`[Bootstrap] 定时任务启动失败: ${err?.message ?? String(err)}`);
  }

  // 10. 重启后 flush pending 消息（上次 gracefulShutdown 进入重启模式时入队的）
  try {
    const flushed = await router.flushPendingMessages();
    if (flushed > 0) logger.info(`[Bootstrap] 已重投 ${flushed} 条 pending 消息`);
  } catch (err: any) {
    logger.warn(`[Bootstrap] flush pending 消息失败: ${err?.message ?? String(err)}`);
  }

  // 11. 可选：启动 WebUI Server（未重建时降级为 null）
  let webui: any = null;
  if (options.enableWebUI !== false) {
    webui = await tryStartWebUI({
      port: options.webuiPort ?? 3830,
      dataDir: globalConfig.workspaceDir,
      serviceRegistry,
    });
  }
  setShutdownDeps({
    router, timer, subAgent: pluginSetup.subAgent, interaction: interactionBridge, webui,
    archive: archiveService,
  });

  // 归档超时降级监视（清理重启残留 pending；启动立即一次 + 每 5 分钟）
  archiveService.startArchiveTimeoutWatcher();

  // 12. 首次运行：直接向 user↔艾吉 会话注入自我介绍消息
  //     （不能 router.trigger —— 首次运行还没有配置全局 LLM，Agent 无法执行，
  //       触发会静默空跑；直接写会话文件让用户在 WebUI 立即可见）
  if (isFirstRun) {
    try {
      const introMessage =
        '你好，我是艾吉 🤝 AgentChat 平台的守护者。\n' +
        '这是你第一次启动 AgentChat，我们聊聊怎么开始：\n' +
        '1. 配置全局 LLM：WebUI 左侧「设置」→「模型管理」添加 Provider 并填 API Key，这是所有 Agent 的思考引擎；\n' +
        '2. 创建第一个 Agent：WebUI「新建 Agent」，给它一个身份和职责，体验 Agent 社区；\n' +
        '3. 配置完成后回来找我，我会带新 Agent 跟你打招呼，展示社区的活力。\n' +
        '期待与你一起把社区经营得热闹起来！';
      const dialogKey = chatDialogKey('agent_chat_dev', 'user');
      const sessionDir = path.join(globalConfig.workspaceDir, 'sessions', dialogKey);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'messages.jsonl');
      const entry = {
        role: 'agent',
        content: introMessage,
        agent_id: 'agent_chat_dev',
        message_id: genMessageId(),
        timestamp: new Date().toISOString(),
      };
      // 幂等：会话已有内容则跳过（避免重复注入）
      if (!fs.existsSync(sessionFile) || fs.readFileSync(sessionFile, 'utf-8').trim() === '') {
        fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n', 'utf-8');
        logger.info(`[Bootstrap] 首次运行：已注入艾吉自我介绍到 ${sessionFile}`);
      }
    } catch (err: any) {
      logger.warn(`[Bootstrap] 首次引导消息注入失败: ${err?.message ?? String(err)}`);
    }
  }

  logger.info('[Bootstrap] [OK] Ready.');
  return { router, registry, globalConfig, loader, pluginRegistry, agentService, groupService, historyService, serviceRegistry, rpc, timer, webui };
}

// ============================================================
// CLI 参数解析 + 直接运行入口
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

/** 直接运行时启动（仅在作为主入口运行时触发，被 import 时不执行） */
function isMainModule(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('index.ts') || entry.endsWith('index.js');
}

if (isMainModule()) {
  const cli = parseCLIArgs();
  bootstrap({
    enableWebUI: cli.enableWebUI,
    webuiPort: cli.webuiPort,
    workspace: cli.workspace,
  }).then(() => {
    // 注册优雅关闭信号（Supervisor 模式：42 重启，0 正常退出）
    process.on('SIGINT', () => { void gracefulShutdown(0, 'SIGINT'); });
    process.on('SIGTERM', () => { void gracefulShutdown(0, 'SIGTERM'); });
  }).catch((err) => {
    logger.error('[Bootstrap] Fatal error:', err);
    process.exit(1);
  });
}

// ============================================================
// 导出
// ============================================================

export { gracefulShutdown, requestRestart, EXIT_RESTART, setShutdownDeps } from './shutdown';
export {
  AgentLoader, loadGlobalConfig, resolveLLMPool, resolveSearchPool,
  setupPlugins, makeAgentAssembly, makePluginManager, buildGlobalBase, workspaceRoot,
} from './loader';
export { AgentRouter } from '@agents/router';
export { AgentRegistry } from '@agents/registry';
export { GroupManager } from '@agents/group';
export type { AgentConfig } from '@agents/config';
