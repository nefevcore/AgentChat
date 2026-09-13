// ============================================================
// ac-bench —— 评测插件行（能力域 owning）
//
// inject 无（服务自身 static inject ['tools','agentLoop']，行无需
// 重复声明）；apply 装载 BenchService 并随行注册内置 BFCL 套件
// （缺省数据 = 包内样例数据集，可用 config.files 指向真实下载）。
//
// 生产评测（真实 LLM）经 CLI：pnpm bench --model … --base-url …
// （见 src/cli.ts；或经本包 README 的下载说明取官方数据集）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { BenchService } from './service.ts';
import { createBfclSuite } from './suites/bfcl.ts';

export const name = 'ac-bench';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'bench',
  label: 'Bench 评测',
  description: '评测域（ctx.bench）：套件注册 + 单会话跑批（BFCL 单轮适配器；临时工具合成 → loop 驱动 → 对拍 → 报告）',
};

/** 行配置（透传 BFCL 套件数据源） */
export interface BenchRowOptions {
  /** 题目文件（JSON 数组/JSONL；缺省 = 包内样例数据集） */
  files?: string[];
  /** 答案文件（possible_answer/ 分离形态，按 id join） */
  answerFiles?: string[];
}

export function apply(ctx: Context, options: BenchRowOptions = {}) {
  ctx.plugin(BenchService, { suites: [createBfclSuite(options)] });
}

export { BenchService, DEFAULT_BENCH_SYSTEM } from './service.ts';
export { createBfclSuite, DEFAULT_BFCL_SAMPLE, normalizeToolSchema, sanitizeToolName } from './suites/bfcl.ts';
export type { BfclSuite, BfclSuiteOptions } from './suites/bfcl.ts';
export { parseCallString, compareCalls, callMatches, looseEq } from './eval.ts';
export { scriptedBenchRow, encodeScript, decodeScript, MOCK_PROVIDER, MOCK_MODEL } from './mock.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
