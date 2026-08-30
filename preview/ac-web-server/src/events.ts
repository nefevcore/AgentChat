// ============================================================
// ac-web-server/src/events.ts —— Web 传输域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：ws/* 事件的分发方是本包的 WebServerService。
// 消费方 `import type {} from 'ac-web-server'` 即获得类型增强。
//
// ws 域 ack 类（地图 §2 M13 新增）：传输层语义回执——deduped（幂等
// 去重命中）/ busy（会话忙，已入队或注入）/ parked（等空闲停靠）。
// ============================================================
import type {} from '@agentchat/cordis';
import type { WsAckPayload } from 'ac-ws-protocol';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * WS 连接建立（握手完成 + ws/ready 已发）。
     * 重连恢复的订阅面：监听方在此重放会话状态（session.history() 回放
     * + delta 流重订——ADR-6 的恢复路径）。
     * @mode emit
     * @scope host
     */
    'ws/connection-opened'(connId: string): void;

    /**
     * WS 连接断开（close/心跳判死 terminate）。清理连接级缓存的订阅面。
     * @mode emit
     * @scope host
     */
    'ws/connection-closed'(connId: string, code: number, reason: string): void;

    /**
     * 投递回执通知（ws/ack 帧外发的同款载荷——审计/日志/桥接订阅面）。
     * @mode emit
     * @scope host
     * 载荷：requestId（幂等键）+ kind（deduped|busy|parked）+ info 附加上下文。
     */
    'ws/ack'(payload: WsAckPayload): void;
  }
}
