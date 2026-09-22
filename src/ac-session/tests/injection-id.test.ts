// ============================================================
// injection-id.test.ts —— 注入身份键全链贯通（重复 context 行根修）
//
// 背景（2026-12 前端反馈：load_skill 后切换会话再返回，出现两条
// 「已加载技能」context 行）：同一份注入事实的三种形态（事件帧直播行/
// journal 活投影行/settlement 提升行）id 互不相干——journal 行无 id、
// 提升行新铸，前端去重无从下手。修复 = recordContext 单点铸造
// injectionId（ctx- 前缀），四形态共享：
//   ① session/context-injected 事件帧 meta.injectionId
//   ② JournalInjectLine.injectionId（journal 落行）
//   ③ records() 活投影行 message_id = injectionId
//   ④ settlement 提升行 message_id = injectionId（不再新铸）
// 本文件钉住 ①③ 同锚 + ④ 收束后不新铸 + 事件通知（source=event）
// 直落路径同款贯通（② 经 ③ 读出验证）。
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-iid-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [agentsRow, sessionRow] as any[]) {
    const fiber = ctx.plugin(row, { root });
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).agents && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
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

const SKILL_BODY = '<skill_content name="demo">正文</skill_content>';
const runStarted = (conv: string) =>
  ctx0.emit('loop/run-started', { agent: 'alpha', conversationId: conv, sender: 'user', source: 'user' } as never);
const stepAt = (conv: string, i: number, text: string) =>
  ctx0.emit('loop/after-step', 'alpha', { index: i, text, reasoning: '', toolCalls: [], toolResults: [], ts: Date.now() } as never, { conversationId: conv, sender: 'user' });

let ctx0: Context; // describe 内逐 it 赋值（boot 返回）

describe('注入身份键 injectionId 全链贯通', () => {
  it('run 活跃：事件帧 id = journal 活投影行 message_id（ctx- 前缀）', async () => {
    const root = tmpRoot();
    const booted0 = await boot(root);
    ctx0 = booted0.ctx;
    ctx0.agents.register({ id: 'alpha', model: 'none' });
    const conv = 'alpha~user';

    // 捕获事件帧载荷（修复 ①）
    let frameMeta: { injectionId?: string } | undefined;
    ctx0.on('session/context-injected', (_cid: string, _aid: string, meta: any) => { frameMeta = meta; });

    runStarted(conv);
    await new Promise((r) => setTimeout(r, 10));
    stepAt(conv, 0, 's1');
    await new Promise((r) => setTimeout(r, 15));

    // recordContext（run 活跃 → journal 路径）：返回值即 injectionId
    const ret = (ctx0.session as any).recordContext(conv, 'alpha', SKILL_BODY, { source: 'skill', label: '已加载技能 demo' });
    await new Promise((r) => setTimeout(r, 50));

    // ① 事件帧携带 + ②→③ 活投影行同锚
    expect(frameMeta?.injectionId, '事件帧缺 injectionId').toBeDefined();
    expect(ret).toBe(frameMeta!.injectionId);
    expect(String(ret).startsWith('ctx-'), '注入 id 须 ctx- 前缀').toBe(true);
    const records = await ctx0.session.records(conv);
    const ctxRow = records.find((r: any) => r.role === 'context' && r.source === 'skill');
    expect(ctxRow, '活投影缺 context 行').toBeDefined();
    expect((ctxRow as any).message_id, '活投影行 message_id ≠ injectionId（刷新行与直播行不同锚）').toBe(ret);
  });

  it('run 收束：settlement 提升行复用注入 id（不新铸）', async () => {
    const root = tmpRoot();
    const booted0 = await boot(root);
    ctx0 = booted0.ctx;
    ctx0.agents.register({ id: 'alpha', model: 'none' });
    const conv = 'alpha~user';

    runStarted(conv);
    await new Promise((r) => setTimeout(r, 10));
    stepAt(conv, 0, 's1');
    await new Promise((r) => setTimeout(r, 15));
    const ret = (ctx0.session as any).recordContext(conv, 'alpha', SKILL_BODY, { source: 'skill', label: '已加载技能 demo' });
    await new Promise((r) => setTimeout(r, 15));
    stepAt(conv, 1, 's2');
    await new Promise((r) => setTimeout(r, 15));

    // 收束（settlement 提升批 + journal 剔除）
    ctx0.emit('router/reply-completed', 'alpha', '终稿', { steps: [], text: '终稿', finish: 'stop', usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } } as never, conv, 'user', 'user');
    await new Promise((r) => setTimeout(r, 100));

    // ④ 提升行 message_id = injectionId（此前新铸 msg-——重复行根因）
    const records = await ctx0.session.records(conv);
    const ctxRow = records.find((r: any) => r.role === 'context' && r.source === 'skill');
    expect(ctxRow, '提升行缺 context 行').toBeDefined();
    expect((ctxRow as any).message_id, '提升行 message_id ≠ injectionId（新铸 = 刷新行与直播行不同锚）').toBe(ret);
  });

  it('事件通知直落（message-received source=event）：行 id = 事件帧 id', async () => {
    const root = tmpRoot();
    const booted0 = await boot(root);
    ctx0 = booted0.ctx;
    ctx0.agents.register({ id: 'alpha', model: 'none' });
    const conv = 'alpha~user';

    let frameMeta: { injectionId?: string; label?: string } | undefined;
    ctx0.on('session/context-injected', (_cid: string, _aid: string, meta: any) => { frameMeta = meta; });

    // 会话空闲的机制通知（job 完成回投路径）——通知面统一后由 session 补发
    ctx0.emit('router/message-received', 'alpha', { role: 'user', content: '[系统通知] 后台任务完成' }, conv, 'alpha', 'event');
    await new Promise((r) => setTimeout(r, 50));

    expect(frameMeta, '事件通知未补发 context-injected 帧').toBeDefined();
    expect(typeof frameMeta!.injectionId === 'string' && frameMeta!.injectionId.startsWith('ctx-')).toBe(true);
    expect(frameMeta!.label, '帧 label = 通知正文（前端直出）').toBe('[系统通知] 后台任务完成');
    const records = await ctx0.session.records(conv);
    const evRow = records.find((r: any) => r.role === 'context' && r.source === 'event');
    expect(evRow, '事件通知行缺').toBeDefined();
    expect((evRow as any).message_id, '事件行 message_id ≠ 帧 injectionId').toBe(frameMeta!.injectionId);
  });
});
