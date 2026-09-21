import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';

/**
 * 断网事故三修复回归（2026-09-20 复盘：断网错误收束 run 的轨迹被回放层
 * 丢弃 → 「继续会话失忆」，重启 + 手工删除后才恢复——本次修复点锁定）：
 *   ① records() 读失败 fail-loud（IO 瞬断不再静默按空会话回放）
 *   ② expandSteps 悬空 tool_calls 合成 tool 结果行（错误收束段行的轨迹
 *      可回放，openai 系 provider 不再因悬空调用拒单）
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-offline-accident-'));
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

/** 写一条错误收束形态的段行（run 键、非 partial、含悬空 result:null 调用） */
function writeErrorSegment(root: string, conv: string, run: string, toolCallId: string): string {
  const file = path.join(root, 'sessions', conv, 'messages.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date(0).toISOString() }),
    JSON.stringify({
      role: 'agent', content: '分析任务', agent_id: 'user',
      message_id: 'm1', timestamp: new Date(0).toISOString(), seq: 1,
    }),
    JSON.stringify({
      role: 'agent', content: '', agent_id: 'a',
      message_id: 'm2', timestamp: new Date(1).toISOString(), seq: 2,
      run,
      steps: [{
        content: '先看现场', reasoning: '断网前的推理', ts: 1,
        toolCalls: [{ id: toolCallId, name: 'grep', arguments: '{}', result: null }],
      }],
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
}

describe('ac-session 断网事故三修复（2026-09-20 复盘）', () => {
  it('① 主文件 IO 读失败 → history() 拒绝空回放（fail-loud 抛错，不静默失忆）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const file = writeErrorSegment(root, 'a~user', 'run-r1', 'call-1');
    // 悬空调用合成 tool 行（修复②）后形状 = user + assistant + tool = 3
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toHaveLength(3);

    // 模拟瞬时 IO 读失败（AV 短锁/盘满等）：把文件替换为同名目录——
    // existsSync 仍真、statSync 成功但 size 变（mtime/size 缓存门必失准）、
    // readFileSync 稳定抛 EISDIR（真实 IO 类错误，零 mock）。
    // 修复前：catch { return []; } 静默按空会话回放 → 整段历史从上下文消失。
    // 修复后：主文件读失败自然上抛（history 可见地失败，不喂空上下文给模型）。
    const original = fs.readFileSync(file, 'utf-8');
    fs.rmSync(file);
    fs.mkdirSync(file);
    try {
      await expect(ctx.session.history('a~user', { viewer: 'a' })).rejects.toThrow(/EISDIR|读取失败/);
    } finally {
      fs.rmSync(file, { recursive: true });
      fs.writeFileSync(file, original, 'utf-8');
    }
    // IO 恢复后回放完整（两轮验证缓存门不卡死）
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toHaveLength(3);
  });

  it('② 错误收束段行的悬空调用：expandSteps 合成 tool 结果行（无悬空 tool_calls）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeErrorSegment(root, 'a~user', 'run-r1', 'call-1');
    const rows = await ctx.session.history('a~user', { viewer: 'a' });
    expect(rows).toEqual([
      { role: 'user', content: '分析任务', name: 'user' },
      { role: 'assistant', content: '先看现场', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ ok: false, error: '（工具未完成：run 异常收束，结果不可用）' }) },
    ]);
  });

  it('②补行覆盖优先：悬空调用已有补行结果 → 回放用真实结果（占位不覆盖终值）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeErrorSegment(root, 'a~user', 'run-r1', 'call-1');
    await ctx.session.backfillToolResult('a~user', 'call-1', { ok: true, output: 'hits' });
    const rows = await ctx.session.history('a~user', { viewer: 'a' });
    const toolRow = rows.find((m) => m.role === 'tool');
    expect(toolRow).toMatchObject({ tool_call_id: 'call-1', content: JSON.stringify({ ok: true, output: 'hits' }) });
  });
});