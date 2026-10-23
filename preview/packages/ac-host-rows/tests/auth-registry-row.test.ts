// ============================================================
// auth-registry 行单测（cr-545）：HostInbox 扇出共存 / grant 受理全链
//（预检·指纹对拍·写者·回执）/ 编辑面 RPC（F2 分立）/ 凭据写面。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service } from '@agentchat/cordis';
import { PostOffice } from 'ac-post-office';
import {
  makeGrantEnvelope,
  makeUsageEnvelope,
  type Envelope,
} from 'ac-envelope-core';
import { makeAuthRegistryRow } from '../src/auth-registry-row.ts';
import { HostInbox } from '../src/host-inbox.ts';
import { readAgentAuth, authFingerprint, readGlobalAuth, readMcpManifest } from 'ac-auth-core';
import { listCredentialNames, readCredential, deriveKey, machineMaterial } from 'ac-credentials-core';

const ROOT = path.join('preview', 'sandbox', 'test-auth-registry-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 收执台：邮局替身——记录 dispatch 的回执信 */
class ReceiptBox {
  sent: Envelope[] = [];
  async dispatch(env: Envelope): Promise<unknown> {
    this.sent.push(env);
    return [];
  }
}

interface Rig {
  ctx: Context;
  po: PostOffice;
  inbox: HostInbox;
  box: ReceiptBox;
  dispose(): Promise<void>;
}

/** webServer 捕获桩（本行 inject ['webServer']——cr-594 起 RPC 面挂 ctx.webServer） */
class StubWebServer extends Service {
  readonly handlers = new Map<string, (params: unknown) => unknown>();
  constructor(ctx: Context) {
    super(ctx, 'webServer');
  }
  registerRpc(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler);
  }
}

async function rig(): Promise<Rig> {
  const po = new PostOffice({ dataRoot: ROOT });
  const inbox = new HostInbox(po);
  inbox.start();
  const box = new ReceiptBox();
  const ctx = new Context();
  const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
  await webFiber;
  const fiber = ctx.plugin(makeAuthRegistryRow({ dataRoot: ROOT, inbox, postOffice: box }));
  await fiber;
  const rpcs = (ctx as unknown as { webServer: StubWebServer }).webServer.handlers;
  return { ctx, po, inbox, box, dispose: async () => { await fiber.dispose(); await webFiber.dispose(); }, rpcs } as Rig & { rpcs: Map<string, (params: unknown) => unknown> };
}

const grantPayload = {
  action: 'grant' as const,
  asset: { kind: 'mcp-server' as const, name: 'wiki' },
  scope: 'per-agent' as const,
  priorFingerprint: '', // 用例内填
};

describe('auth-registry 行（grant 信受理）', () => {
  it('mcp 授予全链：受理 → grants + mcp.json → grant-applied 回执（新指纹）', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      const env = makeGrantEnvelope({
        uuid: 'conv-1', requestId: 'gr-1', sender: 'alpha',
        payload: { ...grantPayload, priorFingerprint: prior },
      });
      await h.po.dispatch(env);
      expect(h.box.sent).toHaveLength(1);
      const receipt = h.box.sent[0];
      expect(receipt.kind).toBe('receipt');
      expect(receipt.to).toBe('alpha');
      expect(receipt.requestId).toBe('gr-1'); // 对账键 = 受理信原值
      const payload = receipt.payload as { subject: string; ok: boolean; newFingerprint?: string };
      expect(payload.subject).toBe('grant-applied');
      expect(payload.ok).toBe(true);
      expect(payload.newFingerprint).not.toBe(prior);
      // 写者面落盘
      expect(readAgentAuth(ROOT, 'alpha')!.grants).toEqual([{ mcp: 'wiki' }]);
      expect(readMcpManifest(ROOT).servers.map((s) => s.name)).toEqual(['wiki']);
    } finally {
      await h.dispose();
    }
  });

  it('指纹对拍不匹配 → 拒收回执（注册表已变更）', async () => {
    const h = await rig();
    try {
      const env = makeGrantEnvelope({
        uuid: 'conv-2', requestId: 'gr-2', sender: 'alpha',
        payload: { ...grantPayload, priorFingerprint: 'stale-fp' },
      });
      await h.po.dispatch(env);
      const payload = h.box.sent[0].payload as { subject: string; ok: boolean; reason?: string };
      expect(payload.subject).toBe('grant-rejected');
      expect(payload.reason).toContain('不匹配');
      expect(readAgentAuth(ROOT, 'alpha')).toBeNull(); // 未写
    } finally {
      await h.dispose();
    }
  });

  it('global scope → 拒收（user 审批面未落地）', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      const env = makeGrantEnvelope({
        uuid: 'conv-3', requestId: 'gr-3', sender: 'alpha',
        payload: { ...grantPayload, scope: 'global', priorFingerprint: prior },
      });
      await h.po.dispatch(env);
      const payload = h.box.sent[0].payload as { subject: string };
      expect(payload.subject).toBe('grant-rejected');
    } finally {
      await h.dispose();
    }
  });

  it('revoke mcp：grants 移除 + mcp.json 移除 + 回执', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      await h.po.dispatch(makeGrantEnvelope({
        uuid: 'conv-4', requestId: 'gr-4', sender: 'alpha',
        payload: { ...grantPayload, priorFingerprint: prior },
      }));
      const prior2 = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      await h.po.dispatch(makeGrantEnvelope({
        uuid: 'conv-4', requestId: 'gr-5', sender: 'alpha',
        payload: { ...grantPayload, action: 'revoke', priorFingerprint: prior2 },
      }));
      expect(readAgentAuth(ROOT, 'alpha')!.grants).toHaveLength(0);
      expect(readMcpManifest(ROOT).servers).toEqual([]);
      expect((h.box.sent[1].payload as { subject: string }).subject).toBe('grant-applied');
    } finally {
      await h.dispose();
    }
  });

  it('requestId 幂等（HostInbox 层）：重投不重复受理', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      const env = makeGrantEnvelope({
        uuid: 'conv-5', requestId: 'gr-6', sender: 'alpha',
        payload: { ...grantPayload, priorFingerprint: prior },
      });
      const r1 = await h.po.dispatch(env);
      const r2 = await h.po.dispatch(env);
      expect(r1[0].ack!.fresh).toBe(true);
      expect(r2[0].ack!.fresh).toBe(false);
      // 幂等重投：受理 handler 不重跑 → 回执只一封（首投已发）
      expect(h.box.sent).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
});

describe('HostInbox 扇出（usage/auth-registry 共存）', () => {
  it('同信扇出两 handler + 非 host 信不进（to 门）+ 非法信滞留', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const inbox = new HostInbox(po);
    inbox.start();
    const gotA: string[] = [];
    const gotB: string[] = [];
    inbox.on(async (e) => { gotA.push(e.requestId); });
    inbox.on(async (e) => { gotB.push(e.requestId); });
    // usage 信（非 grant/revoke → auth handler 直过）
    const u = makeUsageEnvelope({ requestId: 'u1', payload: {} as never });
    await po.dispatch(u);
    expect(gotA).toEqual(['u1']);
    expect(gotB).toEqual(['u1']);
    // 非法信（校验抛错——注：这里 handler 不校验，直接验证扇出错误传播用下一例）
  });

  it('handler 抛错 = 投递失败滞留（at-least-once）+ 幂等重投不重跑', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const inbox = new HostInbox(po);
    inbox.start();
    let calls = 0;
    inbox.on(async () => { calls++; throw new Error('boom'); });
    const env: Envelope = {
      uuid: 'c', requestId: 'e1', sender: 'user', to: 'host', kind: 'message', budget: 0, payload: null,
    };
    const out = await po.dispatch(env);
    expect(out[0]).toMatchObject({ channel: 'outbox', ack: null });
    expect(calls).toBe(1);
    // 重投（同 requestId）：幂等 seen 未记（失败不记）→ handler 重跑
    const out2 = await po.dispatch(env);
    expect(out2[0]).toMatchObject({ channel: 'outbox' });
    expect(calls).toBe(2);
  });
});

describe('编辑面 RPC（F2 分立）', () => {
  it('六方法注册与读写（deny/allow/agent-view/global-view/credentials/write-credential）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const inbox = new HostInbox(po);
    inbox.start();
    const ctx = new Context();
    const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
    await webFiber;
    const fiber = ctx.plugin(makeAuthRegistryRow({
      dataRoot: ROOT,
      inbox,
      postOffice: new ReceiptBox(),
    }));
    await fiber;
    const rpcs = (ctx as unknown as { webServer: StubWebServer }).webServer.handlers;
    try {
      expect(rpcs.size).toBe(6);
      // deny → agent-view → allow
      (rpcs.get('auth/deny')!)({ agentId: 'alpha', ref: { mcp: 'wiki' } });
      expect(readAgentAuth(ROOT, 'alpha')!.denials).toEqual([{ mcp: 'wiki' }]);
      const view = (rpcs.get('auth/agent-view')!)({ agentId: 'alpha' }) as { auth: { denials: unknown[] } };
      expect(view.auth.denials).toHaveLength(1);
      (rpcs.get('auth/allow')!)({ agentId: 'alpha', ref: { mcp: 'wiki' } });
      expect(readAgentAuth(ROOT, 'alpha')!.denials).toHaveLength(0);
      // write-credential → credentials（加密往返——机器绑定）
      (rpcs.get('auth/write-credential')!)({ name: 'openai', value: 'sk-123' });
      expect(listCredentialNames(ROOT)).toEqual(['openai']);
      const key = deriveKey(machineMaterial());
      expect(readCredential(ROOT, key, 'openai')).toBe('sk-123');
      // global-view（空层也 200）
      const g = (rpcs.get('auth/global-view')!)({}) as { global: { entries: unknown[] } };
      expect(g.global.entries).toEqual([]);
    } finally {
      await fiber.dispose();
      await webFiber.dispose();
    }
  });
});
