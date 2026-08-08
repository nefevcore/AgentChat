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
import { PluginRegistry } from '@plugins/registry';
import type { PluginServices } from '@plugins/types';
import type { TimerManager } from '@plugins/builtin/services/timer';
import {
  AgentLoader, loadGlobalConfig, setupPlugins, makeAgentAssembly, makePluginManager,
} from './loader';
import {
  AgentService, GroupService, HistoryService, ServiceRegistry, RPCBridge,
  InteractionBridge, initRuntime,
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
  historyService: HistoryService;
  agentService: AgentService;
  groupService: GroupService;
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
      historyService: opts.historyService,
      serviceRegistry: opts.serviceRegistry,
      agentService: opts.agentService,
      groupService: opts.groupService,
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
  const srcRoot = path.resolve(__dirname, '..');
  const pluginSetup = setupPlugins(globalConfig, {
    router,
    interaction: interactionBridge,
    searchProviders: globalConfig.searchProviders,
    agentsDir: globalConfig.agentsDir,
    backupAll: () => {
      const r = createBackup();
      return { skipped: r.skipped ?? false, file: r.file, size: r.size };
    },
    // archiveAll: 归档实现待 L3/L5 后续注入
  }, pluginRegistry);
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

  // 7. L4 服务装配
  const serviceRegistry = new ServiceRegistry();
  const agentService = new AgentService({
    registry,
    loader,
    agentRouter: router,
    pluginRegistry,
    timer,
    pluginServices: pluginSetup.services,
  });
  serviceRegistry.register('agentService', agentService);

  const groupService = new GroupService(router.getGroupManager(), globalConfig.workspaceDir);
  groupService.loadGroupsFromDisk(); // 群组落盘恢复（Agent 已注册）
  serviceRegistry.register('groupService', groupService);

  const historyService = new HistoryService({ wsRoot: globalConfig.workspaceDir });
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
      historyService,
      agentService,
      groupService,
    });
  }
  setShutdownDeps({ router, timer, subAgent: pluginSetup.subAgent, interaction: interactionBridge, webui });

  // 12. 首次运行：触发艾吉的自我介绍与引导
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
        .then(() => logger.info('[Bootstrap] 已触发艾吉的首次引导自我介绍'))
        .catch((err: any) => logger.warn(`[Bootstrap] 触发首次引导失败: ${err?.message ?? String(err)}`));
    } catch (err: any) {
      logger.warn(`[Bootstrap] 首次引导初始化失败: ${err?.message ?? String(err)}`);
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
