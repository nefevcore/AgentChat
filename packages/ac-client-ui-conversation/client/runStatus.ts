// ============================================================
// runStatus.ts —— 会话状态推导纯函数层（cr-744）
//
// 发起会话到前端首输出的静默空窗可视化判据（全部来自 feed 分区态，
// 零后端改动）。状态按【分区当前活动】推导而非按帧序推进——任一帧
// 丢失只影响相邻档位细分，不会卡死（run-started 帧在冷启动场景可能
// 落在 tap 桥接建立前丢失，delta 到达仍能点亮 thinking/replying）：
//   waking    streaming 但无任何 run 迹象——投递/冷启动窗口
//   connecting waking 窗细分：wire 断开、消息未出门（连接 host 等待——
//             本地判定，见 deriveRunStatus 的 env.wireConnected）
//   spawning  waking 窗细分：宿主确认壳拉起在飞（启动 shell 等待——
//             spawn → boot.ready 窗口，宿主 stats 轮询回填的 inflight 集）
//   calling   占位已建（或 runStartAt 已设）但全空——模型 API 往返窗口
//   thinking  流式占位有思考内容——reasoning delta 到达
//   tooling   有运行中工具（未闭合 tool 行 / running toolCalls）
//   replying  流式占位有正文——content delta 到达
//   error     busyFeedback error 通道（投递失败/看门狗超时并入，
//             用户裁决：反馈面收敛到一处）
//   hidden    无分区 / run 不在途（组合判据，见 runInFlight）
// 计时：全档共用 sinceMs（末条 viewer 消息 ts）——「整体耗时」从用户
// 发送那一刻起算，跨档连续不归零（用户裁决 2026-10-28）。
// 消费方：RunStatusDockHost（feed 分区态 → 本层推导 → 纯展示卡）。
// ============================================================

/** 会话状态（hidden = 卡不渲染） */
export type RunStatus =
  | { kind: 'waking'; sinceMs: number }
  | { kind: 'connecting'; sinceMs: number }
  | { kind: 'spawning'; sinceMs: number }
  | { kind: 'calling'; sinceMs: number }
  | { kind: 'thinking'; sinceMs: number }
  | { kind: 'tooling'; sinceMs: number }
  | { kind: 'replying'; sinceMs: number }
  | { kind: 'error'; text: string }
  | { kind: 'hidden' };

/** 分区态最小面（DialogFeed 结构子集——测试可直接造桩） */
export interface RunStatusDialog {
  streaming: boolean;
  runStartAt?: number;
  /** 最近分区活动时刻（bump 刷新——权威判死的静默豁免窗基准） */
  lastStreamAt?: number;
  rawMessages: Array<{
    role: string;
    agent_id?: string;
    timestamp?: number;
    content?: string;
    thinking?: string;
    reasoning_content?: string;
    isStreaming?: boolean;
    toolCalls?: unknown[];
    files?: unknown[];
  }>;
}

/** 计时起点：末条 viewer 消息 ts（sendMessage append 时刻——整体耗时锚） */
export function lastViewerTs(d: RunStatusDialog): number {
  for (let i = d.rawMessages.length - 1; i >= 0; i--) {
    const m = d.rawMessages[i]!;
    if (m.agent_id === 'user' && typeof m.timestamp === 'number') return m.timestamp;
  }
  return 0;
}

/** 整体耗时中文完整格式：47 秒 / 1 分 23 秒 / 1 小时 2 分 5 秒（不压缩） */
export function formatDurationCn(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${ss} 秒`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

// ── 相位判据（全部就地推导，不依赖帧序）──

/** 运行中 toolCall 判定（宽松形状收窄——直播 toolCalls 是宽松对象；
 * 死 partial 行无 running/preparing 标记不误判） */
function isRunningTc(tc: unknown): boolean {
  return typeof tc === 'object' && tc !== null
    && ((tc as { running?: unknown }).running === true || (tc as { preparing?: unknown }).preparing === true);
}

/** 工具执行窗口（无活跃步载体时——after-step 关载体到下一步 step-started
 * 建新载体之间）：直播 tool 占位（isStreaming——含最短转圈延迟关停窗）
 * 或 agent.toolCalls 有 running/preparing */
function hasRunningTool(d: RunStatusDialog): boolean {
  return d.rawMessages.some((m) =>
    (m.role === 'tool' && m.isStreaming === true)
    || (m.role === 'agent' && (m.toolCalls ?? []).some(isRunningTc)));
}

/** 最后一个流式 agent 占位（当前步载体；null = 无在途占位） */
function lastStreamingAgent(d: RunStatusDialog): RunStatusDialog['rawMessages'][number] | null {
  for (let i = d.rawMessages.length - 1; i >= 0; i--) {
    const m = d.rawMessages[i]!;
    if (m.role === 'agent' && m.isStreaming === true) return m;
  }
  return null;
}

/** run 进行中组合判据：streaming 标志（发送即置/边界帧维护）+ 流式
 * 占位在场。单押 streaming 会在边界帧丢失窗口（后端重启/刷新撞上广播
 * 帧）漏判——中途 delta 帧只写占位不置 streaming，占位在场即 run 在途。
 * 【刻意不含「content 空的 tool 行」】工具执行窗口由 d.streaming 兜住
 * （onStepEnd 带工具调用不熄灭）；而 run 进行中刷新带回的 partial 检查
 * 点行同为 content 空——后端已重启时是死行（收束行永不到），计入则
 * 状态卡恒 tooling 不收束。 */
function runInFlight(d: RunStatusDialog): boolean {
  return d.streaming || d.rawMessages.some((m) => m.isStreaming === true);
}

/** waking 窗外部判据（cr-840）：两等待相位的真源在推导层之外——
 * connecting 是本地 wire 态（消息还压在 rpc-wire 的 queue 里没出门），
 * spawning 是宿主编排面 inflight 集（spawn → boot.ready 在飞）。两者
 * 都是「缺省按无」的可选信号：缺省 waking 不细分，行为与 cr-840 前一致。 */
export interface WakeEnv {
  /** wire 连接态（缺省 true = 已连）；waking 窗内 false → connecting */
  wireConnected?: boolean;
  /** 会话目标 agent（Host 席位数据）；宿主正在拉它的壳 → spawning */
  targetAgent?: string;
  /** 宿主正在拉壳的 agent 集（缺省空）；含目标 agent → spawning */
  spawningAgents?: ReadonlySet<string>;
}

/**
 * 状态推导（分区态 + busy 反馈 → 九态）。判据序：
 *   权威判死（cr-756）→ error → 在途组合判据 → 载体相位 → waking 细分。
 * 权威 miss + 20s 静默 = 死行收束（本地帧残留但 shell 说 settled——
 * 后端重启/刷新窗口的权威对账，替代启发式死行判别）；新帧到达
 * （bump 清标记）即恢复本地帧自治。
 * 多步 run 自然流转：唤醒 → API → 思考 → 工具 → API → 思考 → 回复 → … → hidden。
 * waking 细分优先级（cr-840）：connecting > spawning——wire 断开时宿主
 * 信号不可达（stats 轮询也在等重连），先陈述本地确凿事实。
 */
export function deriveRunStatus(
  d: RunStatusDialog | null | undefined,
  busyFeedback: string,
  busyTone: 'info' | 'error',
  authoritativeActive: boolean | undefined = undefined,
  nowMs: number = Date.now(),
  env: WakeEnv = {},
): RunStatus {
  if (busyFeedback !== '' && busyTone === 'error') {
    return { kind: 'error', text: busyFeedback };
  }
  // 权威判死：shell stats 确认不在跑 + 本地 20s 无新帧（豁免窗内后端可能
  // 只是还没广播下一帧——对齐悬挂探针 STREAM_STALE_PROBE_MS 口径）
  if (authoritativeActive === false && d && (nowMs - (d.lastStreamAt ?? 0)) > 20_000) {
    return { kind: 'hidden' };
  }
  if (!d || !runInFlight(d)) return { kind: 'hidden' };
  const sinceMs = lastViewerTs(d);
  const carrier = lastStreamingAgent(d);
  if (carrier) {
    if (carrier.content) return { kind: 'replying', sinceMs };
    if (carrier.thinking || carrier.reasoning_content) return { kind: 'thinking', sinceMs };
    if ((carrier.toolCalls ?? []).some(isRunningTc)) return { kind: 'tooling', sinceMs }; // 载体自带工具分片（参数流式/preparing）
    return { kind: 'calling', sinceMs }; // 占位已建但全空——API 往返
  }
  if (hasRunningTool(d)) return { kind: 'tooling', sinceMs }; // 步间工具执行窗口
  if (d.runStartAt !== undefined) return { kind: 'calling', sinceMs }; // run 已启动、step 未到
  // waking 细分（cr-840）：无任何 run 迹象的静默窗——先看 wire 断开（消息
  // 未出门），再看宿主拉壳在飞；都不是则维持通用 waking。
  if (env.wireConnected === false) return { kind: 'connecting', sinceMs };
  if (env.targetAgent !== undefined && env.spawningAgents?.has(env.targetAgent) === true) {
    return { kind: 'spawning', sinceMs };
  }
  return { kind: 'waking', sinceMs }; // 投递在途/壳已就绪待响应——通用冷启动窗
}