// ============================================================
// ac-singles/src/events.ts —— 独立会话域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：singles/* 事件的分发方是本包的 SinglesService。
// 纯通知（emit）：WS 广播（前端列表刷新）/ 审计订阅方【零注入 singles】。
// ============================================================
import type {} from '@agentchat/cordis';
import type { SingleSessionMeta } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 独立会话已变更（create/update/archive/remove 后的统一通知；
     * 载荷 = 变更后终值；remove 时 meta 为删除前快照）。
     * 订阅方：WS 桥（前端 singles 列表刷新）、审计。
     * @mode emit
     * @scope host
     */
    'singles/updated'(meta: SingleSessionMeta, action: 'created' | 'updated' | 'archived' | 'removed'): void;
  }
}
