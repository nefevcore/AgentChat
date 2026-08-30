// ============================================================
// ac-jobs/src/events.ts —— 后台任务域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：job/settled 的分发方是本包的 JobsService。
// 消费方 `import type {} from 'ac-jobs'` 即获得事件类型增强。
// ============================================================
import type {} from '@agentchat/cordis';
import type { JobSnapshot } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 任务终态通知（settle 后触发一轮；first-wins 保证一个任务只发一次）。
     * @mode emit
     * @scope host
     * 载荷 = 任务终态快照（id/kind/status/detail/ownerAgentId）。
     * 谁该订阅：宿主接线（触发 Agent 干活 = sender:'event' 信封投递）、
     * WS 广播、审计。替代 src onJobDone 私有 listener 数组。
     */
    'job/settled'(job: JobSnapshot): void;
  }
}
