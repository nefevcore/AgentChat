// ============================================================
// @agentchat/boot/src/plugin-finalize.ts —— boot 收尾接线行（L2）
//
// 域插件（workspace/archive/timer/subagent/server）都已激活后，本行完成：
//   · runtime.requestRestart 实际注入（shutdown 域）
//   · PluginManager 注册进 ServiceRegistry（webui /api/plugins 消费）
//   · shutdown deps 接线
//   · timer 启动 / pending flush / archive 超时 watcher
//   · ctx.webServerHost（@agentchat/webui 插件行 inject 后自行启动 HTTP/WS）
//
// 本行不 new 任何业务服务；它只做接线。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { WebServerHostService, setRequestRestart } from '@agentchat/server';
import { makePluginManager } from './loader';
import { bootProfile, writeInstance } from './instance';
import { PluginManagerService } from './plugin-manager-service';
import { requestRestart, setShutdownDeps } from './shutdown';

export const name = 'agentchat-bootstrap-finalize';

/** boot-finalize 依赖：全部域服务已提供 */
export const inject = ['bootstrap', 'workspace', 'archive', 'timerManager', 'subagent', 'l4'];

export interface Config {
  /** 是否启用 WebUI（默认：未设 AGENTCHAT_NO_WEBUI=1 时启用） */
  enableWebUI?: boolean;
  /** WebUI 端口（默认 3830） */
  webuiPort?: number;
}

export function apply(ctx: Context, config: Config = {}) {
  const logger = ctx.logger('boot');
  const core = ctx.bootstrap;
  const l4 = ctx.l4;

  // 1. shutdown 域请求重启（RPC/工具走 services/runtime 门面）
  setRequestRestart((reason) => requestRestart(reason));

  // 2. PluginManager（webui /api/plugins 经 serviceRegistry 发现；
  //    同时注册为 ctx.pluginManager，/api/plugins 路由行按 inject 等待本服务）
  const pluginManager = makePluginManager(core.registry, core.globalConfig, ctx, { agentService: l4.agentService });
  l4.serviceRegistry.register('pluginManager', pluginManager);
  new PluginManagerService(ctx, pluginManager);

  // 3. 关闭依赖接线（router 域 → 插件域 → WebUI；webui 实例由插件行启动后经 ServerService 读取）
  setShutdownDeps({
    router: core.router,
    timer: ctx.timerManager.manager,
    subAgent: ctx.subagent.manager,
    interaction: l4.interactionBridge,
    webui: null,
    archive: ctx.archive.manager,
    workspaceDir: core.workspaceDir,
  });

  // 4. 定时任务启动（读取 Agent config.json 的 timer 命名空间 + 全局 chime）
  try {
    ctx.timerManager.manager.reloadAll();
  } catch (err: any) {
    logger.warn(`定时任务启动失败: ${err?.message ?? String(err)}`);
  }

  // 5. 重启后 flush pending 消息（后台执行；不阻塞 WebUI 启动）
  try {
    void core.router.flushPendingMessages().then((flushed: number) => {
      if (flushed > 0) logger.info(`已重投 ${flushed} 条 pending 消息`);
    }).catch((err: any) => {
      logger.warn(`flush pending 消息失败: ${err?.message ?? String(err)}`);
    });
  } catch (err: any) {
    logger.warn(`flush pending 消息失败: ${err?.message ?? String(err)}`);
  }

  // 6. 归档超时降级监视（启动立即一次 + 每 5 分钟）
  ctx.archive.manager.startArchiveTimeoutWatcher();

  // 7. WebUI 宿主契约：webui 插件行 inject webServerHost 后自行启动
  const noWebUI = process.env.AGENTCHAT_NO_WEBUI === '1';
  const webuiEnabled = config.enableWebUI ?? !noWebUI;
  new WebServerHostService(
    ctx,
    l4.serviceRegistry,
    core.workspaceDir,
    config.webuiPort ?? 3830,
    webuiEnabled,
  );

  // 8. 实例注册表（P2 多入口共享后端）：owner 装配完成后登记本实例，
  //    client 表面（agentchat headless）据此发现并连 WS。优雅退出由
  //    gracefulShutdown 清理；崩溃残留由 pid 活性检查兜底。
  //    VITEST 场景不写：测试树不该污染真实 workspace 的注册表
  //    （e2e 显式开 AGENTCHAT_INSTANCE_E2E=1 验证本接线）。
  if (!process.env.VITEST || process.env.AGENTCHAT_INSTANCE_E2E === '1') {
    try {
      writeInstance(core.workspaceDir, {
        pid: process.pid,
        port: config.webuiPort ?? 3830,
        profile: bootProfile(),
        workspaceDir: core.workspaceDir,
        startedAt: new Date().toISOString(),
        nodeVersion: process.version,
      });
      logger.info(`实例注册表已写入（pid=${process.pid} port=${config.webuiPort ?? 3830}）`);
    } catch (err: any) {
      logger.warn(`写实例注册表失败（client 表面将无法发现本实例）: ${err?.message ?? String(err)}`);
    }
  }

  logger.info('AgentChat boot 收尾接线完成（timer/pending/archive/webServerHost）');
}
