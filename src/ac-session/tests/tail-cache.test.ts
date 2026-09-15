// ============================================================
// ac-session：tail() 尾部摘要缓存 + 尾窗读取（2026-09-15 优化）回归
// ============================================================
// 契约（src/index.ts tailCache / TAIL_WINDOW_BYTES）：
//   1. 命中等价——文件未变时第二次 tail() 与第一次结果全等；
//   2. 写后失效——append 落新行（mtime+size 变化）后 tail() 返回新末条；
//   3. 外部直改失效——绕过服务追加（mtime 变化、size 也变）后读到新末条；
//   4. 重写失效——deleteMessage/compact 后 tail() 读到重写后的末条；
//   5. clear 后 undefined；
//   6. 部分行跳过——末行是 run 进行中的 partial 时，返回其前的末条完整行；
//   7. 尾窗正确性——大文件（> 窗口的场景由小窗间接验证：末条在文件尾）
//      tail() 不整读也能取到正确末条（窗内找不到时全读兜底）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-tail-'));
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

describe('tail() 尾部摘要', () => {
  it('文件未变：第二次调用结果全等（命中缓存）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    const first = ctx.session.tail('a~user');
    const second = ctx.session.tail('a~user');
    expect(second).toEqual(first);
    expect(first?.content).toBe('第二条');
  });

  it('写后失效：append 新行后 tail() 返回新末条', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect(ctx.session.tail('a~user')?.content).toBe('第一条');
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    expect(ctx.session.tail('a~user')?.content).toBe('第二条');
  });

  it('外部直改文件：mtime/size 变化后缓存失准重读', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect(ctx.session.tail('a~user')?.content).toBe('第一条');
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(file, `${JSON.stringify({ role: 'agent', content: '外部直写', agent_id: 'a', message_id: 'ext-1', timestamp: new Date().toISOString(), seq: 99 })}\n`, 'utf-8');
    expect(ctx.session.tail('a~user')?.content).toBe('外部直写');
  });

  it('deleteMessage 重写后：tail() 读到删除后文件的末条', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第二条' });
    const before = await ctx.session.records('a~user');
    expect(ctx.session.tail('a~user')?.content).toBe('第二条');
    await ctx.session.deleteMessage('a~user', before[1]!.message_id);
    expect(ctx.session.tail('a~user')?.content).toBe('第一条');
  });

  it('clear 后：tail() 返回 undefined', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '第一条' });
    expect(ctx.session.tail('a~user')?.content).toBe('第一条');
    ctx.session.clear('a~user');
    expect(ctx.session.tail('a~user')).toBeUndefined();
  });

  it('部分行跳过：末行是 partial 时返回其前的末条完整行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: '完整行' });
    // 绕过服务直接追加一条 partial 行（run 进行中的步级 checkpoint 形态）
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(file, `${JSON.stringify({ role: 'assistant', content: '进行中的中间步', partial: true, run: 'r1', message_id: 'p-1', timestamp: new Date().toISOString(), seq: 2 })}\n`, 'utf-8');
    expect(ctx.session.tail('a~user')?.content).toBe('完整行');
  });

  it('大文件：末条在文件尾时尾窗读取直接命中（不整读）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 直接构造大文件：头部灌 1MB 填充 + 末条真实记录
    const dir = path.join(root, 'sessions', 'a~user');
    fs.mkdirSync(dir, { recursive: true });
    const filler = JSON.stringify({ role: 'user', content: 'x'.repeat(2048), message_id: 'f', timestamp: '2026-09-15T00:00:00Z', seq: 1 });
    const lines: string[] = [];
    let size = 0;
    while (size < 1024 * 1024) {
      lines.push(filler);
      size += Buffer.byteLength(filler) + 1;
    }
    const last = JSON.stringify({ role: 'agent', content: '末条记录', agent_id: 'a', message_id: 'last-1', timestamp: '2026-09-15T00:01:00Z', seq: 999 });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${[...lines, last].join('\n')}\n`, 'utf-8');
    expect(ctx.session.tail('a~user')?.content).toBe('末条记录');
    // 缓存命中后仍正确
    expect(ctx.session.tail('a~user')?.content).toBe('末条记录');
  });

  it('并发双桶互不干扰：各自缓存条目独立', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'a', { role: 'user', content: 'A 桶' });
    await ctx.session.append('b~user', 'b', { role: 'user', content: 'B 桶' });
    expect(ctx.session.tail('a~user')?.content).toBe('A 桶');
    expect(ctx.session.tail('b~user')?.content).toBe('B 桶');
    await ctx.session.append('a~user', 'a', { role: 'user', content: 'A 桶第二条' });
    expect(ctx.session.tail('a~user')?.content).toBe('A 桶第二条');
    expect(ctx.session.tail('b~user')?.content).toBe('B 桶');
  });
});
