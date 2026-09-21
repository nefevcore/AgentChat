// ============================================================
// ac-session/src/events.ts —— 会话域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：本包 SessionService 在 context 行落账时 emit
// 'session/context-injected'——流式运行期的注入可见性事件（2026-09-21
// 前端反馈 #3：load_skill 等工具的注入信息此前只在 journal/partials，
// 前端无任何通知，刷新后才以 context 行出现——流式期间完全不可见）。
// 消费方 `import type {} from 'ac-session'` 即获得类型增强。
// ============================================================
import type {} from '@agentchat/cordis';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * context 注入行落账通知（recordContext 的广播面——journal 与直落两路
     * 均发）。载荷刻意不带正文（技能正文可达数 KB~数十 KB，广播面瘦身与
     * llm/delta 的 input 瘦身同纪律）；前端渲染为事件分隔行（label 可见），
     * 正文在刷新后的 context 行 / journal 提升行在场。
     * @mode broadcast
     * @scope session
     */
    'session/context-injected'(
      conversationId: string,
      agentId: string,
      meta: { source: string; label?: string },
    ): void;
  }
}

export {};
