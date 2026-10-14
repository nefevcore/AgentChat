// ============================================================
// ac-session 落盘 lone surrogate 清洗回归（cr-415 防线2）：毒 content
//（孤立代理项）经事件通道入账 → write() 落盘前转义面清洗——盘上行
// 永不含 \udXXX 孤立转义（当年 appendJSONL 防线在插件化迁移中丢失）。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-lone-'));
}

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(sessionRow, { root });
  await fiber;
  for (let i = 0; i < 1000; i++) {
    if ((ctx as unknown as Record<string, unknown>).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  return { ctx, fiber };
}

describe('ac-session write() lone surrogate 落盘清洗（cr-415 防线2）', () => {
  it('毒 content 落盘后被清洗（盘上无孤立代理转义），回放读回 U+FFFD', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 毒数据：孤立高代理（模拟上游截断面失守产出）
    ctx.emit('router/message-received', 'a', { role: 'user', content: '前\uD83D后' }, 'a~user');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.session.flush('a~user');

    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const disk = fs.readFileSync(file, 'utf-8');
    expect(disk).not.toContain('\\ud83d');
    expect(disk).toContain('\\ufffd');

    const hist = await ctx.session.history('a~user', { viewer: 'a' });
    const target = hist.find((m: { content: string }) => m.content.includes('前'));
    expect(target?.content).toBe('前\uFFFD后');
  });

  it('合法 emoji（成对代理对）落盘原样保留', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.emit('router/message-received', 'a', { role: 'user', content: '完整😀emoji' }, 'a~user');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.session.flush('a~user');

    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const disk = fs.readFileSync(file, 'utf-8');
    // emoji 码点完整在盘（UTF-8 编码字面）——清洗只动孤立项，合法字符不受牵连
    expect(disk).toContain('😀');
    const hist = await ctx.session.history('a~user', { viewer: 'a' });
    const target = hist.find((m: { content: string }) => m.content.includes('完整'));
    expect(target?.content).toBe('完整😀emoji');
  });
});
