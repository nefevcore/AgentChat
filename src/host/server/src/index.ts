// ============================================================
// @agentchat/server —— 宿主域（迁移自 src/services/* + src/server/*）
//
// · L4 门面：ServiceRegistry / RPCBridge / InteractionBridge / Runtime 门面 /
//   AgentService / GroupService / HistoryService / ConfigService
// · 传输层：WebUIServer（Express HTTP + WS + JSON-RPC + 事件桥）
//
// 装配约定：boot 层经 initRuntime 注入 Router/全局配置/重启函数；
// ServiceRegistry 作为"服务发现"入口传给 WebUIServer。
// ============================================================

export { ServiceRegistry } from './registry';
export { RPCBridge, parseRPCMessage, buildRPCSuccess, buildRPCError } from './rpc';
export { InteractionBridge, getInteractionBridge, setInteractionBridge } from './interactions';
export {
  initRuntime, getRouter, getRegistry, getGroupManager, requestRestart,
  getGlobalConfig, setGlobalConfig, setRequestRestart,
} from './runtime';
export type { RuntimeDeps } from './runtime';
export type { AgentRouter, AgentRegistry, GroupManager, RouterMessage } from './runtime';
export { ConfigService, configService } from './config-service';
export { HistoryService } from './history-service';
export type { HistoryServiceOptions, ArchiveFn } from './history-service';
export { SinglesService } from './singles';
export type { SingleSessionRecord, SinglesRegistryLike, SinglesServiceOptions } from './singles';
export { createSinglesRouter } from './api/singles';
export { GroupService } from './group-service';
export type { GroupWithActivity } from './group-service';
export { AgentService } from './agent-service';
export type { AgentLoaderLike, AgentServiceOptions, TimerEntry, PluginRegistryLike } from './agent-service';
export { WebUIServer } from './webui-server';
export * from './service';
export { HttpRouteRegistry } from './http-routes';
export type { HttpRouteHandler, HttpRouteInfo } from './http-routes';
export type { WebUIServerOptions } from './webui-server';
export { PluginEventBus } from './plugin-events';
export type { PluginManager } from './api/plugins';
export { createUiRouter, createUiPluginStaticHandler, UI_SLOT_CATALOG } from './api/ui';
export type { UISlotInfo } from '@agentchat/protocol';
export {
  createBackup, listBackups, backupDue, backupRootDir,
  BACKUP_KEEP, BACKUP_INTERVAL_MS, BACKUP_DIR,
} from '@agentchat/backup';
export { ArchiveService, estimateMessagesTokens, truncateMessagesByTokenBudget, safeSplitIdx, truncateTail } from '@agentchat/archive';
export type {
  PersistedRole, ToolCall, AgentInfo, GroupInfo, GroupPersistedMessage, PersistedMessage,
  SingleSessionInfo, SingleSessionCreateInput,
} from '@agentchat/protocol';
