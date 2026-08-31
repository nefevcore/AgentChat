// ============================================================
// 轨迹回放开关（M21/D14，§2.5；2026-08-30 P2 收口）：布尔两态——
// false（缺省）= 对话级；true = viewer 自己的回复行 steps[] 全量展开
// （run 内消息序复现）。读取 = settingsOf 合成（全局默认层
// settings.session ∪ Agent 差异层）+ 存量 config 键双读过渡。
// 两态回放形状 golden 锁定；读取热生效。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as configRow from 'ac-config';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';
import * as sessionRow from '../src/index.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-replay-traj-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [toolsRow, agentsRow, configRow, routerRow, sessionRow];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, (configRow === (row as any) || sessionRow === (row as any)) ? { root } : undefined);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).config && (ctx as any).session) break;
    await sleep(1);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('轨迹回放开关（D14）', () => {
  it('两态 golden：缺省对话级 → 开启后 viewer 自己的行全量展开（run 内消息序）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '查一下' }, 'a~b', 'b', 'agent');
    ctx.emit('router/reply-completed', 'a', '查完了', {
      steps: [
        {
          index: 0,
          text: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{"file_path":"x.ts"}' }],
          toolResults: [{ ok: true, output: { content: 'hi' } }],
        },
        { index: 1, text: '查完了', toolCalls: [], toolResults: [] },
      ],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~b', 'b', 'agent');

    // 缺省 false：对话级（steps 不进回放）
    expect(await ctx.session.history('a~b', { viewer: 'a' })).toEqual([
      { role: 'user', content: '查一下', name: 'b' },
      { role: 'assistant', content: '查完了', name: 'a' },
    ]);

    // 开启（config 热生效——消费即读，无重启）
    ctx.config.set('session.replayTrajectory', true);
    expect(await ctx.session.history('a~b', { viewer: 'a' })).toEqual([
      { role: 'user', content: '查一下', name: 'b' },
      { role: 'assistant', content: '' , tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"x.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: { content: 'hi' } }) },
      { role: 'assistant', content: '查完了' },
    ]);

    // peer 视角不展开（轨迹是 viewer 自己的记忆；peer 行维持对话级 user）
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toEqual([
      { role: 'assistant', content: '查一下', name: 'b' },
      { role: 'user', content: '查完了', name: 'a' },
    ]);

    // 关回：形状复原（两态锁定；翻转 = 一次性显式 replace）
    ctx.config.set('session.replayTrajectory', false);
    expect(await ctx.session.history('a~b', { viewer: 'a' })).toHaveLength(2);
  });

  it('P2 收口：settingsOf 合成层（全局默认 ∪ Agent 差异）生效且优先于存量 config 键', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.agents.register({ id: 'b', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '查一下' }, 'a~b', 'b', 'agent');
    const steps = [
      {
        index: 0,
        text: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"file_path":"x.ts"}' }],
        toolResults: [{ ok: true, output: { content: 'hi' } }],
      },
      { index: 1, text: '查完了', toolCalls: [], toolResults: [] },
    ];
    ctx.emit('router/reply-completed', 'a', '查完了', {
      steps, finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~b', 'b', 'agent');
    ctx.emit('router/reply-completed', 'b', 'b 也答', {
      steps, finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~b', 'a', 'agent');

    // 基线：双端均对话级（user 行 + 两端回复各 1）
    expect(await ctx.session.history('a~b', { viewer: 'a' })).toHaveLength(3);
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(3);

    // Agent 差异层（a 开）：a 展开自己的轨迹（+2）；b 维持对话级
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: true } } });
    expect(await ctx.session.history('a~b', { viewer: 'a' })).toHaveLength(5);
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(3);

    // 全局默认层（settings.session）开启 → 未覆盖的 b 也展开
    ctx.config.set('settings', { session: { replayTrajectory: true } });
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(5);

    // 差异层 false 覆盖全局 true：b 回落对话级（settingsOf 差异层优先）
    ctx.agents.register({ id: 'b', model: 'none', settings: { session: { replayTrajectory: false } } });
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(3);

    // 新层显式 false 优先于存量 config 键 true（双读过渡不倒挂）
    ctx.config.set('session.replayTrajectory', true);
    ctx.config.set('settings', { session: { replayTrajectory: false } });
    ctx.agents.register({ id: 'b', model: 'none' }); // 摘掉差异层，让全局层裁决
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(3);

    // 新层未配置时回落存量键（存量部署不静默翻转）
    ctx.config.set('settings', {});
    expect(await ctx.session.history('a~b', { viewer: 'b' })).toHaveLength(5);
  });
});
