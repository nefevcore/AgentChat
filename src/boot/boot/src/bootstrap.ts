// ============================================================
// AgentChat 主入口 —— 启动流程（L5，唯一有副作用层）
//
// 启动流程（块 A 之后）：
//   1. 加载环境变量 + 全局配置（workspace/config.json）
//   2. 核心能力（agentLoop/llm/tools/hooks + 能力行）就绪
//   3. boot 核心装配行：Assembly/Router/Registry/Loader/services → ctx.bootstrap
//   4. 域插件行依次激活：workspace → archive → timer → subagent → server L4
//   5. boot 收尾接线行：PluginManager/timer 启动/pending flush/archive watcher/webServerHost
//   6. 可选 WebUI 插件行（直接调用路径）；Loader 路径由 cordis.yml 自行装载
//
// 本文件不再 `new` 任何业务服务：所有构造都发生在各自插件行内。
// ============================================================

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@agentchat/util';
import { Context } from '@agentchat/cordis';
import type { AgentRouter } from '@agentchat/router';
import type { AgentRegistry } from '@agentchat/agents';
import type { AgentConfig } from '@agentchat/agent-config';
import type { TimerManager } from '@agentchat/timer';
import type { SubAgentManager } from '@agentchat/subagent';
import type { WebUIServer } from '@agentchat/server';
import type {
  AgentService, GroupService, HistoryService, ServiceRegistry, RPCBridge,
} from '@agentchat/server';
import { gracefulShutdown, requestRestart, setShutdownDeps, EXIT_CONFIG } from './shutdown';
import { registerCoreServices } from './register-core';
import { acquireRuntime, describeRuntime, legacyTimerHolder, releaseRuntime } from '@agentchat/toolkit';
import {
  AgentLoader, loadGlobalConfig, resolveLLMPool, resolveSearchPool,
  setupPlugins, makeAgentAssembly, makePluginManager, buildGlobalBase, workspaceRoot,
} from './loader';

import { bundleRow } from './bundle-rows.gen';

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
// 主启动函数（直接调用路径 = 测试/CLI；Loader 路径走 cordis.yml 各行）
// ============================================================

export interface BootstrapOptions {
  enableWebUI?: boolean;
  webuiPort?: number;
  workspace?: string;
  /** Loader 场景由 @agentchat/webui 插件行自行启动 WebUI；bootstrap 只准备 webServerHost */
  deferWebUI?: boolean;
  /** cordis 上下文（可选；缺省创建 root Context 并走完整插件行装配） */
  ctx?: Context;
}

export interface BootstrapResult {
  router: AgentRouter;
  registry: AgentRegistry;
  globalConfig: Record<string, any>;
  loader: AgentLoader;
  agentService: AgentService;
  groupService: GroupService;
  historyService: HistoryService;
  serviceRegistry: ServiceRegistry;
  rpc: RPCBridge;
  timer?: TimerManager;
  subAgent?: SubAgentManager;
  webui: WebUIServer | null;
}

/** 读取插件行装配结果（ctx 服务面） */
function collectResult(ctx: Context): Omit<BootstrapResult, 'webui'> {
  const core = ctx.bootstrap;
  const l4 = ctx.l4;
  return {
    router: core.router,
    registry: core.registry,
    globalConfig: core.globalConfig,
    loader: core.loader,
    agentService: l4.agentService,
    groupService: l4.groupService,
    historyService: l4.historyService,
    serviceRegistry: l4.serviceRegistry,
    rpc: l4.rpc,
    timer: ctx.timerManager?.manager,
    subAgent: ctx.subagent?.manager,
  };
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  logger.info('═══════════════════════════════════════');
  logger.info('  AgentChat 正在启动…');
  logger.info('═══════════════════════════════════════');

  // 0. workspace 运行时标识（.runtime）：程序化路径幂等获取（CLI 入口已拿过则
  //    缓存命中）。他进程活持有 → fail-open 继续（与旧 timer 锁语义一致：树照常
  //    boot、定时调度跳过）；测试/嵌入通常在独立 tmp workspace，获取即成功。
  const rtDir = workspaceRoot(options.workspace);
  const rt = acquireRuntime(rtDir, { kind: 'embedded', profile: 'embedded', workspaceDir: rtDir });
  if (rt.status === 'blocked') {
    logger.warn(`workspace 已被实例 pid=${rt.holder.pid} 运行（${rtDir}）：本进程定时调度与配置写入将跳过`);
  }

  // 1. cordis 上下文：直接调用时惰性创建；Loader 场景传入的 ctx 已有能力行
  const bootCtx = options.ctx ?? new Context();
  if (!bootCtx.llm || !bootCtx.tools || !bootCtx.hooks) {
    await registerCoreServices(bootCtx);
  }

  // 2. boot 核心装配行（幂等：ctx.bootstrap 已存在则跳过）
  if (!bootCtx.get('bootstrap')) {
    await bootCtx.plugin(bundleRow('boot-core').module as any, { workspace: options.workspace });
  }

  // 2.5 HTTP 路由注册表（L3 宿主注册口；业务路由由各域行注册）
  if (!bootCtx.get('http')) {
    await bootCtx.plugin(bundleRow('http-host').module as any);
  }

  // 3. 域插件行（每个构造收敛在各自包；此函数只做装配顺序）
  if (!bootCtx.get('workspace')) await bootCtx.plugin(bundleRow('workspace-init').module as any);
  if (!bootCtx.get('archive')) await bootCtx.plugin(bundleRow('archive').module as any);
  if (!bootCtx.get('timerManager')) await bootCtx.plugin(bundleRow('timer-service').module as any);
  if (!bootCtx.get('subagent')) await bootCtx.plugin(bundleRow('subagent-service').module as any);
  if (!bootCtx.get('l4')) await bootCtx.plugin(bundleRow('server-l4').module as any);

  // 4. boot 收尾接线行（PluginManager/timer 启动/pending flush/archive watcher/webServerHost）
  const webuiEnabled = options.enableWebUI !== false;
  if (!bootCtx.get('webServerHost')) {
    await bootCtx.plugin(bundleRow('boot-finalize').module as any, {
      enableWebUI: webuiEnabled,
      webuiPort: options.webuiPort ?? 3830,
    });
  }

  // 4.5 传输层通用路由 + 插件域路由（inject http/pluginManager；必须在 finalize 之后 await）
  await bootCtx.plugin(bundleRow('http-routes').module as any);
  await bootCtx.plugin(bundleRow('plugins-http').module as any);
  // 市场路由行（inject http+market）：与插件域路由同批——http 服务已在 2.5 就绪；
  // register-core 内 await 会因 inject PENDING 挂死，故挂载在此。
  await bootCtx.plugin(bundleRow('market-http').module as any);

  // 5. 直接调用路径启动 WebUI（Loader 路径 deferWebUI=true，由 cordis.yml 的 webui 行启动）
  let webui: WebUIServer | null = null;
  if (webuiEnabled && options.deferWebUI !== true) {
    try {
      await bootCtx.plugin(bundleRow('webui').module as any, { webuiPort: options.webuiPort ?? 3830 });
      const serverService = bootCtx.get('server') as { server: WebUIServer } | undefined;
      webui = serverService?.server ?? null;
    } catch (err: any) {
      logger.warn(`[Bootstrap] WebUI 启动失败（纯 API 降级）: ${err?.message ?? String(err)}`);
      webui = null;
    }
  }

  // 6. shutdown 依赖补齐 WebUI 实例（gracefulShutdown 需要 stop）
  setShutdownDeps({
    ...(bootCtx.get('l4') ? {
      router: bootCtx.bootstrap.router,
      timer: bootCtx.timerManager?.manager,
      subAgent: bootCtx.subagent?.manager,
      interaction: bootCtx.l4.interactionBridge,
      archive: bootCtx.archive?.manager,
      workspaceDir: bootCtx.bootstrap.workspaceDir,
    } : {}),
    webui,
  });

  logger.info('[Bootstrap] [OK] Ready.');
  return { ...collectResult(bootCtx), webui };
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

/** 直接运行时启动（仅在作为主入口运行时触发，被 import 时不执行）。
 *  严格 URL 判定：vitest/tsx 等场景 argv[1] 是 runner 入口（.mjs 结尾），
 *  旧的"后缀即真"判定会在测试 worker import 本模块时触发幻影 boot
 *  （抢 workspace/timer 锁 → 测试间歇性失败）。 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const cli = parseCLIArgs();
  // P2 owner 门禁（dist 直启路径）：原子获取 .runtime + 旧版本进程 shim。
  // 程序化 bootstrap() 不经此门禁（fail-open）。
  const gateDir = workspaceRoot(cli.workspace);
  const rt = acquireRuntime(gateDir, { kind: 'web-app', profile: 'web-app', workspaceDir: gateDir });
  const legacy = legacyTimerHolder(gateDir);
  if (rt.status === 'blocked' || legacy?.alive) {
    const who = rt.status === 'blocked'
      ? describeRuntime(rt.holder)
      : `pid=${legacy!.pid}（旧版本实例，timer-instance.lock）`;
    logger.error(`已有 AgentChat 实例运行中（${who}）。`);
    logger.error('WebUI: 打开对应端口；CLI: agentchat headless --to <agentId> <提示词…>');
    logger.error('如确需第二个实例：换 workspace（--workspace=<dir>）。');
    releaseRuntime(gateDir); // 自己刚获取到的（legacy 场景）不留陈旧标识
    process.exit(EXIT_CONFIG); // 启动期配置类失败：78（supervisor 不重拉）
  }
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
    // 启动期失败 = 配置类（不会自愈）→ 78：supervisor 不重拉（restart-design §5.2）
    process.exit(EXIT_CONFIG);
  });
}

// ============================================================
// 导出
// ============================================================

export { gracefulShutdown, requestRestart, EXIT_RESTART, EXIT_CONFIG, setShutdownDeps } from './shutdown';
export {
  AgentLoader, loadGlobalConfig, resolveLLMPool, resolveSearchPool,
  setupPlugins, makeAgentAssembly, makePluginManager, buildGlobalBase, workspaceRoot,
} from './loader';
export { AgentRouter } from '@agentchat/router';
export { AgentRegistry } from '@agentchat/agents';
export { GroupManager } from '@agentchat/router';
export type { AgentConfig } from '@agentchat/agent-config';
