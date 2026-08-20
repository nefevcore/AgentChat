// ============================================================
// @agentchat/boot/src/loader-boot.ts —— dev/Loader 路径主入口
//
// 用法：pnpm dev [--patch extra.yml ...]
// 取代直接挂 vendor cordis/bin.js：空 root + 分层补丁组合（DSH 形态），
// 用户层/机器层变化热重组合（不重启进程）。
//
// 与 dist 路径（bootstrap.ts 直调装配）的关系不变：本文件只在
// 仓库 dev / Loader 场景使用；dist 单文件不含 Loader。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@agentchat/util';
import { pluginsRoot } from '@agentchat/plugins';
import { workspaceRoot, acquireRuntime, describeRuntime, legacyTimerHolder, releaseRuntime } from '@agentchat/toolkit';
import {
  agentchatHome, bootComposed, composeLayers, dumpComposedYaml, isBundleProfile,
  watchPatchLayers, type BundleProfile,
} from './composition';
import { EXIT_CONFIG, gracefulShutdown } from './shutdown';
import { defaultWorkspaceDir, setBootProfile } from './instance';

const logger = createLogger('[loader-boot]');

/** 组合树就绪信号（ready）：此后失败不再归 78（supervisor 按崩溃退避处置） */
let bootReady = false;

interface LaunchArgs {
  overlays: string[];
  rest: string[];
  dump?: 'config' | 'default-config';
  profile: BundleProfile;
  /** 显式工作区（--workspace <dir>；进 env 供全部下游解析） */
  workspace?: string;
}

/** 解析 --patch / --workspace / --dump-config / --dump-default-config / --profile；其余参数透传 */
function parseArgs(argv: string[]): LaunchArgs {
  const overlays: string[] = [];
  const rest: string[] = [];
  let dump: LaunchArgs['dump'];
  // 缺省 web-app：向后兼容（拆分前 base bundle 内焊有 webui 行）
  let profile: BundleProfile = 'web-app';
  let workspace: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--patch') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --patch 需要一个补丁文件路径');
        process.exit(2);
      }
      overlays.push(value);
    } else if (arg === '--workspace') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --workspace 需要一个目录路径');
        process.exit(2);
      }
      workspace = value;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
      if (!workspace) {
        console.error('error: --workspace 需要一个目录路径');
        process.exit(2);
      }
    } else if (arg === '--profile') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --profile 需要一个 profile 名（base / web-app）');
        process.exit(2);
      }
      if (!isBundleProfile(value)) {
        console.error(`error: 未知 profile "${value}"（可用：base / web-app）`);
        process.exit(2);
      }
      profile = value;
    } else if (arg === '--dump-config') {
      dump = 'config';
    } else if (arg === '--dump-default-config') {
      dump = 'default-config';
    } else {
      rest.push(arg);
    }
  }
  if (dump && dump === 'config' && argv.includes('--dump-default-config')) {
    console.error('error: --dump-config 与 --dump-default-config 互斥');
    process.exit(2);
  }
  return { overlays, rest, dump, profile, workspace };
}

async function main(): Promise<void> {
  const { overlays, dump, profile, workspace } = parseArgs(process.argv.slice(2));
  // --workspace 进 env：owner 门禁/组合 market 层/finalize 注册表/工具沙箱全部
  // 经同一解析链（toolkit workspaceRoot 单一事实源）
  if (workspace) process.env.AGENTCHAT_WORKSPACE = workspace;
  const profileDir = process.cwd();

  // 离线打印有效组合（不 boot）：所见即所启
  if (dump) {
    const text = await dumpComposedYaml({
      profileDir,
      overlays,
      profile,
      mode: dump === 'config' ? 'full' : 'default',
    });
    // 显式退出：dump 路径可能触碰的模块（market registry 等）留下句柄
    // （ConnectWrap/PipeWrap），自然退出不会发生。写完 flush 再退，防管道截断。
    process.stdout.write(text, () => process.exit(0));
    return;
  }

  // P2 owner 门禁：原子获取 workspace 运行时标识 .runtime（wx 排他创建，
  // 消灭 check-then-boot 的双启 TOCTOU 窗口）。他进程活持有 → 拒绝第二棵
  // 组合树；旧版本进程只写 timer-instance.lock → 迁移 shim 同样可见。
  // 陈旧持有者（pid 死）在获取内自动清理重建。锁文件不可写（degraded）→
  // 警告后继续（与旧语义一致，EADDRINUSE 兜底）。
  const gateDir = defaultWorkspaceDir();
  const rt = acquireRuntime(gateDir, { kind: profile, profile, workspaceDir: gateDir });
  const legacy = legacyTimerHolder(gateDir);
  if (rt.status === 'blocked' || legacy?.alive) {
    const who = rt.status === 'blocked'
      ? describeRuntime(rt.holder)
      : `pid=${legacy!.pid}（旧版本实例，timer-instance.lock）`;
    logger.error(`已有 AgentChat 实例运行中（${who}），拒绝启动第二棵组合树。`);
    if (rt.status === 'blocked' && rt.holder.port) {
      logger.error(`WebUI: http://localhost:${rt.holder.port}；CLI: agentchat headless --to <agentId> <提示词…>`);
    }
    logger.error('如确需第二个实例：换 workspace（--workspace <dir> 或 AGENTCHAT_WORKSPACE）。');
    releaseRuntime(gateDir); // 自己刚获取到的（legacy 场景）不留陈旧标识
    // 启动期配置类失败（他实例持有不会自愈）→ 78：supervisor 不重拉（§5.2）
    process.exit(EXIT_CONFIG);
  }
  if (rt.degraded) {
    logger.warn('.runtime 获取降级（不可写），双实例保护失效，端口冲突将兜底');
  }

  setBootProfile(profile); // 运行时标识记录 boot profile（finalize 补写）
  const booted = await bootComposed({
    profileDir,
    overlays,
    profile,
    enableLogs: process.env.AGENTCHAT_COMPOSE_LOGS === '1',
    onContext(ctx) {
      // 组合树自举完成后由各行插件自行启动服务；此处只放全局启动环境
      (ctx as any).cmdlineArgs = { overlays, profile, argv: process.argv.slice(2) };
    },
  });
  bootReady = true; // ready 之后失败 = 运行期问题（崩溃类，非 78 配置类）

  // 用户层/机器层热生效：文件变化 → 重组合 → include.refresh
  // （bundle 层随源码走，改动经 supervisor/dev 流程重启，不参与 watch）
  // 固定路径无条件监视——文件此刻为空/不存在也要 watch，否则用户首次
  // 写入内容不会热生效（loadPatchLayer 对空层返回 undefined 的坑）。
  const userFiles = [
    path.join(profileDir, 'cordis.patch.yml'),
    path.join(agentchatHome(), 'cordis.patch.yml'),
  ];
  if (userFiles.length > 0) {
    // registry.json 也入监视：市场安装/卸载（CLI 或 WebUI）→ market 动态层
    // 增删行 → 热重组合（新行经桥装载，行回收即卸载）。路径经 workspaceRoot
    // 单一事实源（--workspace/env/cwd 已有/机器 home 四级解析一致）
    const registryFile = path.join(pluginsRoot(workspaceRoot()), 'registry.json');
    const watched = fs.existsSync(registryFile)
      ? [...userFiles, registryFile]
      : userFiles;
    watchPatchLayers(watched, () => {
      composeLayers({ profileDir, overlays, profile }).then((next) =>
        booted.reapply(next.patches),
      ).then(
        () => logger.info('组合输入已变化，树已热更新'),
        (err: any) => logger.error(`组合树热更新失败（保留旧树）: ${err?.message ?? String(err)}`),
      );
    });
    logger.info(`监视组合输入热更新: ${watched.join(', ')}`);
  }

  logger.info(`组合树已启动（profile: ${profile}，root: ${profileDir}）`);
}

main().then(() => {
  // 统一 worker 信号接线：dev/Loader 路径与 dist 直启（bootstrap.ts）一致——
  // Ctrl+C / supervisor 转发 SIGTERM 走 gracefulShutdown（会话落盘后再退），
  // 不再硬退出丢消息。gracefulShutdown 自带 in-flight 幂等守卫（双达安全）。
  process.on('SIGINT', () => { void gracefulShutdown(0, 'SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown(0, 'SIGTERM'); });
}).catch((err) => {
  logger.error(`启动失败: ${err?.stack ?? String(err)}`);
  // ready 之前的失败 = 配置/组合类（不会自愈）→ 78：supervisor 不重拉，
  // 消灭「补丁层写错一个字段 → 每 1.5s 无限重拉」死循环（restart-design §5.2）。
  process.exitCode = bootReady ? 1 : EXIT_CONFIG;
});
