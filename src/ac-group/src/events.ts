// ============================================================
// ac-group/src/events.ts —— 群域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：group/* 事件的分发方是本包的 GroupService。
// 全部纯通知（emit）：WS 广播 / 持久化（ac-group-store）/ 审计订阅方
// 【零注入 group 服务】。变更类载荷携带变更后的 GroupConfig 终值。
// ============================================================
import type {} from '@agentchat/cordis';
import type { GroupConfig, GroupMessageRecord } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 群已创建（成员表初始化完成）。
     * @mode emit
     * @scope host
     */
    'group/created'(group: GroupConfig): void;

    /**
     * 群已删除（内容流一并丢弃；store 订阅方负责清盘）。
     * @mode emit
     * @scope host
     */
    'group/deleted'(groupId: string, group: GroupConfig): void;

    /**
     * 群已重命名（载荷为终值）。
     * @mode emit
     * @scope host
     */
    'group/renamed'(groupId: string, name: string, group: GroupConfig): void;

    /**
     * 群简介变更（载荷 description 为终值——undefined = 清空；group 为
     * 变更后终值）。UI/审计订阅方消费（前端群聊抽屉保存简介链路）。
     * @mode emit
     * @scope host
     */
    'group/description-set'(groupId: string, description: string | undefined, group: GroupConfig): void;

    /**
     * 成员加入（载荷 group 为变更后终值）。
     * @mode emit
     * @scope host
     */
    'group/member-added'(groupId: string, agentId: string, group: GroupConfig): void;

    /**
     * 成员离开（载荷 group 为变更后终值；清空自动删除时随后发 group/deleted）。
     * @mode emit
     * @scope host
     */
    'group/member-removed'(groupId: string, agentId: string, group: GroupConfig): void;

    /**
     * 记忆属主变更（载荷 owner 为终值——undefined = 解除；group 为变更后
     * 终值）。属主退群触发的自动解除同发本事件。UI/审计订阅方消费。
     * @mode emit
     * @scope host
     */
    'group/memory-owner-set'(groupId: string, owner: string | undefined, group: GroupConfig): void;

    /**
     * 群消息已入流（内容通道唯一事实源的写入通知；投递触发在 post 之后、
     * 由 send 编排——本事件不区分是否触发投递）。UI 实时展示 / store 落盘订阅。
     * N2 双语境：用户经 RPC 发言 = 宿主上下文；Agent 群内回帖经 conversation
     * 投递 = 该 Agent 执行里——判定式（"发生在谁的执行里"）给不出稳定
     * 答案，按 host 保守归（无读取器即不可门控）。
     * @mode emit
     * @scope host
     */
    'group/message-posted'(groupId: string, message: GroupMessageRecord): void;
  }
}
