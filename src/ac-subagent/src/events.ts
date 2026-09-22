// ============================================================
// ac-subagent/src/events.ts —— 子 Agent 域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：subagents/* 事件的分发方是本包的 SubagentsService。
// 纯通知（emit）：WS 广播（前端清单刷新）/ 审计订阅方【零注入 subagents】。
// ============================================================
import type {} from '@agentchat/cordis';
import type { SubagentInfo } from './service.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 子 Agent 已变更（spawn / run 起跑 / run 收束 / stop / delete 后的
     * 统一通知；载荷 = 变更后投影（list 口径：displayStatus/runs/lastRun
     * 等展示字段齐备），delete 时为删除前快照）。
     * 订阅方：WS 桥（前端子Agent 清单刷新）、审计。
     * @mode emit
     * @scope host
     */
    'subagents/updated'(info: SubagentInfo, action: 'spawned' | 'started' | 'settled' | 'stopped' | 'removed'): void;
  }
}
