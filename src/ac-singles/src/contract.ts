// ============================================================
// ac-singles/src/contract.ts —— 独立会话域类型
//
// 会话 = 引用 + 覆盖，不是拷贝（src SinglesService 同款语义）：
//   agentId 引用已注册 Agent（预设/常规皆可）；model 为会话级覆盖
//   （缺省 = Agent 原配置）；工具集/钩子跟随 Agent 原定义。
// 消息流不归本域：conversationId = sid，ac-session 按键分桶
// （规约 2——文件名即 conversationId，淘汰 src single~ 前缀魔法）。
// ============================================================

/** 独立会话元数据（session.json 持久形态 = wire 形） */
export interface SingleSessionMeta {
  id: string;
  /** 引用的 Agent id（空 = 待选择；发消息前必须补齐） */
  agentId: string;
  /** 会话级模型覆盖（undefined = Agent 原配置） */
  model?: string;
  title?: string;
  /** 挂载的用户工作区 id（缺省/空 = 未分组） */
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'archived';
}

/** 创建入参（全部可选——空会话先建，Agent 在输入栏选择后经 update 补齐） */
export interface SinglesCreateInput {
  agentId?: string;
  model?: string;
  title?: string;
  workspaceId?: string;
  /** 复用已有空白会话（未选 Agent 且无消息；空白会话全局唯一不变量） */
  reuse?: boolean;
}

/** 更新入参（undefined = 不变；model: null = 清除覆盖；agentId: '' = 清空待选） */
export interface SinglesUpdateInput {
  agentId?: string;
  model?: string | null;
  title?: string;
  workspaceId?: string;
}
