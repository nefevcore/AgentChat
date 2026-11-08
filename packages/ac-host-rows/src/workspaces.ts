// ============================================================
// workspaces.ts —— 工作区登记表（cr-583）——读面单源转发
//
// 数据 = <dataRoot>/meta/workspaces.json（数据分层第二层）。实现已下沉
// ac-core-utils/workspaces（数据分层第二批迁居时发现主线 WorkspaceService
//（ac-workspace ctx.workspace 四方法）仍读写根级旧位置——两处各写一份
//「读旧写新」必走散，故词汇单源化：本文件仅转发，公共导出面不变
//（web-api / face-ops 既有 import 零改动）。
// ============================================================
export {
  listWorkspaces,
  registerWorkspace,
  updateWorkspace,
  removeWorkspace,
  workspacePathOf,
} from 'ac-core-utils';
export type { WorkspaceRegistration } from 'ac-core-utils';
