// ============================================================
// ac-subagent/src/index.ts —— 子 Agent 行（SubAgentManager + subagent 工具）
//
// src svc/subagent 平移（输出归一 {ok, output}）。preview 形态差异：
//   · spawn = ctx.agentLoop.run 直连（agent:undefined → runAddress 无地址
//     → 无 steer 队列/无会话归属——零会话污染天然成立，不靠"无 hooks"约定）
//   · 受控工具集 = request.tools（loop 原生支持；子 Agent 不可能比父强）
//   · completed 缓存（上限 50）先于 ac-jobs 交付：awaitResult 查缓存，
//     job 登记（kind=subagent）只接统一任务词汇（list/kill/settled）
//   · 生命周期不变：spawn → running → done/error/timeout/killed → 回收
// requiredTags ['delegation']（任务委派能力——ac-security 行执行；
// 更名自 conductor：存量 tags 由 agent-store 读边界归一）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { LoopRunResult } from 'ac-agent-loop';
import { splitModelRef } from 'ac-llm';
import { defaultPoolConnection } from 'ac-llm-pool';

export type SubAgentStatus = 'running' | 'done' | 'error' | 'timeout' | 'killed';

export interface SubAgentHandle {
  id: string;
  parentId: string;
  name: string;
  status: SubAgentStatus;
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

export interface SpawnSubAgentOptions {
  parentId: string;
  name?: string;
  task: string;
  context?: string;
  toolNames?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  /** 发起会话键（完成通知回投目标；缺省回 owner 自会话桶） */
  conversationId?: string;
}

interface SubEntry {
  handle: SubAgentHandle;
  controller: AbortController;
  promise: Promise<void>;
}

/** 完成缓存上限 */
const COMPLETED_CACHE_MAX = 50;
/** 缺省超时（5 分钟） */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** 任务 prompt 装配（独立上下文，不背父 Agent 历史——src 原样） */
function buildTaskPrompt(task: string, context?: string): string {
  const parts = [
    `[子任务] 请作为独立子 Agent 完成以下任务。`,
    ``,
    `任务：${task}`,
  ];
  if (context?.trim()) {
    parts.push(``, `[上下文]`, context.trim());
  }
  parts.push(``, `要求：独立思考并执行，完成后只返回最终结论。你的思考过程与工具调用不会写入任何会话记录。`);
  return parts.join('\n');
}

export const name = 'ac-subagent';

export const inject = ['tools', 'agentLoop', 'jobs', 'agents'];

export function apply(ctx: Context) {
  const subs = new Map<string, SubEntry>();
  /** 已完成的 handle 缓存（上限 50；awaitResult 先于 ac-jobs 交付） */
  const completed = new Map<string, SubAgentHandle>();

  /** 创建并启动子 Agent（异步执行不阻塞；返回 handle） */
  async function spawn(opts: SpawnSubAgentOptions): Promise<SubAgentHandle> {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const name = opts.name || '子任务';

    // 父 Agent 配置（模型/模型商；子 Agent 共享父的 LLM 注册）
    const parent = ctx.agents.get(opts.parentId);
    if (!parent) {
      throw new Error(`父 Agent "${opts.parentId}" 未注册（subagent spawn 需要父的 model 配置）`);
    }
    // 模型解析与 router 信封同口径（2026-09-02 反馈：admin 未声明 model 而
    // 用默认池连接跑得好好的，派子 Agent 却被拒——"无可用模型"）：缺省
    // 回落默认池连接（`default:true` 优先，缺省首条；ac-llm-pool 同款）。
    let model = parent.model;
    if (!model) {
      const config = ctx.get('config', false) as
        | { get<T>(key: string): T | undefined }
        | undefined;
      const def = defaultPoolConnection(config?.get<Record<string, unknown>>('llmProviders'));
      if (def) model = `${def.provider}@${def.model}`;
    }
    if (!model || parent.virtual) {
      throw new Error(`父 Agent "${opts.parentId}" 无可用模型（virtual 或缺 model，不能派子 Agent）`);
    }
    // 防御性拆分（P4）：存量 AgentConfig.model 可能带 name@model 引用
    // （迁移窗口/手编盘档）——拆出 provider 优先于 parent.provider。
    const ref = splitModelRef(model);
    const provider = ref.provider ?? parent.provider;

    const handle: SubAgentHandle = {
      id,
      parentId: opts.parentId,
      name,
      status: 'running',
      task: opts.task,
      startedAt: Date.now(),
    };

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      ctx.logger.warn(`[subagent] "${id}" 超时（${Math.round(timeoutMs / 1000)}s），强制终止`);
      controller.abort();
    }, timeoutMs);

    const promise = (async () => {
      try {
        // loop 直连：agent:undefined（零会话污染）+ 受控工具集 + signal
        const result: LoopRunResult = await ctx.agentLoop.run({
          model: ref.model,
          ...(provider ? { provider } : {}),
          messages: [{ role: 'user', content: buildTaskPrompt(opts.task, opts.context) }],
          ...(opts.toolNames && opts.toolNames.length > 0 ? { tools: opts.toolNames } : {}),
          maxSteps: opts.maxSteps ?? 15,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (controller.signal.aborted) {
          handle.status = handle.status === 'running' ? 'timeout' : handle.status;
        } else {
          handle.status = 'done';
          handle.result = result.text;
        }
        handle.finishedAt = Date.now();
        ctx.logger.info(`[subagent] "${id}" 完成（status=${handle.status}）`);
      } catch (err: unknown) {
        clearTimeout(timer);
        handle.status = controller.signal.aborted ? 'timeout' : 'error';
        handle.error = err instanceof Error ? err.message : String(err);
        handle.finishedAt = Date.now();
        ctx.logger.warn(`[subagent] "${id}" 异常（${handle.status}）: ${handle.error}`);
      } finally {
        // 回收：活跃表移除，handle 移入 completed 缓存供 awaitResult 查询
        subs.delete(id);
        completed.set(id, handle);
        if (completed.size > COMPLETED_CACHE_MAX) {
          const oldest = completed.keys().next().value;
          if (oldest) completed.delete(oldest);
        }
      }
    })();

    subs.set(id, { handle, controller, promise });

    // 接入统一任务词汇（kind=subagent；owner=父 Agent；完成通知走 job/settled）
    // 映射：done→completed / error→failed / timeout|killed→killed
    try {
      ctx.jobs.start({
        kind: 'subagent',
        label: opts.task.slice(0, 80),
        ownerAgentId: opts.parentId,
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
        meta: { subagentId: id, name, parentId: opts.parentId },
        run: () => ({
          cancel: () => {
            kill(id);
          },
          done: promise.then(() => {
            switch (handle.status) {
              case 'done':
                return { status: 'completed' as const, detail: 'exit ok', output: handle.result ?? '' };
              case 'error':
                return { status: 'failed' as const, detail: handle.error ?? 'error' };
              default:
                return { status: 'killed' as const, detail: handle.status };
            }
          }),
          readOutput: () => handle.result ?? handle.error ?? '',
        }),
      });
    } catch (err: unknown) {
      ctx.logger.warn(`[subagent] "${id}" 登记 ctx.jobs 失败（不影响执行）: ${String(err)}`);
    }

    return handle;
  }

  /** 等待子 Agent 完成（不设等待上限——wait 语义 = 阻塞到收束；src 语义） */
  async function awaitResult(id: string): Promise<SubAgentHandle | null> {
    const done = completed.get(id);
    if (done) return done;
    const entry = subs.get(id);
    if (!entry) return null;
    await entry.promise;
    return entry.handle;
  }

  /** 中断并回收子 Agent */
  function kill(id: string): boolean {
    const entry = subs.get(id);
    if (!entry) return false;
    entry.handle.status = 'killed';
    entry.handle.finishedAt = Date.now();
    entry.controller.abort();
    return true;
  }

  function list(): SubAgentHandle[] {
    return [...subs.values()].map((e) => e.handle);
  }

  function get(id: string): SubAgentHandle | undefined {
    return subs.get(id)?.handle ?? completed.get(id);
  }

  // ---- subagent 工具（spawn/list/await/kill 单工具 action 分发） ----
  ctx.tools.register({
    name: 'subagent',
    description:
      '派出子 Agent 独立执行子任务（独立上下文，可并行多个）：spawn 创建、await 取结果、list 查看、kill 终止。',
    requiredTags: ['delegation'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn', 'list', 'await', 'kill'], description: '操作' },
        task: { type: 'string', description: '[spawn] 任务描述（需完整自包含）' },
        name: { type: 'string', description: '[spawn] 子 Agent 名称' },
        tools: { type: 'array', items: { type: 'string' }, description: '[spawn] 可用工具名（留空 = 纯推理）' },
        context: { type: 'string', description: '[spawn] 附加上下文' },
        subagent_id: { type: 'string', description: '[await/kill] 子 Agent ID' },
        max_steps: { type: 'number', description: '[spawn] 步数上限（默认 15）', minimum: 1 },
        timeout_s: { type: 'number', description: '[spawn] 超时秒数（默认 300，超时强制终止）', minimum: 1 },
        wait_time: {
          type: 'number',
          description:
            '等待秒数。[spawn] 传正值 = 等到完成（默认 0 = 立即返回）；[await] 默认 60',
          minimum: 0,
          maximum: 600,
        },
      },
      required: ['action'],
    },
    async execute(args, call): Promise<ToolResult> {
      // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
      const parentId = call.agentId ?? '__host__';
      switch (args.action) {
        case 'spawn': {
          const task = String(args.task ?? '').trim();
          if (!task) return { ok: false, error: '缺少 task 参数' };
          const handle = await spawn({
            parentId,
            name: args.name ? String(args.name) : undefined,
            task,
            context: args.context ? String(args.context) : undefined,
            toolNames: Array.isArray(args.tools) ? args.tools.map((s: unknown) => String(s)) : undefined,
            maxSteps: Number(args.max_steps) || 15,
            timeoutMs: Math.round((Number(args.timeout_s) || 300) * 1000),
            ...(call.conversationId ? { conversationId: call.conversationId } : {}),
          });
          // 阻塞模式：wait_time > 0
          const waitTime = Number(args.wait_time) || 0;
          if (waitTime > 0) {
            const waitMs = Math.round(waitTime * 1000);
            const done = await awaitResult(handle.id);
            if (!done || done.status !== 'done') {
              return {
                ok: false,
                error: done?.error || `子 Agent 未在 ${waitMs / 1000}s 内完成`,
                output: { subagent_id: handle.id, status: done?.status ?? 'unknown' },
              };
            }
            return {
              ok: true,
              output: {
                subagent_id: handle.id,
                status: 'done',
                result: done.result,
                elapsed_ms: (done.finishedAt ?? Date.now()) - done.startedAt,
              },
            };
          }
          return {
            ok: true,
            output: {
              subagent_id: handle.id,
              status: 'running',
              message: `子 Agent "${handle.id}" 已启动，用 subagent(action="await", subagent_id) 获取结果`,
            },
          };
        }
        case 'kill': {
          const id = String(args.subagent_id ?? '');
          if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
          if (!kill(id)) {
            return { ok: false, error: `子 Agent "${id}" 不存在或已回收` };
          }
          return { ok: true, output: { subagent_id: id, message: `子 Agent "${id}" 已终止并回收` } };
        }
        case 'list': {
          const listOut = list().map((h) => ({
            id: h.id,
            parent: h.parentId,
            name: h.name,
            status: h.status,
            task: h.task.slice(0, 80),
            started_at: new Date(h.startedAt).toISOString(),
            elapsed_ms: (h.finishedAt ?? Date.now()) - h.startedAt,
          }));
          return { ok: true, output: { active_count: listOut.length, subagents: listOut } };
        }
        case 'await': {
          const id = String(args.subagent_id ?? '');
          if (!id) return { ok: false, error: '缺少 subagent_id 参数' };
          const waitMs = Math.round((Number(args.wait_time) || 60) * 1000);
          const cur = get(id);
          if (!cur) {
            return {
              ok: false,
              error: `子 Agent "${id}" 不存在或已回收（可能早已完成，结果已丢失）`,
            };
          }
          if (cur.status !== 'running') {
            return {
              ok: true,
              output: {
                subagent_id: id,
                status: cur.status,
                result: cur.result,
                error: cur.error,
                elapsed_ms: (cur.finishedAt ?? Date.now()) - cur.startedAt,
              },
            };
          }
          const done = await awaitResult(id);
          if (!done) return { ok: false, error: `子 Agent "${id}" 已消失` };
          if (done.status === 'running') {
            return {
              ok: true,
              output: {
                subagent_id: id,
                status: 'running',
                message: `子 Agent 仍在运行（已等待 ${waitMs / 1000}s）。可再次调用 subagent(action="await") 或 subagent(action="kill")。`,
              },
            };
          }
          return {
            ok: true,
            output: {
              subagent_id: id,
              status: done.status,
              result: done.result,
              error: done.error,
              elapsed_ms: (done.finishedAt ?? Date.now()) - done.startedAt,
            },
          };
        }
        default:
          return { ok: false, error: `未知 action "${String(args.action)}"，应为 spawn/list/await/kill 之一` };
      }
    },
  });
}
