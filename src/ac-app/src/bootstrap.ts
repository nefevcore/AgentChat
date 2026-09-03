// ============================================================
// ac-app/src/bootstrap.ts —— dist 直调发布入口（npm 包形态）
//
// 与 boot.ts（Loader 装配路径）的分工：
//   · boot.ts = 仓库/开发形态：Loader + include 读 ./cordis.yml，
//     行模块按裸包名从 node_modules 动态解析——发布包无 node_modules，
//     此路径在 dist 不可用；
//   · bootstrap.ts = 发布形态：行表来自本包 TREE（静态 import 全量行，
//     esbuild 打成单文件 dist/agentchat.mjs；行集与 cordis.yml 由
//     tree.test.ts「双表一致」守护锁定，不会漂移）。
//
// 与 boot.ts 的语义对齐（逐条）：
//   1. 数据根锚定：INIT_CWD（pnpm/npm 脚本环境）回落 process.cwd()，
//      写 AGENTCHAT_DATA_ROOT（已设则尊重；显式入参最高）；
//   2. 行偏好层：<dataRoot>/cordis.patch.yml fail-soft 读入，disabled 行
//      不装配（loader 路径由 include patches 实现，此处等价跳过）；
//   3. 单实例锁：锁文件锚定**数据根**（dev 路径锚 trackDir=src/——dist
//      包目录可能只读，且双写者冲突的本源就是同数据根）；
//   4. 进程级兜底（unhandledRejection/uncaughtException 记日志不退出）；
//   5. 装载失败 = 配置/组合错误（不自愈）→ 退出码 EXIT_CONFIG(78)；
//   6. boot 末事件治理清扫（eventPolicy.sweep）。
//
// dist 形态差异（有意为之）：
//   · hmr 行不在 TREE（loader 专属，dist 无热重载）；
//   · web-server 行 config 由本入口注入生产值（yml 的 './webui/dist'
//     相对路径面向 src/ cwd；dist 的静态产物与 bundle 同目录）；
//   · `--port=N` / `--port N` 命令行参数覆盖缺省 3830（发布手册冒烟口径）。
// ============================================================
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { readPatchFile, type PatchFileEntry } from 'ac-plugin-core';
import { acquireRuntimeLock, runtimeLockPath, EXIT_CONFIG } from 'ac-supervisor-core';
import { bootTree, TREE, type BootedTree } from './index.ts';

/** dist 静态产物目录：bundle 形态 = 本文件所在目录（<pkg>/dist） */
function defaultStaticDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** `--port=N` / `--port N` 解析（无则 undefined） */
export function parsePortArg(argv: readonly string[]): number | undefined {
  for (const [i, arg] of argv.entries()) {
    if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length));
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
      return undefined;
    }
    if (arg === '--port') {
      const port = Number(argv[i + 1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
      return undefined;
    }
  }
  return undefined;
}

export interface BootDistOptions {
  /** 覆盖数据根（测试用；缺省 INIT_CWD 回落 cwd，已设 env 尊重之） */
  dataRoot?: string;
  /** 覆盖静态产物目录（测试用；缺省 AGENTCHAT_WEBUI_DIST 回落本文件所在目录） */
  staticDir?: string;
  /** 覆盖监听端口（测试用；缺省 --port 参数回落 3830） */
  port?: number;
  /** 单实例锁（测试用；缺省真取锁） */
  lock?: boolean;
}

export interface BootedDist extends BootedTree {
  /** 行偏好层应用明细（boot 日志/测试断言用） */
  skippedRows: string[];
  /** 释放单实例锁（进程 exit 钩子同款；测试显式清理用） */
  unlock?: () => void;
}

/**
 * dist 直调 boot：TREE 全量行（patch 停用行除外）+ 生产 web-server config。
 * 抛错 = 装载失败（main 转 EXIT_CONFIG）；测试可直调后按 fibers 反序 dispose。
 */
export async function bootDist(options: BootDistOptions = {}): Promise<BootedDist> {
  // ---- 数据根锚定（语义同 boot.ts；显式入参最高） ----
  const dataRoot = options.dataRoot ?? process.env.AGENTCHAT_DATA_ROOT
    ?? path.resolve(process.env.INIT_CWD || process.cwd());
  process.env.AGENTCHAT_DATA_ROOT = dataRoot;
  console.log(`[boot] 持久化数据根（AGENTCHAT_DATA_ROOT）: ${dataRoot}`);

  // ---- 单实例锁（锚定数据根；supervised 形态锁由 supervisor 持有。
  //      冲突抛错（main 转 EXIT_CONFIG）；陈旧锁回收语义见 acquireRuntimeLock） ----
  let unlock: (() => void) | undefined;
  if (options.lock !== false && process.env.AGENTCHAT_SUPERVISED !== '1') {
    const lockFile = runtimeLockPath(dataRoot);
    try {
      unlock = acquireRuntimeLock(lockFile);
      process.on('exit', () => unlock?.());
      console.log(`[boot] 已获取单实例锁: ${lockFile}`);
    } catch (err) {
      throw new Error(
        `检测到另一实例正在运行（${lockFile} 已被锁定）。` +
          '同数据根双写者会互相覆盖（config/singles/会话文件）；请先停止另一实例（同目录的 agentchat / pnpm dev）后重试。' +
          `（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  }

  // ---- 行偏好层（fail-soft；首期 {id, disabled}——loader 路径经 include
  //      patches 等价实现） ----
  const read = readPatchFile(dataRoot);
  for (const warning of read.warnings) console.warn(`[boot] cordis.patch.yml: ${warning}`);
  const skippedRows: string[] = [];
  const skip = new Set<string>();
  const known = new Set(TREE.map((r) => r.id));
  for (const entry of read.patches as PatchFileEntry[]) {
    if (entry.disabled !== true) continue;
    if (!known.has(entry.id)) {
      console.warn(`[boot] cordis.patch.yml 停用了未知行 "${entry.id}"（忽略）`);
      continue;
    }
    skip.add(entry.id);
  }
  if (skip.size > 0) {
    skippedRows.push(...skip);
    console.log(`[boot] 行偏好层停用行: ${[...skip].join(', ')}`);
  }

  // ---- web-server 生产 config（yml 的 './webui/dist' 是 src/ cwd 相对路径；
  //      dist 静态产物与 bundle 同目录） ----
  const staticDir = options.staticDir ?? process.env.AGENTCHAT_WEBUI_DIST ?? defaultStaticDir();
  const port = options.port ?? parsePortArg(process.argv) ?? 3830;
  console.log(`[boot] web-server: http://127.0.0.1:${port}（静态目录 ${staticDir}）`);

  const tree = await bootTree({ 'web-server': { port, host: '127.0.0.1', staticDir } }, skip);

  // ---- boot 末事件治理清扫（同 boot.ts；行序 ≠ 激活序，收敛后单次清扫） ----
  const policy = tree.ctx.get('eventPolicy', false) as { sweep(): number } | undefined;
  if (policy) {
    const removed = policy.sweep();
    if (removed > 0) console.log(`[boot] 事件治理清扫：移除 ${removed} 条已停用监听器`);
  }

  return { ...tree, skippedRows, unlock };
}

/** 脚本直跑入口（bundle 的 main）：进程兜底 + 装载失败转 EXIT_CONFIG */
async function main() {
  process.on('unhandledRejection', (reason) => {
    console.error('[boot] 未处理的 Promise 拒绝（已兜底，进程继续）:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[boot] 未捕获异常（已兜底，进程继续）:', err);
  });
  try {
    await bootDist();
  } catch (err) {
    console.error(`[boot] 装载失败（配置/组合错误，不会自愈——退出码 ${EXIT_CONFIG}）:`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(EXIT_CONFIG);
  }
}

// 脚本直跑判定（import 进测试/打包时不自启）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
