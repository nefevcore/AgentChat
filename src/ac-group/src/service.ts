// ============================================================
// ac-group/src/service.ts —— 群服务（cordis Service）
//
// KV Cache effect（M21/D9 声明纪律）: Prefix-stable —— 派生窗钉住
// （D6）：窗口头派生一次后不动，本体新事件增量吸收——派生间字节只做
// 尾部追加。显式失效：本体轮转 / 超阈值重派生 = invalidate-from-head
// （一次显式 replace，低频）。
//
// 本包是群域的 owning package：群配置/群消息域类型（./contract.ts）、
// `<msg>` 视图包装（./view.ts）、group/* 事件目录（./events.ts）。
//
// 职责（单通道 v3，对齐 src GroupManager + GroupService）：
//   · 成员表：create/delete/join/leave/rename + setDescription + setMemoryOwner（事件通知 group/*）
//   · 内容通道：post 入流（唯一事实源）+ group/message-posted 事件
//   · GroupFeed：readSince(锚点)/currentAnchor —— busy 参与者的增量注入
//   · 投递：send = post + 逐参与者 ctx.conversation.deliver
//     （conversationId=群 id → handle=gid~member 每参与者独立门；
//     busy=steer、idle=新 run；fire-and-forget，受理即返回）
//   · 群聊行为契约（M26 行为对齐）：GROUP_CONTRACT_TEXT 经 loop/before-run
//     注入每个群 run 的"回/不回"决策点（历史尾部、触发消息之前）——
//     沉默权/不刷屏/send_group 语义；实测教训：放系统提示词会因长上下文
//     注意力稀释失效（src 轨 08-03 空转 / 08-09 回声链雪崩两次事故沉淀）
//   · 轮转（2026-10 群记忆收敛）：达阈值分流——配了记忆属主走
//     [群归档整理] run（属主写语义概要 + 重写全员共享的群记忆，
//     ARCHIVE_REVIEW_META 三处不落盘 + maxSteps 硬闸 + 超时兜底机械
//     回退）；无属主维持机械摘要轮转。
//
// 【D11 存储统一（M21 落地）】群本体**迁入 sessions 树**，消息流归
// ac-session 单 owning（规约 1）：
//   · 本体 = sessions/groups/<gid>/messages.jsonl（经 session.setShelf
//     上架；中性行：一切真实发言 role:'agent' + agent_id=说话人端点——
//     用户 post 与成员 send_group 发言同词表——post 是唯一入账口）；
//   · post → session.append（唯一写口，行 id 返回对齐 GroupFeed 锚点）；
//     群本体只收真实发言（post 唯一口）——成员 run 的终稿/步级部分行/
//     工具补行不入本体（M26：send_group 才是发言，直接输出无人可见——
//     契约明示；ac-session 按 group hint meta / groups shelf 跳过）；
//   · 退役 groups/<gid>/messages.jsonl（旧双事实源的病灶，F6②）；
//     groups/<gid>/ 保留成员表 group.json + 轮转分段 archive/（本域）；
//   · 本体读取（historyFor/GroupFeed/records）→ session.records 懒水合
//     （按 gid 一次，内存缓存；无 session 行 = 纯内存态——测试兼容）；
//   · 轮转：分段写 groups/<gid>/archive/history_N.jsonl + 机械摘要
//     summary_N.md（编排归本服务），本体重建经 session.compact
//     （owning 写口）；视图失效走 conversation.markStale（D11：本体每有
//     新发言，成员视图 stale → 下次 run 由 send 的 per-member 新种子
//     重派生——视角单源 = 本体，不再有第二事实源）；
//   · per-Agent 视角文件不采纳（S1/S3）：成员"视角桶"
//     （sessions/<gid>~<member>）是 src 时代形态——preview 以内存视图
//     + historyFor 种子承担，不落文件（写放大 + 第二事实源）。
//
// M15 持久化（行配置 root 给定即启用成员表/轮转域；缺省纯内存）：
//   <root>/groups/<gid>/group.json   成员表（原子写）
//   <root>/groups/<gid>/archive/     轮转分段 history_N.jsonl + summary_N.md
//   <root>/sessions/groups/<gid>/    本体（ac-session 域，shelf 上架）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { estimateTokens } from 'ac-text-budget';
import { ARCHIVE_REVIEW_META, isArchiveReviewRun, type LoopRunResult } from 'ac-agent-loop';
import { maxSeqOf } from 'ac-session';
import { displayNameOf } from 'ac-agents'; // 端点显示名单源解析（连带 ctx.agents 类型增强）
import type { LlmMessage } from 'ac-llm';
import type {} from 'ac-router'; // router/* 事件目录（type-only）
import type { ConversationDeliverOptions, ConversationOutcome } from 'ac-conversation';
import type {
  GroupConfig,
  GroupFeedAnchor,
  GroupFeedPage,
  GroupMessageRecord,
  GroupSendOptions,
  GroupSendResult,
} from './contract.ts';
import { wrapGroupMsg } from './view.ts';

/** 行配置（透传 GroupService 构造；index 再导出） */
export interface GroupRowOptions {
  /** 数据根（给定即启用持久化；群域目录 = <root>/groups） */
  root?: string;
  /** 本体轮转阈值（总 token；缺省 500_000） */
  archiveTokens?: number;
  /** 轮转后本体保留尾部 token 预算（缺省 30_000） */
  keepTokens?: number;
  /** 群历史回放加载预算（缺省 30_000） */
  loadLimitTokens?: number;
  /**
   * 派生窗重派生阈值（M21/D6·D5；缺省 max(100_000, loadLimitTokens×2)
   * ——loadLimitTokens > 50k 时随之上浮）
   */
  rederiveTokens?: number;
  /**
   * 属主整理 run 步数硬上限（闸①，M20 教训——失控整理是唯一现实 OOM
   * 路径；缺省 128）
   */
  reviewMaxSteps?: number;
  /** 属主整理 run 超时兜底（缺省 10 分钟；超时 = abort + 机械摘要回退强制轮转） */
  reviewTimeoutMs?: number;
  /** 残留 pending 扫描间隔（缺省 5 分钟；有 pending 才拉起周期扫描） */
  reviewScanIntervalMs?: number;
}

/**
 * ac-session 服务面（D11 跨域读写口；可选能力——未装载时纯内存态）。
 * 结构化本地类型：规约 1 跨域走服务方法，运行时按服务 key 解耦。
 */
interface SessionBackend {
  append(conversationId: string, agentId: string, message: LlmMessage): Promise<string>;
  records(conversationId: string): Promise<
    Array<{
      role: string;
      content: string;
      message_id: string;
      timestamp: string;
      agent_id?: string;
      reasoning_content?: string;
      steps?: GroupMessageRecord['steps'];
      attachments?: GroupMessageRecord['attachments'];
      seq?: number;
    }>
  >;
  compact(
    conversationId: string,
    opts: { summary?: string; keep?: Array<Record<string, unknown>>; baselineSeq?: number },
  ): Promise<void>;
  clear(conversationId: string): void;
  setShelf(conversationId: string, shelf: string): void;
}

/** SessionRecord 行 → GroupMessageRecord（本体读取投影；仅真实发言） */
function toGroupMessage(
  gid: string,
  r: {
    role: string;
    content: string;
    message_id: string;
    timestamp: string;
    agent_id?: string;
    reasoning_content?: string;
    steps?: GroupMessageRecord['steps'];
    attachments?: GroupMessageRecord['attachments'];
  },
): GroupMessageRecord {
  return {
    id: r.message_id,
    groupId: gid,
    from: r.agent_id ?? 'user',
    content: r.content,
    at: Date.parse(r.timestamp) || 0,
    // M26 前遗留行透传（steps/attachments；回复行兼容——新数据只有 post 行）
    ...(r.reasoning_content ? { reasoning: r.reasoning_content } : {}),
    ...(r.steps && r.steps.length > 0 ? { steps: r.steps } : {}),
    // M4 群聊图片：附件引用随本体行透传（UI 恢复 + historyFor 回放）
    ...(r.attachments && r.attachments.length > 0 ? { attachments: r.attachments } : {}),
  };
}

/** 铸造消息 id（内存态兜底；持久态用 session.append 返回的行 id） */
function mintMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 群投递触发信封标记键（M21 步骤 5 / F6①）：值恒 true。群 send 的逐成员
 * hint 投递携带——hint 是「投递触发器」（事实行已由 post 落入群本体），
 * ac-session 的 message-received 入账据此跳过（修影子桶 hint 按成员重复
 * N 次）；群 run 终稿不入本体（M26——群内容 = post 唯一口，send_group
 * 才是发言）。
 */
export const GROUP_HINT_META = 'group-hint';

/**
 * 群 hint 投递触发判定（M21/F6①，与 GROUP_HINT_META 同源单导出）：
 * 事实行已入群本体，session 入账/上下文视图据此跳过逐成员 hint。
 */
export function isGroupHint(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[GROUP_HINT_META] === true;
}

/**
 * 群聊行为契约正典（src 轨 group-contract.ts 逐字继承——两次真实事故
 * 沉淀的实测文案：08-03 空转（不调 send_group 直接输出，输出无人可见）/ 
 * 08-09 回声链雪崩（4 Agent 秒级互接话、91.4% 消息间隔 <3s）。契约位于
 * "回/不回"决策点而非系统提示词——群聊是最长上下文场景，系统提示词
 * 位置会注意力稀释失效（src 实测结论，勿回退）。修改文案需过真实群
 * 沉默率/回复质量验收。
 */
export const GROUP_CONTRACT_TEXT =
  '收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。';

/** 属主整理轮转 pending 标记（磁盘形态；崩溃残留由超时扫描兜底） */
interface RotationPending {
  /** 记忆属主（整理 run 目标 + 概要读取基准） */
  owner: string;
  requestedAt: string;
  /** 本次归档段号（summary_N.md 覆写目标） */
  index: number;
  /** 保留尾部首行 seq（收尾重算 keep 的锚；B1 窗口） */
  keepFromSeq?: number;
  /** 快照基线（compact baselineSeq——整理期间新到消息并入） */
  baselineSeq: number | undefined;
}

/** 整理 run 摘要物料的 token 预算（输入有界化——M20 教训，防全量起步） */
const REVIEW_DIGEST_TOKENS = 50_000;

/** 触发通知的时间行（对齐 src tail 形态） */
function timeLine(): string {
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `[当前时间] ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} ${weekdays[now.getDay()]}`;
}

/** 群 id 校验：禁路径分隔/遍历（目录名即群 id——规约 2） */
function assertGroupId(groupId: string): void {
  if (!groupId || groupId.includes('/') || groupId.includes('\\') || groupId.includes('..')) {
    throw new Error(`群 id "${groupId}" 非法（禁路径分隔/遍历字符）`);
  }
}

/** 原子写 JSON（各 owning service 自持写法） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

export class GroupService extends Service {
  /** 群配置（成员表） */
  private groups = new Map<string, GroupConfig>();

  /**
   * 群消息流（内容通道唯一事实源的本体回放缓存；D11：事实源在
   * sessions/groups/<gid>/messages.jsonl——本缓存由 session.records 懒水合
   * 或 post 增量维护，纯内存态时即为事实源）
   */
  private logs = new Map<string, GroupMessageRecord[]>();

  /** 懒水合在途守卫（gid → 水合 promise；失败即除名允许重试） */
  private logReady = new Map<string, Promise<void>>();

  /** 持久化根（undefined = 纯内存——测试/演示；群域 = 成员表 + 轮转分段） */
  private readonly storeRoot: string | undefined;
  /** 本体轮转阈值（总 token 估算；缺省 500k，src groupArchiveTokens） */
  private readonly archiveTokens: number;
  /** 轮转后本体保留尾部 token 预算（缺省 30k） */
  private readonly keepTokens: number;
  /** 群历史回放加载预算（token；缺省 30k，src groupLoadLimitTokens） */
  private readonly loadLimitTokens: number;
  /**
   * 派生窗重派生阈值（M21/D6·D5：≈0.8×保守模型窗，缺省 100k token）：
   * 窗口累计超阈 → 整体重算一次（显式 replace）。窗口钉住使派生间
   * 字节只做尾部追加（滑窗消除）。
   */
  private readonly rederiveTokens: number;
  /** 派生窗状态（gid → 钉住的窗口头 + 增量吸收水位；轮转/删群时重置） */
  private windows = new Map<string, { start: number; absorbed: number; tokens: number }>();
  /** 进行中的属主整理轮转（内存幂等闸；收尾/兜底时清） */
  private rotating = new Set<string>();
  /** 超时兜底扫描句柄（有 pending 才存在——空闲零定时器，boot 自退） */
  private scanDispose?: () => void;
  /** 闸①：属主整理 run 步数硬上限（M20 教训） */
  private readonly reviewMaxSteps: number;
  /** 属主整理 run 超时兜底 */
  private readonly reviewTimeoutMs: number;
  /** 残留 pending 扫描间隔 */
  private readonly reviewScanIntervalMs: number;

  constructor(ctx: Context, options: GroupRowOptions = {}) {
    super(ctx, 'group');
    // 持久化根缺省跟随宿主数据根（AGENTCHAT_DATA_ROOT；未设 = 内存态，
    // 测试/演示兼容）——与各持久化行同根约定（M18 数据根=启动 cwd）。
    const persistRoot = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.storeRoot = persistRoot !== undefined ? path.resolve(persistRoot, 'groups') : undefined;
    this.archiveTokens = options.archiveTokens ?? 500_000;
    this.keepTokens = options.keepTokens ?? 30_000;
    this.loadLimitTokens = options.loadLimitTokens ?? 30_000;
    this.rederiveTokens = options.rederiveTokens ?? Math.max(100_000, this.loadLimitTokens * 2);
    this.reviewMaxSteps = options.reviewMaxSteps ?? 128;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? 10 * 60_000;
    this.reviewScanIntervalMs = options.reviewScanIntervalMs ?? 5 * 60_000;
    if (this.storeRoot !== undefined) this.loadFromDisk();

    // ---- 属主整理 run 完成收尾（事件驱动；识别群桶的 archive-review
    // run——1v1 归档桶含 ~ 不在 groups 名册，天然不误触） ----
    this.ctx.on('loop/after-run', (request, result) => {
      if (!isArchiveReviewRun(request.meta)) return;
      const gid = request.conversationId;
      if (gid === undefined || !this.groups.has(gid)) return;
      if (request.agent === undefined) return;
      void this.completeRotation(gid, request.agent, result).catch((err: unknown) => {
        this.ctx.logger.error(`[group] 属主整理收尾失败（${gid}）: ${String(err)}`);
      });
    }, { description: '群轮转属主整理收尾（概要落盘 + compact 重建）' });

    // ---- 超时兜底（启动即扫一次；周期扫描懒拉起——见 syncRotationScan） ----
    void this.scanRotationPending();

    // ---- 群聊行为契约注入（M26 行为对齐；决策点 = 历史尾部、触发消息之前）----
    // 每 run 注入一次（busy steer 不重复携带——run 上下文已有一份）；
    // 只改写本次 run 的消息副本，不落盘；机制 run（归档整理）与非群桶
    // （1v1/独立会话）不注入。per-Agent 文案覆盖见 contractFor。
    this.ctx.on('loop/before-run', (call, next) => {
      const request = call.request;
      if (request.conversationId === undefined || !this.groups.has(request.conversationId)) {
        return next();
      }
      if (isArchiveReviewRun(request.meta)) return next();
      const messages = request.messages;
      if (messages.length === 0) return next();
      // 插入位 = 触发消息之前（上下文倒数第二区）：messages 末位是本次
      // 触发消息（router.send 组装 [history..., message]）
      const at = messages.length - 1;
      call.request = {
        ...request,
        messages: [
          ...messages.slice(0, at),
          { role: 'user', content: this.contractFor(request.agent) },
          ...messages.slice(at),
        ],
      };
      return next();
    }, { description: '群聊行为契约注入（决策点：历史尾部、触发消息之前；沉默权/不刷屏/send_group 语义）' });
  }

  /**
   * 群聊行为契约解析（per-Agent 覆盖）：settings['group'].contractText
   * 非空文本覆盖正典（A/B 文案实验——观察沉默率/回复质量）；空/缺省
   * 回落 GROUP_CONTRACT_TEXT（src groupContractTextOf 同语义）。
   */
  private contractFor(agentId: string | undefined): string {
    if (agentId !== undefined) {
      const cfg = this.ctx.agents.settingsOf(agentId, 'group');
      if (cfg !== undefined && cfg !== null && typeof cfg === 'object') {
        const text = (cfg as { contractText?: unknown }).contractText;
        if (typeof text === 'string' && text.trim()) return text;
      }
    }
    return GROUP_CONTRACT_TEXT;
  }

  // 端点显示名：ac-agents displayNameOf 单源（回退链 name ?? description，
  // 未注册/空 → undefined → 包装层用 id）。群内 <msg> 视图与 hint 信封
  // 据此显示"小七"而非裸 id "nana"。

  // ============================================================
  // 磁盘层（owning：成员表 + 轮转分段；本体归 ac-session 域）
  // ============================================================

  private groupDir(groupId: string): string {
    assertGroupId(groupId);
    return path.join(this.storeRoot!, groupId);
  }

  private configPath(groupId: string): string {
    return path.join(this.groupDir(groupId), 'group.json');
  }

  /** ac-session 可选解析（D11 跨域读写口；未装载 = 纯内存态） */
  private sessionBackend(): SessionBackend | undefined {
    return this.ctx.get('session', false) as SessionBackend | undefined;
  }

  /**
   * 本体懒水合（D11）：首次触达该群时从 session.records 读取并上映射；
   * 已有内存态（post 建立的水合结果 / 轮转重建）则零成本直通。并发守卫
   * 经 logReady promise 缓存（失败除名允许重试）。
   */
  private ensureLog(groupId: string): Promise<void> {
    if (!this.groups.has(groupId)) return Promise.resolve(); // 未知群：空流语义（不建缓存）
    const pending = this.logReady.get(groupId);
    if (pending) return pending;
    const hydration = this.doEnsureLog(groupId).catch((err: unknown) => {
      this.logReady.delete(groupId);
      throw err;
    });
    this.logReady.set(groupId, hydration);
    return hydration;
  }

  private async doEnsureLog(groupId: string): Promise<void> {
    if (this.logs.has(groupId)) return; // 已水合 / 内存态已建
    const session = this.sessionBackend();
    if (session) {
      // 本体桶上架（D11：sessions/groups/<gid>/；幂等——同架重复无副作用）
      try {
        session.setShelf(groupId, 'groups');
      } catch (err: unknown) {
        this.ctx.logger.warn(`[group] 本体桶上架失败（${groupId}）: ${String(err)}`);
      }
      const records = await session.records(groupId);
      const log = records
        .filter((r) => r.role === 'agent')
        .map((r) => toGroupMessage(groupId, r));
      this.logs.set(groupId, log);
    } else {
      this.logs.set(groupId, []);
    }
  }

  /** 启动加载：群目录扫描 → 成员表回内存（本体懒水合，见 ensureLog） */
  private loadFromDisk(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.storeRoot!, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 首启
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const gid = entry.name;
      try {
        const raw = JSON.parse(fs.readFileSync(this.configPath(gid), 'utf-8')) as GroupConfig;
        if (raw && typeof raw.id === 'string' && Array.isArray(raw.members)) {
          this.groups.set(gid, raw);
        }
      } catch {
        /* 损坏配置跳过（群不可见但目录保留供诊断） */
      }
    }
    if (this.groups.size > 0) {
      this.ctx.logger.info('[group] 已加载 %C 个群（持久化）', String(this.groups.size));
    }
  }

  /** 成员表落盘（原子写） */
  private persistConfig(group: GroupConfig): void {
    if (this.storeRoot === undefined) return;
    try {
      writeJsonAtomic(this.configPath(group.id), group);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 成员表落盘失败（${group.id}）: ${String(err)}`);
    }
  }

  /**
   * 本体轮转检测（src maybeArchiveBody 语义，D11 落位）：总 token 超
   * archiveTokens → 分流：
   *   · 配了记忆属主且无进行中轮转 → 属主整理漏斗（rotateWithReview：
   *     [群归档整理] run 写语义概要 + 重写群记忆，机械摘要作回退产物）；
   *   · 其余（无属主 / 整理进行中再达阈）→ 机械轮转（rotateMechanical）。
   */
  private async maybeRotate(groupId: string): Promise<void> {
    if (this.storeRoot === undefined) return;
    const session = this.sessionBackend();
    if (!session) return; // 纯内存态：无持久域
    const log = this.logs.get(groupId);
    if (!log || log.length === 0) return;
    const totalTokens = log.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    if (totalTokens <= this.archiveTokens) return;

    const owner = this.groups.get(groupId)?.memoryOwner;
    if (owner) {
      // 整理进行中：跳过（收尾后的下次增长再评估——防机械轮转与在途
      // 整理双写竞态）
      if (this.rotating.has(groupId)) return;
      // 漏斗与消息链路解耦（fire-and-forget，对齐 ac-archive requestArchive）：
      // deliver 是深链（placement next-run 等空闲 + await 整个 run 收尾），
      // await 会把跨阈值的那条消息（web-api 群 RPC / send_group 工具）阻塞
      // 分钟级——属主自己触发时（工具在其群桶 run 内执行）deliver 等空闲与
      // 工具等返回互锁至超时。收尾本就事件驱动（loop/after-run →
      // completeRotation），投递失败即行机械回退（rotateWithReview 内 catch），
      // 等空闲超时由 scanRotationPending 兜底——detach 语义等价且不阻塞
      // post 的 group/message-posted 事件与逐成员 hint 投递。
      // rotating 门在 rotateWithReview 同步前缀内即登记，并发 post 不会双跑。
      void this.rotateWithReview(groupId, owner).catch((err: unknown) => {
        this.ctx.logger.error(`[group] 属主整理轮转异常（${groupId}/${owner}）: ${String(err)}`);
        this.rotating.delete(groupId);
        this.syncRotationScan();
      });
      return;
    }
    await this.rotateMechanical(groupId);
  }

  /**
   * 机械轮转（原 maybeArchiveBody 主体；无属主群的现状路径 + 属主整理的
   * 回退产物）：旧消息入 groups/<gid>/archive/history_N.jsonl + 机械摘要
   * summary_N.md（时间/发送人/截断正文，尾部 60 条）+ 本体经
   * session.compact 重建保留尾部 keepTokens（×1.5 容差；owning 写口）。
   * 分段行 = SessionRecord 原文（steps/reasoning 随行保留——审计不降级）。
   */
  private async rotateMechanical(groupId: string): Promise<void> {
    const session = this.sessionBackend();
    if (!session) return;
    const records = await session.records(groupId); // 全 fidelity（含 steps）
    const { start: splitIdx } = this.tailScan(records.map((r) => r.content), this.keepTokens);
    if (splitIdx <= 0) return; // 全部在保留预算内（理论不达）
    const archived = records.slice(0, splitIdx);
    const kept = records.slice(splitIdx);
    const index = this.writeArchiveSegment(groupId, archived);
    if (index === undefined) return;
    this.writeMechanicalSummary(groupId, index, archived);
    await this.rebuildBody(groupId, kept, maxSeqOf(records));
    this.ctx.logger.info(
      '[group] 本体轮转 %C：%C 条 → archive/history_%C，保留尾部 %C 条',
      groupId,
      String(archived.length),
      String(index),
      String(kept.length),
    );
  }

  /**
   * 属主整理轮转（2026-10 群记忆收敛）：写归档段 + 机械摘要（回退产物）
   * → pending 标记 → 给属主投递 [群归档整理] run（source:'event' 同桶
   * 串行化门 + ARCHIVE_REVIEW_META 三处不落盘 + maxSteps 硬闸；种子 =
   * 旧概要 + 本段机械摘要全文——输入有界化，不重蹈 M20 全量起步）→
   * 完成由 loop/after-run 事件驱动收尾（completeRotation），超时由
   * scanRotationPending 兜底（abort + 机械摘要回退强制轮转）。
   */
  private async rotateWithReview(groupId: string, owner: string): Promise<void> {
    const session = this.sessionBackend();
    if (!session) return;
    this.rotating.add(groupId);
    this.syncRotationScan();
    const records = await session.records(groupId);
    const { start: splitIdx } = this.tailScan(records.map((r) => r.content), this.keepTokens);
    if (splitIdx <= 0) {
      // 保留预算已覆盖全部（理论不达）：无段可整，静默出闸
      this.rotating.delete(groupId);
      this.syncRotationScan();
      return;
    }
    const archived = records.slice(0, splitIdx);
    const kept = records.slice(splitIdx);
    const index = this.writeArchiveSegment(groupId, archived);
    if (index === undefined) {
      this.rotating.delete(groupId);
      this.syncRotationScan();
      return;
    }
    this.writeMechanicalSummary(groupId, index, archived); // 回退产物（整理成功会被覆写）
    const firstKept = kept[0];
    const pending: RotationPending = {
      owner,
      requestedAt: new Date().toISOString(),
      index,
      keepFromSeq: typeof firstKept?.seq === 'number' ? firstKept.seq : undefined,
      baselineSeq: maxSeqOf(records),
    };
    this.writeRotationPending(groupId, pending);
    const group = this.groups.get(groupId);
    const history = this.reviewSeed(groupId, owner, archived, index);
    const prompt = this.reviewPrompt(group ?? { id: groupId, name: groupId, members: [], createdAt: 0 }, owner, archived.length);
    this.ctx.logger.info(
      '[group] 属主整理轮转 %C（owner=%C，%C 条 → history_%C，整理 run 投递）',
      groupId,
      owner,
      String(archived.length),
      String(index),
    );
    // M12 铁律 2：deliver 是深链服务，经 ctx.get 取 root-traced 引用
    const conversation = this.ctx.get('conversation') as {
      deliver(
        agentId: string,
        inbound: { role: 'user'; content: string },
        options: ConversationDeliverOptions,
      ): Promise<ConversationOutcome>;
    };
    let outcome: ConversationOutcome;
    try {
      outcome = await conversation.deliver(
        owner,
        { role: 'user', content: prompt },
        {
          conversationId: groupId, // 同桶：与群消息 run 共串行化门
          sender: owner, // 机制触发 = 目标自身
          source: 'event',
          placement: 'next-run',
          meta: { [ARCHIVE_REVIEW_META]: true }, // 三处不落盘（session/usage/上下文视图）
          maxSteps: this.reviewMaxSteps, // 闸①：失控防线步数硬上限
          history, // 整理种子（旧概要 + 本段摘要物料）
          timeoutMs: this.reviewTimeoutMs, // 等空闲上限 = 兜底超时
        },
      );
    } catch (err: unknown) {
      // 投递失败（未知 Agent/构造异常）→ 无 run 无 after-run，立即机械回退
      this.ctx.logger.warn(`[group] 属主整理 run 投递失败（${owner}/${groupId}）: ${String(err)}`);
      await this.forceRotation(groupId, pending).catch(() => undefined);
      return;
    }
    if (outcome.kind === 'timeout') {
      this.ctx.logger.warn(
        `[group] 属主整理 run 等待空闲超时（${owner}/${groupId}）——交由 pending 兜底机械回退`,
      );
    }
    // 正常路径收尾在 loop/after-run（completeRotation）；queued/steered 的
    // run 迟早收束，同走事件收尾；超时漏斗由 scanRotationPending 兜底。
  }

  /**
   * 属主整理收尾（loop/after-run 事件驱动）：run 正常收束（finish='stop'）
   * → 优先读属主亲写概要（须本次请求之后更新，mtime 语义对齐 1v1 归档
   * D4）覆写 summary_N.md；失败/缺文件/未更新 → 保留机械摘要（回退）。
   * 随后 compact 重建本体（B1：baselineSeq 窗口并入整理期间新到消息）、
   * 内存 log/派生窗重置、成员视图 stale、清标记。
   */
  private async completeRotation(groupId: string, owner: string, result: LoopRunResult): Promise<void> {
    const pending = this.readRotationPending(groupId);
    if (pending === undefined || pending.owner !== owner) return; // 非本次漏斗（如已被兜底清理）
    this.ctx.logger.info(
      '[group] 属主整理收束 conv=%C owner=%C finish=%C steps=%C',
      groupId,
      owner,
      result.finish,
      String(result.steps.length),
    );
    if (result.finish === 'stop') {
      const summary = this.ownerSummaryOf(groupId, owner, pending, result.text);
      if (summary !== undefined) {
        const file = path.join(this.groupDir(groupId), 'archive', `summary_${pending.index}.md`);
        try {
          fs.writeFileSync(file, summary.endsWith('\n') ? summary : `${summary}\n`, 'utf-8');
          this.ctx.logger.info(`[group] 属主语义概要已落盘（${groupId}/summary_${pending.index}.md）`);
        } catch (err: unknown) {
          this.ctx.logger.warn(`[group] 语义概要落盘失败（保留机械摘要）: ${String(err)}`);
        }
      }
    }
    await this.forceRotation(groupId, pending);
  }

  /**
   * 强制轮转收口（整理收尾 / 投递失败 / 超时兜底共用）：按 pending 的
   * keepFromSeq 重算保留尾部（整理期间新到消息自然并入），compact 重建
   * 本体 + 内存态重置 + 清标记。
   */
  private async forceRotation(groupId: string, pending: RotationPending): Promise<void> {
    const session = this.sessionBackend();
    if (!session) return;
    await this.ensureLog(groupId); // shelf 注册 + 本体水合（崩溃残留路径首次触达）
    const records = await session.records(groupId);
    const keep =
      pending.keepFromSeq !== undefined
        ? records.filter((r) => (r.seq ?? 0) >= pending.keepFromSeq!)
        : records; // 无锚（理论不达）= 全保留，交给下次轮转
    if (keep.length === records.length && records.length > 0 && pending.keepFromSeq !== undefined) {
      // 锚点行已被删（B1 边界）：按尾部预算重扫
      const { start } = this.tailScan(records.map((r) => r.content), this.keepTokens);
      keep.splice(0, start);
    }
    await session.compact(groupId, { keep, baselineSeq: pending.baselineSeq });
    this.logs.set(
      groupId,
      keep.filter((r) => r.role === 'agent').map((r) => toGroupMessage(groupId, r)),
    );
    this.windows.delete(groupId); // 轮转 = 显式 replace：派生窗随之重置
    this.markViewsStale(groupId);
    this.rotating.delete(groupId);
    this.clearRotationPending(groupId);
    this.syncRotationScan();
  }

  /** 属主亲写概要（D4 同款 mtime 判新；缺/旧/空 → 回退 undefined 用机械摘要或回复文本） */
  private ownerSummaryOf(
    groupId: string,
    owner: string,
    pending: RotationPending,
    fallbackText: string,
  ): string | undefined {
    const requestedAt = Date.parse(pending.requestedAt);
    const file = this.ownerSummaryFile(owner, groupId);
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (!Number.isNaN(requestedAt) && stat.mtimeMs >= requestedAt) {
          const text = fs.readFileSync(file, 'utf-8').trim();
          if (text) return this.clipSummary(text);
          this.ctx.logger.info(`[group] 属主亲写概要为空（${file}），回退整理回复文本`);
        } else {
          this.ctx.logger.info('[group] 概要文件早于本次整理请求（未由属主更新），回退整理回复文本');
        }
      }
    } catch {
      /* 读失败走回退 */
    }
    return fallbackText.trim() || undefined;
  }

  /**
   * 属主亲写概要落点（服务端读侧，绝对路径；与 anchorOutput 提示词同锚）：
   * workspace.agentWorkdir 唯一事实源；未装 workspace 行回落
   * <数据根>/files/<owner>/（storeRoot 的父目录即数据根）。
   */
  private ownerSummaryFile(owner: string, groupId: string): string {
    const ws = this.ctx.get('workspace') as { agentWorkdir(id: string): string } | undefined;
    const base =
      ws !== undefined
        ? ws.agentWorkdir(owner)
        : this.storeRoot !== undefined
          ? path.join(path.dirname(this.storeRoot), 'files', owner)
          : path.join(process.cwd(), 'files', owner);
    return path.join(base, 'summary', `${groupId}.md`);
  }

  /** 概要截断到预算字数（防属主写超长文件顶爆成员上下文） */
  private clipSummary(text: string): string {
    const budget = this.summaryBudgetChars();
    if (text.length <= budget) return text;
    this.ctx.logger.warn(`[group] 概要超预算（${text.length} > ${budget} 字），截断`);
    return `${text.slice(0, budget)}\n\n（已达字数上限截断）`;
  }

  /** 概要字数预算（≈4‰ 轮转阈值；下限 400 防小阈值配置挤成零头） */
  private summaryBudgetChars(): number {
    return Math.max(400, Math.ceil(this.archiveTokens * 0.004));
  }

  /**
   * 超时兜底（崩溃残留/挂死 pending；M20 闸②语义）：扫各群 archive/
   * .pending.json 超时 → abort 属主在途整理 run → 机械摘要回退强制轮转。
   * 未超时的可能是进行中/排队等待——绝不能误清理。
   */
  private async scanRotationPending(): Promise<void> {
    if (this.storeRoot === undefined) return;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.storeRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const gid = d.name;
      if (!this.groups.has(gid)) continue;
      const pending = this.readRotationPending(gid);
      if (pending === undefined) continue;
      const requestedAt = Date.parse(pending.requestedAt || '0');
      if (Number.isNaN(requestedAt) || Date.now() - requestedAt <= this.reviewTimeoutMs) continue;
      this.ctx.logger.warn(
        `[group] 属主整理超时（> ${Math.round(this.reviewTimeoutMs / 60000)} 分钟），中止并机械回退 ${gid}`,
      );
      const conversation = this.ctx.get('conversation') as
        | { abort(agentId: string, conversationId?: string): number }
        | undefined;
      conversation?.abort(pending.owner, gid);
      await this.forceRotation(gid, pending).catch(() => undefined);
    }
    this.syncRotationScan();
  }

  /** 懒扫描（有 pending 才有周期定时器——空闲零定时器，boot 自退）。
   *  定时器 = 官方 cordis-timer（可选能力：经 ctx.get 取服务实例调
   *  interval——mixin 访问器 ctx.interval 需 inject 声明，服务方法面
   *  免声明；行未装时降级为仅构造扫描/下次轮转触发时收敛） */
  private syncRotationScan(): void {
    const timer = this.ctx.get('timer', false) as
      | { interval(fn: () => void, ms: number): () => void }
      | undefined;
    const need = this.needRotationScan();
    if (need && !this.scanDispose && timer !== undefined) {
      this.scanDispose = timer.interval(() => void this.scanRotationPending(), this.reviewScanIntervalMs);
    } else if (!need && this.scanDispose) {
      this.scanDispose();
      this.scanDispose = undefined;
    }
  }

  /** 是否存在轮转 pending（内存进行中 + 盘上残留） */
  private needRotationScan(): boolean {
    if (this.rotating.size > 0 || this.storeRoot === undefined) return this.rotating.size > 0;
    try {
      for (const d of fs.readdirSync(this.storeRoot, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(this.storeRoot!, d.name, 'archive', '.pending.json'))) {
          return true;
        }
      }
    } catch {
      /* 根目录不存在 */
    }
    return false;
  }

  /** 归档分段落盘（返回段号；失败 undefined） */
  private writeArchiveSegment(
    groupId: string,
    archived: Array<Record<string, unknown>>,
  ): number | undefined {
    try {
      const archiveDir = path.join(this.groupDir(groupId), 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const existing = fs
        .readdirSync(archiveDir)
        .filter((f) => /^history_\d+\.jsonl$/.test(f));
      const index = existing.length + 1;
      fs.writeFileSync(
        path.join(archiveDir, `history_${index}.jsonl`),
        `${archived.map((r) => JSON.stringify(r)).join('\n')}\n`,
        'utf-8',
      );
      return index;
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 归档分段落盘失败（${groupId}，下次消息重试）: ${String(err)}`);
      return undefined;
    }
  }

  /** 机械摘要落盘（时间/发送人/截断正文，尾部 60 条；回退产物 + 无属主群的主产物） */
  private writeMechanicalSummary(
    groupId: string,
    index: number,
    archived: Array<{ content: string; timestamp?: string; agent_id?: string }>,
  ): void {
    const items = archived
      .filter((r) => (r.content ?? '').trim())
      .slice(-60)
      .map((r) => {
        const ts = (r.timestamp || '').slice(0, 16).replace('T', ' ');
        const text = r.content.length > 150 ? `${r.content.slice(0, 150)}…` : r.content;
        return `- [${ts}] ${r.agent_id ?? 'user'}: ${text.replace(/\n/g, ' ')}`;
      });
    if (items.length === 0) return;
    try {
      fs.writeFileSync(
        path.join(this.groupDir(groupId), 'archive', `summary_${index}.md`),
        `# 群聊 ${groupId} 早期摘要（归档 ${new Date().toISOString().slice(0, 16)}，${archived.length} 条 → history_${index}.jsonl）\n\n${items.join('\n')}\n`,
        'utf-8',
      );
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 机械摘要落盘失败（${groupId}）: ${String(err)}`);
    }
  }

  /** 本体重建（D11 owning 写口 + B1 基线窗口；内存 log/派生窗/视图同步收口） */
  private async rebuildBody(
    groupId: string,
    kept: Array<{ role: string; content: string; message_id: string; timestamp: string; agent_id?: string; steps?: GroupMessageRecord['steps']; attachments?: GroupMessageRecord['attachments']; seq?: number }>,
    baselineSeq: number | undefined,
  ): Promise<void> {
    const session = this.sessionBackend();
    if (!session) return;
    await session.compact(groupId, { keep: kept, baselineSeq });
    this.logs.set(
      groupId,
      kept.filter((r) => r.role === 'agent').map((r) => toGroupMessage(groupId, r)),
    );
    this.windows.delete(groupId);
    this.markViewsStale(groupId);
  }

  /**
   * 属主整理 run 种子（输入有界化——不重蹈 M20 全量起步）：旧概要（上一
   * 段语义/机械摘要）+ 本段机械摘要全文（条目级 token 预算，超出丢最旧
   * 并注明）。返回 user 视角消息（conversation.deliver history 种子）。
   */
  private reviewSeed(
    groupId: string,
    _owner: string,
    archived: Array<{ content: string; timestamp?: string; agent_id?: string }>,
    index: number,
  ): LlmMessage[] {
    const parts: string[] = [];
    if (index > 1) {
      const prev = this.readArchiveSummaryFile(groupId, index - 1);
      if (prev !== undefined) {
        parts.push(`（本群更早的概要——新概要应与之衔接、合并为一条连贯叙事）\n${prev}`);
      }
    }
    const lines: string[] = [];
    let used = 0;
    let dropped = 0;
    const budget = REVIEW_DIGEST_TOKENS;
    // 新→旧装载（预算尽即止丢更旧条目）：概要的价值点在与保留尾部的
    // 衔接——对照 writeMechanicalSummary 的 .slice(-60) 同口径。旧→新
    // 遍历会在超预算时丢掉最新物料，恰留下与尾部不衔接的最旧段。
    for (let i = archived.length - 1; i >= 0; i--) {
      const r = archived[i];
      if (!(r.content ?? '').trim()) continue;
      const ts = (r.timestamp || '').slice(0, 16).replace('T', ' ');
      const text = r.content.length > 300 ? `${r.content.slice(0, 300)}…` : r.content;
      const line = `- [${ts}] ${r.agent_id ?? 'user'}: ${text.replace(/\n/g, ' ')}`;
      const t = estimateTokens(line);
      if (used + t > budget && lines.length > 0) {
        dropped++;
        continue; // 预算尽：更旧条目略过
      }
      used += t;
      lines.unshift(line); // 展示保持时间正序（旧→新）
    }
    parts.push(
      `（本段将归档的群消息摘要物料${dropped > 0 ? `（更早 ${dropped} 条已按预算略）` : ''}）\n${lines.join('\n')}`,
    );
    return [{ role: 'user', content: parts.join('\n\n') }];
  }

  /** 读指定段摘要文件（无/空 → undefined） */
  private readArchiveSummaryFile(groupId: string, index: number): string | undefined {
    try {
      const text = fs.readFileSync(
        path.join(this.groupDir(groupId), 'archive', `summary_${index}.md`),
        'utf-8',
      ).trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 属主整理提示词（对齐 1v1 归档整理 hint 哲学：Agent 亲自整理 + 会话键
   * 显式表迹 + 路径锚定专用空间；群变体——属主为全群整理，概要注入全体
   * 成员、记忆为全员共享单份）。
   */
  private reviewPrompt(group: GroupConfig, owner: string, count: number): string {
    const summaryRel = this.anchorOutput(owner, `summary/${group.id}.md`);
    const memoryRel = this.anchorOutput(owner, `memory/${group.id}.md`);
    const budget = this.summaryBudgetChars();
    return [
      `[群归档整理] 你是群「${group.name}」（键 ${group.id}）的记忆管理 Agent。群聊已达归档阈值，${count} 条早期消息即将移出会话流。请基于系统消息中的摘要物料完成以下整理：`,
      `1. 【生成群概要】把本段群聊（与已有概要衔接）的关键决策、重要结论、各成员观点与待办事项，整理为一段以"此前，"开头的自然语言，控制在 ${budget} 字以内，用 write 工具写入 ${summaryRel}（整文件即概要，重写覆盖；该概要将注入全体成员的后续上下文）。若无法使用 write 工具，直接把概要作为回复返回。`,
      `2. 【整理群记忆】重写本群（键 ${group.id}）的长期记忆文件 ${memoryRel}（不要只追加）：合并重复信息、压缩冗长表述、删除已过时或已被替代的记忆，只保留仍有效且重要的内容——用 write 工具整文件重写提交（系统提示 <memory> 块即注入自该文件，本群全体成员共享这一份记忆；重写即时生效，文件不存在则新建）。`,
      `整理是机制任务：不要发起群聊、不要等待成员回复；完成后简短确认即可，系统会自动完成归档。`,
    ].join('\n');
  }

  /**
   * 整理输出物路径锚定（写侧对齐读侧，与 ac-archive.anchorReviewPath 同源）：
   * 沙箱基准与 Agent 专用空间一致（常规/预设）给相对路径；显式
   * settings['security'].workdir 分叉时给专用空间绝对路径（沙箱已并根——
   * agentSpaceRoots）。未装 workspace 行 → 相对路径（既有约定）。
   */
  private anchorOutput(agentId: string, rel: string): string {
    const ws = this.ctx.get('workspace') as
      | { agentRelPath(id: string, relPath: string): string }
      | undefined;
    return ws ? ws.agentRelPath(agentId, rel) : rel;
  }

  /** 轮转 pending 标记路径（groups/<gid>/archive/.pending.json） */
  private rotationPendingPath(groupId: string): string {
    return path.join(this.groupDir(groupId), 'archive', '.pending.json');
  }

  private writeRotationPending(groupId: string, pending: RotationPending): void {
    try {
      const file = this.rotationPendingPath(groupId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(pending), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] pending 标记写入失败（${groupId}）: ${String(err)}`);
    }
  }

  private readRotationPending(groupId: string): RotationPending | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.rotationPendingPath(groupId), 'utf-8')) as Partial<RotationPending>;
      if (typeof raw.owner !== 'string' || !raw.owner || typeof raw.index !== 'number') return undefined;
      return {
        owner: raw.owner,
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : '',
        index: raw.index,
        keepFromSeq: typeof raw.keepFromSeq === 'number' ? raw.keepFromSeq : undefined,
        baselineSeq: typeof raw.baselineSeq === 'number' ? raw.baselineSeq : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private clearRotationPending(groupId: string): void {
    try {
      const file = this.rotationPendingPath(groupId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  /** 成员视图失效（D11：本体增长/轮转 → conversation 视图 stale，下次 run 重派生）。
   *  防御式调用：conversation 为硬依赖，但 markStale 是 D11 新面（测试桩/最小组合可能未实现） */
  private markViewsStale(groupId: string): void {
    (this.ctx.conversation as { markStale?(id: string): void } | undefined)?.markStale?.(groupId);
  }

  /** 最新轮转摘要（无归档 → undefined；historyFor 头部注入用） */
  private latestArchiveSummary(groupId: string): string | undefined {
    if (this.storeRoot === undefined) return undefined;
    try {
      const dir = path.join(this.groupDir(groupId), 'archive');
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^summary_\d+\.md$/.test(f))
        .sort((a, b) => Number((b.match(/\d+/) ?? ['0'])[0]) - Number((a.match(/\d+/) ?? ['0'])[0]));
      if (files.length === 0) return undefined;
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf-8').trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  // ============================================================
  // 成员表生命周期
  // ============================================================

  /** 创建群（成员须全部已注册为 Agent；id 禁 ~/路径字符——M19 与对键命名空间隔离；生成侧约定 g- 前缀） */
  create(def: { id: string; name: string; members: string[]; description?: string; memoryOwner?: string }): GroupConfig {
    if (
      !def.id ||
      def.id.includes('~') ||
      def.id.includes('/') ||
      def.id.includes('\\') ||
      def.id.includes('..') ||
      /\s/.test(def.id)
    ) {
      throw new Error(`群 id "${def.id}" 非法（非空，禁 ~ / 路径分隔 / .. / 空白——对键桶模型隔离）`);
    }
    if (this.groups.has(def.id)) throw new Error(`群 "${def.id}" 已存在`);
    for (const m of def.members) {
      if (!this.ctx.agents.has(m)) throw new Error(`成员 "${m}" 未注册为 Agent`);
    }
    if (def.memoryOwner !== undefined && !def.members.includes(def.memoryOwner)) {
      throw new Error(`记忆属主 "${def.memoryOwner}" 不是群成员`);
    }
    const group: GroupConfig = {
      id: def.id,
      name: def.name,
      members: [...def.members],
      createdAt: Date.now(),
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.memoryOwner !== undefined ? { memoryOwner: def.memoryOwner } : {}),
    };
    this.groups.set(group.id, group);
    this.persistConfig(group);
    this.ctx.emit('group/created', group);
    return group;
  }

  /** 删除群（内容流一并丢弃；持久化目录一并清理——本体经 session.clear owning 写口） */
  delete(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    this.groups.delete(groupId);
    this.logs.delete(groupId);
    this.logReady.delete(groupId);
    this.windows.delete(groupId);
    this.rotating.delete(groupId);
    try {
      this.sessionBackend()?.clear(groupId); // 本体桶（sessions/groups/<gid>/）
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 本体桶清理失败（${groupId}）: ${String(err)}`);
    }
    if (this.storeRoot !== undefined) {
      try {
        fs.rmSync(this.groupDir(groupId), { recursive: true, force: true });
      } catch (err: unknown) {
        this.ctx.logger.warn(`[group] 群目录清理失败（${groupId}）: ${String(err)}`);
      }
    }
    this.ctx.emit('group/deleted', groupId, group);
    return true;
  }

  /** 重命名 */
  rename(groupId: string, name: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    group.name = name;
    this.persistConfig(group);
    this.ctx.emit('group/renamed', groupId, name, group);
    return true;
  }

  /**
   * 设定/清空群简介（undefined = 清空——删键回未设置；与 setMemoryOwner
   * 的解除语义同口径）。返回变更后终值。
   */
  setDescription(groupId: string, description: string | undefined): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    if (description === undefined) delete group.description;
    else group.description = description;
    this.persistConfig(group);
    this.ctx.emit('group/description-set', groupId, group.description, group);
    return true;
  }

  /**
   * 设定/解除记忆属主（agentId 须为成员；undefined = 解除回现状——每
   * 成员各自记忆 + 机械摘要轮转）。返回变更后终值。
   */
  setMemoryOwner(groupId: string, agentId: string | undefined): GroupConfig {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`群 "${groupId}" 不存在`);
    if (agentId === undefined) {
      if (group.memoryOwner === undefined) return group; // 幂等
      delete group.memoryOwner;
    } else {
      if (!this.ctx.agents.has(agentId)) throw new Error(`属主 "${agentId}" 未注册为 Agent`);
      if (!group.members.includes(agentId)) throw new Error(`属主 "${agentId}" 不是群 "${groupId}" 的成员`);
      if (group.memoryOwner === agentId) return group; // 幂等
      group.memoryOwner = agentId;
    }
    this.persistConfig(group);
    this.ctx.emit('group/memory-owner-set', groupId, group.memoryOwner, group);
    return group;
  }

  /** 加入（agentId 须已注册；已在群中 = 幂等 true） */
  join(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group || !this.ctx.agents.has(agentId)) return false;
    if (group.members.includes(agentId)) return true;
    group.members.push(agentId);
    this.persistConfig(group);
    this.ctx.emit('group/member-added', groupId, agentId, group);
    return true;
  }

  /** 离开；群清空时自动删除；记忆属主退群 → 自动解除（管理权悬空不如显式回退） */
  leave(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    const idx = group.members.indexOf(agentId);
    if (idx === -1) return false;
    group.members.splice(idx, 1);
    let ownerCleared = false;
    if (group.memoryOwner === agentId) {
      delete group.memoryOwner;
      ownerCleared = true;
    }
    this.persistConfig(group);
    this.ctx.emit('group/member-removed', groupId, agentId, group);
    if (ownerCleared) {
      this.ctx.emit('group/memory-owner-set', groupId, undefined, group);
    }
    if (group.members.length === 0) this.delete(groupId); // 自动删除（再发 deleted 事件）
    return true;
  }

  // ---- 查询 ----

  get(groupId: string): GroupConfig | undefined {
    return this.groups.get(groupId);
  }

  list(): GroupConfig[] {
    return [...this.groups.values()];
  }

  /** 某 Agent 参与的全部群 */
  listForAgent(agentId: string): GroupConfig[] {
    return this.list().filter((g) => g.members.includes(agentId));
  }

  isMember(groupId: string, agentId: string): boolean {
    return this.groups.get(groupId)?.members.includes(agentId) ?? false;
  }

  /**
   * 本体消息原始记录（M7 WebUI 群历史渲染；规约 1：跨服务读取走服务
   * 方法）。倒序 limit/正序 offset 分页（对齐 src getGroupHistory 形态）；
   * 缺省最近 50 条。轮转入 archive 的旧段不在其中（historyFor 才带摘要）。
   * D11：事实源 = sessions/groups/<gid>/（首次触达懒水合，此后内存缓存）。
   */
  async records(groupId: string, limit = 50, offset = 0): Promise<GroupMessageRecord[]> {
    await this.ensureLog(groupId);
    const log = this.logs.get(groupId) ?? [];
    const start = Math.max(0, log.length - offset - limit);
    const end = Math.max(0, log.length - offset);
    return log.slice(start, end);
  }

  // ============================================================
  // 内容通道（单通道 v3：本体是唯一内容事实源）
  // ============================================================

  /**
   * 消息入流（不触发投递；send = post + 通知参与者）。
   * 'user' 始终允许发言（无需入成员表）；Agent 发送者须是成员。
   * D11：持久态经 session.append 落本体（sessions/groups/<gid>/，中性行
   * role:'agent' + agent_id=说话人；行 id 返回对齐 GroupFeed 锚点）；
   * 无 session 行 = 纯内存。post 后成员视图 stale（conversation.markStale
   * ——下次 run 由 send 的 per-member 新种子重派生，视角单源 = 本体）。
   */
  async post(
    groupId: string,
    from: string,
    content: string,
    attachments?: GroupMessageRecord['attachments'],
  ): Promise<GroupMessageRecord> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`群 "${groupId}" 不存在`);
    if (from !== 'user' && !group.members.includes(from)) {
      throw new Error(`发送者 "${from}" 不是群 "${groupId}" 的成员`);
    }
    await this.ensureLog(groupId);
    let id = mintMessageId();
    const session = this.sessionBackend();
    if (session) {
      try {
        id = await session.append(groupId, from, {
          role: 'user',
          content,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
      } catch (err: unknown) {
        this.ctx.logger.warn(`[group] 本体落盘失败（${groupId}，内存语义继续）: ${String(err)}`);
      }
    }
    const message: GroupMessageRecord = {
      id,
      groupId,
      from,
      content,
      at: Date.now(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    const log = this.logs.get(groupId)!;
    log.push(message);
    await this.maybeRotate(groupId);
    // 本体增长 → 成员视图失准（D11 per-member 单源派生；与 archive/completed
    // 联动同款 stale-惰性——在途 run 的信封快照不受影响）
    this.markViewsStale(groupId);
    this.ctx.emit('group/message-posted', groupId, message);
    return message;
  }

  /**
   * 群消息投递：post 入流 → 通知其余全部参与者（fire-and-forget，
   * 受理即返回；对齐 src "trigger 永远不等待 run 收尾"）。
   * busy 参与者 → conversation 按 placement（缺省 steer）注入活跃 run；
   * idle 参与者 → 新 run（tail 形态：通知携带 <msg> 全文 + 时间）。
   * history 种子（M15）：持久化时传群历史回放（重启后首跑恢复上下文；
   * 会话已有内存视图则被忽略——零额外开销）。
   */
  async send(
    groupId: string,
    from: string,
    content: string,
    options: GroupSendOptions = {},
  ): Promise<GroupSendResult> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`群 "${groupId}" 不存在`);
    const targets = group.members.filter((m) => m !== from);
    // M19：sender = 说话人端点 id（viewer 虚拟端点也是端点之一）；
    // source = 拓扑类（虚拟端点 = 'user'，Agent 成员 = 'agent'）。
    const source = this.ctx.agents.get(from)?.virtual ? ('user' as const) : ('agent' as const);
    // M21/F2+D6：per-member 派生种子在 post **之前**计算——种子不含本条
    // （本条经 hint 进信封末尾恰好一次；旧实现 post 后算种子致首轮双份）
    const histories = new Map<string, LlmMessage[]>();
    if (this.sessionBackend() !== undefined) {
      for (const member of targets) {
        histories.set(member, await this.historyFor(groupId, member));
      }
    }
    const message = await this.post(groupId, from, content, options.attachments);
    // hint = <msg> 包装（含显示名）+ 时间行（M26：不带契约——契约经
    // loop/before-run 注入决策点，busy steer 免重复携带）
    const hint = `${wrapGroupMsg({ from, displayName: displayNameOf(this.ctx.agents.get(from)), groupName: group.name, content })}\n\n${timeLine()}`;
    // M4 群聊图片：hint 信封携带附件引用（首个 run 即可见；本体行已由
    // post 落盘，session 对 GROUP_HINT_META 跳过入账——不双录）
    const hintMessage: LlmMessage = {
      role: 'user',
      content: hint,
      ...(options.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    };

    // 不 await 单个投递：trigger 语义（idle 参与者的 run 在后台进行）。
    // deliver 的同步前缀（busy 决策/门注册）在本次循环内即完成——
    // send 返回时各参与者已受理（steered 或 run 已开门）。
    // M21/F2：播种视角 per-member——各自 viewer 派生（修"非首成员以他人
    // 视角播种"）；M21/F6①：hint 投递带 GROUP_HINT_META（事实行已由 post
    // 入本体，session 不重复入账）。
    const deliveries = new Map<string, Promise<ConversationOutcome>>();
    for (const member of targets) {
      const history = histories.get(member);
      deliveries.set(
        member,
        this.ctx.conversation.deliver(member, hintMessage, {
          sender: from,
          source,
          conversationId: groupId,
          meta: { [GROUP_HINT_META]: true },
          ...(options.placement ? { placement: options.placement } : {}),
          ...(history !== undefined ? { history } : {}),
        }),
      );
    }
    if (!options.settle) {
      for (const p of deliveries.values()) {
        void p.catch((err: unknown) => {
          this.ctx.logger.warn(`[group] 投递失败 ${groupId}: ${String(err)}`);
        });
      }
    }

    const result: GroupSendResult = { message, triggered: targets };
    if (options.settle) {
      const delivery: Record<string, ConversationOutcome> = {};
      for (const [member, p] of deliveries) delivery[member] = await p;
      result.delivery = delivery;
    }
    return result;
  }

  // ============================================================
  // 群历史回放（src loadGroupHistory 语义原样；M15 持久化配套）
  // ============================================================

  /**
   * 群历史回放（viewer 视角）：peer 消息 <msg> 包装（含显示名；与
   * trigger hint/readSince 同一构造点）、own 消息投 **assistant 角色**
   * 原文（M26 行为对齐——src resolveApiRole 语义：自己的历史发言是
   * "我说过的话"，全 user 化会让上下文丢失 assistant 示范密度，模型
   * 漂移向"直接输出文本"而非调用 send_group——08-03 空转事故根因）；
   * 相邻 peer 纯发言合并（连续 user 稀释注意力、多占 token 的 src 教训）；
   * 轮转摘要注入为头部。
   * 内存态群（无持久化）回放内存流。返回消息（群历史经种子进入上下文，
   * 供 conversation.deliver 的 history 种子）。
   *
   * M21/D6（滑窗消除，§6.3）：截断窗**钉住**——派生一次后窗口头不动，
   * 本体新事件增量吸收（token 只增）；超重派生阈值（≈0.8×保守模型窗，
   * M21 D5）才整体重算一次（显式 replace、低频）。旧实现"每次回放从尾
   * 重算"使窗口头随本体增长前滑 ⇒ 每次派生的历史首条都在变 ⇒ 前缀整体
   * 重建（三形态中唯一结构性永不命中）——钉住后派生间只做尾部追加。
   * D11：事实源 = sessions 本体（懒水合；纯内存群回放内存流）。
   */
  async historyFor(groupId: string, viewer: string): Promise<LlmMessage[]> {
    const group = this.groups.get(groupId);
    const groupName = group?.name ?? groupId;
    await this.ensureLog(groupId);
    const log = this.logs.get(groupId) ?? [];
    const win = this.windowOf(groupId, log);

    // 视角包装 + 相邻 peer 纯发言合并（窗口内）；附件引用随行携带
    //（peer 合并行 = 合并内全部附件按序并集；own 行携带自身附件）
    const merged: Array<{ from: string; text: string; attachments: GroupMessageRecord['attachments'] }> = [];
    for (const m of log.slice(win.start)) {
      const isPeer = m.from !== viewer;
      const text = isPeer
        ? wrapGroupMsg({ from: m.from, displayName: displayNameOf(this.ctx.agents.get(m.from)), groupName, content: m.content })
        : m.content;
      const last = merged[merged.length - 1];
      if (isPeer && last && last.from !== viewer) {
        last.text = `${last.text}\n${text}`; // 相邻 peer 发言合成一条（<msg> 标签区分发言人）
        if (m.attachments && m.attachments.length > 0) {
          last.attachments = [...(last.attachments ?? []), ...m.attachments];
        }
      } else {
        merged.push({ from: m.from, text, attachments: m.attachments });
      }
    }

    // 轮转摘要头（有归档时始终在场——早期消息的长期记忆入口）
    const summary = this.latestArchiveSummary(groupId);
    const head =
      summary !== undefined
        ? [`（本群更早的消息已归档，以下为归档摘要，供了解背景）\n${summary}`]
        : [];
    return [
      ...head.map((content) => ({ role: 'user' as const, content })),
      ...merged.map((m) => ({
        // M26：own = assistant（自己的发言）；peer = user（入站视角）
        role: m.from === viewer ? ('assistant' as const) : ('user' as const),
        content: m.text,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      })),
    ];
  }

  // ============================================================
  // 派生窗（M21/D6：窗口钉住 + 增量吸收 + 阈值显式重派生）
  // ============================================================

  /**
   * 取/吸收派生窗：无窗 → 按尾部预算派生一次（start 钉住）；有窗 →
   * 增量吸收本体新事件（窗口头不动——派生间字节只做尾部追加）；累计
   * token 超重派生阈值 → 整体重算（一次显式 replace）。
   */
  private windowOf(groupId: string, log: GroupMessageRecord[]): { start: number; absorbed: number; tokens: number } {
    let win = this.windows.get(groupId);
    if (!win) {
      win = this.deriveWindow(log);
      this.windows.set(groupId, win);
      return win;
    }
    for (let i = win.absorbed; i < log.length; i++) {
      win.tokens += estimateTokens(log[i].content);
    }
    win.absorbed = log.length;
    if (win.tokens > this.rederiveTokens) {
      this.ctx.logger.info(
        '[group] 成员视图超阈值重派生 %C（%C token > %C，一次显式 replace）',
        groupId,
        String(win.tokens),
        String(this.rederiveTokens),
      );
      win = this.deriveWindow(log);
      this.windows.set(groupId, win);
    }
    return win;
  }

  /** 尾部预算扫描（maybeRotate 保留窗与派生窗共用同式）：从尾往前累计
   *  token 至预算 ×1.5（src 容差语义——允许末条略超预算换完整语义单元），
   *  返回纳入的最早下标与累计 token。 */
  private tailScan(contents: string[], budget: number): { start: number; tokens: number } {
    let acc = 0;
    let start = contents.length;
    for (let i = contents.length - 1; i >= 0; i--) {
      const t = estimateTokens(contents[i]);
      if (acc + t > budget * 1.5 && acc > 0) break;
      acc += t;
      start = i;
    }
    return { start, tokens: acc };
  }

  /** 尾部预算派生（start 钉住——此后只增不减） */
  private deriveWindow(log: GroupMessageRecord[]): { start: number; absorbed: number; tokens: number } {
    const { start, tokens } = this.tailScan(log.map((m) => m.content), this.loadLimitTokens);
    return { start, absorbed: log.length, tokens };
  }

  // ============================================================
  // GroupFeed（锚点增量；busy 参与者的免重复注入通道）
  // ============================================================

  /**
   * 锚点之后的增量（own 消息原文、peer 消息 <msg> 包装——与
   * historyFor 回放层一致）。无锚点 → 空增量（防双注：idle run 的全量
   * 上下文另行组装，readSince 只服务"run 进行中的增量追赶"）。
   */
  async readSince(
    groupId: string,
    anchor: GroupFeedAnchor | undefined,
    opts?: { viewer?: string },
  ): Promise<GroupFeedPage> {
    await this.ensureLog(groupId);
    const log = this.logs.get(groupId) ?? [];
    const tail = this.tailAnchor(log);
    if (anchor === undefined) return { injected: '', messageIds: [], anchor: tail };

    const start = this.locateAnchorIndex(log, anchor) + 1;
    const slice = log.slice(start);
    if (slice.length === 0) return { injected: '', messageIds: [], anchor: tail };

    const group = this.groups.get(groupId);
    const groupName = group?.name ?? groupId;
    const viewer = opts?.viewer;
    const lines: string[] = [];
    for (const m of slice) {
      // own 消息不包装（与 historyFor 行为一致）：自己说过的话以原文回显
      lines.push(
        viewer !== undefined && m.from === viewer
          ? m.content
          : wrapGroupMsg({
              from: m.from,
              displayName: displayNameOf(this.ctx.agents.get(m.from)),
              groupName,
              content: m.content,
            }),
      );
    }
    return {
      injected: lines.join('\n'),
      messageIds: slice.map((m) => m.id),
      anchor: { messageId: slice[slice.length - 1].id, index: log.indexOf(slice[slice.length - 1]) },
    };
  }

  /** 当前流尾锚点（最新一条 message id + 序号；空流 = index -1） */
  async currentAnchor(groupId: string): Promise<GroupFeedAnchor> {
    await this.ensureLog(groupId);
    return this.tailAnchor(this.logs.get(groupId) ?? []);
  }

  private tailAnchor(log: GroupMessageRecord[]): GroupFeedAnchor {
    const last = log.at(-1);
    return last === undefined ? { index: -1 } : { messageId: last.id, index: log.length - 1 };
  }

  /** 锚点定位：messageId 优先；缺失/被修剪时回退 index；都无 → -1 */
  private locateAnchorIndex(log: GroupMessageRecord[], anchor: GroupFeedAnchor): number {
    if (anchor.messageId !== undefined) {
      const i = log.findIndex((m) => m.id === anchor.messageId);
      if (i !== -1) return i;
    }
    return anchor.index ?? -1;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 群服务（ac-group 提供）：成员表 + 单通道内容流（可持久化）+ GroupFeed + 参与者投递 */
    group: GroupService;
  }
}
