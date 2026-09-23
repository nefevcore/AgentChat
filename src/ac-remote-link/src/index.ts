// ============================================================
// ac-remote-link/src/index.ts —— 远程链路薄行（apply + 管理面 RPC + 契约出口）
//
// inject ['webServer']：服务本体（ctx.remoteLink）+ 管理 RPC（注册即
// 归属——摘本行 = 设备管理面下线，remote-link 服务不受影响）。
//
// 方法面（P1）：
//   remote/status         服务状态（identity 公钥/relay/在线设备）
//   remote/devices        设备清单（注册表 + 在线状态合并）
//   remote/revoke         吊销设备（断连 + 删注册表）
//   remote/pair-start     开配对会话（返回 qrUri + roomId + 过期时间）
//   remote/pair-confirm   SAS 确认（true=接受 / false=拒绝）
//   remote/pair-cancel    取消配对会话
//   remote/connect        手动连 relay（重连模式）
//   remote/disconnect     断开全部连接
// ============================================================
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import { RemoteLinkService } from './service.ts';

export const name = 'ac-remote-link';
export const inject = ['webServer'];

/** 行配置（cordis.yml 接 config 的行包形态；缺省全空 = 静默待机） */
export interface Config {
  /** 中继地址（ws:// 或 wss://；缺省空 = 不连接——settings.remoteLink.relayUrl 可热更覆盖） */
  relayUrl?: string;
  /** relay TLS 证书 sha256 pin（hex；缺省跳过——测试形态） */
  tlsPin?: string;
  /** 新配对设备缺省权限档 */
  defaultScopes?: string[];
  /** 自动重连（缺省开） */
  autoReconnect?: boolean;
  /** 数据根覆盖（测试用） */
  root?: string;
}

export const Config: z<Config> = z.object({
  relayUrl: z.string(),
  tlsPin: z.string(),
  defaultScopes: z.array(z.string()),
  autoReconnect: z.boolean(),
  root: z.string(),
}) as z<Config>;

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'remote-link',
  label: '远程链路',
  description: '出站 relay 连接 + Noise E2E + 设备注册表 + 配对 + scopes 闸门（remote-client-relay-plan §4.4）',
  automatic: true,
};

// ---- 参数窄化（与 ac-web-api 同款薄行自持） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失`);
  return v;
}

function optBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const v = source[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function apply(ctx: Context, options: Record<string, unknown> = {}) {
  // 类插件实例化即注册 ctx.remoteLink（同步）——RPC 面直接持实例引用，
  // 不经 ctx.remoteLink（避免行 inject 声明 remoteLink 的自引用等待）
  const svc = new RemoteLinkService(ctx, options as never);
  const remote = () => svc;
  const web = ctx.webServer;

  web.registerRpc('remote/status', () => remote().status());

  web.registerRpc('remote/devices', () => {
    const st = remote().status();
    const online = new Set(st.onlineDeviceIds);
    return {
      devices: remote().listDevices().map((d: import('./device-registry.ts').RemoteDevice) => ({ ...d, online: online.has(d.id) })),
      relayUrl: st.relayUrl,
      identityPubkey: st.identityPubkey,
    };
  });

  web.registerRpc('remote/revoke', (params) => {
    const p = obj(params);
    const removed = remote().revokeDevice(reqStr(p, 'deviceId'));
    if (!removed) throw new Error(`设备不存在: ${String(p.deviceId)}`);
    return { revoked: removed.id };
  });

  web.registerRpc('remote/pair-start', async (params) => {
    const p = obj(params);
    const name = typeof p.deviceName === 'string' && p.deviceName ? p.deviceName : undefined;
    return remote().startPairing(name);
  });

  web.registerRpc('remote/pair-confirm', (params) => {
    const p = obj(params);
    return remote().confirmPairing(reqStr(p, 'sessionId'), optBool(p, 'accept') !== false);
  });

  web.registerRpc('remote/pair-cancel', (params) => {
    const p = obj(params);
    return remote().cancelPairing(reqStr(p, 'sessionId'));
  });

  web.registerRpc('remote/connect', (params) => {
    const p = obj(params);
    const deviceId = typeof p.deviceId === 'string' && p.deviceId ? p.deviceId : undefined;
    return remote().connect(deviceId ? { deviceId } : undefined);
  });

  web.registerRpc('remote/disconnect', () => {
    remote().disconnect();
    return { ok: true };
  });
}

// ---- 契约出口（消费方 import type {} 即得服务类型 + remote/* 事件增强）----
export type * from './contract.ts';
export type {} from './events.ts';

export { RemoteLinkService } from './service.ts';
export { DeviceRegistry } from './device-registry.ts';
export type { RemoteDevice, RemoteScope } from './device-registry.ts';