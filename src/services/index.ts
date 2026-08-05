// ============================================================
// services —— src 对外服务门面（v0.5.0 P3）
//
// webui / TUI / Desktop 统一从这里获取能力（唯一入口）。
// 插件启动时通过 ServiceRegistry 自主注册服务。
// ============================================================

export { ServiceRegistry } from './registry';
export { AgentService } from './agent-service';
export { HistoryService } from './history-service';
