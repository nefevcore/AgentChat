// ============================================================
// ac-group/src/service.ts —— 群服务（cordis Service）
//
// 【cr-4 成员私有转录流】（memory-timeline-plan §四，推翻 D11 S1/S3
// 与派生视图路线）：成员上下文不再每 run 从本体派生——post 扇出
// viewer 投影行进成员私有流（sessions/<gid>~<member>/），成员 run 走
// 标准 session 机制（journal/settlement/步级转录/崩溃恢复/回放/压缩
// 全套）。派生窗全族（windowOf/deriveWindow/tailScan D6）、相邻 peer
// 合并、historyFor 派生视图退役（historyFor 降级为入群种子）。
//
// KV Cache effect: Prefix-stable by construction——成员流只做尾部
// 追加（扇出投影 + run 转录），无就地变异、无重派生。
//
// 本包是群域的 owning package：群配置/群消息域类型（./contract.ts）、
// `<msg>` 视图包装（./view.ts）、group/* 事件目录（./events.ts）。
//
// 职责：
//   · 成员表：create/delete/join/leave/rename + setDescription（事件
//     通知 group/*）；双向名册校验（群 id 撞 Agent id 拒——撞形防线）
//   · 内容通道：post 入本体（唯一发言事实源）+ 成员流扇出 +
//     group/message-posted 事件
//   · 投递：send = post + 逐成员 conversation.deliver（成员流键
//     gid~member；hint 只唤醒不携消息——投影行已入账；fire-and-forget）
//   · 群聊行为契约（M26）：GROUP_CONTRACT_TEXT 经 loop/before-run 注入
//     决策点（判定键含成员流键——isGroupConversation）
//   · 本体轮转：达阈值机械轮转（archive/ 分段 + 摘要；属主整理随
//     memoryOwner 全链退役——群共享记忆概念消失，cr-4）
//
// 【D11 存储统一（保留部分）】本体 = sessions/groups/<gid>/
// messages.jsonl（shelf 上架，post 唯一入账口——群本体只收真实发言；
// 成员 run 转录不落本体，落成员流）。成员流 = sessions/<gid>~<member>/
// （cr-4 新增，标准 session 桶——无 shelf，settlement 全套照常）。
//
// M15 持久化（行配置 root 给定即启用；缺省纯内存）：
//   <root>/groups/<gid>/group.json   成员表（原子写）
//   <root>/groups/<gid>/archive/     轮转分段 history_N.jsonl + summary_N.md
//   <root>/sessions/groups/<gid>/    本体（ac-session 域，shelf 上架）
//   <root>/sessions/<gid>~<member>/  成员私有转录流（cr-4）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { estimateTokens } from 'ac-text-budget';
import { isArchiveReviewRun } from 'ac-agent-loop';
import { GROUP_HINT_META, maxSeqOf } from 'ac-core-utils'; // 跨行协议纯函数（原住本包/ac-session，解 session⇄group 环；2026-09-05 边界评估）
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
 * 成员私有转录流键（cr-4）：sessions/<gid>~<member>/——runAddress 同形
 * （member 恒最右，右起解析无歧义；gid 禁 ~ 使拆分唯一）。撞形防线：
 * 群 id 禁 ~（规约）+ 双向名册校验（create/register 双卡）+ 一致性测试。
 */
export function memberStreamKey(groupId: string, member: string): string {
  return `${groupId}~${member}`;
}

// GROUP_HINT_META / isGroupHint 已下沉 ac-core-utils（跨行协议纯函数）：
// session/conversation/ws-bridge 消费、本行生产，随本包导出会与 D11 存储
// 方向相逆成环——见 ac-core-utils 包头。

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

  constructor(ctx: Context, options: GroupRowOptions = {}) {
    super(ctx, 'group');
    // 持久化根缺省跟随宿主数据根（AGENTCHAT_DATA_ROOT；未设 = 内存态，
    // 测试/演示兼容）——与各持久化行同根约定（M18 数据根=启动 cwd）。
    const persistRoot = options.root ?? process.env.AGENTCHAT_DATA_ROOT;
    this.storeRoot = persistRoot !== undefined ? path.resolve(persistRoot, 'groups') : undefined;
    this.archiveTokens = options.archiveTokens ?? 500_000;
    this.keepTokens = options.keepTokens ?? 30_000;
    if (this.storeRoot !== undefined) this.loadFromDisk();

    // ---- 群聊行为契约注入（M26 行为对齐；决策点 = 历史尾部、触发消息之前）----
    // 每 run 注入一次（busy steer 不重复携带——run 上下文已有一份）；
    // 只改写本次 run 的消息副本，不落盘；机制 run（归档整理）与非群会话
    // 不注入。判定键（cr-4 成员转录流）：conversationId ∈ 群名册 **或**
    // gid~member 形（成员流 run——handle 解析 gid 后命中名册）。
    // per-Agent 文案覆盖见 contractFor。
    this.ctx.on('loop/before-run', (call, next) => {
      const request = call.request;
      if (request.conversationId === undefined || !this.isGroupConversation(request.conversationId)) {
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
   * 群会话判定（cr-4 成员转录流）：conversationId = 群本体键（群名册）或
   * 成员流键 gid~member（runAddress 右起解析——member 恒最右，gid 取
   * 末段左侧全部——gid 禁 ~ 使拆分无歧义）。
   */
  isGroupConversation(conversationId: string): boolean {
    if (this.groups.has(conversationId)) return true;
    const t = conversationId.indexOf('~');
    if (t <= 0) return false;
    return this.groups.has(conversationId.slice(0, t));
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
        if (typeof raw.id === 'string' && Array.isArray(raw.members)) {
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

    await this.rotateMechanical(groupId);
  }

  /** 尾部预算扫描（保留窗共用式）：从尾往前累计 token 至预算 ×1.5
   *  （src 容差语义——允许末条略超预算换完整语义单元），返回纳入的
   *  最早下标与累计 token。 */
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

  /**
   * 机械轮转（原 maybeArchiveBody 主体）：旧消息入 groups/<gid>/archive/
   * history_N.jsonl + 机械摘要 summary_N.md（时间/发送人/截断正文，尾部
   * 60 条）+ 本体经 session.compact 重建保留尾部 keepTokens（×1.5 容差；
   * owning 写口）。分段行 = SessionRecord 原文（steps/reasoning 随行保留）。
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
      .filter((r) => r.content.trim())
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
  }


  // ============================================================
  // 成员表生命周期
  // ============================================================

  /**
   * 创建群（成员须全部已注册为 Agent；id 禁 ~/路径字符——M19 与对键
   * 命名空间隔离；生成侧约定 g- 前缀）。**双向名册校验**（cr-4 撞形
   * 防线②）：群 id 撞已注册 Agent id → 拒（gid~member 会与 1v1 对键
   * 争用同一会话桶）；反向卡位在 agents.register。
   */
  create(def: { id: string; name: string; members: string[]; description?: string }): GroupConfig {
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
    if (this.ctx.agents.has(def.id)) {
      throw new Error(`群 id "${def.id}" 与已注册 Agent 同名（成员流键 gid~member 会与 1v1 对桶撞形）`);
    }
    for (const m of def.members) {
      if (!this.ctx.agents.has(m)) throw new Error(`成员 "${m}" 未注册为 Agent`);
    }
    const group: GroupConfig = {
      id: def.id,
      name: def.name,
      members: [...def.members],
      createdAt: Date.now(),
      ...(def.description !== undefined ? { description: def.description } : {}),
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
    try {
      this.sessionBackend()?.clear(groupId); // 本体桶（sessions/groups/<gid>/）
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 本体桶清理失败（${groupId}）: ${String(err)}`);
    }
    for (const m of group.members) {
      try {
        this.sessionBackend()?.clear(memberStreamKey(groupId, m)); // 成员私有流一并清理
      } catch { /* 尽力而为 */ }
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
   * 设定/清空群简介（undefined = 清空——删键回未设置）。返回变更后终值。
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
   * 加入（agentId 须已注册；已在群中 = 幂等 true）。新成员成员流从零
   * 开始——一次性种子（本体尾部投影，与入群时点之后的扇出衔接）。
   */
  join(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group || !this.ctx.agents.has(agentId)) return false;
    if (group.members.includes(agentId)) return true;
    group.members.push(agentId);
    this.persistConfig(group);
    void this.seedMemberStream(group, agentId).catch((err: unknown) => {
      this.ctx.logger.warn(`[group] 入群种子失败（${groupId}/${agentId}）: ${String(err)}`);
    });
    this.ctx.emit('group/member-added', groupId, agentId, group);
    return true;
  }

  /**
   * 入群种子（晚加入成员的成员流引导）：本体尾部消息投影进新成员流
   * （数量有界——本体轮转已保证尾部体量；归档摘要头并入首行）。
   */
  private async seedMemberStream(group: GroupConfig, member: string): Promise<void> {
    const session = this.sessionBackend();
    if (!session) return;
    const groupId = group.id;
    await this.ensureLog(groupId);
    const log = this.logs.get(groupId) ?? [];
    const archiveSummary = this.latestArchiveSummary(groupId);
    if (archiveSummary !== undefined) {
      await session.append(memberStreamKey(groupId, member), member, {
        role: 'user',
        content: `（本群更早的消息已归档，以下为归档摘要，供了解背景）\n${archiveSummary}`,
      });
    }
    for (const m of log) {
      await session.append(memberStreamKey(groupId, member), m.from, this.projectFor(member, group, m));
    }
  }

  /** 离开；群清空时自动删除 */
  leave(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    const idx = group.members.indexOf(agentId);
    if (idx === -1) return false;
    group.members.splice(idx, 1);
    this.persistConfig(group);
    try {
      this.sessionBackend()?.clear(memberStreamKey(groupId, agentId)); // 成员私有流一并清理
    } catch { /* 尽力而为 */ }
    this.ctx.emit('group/member-removed', groupId, agentId, group);
    if (group.members.length === 0) this.delete(groupId); // 自动删除（再发 deleted 事件）
    return true;
  }

  // ---- 查询 ----

  get(groupId: string): GroupConfig | undefined {
    return this.groups.get(groupId);
  }

  /**
   * 完整参与面（含隐式成员 user）：'user' 端点永不入册（post 特权 + UI
   * 建群流程过滤），但它恒在群内——成员表展示/注入的参与者全貌以本方法
   * 为单源（[群聊成员] 块、list_groups、前端成员列表）。保持 members
   * 纯 Agent 语义不变（send 触发目标、属主校验等继续用它）。
   */
  membersWithUser(groupId: string): string[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    return group.members.includes('user') ? group.members : ['user', ...group.members];
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
   * 缺省最近 50 条。轮转入 archive 的旧段不在其中。
   * D11：事实源 = sessions/groups/<gid>/（首次触达懒水合，此后内存缓存）。
   */

  /** 最新轮转摘要（无归档 → undefined；入群种子头部用） */
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
   * 无 session 行 = 纯内存。成员上下文每 run 从本体重派生（视角单源 = 本体）。
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
    // 成员流扇出（cr-4 转录流）：逐成员私有流（sessions/<gid>~<member>/）
    // 追加 viewer 投影行——自己的发言 assistant 原文、他人 user + <msg>
    // 包装（投影行即入账行：该消息在成员流中的唯一入账形态）。写放大 =
    // 每条 post × N 成员 × 数百字节，人速频率可忽略。
    if (session) {
      for (const member of group.members) {
        try {
          const bucket = memberStreamKey(groupId, member);
          await session.append(bucket, from, this.projectFor(member, group, message));
        } catch (err: unknown) {
          this.ctx.logger.warn(`[group] 成员流扇出失败（${groupId}/${member}）: ${String(err)}`);
        }
      }
    }
    await this.maybeRotate(groupId);
    this.ctx.emit('group/message-posted', groupId, message);
    return message;
  }

  /**
   * post 消息在指定成员流中的投影（viewer 视角）：自己的发言 assistant
   * 原文（"我说过的话"——assistant 示范密度，M26 resolveApiRole 语义）；
   * 他人 user + <msg> 包装（含显示名）+ 时间行。
   */
  private projectFor(member: string, group: GroupConfig, message: GroupMessageRecord): { role: 'user' | 'assistant'; content: string; attachments?: GroupMessageRecord['attachments'] } {
    if (message.from === member) {
      return {
        role: 'assistant',
        content: message.content,
        ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      };
    }
    return {
      role: 'user',
      content: `${wrapGroupMsg({
        from: message.from,
        displayName: displayNameOf(this.ctx.agents.get(message.from)),
        groupName: group.name,
        content: message.content,
      })}\n\n${timeLine()}`,
      ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    };
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
    const message = await this.post(groupId, from, content, options.attachments);
    // hint = <msg> 包装（含显示名）+ 时间行（M26：不带契约——契约经
    // loop/before-run 注入决策点，busy steer 免重复携带）。
    // cr-4：deliver 只唤醒不携消息——投影行已由 post 扇出入成员流
    // （session 对 GROUP_HINT_META 跳过入账，成员流不产生第二份触发行），
    // handle/conversationId = 成员流键 gid~member（run 与回放都在私有流上）。
    const hint = `${wrapGroupMsg({ from, displayName: displayNameOf(this.ctx.agents.get(from)), groupName: group.name, content })}\n\n${timeLine()}`;
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
    const deliveries = new Map<string, Promise<ConversationOutcome>>();
    for (const member of targets) {
      deliveries.set(
        member,
        this.ctx.conversation.deliver(member, hintMessage, {
          sender: from,
          source,
          conversationId: memberStreamKey(groupId, member),
          meta: { [GROUP_HINT_META]: true },
          ...(options.placement ? { placement: options.placement } : {}),
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

}

declare module '@agentchat/cordis' {
  interface Context {
    /** 群服务（ac-group 提供）：成员表 + 单通道内容流（可持久化）+ GroupFeed + 参与者投递 */
    group: GroupService;
  }
}
