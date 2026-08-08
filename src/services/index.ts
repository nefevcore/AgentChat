// ============================================================
// services —— L4 门面（多端唯一入口）
//
// webui / TUI / Desktop 统一从这里获取能力（唯一入口）。
// 插件启动时通过 ServiceRegistry 自主注册服务（经 app 装配注入的
// registerService 回调，插件不直接 import services/）。
//
// 依赖方向：services 聚合 core/agents/plugins（L4→L3→L2→L1 单向）。
// ============================================================

export { ServiceRegistry } from './registry';
export { AgentService } from './agent-service';
export type { AgentLoaderLike, AgentServiceOptions, TimerEntry } from './agent-service';
export { HistoryService } from './history-service';
export type { HistoryServiceOptions, ArchiveFn } from './history-service';
export { ConfigService, configService } from './config-service';
export { GroupService } from './group-service';
export type { GroupWithActivity } from './group-service';
export { RPCBridge, parseRPCMessage, buildRPCSuccess, buildRPCError } from './rpc';
export { InteractionBridge, getInteractionBridge, setInteractionBridge } from './interactions';
export { createBackup, listBackups, backupDue, BACKUP_KEEP, BACKUP_INTERVAL_MS, BACKUP_DIR, backupRootDir } from './backup';
export {
  initRuntime, getRouter, getRegistry, getGroupManager, requestRestart,
  getGlobalConfig, setGlobalConfig,
} from './runtime';
export type { RuntimeDeps } from './runtime';
export type { AgentRouter, AgentRegistry, GroupManager, AgentMessage } from './runtime';
// 跨端契约（src/shared，零依赖；供各端直接引用）
export type { PersistedRole, ToolCall, AgentInfo, GroupInfo, GroupPersistedMessage, PersistedMessage } from '@shared/types';
