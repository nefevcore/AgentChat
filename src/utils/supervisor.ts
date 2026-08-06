// ============================================================
// supervisor 环境判断 —— 横切工具（被全层使用）
//
// 从 app/shutdown 移出：纯环境变量判断，不依赖任何层，
// 插件/服务/应用层均可直接 import（满足"plugins 不 import app"分层约束）。
// ============================================================

/** 是否处于 supervisor 托管模式（由环境变量 AGENTCHAT_SUPERVISED=1 标识） */
export function isSupervised(): boolean {
  return process.env.AGENTCHAT_SUPERVISED === '1';
}
