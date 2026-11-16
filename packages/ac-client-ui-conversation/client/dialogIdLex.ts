// ============================================================
// ac-client-ui-conversation/client/dialogIdLex.ts —— 会话键词法
// 判定单源（cr-1137 并源：conversation index 与 routeDialog 共用——
// 两处走散即帧路由与 presence 登记口径漂移）
//
// singles 会话键词汇锁（cr-1120，与服务端 isSingleSessionId 同形）：
// uuid v4/v7。签发源 = 服务端 issueConversationId（uuidv7）/ 前端
// issueLocalConversationId。
// ============================================================

export const SINGLE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
