// ============================================================
// subagent-history-steps-dedup.test.ts —— 子会话回放 step 重复回归锁
//
// 事故形态：前端回放 subagent 会话每个 step 重复 N 次（实测 5 次）。
// 根因：subagents/history 对账本每条带 run 键的 agent 行都挂
// stepsOfLedger/stepsOfRun 的**整 run 全量** steps——而收束 run 在账本是
// 多行形态（段行×N + 注入行 + 终稿行），全量步行重复投 N 遍。
// 修复：steps 按 run 单锚挂载；段行折叠、注入行投 context 注入卡。
// ============================================================
import { describe, it, expect } from 'vitest';
import type { Context } from '@agentchat/cordis';
import * as fs from 'node:fs';
import { registerShellFace } from '../src/face-shell.ts';

type Handler = (params: unknown) => unknown;
function collect() {
  const handlers = new Map<string, Handler>();
  return { web: { registerRpc: (m: string, h: Handler) => { handlers.set(m, h); } }, handlers };
}
const ctx = { get: () => undefined } as unknown as Context;

describe('subagents/history steps 按 run 单锚（step 重复回归）', () => {
  it('注入边界多段行形态：全量 steps 只投一次，注入行进 context 卡，终稿行不重挂', async () => {
    const rootDir = 'sandbox/test-sub-dedup-' + process.pid;
    const sessDir = rootDir + '/agents/parent1/children/kid1/sessions/c1';
    fs.mkdirSync(sessDir + '/journal', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/parent1/children/kid1/config.json', JSON.stringify({ id: 'kid1' }), 'utf-8');
    // 已收束 run 的账本真形态：段行 + 注入行 + 段行 + 终稿行（settlement 物化产物）
    fs.writeFileSync(sessDir + '/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1, participants: ['kid1', 'parent1'] }),
      JSON.stringify({ role: 'agent', agent_id: 'parent1', content: '任务' }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'kid1', run: 'run-1', source: 'segment', message_id: 'seg-run-1-0', timestamp: '2026-02-08T10:00:00Z', seq: 2, steps: [{ content: 'step A', ts: 1 }] }),
      JSON.stringify({ role: 'agent', content: '注入', agent_id: 'kid1', run: 'run-1', source: 'inject', injectSource: 'skill', message_id: 'inj-1', timestamp: '2026-02-08T10:00:01Z', seq: 3 }),
      JSON.stringify({ role: 'agent', content: '', agent_id: 'kid1', run: 'run-1', source: 'segment', message_id: 'seg-run-1-2', timestamp: '2026-02-08T10:00:02Z', seq: 4, steps: [{ content: 'step B', ts: 2 }] }),
      JSON.stringify({ role: 'agent', content: '终稿', agent_id: 'kid1', run: 'run-1', message_id: 'm1', timestamp: '2026-02-08T10:00:03Z', seq: 5 }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null });
      const out = await handlers.get('subagents/history')!({ id: 'kid1' }) as {
        total: number;
        records: Array<{ role: string; content: string; run?: string; steps?: Array<{ content: string }> }>;
      };
      // steps 只出现一份（run 全量），且步内容不丢（跨段拼接）
      const stepped = out.records.filter((r) => r.steps !== undefined);
      expect(stepped).toHaveLength(1);
      expect(stepped[0]!.steps!.map((s) => s.content)).toEqual(['step A', 'step B']);
      // 注入行进 context 注入卡（对齐主投影 assembleSessionView 语义）
      const inj = out.records.find((r) => r.role === 'context');
      expect(inj).toMatchObject({ content: '注入' });
      // 终稿行仍在（无 steps 重复挂载）
      expect(out.records.find((r) => r.content === '终稿')).toMatchObject({ role: 'assistant', run: 'run-1' });
      // cr-1132 起 fold 单源（主投影语义）：steps 并入终稿行（一非二）
      expect(out.total).toBe(3); // 任务行 + 注入卡 + 终稿行(带 steps)
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('纯终稿 run（无段行）：终稿行作锚挂 steps（原路径不回归）', async () => {
    const rootDir = 'sandbox/test-sub-dedup2-' + process.pid;
    const sessDir = rootDir + '/agents/parent1/children/kid1/sessions/c1';
    fs.mkdirSync(sessDir + '/journal', { recursive: true });
    fs.writeFileSync(rootDir + '/agents/parent1/children/kid1/config.json', JSON.stringify({ id: 'kid1' }), 'utf-8');
    fs.writeFileSync(sessDir + '/messages.jsonl', [
      JSON.stringify({ type: 'session-header', version: 1, participants: ['kid1', 'parent1'] }),
      JSON.stringify({ role: 'agent', agent_id: 'kid1', content: '终稿', run: 'run-2', message_id: 'm2', timestamp: '2026-02-08T10:00:03Z', seq: 2 }),
    ].join('\n') + '\n', 'utf-8');
    // journal 里步行已被收束剔除（settled 行保留）——stepsOfRun 由此判收束态
    fs.writeFileSync(sessDir + '/journal/partials.jsonl', [
      JSON.stringify({ type: 'journal-step', run: 'run-2', step: 1, content: 'step X', ts: 1 }),
      JSON.stringify({ type: 'journal-settled', run: 'run-2', finish: 'ok', seq: 2 }),
    ].join('\n') + '\n', 'utf-8');
    try {
      const { web, handlers } = collect();
      registerShellFace(web, ctx, { dataRoot: rootDir, port: () => null });
      const out = await handlers.get('subagents/history')!({ id: 'kid1' }) as {
        records: Array<{ role: string; content: string; run?: string; steps?: Array<{ content: string }>; partial?: boolean }>; 
      };
      const stepped = out.records.filter((r) => r.steps !== undefined);
      expect(stepped).toHaveLength(1);
      expect(stepped[0]).toMatchObject({ role: 'assistant', content: '终稿', run: 'run-2' });
      expect(stepped[0]!.steps!.map((s) => s.content)).toEqual(['step X']);
      expect(stepped[0]!.partial).toBeUndefined(); // journal 有 settled → 非在途
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});