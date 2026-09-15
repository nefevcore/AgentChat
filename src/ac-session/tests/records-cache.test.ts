// ============================================================
// ac-session：records() 解析缓存（mtime/size 门）行为回归
// ============================================================
// 缓存契约（src/index.ts recordsCache）：
//   1. 命中等价——文件未变时第二次 records() 与第一次结果全等，
//      且不重读文件（mtime/size 门内的 stat 兜底）；
//   2. 写后失效——append 落新行（mtime+size 变化）后读到新内容；
//   3. 外部修改失效——绕过服务直改文件（等 mtime 分辨率间隔后同 size
//      追加）也能读到新内容（mtime 门兜底，非仅依赖主动失效点）；
//   4. deleteMessage/compact 重写后读到重写结果（rewriteMessages 主动失效）；
//   5. clear 后回空会话。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-cache-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const fiber = ctx.plugin(sessionRow as any, { root });
  await fiber;
  fibers.push(fiber);
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).session) break;
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

describe('records() 解析缓存', () => {
  it('文件未变：第二次调用结果全等（命中缓存）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    const first = await ctx.session.records('a~user');
    const second = await ctx.session.records('a~user');
    expect(second).toEqual(first);
    expect(second.map((r: { content: string }) => r.content)).toEqual(['第一条', '第二条']);
  });

  it('写后失效：append 新行后 records() 读到新内容', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect((await ctx.session.records('a~user')).length).toBe(1);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    const after = await ctx.session.records('a~user');
    expect(after.length).toBe(2);
    expect(after[1]!.content).toBe('第二条');
  });

  it('外部直改文件：mtime 变化后缓存失准重读（不依赖主动失效点）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect((await ctx.session.records('a~user')).length).toBe(1);
    // 绕过服务直写文件（模拟外部工具编辑）——sleep 跨 mtime 分辨率
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(file, `${JSON.stringify({ role: 'agent', content: '外部直写', agent_id: 'a', message_id: 'ext-1', timestamp: new Date().toISOString(), seq: 99 })}\n`, 'utf-8');
    const after = await ctx.session.records('a~user');
    expect(after.length).toBe(2);
    expect(after[1]!.content).toBe('外部直写');
  });

  it('deleteMessage 重写后：读到删除后的记录集', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    const before = await ctx.session.records('a~user');
    expect(before.length).toBe(2);
    expect(await ctx.session.deleteMessage('a~user', before[0]!.message_id)).toBe(true);
    const after = await ctx.session.records('a~user');
    expect(after.length).toBe(1);
    expect(after[0]!.content).toBe('第二条');
  });

  it('compact 重写后：读到 keep 集', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '旧消息' });
    await ctx.session.append('a~user', 'a', { role: 'user', content: '新消息' });
    const before = await ctx.session.records('a~user');
    const keep = before.slice(-1);
    await ctx.session.compact('a~user', { summary: '此前讨论了 X', keep, baselineSeq: 2 });
    const after = await ctx.session.records('a~user');
    expect(after.map((r: { content: string }) => r.content)).toEqual(['新消息']);
  });

  it('clear 后：records() 回空会话', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect((await ctx.session.records('a~user')).length).toBe(1);
    ctx.session.clear('a~user');
    expect(await ctx.session.records('a~user')).toEqual([]);
  });

  it('并发双桶互不干扰：各自缓存条目独立', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: 'A 桶' });
    await ctx.session.append('b~user', 'b', { role: 'user', content: 'B 桶' });
    // 预热两桶缓存
    await ctx.session.records('a~user');
    await ctx.session.records('b~user');
    // 只写 A 桶
    await ctx.session.append('a~user', 'a', { role: 'user', content: 'A 桶第二条' });
    expect((await ctx.session.records('a~user')).length).toBe(2);
    // B 桶不受影响
    expect((await ctx.session.records('b~user')).map((r: { content: string }) => r.content)).toEqual(['B 桶']);
  });
});
