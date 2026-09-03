// ============================================================
// ac-conv-settings/src/events.ts —— 会话设置域事件目录
//
// 谁提供 ctx.convSettings，谁声明本域事件（契约归属 owning package）。
// ============================================================
import type { ConvSettings } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 会话设置变更（纯通知：多端/多标签同步广播——ChatInput 等消费方
     * 据此即时刷新选择态回显）。
     *
     * @mode emit
     * @scope host（设置写入发生在宿主上下文，不属任何 Agent 的执行）
     * @param conversationId 会话归属键（对桶 a~b / 群 gid）
     * @param settings 变更后的终态设置（cleared = 空对象）
     * @param change 'set' | 'cleared'
     */
    'conv-settings/updated'(conversationId: string, settings: ConvSettings, change: 'set' | 'cleared'): void;
  }
}
