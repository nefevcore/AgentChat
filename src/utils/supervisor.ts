// ============================================================
// src/utils/supervisor.ts —— 横切工具（被全层用，依赖根之上）
//
// isSupervised()：是否为 Supervisor 托管模式（父进程拉起、重启约定）。
// 被 L3（builtin prompt/tools 的 system_restart 门控）与 L5（shutdown
// 重启退出码）共用 —— 唯一真正横切的 helper，故保留最小 utils/ 目录。
//
// 铁律：零依赖，仅读环境变量。
// ============================================================

/** 是否 Supervisor 模式（父进程托管，AGENTCHAT_SUPERVISED=1） */
export function isSupervised(): boolean {
  return process.env.AGENTCHAT_SUPERVISED === '1';
}
