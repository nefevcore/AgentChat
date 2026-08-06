// ============================================================
// services —— src 对外服务门面（v0.5.0 P3）
//
// webui / TUI / Desktop 统一从这里获取能力（唯一入口）。
// 插件启动时通过 ServiceRegistry 自主注册服务。
// ============================================================

export { ServiceRegistry } from './registry';
export { AgentService } from './agent-service';
export type { TimerEntry } from './agent-service';
export { HistoryService } from './history-service';
export { ConfigService, configService } from './config-service';
export { GroupService } from './group-service';
export { RPCBridge, parseRPCMessage, buildRPCSuccess, buildRPCError } from './rpc';
export { InteractionBridge, getInteractionBridge, setInteractionBridge } from './interactions';
export { createBackup, listBackups, backupDue, BACKUP_KEEP, BACKUP_DIR, backupRootDir } from './backup';
export { initRuntime, getRouter, getRegistry, getGroupManager, requestRestart } from './runtime';
export type { AgentRouter, AgentRegistry, GroupManager, AgentMessage } from './runtime';
