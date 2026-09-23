// ============================================================
// ac-remote-link 测试：
//   · 身份密钥：首次生成落盘、重启（新实例同目录）加载同钥
//   · 配对会话面：二维码 URI 形状 + 房间 id 合法（relay 正则）+ 重复开启拒绝
//   · scopes 闸门：read 拒 deliver / chat 过 / 未知方法拒
//   · 注册表持久化：add → 新实例读回 → revoke 删除
//   · 事件下行白名单：allowlist 外不单播
// 注：全链路 ws + Noise 握手的 e2e 由 noise-core 单测（XK/KK 往返）+
//     relay 协议 e2e（scripts/relay-e2e.mjs 形态）分层覆盖；本文件聚焦服务面。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@agentchat/cordis';
import { RemoteLinkService } from '../src/service.ts';
import { DeviceRegistry } from '../src/device-registry.ts';

let tmpRoot: string;
let ctx: Context;
let svc: RemoteLinkService;

async function boot(opts: Record<string, unknown> = {}): Promise<void> {
  ctx = new Context();
  // mock webServer（服务只依赖 callRpc）——provide 后直接 new 服务（web-server 测试同款形态）
  const rpcTable = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  ctx.provide('webServer', {
    callRpc: async (method: string, params?: unknown) => {
      const h = rpcTable.get(method);
      if (!h) throw new Error(`unknown method: ${method}`);
      return h(params);
    },
  });
  svc = new RemoteLinkService(ctx, { root: tmpRoot, relayUrl: 'wss://fake.relay', autoReconnect: false, ...opts } as never);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'remote-link-'));
});

afterEach(async () => {
  void ctx;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('身份密钥', () => {
  it('首次生成落盘、重启加载同钥', async () => {
    await boot();
    const f1 = join(tmpRoot, 'remote', 'identity');
    expect(existsSync(f1)).toBe(true);
    const raw1 = readFileSync(f1, 'utf8');
    const svc2 = new RemoteLinkService(new Context(), { root: tmpRoot, relayUrl: 'wss://x' });
    expect(svc2.status().identityPubkey).toBe(svc.status().identityPubkey);
    expect(readFileSync(f1, 'utf8')).toBe(raw1);
  });
});

describe('配对会话面', () => {
  it('startPairing 生成二维码 URI + 房间 id 合法形状', async () => {
    await boot();
    const session = await svc.startPairing();
    expect(session.state).toBe('wait-join');
    expect(session.qrUri).toContain('agentchat://pair?v=1');
    expect(session.qrUri).toContain('relay=');
    expect(session.qrUri).toContain('room=');
    expect(session.qrUri).toContain('pk=');
    expect(session.roomId).toMatch(/^[A-Za-z0-9_-]{22,43}$/);
  });

  it('重复 startPairing 拒绝', async () => {
    await boot();
    await svc.startPairing();
    await expect(svc.startPairing()).rejects.toThrow('already in progress');
  });
});

describe('scopes 闸门', () => {
  it('read 拒 deliver / chat 过 / 未知方法拒', async () => {
    await boot();
    const readDev = { id: 'd1', name: 'n', pubkey: 'k', scopes: ['read' as const], pairedAt: 0 };
    const chatDev = { id: 'd2', name: 'n', pubkey: 'k', scopes: ['read' as const, 'chat' as const], pairedAt: 0 };
    expect(svc.scopeAllows(readDev.scopes, 'conversation/deliver')).toBe(false);
    expect(svc.scopeAllows(chatDev.scopes, 'conversation/deliver')).toBe(true);
    expect(svc.scopeAllows(chatDev.scopes, 'unknown/method')).toBe(false);
  });
});

describe('注册表持久化', () => {
  it('add → 新实例读回 → revoke 删除', () => {
    const reg = new DeviceRegistry(join(tmpRoot, 'remote'));
    reg.add({ id: 'x1', name: 'phone', pubkey: 'pk1', scopes: ['read'], pairedAt: 1 });
    const reg2 = new DeviceRegistry(join(tmpRoot, 'remote'));
    expect(reg2.get('x1')?.name).toBe('phone');
    expect(reg2.revoke('x1')?.id).toBe('x1');
    expect(reg2.get('x1')).toBeUndefined();
  });
});

describe('事件下行白名单', () => {
  it('allowlist 外不单播、白名单内不抛错', async () => {
    await boot();
    expect(() => svc.broadcastEvent('llm/delta', [{ delta: 'x' }])).not.toThrow();
    expect(() => svc.broadcastEvent('config/changed', [{}])).not.toThrow();
  });
});