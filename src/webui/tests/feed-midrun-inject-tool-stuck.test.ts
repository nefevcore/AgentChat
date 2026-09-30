// ============================================================
// feed-midrun-inject-tool-stuck.test.ts —— run 中插入 event 行后
// 工具卡不永久转圈回归（cr-61）
//
// 背景 bug：run 中 step 工具执行期间，后台 job 完成通知（session/context-injected）
// push event 行进 rawMessages 尾部——此后该 step 的 tool 行不再位于消息末条。
// 工具完成（tool/after-execute）更新 tool 行 = 中段消息变化，
// buildTurnsIncremental 走 turnContentSig 前缀复用分支，而签名漏各 tool 的
// result/label 长度 → 复用过期 Turn（result 空 → isStreaming=true）——
// 工具卡内容空且永久转圈，直到收束重拉（after-run settlement）或刷新页面。
//
// 修复语义：turnContentSig 纳入各 tool 的 result/label 长度（对齐 msgSig
// 的 toolCallsSig 口径）——工具终值落进消息流后，所在轮签名随之变化，
// 前缀复用不再吞掉更新。
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ method: string; params: any; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) =>
      new Promise((resolve, reject) => { rpcCalls.push({ method, params, resolve, reject }); })),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));
vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';
const conv = A + '~user';

describe('run 中插入 event 行后工具卡不永久转圈（前缀复用须感知 tool result）', () => {
  let cores: SessionCores;
  beforeEach(() => {
    rpcCalls.length = 0;
    cores = createSessionCores(wireFace);
    cores.feed.init();
    cores.roster.activeAgentId.value = A;
  });

  it('中段 event 行插入后 after-execute 落 result：turns 视图即时拿到终值并停转', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 1, undefined, { runId: 'r1', stepId: 'r1:1', conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' } }, { toolCalls: [{ index: 0, id: 'call-1', name: 'pwsh', argumentsDelta: '{"command":"dir"}' }] }, { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' }]);
    feed.ingestFrame('llm/delta-end', [{ meta: { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' } }, { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' }]);
    // 建立 memo（工具占位转圈中的中间态派生）
    feed.getTurns(id).value;
    // 后台 job 完成通知：event 行 push 进尾部（tool 行自此不在末位）
    feed.ingestFrame('session/context-injected', [conv, A, { source: 'event', label: '任务 j-1 完成', injectionId: 'inj-1' }]);
    feed.getTurns(id).value;
    // 工具完成（中段消息变化）——修复前此处前缀复用返回过期 Turn
    feed.ingestFrame('tool/after-execute', [{ agentId: A, conversationId: conv, toolCallId: 'call-1', name: 'pwsh' }, { ok: true, output: '命令输出 ABC' }, undefined]);
    const turns = feed.getTurns(id).value;
    const toolMsgs = turns.flatMap((t: any) => t.steps.flatMap((s: any) => s.tools));
    expect(toolMsgs.map((m: any) => ({ c: (m.content || '').length, run: !!m.isStreaming })))
      .toEqual([{ c: '命令输出 ABC'.length, run: false }]);
  });

  it('对照组：无 event 插入（tool 行居末位）原本即正常——onlyLast 重建末轮', () => {
    const feed = cores.feed;
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, sender: 'user', source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 1, undefined, { runId: 'r1', stepId: 'r1:1', conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' } }, { toolCalls: [{ index: 0, id: 'call-1', name: 'pwsh', argumentsDelta: '{"command":"dir"}' }] }, { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' }]);
    feed.ingestFrame('llm/delta-end', [{ meta: { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' } }, { agent: A, conversationId: conv, runId: 'r1', stepId: 'r1:1' }]);
    feed.getTurns(id).value;
    feed.ingestFrame('tool/after-execute', [{ agentId: A, conversationId: conv, toolCallId: 'call-1', name: 'pwsh' }, { ok: true, output: '命令输出 ABC' }, undefined]);
    const turns = feed.getTurns(id).value;
    const toolMsgs = turns.flatMap((t: any) => t.steps.flatMap((s: any) => s.tools));
    expect(toolMsgs.map((m: any) => ({ c: (m.content || '').length, run: !!m.isStreaming })))
      .toEqual([{ c: '命令输出 ABC'.length, run: false }]);
  });
});