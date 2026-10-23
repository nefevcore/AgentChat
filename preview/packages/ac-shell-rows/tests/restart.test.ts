// ============================================================
// 安全重启行单测（cr-629）：两工具注册 + restart_shell 走 conversation
// 重启面 + restart_host 无邮局 fail-loud。数据根恒 preview/sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, FiberStates, type Fiber } from '@agentchat/cordis';
import { makeRestartRow } from '../src/restart.ts';

const ROOT = path.resolve('preview', 'sandbox', 'test-restart-' + process.pid);

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
    const h = await boot();
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
});
