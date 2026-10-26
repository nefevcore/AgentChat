// ============================================================
// 安全重启行单测（cr-629）：两工具注册 + restart_shell 走 conversation
// 重启面 + restart_host 无邮局 fail-loud；cr-656 宿主换代后同壳二次调用仍送达
// （每次调用独立连接——缓存连接会随旧宿主换代失效）。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, FiberStates, type Fiber } from '@agentchat/cordis';
import { makeRestartRow } from '../src/restart.ts';
import { listenIpc } from 'ac-post-office';
import { socketPathFor } from 'ac-envelope-core';

const ROOT = path.resolve('sandbox', 'test-restart-' + process.pid);

interface ToolDef { name: string; execute?: (args: Record<string, unknown>, call: unknown) => Promise<unknown> }
class StubToolsService extends Service {
  readonly tools = new Map<string, ToolDef>();
  constructor(ctx: Context) { super(ctx, 'tools'); }
  register(tool: ToolDef) {
    this.tools.set(tool.name, tool);
    this.ctx.fiber.effect(() => () => { this.tools.delete(tool.name); }, 'tools.register(' + tool.name + ')');
  }
}

class StubConversationService extends Service {
  readonly calls: string[] = [];
  constructor(ctx: Context) { super(ctx, 'conversation'); }
  requestRestart(): boolean {
    this.calls.push('requestRestart');
    return true;
  }
}

beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function boot(postOfficeAddress?: string) {
  const ctx = new Context();
  const toolsFiber = ctx.plugin(class extends StubToolsService { constructor(c: Context) { super(c); } });
  await toolsFiber;
  const convFiber = ctx.plugin(class extends StubConversationService { constructor(c: Context) { super(c); } });
  await convFiber;
  const fiber = ctx.plugin(makeRestartRow({ dataRoot: ROOT, agentId: 'alpha', ...(postOfficeAddress !== undefined ? { postOfficeAddress } : {}) }));
  await fiber;
  expect(fiber.state).toBe(FiberStates.ACTIVE);
  return {
    tools: (ctx as unknown as { tools: StubToolsService }).tools,
    conv: (ctx as unknown as { conversation: StubConversationService }).conversation,
    fibers: [fiber, convFiber, toolsFiber] as Fiber[],
  };
}

describe('安全重启行（cr-629）', () => {
  it('restart_shell：两工具注册 + 走 conversation 重启面', async () => {
    const h = await boot(socketPathFor(ROOT, 'po-a'));
    try {
      expect([...h.tools.tools.keys()].sort()).toEqual(['restart_host', 'restart_shell']);
      const out = await h.tools.tools.get('restart_shell')!.execute!({}, { agentId: 'alpha', conversationId: 'c1' }) as { ok: boolean; output: { restarting: boolean; inFlight: boolean } };
      expect(out.ok).toBe(true);
      expect(out.output).toMatchObject({ restarting: true, inFlight: true });
      expect(h.conv.calls).toEqual(['requestRestart']);
    } finally {
      for (const f of h.fibers) if (f.uid !== null) await f.dispose();
    }
  });

  it('restart_host：无邮局（CLI 直连形态）fail-loud；有邮局经信封送达（不验宿主半边——宿主侧钩子另测）', async () => {
    const h = await boot();
    try {
      const out = await h.tools.tools.get('restart_host')!.execute!({}, { agentId: 'alpha' }) as { ok: boolean; error?: string };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('CLI 直连形态无邮局');
      expect(h.conv.calls).toEqual([]);
    } finally {
      for (const f of h.fibers) if (f.uid !== null) await f.dispose();
    }
  });

  it('restart_host：宿主换代（旧连接随旧宿主消失）后同壳第二次调用仍送达（cr-656）', async () => {
    const address = socketPathFor(ROOT, 'post-office');
    const frames: unknown[] = [];
    const listen = () => listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    let server = await listen();
    const h = await boot(address);
    try {
      const tool = h.tools.tools.get('restart_host')!;
      const call = { agentId: 'alpha', conversationId: 'c1' };
      expect(((await tool.execute!({}, call)) as { ok: boolean }).ok).toBe(true);
      // 宿主换代：旧监听关闭（本壳持有的旧连接随旧宿主一起失效）→ 同地址新宿主接管
      await server.close();
      server = await listen();
      expect(((await tool.execute!({}, call)) as { ok: boolean }).ok).toBe(true);
      expect(frames).toHaveLength(2);
    } finally {
      for (const f of h.fibers) if (f.uid !== null) await f.dispose();
      await server.close();
    }
  });
  it('restart_shell：同轮重复调用直接返回已排程态（cr-664 D4——服务面只触一次）', async () => {
    const h = await boot(socketPathFor(ROOT, 'po-d4'));
    try {
      const tool = h.tools.tools.get('restart_shell')!;
      const call = { agentId: 'alpha', conversationId: 'c1' };
      const first = await tool.execute!({}, call) as { ok: boolean; output: { inFlight: boolean; alreadyScheduled?: boolean } };
      expect(first.ok).toBe(true);
      expect(first.output.alreadyScheduled).toBeUndefined();
      const second = await tool.execute!({}, call) as { ok: boolean; output: { alreadyScheduled?: boolean } };
      expect(second.ok).toBe(true);
      expect(second.output.alreadyScheduled).toBe(true);
      expect(h.conv.calls).toEqual(['requestRestart']); // 二次调用不触服务面
    } finally {
      for (const f of h.fibers) if (f.uid !== null) await f.dispose();
    }
  });

  it('restart_shell：无邮局（CLI 直连形态）fail-loud（cr-664 D5——退 42 无人重拉）', async () => {
    const h = await boot();
    try {
      const out = await h.tools.tools.get('restart_shell')!.execute!({}, { agentId: 'alpha', conversationId: 'c1' }) as { ok: boolean; error?: string };
      expect(out.ok).toBe(false);
      expect(out.error).toContain('CLI 直连形态无宿主重拉面');
      expect(h.conv.calls).toEqual([]);
    } finally {
      for (const f of h.fibers) if (f.uid !== null) await f.dispose();
    }
  });
});
