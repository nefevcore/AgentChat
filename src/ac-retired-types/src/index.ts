// ============================================================
// ac-retired-types —— 旧树退役类型墓碑（cr-696）
//
// ◐c 退役批删除了 A 类行包（ac-singles/ac-group/ac-session 等 24 包），
// 但 B 类保留包（goal/todo/workspace/collab-tools 等）源码仍以可选能力
// 形态消费这些服务的类型面（运行时由 preview 壳 shims 提供同名实现，
// 主线侧行已不存在）。本文件把被删包的 Context/Events 类型增强声明
// 集中承载——方法面按 B 类源码实际消费面收敛（签名从 git HEAD 原包
// 抽取；完整接口见 git 历史）。纯类型、零运行时：不进 cordis.yml/
// TREE/workspace 依赖，仅由根 tsconfig include 面闭合。
// ============================================================
import type { AgentConfig } from 'ac-agents';
import type { LlmMessage } from 'ac-llm';

// ---- 服务占位（方法面 = B 类消费面） ----

/** Agent 档案目录（原 ac-agent-store） */
interface AgentStoreService {
  getAgent(id: string): AgentConfig | undefined;
  saveAgent(config: AgentConfig): void;
  readEntry<T>(agentId: string, key: string): T | undefined;
  saveEntry(agentId: string, key: string, value: unknown): void;
  readDoc(agentId: string, name: string): string | undefined;
  saveDoc(agentId: string, name: string, content: string): void;
}

/** 群服务（原 ac-group——GroupConfig 简化形状） */
interface GroupConfig {
  id: string;
  name: string;
  description?: string;
  members: string[];
}

interface GroupService {
  get(groupId: string): GroupConfig | undefined;
  isMember(groupId: string, agentId: string): boolean;
  list(): GroupConfig[];
  listForAgent(agentId: string): GroupConfig[];
  membersWithUser(groupId: string): string[];
  send(groupId: string, from: string, content: string, options?: unknown): Promise<{ triggered: string[] }>;
}

/** 独立会话管理（原 ac-singles） */
interface SinglesService {
  list(): Array<{ id: string; [k: string]: unknown }>;
}

/** 会话历史（原 ac-session） */
interface SessionService {
  history(conversationId: string, options?: { viewer?: string }): Promise<LlmMessage[]>;
  append(conversationId: string, agentId: string, message: LlmMessage): Promise<string>;
  recordContext(conversationId: string, agentId: string, meta: Record<string, unknown>): void;
}

/** 子 Agent 多轮会话（原 ac-subagent——SubagentInfo 简化形状） */
interface SubagentInfo {
  id: string;
  parentId: string;
  name: string;
  status: string;
  displayStatus: string;
}

interface SubagentsService {
  get(id: string): SubagentInfo | undefined;
  send(id: string, opts: { parentId: string; text: string; mode?: string; conversationId?: string; elevation?: string }): { delivered: string; info: SubagentInfo; settled?: Promise<unknown> };
}

/** 插件注册中心（原 ac-plugin-registry） */
interface PluginRegistryService {
  stage(name: string, owner: string, source: unknown): Promise<unknown>;
}

/** 消息路由（原 ac-router——conversation 消费面：send） */
interface RouterService {
  send(agentId: string, inbound: string | LlmMessage, options?: Record<string, unknown>): Promise<import('ac-agent-loop').LoopRunResult>;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** Agent 数据目录服务（原 ac-agent-store——退役墓碑） */
    agentStore: AgentStoreService;
    /** 群服务（原 ac-group——退役墓碑） */
    group: GroupService;
    /** 独立会话管理（原 ac-singles——退役墓碑） */
    singles: SinglesService;
    /** 会话历史服务（原 ac-session——退役墓碑） */
    session: SessionService;
    /** 子 Agent 服务（原 ac-subagent——退役墓碑） */
    subagents: SubagentsService;
    /** 插件注册中心（原 ac-plugin-registry——退役墓碑） */
    pluginRegistry: PluginRegistryService;
    /** 消息路由（原 ac-router——退役墓碑） */
    router: RouterService;
  }

  interface Events {
    /** 独立会话元数据变更（原 ac-singles emit）@mode emit @scope host */
    'singles/updated'(record: { id: string; updatedAt?: string; [k: string]: unknown }, action: string): void;
    /** 群删除（原 ac-group emit——级联清理消费）@mode emit @scope host */
    'group/deleted'(groupId: string, group: { id: string; members: string[] }): void;
    /** 群消息（原 ac-group emit——usage 弦图消费）@mode emit @scope host */
    'group/message-posted'(payload: { groupId: string; [k: string]: unknown }): void;
    /** 路由入站（原 ac-router emit）@mode emit @scope run */
    'router/message-received'(agentId: string, message: string): void;
    /** 路由回信（原 ac-router emit）@mode emit @scope run */
    'router/reply-completed'(agentId: string, message: string): void;
    /** context 注入行落账（原 ac-session emit）@mode emit @scope run */
    'session/context-injected'(conversationId: string, agentId: string, meta: { source: string; injectionId?: string; label?: string }): void;
    /** run settlement 物化完成（原 ac-session emit）@mode emit @scope run */
    'session/run-settled'(conversationId: string, agentId: string, meta: { runId: string }): void;
  }
}
