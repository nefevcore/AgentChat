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
//   · 成员表：create/delete/join/leave/rename（事件通知 group/*）
//   · 内容通道：post 入流（唯一事实源）+ group/message-posted 事件
//   · GroupFeed：readSince(锚点)/currentAnchor —— busy 参与者的增量注入
//   · 投递：send = post + 逐参与者 ctx.conversation.deliver
//     （conversationId=群 id → handle=gid~member 每参与者独立门；
//     busy=steer、idle=新 run；fire-and-forget，受理即返回）
//
// 【D11 存储统一（M21 落地）】群本体**迁入 sessions 树**，消息流归
// ac-session 单 owning（规约 1）：
//   · 本体 = sessions/groups/<gid>/messages.jsonl（经 session.setShelf
//     上架；中性行：一切真实发言 role:'agent' + agent_id=说话人端点——
//     用户 post 与成员回复同词表，回复行内嵌 steps[]）；
//   · post → session.append（唯一写口，行 id 返回对齐 GroupFeed 锚点）；
//     成员回复经 router/reply-completed 事件照常入账（GROUP_HINT_META
//     只跳过 hint 触发行——入站只入一次，F6①）；
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
import { isArchiveReviewRun } from 'ac-agent-loop';
import { maxSeqOf } from 'ac-session';
import type { LlmMessage } from 'ac-llm';
import type {} from 'ac-router'; // router/* 事件目录（type-only——回复感知订阅）
import type { ConversationOutcome } from 'ac-conversation';
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
    // D11 契约透传：群成员工具卡片/思维链刷新不丢（RPC/UI 消费）
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
 * N 次）；回复照常入账（reply-completed 不查本键——回复是会话事实）。
 */
export const GROUP_HINT_META = 'group-hint';

/**
 * 群 hint 投递触发判定（M21/F6①，与 GROUP_HINT_META 同源单导出）：
 * 事实行已入群本体，session 入账/上下文视图据此跳过逐成员 hint。
 */
export function isGroupHint(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[GROUP_HINT_META] === true;
}

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
    if (this.storeRoot !== undefined) this.loadFromDisk();

    // ---- 成员回复感知（D11）：reply-completed 事件把回复写进本体桶
    // （ac-session 入账），本服务只做内存 log 增量——锚点/records/读增量
    // 即刻可见；不重复写盘（事件多播，session 是唯一写口）。回复形状与
    // ac-session 入账同构（steps/reasoning 透传——D11 契约）。 ----
    this.ctx.on('router/reply-completed', (agentId, text, result, conversationId, _sender, _source, meta) => {
      if (isArchiveReviewRun(meta)) return; // 机制 run 除外（对齐 session 入账口径）
      const gid = conversationId;
      if (typeof gid !== 'string' || !this.groups.has(gid)) return;
      if (!text) return; // 中断/空回复不进内容流（对齐 session 口径）
      const log = this.logs.get(gid);
      if (!log) return; // 未水合：下次 ensureLog 从本体全量读（含该行）——不抢跑
      const reasoning = result.steps
        .map((s) => s.reasoning?.trim())
        .filter((r): r is string => !!r)
        .join('\n\n');
      const steps = result.steps
        .map((s) => ({
          content: s.text,
          ...(s.reasoning ? { reasoning: s.reasoning } : {}),
          ...(s.toolCalls.length > 0
            ? {
                toolCalls: s.toolCalls.map((tc, i) => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                  result: s.toolResults[i] ?? null,
                })),
              }
            : {}),
        }))
        .filter((s) => s.content || s.reasoning || (s.toolCalls !== undefined && s.toolCalls.length > 0));
      log.push({
        id: mintMessageId(), // 运行期合成 id（锚点幂等用；重启后水合取本体真行）
        groupId: gid,
        from: agentId,
        content: text,
        at: Date.now(),
        ...(reasoning ? { reasoning } : {}),
        ...(steps.length > 0 ? { steps } : {}),
      });
      void this.maybeRotate(gid).catch(() => undefined); // 回复也计 token（轮转检测尽力而为）
    }, { description: '群桶回复入账（message-posted 单一内容源）' });
  }

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
   * 本体轮转（src maybeArchiveBody 语义，机械摘要不过 LLM；D11 落位）：
   * 总 token 超 archiveTokens → 旧消息入 groups/<gid>/archive/history_N.jsonl
   * + 机械摘要 summary_N.md（时间/发送人/截断正文，尾部 60 条）+ 本体经
   * session.compact 重建保留尾部 keepTokens（×1.5 容差；owning 写口）。
   * 分段行 = SessionRecord 原文（steps/reasoning 随行保留——审计不降级）。
   */
  private async maybeRotate(groupId: string): Promise<void> {
    if (this.storeRoot === undefined) return;
    const session = this.sessionBackend();
    if (!session) return; // 纯内存态：无持久域
    const log = this.logs.get(groupId);
    if (!log || log.length === 0) return;
    const totalTokens = log.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    if (totalTokens <= this.archiveTokens) return;

    const records = await session.records(groupId); // 全 fidelity（含 steps）
    const { start: splitIdx } = this.tailScan(records.map((r) => r.content), this.keepTokens);
    if (splitIdx <= 0) return; // 全部在保留预算内（理论不达）
    const archived = records.slice(0, splitIdx);
    const kept = records.slice(splitIdx);

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
      // 机械摘要锚点（轮转产物；historyFor 注入为长期记忆头）
      const items = archived
        .filter((r) => (r.content ?? '').trim())
        .slice(-60)
        .map((r) => {
          const ts = (r.timestamp || '').slice(0, 16).replace('T', ' ');
          const text = r.content.length > 150 ? `${r.content.slice(0, 150)}…` : r.content;
          return `- [${ts}] ${r.agent_id ?? 'user'}: ${text.replace(/\n/g, ' ')}`;
        });
      if (items.length > 0) {
        fs.writeFileSync(
          path.join(archiveDir, `summary_${index}.md`),
          `# 群聊 ${groupId} 早期摘要（归档 ${new Date().toISOString().slice(0, 16)}，${archived.length} 条 → history_${index}.jsonl）\n\n${items.join('\n')}\n`,
          'utf-8',
        );
      }
      // 本体重建（D11：经 session.compact owning 写口——头行保留、seq 续号）。
      // B1：baselineSeq = 快照基线——轮转写归档段期间新到群消息（并发发言）
      // 由 rewriteMessages 重读并入，不被 tmp+rename 覆盖
      await session.compact(groupId, { keep: kept, baselineSeq: maxSeqOf(records) });
      this.logs.set(
        groupId,
        kept.filter((r) => r.role === 'agent').map((r) => toGroupMessage(groupId, r)),
      );
      this.windows.delete(groupId); // 轮转 = 显式 replace：派生窗随之重置（下次派生重钉）
      this.markViewsStale(groupId);
      this.ctx.logger.info(
        '[group] 本体轮转 %C：%C 条 → archive/history_%C，保留尾部 %C 条',
        groupId,
        String(archived.length),
        String(index),
        String(kept.length),
      );
    } catch (err: unknown) {
      this.ctx.logger.warn(`[group] 本体轮转失败（${groupId}，下次消息重试）: ${String(err)}`);
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
    this.windows.delete(groupId);
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

  /** 离开；群清空时自动删除 */
  leave(groupId: string, agentId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    const idx = group.members.indexOf(agentId);
    if (idx === -1) return false;
    group.members.splice(idx, 1);
    this.persistConfig(group);
    this.ctx.emit('group/member-removed', groupId, agentId, group);
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
    const hint = `${wrapGroupMsg({ from, groupName: group.name, content })}\n\n${timeLine()}`;
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
   * 群历史回放（viewer 视角）：peer 消息 <msg> 包装（与 trigger hint/
   * readSince 同一构造点）、own 消息原文；相邻 peer 纯发言合并（连续
   * user 稀释注意力、多占 token 的 src 教训）；轮转摘要注入为头部。
   * 内存态群（无持久化）回放内存流。返回 user 角色消息（群历史以入站
   * 视角进入上下文，供 conversation.deliver 的 history 种子）。
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
      const text = isPeer ? wrapGroupMsg({ from: m.from, groupName, content: m.content }) : m.content;
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
        role: 'user' as const,
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
          : wrapGroupMsg({ from: m.from, groupName, content: m.content }),
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
