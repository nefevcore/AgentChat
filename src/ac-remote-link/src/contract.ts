// ============================================================
// ac-remote-link/src/contract.ts —— 远程链路域契约（纯类型，零运行时）
// ============================================================

export type { RemoteDevice, RemoteScope } from './device-registry.ts';
import type { RemoteScope } from './device-registry.ts';

/** 配对会话（startPairing 后的活动状态） */
export interface PairingSession {
  sessionId: string;
  /** relay 房间 id（p: 前缀——配对模式信令） */
  roomId: string;
  /** 二维码 URI（agentchat://pair?v=1&relay=...&room=...&pk=...&exp=...） */
  qrUri: string;
  /** 过期时间（epoch ms） */
  expiresAt: number;
  state: 'wait-join' | 'sas-confirm' | 'done' | 'expired';
  /** SAS 到位后填充（两端显示比对） */
  sas?: string;
  /** 手机上报的设备信息（握手载荷） */
  deviceName?: string;
}

/** 服务状态快照（管理面展示用） */
export interface RemoteLinkStatus {
  identityPubkey: string;
  relayUrl: string | null;
  state: 'idle' | 'connecting' | 'online' | 'pairing' | 'error';
  onlineDeviceIds: string[];
  lastError: string | null;
}

/** remote-link RPC 面转发上下文（scopes 闸门判定用） */
export interface RemoteCallContext {
  deviceId: string;
  scopes: RemoteScope[];
}