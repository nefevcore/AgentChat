// ============================================================
// ac-run-code/src/tool.ts —— run_code 工具体（主线程侧）
//
// 链路：resolveEffectiveTools（与 router 工具可见面合成同链）→
// buildSdkProjection → worker（双入口引导，计划 §五.2）→ 桥接执行
// （子调用一律 ctx.tools.execute——能力轴/档位/黑名单/扫描/脱敏/
// 事件面全自动生效）→ 摘要步记录（裁决 #1：程序体全文不回上下文）。
//
// worker 引导（实验结论 2026-09-17）：
//   dev   = new URL('./worker.ts', import.meta.url)（TS 直跑）
//   bundle= 同目录 worker.mjs（build-bundle 第二入口产物）
//   回退  = 两处都不存在 → 报可诊断错误（eval 自举留异常部署）
// ============================================================
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from '@agentchat/cordis';
import type { ToolCall, ToolDefinition, ToolResult } from 'ac-tools';
import type { AgentConfig } from 'ac-agents';
import { resolveToolNames, toolAllowedFor } from 'ac-agents';
import { buildSdkProjection } from 'ac-run-code-core';
import type { MainToWorker, WorkerDone, WorkerToMain, RunSummary, SubcallTrace } from './protocol.ts';

/**
 * 子调用并发分类词表（写路径 ∪ 命令类按提交序串行）。
 * 单源优先：ac-security 的 WRITE_PATH_TOOLS/COMMAND_TOOLS（安全域事实源，
 * 与路径复检/命令扫描同一份名单）；ac-security 缺席（独立发布形态——
 * run_code 不强绑宿主安全行）时回落内置等值名单 + 启动告警。两份名单的
 * 一致性由 ac-run-code 测试锁定（词表单源断言）。
 */
const FALLBACK_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const FALLBACK_COMMAND_TOOLS = new Set(['pwsh', 'bash']);
function serialWordlists(): { write: Set<string>; command: Set<string> } {
  try {
    // 动态 require 形态的静态可达 import——esbuild 正常打包；缺席时
    // try/catch 兜底（独立性：不把 ac-security 声明为硬依赖）
    const security = require('ac-security') as {
      WRITE_PATH_TOOLS: Set<string>;
      COMMAND_TOOLS: Set<string>;
    };
    if (security?.WRITE_PATH_TOOLS instanceof Set && security?.COMMAND_TOOLS instanceof Set) {
      return { write: security.WRITE_PATH_TOOLS, command: security.COMMAND_TOOLS };
    }
  } catch { /* ac-security 未装配——回落内置 */ }
  return { write: FALLBACK_WRITE_TOOLS, command: FALLBACK_COMMAND_TOOLS };
}
const SERIAL_LISTS = serialWordlists();

/** 预算缺省（行 config 可覆盖；computeMs 只计子调用执行耗时——审批等待除外） */
export interface RunCodeRowOptions {
  defaultComputeMs?: number;
  defaultMaxWallMs?: number;
  defaultMaxOutputBytes?: number;
}

/**
 * 输出预算缺省 32KB（实测复盘 a7828839：编辑工作流需经 return 回传待改
 * 文件全文——12.8KB 常态贴近 16KB 旧上限，中大型文件会中段截断；模型已
 * 自适应 offset/limit 分段读，预算再紧会切断「读全文→编辑」正当路径。
 * 4cd1a90d 那批的 64KB→16KB 收紧误伤面大于收益，回调折中 32KB）。
 */
const DEFAULTS = { computeMs: 120_000, maxWallMs: 600_000, maxOutputBytes: 32 * 1024 };

/** trace 上限（超出截断计 traceTruncated——卡片列表可视上限，防长循环程序撑爆步记录） */
const TRACE_LIMIT = 50;

/**
 * 会话级 lib 注册表（lib 扩展，2026-09-17）：key = `${agentId ?? '~'}|${conversationId ?? '~'}`，
 * value = Map<库名, 源码>。跨 run_code 调用共享（worker 即用即弃，主线程是
 * 持有方）；会话维度的生命周期 = 注册表随会话演进累积，容量闸在 worker define
 * 侧（64KB/32 条）。不设显式清理——量级由容量闸封顶，进程重启自然清空。
 */
const libStores = new Map<string, Map<string, string>>();
function libStoreOf(agentId: string | undefined, conversationId: string | undefined): Map<string, string> {
  const key = `${agentId ?? '~'}|${conversationId ?? '~'}`;
  let store = libStores.get(key);
  if (store === undefined) {
    store = new Map();
    libStores.set(key, store);
  }
  return store;
}

/**
 * 子调用一句话简述（卡片「工具调用」行文案）：关键参数优先，回落
 * 结果摘要字段（count/total/result 等标量），截 80。与前端 toolLabel
 * 的 argDetail 同族但独立实现——桥接层不可 import 前端包。
 */
function subcallBrief(name: string, args: Record<string, unknown>, result: ToolResult | undefined): string {
  const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const str = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  // 参数面：工具语义主参数（与 toolLabel.ts argDetail 的词表对齐）
  const argPick = (): string => {
    switch (name) {
      case 'read': case 'write': case 'edit':
        return str(args.file_path ?? args.filePath ?? args.path);
      case 'glob': return str(args.pattern);
      case 'grep': return str(args.pattern).slice(0, 40);
      case 'pwsh': case 'bash': return str(args.description) || str(args.command).slice(0, 60);
      case 'web_search': return str(args.query).slice(0, 50) || str(args.description);
      case 'math': return str(args.expression).slice(0, 50);
      case 'subagent': return str(args.action) || 'spawn';
      default: {
        // 通用：第一个字符串型参数（大多数工具的主参数形态）
        for (const v of Object.values(args)) {
          const s = str(v);
          if (s) return clip(s, 60);
        }
        return '';
      }
    }
  };
  const a = argPick();
  // 结果面：标量摘要字段（存在才拼）
  const out = result?.output;
  const resultPick = (): string => {
    if (out === null || typeof out !== 'object' || out === undefined) {
      return typeof out === 'string' ? clip(out, 30) : '';
    }
    const o = out as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['count', 'total', 'total_lines', 'result', 'ok_count', 'lines']) {
      const v = o[k];
      if (typeof v === 'number' || typeof v === 'string') parts.push(`${k}=${String(v)}`);
      if (parts.length >= 2) break;
    }
    return parts.join(' ');
  };
  const r = resultPick();
  if (a && r) return clip(`${a} · ${r}`);
  return clip(a || r || '');
}

/**
 * 生效工具集解析（与 router RouterService.execute 的可见面合成同链——
 * 能力面 → resolveToolNames → 形态面终滤；计划 §二同源纪律）。
 * router 私有逻辑不 import（三条红线），此处按同一单源函数复算；
 * tag 展开告警接 logger.warn（对齐 router 文案口径）。
 *
 * 口径（2026-09-17 互斥形态改版）：
 *   · scope='llm'——LLM 可见面：能力面 → include/exclude → 形态面。
 *     互斥形态（AgentConfig.tools = ['run_code']）下其余工具被 include
 *     收出 LLM 面，但仍在能力面内（tags 授权未变）。
 *   · scope='projection'——投影源：**能力面直取**（跳过 include/exclude
 *     收窄——互斥形态的投影要涵盖全部已授权工具，否则程序里除了
 *     run_code 什么都调不了）。include/exclude 的语义边界收窄为
 *     「LLM 直调面」；投影面 = tags 即工具面的授权真理。安全无碍：
 *     子调用执行照走 ctx.tools.execute 全门禁（能力轴逐调用复检），
 *     投影声明宽 = fail-safe（声明了但无权执行会被拒），不越权。
 * 两口径都过形态面终滤（single 裁剪与 router 同口径——坑 #10）。
 */
export function resolveEffectiveTools(
  ctx: Context,
  agentId: string | undefined,
  conversationId: string | undefined,
  scope: 'llm' | 'projection' = 'llm',
): ToolDefinition[] {
  // agents 为可选能力（ctx.get 非 strict）；capabilitySetOf 需 agents 面
  // ——本工具行 inject 只声明 tools，按受限调用方纪律手工合成能力集
  const agents = ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;
  const agent = agentId === undefined ? undefined : agents?.get(agentId);
  const caps = new Set<string>(['base']);
  if (agentId !== undefined) {
    caps.add(`agent:${agentId}`);
    for (const t of agent?.tags ?? []) caps.add(t);
  }
  const visible = ctx.tools.list().filter((t) => toolAllowedFor(t, caps));
  if (scope === 'projection') {
    // 投影源：能力面全量（授权真理）——不经 include/exclude 收窄，
    // 但 run_code 自身排除（递归防护在投影层）
    return visible.filter((d) => d.name !== 'run_code' && !formDenied(ctx, d, conversationId));
  }
  const resolved = resolveToolNames(
    agent?.tools,
    visible,
    (tag) => {
      ctx.logger.warn(`[run_code] tools 引用 'tag:${tag}' 展开为空（标签不存在或无工具声明它），相关条目已静默落空——Agent ${agentId ?? '无身份'}`);
    },
    (name) => {
      ctx.logger.warn(`[run_code] tools 点名 '${name}' 不在当前可见工具面（不存在/不可见/已改名），该条目落空——Agent ${agentId ?? '无身份'}`);
    },
  ) ?? visible.map((t) => t.name);
  return resolved
    .map((name) => ctx.tools.get(name))
    .filter((d): d is ToolDefinition => d !== undefined && !formDenied(ctx, d, conversationId));
}

/** 形态面（single）判定：与 router formAllowed 同口径（坑 #10） */
function formDenied(ctx: Context, def: ToolDefinition, conversationId: string | undefined): boolean {
  if (conversationId === undefined) return false;
  const singles = ctx.get('singles', false) as { get(sid: string): unknown } | undefined;
  if (!singles || !singles.get(conversationId)) return false;
  return (def.excludeForms ?? []).includes('single');
}

/** worker 引导 URL 解析（dev ./worker.ts → bundle ./worker.mjs → undefined） */
export function resolveWorkerEntry(): string | undefined {
  // vitest/transformer 下 import.meta.url 可能带 ?v= 查询后缀——剥掉再判存在
  const stripQuery = (u: URL): string => fileURLToPath(new URL(u.pathname, 'file://'));
  const here = stripQuery(new URL('./worker.ts', import.meta.url));
  if (existsSync(here)) return here;
  const bundled = stripQuery(new URL('./worker.mjs', import.meta.url));
  if (existsSync(bundled)) return bundled;
  return undefined;
}

/** 工具体入口（ac-run-code/src/index.ts 注册进 ctx.tools） */
export async function executeRunCode(
  ctx: Context,
  options: RunCodeRowOptions,
  args: Record<string, unknown>,
  call: ToolCall,
): Promise<ToolResult> {
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code.trim()) return { ok: false, error: '缺少 code 参数（可擦除 TS 程序体）' };
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb);
  const computeMs = num(args.compute_ms, options.defaultComputeMs ?? DEFAULTS.computeMs);
  const maxWallMs = num(args.max_wall_ms, options.defaultMaxWallMs ?? DEFAULTS.maxWallMs);
  const maxOutputBytes = num(args.max_output_bytes, options.defaultMaxOutputBytes ?? DEFAULTS.maxOutputBytes);

  // 投影源 = 生效工具集（每次调用现算——不跨 run 缓存，坑 #4）。
  // 注：投影的模型可见面是 loop/before-run 注入的 system 块（见
  // injectProjection——每次 run 同源现算）；工具体内不再计算（发送即
  // 丢弃的形态已在 2026-09-17 实测复盘修正）。
  const effective = resolveEffectiveTools(ctx, call.agentId, call.conversationId);

  // worker 引导（双入口 + 探测）
  const entry = resolveWorkerEntry();
  if (entry === undefined) {
    return { ok: false, error: 'run_code worker 引导文件缺失（dev ./worker.ts 或 bundle ./worker.mjs 均不存在）——部署形态不完整' };
  }

  const runId = call.toolCallId ?? `run-${Date.now().toString(36)}`;
  // lib 注入：会话级注册表快照（非空才注入——省协议体积）
  const libStore = libStoreOf(call.agentId, call.conversationId);
  const libSource = libStore.size > 0 ? Object.fromEntries(libStore) : undefined;
  const worker = new Worker(entry);
  if (typeof worker.unref === 'function') worker.unref();
  // 中止控制器（compute 预算 / 墙钟看门狗 / 用户 signal 共用——
  // 一处 abort 全链生效：子调用 signal + worker abort 消息）
  let abortCtl: AbortController | undefined;
  const workerAbortSignal = (): AbortSignal | undefined => abortCtl?.signal;

  // —— 主线程桥接：子调用 → ctx.tools.execute（全安全面）——
  let computeUsed = 0;
  let mainAborted = false;
  const summary: RunSummary = { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] };
  let traceTruncated = 0;
  let serialChain: Promise<void> = Promise.resolve();

  /** compute 预算强制执行：子调用完成后累计超限即发 abort（worker 下一边界收束） */
  function enforceComputeBudget(): void {
    if (!mainAborted && computeMs > 0 && computeUsed > computeMs) {
      mainAborted = true;
      abortCtl ??= new AbortController();
      abortCtl.abort();
      worker.postMessage({ type: 'abort', reason: `子调用累计执行耗时超预算（computeMs=${computeMs}ms，已用 ${computeUsed}ms）` } satisfies MainToWorker);
    }
  }

  const invoke = (name: string, invokeArgs: Record<string, unknown>, seq: number): Promise<void> => {
    const isSerial = SERIAL_LISTS.write.has(name) || SERIAL_LISTS.command.has(name);
    if (isSerial) summary.serialized.push(seq);
    const task = (): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const t0 = Date.now();
        const done = (r: ToolResult) => {
          if (settled) return;
          settled = true;
          const dur = Date.now() - t0;
          // computeMs 只累计子调用执行耗时（含排队）；审批等待在
          // before-execute waterfall 内——不计（ac-tools durationMs 口径）。
          // 此处以墙钟近似：审批等待会略微高估 compute，保守方向可接受
          // （预算宁可早停）。后续可经 tool/transform-result 观察精化。
          computeUsed += dur;
          summary.calls++;
          if (r.ok) summary.ok++;
          else summary.failed++;
          if (!r.ok && r.error && /权限|档位|黑名单|拒绝/.test(r.error)) {
            summary.denied.push({ name, error: r.error.slice(0, 200) });
          }
          // 轨迹收集（UI 卡片数据源）：上限 50，超出只计数
          if (summary.trace.length < TRACE_LIMIT) {
            const entry: SubcallTrace = {
              seq,
              name,
              ok: r.ok,
              ms: dur,
              brief: subcallBrief(name, invokeArgs, r),
              ...(!r.ok && r.error ? { error: r.error.slice(0, 200) } : {}),
            };
            summary.trace.push(entry);
          } else {
            traceTruncated++;
          }
          worker.postMessage({ type: 'result', seq, ok: r.ok, ...(r.output !== undefined ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}) } satisfies MainToWorker);
          enforceComputeBudget();
          resolve();
        };
        void ctx.tools
          .execute({
            name,
            args: invokeArgs,
            ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
            ...(call.conversationId !== undefined ? { conversationId: call.conversationId } : {}),
            toolCallId: `${runId}#${seq}`,
            signal: workerAbortSignal(),
            ...(call.elevation ? { elevation: call.elevation } : {}),
            // 子调用标记（实测复盘 #B）：ToolCall 开放词汇面——UI/审计
            // 据此区分「run_code 程序内子调用」与「模型直接调用」（tool_call_id
            // 形如 <runId>#<seq> 是提示不是判据——显式标记才可编程消费）
            runCodeSubcall: true,
          })
          .then(done, (err: unknown) => done({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
    if (!isSerial) {
      void task();
      return Promise.resolve();
    }
    // 写路径/命令类：按提交序串行（前一个完成后再执行）
    serialChain = serialChain.then(task, task);
    return serialChain;
  };

  const wallStart = Date.now();
  // 程序体全文入 host 日志（实测复盘 #D：裁决 #1 的诊断去向——步记录
  // 只有 programHash，排查需按哈希回捞全文）
  ctx.logger.debug('[run_code] 程序体（%s）：\n%s', hashText(code), code);
  const done = await new Promise<WorkerDone>((resolveDone, rejectDone) => {
    let init = false;
    worker.on('message', (m: WorkerToMain) => {
      if (m.type === 'ready') {
        worker.postMessage({
          type: 'init',
          runId,
          code,
          computeMs,
          maxWallMs,
          maxOutputBytes,
          ...(libSource !== undefined ? { libSource } : {}),
        } satisfies MainToWorker);
        init = true;
        return;
      }
      if (m.type === 'invoke') {
        void invoke(m.name, m.args, m.seq);
        return;
      }
      if (m.type === 'done') {
        resolveDone(m);
      }
    });
    worker.on('error', (err) => {
      rejectDone(err);
    });
    worker.on('exit', (code_) => {
      if (code_ !== 0) rejectDone(new Error(`worker 异常退出（code=${code_}）`));
      else resolveDone({ type: 'done', ok: false, error: 'worker 提前退出', summary: { calls: 0, ok: 0, failed: 0, computeMs: 0, wallMs: 0, denied: [], serialized: [], trace: [] } });
    });
    // 主线程侧看门狗：墙钟预算（含审批等待）——worker 自身无 timer 面
    const wallTimer = setTimeout(() => {
      if (init) {
        abortCtl ??= new AbortController();
        abortCtl.abort();
        worker.postMessage({ type: 'abort', reason: `墙钟预算耗尽（maxWallMs=${maxWallMs}ms）` } satisfies MainToWorker);
        setTimeout(() => void worker.terminate(), 5_000).unref?.();
      }
    }, maxWallMs > 0 ? maxWallMs : 2 ** 31 - 1);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();
    call.signal?.addEventListener('abort', () => {
      clearTimeout(wallTimer);
      abortCtl ??= new AbortController();
      abortCtl.abort();
      worker.postMessage({ type: 'abort', reason: '用户中止' } satisfies MainToWorker);
    }, { once: true });
  }).finally(() => {
    void worker.terminate();
  });

  summary.computeMs = computeUsed;
  summary.wallMs = Date.now() - wallStart;
  // lib 注册表回写：done 快照 → 会话级 store（全量覆写——含程序未 define 的
  // 存量；失败/interrupted 的 run 不回写——注册表只反映成功程序的状态）
  if (done.ok && done.libExports !== undefined) {
    libStore.clear();
    for (const [name, src] of Object.entries(done.libExports)) libStore.set(name, src);
  }
  // 程序体哈希（步记录入摘要——裁决 #1）+ 收束 info 行（宿主日志可检索）
  const programHash = hashText(code);
  ctx.logger.info(
    '[run_code] 收束 run=%C ok=%C ok/总=%C/%C compute=%Cms wall=%Cms hash=%C',
    runId,
    done.ok,
    String(summary.ok),
    String(summary.calls),
    String(summary.computeMs),
    String(summary.wallMs),
    programHash,
  );
  const output = {
    summary: {
      ...done.summary,
      ...summary,
      computeMs: Math.max(done.summary.computeMs, summary.computeMs),
      wallMs: Math.max(done.summary.wallMs, summary.wallMs),
      ...(traceTruncated > 0 ? { traceTruncated } : {}),
    },
    programHash,
    ...(done.value !== undefined ? { value: done.value } : {}),
  };
  if (done.interrupted) {
    return { ok: false, error: done.error ?? '程序中止', interrupt: { type: 'run-code-interrupted', reason: done.error ?? '程序中止' }, output };
  }
  if (!done.ok) {
    return { ok: false, error: done.error ?? '程序执行失败', output };
  }
  return { ok: true, output };
}

/** 简单稳定哈希（FNV-1a 32bit hex——摘要用途，非密码学） */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
