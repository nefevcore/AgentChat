// ============================================================
// ac-conversation/src/service.ts —— 会话状态机服务（cordis Service）
//
// KV Cache effect（声明纪律）: 派生确定性 —— 会话上下文 = 每 run 经
// session.history(conv,{viewer}) 从会话文件重派生（与重启后首跑同一
// 投影，S3 由构造保证）。文件只追加 → 派生结果单调追加（KV 前缀稳定，
// S4 不受损）；归档/轮转 = 显式 replace（S5，重派生自然反映）。
//
// 视图增量层已退役（2026-11 根因消除）：此前视图由三个事件处理器增量
// 投影（message-received/steered/reply-completed）+ stale 补丁维护，
// 手写投影必须永远追平文件投影——2026-09-05（终稿 vs 轨迹）与
// 2026-09-23（error 收束丢轨迹，断网续聊失忆）两起同构漂移证明该
// 结构性双事实源不可维护。现 views 仅持有「最近一次派生快照」：
// startRun 每 run 无条件重派生（链跑轮间亦然——群 blindspot 语义由
// 构造保持）；无 session 行的测试组合回落上次快照（seed 即唯一事实）。
//
// 本包是会话状态机域的 owning package（ADR-1）：src router 的有状态
// 调度全部移入此处，ac-router 保持"纯转发、零会话状态"。
//
//   · 串行化门：handle（= runAddress(agent, conversationId)）→ 活跃 run；
//     同一会话同一 Agent 至多一个 run，忙时按 placement 决策
//   · inbox 双队列：next-step = steer 注入活跃 run（经
//     ctx.agentLoop.steer，能力调用）；next-turn = 跨 run 队列，
//     当前 run 结束后作为独立 run 消费（含 MAX_AUTO_WAKES 防自激）。
//     队列条目带稳定 id；queue()/removeQueued()/steerQueued() 构成
//     排队 UI 数据面（DSH queue/严格 steering 姿势），每次变更广播
//     conversation/queue-changed 权威快照
//   · 会话上下文 = **每 run 从会话文件重派生**（S1 字面化）：startRun
//     经 contextFor 调 session.history(conv,{viewer})——records() 读侧
//     自带 flush 排空 + settleChain 等待 + journal 活投影，派生永远看到
//     已入账的完整事实（含 error/中断收束的 steps 段行——2026-09-23
//     事故的根因消除）。群桶经可选 group 服务的 historyFor 专用投影；
//     调用方显式种子（options.history）优先。无 session 行的最小测试
//     组合回落上次派生快照（不构成第二事实源：seed 即唯一事实源）。
//
// M15 待投持久化（src pending-resume 的最小闭环）：行配置 root 给定
// 即启用——next-turn 队列入队即落盘（<root>/conversation/pending-
// <handle>.jsonl，先记账后受理）；消费后重写剩余；启动回放恢复
// （崩溃/42 重启后待投消息不丢。进行中 run 的消息已由 ac-session
// 入账，不属本队列职责）。
//
// 投递通知：新 run 走 router/message-received + router/reply-completed
// （经 ctx.router.send）；steer 注入不经 router → 广播
// conversation/steered（./events.ts）让 ac-session 等订阅方入账。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { runAddress, pairKey, isArchiveReviewRun } from 'ac-agent-loop';
import { TIER_RANK, tierOf, type AgentConfig } from 'ac-agents';
import { securityNoticeText, wrapWithSecurityNotice } from 'ac-sandbox-core';
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';
import type {
  ConversationDeliverOptions,
  ConversationLane,
  ConversationOutcome,
  ConversationQueuedItem,
  ConversationRunInfo,
} from './contract.ts';

/**
 * run 结束后因自主来源自动连跑的上限（防"完成→自触发→再完成"自激）。
 * 自主来源 = source='event'，以及**群桶内的 source='agent'**（M26 行为
 * 对齐：Agent 经 send_group 互答的逐成员 hint 投递是回声链——src 轨
 * kind='group' 受预算约束的语义；群桶内真人输入（source='user'）与 1v1
 * 的 Agent 委托照旧重置预算）。
 */
const MAX_AUTO_WAKES = 3;

/**
 * 缺省发送方端点（单 viewer 常量）：sender 未给出时的对键推导与队列
 * 回落基准。多 viewer 未来由投递边界（web-api 连接层）显式传 sender，
 * 本常量仅作最后兜底——不承重身份判定。
 */
const DEFAULT_SENDER = 'user';

/** placement='next-run' 等待会话空闲的缺省上限（对齐 LLM 180s 超时兜底 + 余量） */
const NEXT_RUN_TIMEOUT_MS = 190_000;

/**
 * 机制 run（归档整理）阻塞时的 next-run 等待上限：整理 run 自有超时兜底
 * （ac-archive timeoutMs 缺省 10min：超时 abort + 强制归档，门必释放）+
 * 余量。缺省 190s 会让分钟级整理把用户消息"假性超时"顶掉（outcome
 * timeout = 消息不投递不入账）。
 */
const MECHANISM_RUN_WAIT_MS = 660_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * deliver 边界提权判定（access-tier §7.2 防伪造不变量，单源）：
 *   · source='user' → 两档直达（宿主 API 面——webui 输入框快捷提权，
 *     人工当场授权；send_agent 走 source:'agent'，Agent 面够不到该字段）
 *   · source='event' → 上限 'sandbox-access'（机制分支永远不需要 full）
 *   · 其余（'agent' 等）→ 恒剥除
 */
function sanitizeElevation(
  source: LoopSource,
  elevation: 'sandbox-access' | 'full-access' | undefined,
): 'sandbox-access' | 'full-access' | undefined {
  if (elevation === undefined) return undefined;
  if (source === 'user') return elevation;
  if (source === 'event' && elevation === 'sandbox-access') return 'sandbox-access';
  return undefined;
}

/** next-turn 队列条目 */
interface QueuedTurn {
  /** 稳定条目 id（排队 UI 变更操作——删除/插话——的寻址键） */
  id: string;
  message: LlmMessage;
  sender: string;
  source: LoopSource;
  /** 入队时间（epoch ms；快照展示用） */
  queuedAt: number;
  /**
   * 本条消息的临时提权（随消息消费生效——链跑 run 按"驱动它的那条
   * 消息"的档位执行；缺省 = 无提权）。入队前已经 deliver 边界判定。
   */
  elevation?: 'sandbox-access' | 'full-access';
}

/** 排队条目 id 生成（进程内单调；持久化后跨重启稳定） */
let queuedSeq = 0;
function nextQueuedId(): string {
  return `q-${Date.now().toString(36)}-${(queuedSeq++).toString(36)}`;
}

/** 串行化门条目（活跃 run） */
interface RunEntry {
  agentId: string;
  conversationId: string;
  controller: AbortController;
  startedAt: number;
  /** run 信封 meta（机制标记——steer 拒入判定用；普通 run 缺省无） */
  meta?: Record<string, unknown>;
  /**
   * 唆使防御 notice 已包装的 sender 集（access-tier §8.2 落点 B 去重）：
   * 同 run 内同 sender 首条 steer 包装、后续裸投——防低档 Agent 连发
   * 消息时 notice 刷屏。随 run 生灭。
   */
  noticedSenders?: Set<string>;
}

/** 待投落盘行（pending-<handle>.jsonl；source 不落盘——恢复后按 'user' 计 MAX_AUTO_WAKES 预算，现存语义） */
interface PendingLine {
  /** 稳定条目 id（旧文件缺省 → 回放时补生成） */
  id?: string;
  message: LlmMessage;
  sender: string;
  /** 入队时间（epoch ms；旧文件缺省 → 回放时取当前） */
  queuedAt?: number;
  /** 本条提权（user 快捷提权语义；旧文件缺省 → 无提权） */
  elevation?: 'sandbox-access' | 'full-access';
}

/** handle 文件名安全校验（runAddress 产物仅含 [a-z0-9-_.~]，防御性校验） */
function assertHandleSafe(handle: string): boolean {
  return /^[^/\\]+$/.test(handle) && !handle.includes('..');
}

/** 会话上下文视图：最近一次派生快照（startRun 每 run 无条件重派生覆盖） */
interface ContextView {
  /** 归属会话桶（派生目标） */
  conversationId: string;
  /** 读者端点 = 本 handle 的 Agent（视角变换基准，§2.4） */
  viewer: string;
  /** 派生行——来自 seed / group.historyFor / session.history（S3 单源） */
  messages: LlmMessage[];
}

/** 行配置（透传 ConversationService 构造；index 再导出） */
export interface ConversationRowOptions {
  /** 待投持久化根（给定即启用 <root>/conversation/*.jsonl；缺省跟随宿主数据根） */
  root?: string;
}

export class ConversationService extends Service {
  /** handle → 活跃 run（串行化门；set 先于任何 await——deliver 同步前缀内完成） */
  private runs = new Map<string, RunEntry>();

  /** handle → next-turn 队列（跨 run 存活） */
  private turns = new Map<string, QueuedTurn[]>();

  /** handle → 会话上下文视图（最近派生快照；每 run 重派生覆盖——无增量维护） */
  private views = new Map<string, ContextView>();

  /** 待投持久化目录（undefined = 内存态，测试/演示兼容） */
  private readonly pendingDir: string | undefined;

  constructor(ctx: Context, options: ConversationRowOptions = {}) {
    super(ctx, 'conversation');
    // 待投持久化根缺省跟随宿主数据根（AGENTCHAT_DATA_ROOT；未设 = 内存态）
    const persistRoot = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.pendingDir =
      persistRoot !== undefined ? path.resolve(persistRoot, 'conversation') : undefined;
    if (this.pendingDir !== undefined) this.replayPending();

    // D3 残余观测：before-run veto 窗口内被吞的注入（消息已入账，
    // 下一条自然 run 重派生时可见——自愈）。只告警不重投（重投经
    // router/message-received 二次入账）；收束判定后的迟到注入由
    // steer() 封口拒绝、本事件不出现。
    this.ctx.on('loop/steer-dropped', (agent, conversationId, handle, dropped) => {
      this.ctx.logger.warn(
        '[conversation] %C 条注入在 run 收尾窗口未被消费（已入账，下次自然 run 可见；conv=%C handle=%C）',
        String(dropped.length),
        conversationId ?? agent ?? '-',
        handle,
      );
    }, { description: '收尾窗口残余注入观测' });
  }

  // ============================================================
  // 待投持久化（M15 最小闭环：入队即落盘、消费即重写、启动回放）
  // ============================================================

  private pendingPath(handle: string): string {
    return path.join(this.pendingDir!, `pending-${handle}.jsonl`);
  }

  /** 启动回放：pending-*.jsonl → turns 队列恢复 */
  private replayPending(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.pendingDir!);
    } catch {
      return; // 目录不存在 = 无残留
    }
    let restored = 0;
    for (const file of files) {
      const m = /^pending-(.+)\.jsonl$/.exec(file);
      if (!m) continue;
      const handle = m[1];
      if (!assertHandleSafe(handle)) continue;
      try {
        const lines = fs.readFileSync(this.pendingPath(handle), 'utf-8').split('\n');
        const queue: QueuedTurn[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as PendingLine;
            if (parsed && parsed.message && typeof parsed.message.role === 'string') {
              queue.push({
                id: typeof parsed.id === 'string' && parsed.id ? parsed.id : nextQueuedId(),
                message: parsed.message,
                sender: typeof parsed.sender === 'string' && parsed.sender ? parsed.sender : DEFAULT_SENDER,
                source: 'user',
                queuedAt: typeof parsed.queuedAt === 'number' && parsed.queuedAt > 0 ? parsed.queuedAt : Date.now(),
                // 提权随落盘行恢复（user 快捷提权语义跨重启保持；旧行缺省 = 无）
                ...(parsed.elevation === 'sandbox-access' || parsed.elevation === 'full-access'
                  ? { elevation: parsed.elevation }
                  : {}),
              });
            }
          } catch {
            /* 损坏行跳过 */
          }
        }
        if (queue.length > 0) {
          this.turns.set(handle, [...(this.turns.get(handle) ?? []), ...queue]);
          restored += queue.length;
        }
      } catch {
        /* 单文件读失败跳过 */
      }
    }
    if (restored > 0) {
      this.ctx.logger.info('[conversation] 已恢复 %C 条待投消息（崩溃/重启残留）', String(restored));
    }
  }

  /** 队列变更落盘（全量重写该 handle 的文件；空队列删除文件） */
  private persistQueue(handle: string): void {
    if (this.pendingDir === undefined) return;
    try {
      const file = this.pendingPath(handle);
      const queue = this.turns.get(handle) ?? [];
      if (queue.length === 0) {
        if (fs.existsSync(file)) fs.rmSync(file);
        return;
      }
      fs.mkdirSync(this.pendingDir, { recursive: true });
      const body = queue
        .map((q) =>
          JSON.stringify({
            id: q.id,
            message: q.message,
            sender: q.sender,
            queuedAt: q.queuedAt,
            ...(q.elevation ? { elevation: q.elevation } : {}),
          } satisfies PendingLine),
        )
        .join('\n');
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${body}\n`, 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err: unknown) {
      // 待投落盘失败不阻塞投递（内存语义照常；持久化尽力而为）
      this.ctx.logger.warn(`[conversation] 待投落盘失败（${handle}）: ${String(err)}`);
    }
  }

  /**
   * 投递一条入站消息（唯一入口；busy 决策点）。
   *   · 空闲 → 开新 run（经 ctx.router.send，事件面照常发射）
   *   · 忙 + next-step + placement steer → ctx.agentLoop.steer 注入活跃 run
   *   · 忙 + next-step + placement next-run → 等会话空闲后作为独立 run
   *   · 忙 + next-turn → 入队，当前 run 结束后消费（MAX_AUTO_WAKES 预算）
   * 投递错误（未知 Agent 等）由 router.send 原样抛出。
   */
  async deliver(
    agentId: string,
    inbound: string | LlmMessage,
    options: ConversationDeliverOptions = {},
  ): Promise<ConversationOutcome> {
    const message: LlmMessage =
      typeof inbound === 'string' ? { role: 'user', content: inbound } : inbound;
    const sender = options.sender ?? DEFAULT_SENDER;
    const source = options.source ?? 'user';
    // 对桶缺省（M19）：直答 = pairKey(sender, agentId)——user 只是端点之一；
    // 群/独立/委托/机制路径由调用方显式传键（web-api 边界显式算直答键，D3）。
    //（水位读写都要用 conversationId——先算键再做提权判定。）
    const conversationId0 = options.conversationId ?? pairKey(sender, agentId);
    // ---- 会话提权水位（2026-09-12 设计：机制唤醒继承）----
    // 用户 run 的快捷提权档位留痕 conv-settings（持久化），同会话后续机制
    // 唤醒（job 回投/timer/late-reply/插件回执等 source='event' 信封）
    // 未显式带档位时自动继承——否则重启/唤醒后的 run 落回 base 档，逐工具
    // 审批疲劳。防伪造不变量不变：继承也走 sanitizeElevation（event 信封
    // 上限 sandbox-access）；单次审批（ac-security）不写水位。
    const convSettings = this.ctx.get('convSettings', false) as
      | { get(id: string): { elevation?: 'sandbox-access' | 'full-access' }; set(id: string, patch: Record<string, string | null | undefined>): unknown }
      | undefined;
    if (source === 'user' && convSettings) {
      const current = convSettings.get(conversationId0).elevation;
      if (options.elevation !== current) {
        // 写水位（含清除：用户收起快捷提权 = 下次机制唤醒不再继承）
        try {
          convSettings.set(conversationId0, { elevation: options.elevation ?? null });
        } catch { /* convSettings 行未装/写失败：水位尽力而为（不影响投递） */ }
      }
    }
    const inherited =
      source === 'event' && options.elevation === undefined
        ? convSettings?.get(conversationId0).elevation
        : undefined;
    // 继承不降档（2026-09-12 反馈修正：goal-round 等机制唤醒继承水位被
    // 裁到 sandbox → 唤醒轮写 D: 盘逐文件弹审批卡，单会话实测 24 次）：
    // 水位 full-access 原样继承 full——用户在本会话武装过 full，机制
    // 唤醒是同一授权意图的延续；sanitizeElevation 对 source='event'
    // 的防伪造上限（sandbox）只约束**不可信调用方显式携带**的档位，
    // 水位继承是 deliver 边界自己合成（等价 source='user' 直达路径），
    // 不在防伪造威胁面内。水位 sandbox 原样。
    const inheritedTier: 'sandbox-access' | 'full-access' | undefined =
      inherited === 'full-access' || inherited === 'sandbox-access' ? inherited : undefined;
    // deliver 边界提权判定（access-tier §7.2 防伪造不变量，单源
    // sanitizeElevation）：'user' 两档直达（宿主 API 人工快捷提权）、
    // 'event' 上限 sandbox（防伪造：不可信调用方显式携带的档位被裁）、
    // 'agent' 恒剥除。**水位继承例外**：继承档位绕过 event 上限（见上——
    // 水位是 deliver 边界自己合成，非调用方输入，不在威胁面内），
    // 但仍走底座判定（只升不降）。
    // 提权只升不降：Agent 自有 tags 档位恒为底座——信封 elevation 不高于
    // 目标 Agent 自有档位时剥除（武装低档绝不把高档 Agent 降级执行；
    // 未注册/agents 行未装 = base 底座，判定不阻断投递）。
    let effElevation = inheritedTier ?? sanitizeElevation(source, options.elevation);
    if (effElevation !== undefined) {
      const agents = this.ctx.get('agents', false) as
        | { get(id: string): AgentConfig | undefined }
        | undefined;
      if (TIER_RANK[tierOf(agents?.get(agentId))] >= TIER_RANK[effElevation]) {
        effElevation = undefined;
      }
    }
    // 剥除 = 显式覆盖为 undefined（展开 options 会保留原 elevation——必须
    // 覆写，否则 agent 信封剥除/低档剥除语义回归为"保留原值"）。
    const effOptions: ConversationDeliverOptions =
      options.elevation !== undefined || inheritedTier !== undefined
        ? { ...options, elevation: effElevation }
        : options;
    // 对桶缺省（M19）：直答 = pairKey(sender, agentId)——user 只是端点之一；
    // 群/独立/委托/机制路径由调用方显式传键（web-api 边界显式算直答键，D3）。
    //（conversationId0 已在水位段算过同源键——直接复用。）
    const conversationId = effOptions.conversationId ?? conversationId0;
    const handle = runAddress(agentId, conversationId)!; // agentId 必填 → 恒有地址
    const lane: ConversationLane = effOptions.lane ?? 'next-step';
    // M18 调试可见性：投递入口（谁 → 哪个会话 → 走向）
    const busy = this.runs.has(handle);
    this.ctx.logger.info(
      '[conversation] deliver %C（conv=%C sender=%C/%C lane=%C %C）',
      agentId,
      conversationId,
      sender,
      source,
      lane,
      busy ? '会话忙' : '会话空闲',
    );

    if (this.runs.has(handle)) {
      // 机制 run（归档整理）拒 steer：其流式隐藏 + 回复不落盘（M20 三处
      // 不落盘），用户消息注入即"回复掉黑洞"（被计算后被丢弃）——一律
      // 等空闲后作为独立用户 run 投递，回复可见可落盘
      const mechanismBusy = isArchiveReviewRun(this.runs.get(handle)?.meta);
      if (lane === 'next-turn') {
        this.turnsFor(handle).push({
          id: nextQueuedId(),
          message,
          sender,
          source,
          queuedAt: Date.now(),
          // 提权随消息：链跑消费时按本条档位开 run（webui 快捷提权在
          // 忙态排队下不丢失）
          ...(effOptions.elevation ? { elevation: effOptions.elevation } : {}),
        });
        this.persistQueue(handle); // 先记账后受理（M15 待投持久化）
        this.notifyQueue(agentId, conversationId, handle); // 排队 UI 权威快照
        return { kind: 'queued', handle };
      }
      if (!mechanismBusy && (effOptions.placement ?? 'steer') === 'steer') {
        // 唆使防御 notice 包装（§8.2 落点 B）：包装点在信封信息尚存的
        // deliver 层（agentLoop.steer 只收裸 LlmMessage，sender/source 已丢）
        const steerMessage = this.wrapNoticeFor(handle, agentId, sender, source, message);
        if (this.ctx.agentLoop.steer(handle, steerMessage, { sender, source })) {
          // 机制标记 run（归档整理等）不进上下文视图（M20：剔除点在入口
          // 分流而非事后回滚——投影通道同款 meta 判定）
          // steer 不经 router：广播本事件让持久化/视图投影方看到这条消息
          this.ctx.emit(
            'conversation/steered',
            agentId,
            steerMessage,
            conversationId,
            handle,
            sender,
            source,
            effOptions.meta,
          );
          return { kind: 'steered', handle };
        }
        // steer 落空（活跃 run 收尾竞态 / 收束封口后迟到）→ 退化为
        // next-run：等空闲后独立 run（D3：封口后回落——消息入账一次）
      }
      // next-run：等会话空闲后作为独立 run（机制 run 阻塞时等待上限放宽
      // 到整理超时兜底之上——归档整理可达分钟级）
      const deadline =
        Date.now() +
        (effOptions.timeoutMs ?? (mechanismBusy ? MECHANISM_RUN_WAIT_MS : NEXT_RUN_TIMEOUT_MS));
      while (this.runs.has(handle)) {
        const idle = await this.waitIdle(handle, deadline - Date.now());
        if (!idle) return { kind: 'timeout', handle };
      }
    }
    return this.startRun(agentId, conversationId, handle, message, effOptions);
  }

  /**
   * 唆使防御 notice 包装（access-tier §8.2 落点 B）：source='agent' 且
   * tierOf(sender) 严格低于 tierOf(接收方) 时把 <security-notice> 块包装
   * 进消息内容（system 已装配不可中途加块——包装进尾部追加的 user 消息，
   * 前缀零改动）。同 run 同 sender 去重（首条包装，后续裸投）。
   * 未注册 sender（agents.get 不到，如存量 sub_* 身份）视作 base——
   * 宁多注不漏注（fail-closed 方向）。agents 行未装载 = 无档位可判，
   * 不注入（软缓解不构成硬边界，缺依赖不阻塞投递）。
   */
  private wrapNoticeFor(
    handle: string,
    agentId: string,
    sender: string,
    source: LoopSource,
    message: LlmMessage,
  ): LlmMessage {
    if (source !== 'agent') return message;
    if (typeof message.content !== 'string' || message.content === '') return message;
    const agents = this.ctx.get('agents', false) as
      | { get(id: string): AgentConfig | undefined }
      | undefined;
    if (agents === undefined) return message;
    const senderTier = tierOf(agents.get(sender));
    if (TIER_RANK[senderTier] >= TIER_RANK[tierOf(agents.get(agentId))]) return message;
    const entry = this.runs.get(handle);
    if (entry === undefined) return message;
    if (entry.noticedSenders?.has(sender)) return message;
    (entry.noticedSenders ??= new Set<string>()).add(sender);
    return {
      ...message,
      content: wrapWithSecurityNotice(securityNoticeText(sender, senderTier), message.content),
    };
  }

  /**
   * 中止活跃 run（软中断：signal 在 step 边界生效，run 以
   * finish='interrupted' 收尾，next-turn 链跑随之停止）。
   * @param agentId 目标 Agent
   * @param conversationId 可选会话桶键（给出 = 精确中止该会话；缺省 = 中止该 Agent 全部活跃会话）
   * @returns 中止的 run 数
   */
  abort(agentId: string, conversationId?: string): number {
    let aborted = 0;
    for (const entry of this.runs.values()) {
      if (entry.agentId !== agentId) continue;
      if (conversationId !== undefined && entry.conversationId !== conversationId) continue;
      entry.controller.abort();
      aborted++;
    }
    return aborted;
  }

  /** 全部运行中会话（运行跟踪/诊断） */
  listRunning(): ConversationRunInfo[] {
    return [...this.runs.entries()].map(([handle, e]) => ({
      agentId: e.agentId,
      conversationId: e.conversationId,
      handle,
      startedAt: e.startedAt,
    }));
  }

  /** 诊断快照：运行中会话 + 各 handle 的 next-turn 积压 */
  stats(): { running: ConversationRunInfo[]; queued: Record<string, number> } {
    const queued: Record<string, number> = {};
    for (const [handle, q] of this.turns) if (q.length > 0) queued[handle] = q.length;
    return { running: this.listRunning(), queued };
  }

  /** 会话是否繁忙（handle 粒度；conversationId 缺省 = 直答对桶 pairKey(DEFAULT_SENDER, agentId)） */
  isBusy(agentId: string, conversationId?: string): boolean {
    return this.runs.has(runAddress(agentId, conversationId ?? pairKey(DEFAULT_SENDER, agentId))!);
  }

  // ============================================================
  // next-turn 队列读写（排队 UI 数据面；DSH queue 姿势）
  // ============================================================

  /** 排队消息快照（conversationId 缺省 = 直答对桶；顺序 = 投递顺序） */
  queue(agentId: string, conversationId?: string): ConversationQueuedItem[] {
    const conv = conversationId ?? pairKey(DEFAULT_SENDER, agentId);
    const list = this.turns.get(runAddress(agentId, conv)!) ?? [];
    return list.map((q) => ({
      id: q.id,
      preview: q.message.content,
      sender: q.sender,
      source: q.source,
      queuedAt: q.queuedAt,
    }));
  }

  /**
   * 删除一条排队消息（排队 UI 行删除）。已消费（链跑开始）的条目自然
   * not-found——前端以 queue-changed 快照为准，不显示失败。
   * @returns 是否删除成功（条目仍在队列中）
   */
  removeQueued(agentId: string, conversationId: string | undefined, id: string): boolean {
    const conv = conversationId ?? pairKey(DEFAULT_SENDER, agentId);
    const handle = runAddress(agentId, conv)!;
    const list = this.turns.get(handle);
    const idx = list?.findIndex((q) => q.id === id) ?? -1;
    if (!list || idx === -1) return false;
    list.splice(idx, 1);
    this.persistQueue(handle);
    this.notifyQueue(agentId, conv, handle);
    return true;
  }

  /**
   * 排队消息插话（DSH 严格 steering 语义）：原子地把一条排队消息转移到
   * 活跃 run 的下一步（steer 注入），不再等当前 run 结束。
   *   · 成功 → 'steered'（消息出队，经 conversation/steered 入账）
   *   · 窗口已关（run 收束竞态/会话空闲）→ 放回原位返回 'requeued'
   *     （DSH 语义：收敛竞态不报失败，消息仍按队列正常投递）
   *   · 条目不存在（已消费/已删）→ 'not-found'
   */
  steerQueued(
    agentId: string,
    conversationId: string | undefined,
    id: string,
  ): 'steered' | 'requeued' | 'not-found' {
    const conv = conversationId ?? pairKey(DEFAULT_SENDER, agentId);
    const handle = runAddress(agentId, conv)!;
    const list = this.turns.get(handle);
    const idx = list?.findIndex((q) => q.id === id) ?? -1;
    if (!list || idx === -1) return 'not-found';
    const [item] = list.splice(idx, 1);
    // 机制 run（归档整理）拒插话：注入即"回复掉黑洞"（同 deliver steer 门）
    // ——放回原位按队列正常投递
    if (
      !isArchiveReviewRun(this.runs.get(handle)?.meta)
    ) {
      // 唆使防御 notice 包装（§8.2 落点 B 同规则：steerQueued 与 deliver
      // steer 分支同属信封信息尚存的注入层）
      const steerMessage = this.wrapNoticeFor(handle, agentId, item.sender, item.source, item.message);
      if (this.ctx.agentLoop.steer(handle, steerMessage, { sender: item.sender, source: item.source })) {
        this.persistQueue(handle);
        // steer 不经 router：广播入账事件（ac-session/视图投影/前端上屏）
        this.ctx.emit('conversation/steered', agentId, steerMessage, conv, handle, item.sender, item.source);
        this.notifyQueue(agentId, conv, handle);
        return 'steered';
      }
    }
    list.splice(idx, 0, item); // 机制 run / 窗口已关：放回原位（不丢消息）
    this.notifyQueue(agentId, conv, handle);
    return 'requeued';
  }

  /** 队列权威快照通知（排队 UI 唯一事实源；DSH session/queue 姿势） */
  private notifyQueue(agentId: string, conversationId: string, handle: string): void {
    this.ctx.emit('conversation/queue-changed', agentId, conversationId, handle, this.queue(agentId, conversationId));
  }

  // ============================================================
  // 内部：串行化门 + next-turn 链跑
  // ============================================================

  /** 开跑（含 next-turn 链跑消费）：注册门 → router.send → 入账 → 消费队列 */
  private async startRun(
    agentId: string,
    conversationId: string,
    handle: string,
    firstMessage: LlmMessage,
    options: ConversationDeliverOptions,
  ): Promise<ConversationOutcome> {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const entry: RunEntry = {
      agentId,
      conversationId,
      controller,
      startedAt: Date.now(),
      ...(options.meta ? { meta: options.meta } : {}),
    };
    this.runs.set(handle, entry); // 同步注册：deliver 同步前缀内即完成（竞态安全）
    // 上下文重派生（2026-11 视图增量层退役）：每 run 从会话文件（或调用
    // 方种子 / 群 historyFor）重新派生——S3 由构造保证（进程内 ≡ 重启后）。
    // 机制标记 run（归档整理，M20）不进文件（meta 判定在 ac-session 入账
    // 侧），重派生天然零污染。
    let view = await this.contextFor(handle, conversationId, agentId, options.history);
    let message = firstMessage;
    let sender = options.sender ?? DEFAULT_SENDER;
    let source: LoopSource = options.source ?? 'user';
    // 提权随消息（webui 快捷提权）：每个链跑 run 按"驱动它的那条消息"
    // 的档位执行——首条 = deliver 边界判定后的 options.elevation，
    // next-turn 消费取该条入队时携带的档位。
    let elevation = options.elevation;
    let autoWakes = 0;
    let first: LoopRunResult | undefined;
    // 群桶判定（M26 行为对齐）：群名册经可选 group 服务（root-traced 解析，
    // 未装群行 = 恒非群桶）。群桶内 Agent 来源（send_group 互答 hint 的
    // next-turn 链跑）与机制触发同属自激链——不重置预算。
    const group = this.ctx.get('group', false) as { get(id: string): unknown } | undefined;
    const groupBucket = group !== undefined && group.get(conversationId) !== undefined;

    try {
      let firstTurn = true;
      while (true) {
        // 轮间重派生（2026-11 视图增量层退役后由构造保证）：链跑轮间
        // 无条件从文件重派生——busy 成员在 run 延伸中能看到自己刚
        // send_group 的发言（2026-09-13 群 blindspot 修复语义保持），
        // 且无需任何 stale 标记。首轮视图已在 startRun 顶部派生（调用方
        // 种子优先），此处跳过。在途 run 的信封快照不受影响（S3
        // 语义保持——每轮快照仍为"本条之前"的稳定拷贝，轮内不再变）。
        if (!firstTurn) view = await this.contextFor(handle, conversationId, agentId, undefined);
        firstTurn = false;
        // run 信封快照：取"本条之前"的拷贝，router 会把本条追加到信封
        // 末尾。上下文已是文件派生单源（error/中断收束的 steps 段行、
        // journal 活投影均由 records() 读侧并入）。
        const history = [...view.messages];
        // 投递失败（如未知 Agent）无需回滚：require 先于 message-received
        // emit（无事件无行）；emit 之后的失败（缺 model 等）行已入文件，
        // 视图与文件一致（S3 语义，旧回滚反而是分叉源）。错误原样上抛
        const result: LoopRunResult = await this.ctx.router.send(agentId, message, {
          sender,
          source,
          conversationId,
          history,
          ...(options.model ? { model: options.model } : {}),
          ...(options.maxSteps != null ? { maxSteps: options.maxSteps } : {}),
          ...(options.meta ? { meta: options.meta } : {}),
          ...(elevation ? { elevation } : {}),
          signal: controller.signal,
        });
        if (first === undefined) first = result;
        if (result.finish === 'interrupted') break; // 中断链跑（ADR-2）

        // ---- next-turn 消费：当前 run 完全结束后才开下一个独立 run ----
        const queue = this.turns.get(handle);
        const next = queue?.shift();
        if (next === undefined) break;
        this.persistQueue(handle); // 消费即重写（M15：磁盘与内存同步）
        this.notifyQueue(agentId, conversationId, handle); // 排队 UI 权威快照
        this.ctx.logger.info(
          '[conversation] 链跑下一轮 %C（conv=%C sender=%C/%C）',
          agentId,
          conversationId,
          next.sender,
          next.source,
        );
        if (next.source === 'event' || (groupBucket && next.source === 'agent')) {
          if (autoWakes >= MAX_AUTO_WAKES) {
            // 预算用尽：放回队首，等外部输入带来的下一次自然唤醒
            queue!.unshift(next);
            this.persistQueue(handle);
            this.notifyQueue(agentId, conversationId, handle);
            break;
          }
          autoWakes++;
        } else {
          autoWakes = 0; // 用户来源（及 1v1 的 Agent 委托）重置预算
        }
        message = next.message;
        sender = next.sender;
        source = next.source;
        elevation = next.elevation;
      }
    } finally {
      if (this.runs.get(handle) === entry) this.runs.delete(handle);
    }
    return { kind: 'run', result: first! };
  }

  /**
   * 重派生会话上下文视图（每 run 调用——视图增量层退役后无沿用路径）：
   *   · 调用方显式种子（群 send 的 per-member historyFor）优先；
   *   · 群桶 → 可选 group 服务的 historyFor 专用投影（<msg> 包装/
   *     peer 合并/own=assistant——session.history 角色投影不含这些，
   *     形状单源归群侧）；2026-09-13 群 blindspot 修复语义由「轮间
   *     无条件重派生」构造保持；
   *   · 其余 → session.history(conv, {viewer}) 文件派生（唯一回放边界，
   *     F1——直答/独立会话重启后首跑上下文连续；records() 读侧自带
   *     flush 排空 + settleChain 等待 + journal 活投影，error/中断
   *     收束的 steps 段行完整可见——2026-09-23 事故根因消除）；
   *   · session 行未装载（最小测试组合）→ 沿用上次快照（无则空）：
   *     seed 即唯一事实源，不构成第二事实源。
   */
  private async contextFor(
    handle: string,
    conversationId: string,
    viewer: string,
    seed: LlmMessage[] | undefined,
  ): Promise<ContextView> {
    let messages: LlmMessage[] | undefined;
    if (seed && seed.length > 0) {
      messages = [...seed];
    } else {
      // 群桶：historyFor 专用投影优先（<msg> 包装/peer 合并/own=assistant）
      const group = this.ctx.get('group', false) as
        | { get(id: string): unknown; historyFor(id: string, viewer: string): Promise<LlmMessage[]> }
        | undefined;
      const groupView =
        group !== undefined && group.get(conversationId) !== undefined
          ? await group.historyFor(conversationId, viewer)
          : undefined;
      if (groupView !== undefined && groupView.length > 0) {
        messages = groupView;
      } else {
        const session = this.ctx.get('session', false) as
          | { history(id: string, options?: { viewer?: string }): Promise<LlmMessage[]> }
          | undefined;
        if (session !== undefined) {
          messages = await session.history(conversationId, { viewer });
        }
      }
    }
    // 无派生源（无 seed/无群/无 session 行）：沿用上次快照（最小测试组合）
    if (messages === undefined) {
      const existing = this.views.get(handle);
      messages = existing ? [...existing.messages] : [];
    }
    const view: ContextView = { conversationId, viewer, messages };
    this.views.set(handle, view);
    return view;
  }

  private turnsFor(handle: string): QueuedTurn[] {
    let queue = this.turns.get(handle);
    if (!queue) {
      queue = [];
      this.turns.set(handle, queue);
    }
    return queue;
  }

  /** 等待 handle 空闲（不中止它）；双拍确认覆盖"旧 run 刚清理、新 run 尚未注册"的间隙 */
  private async waitIdle(handle: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.runs.has(handle)) {
      if (Date.now() >= deadline) return false;
      await sleep(20);
    }
    await sleep(20);
    return !this.runs.has(handle);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话状态机（ac-conversation 提供）：串行化门 + inbox 双队列 + steer/next-run placement */
    conversation: ConversationService;
  }
}
