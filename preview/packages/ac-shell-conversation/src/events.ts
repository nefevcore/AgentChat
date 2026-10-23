// ============================================================
// events.ts —— 会话域事件目录（声明合并，零运行时；cr-578 → cr-591 泛化）
//
// 谁 emit 谁声明：conversation/run-settled 的分发方是本包的
// ConversationService（driveRun settle 点），类型随事件住 owning 包。
// 消费方 `import type {} from 'ac-shell-conversation'` 即获得类型增强
//（壳 boot 旁带发射面是唯一消费者）。
// ============================================================
import type {} from '@agentchat/cordis';

/** run 收束通知载荷（cr-591：每用户 run 收束即发——前端收束三件套
 * 〔清 busy / 终稿入列 / 权威行重拉〕的唯一驱动；此前仅失败收束发
 * run-error，成功收束缺席 = busy 卡死 + 终稿只能刷新可见） */
export interface RunSettledPayload {
  conversationId: string;
  runId: string;
  finish: 'ok' | 'error' | 'interrupted';
  /** 终稿文本 */
  text: string;
  /** 失败描述（error 收束 = loop 收束 error 文本；缺席 = finish 词） */
  message?: string;
  sender: string;
  source: string;
}

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 用户 run 收束通知（emit；机制 run〔reviewRun〕不发）。
     * @mode emit
     * @scope run
     */
    'conversation/run-settled'(payload: RunSettledPayload): void;
    /**
     * 上下文注入可见性（emit；主线 owning 声明 = ac-session/src/events.ts
     * 同签名——preview 壳树不装 ac-session，此处按同形声明，两包不同树
     * 不冲突。cr-625：ask_questions 作答注入等 context 材料的前端直播行
     *（session/context-injected 前端帧）唯一驱动源）。
     * @mode emit
     * @scope session
     */
    'session/context-injected'(
      conversationId: string,
      agentId: string,
      meta: { source: string; injectionId?: string; label?: string },
    ): void;
    // 'conversation/queue-changed' 不在此声明——主线 ac-conversation/src/
    // events.ts 已是 owning 声明（四参序 + ConversationQueuedItem[]），
    // 本包按其签名 emit（cr-579）。
  }
}
