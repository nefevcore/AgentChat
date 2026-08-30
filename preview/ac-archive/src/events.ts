// ============================================================
// ac-archive/src/events.ts —— 归档域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：archive/* 事件由本包 ArchiveService emit。
// src archive.completed / session.archived 的 preview 收敛形态——
// UI 据此把"正在归档…"态翻转为完成并刷新会话视图。
// ============================================================
import type {} from '@agentchat/cordis';

/** archive/completed 载荷 */
export interface ArchiveCompletedPayload {
  conversationId: string;
  agentId: string;
  /** 本次移入归档分段的条数 */
  archived: number;
  /** 归档后保留在会话流中的尾部条数 */
  kept: number;
  /** 新写出的分段名（本次无归档条目时缺省） */
  segment?: string;
}

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 归档重建完成通知（M7 WebUI；src archive.completed/session.archived
     * 的收敛形态）。archiveAndRebuild 是唯一归档重建漏斗（requestArchive
     * 与超时强制归档共用），完成即 emit。UI/审计订阅方据此刷新会话视图
     * （会话流已被 compact 重写，需重拉 history）。
     * @mode emit
     * @scope host
     */
    'archive/completed'(payload: ArchiveCompletedPayload): void;
  }
}
