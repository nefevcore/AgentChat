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
     * injectionId（注入身份键）：recordContext 铸造，journal 行/活投影行/
     * 提升行同锚——前端直播行据此带 persistedMsgId，与刷新行精确去重
     * （运行中切换会话回视的重复 context 行根修）。旧后端帧缺席该字段，
     * 前端回落本地 id（行为同旧）。
     * 分发 = ctx.emit（cr-19 订正：原标 broadcast 不在 DispatchMode 五值；
     * scope 按判定式归 run——emit 点在投递链回调与工具 run 内）。
     * @mode emit
     * @scope run
     */
    'session/context-injected'(
      conversationId: string,
      agentId: string,
      meta: { source: string; injectionId?: string; label?: string },
    ): void;

    /**
     * run settlement 物化完成通知（cr-94 D1 收敛协议）：提升批已 durable
     * 落盘 + journal 剔除完成——此时刻起 records()/history() 必已可见
     * 权威收束行/段行。前端据此事件驱动重拉首屏（替代 after-run 后
     * 500ms 赌窗——直播行→权威行替换获得显式收敛信号）。
     * 只在 journal settlement 路径发（enqueueSettlement 有物化对象）；
     * 直落收束行（无 journal run）不发——读侧在 reply-completed 时已
     * 可见（同同步入队）。载荷瘦身（不带正文/结果）。
     * @mode emit
     * @scope run
     */
    'session/run-settled'(
      conversationId: string,
      agentId: string,
      meta: { runId: string },
    ): void;
  }
}

export {};
