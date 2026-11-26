// ============================================================
// ac-jobs/src/wakeup.ts —— job 完成通知回投（cr-992 随迁补齐）
//
// 旧 ac-job-wakeup 行（cr-696 旧树退役）投递面的新家：cr-453 裁决
// 「job-wakeup 三投递策略随迁壳 jobs」，随迁一直未落——后台任务完成后
// 无通知回投发起会话（用户观察「job 完成后没有注入回会话」）。本模块
// 补齐该接线：订阅 job/settled → conversation.deliver(sender:'event')。
//
// 三投递策略（裁决簿〈jobs 归属〉）：
//   · digest 窗口聚合——同 owner+会话 5s 窗口内首条即投、后续暂存、
//     窗口收束补投 digest（N 条任务 → 至多 2 次唤醒，防并行子任务
//     逐条回投的自会话成本放大）
//   · killedBy='owner' 且 settle 非 failed 跳过——接收者即制造者
//     （job 工具 kill），回执已在 tool result，再唤醒即自激（cr-218/227；
//     判据用 killedBy 不用终态字面：Windows taskkill /F = exit code 1
//     无 signal，producer 报 completed 而非 killed，字面过滤曾漏网）
//   · sub_* owner 无会话键跳过——子 Agent run 内 job 回投自会话桶只会
//     拉起无人值守空转 run（cr-132）；子 Agent 收束汇报走 subagent
//     行的 settled 机制直达父会话，不经本面
//
// 行组合可选：conversation 行未装（ctx.get 落空）→ 跳过不炸。软依赖
// use-time 读取（事件回调内），不构成 start-time 探测反模式。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { JobSnapshot } from './contract.ts';

/** 通知正文里的 detail 截断（全文走 job read） */
const DETAIL_MAX = 400;

/**
 * 通知正文里的输出尾部预览截断（cr-1323）：meta.output 在通知侧只作预览，
 * 完整输出走 job logs（独立预算，不受此值影响）。
 */
const TAIL_MAX = 1_000;

/** digest 合并窗口：同 owner+会话的第二条起暂存，窗口收束补投 */
const DIGEST_WINDOW_MS = 5_000;

interface PendingNotice {
  jobId: string;
  kind: string;
  status: string;
  detail: string;
  tail: string;
}

interface DigestWindow {
  timer: ReturnType<typeof setTimeout>;
  pending: PendingNotice[];
}

/** conversation 服务最小消费面（软依赖形状——主线/壳两方言叶同构） */
type ConversationDeliver = {
  deliver(agentId: string, message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** subagents 服务最小消费面（cr-132 过滤判据——软依赖） */
type SubagentsLookup = { get(id: string): unknown };

const STATUS_TEXT: Record<string, string> = { completed: '完成', killed: '已终止', failed: '失败' };

/** 主通知文本（首条/单条投递；cr-1323 附输出尾部——收束即足额判定，免二跳查日志） */
function noticeText(job: JobSnapshot, status: string): string {
  const detail = job.detail ? '：' + job.detail.slice(0, DETAIL_MAX) : '';
  const tail = tailText(job.meta?.output, TAIL_MAX);
  const tailPart = tail ? '\n输出尾部：\n' + tail : '';
  return '[系统通知] 后台任务 ' + job.id + '（' + job.kind + '）' + status + detail + '。' + (tail ? '完整输出（如需）用 job logs 查看。' : '需要时可用 job 工具读取完整输出。') + tailPart;
}

/** digest 文本（窗口内后续条目的合并通知；cr-1323 同附尾部） */
function digestText(pending: PendingNotice[]): string {
  const lines = pending.map((p) => '- 任务 ' + p.jobId + '（' + p.kind + '）' + p.status + (p.detail ? '：' + p.detail.slice(0, 120) : '') + (p.tail ? '\n  输出尾部：' + p.tail : '')).join('\n');
  return '[系统通知] 窗口内另有 ' + pending.length + ' 个后台任务收束：\n' + lines + '\n需要更多细节可用 job 工具读取。';
}

/**
 * meta.output → 预览文本（截 TAIL_MAX 字；非串/空 = ''）。
 * 超出时保留**末段**（前导省略号）：这是尾部预览，结论/报错在最后几行——
 * 从头截会把最该看的部分裁掉。
 */
function tailText(src: unknown, max: number): string {
  if (typeof src !== 'string' || src.trim() === '') return '';
  return src.length > max ? '…' + src.slice(-(max - 1)) : src;
}

/**
 * 回投目标：任务在哪个会话启动，通知就回到哪个会话（job.conversationId
 * = 启动时执行身份）。无会话键（宿主任务/旧 producer）回退 owner 自会话
 * 桶 pairKey(owner, owner)；sender = owner 自身（自会话语义）。
 */
function targetConversation(job: JobSnapshot): { owner: string; conversationId: string } {
  return { owner: job.ownerAgentId!, conversationId: job.conversationId ?? job.ownerAgentId + '~' + job.ownerAgentId };
}

/**
 * job/settled → 通知回投（行内伴生面——ac-jobs 行 apply 装配）。
 * 订阅即归属：行卸载时 cordis 撤销监听；digest 窗口 timer 经 effect 清理。
 */
export function applyJobWakeup(ctx: Context): void {
  const windows = new Map<string, DigestWindow>();

  ctx.effect(() => () => {
    for (const w of windows.values()) clearTimeout(w.timer);
    windows.clear();
  });

  const flushWindow = (key: string, owner: string, conversationId: string) => {
    const w = windows.get(key);
    if (!w) return;
    windows.delete(key);
    if (w.pending.length === 0) return;
    const conversation = ctx.get('conversation', false) as ConversationDeliver | undefined;
    if (!conversation) return;
    void conversation.deliver(owner, digestText(w.pending), { sender: owner, source: 'event', conversationId })
      .catch((err: unknown) => {
        ctx.logger.warn('[job-wakeup] digest 回投失败（' + owner + '/' + conversationId + '）: ' + String(err));
      });
  };

  ctx.on('job/settled', (job: JobSnapshot) => {
    const owner = job.ownerAgentId;
    if (!owner) return; // 无主任务（宿主发起）无人可唤醒
    // owner 自杀不通知（cr-218/227——头部注释）
    if (job.killedBy === 'owner' && job.status !== 'failed') return;
    // 子 Agent owner 不唤醒（cr-132）：无会话键的 sub_* job 跳过——
    // 自会话桶唤醒只会拉起无人值守空转 run；显式 conversationId
    // 照常投（那是发起会话回执，不是自会话唤醒）
    if (job.conversationId === undefined) {
      const subs = ctx.get('subagents', false) as SubagentsLookup | undefined;
      if (subs?.get(owner) !== undefined) return;
    }
    const conversation = ctx.get('conversation', false) as ConversationDeliver | undefined;
    if (!conversation) return; // 会话行未装（行组合可选）——跳过

    const status = STATUS_TEXT[job.status] ?? job.status;
    const { conversationId } = targetConversation(job);

    // digest 窗口：已有窗口 → 暂存（收束补 digest）；无窗口 → 首条即投并开窗
    const key = owner + String.fromCharCode(0) + conversationId;
    const existing = windows.get(key);
    if (existing !== undefined) {
      existing.pending.push({ jobId: job.id, kind: job.kind, status, detail: job.detail ?? '', tail: tailText(job.meta?.output, TAIL_MAX) });
      return;
    }
    const timer = setTimeout(() => flushWindow(key, owner, conversationId), DIGEST_WINDOW_MS);
    windows.set(key, { timer, pending: [] });

    void conversation.deliver(owner, noticeText(job, status), {
      sender: owner,
      source: 'event',
      conversationId,
    }).catch((err: unknown) => {
      ctx.logger.warn('[job-wakeup] 唤醒 ' + owner + ' 失败（任务 ' + job.id + '）: ' + String(err));
    });
  }, { description: 'job 完成通知回投：向发起会话投递收束通知（同 owner+会话 5s 窗口内合并）' });
}
