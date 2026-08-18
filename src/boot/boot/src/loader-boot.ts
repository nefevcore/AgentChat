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
import * as path from 'path';
import { createLogger } from '@agentchat/util';
import { agentchatHome, bootComposed, composeLayers, watchPatchLayers } from './composition';

const logger = createLogger('[loader-boot]');

interface LaunchArgs {
  overlays: string[];
  rest: string[];
}

/** 解析 --patch（可重复）；其余参数原样透传（未来交组合树内插件解析） */
function parseArgs(argv: string[]): LaunchArgs {
  const overlays: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--patch') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --patch 需要一个补丁文件路径');
        process.exit(2);
      }
      overlays.push(value);
    } else {
      rest.push(arg);
    }
  }
  return { overlays, rest };
}

async function main(): Promise<void> {
  const { overlays } = parseArgs(process.argv.slice(2));
  const profileDir = process.cwd();

  const booted = await bootComposed({
    profileDir,
    overlays,
    enableLogs: process.env.AGENTCHAT_COMPOSE_LOGS === '1',
    onContext(ctx) {
      // 组合树自举完成后由各行插件自行启动服务；此处只放全局启动环境
      (ctx as any).cmdlineArgs = { overlays, argv: process.argv.slice(2) };
    },
  });

  // 用户层/机器层热生效：文件变化 → 重组合 → include.refresh
  // （bundle 层随源码走，改动经 supervisor/dev 流程重启，不参与 watch）
  // 固定路径无条件监视——文件此刻为空/不存在也要 watch，否则用户首次
  // 写入内容不会热生效（loadPatchLayer 对空层返回 undefined 的坑）。
  const userFiles = [
    path.join(profileDir, 'cordis.patch.yml'),
    path.join(agentchatHome(), 'cordis.patch.yml'),
  ];
  if (userFiles.length > 0) {
    watchPatchLayers(userFiles, () => {
      const next = composeLayers({ profileDir, overlays });
      booted.reapply(next.patches).then(
        () => logger.info('补丁层已变化，组合树已热更新'),
        (err: any) => logger.error(`组合树热更新失败（保留旧树）: ${err?.message ?? String(err)}`),
      );
    });
    logger.info(`监视补丁层热更新: ${userFiles.join(', ')}`);
  }

  logger.info(`组合树已启动（profile: ${profileDir}）`);
}

main().catch((err) => {
  logger.error(`启动失败: ${err?.stack ?? String(err)}`);
  process.exitCode = 1;
});
