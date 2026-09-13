// ============================================================
// ac-bench/src/service.ts —— 评测跑批服务（cordis Service）
//
// 本包是评测域契约的 owning package：域类型见 ./contract.ts，
// bench/* 事件目录见 ./events.ts。
//
// ctx.bench：套件注册中心 + 单会话跑批。
//   · registerSuite —— fiber 归属（行卸载自动回收，注册中心标准形态）；
//   · run —— 逐用例：合成临时工具（用后即焚 disposer）→ agentLoop
//     机制 run（meta 带 ARCHIVE_REVIEW_META：不入会话账/不记 usage/
//     不进上下文视图，M20 机制标记）→ 聚合实际调用 → eval 对拍 →
//     报告。事件：run-started / case-settled / run-completed（emit）。
//
// 跨服务方法调用一律 this.ctx.get（铁律 2）；static inject 声明硬依赖
// （tools/agentLoop——构造期即可安全访问，方法期走 get 面同源）。
// ============================================================
import { randomUUID } from 'node:crypto';
import { Service, type Context } from '@agentchat/cordis';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import type { ToolDefinition } from 'ac-tools';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';
import type {
  BenchActualCall,
  BenchCase,
  BenchCaseResult,
  BenchReport,
  BenchRunOptions,
  BenchSuite,
} from './contract.ts';
import { compareCalls } from './eval.ts';
import { encodeScript } from './mock.ts';

/** 跑批缺省系统提示词（BFCL 语义：能调则调、无需则直答） */
export const DEFAULT_BENCH_SYSTEM =
  'You are an expert in composing functions. You have access to a set of tools. ' +
  'Based on the question, call the tool(s) with exact argument values extracted from the question. ' +
  'If the task does not require any tool, answer directly without calling anything.';

/** 跑批缺省步数预算（单轮类目 1-2 步收束；反例/续答留余量） */
export const DEFAULT_MAX_STEPS = 6;

export interface BenchServiceOptions {
  /** 随行装载的内置套件（行 apply 注入；构造期注册，fiber 归属本行） */
  suites?: BenchSuite[];
}

export class BenchService extends Service {
  static inject = ['tools', 'agentLoop'];

  private suites = new Map<string, BenchSuite>();

  constructor(ctx: Context, options: BenchServiceOptions = {}) {
    super(ctx, 'bench');
    for (const suite of options.suites ?? []) this.registerSuite(suite);
  }

  /** 注册套件（重名抛错；disposer 供动态注册场景手动撤） */
  registerSuite(suite: BenchSuite) {
    if (!suite.name) throw new Error('套件注册缺少 name');
    if (this.suites.has(suite.name)) throw new Error(`bench 套件 "${suite.name}" 已注册`);
    return this.ctx.fiber.effect(() => {
      this.suites.set(suite.name, suite);
      return () => {
        this.suites.delete(suite.name);
      };
    }, `bench.registerSuite(${suite.name})`);
  }

  /** 已注册套件（名字典序） */
  listSuites(): BenchSuite[] {
    return [...this.suites.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * 跑批一个套件：逐用例机制 run → 对拍 → 聚合报告。
   * 用例串行执行（同会话域零并发竞争；临时工具名冲突天然互斥）。
   */
  async run(suiteName: string, options: BenchRunOptions): Promise<BenchReport> {
    const suite = this.suites.get(suiteName);
    if (!suite) {
      throw new Error(`bench 套件 "${suiteName}" 不存在（已注册：${[...this.suites.keys()].join(', ') || '无'}）`);
    }
    const agentLoop = this.ctx.get('agentLoop');
    const tools = this.ctx.get('tools');
    if (!agentLoop || !tools) throw new Error('bench.run 需要 agentLoop 与 tools 服务（行未激活）');

    const all = await suite.load();
    const filtered = all.filter((c) => (options.filter ? c.id.includes(options.filter) : true));
    const offset = Math.max(0, options.offset ?? 0);
    const slice = filtered.slice(offset, options.limit !== undefined ? offset + options.limit : undefined);

    const runId = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    this.ctx.emit('bench/run-started', {
      suite: suiteName,
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      runId,
      total: slice.length,
    });

    const cases: BenchCaseResult[] = [];
    for (const benchCase of slice) {
      cases.push(await this.runCase(benchCase, options, runId, agentLoop, tools));
      this.ctx.emit('bench/case-settled', cases.at(-1)!);
    }

    const passed = cases.filter((c) => c.pass).length;
    const report: BenchReport = {
      suite: suiteName,
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      runId,
      startedAt,
      durationMs: Date.now() - t0,
      total: cases.length,
      passed,
      accuracy: cases.length > 0 ? passed / cases.length : 0,
      promptTokens: cases.reduce((acc, c) => acc + c.promptTokens, 0),
      completionTokens: cases.reduce((acc, c) => acc + c.completionTokens, 0),
      cases,
    };
    this.ctx.emit('bench/run-completed', report);
    return report;
  }

  /** 单用例执行：临时工具合成 → 机制 run → 实际调用聚合 → 对拍 */
  private async runCase(
    benchCase: BenchCase,
    options: BenchRunOptions,
    runId: string,
    agentLoop: { run(request: LoopRunRequest): Promise<LoopRunResult> },
    tools: { register(def: ToolDefinition): () => void },
  ): Promise<BenchCaseResult> {
    const t0 = Date.now();
    let actual: BenchActualCall[] = [];
    let finish: string | undefined;
    let steps = 0;
    let error: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    const disposers: Array<() => void> = [];

    try {
      // 临时工具合成（桩执行体：对拍只看调用面，不看真实副作用）
      for (const tool of benchCase.tools) {
        disposers.push(
          tools.register({
            ...tool,
            execute: () => ({ ok: true, output: { result: 'ok' } }),
          } satisfies ToolDefinition),
        );
      }
      // 脚本化冒烟：期望调用 → 指令块（配合 mock provider 回放）
      const script = options.scripted ? encodeScript(benchCase.expected) : '';
      const prompt = script ? `${benchCase.prompt}\n\n${script}` : benchCase.prompt;
      const system = [benchCase.systemHint, options.system ?? DEFAULT_BENCH_SYSTEM]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join('\n\n');

      const result = await agentLoop.run({
        model: options.model,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
        tools: benchCase.tools.map((t) => t.name),
        maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        sender: 'bench',
        source: 'event',
        conversationId: `bench-${runId}-${slugify(benchCase.id)}`,
        meta: { [ARCHIVE_REVIEW_META]: true, 'bench-case': benchCase.id },
      });

      finish = result.finish;
      steps = result.steps.length;
      error = result.error;
      promptTokens = result.usage.promptAccumulated;
      completionTokens = result.usage.completion;
      actual = aggregateCalls(result);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // 卸载竞争（fiber 已回收）——忽略
        }
      }
    }

    const verdict = compareCalls(benchCase.expected, actual);
    const cleanFinish = finish === 'stop' && !error;
    return {
      id: benchCase.id,
      ...(benchCase.category ? { category: benchCase.category } : {}),
      pass: verdict.pass && cleanFinish,
      ...(verdict.reason
        ? { reason: verdict.reason }
        : verdict.pass && !cleanFinish
          ? { reason: `调用对拍通过但收束异常（finish=${finish}${error ? `：${error}` : ''}）` }
          : {}),
      ...(finish !== undefined ? { finish } : {}),
      steps,
      durationMs: Date.now() - t0,
      expected: benchCase.expected,
      actual,
      promptTokens,
      completionTokens,
      ...(error ? { error } : {}),
    };
  }
}

/** 用例 id → 会话键安全片段（只留字母数字下划线连字符） */
function slugify(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
}

/** run 步记录 → 实际调用清单（arguments JSON 容错解析） */
function aggregateCalls(result: LoopRunResult): BenchActualCall[] {
  const calls: BenchActualCall[] = [];
  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.arguments || '{}') as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // 解析失败按空参（对拍自然失配）
      }
      calls.push({ name: tc.name, args });
    }
  }
  return calls;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 评测跑批服务（ac-bench 提供；套件注册 + 单会话跑批，事件见本包 ./events.ts） */
    bench: BenchService;
  }
}
