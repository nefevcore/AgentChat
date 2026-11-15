// ============================================================
// ac-host-face-client/tests/client-row.test.ts —— 壳侧能力面行（cr-886 → cr-1114 批1）
//
// 不起真宿主：起最小 ipc echo 服务端按需回契约帧——验 client 行的
// boot 静态承诺面（零 I/O 注册）、execute 惰性连接、对账重建、
// 本地段优先、宿主缺席可读报错。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import { listenIpcConns, socketPathFor, type IpcServer } from 'ac-envelope-core';
import type { HostFaceContract, HostFaceFrame } from 'ac-host-face-core';
import { makeHostFaceClientRow } from '../src/index.ts';

const tmps: string[] = [];
const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const servers: IpcServer[] = [];

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const s of servers.splice(0)) await s.close();
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-facec-'));
  tmps.push(dir);
  return dir;
}

/** 最小宿主替身：discover 回给定契约；execute 回固定结果 */
async function fakeHost(dataRoot: string, contract: HostFaceContract): Promise<void> {
  const { server } = await listenIpcConns(socketPathFor(dataRoot, 'host-face'), (payload) => {
    const f = payload as HostFaceFrame;
    if (f.kind === 'discover') return { kind: 'contract', corrId: f.corrId, contract };
    if (f.kind === 'ping') return { kind: 'pong', corrId: f.corrId };
    if (f.kind === 'execute') return { kind: 'exec-result', corrId: f.corrId, ok: true, result: { via: 'host', tool: f.tool } };
    return undefined;
  });
  servers.push(server);
}

const CONTRACT: HostFaceContract = {
  version: 1,
  tools: [{
    name: 'timer',
    description: '测试 timer 代理',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    requiredTags: ['infra'],
  }],
  sections: [{ name: 'GUIDELINES_TIMER', text: '[远程段] 主动安排测试文本', gate: { toolsAny: ['timer'], notSingle: true } }],
  facts: ['singles', 'group'],
};

async function bootClient(dataRoot: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow]) {
    const f = ctx.plugin(row as any, undefined);
    await f;
    fibers.push(f);
  }
  const f = ctx.plugin(makeHostFaceClientRow({ dataRoot }) as any, undefined);
  await f;
  fibers.push(f);
  booted.push({ ctx, fibers });
  return ctx;
}

/** 触发 prepare 对账（真实链路 = run() 入口第一拍；测试直接跑一轮 run） */
async function runOnce(ctx: Context): Promise<void> {
  await ctx.agentLoop.run({ runId: 'probe-' + Math.random().toString(36).slice(2, 6), agent: 'a', model: 'mock', tools: [], messages: [] });
}

describe('宿主能力面壳侧行（cr-1114 批1 承诺面）', () => {
  it('boot 静态承诺面：代理工具 + GUIDELINES_TIMER 段 boot 即在册（零 I/O，无需首 run）', async () => {
    const root = tmpRoot(); // 不起 fakeHost——boot 不依赖宿主
    const ctx = await bootClient(root);
    expect(ctx.tools.has('timer')).toBe(true);
    expect(ctx.tools.has('update_agent_profile')).toBe(true);
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('主动用 timer(action=\"set\")'); // 静态承诺面文本
  });

  it('宿主缺席：代理在册、execute 报可读错误（boot 不阻塞——软降级语义升级为可见性不丢）', async () => {
    const root = tmpRoot();
    const ctx = await bootClient(root);
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, agentId: 'a1' } as never);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('宿主能力面不可达');
  });

  it('execute 惰性连接：宿主在场 → 经宿主执行（boot 零连接，首调用建连）', async () => {
    const root = tmpRoot();
    await fakeHost(root, CONTRACT);
    const ctx = await bootClient(root);
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, agentId: 'a1' } as never);
    expect(r.ok).toBe(true);
    expect((r.output as { via: string }).via).toBe('host');
    // Shim：singles 判定经数据根（cr-973 迁 meta/sessions/）
    fs.mkdirSync(path.join(root, 'meta', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'meta', 'sessions', '.singles-registry.json'),
      JSON.stringify({ version: 2, entries: { 's-1': { id: 's-1' } } }), 'utf-8');
    const singles = ctx.get('singles') as unknown as { get(id: string): unknown };
    expect(singles.get('s-1')).toBeDefined();
    expect(singles.get('other')).toBeUndefined();
  });

  it('prepare 对账：契约与承诺面漂移 → 重建为契约面 + emit tools/source-changed（cr-1114 批2 事件面同构）', async () => {
    const root = tmpRoot();
    await fakeHost(root, CONTRACT); // timer 描述与 GUIDELINES_TIMER 文本均异于静态面
    const ctx = await bootClient(root);
    const diffs: Array<{ source: string; added: string[]; removed: string[]; changed: string[] }> = [];
    ctx.on('tools/source-changed', (d) => diffs.push(d as never));
    // boot 静态面（正典描述）
    expect((ctx.tools.get('timer') as { description: string }).description).not.toContain('测试 timer 代理');
    await runOnce(ctx); // run() 入口 prepare → discover → 对账重建
    expect((ctx.tools.get('timer') as { description: string }).description).toBe('测试 timer 代理');
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('[远程段] 主动安排测试文本');
    // 事件面：与 MCP 对账同构（source 词区分，载荷结构相同）
    //（CONTRACT = timer(描述变) + 无 update_agent_profile(删)——重建 diff 应含 changed+removed）
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.source).toBe('host-face');
    expect(diffs[0]!.changed).toEqual(['timer']);
    expect(diffs[0]!.removed).toContain('update_agent_profile');
    // 基准面不累积：再跑一轮（恒等）零事件零重建
    await runOnce(ctx);
    expect(diffs.length).toBe(1);
  });

  it('prepare 对账：契约与承诺面恒等 → 零操作（在册 spec 不变）', async () => {
    const root = tmpRoot();
    const core = await import('ac-host-face-core');
    const IDENTICAL: HostFaceContract = {
      version: 1,
      // 同源静态面（真实宿主 discover 回的就是 HOST_FACE_* 常量本体）
      tools: core.HOST_FACE_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      sections: core.HOST_FACE_SECTIONS,
      facts: [],
    };
    await fakeHost(root, IDENTICAL);
    const ctx = await bootClient(root);
    const before = ctx.tools.listWithOwner().map((t) => t.name).sort().join(',');
    await runOnce(ctx);
    expect(ctx.tools.listWithOwner().map((t) => t.name).sort().join(',')).toBe(before);
    expect(ctx.tools.has('update_agent_profile')).toBe(true); // 承诺面全量保持
  });

  it('段位占用：boot 静态段占位后 owner 同名注册抛错（位唯一性）', async () => {
    const root = tmpRoot();
    const ctx = await bootClient(root);
    // boot 即占位（不再需要 until 等待 discover）
    expect(() => ctx.agentLoop.registerPromptSection({ name: 'GUIDELINES_TIMER', text: '[本地段]' }, 'test')).toThrow();
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('主动用 timer'); // 静态面保持
  });
});
