// ============================================================
// auth-registry 行单测（cr-545；cr-1175 批 2 起服务帧 grant.apply）：
// grant 受理全链（预检·指纹对拍·写者·回执）/ 编辑面 RPC（F2 分立）/ 凭据写面。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service } from '@agentchat/cordis';
import { PostOffice } from 'ac-post-office';
import type { Envelope } from 'ac-envelope-core';
import { makeAuthRegistryRow } from '../src/auth-registry-row.ts';
import { HostServiceDesk } from '../src/service-desk.ts';
import { readAgentAuth, authFingerprint, readGlobalAuth, readMcpManifest } from 'ac-auth-core';
import { listCredentialNames, readCredential, deriveKey, machineMaterial } from 'ac-credentials-core';

const ROOT = path.join('sandbox', 'test-auth-registry-' + process.pid);
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
  desk: HostServiceDesk;
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
  const desk = new HostServiceDesk();
  const box = new ReceiptBox();
  const ctx = new Context();
  const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
  await webFiber;
  const fiber = ctx.plugin(makeAuthRegistryRow({ dataRoot: ROOT, desk, postOffice: box }));
  await fiber;
  const rpcs = (ctx as unknown as { webServer: StubWebServer }).webServer.handlers;
  return { ctx, po, desk, box, dispose: async () => { await fiber.dispose(); await webFiber.dispose(); }, rpcs } as Rig & { rpcs: Map<string, (params: unknown) => unknown> };
}

/** grant.apply 服务帧直投（request 档） */
const applyGrantFrame = (h: Rig, agent: string, payload: Record<string, unknown>): Promise<unknown> =>
  h.desk.handle({ svc: 'grant.apply', reqId: 'test-req', payload: { ...payload, agent, conversationId: 'conv-g' } }, null);

const grantPayload = {
  action: 'grant' as const,
  asset: { kind: 'mcp-server' as const, name: 'wiki' },
  scope: 'per-agent' as const,
  priorFingerprint: '', // 用例内填
};

describe('auth-registry 行（grant.apply 服务帧受理）', () => {
  it('mcp 授予全链：受理 → grants + mcp.json → grant-applied 回执（新指纹）', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      const ack = await applyGrantFrame(h, 'alpha', { ...grantPayload, priorFingerprint: prior });
      expect((ack as { ok: boolean }).ok).toBe(true);
      expect(h.box.sent).toHaveLength(1);
      const receipt = h.box.sent[0];
      expect(receipt.kind).toBe('receipt');
      expect(receipt.to).toBe('alpha');
      const payload = receipt.payload as { subject: string; ok: boolean; newFingerprint?: string };
      expect(payload.subject).toBe('grant-applied');
      expect(payload.ok).toBe(true);
      expect(payload.newFingerprint).not.toBe(prior);
      expect(readAgentAuth(ROOT, 'alpha')!.grants).toEqual([{ mcp: 'wiki' }]);
      expect(readMcpManifest(ROOT).servers.map((s) => s.name)).toEqual(['wiki']);
    } finally {
      await h.dispose();
    }
  });

  it('指纹对拍不匹配 → 拒收回执（注册表已变更）', async () => {
    const h = await rig();
    try {
      await applyGrantFrame(h, 'alpha', { ...grantPayload, priorFingerprint: 'stale-fp' });
      const payload = h.box.sent[0].payload as { subject: string; ok: boolean; reason?: string };
      expect(payload.subject).toBe('grant-rejected');
      expect(payload.reason).toContain('不匹配');
      expect(readAgentAuth(ROOT, 'alpha')).toBeNull();
    } finally {
      await h.dispose();
    }
  });

  it('global scope → 拒收（user 审批面未落地）', async () => {
    const h = await rig();
    try {
      const prior = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      await applyGrantFrame(h, 'alpha', { ...grantPayload, scope: 'global', priorFingerprint: prior });
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
      await applyGrantFrame(h, 'alpha', { ...grantPayload, priorFingerprint: prior });
      const prior2 = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
      await applyGrantFrame(h, 'alpha', { ...grantPayload, action: 'revoke', priorFingerprint: prior2 });
      expect(readAgentAuth(ROOT, 'alpha')!.grants).toHaveLength(0);
      expect(readMcpManifest(ROOT).servers).toEqual([]);
      expect((h.box.sent[1].payload as { subject: string }).subject).toBe('grant-applied');
    } finally {
      await h.dispose();
    }
  });
});


describe('编辑面 RPC（F2 分立）', () => {
  it('六方法注册与读写（deny/allow/agent-view/global-view/credentials/write-credential）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const desk = new HostServiceDesk();
    const ctx = new Context();
    const webFiber = ctx.plugin(class extends StubWebServer { constructor(c: Context) { super(c); } });
    await webFiber;
    const fiber = ctx.plugin(makeAuthRegistryRow({
      dataRoot: ROOT,
      desk,
      postOffice: new ReceiptBox(),
    }));
    await fiber;
    const rpcs = (ctx as unknown as { webServer: StubWebServer }).webServer.handlers;
    try {
      expect(rpcs.size).toBe(6);
      (rpcs.get('auth/deny')!)({ agentId: 'alpha', ref: { mcp: 'wiki' } });
      expect(readAgentAuth(ROOT, 'alpha')!.denials).toEqual([{ mcp: 'wiki' }]);
      const view = (rpcs.get('auth/agent-view')!)({ agentId: 'alpha' }) as { auth: { denials: unknown[] } };
      expect(view.auth.denials).toHaveLength(1);
      (rpcs.get('auth/allow')!)({ agentId: 'alpha', ref: { mcp: 'wiki' } });
      expect(readAgentAuth(ROOT, 'alpha')!.denials).toHaveLength(0);
      (rpcs.get('auth/write-credential')!)({ name: 'openai', value: 'sk-123' });
      expect(listCredentialNames(ROOT)).toEqual(['openai']);
      const key = deriveKey(machineMaterial());
      expect(readCredential(ROOT, key, 'openai')).toBe('sk-123');
      const g = (rpcs.get('auth/global-view')!)({}) as { global: { entries: unknown[] } };
      expect(g.global.entries).toEqual([]);
    } finally {
      await fiber.dispose();
      await webFiber.dispose();
    }
  });
});