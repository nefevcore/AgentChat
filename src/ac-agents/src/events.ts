// ============================================================
// ac-agents/src/events.ts —— Agent 域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：agents/* 事件由本包 AgentsService 的数据驱动写口
// （reassign/remove）emit。src agent.profile.updated 的 preview 形态
// ——src 写侧本就缺失（M7 简报：勿照搬），preview 补真的：管理面
// 写后 / agents-dir 热重扫覆盖注册后，UI 据此刷新档案。
// ============================================================
import type {} from '@agentchat/cordis';
import type { AgentConfig } from './service.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * Agent 档案变更通知（M7 WebUI；src agent.profile.updated 的真实现）。
     * reassign（管理面写/热重扫覆盖注册）→ change='updated'；
     * remove（数据驱动撤注册）→ change='removed'（config 为被撤档案）。
     * UI/审计/缓存订阅方据此刷新；register（插件行首注册）不发——
     * 初始清单走 agents/list 拉取。
     * @mode emit
     * @scope host
     */
    'agents/updated'(config: AgentConfig, change: 'updated' | 'removed'): void;
  }
}
