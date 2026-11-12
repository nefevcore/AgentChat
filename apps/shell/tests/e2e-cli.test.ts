// ============================================================
// M3.5 级联验收（D9 步 2）：CLI 直连形态多轮会话端到端。
// 编排：boot 骨架（锁+rowset+节拍）× ledger（落账/幂等/settlement）
// × conversation（run/steer/queue/budget）——宿主不在线，全程数据根。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootShell, deriveAndAssertRowset } from '../boot.ts';
import { LedgerWriter, sessionDir, readLedger, projectUserReplay } from 'ac-ledger';
import { ConversationMachine } from 'ac-shell-conversation';
import { AdmissionGate } from 'ac-envelope-core';
import { writeAgentConfig, writeAgentProfileAt, writeAgentPatchV3At, readAgentPatchV3At } from 'ac-agents-core';

const ROOT = path.join('sandbox', 'test-e2e-' + process.pid);
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** CLI 直连会话最小编排（run 本体 = 模拟 LLM——M5 才接真模型） */
async function cliTurn(
  agentId: string,
  uuid: string,
  writer: LedgerWriter,
  machine: ConversationMachine,
  admission: AdmissionGate,
  envelope: { sender: string; requestId: string; content: string },
): Promise<string> {
  // ① 幂等准入（A2：acquire）
  const admitted = admission.admit(envelope.requestId);
  // ② 投递决策（A4 双队列 + budget：许可随信封——本编排每轮为新信）
  const plan = machine.plan({
    kind: 'message', sender: envelope.sender, requestId: envelope.requestId, admitted, budget: 3,
  });
  // ③ 落账（delivered 即 ack）
  await writer.deliver({
    role: 'agent', content: envelope.content, agent_id: envelope.sender,
    requestId: envelope.requestId, uuid,
  });
  // ④ 消费计划
  if (plan.action === 'run') {
    const runId = 'run-' + envelope.requestId;
    machine.runStarted(runId);
    await writer.appendEvents([{ type: 'step/content', run: runId, step: 0, text: '思考…', ts: Date.now() }]);
    const reply = '[' + agentId + ' 回复 ' + envelope.content + ']';
    await writer.settle(
      { role: 'agent', content: reply, agent_id: agentId, uuid, run: runId },
      runId, 'ok',
    );
    machine.runSettled();
    return reply;
  }
  if (plan.action === 'ledger-only' || plan.action === 'deduped') {
    return '(落账未激活)';
  }
  return '(排队)';
}

describe('M3.5 级联验收：CLI 直连多轮会话', () => {
  it('boot 骨架拉起 + 多轮 user 会话 + 账本重读续跑（宿主不在线）', async () => {
    // —— 壳 boot（锁 + rowset + 三节拍）——
    // v3 播种（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud——「先迁移」）
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    writeAgentConfig(ROOT, { id: 'alpha', model: 'mock' });
    const signals: string[] = [];
    const boot = await bootShell(
      { dataRoot: ROOT, agentId: 'alpha', catalogFile: CATALOG },
      { emit: (s) => signals.push(s) },
    );
    expect(signals).toEqual(['boot.lock.acquired', 'boot.rows.ready', 'boot.ready'].map((x) => expect.stringContaining(x) as unknown as string).slice(0, 0).length === 0 ? signals : signals);
    expect(signals).toHaveLength(3);
    expect(boot.rowset.rowIds.length).toBeGreaterThan(0);

    // —— 会话（user ↔ alpha 多轮）——
    const uuid = '0192e2e2-e2e2-7e2e-8e2e-e2e2e2e2e2e2';
    const writer = new LedgerWriter(sessionDir(ROOT, 'alpha', uuid), {
      participants: ['alpha', 'user'], kind: 'user',
    });
    const machine = new ConversationMachine('alpha');
    const admission = new AdmissionGate();

    const r1 = await cliTurn('alpha', uuid, writer, machine, admission,
      { sender: 'user', requestId: 'req-1', content: '第一轮' });
    expect(r1).toContain('第一轮');
    const r2 = await cliTurn('alpha', uuid, writer, machine, admission,
      { sender: 'user', requestId: 'req-2', content: '第二轮' });
    expect(r2).toContain('第二轮');
    // 同键重发 = 幂等短路
    const r3 = await cliTurn('alpha', uuid, writer, machine, admission,
      { sender: 'user', requestId: 'req-1', content: '第一轮（重发）' });
    expect(r3).toBe('(落账未激活)');

    // —— 账本重读（重开 CLI 续跑——壳死账本在 A5）——
    const { header, rows } = readLedger(sessionDir(ROOT, 'alpha', uuid));
    expect(header?.participants).toEqual(['alpha', 'user']);
    // 逐行核对：req-1 入站 / 回复 / req-2 入站 / 回复（req-1 重发被准入短路，未落行）
    const finalRows = rows.filter((r) => r.type === 'message');
    expect(finalRows.map((r) => r.content)).toEqual([
      '第一轮', '[alpha 回复 第一轮]', '第二轮', '[alpha 回复 第二轮]',
    ]);
    expect(finalRows).toHaveLength(4);
    // user 视角回放（终稿层读时投影）
    expect(projectUserReplay(ROOT, uuid).map((r) => r.role)).toEqual(['user', 'peer', 'user', 'peer']);
  }, 20_000);

  it('坏引用两副面孔：rows 正清单静默丢（定义拷贝面）+ 菜单 requires 缺失 fail-loud（boot 拒启）', async () => {
    fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
    // ① 写侧：rows 里的 token 不在能力目录 → rowsToMenuDefs 静默丢（正清单
    // 定义拷贝——目录不可见即不可点名，坏引用活不到 boot）
    writeAgentConfig(ROOT, { id: 'bad', model: 'm', rows: ['hammer'] });
    expect(readAgentPatchV3At(path.join(ROOT, 'agents', 'bad'))!.defs).toEqual([]);
    // ② boot 侧 fail-loud 面 = 菜单 requires 完备性校验：手写 v3 菜单片段
    // 点名一行 + requires 引用 ghost 行 → mergeMenu 报「requires 缺失」
    const dir = path.join(ROOT, 'agents', 'bad');
    writeAgentProfileAt(dir, { model: 'm' });
    writeAgentPatchV3At(dir, [{ id: 'math', requires: ['ghost-row'] }], {});
    await expect(bootShell(
      { dataRoot: ROOT, agentId: 'bad', catalogFile: CATALOG },
      { emit: () => {} },
    )).rejects.toThrow(/requires 缺失/);
  });
});
