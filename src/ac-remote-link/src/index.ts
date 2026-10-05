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
import { proxyToSelf, type HttpBridgeParams } from './http-bridge.ts';
import { createBridgeCatalog } from 'ac-wire-format';
import { isArchiveReviewRun } from 'ac-agent-loop';
import { isGroupHint } from 'ac-core-utils';
import { isBackgroundSender } from 'ac-ws-protocol';

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
  description: '出站 relay 连接 + Noise E2E + 设备注册表 + 配对（cr-105：RPC 面全放行，deliver 强制改写保留）',
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

/** HTTP 转发的参数窄化（缺省 GET；path 必填——其余由 http-bridge 校验） */
function httpParams(p: Record<string, unknown>): HttpBridgeParams {
  return {
    method: typeof p.method === 'string' ? p.method : undefined,
    path: reqStr(p, 'path'),
    contentType: typeof p.contentType === 'string' ? p.contentType : undefined,
    bodyB64: typeof p.bodyB64 === 'string' ? p.bodyB64 : undefined,
  };
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
    const session = new Map(st.devices.map((d) => [d.deviceId, d.session]));
    return {
      // session 会话态（cr-246 两维度）：online=在线传输 / waiting=占座等对端 / 无=未连
      devices: remote().listDevices().map((d: import('./device-registry.ts').RemoteDevice) => ({ ...d, session: session.get(d.id) ?? null })),
      relayUrl: st.relayUrl,
      identityPubkey: st.identityPubkey,
      tlsPinConfigured: st.tlsPinConfigured,
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
    // sas（R-2）：接受时必填——服务端与握手产物核对，堵盲确认
    return remote().confirmPairing(
      reqStr(p, 'sessionId'),
      optBool(p, 'accept') !== false,
      typeof p.sas === 'string' ? p.sas.trim() : undefined,
    );
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

  // ---- 宿主 HTTP 面转发（M3.4）----
  // 远程 WebView 的 /api/* 请求经此投回核心端自身 web-server（通用转发，非逐端点
  // bridge——后者会持续追着 webui 新增端点跑）。cr-105 起 scopes 闸门退役，
  // read/static 桥自带 GET-only 硬校验（方法闸在桥层，不依赖设备权限）。
  web.registerRpc('http/read', async (params) => {
    const p = httpParams(obj(params));
    if ((p.method ?? 'GET').toUpperCase() !== 'GET') {
      throw new Error('remote http: http/read 只接受 GET');
    }
    return proxyToSelf(await web.ready(), p);
  });

  // GET 静态面代理（cr-101 变体B）：webui dist 的在线取用——webui 更新后手机端
  // 免重装 APK，WebView 加载核心端最新 dist（缓存协商由 cacheHeaders 白名单承载，
  // cr-82）。仅 GET（此处硬校验）；路径校验住 http-bridge safePath——/api/ = 动态面，
  // 其余 = 静态面全通（cr-108 白名单退役），逃逸形态拒绝。与 http/read 分立两个
  // method：静态面只回 GET 且行为面独立（后续如需限流有独立落点）。
  web.registerRpc('http/static', async (params) => {
    const p = httpParams(obj(params));
    if ((p.method ?? 'GET').toUpperCase() !== 'GET') {
      throw new Error('remote http: http/static 只接受 GET');
    }
    return proxyToSelf(await web.ready(), p);
  });

  web.registerRpc('http/write', async (params) =>
    proxyToSelf(await web.ready(), httpParams(obj(params))));

  // ---- 事件下行（会话流 → 远程设备）----
  // cr-108 并源：订阅清单/过滤/整形与 ws-bridge 消费同一共享目录
  // （ac-wire-format createBridgeCatalog——域判定经注入，域词汇住各域）。
  // 13 事件白名单退役：手机端从此与桌面同面（群消息/决策卡/列表刷新等
  // 29 种事件此前静默缺失）。delta 批器住 service（WAN 微批实例独立）。
  const catalog = createBridgeCatalog({
    isBackgroundSender,
    isArchiveReviewRun,
    isGroupHint,
  });
  for (const ev of catalog.events) {
    ctx.on(ev.name as never, ((...args: unknown[]) => {
      const wired = ev.wire ? ev.wire(args) : args;
      if (wired === undefined) return;
      remote().broadcastEvent(ev.name, wired);
    }) as never, { description: `远程下行：${ev.name} → 在线设备（Noise 加密帧）` });
  }
}

// ---- 契约出口（消费方 import type {} 即得服务类型 + remote/* 事件增强）----
export type * from './contract.ts';
export type {} from './events.ts';

export { RemoteLinkService } from './service.ts';
export { DeviceRegistry } from './device-registry.ts';
export type { RemoteDevice, RemoteScope } from './device-registry.ts';