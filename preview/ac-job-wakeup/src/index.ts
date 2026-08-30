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
//   · 无 owner（宿主任务）/conversation 未装 = 跳过（行组合可选）
//
// 与 ac-ws-bridge 的分工：那是 WS 广播通道（前端通知），本行是
// Agent 唤醒通道（对话闭环）——同事件两个订阅方，互不依赖。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-jobs'; // job/settled 事件目录 + JobSnapshot（type-only）
import type {} from 'ac-conversation'; // ctx.conversation 可选能力类型（type-only）

/** 结果摘要上限（通知正文里的 detail 截断；全文走 job read） */
const DETAIL_MAX = 400;

export const name = 'ac-job-wakeup';

export function apply(ctx: Context) {
  ctx.on('job/settled', (job) => {
    const owner = job.ownerAgentId;
    if (!owner) return; // 无主任务（宿主发起）无人可唤醒
    const conversation = ctx.get('conversation');
    if (!conversation) return; // 行组合未装会话状态机——跳过（非错误）

    const status =
      job.status === 'completed' ? '完成' : job.status === 'killed' ? '已终止' : '失败';
    const detail = job.detail ? `：${job.detail.slice(0, DETAIL_MAX)}` : '';
    const notice = `[系统通知] 后台任务 ${job.id}（${job.kind}）${status}${detail}。需要时可用 job 工具读取完整输出。`;
    // M19/D2 同规：机制唤醒归 Agent 自会话桶 pairKey(owner, owner)——与
    // 用户直答对桶分离；sender = owner 自身（自会话语义）、source='event'。
    void conversation
      .deliver(owner, notice, {
        sender: owner,
        source: 'event',
        conversationId: `${owner}~${owner}`,
      })
      .catch((err: unknown) => {
        ctx.logger.warn(`[job-wakeup] 唤醒 ${owner} 失败（任务 ${job.id}）: ${String(err)}`);
      });
  });
}
