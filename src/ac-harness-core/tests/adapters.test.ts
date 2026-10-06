// ============================================================
// ac-harness-core —— 适配器归一单测（JSONL fixture，零真子进程）
// ============================================================
import { describe, it, expect } from 'vitest';
import { claudeCodeAdapter, codexAdapter } from '../src/adapters.ts';
import { parseJsonlLine } from '../src/events.ts';

describe('claude-code adapter', () => {
  it('init 行 → started（session_id/model）', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'opus' }))!;
    const r = claudeCodeAdapter.lineOutcome(o);
    expect(r).toEqual({ ok: true, event: { kind: 'started', runKey: 's-1', model: 'opus' } });
  });

  it('assistant text 块 → delta', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }))!;
    const r = claudeCodeAdapter.lineOutcome(o);
    expect(r).toEqual({ ok: true, event: { kind: 'delta', text: '你好' } });
  });

  it('assistant tool_use 块 → notice（优先于 text）', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: 'x' }] } }))!;
    const r = claudeCodeAdapter.lineOutcome(o);
    expect(r).toEqual({ ok: true, event: { kind: 'notice', label: '工具 Bash' } });
  });

  it('result 行 → terminal（is_error 分流 + usage 归一）', () => {
    const ok = parseJsonlLine(JSON.stringify({ type: 'result', result: '终稿', is_error: false, cost_usd: 0.02, num_turns: 3, duration_ms: 4500 }))!;
    expect(claudeCodeAdapter.lineOutcome(ok)).toEqual({
      ok: true,
      terminal: { finish: 'stop', text: '终稿', usage: { costUsd: 0.02, turns: 3, elapsedMs: 4500 } },
    });
    const err = parseJsonlLine(JSON.stringify({ type: 'result', result: '出错了', is_error: true }))!;
    expect(claudeCodeAdapter.lineOutcome(err).ok).toBe(true);
    expect((claudeCodeAdapter.lineOutcome(err) as any).terminal.finish).toBe('error');
  });

  it('未知/损坏行 → { ok:false }（丢弃计数面）', () => {
    expect(claudeCodeAdapter.lineOutcome(parseJsonlLine('not json') ?? {})).toEqual({ ok: false });
    expect(claudeCodeAdapter.lineOutcome({ type: 'stream_event' })).toEqual({ ok: false });
  });

  it('buildArgs：两档沙箱 + 模型 + prompt 不进 argv', () => {
    expect(claudeCodeAdapter.buildArgs({ prompt: 'p', cwd: '/w', sandbox: 'plan' })).toEqual(
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'],
    );
    expect(claudeCodeAdapter.buildArgs({ prompt: 'p', cwd: '/w', sandbox: 'workspace-write', model: 'sonnet' })).toEqual(
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--model', 'sonnet'],
    );
  });
});

describe('codex adapter', () => {
  it('thread.started → started（thread_id）', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-9' }))!;
    const r = codexAdapter.lineOutcome(o);
    expect(r).toEqual({ ok: true, event: { kind: 'started', runKey: 'th-9' } });
  });

  it('item.completed agent_message → delta；command_execution → notice', () => {
    const msg = parseJsonlLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', content: [{ type: 'output_text', text: '答复' }] } }))!;
    expect(codexAdapter.lineOutcome(msg)).toEqual({ ok: true, event: { kind: 'delta', text: '答复' } });
    const cmd = parseJsonlLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: '' } }))!;
    expect(codexAdapter.lineOutcome(cmd)).toEqual({ ok: true, event: { kind: 'notice', label: '命令 npm test' } });
  });

  it('turn.completed → terminal（token 口径直传）', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20, tokens_used: 30 } }))!;
    expect(codexAdapter.lineOutcome(o)).toEqual({
      ok: true,
      terminal: { finish: 'stop', text: '', usage: { prompt: 10, completion: 20, total: 30 } },
    });
  });

  it('turn.failed → terminal error', () => {
    const o = parseJsonlLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))!;
    expect((codexAdapter.lineOutcome(o) as any).terminal).toMatchObject({ finish: 'error' });
  });

  it('buildArgs：-C cwd + 两档 sandbox + -m 模型', () => {
    expect(codexAdapter.buildArgs({ prompt: 'p', cwd: '/w', sandbox: 'plan' })).toEqual(
      ['exec', '--json', '-C', '/w', '--sandbox', 'read-only'],
    );
    expect(codexAdapter.buildArgs({ prompt: 'p', cwd: '/w', sandbox: 'workspace-write', model: 'gpt-5.2' })).toEqual(
      ['exec', '--json', '-C', '/w', '--sandbox', 'workspace-write', '-m', 'gpt-5.2'],
    );
  });

  it('buildArgs：resumeKey 拼装（claude --resume / codex exec resume）', () => {
    expect(claudeCodeAdapter.buildArgs({ prompt: 'p', cwd: '/w', resumeKey: 's-1' }))
      .toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--resume', 's-1', '--permission-mode', 'acceptEdits']);
    expect(codexAdapter.buildArgs({ prompt: 'p', cwd: '/w', resumeKey: 'th-1' }))
      .toEqual(['exec', 'resume', 'th-1', '--json', '-C', '/w', '--sandbox', 'workspace-write']);
  });
});

describe('finalize 收敛', () => {
  it('非零退出且无终稿 → 错误形态带 stderr 尾', () => {
    const r = claudeCodeAdapter.finalize({ finish: 'stop', text: '', stats: { unknownEvents: 0 } }, 1, 'boom');
    expect(r.ok).toBe(false);
    expect(r.finish).toBe('error');
    expect(r.text).toContain('code=1');
    expect(r.text).toContain('boom');
  });

  it('零退出无终稿 → 空稿说明（不报错）', () => {
    const r = codexAdapter.finalize({ finish: 'stop', text: '', usage: undefined, stats: { unknownEvents: 2 } }, 0, '');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('无终稿输出');
    expect(r.stats?.unknownEvents).toBe(2);
  });
});