// ============================================================
// ac-app/src/ecosystem.ts —— 配置驱动装配（测试/演示辅助）
//
// ⚠ 官方启动路径不是本文件：pnpm preview:boot（boot.ts chdir 后复用
//   vendor cordis bin.js，零自研引导）。本文件仅在官方路径之外提供
//   initial 物化 / include patches / 临时 yml 等测试与演示能力。
//
// 行 name 全部为【裸包名】（教程/官方形态）：
//   ac-* / @agentchat/cordis-* —— 解析锚点是 ctx.baseUrl（vendor loader
//   tree.ts 的 internal.import 以 baseUrl 为 parentURL），从 preview/
//   沿目录树向上至仓库根 node_modules 命中（ac-* 已声明进根
//   package.json devDependencies —— 与旧轨 @agentchat/* 同一惯例）。
//   本地文件行用相对路径（教程同款：'./hello.ts'）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { Context, type Fiber, type Plugin } from '@agentchat/cordis';
import Loader, { ModuleLoader, type Entry, type EntryOptions } from '@agentchat/cordis-loader';
import type { PatchOptions } from '@agentchat/cordis-include';

export { ModuleLoader };

export interface BootFromConfigOptions {
  /** 配置目录锚点（缺省 = preview/） */
  baseUrl?: string;
  /** 配置文件相对路径（缺省 './cordis.yml'） */
  file?: string;
  /**
   * 初始行表（include 的 initial：目标文件缺失时物化落盘）。
   * 生产路径不传——官方 bin.js 直接读已存在的 preview/cordis.yml；
   * 本选项供测试用独立 yml（initial 取自对真实 cordis.yml 的解析，
   * 单一事实源，勿在此维护第二份行表）。
   */
  rows?: EntryOptions[];
  /** 运行时补丁（include patches：文件读取后应用，不写回） */
  patches?: PatchOptions[];
}

export interface BootedConfig {
  ctx: Context;
  loaderFiber: Fiber;
  includeEntry: Entry;
  include: import('@agentchat/cordis-include').default;
}

/** 配置驱动 boot：Context → Loader → include(裸包名行) —— 与官方 bin.js 同构 */
export async function bootFromConfig(options: BootFromConfigOptions = {}): Promise<BootedConfig> {
  const ctx = new Context();
  ctx.baseUrl = options.baseUrl ?? new URL('../../', import.meta.url).href;

  const loaderFiber = ctx.plugin(Loader as unknown as Plugin);
  await loaderFiber;

  await ctx.loader.create({
    name: '@agentchat/cordis-include',
    config: {
      path: options.file ?? './cordis.yml',
      ...(options.rows ? { initial: options.rows } : {}),
      ...(options.patches ? { patches: options.patches } : {}),
    },
  });

  const includeEntry = findIncludeEntry(ctx)!;
  const include = includeEntry.subtree as BootedConfig['include'];
  return { ctx, loaderFiber, includeEntry, include };
}

/** 在 loader 条目树中定位 include 子树的条目 */
export function findIncludeEntry(ctx: Context): Entry | undefined {
  for (const entry of ctx.loader.entries()) {
    const tree = entry.subtree;
    if (tree && 'refresh' in tree && 'filename' in (tree as object)) return entry;
  }
}

/** 便捷：preview/ 目录的绝对路径与 file URL */
export const PREVIEW_DIR = fileURLToPath(new URL('../../', import.meta.url));
