// ============================================================
// ac-agent-loop/src/service.ts —— ReAct 循环服务（cordis Service）
//
// 本包同时是循环域契约的 owning package：域类型见 ./contract.ts，
// loop/* 事件目录见 ./events.ts（谁 emit 谁声明）；跨域词汇
// （LlmMessage 等）type-import 自 owning 包 ac-llm / ac-tools。
//
// ctx.agentLoop.run(request)：能力调用（有返回值、依赖由 inject 保证）。
// ctx.agentLoop.steer(handle, message)：向活跃 run 注入消息（ADR-1；
//   handle = runAddress(agent, conversationId)，ac-conversation 的串行化门
//   与本方法共用同一寻址词汇）。
// 边界全部事件化（./events.ts）：
//   · loop/before-run（waterfall）—— 改写请求 / veto / 包裹观察
//   · loop/run-started（emit）—— run 开始通知（before-run 通过后）
//   · loop/after-run（emit）—— 持久化/审计/指标订阅
//   · loop/before-step（waterfall）—— 改写本步消息
//   · loop/step-started（emit）—— step 开始通知（before-step 通过后）
//   · loop/after-step（emit）—— 步级订阅
// 工具执行走 ctx.tools.execute → 自动获得 tool/before-execute
// 拦截链（veto/改写）与 tool/after-execute 通知 —— 循环不重新实现拦截。
// 中断（ADR-2 最小方案）：request.signal 在 step 边界检查 →
//   finish='interrupted' + interruptReason。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { LlmMessage, LlmToolCall, LlmToolSpec, LlmUsage } from 'ac-llm';
import type {
  LoopInterruptReason,
  LoopRunCall,
  LoopRunRequest,
  LoopRunResult,
  LoopRunTransform,
  LoopRunUsage,
  LoopStepCall,
  LoopStepRecord,
  LoopStepTransform,
} from './contract.ts';

/** 工具调用 arguments（JSON 字符串）→ 参数对象；解析失败透传原文 */
function parseArgs(tc: LlmToolCall): Record<string, unknown> {
  if (!tc.arguments) return {};
  try {
    const parsed = JSON.parse(tc.arguments);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { __raw: tc.arguments };
  } catch {
    return { __raw: tc.arguments };
  }
}

/** signal.reason → 可读文本 */
function abortText(signal: AbortSignal): string | undefined {
  const r = signal.reason;
  if (r instanceof Error) return r.message;
  if (typeof r === 'string' && r) return r;
  return undefined;
}

/**
 * 有界并发映射（对齐 src mapLimit(5)：同一步的多个工具调用并发执行，
 * 结果按输入序回填——OpenAI 多工具调用语义要求 tool 消息与
 * tool_calls 顺序一致）。limit=1 即串行。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 合并单步用量到 run 统计（双轨制，src accumulateUsage 语义原样）：
 *   prompt/total → 覆盖为最新值（当次上下文大小，供归档阈值判断）；
 *   promptAccumulated/totalAccumulated/completion/cache → 累加（展示总用量）；
 *   steps → 每次供给 +1（react_steps）。
 */
function mergeUsage(acc: LoopRunUsage | undefined, usage: LlmUsage): LoopRunUsage {
  if (!acc) {
    return {
      prompt: usage.prompt,
      completion: usage.completion,
      ...(usage.total != null ? { total: usage.total } : {}),
      promptAccumulated: usage.prompt,
      ...(usage.total != null ? { totalAccumulated: usage.total } : {}),
      ...(usage.cacheHit != null ? { cacheHit: usage.cacheHit } : {}),
      ...(usage.cacheMiss != null ? { cacheMiss: usage.cacheMiss } : {}),
      steps: 1,
    };
  }
  const out: LoopRunUsage = {
    ...acc,
    prompt: usage.prompt, // 覆盖轨：当次上下文
    completion: acc.completion + usage.completion,
    promptAccumulated: acc.promptAccumulated + usage.prompt,
    steps: acc.steps + 1,
  };
  if (usage.total != null) {
    out.total = usage.total; // 覆盖轨
    out.totalAccumulated = (acc.totalAccumulated ?? 0) + usage.total;
  }
  if (usage.cacheHit != null) out.cacheHit = (acc.cacheHit ?? 0) + usage.cacheHit;
  if (usage.cacheMiss != null) out.cacheMiss = (acc.cacheMiss ?? 0) + usage.cacheMiss;
  return out;
}

/**
 * run 寻址（steer 注入 / 串行化门共用的地址词汇，本包 owning）：
 *   · agent 缺省 → 无地址（subagent 直连形态，steer 不适用）
 *   · conversationId 缺省或 = agent → agent（1v1：一个 Agent 一条会话门）
 *   · conversationId ≠ agent → `${conversationId}~${agent}`（群聊：组键共享
 *     会话桶，但每个参与者是独立 run——对齐 src group~gid~aid 语义）
 * 无歧义前提：Agent id 禁 `~`（agents.register 校验），对键从右起最后
 * 一段即 agent——M19 承重墙。
 */
export function runAddress(
  agent: string | undefined,
  conversationId: string | undefined,
): string | undefined {
  if (agent === undefined) return undefined;
  if (!conversationId || conversationId === agent) return agent;
  return `${conversationId}~${agent}`;
}

/**
 * 对键构造（M19 全对键桶模型的会话归属键，本包 owning——conversationId
 * 词汇与信封契约归此）：两端排序后 `~` 连接；a===b 即自会话对角线 `a~a`。
 * 一切双端会话（user⇄agent 直答 / agent⇄agent 委托 / 机制自会话）共用。
 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

/** 对键解析：'a~b' → [a, b]（已排序）；非对键返回 undefined */
export function pairEndpoints(conversationId: string): [string, string] | undefined {
  if (!conversationId.includes('~')) return undefined;
  const [a, b] = conversationId.split('~');
  return a && b ? [a, b] : undefined;
}

/**
 * 归档整理 run 的信封标记键（M20，对齐 src META_ARCHIVE_REVIEW）：
 * 值恒为 true。透传链 conversation.deliver → router.send → LoopRunRequest.meta；
 * 三个消费方各查本键跳过副作用——ac-session（入账）、ac-usage（记账）、
 * ac-conversation（上下文视图）。ws-bridge 的流式过滤仍按 source='event'。
 */
export const ARCHIVE_REVIEW_META = 'archive-review';

/**
 * 工具名清单 → 规范化 LlmToolSpec[]（缺省 = 全部已注册工具；空清单 = 空集）。
 * M21/D4 顺序规范化（DSH M2b）：按工具名**字典序**——与注册顺序/插件
 * 装卸时序解耦（注册顺序是插件加载时序的产物，HMR/装卸即变 → 前缀
 * 抖动）。落地即一次性全量缓存失效，接受（一次性迁移成本）。
 * 导出供 ac-singles 前缀快照（M21 步骤 4）同口径计算 specs 哈希——
 * 唯一规范化点，防两处漂移。
 */
export function normalizeToolSpecs(
  defs: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>,
  names: string[] | undefined,
): LlmToolSpec[] {
  const selected = (names ? defs.filter((d) => names.includes(d.name)) : defs)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return selected.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      ...(d.parameters ? { parameters: d.parameters } : {}),
    },
  }));
}

/**
 * steer 队列（run 生灭）：
 *   · items——待注入消息 + 投递元数据
 *   · sealed——收束判定已过：不再接受新注入（迟到的 steer 返回 false，
 *     ac-conversation 优雅回落 next-run：消息作为下一条独立 run 的入站，
 *     入账一次、不丢不重——D3 修复的核心）
 */
interface SteerQueue {
  items: Array<{ message: LlmMessage; sender?: string; source?: string }>;
  sealed: boolean;
}

export class AgentLoopService extends Service {
  /** 活跃 run 的 steer 队列（runAddress → 队列）；随 run 生灭 */
  private steerQueues = new Map<string, SteerQueue>();

  constructor(ctx: Context) {
    super(ctx, 'agentLoop');
  }

  /**
   * 执行一轮 Agent 循环（拦截链内环）。
   * 拦截器 veto（不调 next）时直接返回拦截器提供的 LoopRunResult。
   */
  run(request: LoopRunRequest): Promise<LoopRunResult> {
    const call: LoopRunCall = { request };
    // steer 注册先于 before-run（同步）：run 受理即可被注入；
    // veto / 异常路径经 finally 回收。同地址并发 run 由 ac-conversation
    // 串行化门防止；直接调用方并发自担（后者覆盖前者队列，回收仅认领自己的）。
    const address = runAddress(request.agent, request.conversationId);
    if (address === undefined) {
      return this.ctx.waterfall('loop/before-run', call, () => this.execute(call.request, undefined));
    }
    const queue: SteerQueue = { items: [], sealed: false };
    this.steerQueues.set(address, queue);
    const promise = this.ctx.waterfall('loop/before-run', call, () => this.execute(call.request, queue));
    return promise.finally(() => {
      if (this.steerQueues.get(address) !== queue) return;
      this.steerQueues.delete(address);
      // D3 残余观测：封口前已入队但未被消费（before-run veto 窗口）——
      // 消息已经 conversation/steered 事件入账/进视图，下一条自然 run
      // 可见（自愈）；发射通知供观测。不自动重投：next-turn 重投会经
      // router/message-received 二次入账（重复行）
      const dropped = queue.items.splice(0);
      if (dropped.length > 0) {
        this.ctx.emit('loop/steer-dropped', request.agent, request.conversationId, address, dropped);
      }
    });
  }

  /**
   * 向活跃 run 注入一条消息（ADR-1：steer 走 Service 方法，非事件）。
   * @param handle run 地址（= runAddress(agent, conversationId)）
   * @param meta 投递元数据（sender/source；steer-dropped 观测载荷用）
   * @returns false = 该地址无活跃 run 或已收束（sealed——D3：收束判定后
   *          的注入不再受理，调用方回落 next-run）
   */
  steer(handle: string, message: LlmMessage, meta?: { sender?: string; source?: string }): boolean {
    const queue = this.steerQueues.get(handle);
    if (!queue || queue.sealed) return false;
    queue.items.push({ message, ...(meta?.sender !== undefined ? { sender: meta.sender } : {}), ...(meta?.source !== undefined ? { source: meta.source } : {}) });
    return true;
  }

  private async execute(
    request: LoopRunRequest,
    steerQueue: SteerQueue | undefined,
  ): Promise<LoopRunResult> {
    const startedAt = Date.now(); // run 耗时（收束日志用）
    // run 开始通知（before-run 通过后；veto 不发）——WS 广播 / UI Turn 分组
    // 订阅面，不能挂在 before-run 决策链上
    this.ctx.emit('loop/run-started', request);
    const steps: LoopStepRecord[] = [];
    let usage: LoopRunUsage | undefined;
    // trigger/receive 双模式（对齐 src）：maxSteps > 0 = 上限；缺省/0 = 不限
    // （receive 模式靠"无工具调用"自然收束，中断由调用方 AbortSignal 负责）
    const maxSteps = request.maxSteps && request.maxSteps > 0 ? request.maxSteps : Infinity;
    // 工作消息：system + 历史；工具轮次在循环内追加（assistant/tool）
    const messages: LlmMessage[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages,
    ];
    const specs = this.toolSpecs(request);
    let finish: LoopRunResult['finish'] = 'stop';
    let error: string | undefined;
    let interruptReason: LoopInterruptReason | undefined;

    try {
      for (let index = 0; index < maxSteps; index++) {
        // step 边界中断检查（含首步之前）：已中止 → 保留已完成步收尾
        if (request.signal?.aborted) {
          finish = 'interrupted';
          const text = abortText(request.signal);
          interruptReason = { type: 'user-abort', ...(text ? { reason: text } : {}) };
          break;
        }
        // 消费 steer 注入（下一步生效；before-step 可继续改写）
        const steering = steerQueue?.items.splice(0);
        if (steering && steering.length > 0) messages.push(...steering.map((s) => s.message));

        const step = await this.step(request, index, messages, specs);
        steps.push(step);
        if (step.usage) usage = mergeUsage(usage, step.usage);

        // 自然收束条件：无工具调用且无待消费 steer（末轮 steer 不丢失）
        const pendingSteer = steerQueue !== undefined && steerQueue.items.length > 0;
        if (step.toolCalls.length === 0 && !pendingSteer) break;
        if (index === maxSteps - 1) {
          // 预算耗尽：模型还想继续（带工具调用）→ max-steps；
          // 已给出终文本但 steer 仍待消费 → stop（steer 留给下一 run，
          // 由 ac-conversation 的会话上下文视图延续）
          if (step.toolCalls.length > 0) finish = 'max-steps';
          break;
        }
        messages.push({
          role: 'assistant',
          content: step.text,
          ...(step.toolCalls.length > 0
            ? {
                tool_calls: step.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
            : {}),
        });
        // 工具执行（M11）：执行身份随 call 装配（agentId/conversationId/
        // toolCallId + signal 透传）；同一步并发执行（mapLimit 5，对齐 src），
        // 结果按 tool_calls 序回填
        const toolResults = await mapLimit(step.toolCalls, 5, (tc) =>
          this.ctx.tools.execute({
            name: tc.name,
            args: parseArgs(tc),
            ...(request.agent !== undefined ? { agentId: request.agent } : {}),
            ...(request.conversationId !== undefined
              ? { conversationId: request.conversationId }
              : {}),
            ...(tc.id !== undefined ? { toolCallId: tc.id } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        );
        for (let i = 0; i < step.toolCalls.length; i++) {
          step.toolResults.push(toolResults[i]);
          messages.push({
            role: 'tool',
            tool_call_id: step.toolCalls[i].id,
            content: JSON.stringify(toolResults[i]),
          });
        }
        // 语义化中断收束检测（M11，ADR-2）：工具体请求宿主级行为 →
        // 本 run 到此收束（interrupt 结果如实入步记录，模型不再续步）
        const interruptIndex = toolResults.findIndex((r) => r.interrupt);
        if (interruptIndex >= 0) {
          const toolInterrupt = toolResults[interruptIndex].interrupt!;
          finish = 'interrupted';
          interruptReason = {
            type: 'tool-interrupt',
            reason: `工具 ${step.toolCalls[interruptIndex].name} 请求 ${toolInterrupt.type}`,
            toolInterrupt,
          };
          break;
        }
      }
    } catch (err) {
      finish = 'error';
      error = err instanceof Error ? err.message : String(err);
    }

    // D3 收束封口：settle 判定已过——此后到 run() finally 删队列之间
    // （transform-run waterfall + after-run emit 的异步窗口）迟到的
    // steer() 返回 false，ac-conversation 回落 next-run（消息入账一次、
    // 不丢不重）。此前窗口内 steer() 仍 true → 入账+ack 已注入 → 队列
    // 连消息一并删除，本轮永不消费。
    if (steerQueue) steerQueue.sealed = true;

    const result: LoopRunResult = {
      steps,
      text: steps.at(-1)?.text ?? '',
      finish,
      ...(error ? { error } : {}),
      ...(interruptReason ? { interruptReason } : {}),
      usage: usage ?? { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    };
    const payload: LoopRunTransform = { request, result };
    // 变换链（安全审查/脱敏 seam）：router 回复、session 入账、调用方拿到的是终值
    const final = await this.ctx.waterfall('loop/transform-run', payload, async () => payload.result);
    // M18 调试可见性：run 收束（步数/耗时/用量/缓存/终态一目了然）。
    // in/out = 累加轨（全部步输入/输出之和）；cache = 缓存命中率
    // （hit/(hit+miss) 的 token 口径，无缓存数据时 '-'）
    const hit = final.usage.cacheHit ?? 0;
    const miss = final.usage.cacheMiss ?? 0;
    const cacheRate = hit + miss > 0 ? `${((hit / (hit + miss)) * 100).toFixed(1)}%` : '-';
    this.ctx.logger.info(
      '[loop] run 收束 agent=%C conv=%C finish=%C steps=%C elapsed=%Cms in=%C out=%C total=%C cache=%C(hit=%C/miss=%C)',
      request.agent ?? '(直连)',
      request.conversationId ?? request.agent ?? '-',
      final.finish,
      String(final.steps.length),
      String(Date.now() - startedAt),
      String(final.usage.promptAccumulated),
      String(final.usage.completion),
      String(final.usage.totalAccumulated ?? final.usage.promptAccumulated + final.usage.completion),
      cacheRate,
      String(hit),
      String(miss),
    );
    this.ctx.emit('loop/after-run', request, final);
    return final;
  }

  /** 单步：before-step waterfall（可改写本步消息）→ llm.chat → transform-step → after-step emit */
  private async step(
    request: LoopRunRequest,
    index: number,
    messages: LlmMessage[],
    specs: LlmToolSpec[] | undefined,
  ): Promise<LoopStepRecord> {
    const stepCall: LoopStepCall = { agent: request.agent, messages };
    // 信封子集（M13 载荷增强）：step/delta 级事件与 llm 调用共用，
    // WS 桥接按它过滤后台会话（source='event' 的流式输出不广播）
    const envelope = {
      conversationId: request.conversationId,
      sender: request.sender,
      source: request.source,
    };
    const record = await this.ctx.waterfall('loop/before-step', stepCall, async () => {
      // step 开始通知（before-step 通过后、llm.chat 前；载荷 = 实际送入模型的消息）
      this.ctx.emit('loop/step-started', request.agent, index, stepCall.messages, envelope);
      const res = await this.ctx.llm.chat({
        ...(request.provider ? { provider: request.provider } : {}),
        model: request.model,
        messages: stepCall.messages,
        ...(specs ? { tools: specs } : {}),
        // 中断透传（C3）：signal 直达传输层（fetch abort），否则用户中断
        // /子代理超时只在步边界生效——当前步 LLM 请求照跑完整轮（token
        // 照扣、会话门不释放）。契约字段早已就位，纯接线遗漏。
        ...(request.signal ? { signal: request.signal } : {}),
        // 采样参数透传（M15：per-Agent 调参；键集由 ac-agents 白名单过滤）
        ...(request.llmParams ? request.llmParams : {}),
        meta: {
          agent: request.agent,
          conversationId: request.conversationId,
          sender: request.sender,
          source: request.source,
        },
      });
      return {
        index,
        text: res.text,
        ...(res.reasoning ? { reasoning: res.reasoning } : {}),
        toolCalls: res.toolCalls ?? [],
        toolResults: [] as LoopStepRecord['toolResults'],
        ...(res.usage ? { usage: res.usage } : {}),
        ...(res.finish ? { finish: res.finish } : {}),
      } satisfies LoopStepRecord;
    });
    // 步记录变换（安全审查/脱敏 seam）：入档与通知均为变换后终值
    const transform: LoopStepTransform = { agent: request.agent, step: record };
    const finalStep = await this.ctx.waterfall('loop/transform-step', transform, async () => transform.step);
    this.ctx.emit('loop/after-step', request.agent, finalStep, envelope);
    return finalStep;
  }

  /**
   * 工具名清单 → LlmToolSpec[]（normalizeToolSpecs 规范化：字典序，
   * 与注册/装卸时序解耦——M21/D4）
   */
  private toolSpecs(request: LoopRunRequest): LlmToolSpec[] | undefined {
    const specs = normalizeToolSpecs(this.ctx.tools.list(), request.tools);
    if (specs.length === 0) return undefined;
    return specs;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** ReAct 循环服务（ac-agent-loop 提供；边界事件见本包 ./events.ts） */
    agentLoop: AgentLoopService;
  }
}
