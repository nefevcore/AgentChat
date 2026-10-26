// ============================================================
// tests/helpers.ts —— shell-tools 测试共用装配（拆分自单文件版）
//
// 单文件时代（shell-tools.integration.test.ts ~36s）19 个用例串行共享
// 一条时间线；拆分后各文件独立进程并行，墙钟 ≈ 最长文件而非总和。
// 装配件不变：tmpRoot/boot/exec/afterEach 清理全部原样迁移。
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as jobsRow from 'ac-jobs';

export type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };

/** 当平台命令工具名（Windows → pwsh；Unix → bash） */
export const CMD_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash';
/** 长sleep命令（平台方言） */
export const SLEEP_30 = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';

export async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
export function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shell-'));
  tmps.push(dir);
  return dir;
}

/** 额外临时目录入册（afterEach 统一清——tierOf 用例的自建 outside 目录） */
export function registerTmp(dir: string): string {
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/**
 * 最小装配（tools + jobs + shell 行）。shellRow 经参数传入（各测试文件
 * 自行 import 本包 src/index.ts，保持与原文件相同的模块图）。
 */
export async function boot(root: string, options: Record<string, unknown> = {}) {
  return bootRows([
    [toolsRow, undefined],
    [jobsRow, undefined],
    [await import('../src/index.ts'), { workdir: root, ...options }],
  ]);
}

/** 显式行集装配（tierOf/限额用例需附 agents 行） */
export async function bootRows(rows: Array<[unknown, unknown]>) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
