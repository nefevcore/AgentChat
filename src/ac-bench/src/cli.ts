// ============================================================
// ac-bench/src/cli.ts —— BFCL 跑批 CLI（pnpm bench）
//
// 两种模式：
//   · 冒烟（缺省）：--mock —— 期望调用脚本化回放，验证
//     注册中心 → agentLoop → 工具执行 → 对拍 → 报告全链路（零 LLM）；
//   · 真实评测：--model <m> --base-url <u> [--api-key <k>] ——
//     OpenAI 兼容端点直连（凭据可走 env：BENCH_API_KEY/OPENAI_API_KEY）。
//
// 数据：缺省 = 包内样例数据集；真实 BFCL 数据下载后经 --file/--answers
// 指入（见本包 README.md）。
//
// 退出码：0 = 跑批完成；1 = 达不到 --min-accuracy 门槛（CI 用）。
// ============================================================
import { Context, type Plugin } from '@agentchat/cordis';
import { OpenAICompletions } from 'ac-openai-completions';
import * as llmRow from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as agentLoopRow from 'ac-agent-loop';
import * as benchRow from './index.ts';
import type { BenchReport } from './contract.ts';

interface Args {
  flags: Set<string>;
  values: Map<string, string[]>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      const key = a.slice(2, eq);
      const value = a.slice(eq + 1);
      values.set(key, [...(values.get(key) ?? []), value]);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, [...(values.get(key) ?? []), next]);
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, values, positional };
}

function one(args: Args, key: string): string | undefined {
  return args.values.get(key)?.at(-1);
}

function num(args: Args, key: string): number | undefined {
  const raw = one(args, key);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

const HELP = `
BFCL 跑批 CLI（ac-bench）

  pnpm bench                                   # 冒烟：内置样例 + 脚本化 mock（零 LLM）
  pnpm bench --limit 3                         # 只跑前 3 例
  pnpm bench --model deepseek-chat --base-url https://api.deepseek.com --api-key <key>
  pnpm bench --file BFCL_v3_simple.json --answers BFCL_v3_simple.answer.json --model …

选项：
  --mock              脚本化冒烟模式（无真实凭据时的缺省回落）
  --model <m>         模型名（真实模式必填；mock 模式忽略）
  --provider <p>      显式 llm provider 名（缺省按 model 路由）
  --base-url <u>      OpenAI 兼容端点（env BENCH_BASE_URL）
  --api-key <k>       API key（env BENCH_API_KEY / OPENAI_API_KEY）
  --file <f>          题目文件，可重复（缺省 = 包内样例）
  --answers <f>       答案文件（possible_answer/ 形态），可重复
  --limit <n>         只跑前 n 例
  --offset <n>        跳过前 n 例
  --filter <s>        用例 id 子串过滤
  --max-steps <n>     步数预算（缺省 6）
  --json              机器可读输出（完整报告 JSON；进度走 stderr 不污染）
  --quiet             关闭实时进度输出（stderr）
  --min-accuracy <p>  通过率门槛（百分比；低于退出码 1）
  --list              只列出用例不跑
  --help              本帮助
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.has('h')) {
    console.log(HELP);
    return 0;
  }

  const files = args.values.get('file');
  const answerFiles = args.values.get('answers');
  const ctx = new Context();

  // ---- 装配最小树：llm → tools → agent-loop → bench ----
  for (const row of [llmRow, toolsRow, agentLoopRow]) {
    await ctx.plugin(row as unknown as Plugin);
  }
  const benchFiber = ctx.plugin(benchRow as unknown as Plugin, {
    ...(files ? { files } : {}),
    ...(answerFiles ? { answerFiles } : {}),
  });
  await benchFiber;

  // ---- 列用例模式 ----
  if (args.flags.has('list')) {
    for (const suite of ctx.bench.listSuites()) {
      const cases = await suite.load();
      console.log(`suite ${suite.name}（${cases.length} 例）`);
      for (const c of cases) {
        console.log(`  ${c.id}  tools=[${c.tools.map((t) => t.name).join(', ')}]  expected=${c.expected.length} 调用`);
      }
    }
    return 0;
  }

  // ---- 模式决议：显式 --mock 或无真实凭据 → 冒烟 ----
  const model = one(args, 'model') ?? process.env.BENCH_MODEL;
  const baseUrl = one(args, 'base-url') ?? process.env.BENCH_BASE_URL;
  const apiKey = one(args, 'api-key') ?? process.env.BENCH_API_KEY ?? process.env.OPENAI_API_KEY;
  const explicitProvider = one(args, 'provider');
  const mock = args.flags.has('mock') || !(model && baseUrl);

  let provider: string;
  let runModel: string;
  if (mock) {
    if (!args.flags.has('mock') && !(model && baseUrl)) {
      console.warn('[bench] 未提供 --model/--base-url（或 api-key），回落脚本化冒烟模式（--mock）');
    }
    const mockFiber = ctx.plugin(benchRow.scriptedBenchRow() as unknown as Plugin);
    await mockFiber;
    provider = benchRow.MOCK_PROVIDER;
    runModel = benchRow.MOCK_MODEL;
  } else {
    const liveRow = {
      name: 'ac-bench-live',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('bench-live', () => new OpenAICompletions({ baseUrl, apiKey, defaultModel: model }), {
          models: [model],
        });
      },
    };
    const liveFiber = ctx.plugin(liveRow as unknown as Plugin);
    await liveFiber;
    provider = explicitProvider ?? 'bench-live';
    runModel = model;
  }

  // ---- 实时进度（stderr：不污染 --json 的 stdout；--quiet 关闭） ----
  // 真实 LLM 跑批全量 400 例约几十分钟——逐例反馈（bench/case-settled 事件）
  // + 进度行（pass/fail/elapsed/avg/eta），跑批不再"黑盒等待"。
  let total = 0;
  let settled = 0;
  let passed = 0;
  const progressT0 = Date.now();
  if (!args.flags.has('quiet')) {
    ctx.on('bench/run-started', (info) => {
      total = info.total;
      console.error(`[bench] 开跑：${info.total} 例 · model=${info.model}${info.provider ? ` · provider=${info.provider}` : ''}`);
    });
    ctx.on('bench/case-settled', (result) => {
      settled += 1;
      if (result.pass) passed += 1;
      console.error(
        `${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  finish=${result.finish ?? '-'} steps=${result.steps} ${result.durationMs}ms  calls=${result.actual.map((a) => a.name).join(',') || '(无)'}`,
      );
      if (!result.pass && (result.reason || result.error)) {
        console.error(`     ↳ ${result.error ? `error: ${result.error}；` : ''}${result.reason ?? ''}`);
      }
      const elapsedS = (Date.now() - progressT0) / 1000;
      const avgS = elapsedS / settled;
      const etaS = Math.max(0, total - settled) * avgS;
      console.error(
        `  [${settled}/${total}] pass=${passed} fail=${settled - passed}  elapsed=${elapsedS.toFixed(0)}s avg=${avgS.toFixed(1)}s/例 eta≈${etaS.toFixed(0)}s`,
      );
    });
  }

  const report = await ctx.bench.run('bfcl', {
    model: runModel,
    provider,
    ...(one(args, 'system') ? { system: one(args, 'system') } : {}),
    ...(num(args, 'max-steps') !== undefined ? { maxSteps: num(args, 'max-steps') } : {}),
    ...(num(args, 'limit') !== undefined ? { limit: num(args, 'limit') } : {}),
    ...(num(args, 'offset') !== undefined ? { offset: num(args, 'offset') } : {}),
    ...(one(args, 'filter') ? { filter: one(args, 'filter') } : {}),
    scripted: mock,
  });

  if (args.flags.has('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const minAccuracy = num(args, 'min-accuracy');
  if (minAccuracy !== undefined && report.accuracy * 100 < minAccuracy) {
    console.error(`[bench] 通过率 ${(report.accuracy * 100).toFixed(1)}% 低于门槛 ${minAccuracy}%`);
    return 1;
  }
  return 0;
}

function printReport(report: BenchReport): void {
  // 逐例明细已在跑批中实时输出（stderr）；此处只打终态汇总 + 失败例回顾
  console.log(`\nsuite=${report.suite} model=${report.model}${report.provider ? ` provider=${report.provider}` : ''} run=${report.runId}`);
  console.log('='.repeat(72));
  const failed = report.cases.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`失败 ${failed.length} 例：`);
    for (const c of failed) {
      console.log(`  FAIL  ${c.id}  finish=${c.finish ?? '-'} steps=${c.steps}`);
      console.log(`       ↳ ${c.error ? `error: ${c.error}；` : ''}${c.reason ?? ''}`);
    }
    console.log('-'.repeat(72));
  }
  console.log(
    `准确率 ${report.passed}/${report.total} = ${(report.accuracy * 100).toFixed(1)}%  ` +
      `tokens(in=${report.promptTokens}, out=${report.completionTokens})  总耗时 ${(report.durationMs / 1000).toFixed(1)}s`,
  );
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('[bench] 跑批失败：', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
