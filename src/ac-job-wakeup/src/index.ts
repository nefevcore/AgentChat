// ============================================================
// ac-job-wakeup —— 后台任务完成唤醒行（M15 对账补齐）
//
// src boot 插件的 onJobDone 双通道之②（完成通知进 owner inbox——
// followup notice，role='user' + system source）的 preview 形态：
//   · 订阅 job/settled（emit 面）→ 有 owner 的任务完成时经
//     ctx.conversation.deliver 注入通知（sender:'event' 信封——
//     机制触发的标准形态，串行化门/链跑/MAX_AUTO_WAKES 防自激全由
//     ac-conversation 承担）
//   · 通知文本带 job read 口径的结果摘要（Agent 醒来即知道发生了什么；
//     需要全文可 job read）
//   · 回投目标 = job.conversationId（任务发起会话——结果回到发起地），
//     缺省回 owner 自会话桶；无 owner（宿主任务）/conversation 未装 =
//     跳过（行组合可选）
//
// 通知合并窗口（2026-09-17 自会话成本优化）：同 owner + 同会话的
// settled 通知在 DIGEST_WINDOW_MS 内聚合——窗口内首条照常投递（保持
// 低延迟），后续条目暂存；首条投递后窗口收束时若有暂存，补投一条
// digest（"另有 N 个任务完成"）。动机：并行子任务逐条回投时，每条
// 62 字符的通知都伴随一次全上下文唤醒（news 实测 9 连通知 = 9 次全额
// run）；合并后 N 条 → 至多 2 次唤醒。
//
// 与 ac-ws-bridge 的分工：那是 WS 广播通道（前端通知），本行是
// Agent 唤醒通道（对话闭环）——同事件两个订阅方，互不依赖。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-jobs'; // job/settled 事件目录 + JobSnapshot（type-only）
import type {} from 'ac-conversation'; // ctx.conversation 服务类型（type-only）

/** 结果摘要上限（通知正文里的 detail 截断；全文走 job read） */
const DETAIL_MAX = 400;

/** 通知合并窗口（同 owner+会话的第二条起暂存，窗口收束补投 digest） */
const DIGEST_WINDOW_MS = 5_000;

/** 暂存条目（窗口内的后续通知） */
interface PendingNotice {
  jobId: string;
  kind: string;
  status: string;
  detail: string;
}

/** 窗口状态：首条已投递，窗口期内收集后续 */
interface DigestWindow {
  timer: ReturnType<typeof setTimeout>;
  pending: PendingNotice[];
}

export const name = 'ac-job-wakeup';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'job-wakeup',
  label: '任务完成唤醒',
  description: '后台任务完成唤醒行（job/settled → 回投源会话通知；同会话 5s 窗口内合并为 digest）',
  automatic: true,
};

export function apply(ctx: Context) {
  /** 窗口注册表（键 = owner\u0000conversationId；行卸载时 timer 全清） */
  const windows = new Map<string, DigestWindow>();

  const disposeAll = ctx.fiber.effect(() => () => {
    for (const w of windows.values()) clearTimeout(w.timer);
    windows.clear();
  }, 'job-wakeup.digest-windows');

  /** 窗口收束：有暂存则补投 digest（conversation 经 ctx.get root-traced 解析——闭包内属性解析受限） */
  const flushWindow = (key: string, owner: string, conversationId: string) => {
    const w = windows.get(key);
    if (!w) return;
    windows.delete(key);
    if (w.pending.length === 0) return;
    const conversation = ctx.get('conversation');
    if (!conversation) return;
    const lines = w.pending
      .map((p) => `- 任务 ${p.jobId}（${p.kind}）${p.status}${p.detail ? `：${p.detail.slice(0, 120)}` : ''}`)
      .join('\n');
    const notice = `[系统通知] 窗口内另有 ${w.pending.length} 个后台任务收束：\n${lines}\n需要详情可用 job 工具读取。`;
    void conversation
      .deliver(owner, notice, { sender: owner, source: 'event', conversationId })
      .catch((err: unknown) => {
        ctx.logger.warn(`[job-wakeup] digest 回投失败（${owner}/${conversationId}）: ${String(err)}`);
      });
  };

  ctx.on('job/settled', (job) => {
    const owner = job.ownerAgentId;
    if (!owner) return; // 无主任务（宿主发起）无人可唤醒
    const conversation = ctx.get('conversation');
    if (!conversation) return; // 行组合未装会话状态机——跳过（非错误）

    const status =
      job.status === 'completed' ? '完成' : job.status === 'killed' ? '已终止' : '失败';
    const detail = job.detail ? `：${job.detail.slice(0, DETAIL_MAX)}` : '';
    // 回投目标（2026-09-02 反馈 #2 修正）：任务在哪个会话启动，通知就回到
    // 哪个会话（job.conversationId = 启动时执行身份）——用户在 a⇋b 会话里
    // 让 b 起的后台任务，结果不再落 b⇋b 自会话桶（对用户即"结果丢失"）。
    // 无会话键（宿主任务 / 旧 producer）回退 M19/D2 规：owner 自会话桶
    // pairKey(owner, owner)；sender = owner 自身（自会话语义）、source='event'。
    const conversationId = job.conversationId ?? `${owner}~${owner}`;

    // 合并窗口：同 owner+会话已有窗口 → 暂存不投递（窗口收束补 digest）；
    // 无窗口 → 首条照常投递并开窗。首条不延迟——单任务场景零回归。
    const key = `${owner}\u0000${conversationId}`;
    const existing = windows.get(key);
    if (existing !== undefined) {
      existing.pending.push({
        jobId: job.id,
        kind: job.kind,
        status,
        detail: job.detail ?? '',
      });
      return;
    }
    const timer = setTimeout(() => flushWindow(key, owner, conversationId), DIGEST_WINDOW_MS);
    windows.set(key, { timer, pending: [] });

    const notice = `[系统通知] 后台任务 ${job.id}（${job.kind}）${status}${detail}。需要时可用 job 工具读取完整输出。`;
    void conversation
      .deliver(owner, notice, {
        sender: owner,
        source: 'event',
        conversationId,
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[job-wakeup] 唤醒 ${owner} 失败（任务 ${job.id}）: ${String(err)}`);
      });
  }, { description: 'job 完成唤醒：向 owner 会话投递回执（同会话窗口内合并）' });

  void disposeAll;
}
