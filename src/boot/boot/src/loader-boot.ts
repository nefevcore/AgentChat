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
import {
  agentchatHome, bootComposed, composeLayers, dumpComposedYaml, isBundleProfile,
  watchPatchLayers, type BundleProfile,
} from './composition';

const logger = createLogger('[loader-boot]');

interface LaunchArgs {
  overlays: string[];
  rest: string[];
  dump?: 'config' | 'default-config';
  profile: BundleProfile;
}

/** 解析 --patch（可重复）/ --dump-config / --dump-default-config / --profile；其余参数透传 */
function parseArgs(argv: string[]): LaunchArgs {
  const overlays: string[] = [];
  const rest: string[] = [];
  let dump: LaunchArgs['dump'];
  // 缺省 web-app：向后兼容（拆分前 base bundle 内焊有 webui 行）
  let profile: BundleProfile = 'web-app';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--patch') {
      const value = argv[++i];
      if (!value) {
        console.error('error: --patch 需要一个补丁文件路径');
        process.exit(2);
      }
      overlays.push(value);
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
  return { overlays, rest, dump, profile };
}

async function main(): Promise<void> {
  const { overlays, dump, profile } = parseArgs(process.argv.slice(2));
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
    // 增删行 → 热重组合（新行经桥装载，行回收即卸载）
    const registryFile = path.join(pluginsRoot(process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default'), 'registry.json');
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

main().catch((err) => {
  logger.error(`启动失败: ${err?.stack ?? String(err)}`);
  process.exitCode = 1;
});
