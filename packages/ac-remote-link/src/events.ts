// ============================================================
// ac-remote-link/src/events.ts —— remote/* 事件目录（emit，host 域）
//
// 管理面通知（与 agents/updated 同级）：webui 设备页轮询/展示用。
// ws-bridge 可订阅转发；M1 先由 remote/* RPC 轮询驱动 UI。
// ============================================================

export {};

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 设备配对完成（写入注册表后 emit）。
     * @mode emit @scope host
     * 载荷：device（注册表条目快照）。订阅方：设备管理 UI / 审计。
     */
    'remote/device-paired': (device: import('./contract.ts').RemoteDevice) => void;
    /**
     * 设备吊销（注册表删除后 emit）。
     * @mode emit @scope host
     * 载荷：deviceId + 被删条目快照（可能 undefined——已不存在时）。
     */
    'remote/device-revoked': (deviceId: string, device?: import('./contract.ts').RemoteDevice) => void;
    /**
     * 设备上线（KK 握手完成）。
     * @mode emit @scope host
     */
    'remote/device-online': (deviceId: string) => void;
    /**
     * 设备离线（连接断开/解密失败主动关闭）。
     * @mode emit @scope host
     */
    'remote/device-offline': (deviceId: string, reason: string) => void;
  }
}