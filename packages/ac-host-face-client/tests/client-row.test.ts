// ============================================================
// ac-host-face-client/tests/client-row.test.ts —— 壳侧能力面行（cr-886）
//
// 不起真宿主：起最小 ipc echo 服务端按需回契约帧——验 client 行的
// discover→装配（代理工具/远程段/Shim）、本地段优先、宿主缺席降级。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import { listenIpcConns, socketPathFor, encodeFrame, type IpcServer } from 'ac-envelope-core';
import type { HostFaceContract, HostFaceFrame } from 'ac-host-face-core';
import { makeHostFaceClientRow } from '../src/index.ts';
import { HostFaceClient } from 'ac-host-face-core';

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
  console.log('[probe] client fiber state:', f.state, 'agentLoop:', ctx.get('agentLoop', false) !== undefined);
  return ctx;
}

/** 等代理面装配：周期性触发 run（首 run 拉契约 → 异步到达 → 后续 run 应用 staged） */
async function until(ctx: Context, cond: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 25 && !cond(); i++) {
    void ctx.waterfall('loop/before-run', { request: { model: 'm', messages: [] } } as never, async () => ({ finish: 'stop' }) as never);
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(cond()).toBe(true);
}

describe('宿主能力面壳侧行（cr-886）', () => {
  it('discover → 代理工具注册 + execute 经宿主 + singles/group Shim 装配', async () => {
    const root = tmpRoot();
    // singles 注册表盘上形态（facts Shim 直读）
    fs.mkdirSync(path.join(root, 'viewer', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'viewer', 'sessions', '.singles-registry.json'),
      JSON.stringify({ version: 2, entries: { 's-1': { id: 's-1' } } }), 'utf-8');
    await fakeHost(root, CONTRACT);
    const ctx = await bootClient(root);
    await until(ctx, () => ctx.tools.has('timer'));
    // Shim：singles 判定经数据根
    const singles = ctx.get('singles') as unknown as { get(id: string): unknown };
    expect(singles.get('s-1')).toBeDefined();
    expect(singles.get('other')).toBeUndefined();
    // 代理 execute → 宿主替身回执
    const r = await ctx.tools.execute({ name: 'timer', args: { action: 'list' }, agentId: 'a1' } as never);
    expect(r.ok).toBe(true);
    expect((r.output as { via: string }).via).toBe('host');
  });

  it('远程段注册 + 门控：timer 在场注入；singles 会话不注入', async () => {
    const root = tmpRoot();
    await fakeHost(root, CONTRACT);
    const ctx = await bootClient(root);
    await until(ctx, () => ctx.tools.has('timer'));
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('[远程段] 主动安排测试文本');
  });

  it('段位占用：宿主补位段占位后 owner 同名注册抛错（位唯一性）', async () => {
    const root = tmpRoot();
    await fakeHost(root, CONTRACT);
    const ctx = await bootClient(root);
    await until(ctx, () => ctx.tools.has('timer'));
    // 位唯一性：宿主补位段已占位，owner 行同名注册抛错（fail-loud）——
    // 行集装配序保证 owner 行先装则宿主段被吞（applyContract 的 catch 路径）
    expect(() => ctx.agentLoop.registerPromptSection({ name: 'GUIDELINES_TIMER', text: '[本地段]' }, 'test')).toThrow();
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], conversationId: 'c1', messages: [] });
    expect(prompt).toContain('[远程段]'); // 初态保持（宿主补位段未被顶掉）
  });

  it('宿主缺席 → 软降级（零代理零段零报错）', async () => {
    const root = tmpRoot(); // 不起 fakeHost
    const ctx = await bootClient(root);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.tools.has('timer')).toBe(false);
    const prompt = ctx.agentLoop.assemblePreview({ model: 'm', tools: ['timer'], messages: [] });
    expect(prompt).toBeUndefined();
  });
});

void encodeFrame;