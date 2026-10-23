// ============================================================
// ac-shell-subagent —— 子 Agent 行（M8.3；R-5 修订版 preview 实现）
//
// 主线 ac-subagent 占名（共进程 loop 直调形态）——preview 避让名同族
//（ac-shell-conversation / ac-credentials-core，cr-504）；cutover 随主线
// 行退役回收名。服务与工具注册在 ./service.ts。
// ============================================================

export const name = 'ac-shell-subagent';

export * from './service.ts';
