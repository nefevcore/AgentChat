// ============================================================
// api/jobs.ts —— 后台任务/子Agent 调用清单读面（DSH job_list 同款）
//
// M27.1：域契约（WireJob + fetchJobs/killJob）随 UI 行走迁
// ac-client-ui-jobs/client（owning = 前端行）；M27.2-2 视图半边起
// 纯视图拆分（splitJobs/jobOutputPreview/jobStatusLabel 等清单词汇）
// 亦随行包走——本模块全量 re-export 维持旧 import 路径。实时性：
// job/started · job/settled 事件帧驱动域服务重拉（ctx.jobBoard）。
// ============================================================

export type { WireJob } from 'ac-client-ui-jobs/client';
export { fetchJobs, killJob } from 'ac-client-ui-jobs/client';
export {
  jobIsRunning,
  jobIsSubagent,
  jobsForConversation,
  jobStatusLabel,
  jobStatusIcon,
  splitJobs,
  jobOutputPreview,
  subagentMeta,
} from 'ac-client-ui-jobs/client';
