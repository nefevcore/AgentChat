// ============================================================
// events.ts —— 子 Agent 域事件目录（声明合并，零运行时；cr-677）
//
// 谁 emit 谁声明：subagents/updated 的分发方是本包的
// ShellSubagentService（spawn/send/stop/delete/onExit 发射点）。
// 消费方 `import type {} from 'ac-shell-subagent'` 即获得类型增强
//（壳 boot 旁带发射面是唯一消费者）。
//
// 主线同名事件的 owning 声明 = ac-subagent/src/events.ts（SubagentInfo +
// 六词 action）。preview 壳树不装 ac-subagent，但 typecheck 全仓扫两树
// ——同名事件的载荷类型必须两树同形（cordis Events 接口全局合并）。
// 故本声明按主线同形：status 用主线 SubagentStatus 开放串，action 含
// 'timeout'（主线词汇；本服务不发但类型面不窄于主线）。
// ============================================================
import type {} from '@agentchat/cordis';

/** 变更后投影载荷（主线 SubagentInfo 同形——status/displayStatus 开放串） */
export interface SubagentUpdatedInfo {
  id: string;
  parentId: string;
  name: string;
  status: string;
  displayStatus: string;
  task: string;
  runs: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 子 Agent 清单变更通知（emit）——载荷 = 变更后投影（list 口径）+
     * 变更词（主线六词；本服务发五词——timeout 不发）。
     * 前端 subagentBoard（运行跟踪面板子Agent 区）帧驱动刷新唯一源。
     * @mode emit
     * @scope subagent
     */
    'subagents/updated'(info: SubagentUpdatedInfo, action: 'spawned' | 'started' | 'settled' | 'timeout' | 'stopped' | 'removed'): void;
    /**
     * 子 Agent 发起提问（emit，cr-730）——盘 watch 发现新 pending ask 时
     * 发射（注入父会话之前）：载荷 = 子域 pending 提问投影。测试/面板徽章
     * 消费面；正文注入归 ShellSubagentService 自身（steer/deliver）。
     * @mode emit
     * @scope subagent
     */
    'subagents/ask'(asking: { childId: string; interactionId: string; questions: Array<{ question: string; options: string[]; multi?: true }> }): void;
  }
}
