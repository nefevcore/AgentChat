// ============================================================
// grep_history 截断 lone surrogate 事故回归（cr-415）：2026-08-05 DeepSeek
// 400 事故（9c6f8fdf 三防线）在插件化迁移中全部丢失——109010c6 批次把
// grep_history 截断回退成裸 slice(0,500)，截断点落在代理对中间产生 lone
// surrogate → 工具结果落盘污染会话历史 → 后续 LLM 请求 400。本测试锁
// 复活后的安全截断行为（safeClipByTokens，cr-415）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as queryRow from '../src/index.ts';

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sq-lone-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [sessionRow, { root }],
    [queryRow, undefined],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).session) break;
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

/** lone surrogate 检测（与生产正则同形） */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('grep_history 截断 lone surrogate 回归（cr-415）', () => {
  it('超长消息截断不产生 lone surrogate（原 bug：截断点落在 emoji 代理对中间）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 构造超预算消息（1000 ASCII = 300 tokens > 166 预算，必触发截断），
    // emoji 混在正文里——任何按 code unit 的截断点都可能落在代理对中间
    const bomb = ('a'.repeat(300) + '😀' + 'b'.repeat(300) + '😀' + 'c'.repeat(400));
    ctx.emit('router/message-received', 'a', { role: 'user', content: bomb }, 'a');
    await new Promise((r) => setTimeout(r, 150));

    const g = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: 'a', limit: 1 },
      conversationId: 'a',
    });
    expect(g.ok).toBe(true);
    const clipped = g.output.matches[0].content;
    expect(hasLoneSurrogate(clipped)).toBe(false);
    expect(clipped.endsWith('…(truncated)')).toBe(true);
  });

  it('预算内消息原样返回（截断未触发——全文含完整 emoji）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.emit('router/message-received', 'a', { role: 'user', content: '短消息😀' }, 'a');
    await new Promise((r) => setTimeout(r, 150));

    const g = await exec(ctx, {
      name: 'grep_history',
      args: { pattern: '短' },
      conversationId: 'a',
    });
    expect(g.ok).toBe(true);
    expect(g.output.matches.some((m: { content: string }) => m.content === '短消息😀')).toBe(true);
    expect(g.output.matches.every((m: { content: string }) => hasLoneSurrogate(m.content) === false)).toBe(true);
  });
});
