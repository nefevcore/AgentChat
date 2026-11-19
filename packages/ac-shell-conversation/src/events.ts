// ============================================================
// events.ts —— 会话域事件目录（声明合并，零运行时；cr-578 → cr-591 泛化
// → cr-976 收束通知退役：conversation/run-settled 的唯一消费方〔壳 boot
// 旁带发射面〕随 B 案删除——前端收敛信号改由 run-end 行 durable 落盘投影
//（run/settled 帧，owning = ac-ledger/ledger/event-appended），事件词汇整体退役。
import type {} from '@agentchat/cordis';

declare module '@agentchat/cordis' {
  interface Events {
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
      meta: { source: string; injectionId?: string; label?: string; bytes?: number; payload?: { questions?: Array<{ question: string; options?: string[]; multi?: boolean }>; answers?: Array<string | string[] | null>; outcome?: 'answered' | 'timeout' } },
    ): void;
    /**
     * 安全重启就绪（emit；cr-629 restart_shell / cr-658 自然收束语义）：
     * 在途 run 已自然收束（终稿/回信恰好一次，无回队面）——boot 收到即
     * 以重启码 42 优雅退出；conversationIds（发起方键集，cr-1159 多会话
     * 并发各记各的——此前单槽被后收束会话顶替）随 marker 落盘，新壳
     * boot 兑现后逐键注入「已重启」通知开续跑轮。空闲时请求则立即发出
     * （无发起方 = 无 conversationIds 字段）。
     * @mode emit
     * @scope run
     */
    'conversation/restart-ready'(payload: { agentId: string; conversationIds?: string[] }): void;
    // 'conversation/queue-changed' 不在此声明——主线 ac-conversation/src/
    // events.ts 已是 owning 声明（四参序 + ConversationQueuedItem[]），
    // 本包按其签名 emit（cr-579）。
  }
}
