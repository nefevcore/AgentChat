// ============================================================
// stream-bridge.ts —— 壳旁带帧 → 前端流式帧桥接（8.5d）
//
// 主线 ws-bridge 是「进程内事件 → WS 帧」；preview 形态事件源在壳进程，
// 宿主只见 B3 旁带 StreamFrame。本件做同款后半段：StreamFrame →
// llm/delta-batch（30ms 微批——主线 LlmDeltaBatcher 纯库复用，帧形与
// 主线逐字段一致）/ llm/delta-end 前端帧，经 webServer.broadcast 下发。
// wireLlmInput 投影同理对齐（前端 feed-core 按 input.meta 路由）。
// 桥接 = 纯函数 + 注入 broadcast——零 cordis 依赖可单测。
// ============================================================
import { LlmDeltaBatcher, wireLlmInput } from 'ac-wire-format';
import { isStreamFrame, type StreamFrame } from 'ac-envelope-core';

/** 前端帧（webServer.broadcast 帧形：type = 事件名直转，data = { args }） */
export interface FrontendFrame {
  type: string;
  data: { args: unknown[] };
}

/** durable-interaction opened wire 整形（主线 bridge-events interactionWire 同义复制） */
function interactionWireOf(record: unknown): unknown {
  const r = record as { kind?: unknown; payload?: { questions?: unknown } | null } | null;
  if (r !== null && typeof r === 'object' && r.kind === 'ask_questions' && r.payload !== null
    && typeof r.payload === 'object' && Array.isArray(r.payload.questions)) {
    const { payload, ...rest } = r as Record<string, unknown> & { payload: { questions: unknown[] } };
    return { ...rest, questions: payload.questions };
  }
  return record;
}

/**
 * 桥接策略注入（背景过滤等目录策略在主线 ws-bridge 内联——preview 壳
 * 场景源恒壳自身，无宿主内后台会话；全量直转）。
 */
export interface StreamBridgeOptions {
  /** 下行出口（webServer.broadcast 或测试注入） */
  send: (frame: FrontendFrame) => void;
  /** 微批窗口 ms（缺省 30——主线同款） */
  windowMs?: number;
  /** 首帧直发（缺省 true——测试可关） */
  immediateFirst?: boolean;
}

/** 主线步级信封形状（loop/step-started / loop/after-step 第末参——前端路由与 stepId 载体索引键） */
function envelopeOf(frame: StreamFrame): Record<string, string | undefined> {
  const m = frame.meta;
  return {
    runId: m?.runId,
    stepId: m?.stepId,
    conversationId: m?.conversationId,
    sender: m?.sender,
    source: m?.source,
  };
}

/**
 * 旁带帧 → 前端帧映射（纯函数核心，单测面）。
 * · delta 帧 → 批器入队（30ms 窗口合帧——llm/delta-batch）。
 * · end 帧 → flushNow（保序：end 前清空在途 delta）+ llm/delta-end 帧。
 * · run-settled 帧（cr-591，run-error 泛化）→ 主线 loop/after-run 帧形
 *   （args = [request, result] 参数序；finish ok→stop）：前端收束三件套
 *   （清 busy / 终稿入列 / 权威行重拉）+ error 红条 / interrupted 分隔符
 *   ——渲染逻辑零新增（主线 feed-core 既有 case）。
 */
export function streamFrameToFrontend(
  frame: StreamFrame,
  batcher: LlmDeltaBatcher,
  send: (frame: FrontendFrame) => void,
): void {
  if (frame.kind === 'delta') {
    // 前端帧 args = [input(投影), chunk, meta] 参数序（主线事件目录同源）。
    // chunk 复原 = 正文 + 思考/工具分片（cr-586：feed-core 思考直播与
    // preparing 卡消费 chunk.reasoning / chunk.toolCalls——空正文帧照发）。
    batcher.push(
      { meta: frame.meta },
      {
        delta: frame.text,
        ...(frame.reasoning !== undefined ? { reasoning: frame.reasoning } : {}),
        ...(frame.toolCalls !== undefined ? { toolCalls: frame.toolCalls } : {}),
      },
      frame.meta,
    );
    return;
  }
  batcher.flushNow();
  if (frame.kind === 'run-started') {
    // 主线 loop/run-started 帧形（args = [request]）：request 携带路由四键
    // ——前端点亮分区 streaming（run 级忙态）+ 重置 run 计时锚。
    send({
      type: 'loop/run-started',
      data: {
        args: [{
          agent: frame.meta?.agent,
          conversationId: frame.meta?.conversationId,
          sender: frame.meta?.sender,
          source: frame.meta?.source,
        }],
      },
    });
    return;
  }
  if (frame.kind === 'step-started') {
    // 主线 loop/step-started 帧形（args = [agent, index, messages, envelope]）
    // ——前端只消费 agent 与 envelope（envelope.stepId = 载体索引键）；
    // messages 壳侧不旁带（载荷大且前端零消费），传空数组占位。
    send({
      type: 'loop/step-started',
      data: {
        args: [
          frame.meta?.agent,
          frame.index,
          [],
          envelopeOf(frame),
        ],
      },
    });
    return;
  }
  if (frame.kind === 'after-step') {
    // 主线 loop/after-step 帧形（args = [agent, step, envelope]）——step 终值
    // 透传（text/reasoning/reasoningMs/toolCalls/stepId/ts——前端步载体收束
    // 翻转 + 「已思考 · Xs」后端权威计时 label）。
    send({
      type: 'loop/after-step',
      data: { args: [frame.meta?.agent, frame.step, envelopeOf(frame)] },
    });
    return;
  }
  if (frame.kind === 'tool-started') {
    // 主线 tool/started 帧形（args = [call]）——run_code 子调用占位卡
    send({ type: 'tool/started', data: { args: [frame.call] } });
    return;
  }
  if (frame.kind === 'tool-progress') {
    // 主线 tool/progress 帧形（args = [call, chunk]）——长任务执行期增量
    send({ type: 'tool/progress', data: { args: [frame.call, frame.chunk] } });
    return;
  }
  if (frame.kind === 'tool-result') {
    // 主线 tool/after-execute 帧形（args = [call, result, error] 参数序）
    // ——onToolEnd 结果回填（工具卡直播期收口，不再恒等待）
    send({ type: 'tool/after-execute', data: { args: [frame.call, frame.result, frame.error] } });
    return;
  }
  if (frame.kind === 'queue-changed') {
    // 主线 conversation/queue-changed 帧形（args 参数序：agentId, conversationId,
    // handle, items——前端 useQueuedMessages 权威快照直接套用）。
    send({
      type: 'conversation/queue-changed',
      data: { args: [frame.meta?.agent, frame.meta?.conversationId, frame.handle, frame.items] },
    });
    return;
  }
  if (frame.kind === 'interaction-opened') {
    // 主线 durable-interaction/opened 帧形（args = [record]）——wire 整形
    // 与主线 ws-bridge bridge-events interactionWire 同义（M7 §二B）：
    // ask_questions 的 payload.questions 上提顶层（前端 pickAskQuestions
    // 两形归一消费）；他 kind 原样。replied/closed 主线恒恒等透传。
    send({ type: 'durable-interaction/opened', data: { args: [interactionWireOf(frame.record)] } });
    return;
  }
  if (frame.kind === 'interaction-replied') {
    send({ type: 'durable-interaction/replied', data: { args: [frame.record] } });
    return;
  }
  if (frame.kind === 'interaction-closed') {
    send({ type: 'durable-interaction/closed', data: { args: [frame.record] } });
    return;
  }
  if (frame.kind === 'context-injected') {
    // 主线 session/context-injected 帧形（args = [conversationId, agentId,
    // meta] 参数序，wire 恒等透传）——前端 feed 事件分隔行（label 直出）。
    send({
      type: 'session/context-injected',
      data: {
        args: [
          frame.meta?.conversationId,
          frame.meta?.agent,
          {
            source: frame.source,
            ...(frame.injectionId !== undefined ? { injectionId: frame.injectionId } : {}),
            ...(frame.label !== undefined ? { label: frame.label } : {}),
          },
        ],
      },
    });
    return;
  }
  if (frame.kind === 'job-event') {
    // 主线 job/started · job/settled 帧形（args = [job]——主线 bridge-events
    // wire 恒等透传同形）：前端 jobBoard.onEvent 按帧 type 重拉 jobs/list
    //（帧载荷仅触发器，清单以 RPC 权威快照为准）。
    send({ type: 'job/' + frame.phase, data: { args: [frame.job] } });
    return;
  }
  if (frame.kind === 'subagents-updated') {
    // 主线 subagents/updated 帧形（args = [info, action] 参数序）：前端
    // subagentBoard.onEvent 重拉 subagents/list（帧载荷仅触发器）。
    send({ type: 'subagents/updated', data: { args: [frame.info, frame.action] } });
    return;
  }
  if (frame.kind === 'run-settled') {
    // 主线 loop/after-run 帧形（args = [request, result] 参数序）：finish 映射
    // ok→stop（主线词汇）；stop → onChatEnd 终稿入列 + 权威行重拉（收束三件
    // 件套）；error → 红色错误条；interrupted → 已中断分隔符——渲染逻辑零
    // 新增（主线 feed-core 既有 case）。
    send({
      type: 'loop/after-run',
      data: {
        args: [
          {
            agent: frame.meta?.agent,
            conversationId: frame.meta?.conversationId,
            sender: frame.meta?.sender,
            source: frame.meta?.source,
          },
          {
            finish: frame.finish === 'ok' ? 'stop' : frame.finish,
            text: frame.text,
            ...(frame.message !== undefined ? { error: frame.message } : {}),
          },
        ],
      },
    });
    return;
  }
  send({ type: 'llm/delta-end', data: { args: [{ model: undefined, meta: frame.meta }, frame.meta] } });
}

/**
 * 壳旁带流桥接（宿主持有；生命周期 = tap 连接生命周期——连接断裂即丢，
 * 不重连：B3 语义）。批器随桥接件走（per-tap 实例——壳重启后新 tap
 * 新批器，不跨壳串扰）。
 */
export class ShellStreamBridge {
  private readonly batcher: LlmDeltaBatcher;
  private readonly send: (frame: FrontendFrame) => void;

  constructor(options: StreamBridgeOptions) {
    this.send = options.send;
    this.batcher = new LlmDeltaBatcher((args) => {
      options.send({ type: 'llm/delta-batch', data: { args: [args] } });
    }, options.windowMs);
  }

  /** 旁带帧入口（tap 回调接线点） */
  ingest(frame: unknown): void {
    if (!isStreamFrame(frame)) return;
    streamFrameToFrontend(frame, this.batcher, this.send);
  }

  /** 连接收束：清空在途批（不丢帧） */
  close(): void {
    this.batcher.flushNow();
  }
}