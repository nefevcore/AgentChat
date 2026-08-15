// ============================================================
// src/services/archive-service 单元测试 —— 归档编排（L4）
// 覆盖：requestArchive 写 pending + 触发整理轮 / archiveAllActiveSessions 批量 /
//       scanPendingArchives 超时清理 / handleRunEnd 整理轮完成 / archiveAndRebuild
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService, ARCHIVE_REVIEW_PREFIX } from '../src/index';
import { chatDialogKey } from '@agentchat/agents';
import type { AgentRegistry } from '@agentchat/agents';
import type { CurrentContext } from '@agentchat/agent-loop';
import type { RunResult } from '@agentchat/agent-loop';
import { META_ARCHIVE_REVIEW } from '@agentchat/toolkit';

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 写入 1:1 会话文件（新架构：sessions/chat~<lo>~<hi>/messages.jsonl） */
function writeSession(wsRoot: string, from: string, to: string, msgs: any[]): void {
  const dir = path.join(wsRoot, 'sessions', chatDialogKey(from, to));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 伪造 registry（isVirtual / get） */
function fakeRegistry(agents: Record<string, any> = {}): AgentRegistry {
  return {
    get: (id: string) => (agents[id] ? { agent_id: id, ...agents[id] } : undefined) as any,
    isVirtual: (id: string) => agents[id]?.virtual === true,
  } as unknown as AgentRegistry;
}/** 构造最小 ctx（整理轮） */
function reviewCtx(agentId: string, counterpart: string, history: any[]): CurrentContext {
  return {
    agentId,
    dialogId: chatDialogKey(agentId, counterpart),
    history,
    meta: { [META_ARCHIVE_REVIEW]: true },
  } as unknown as CurrentContext;
}

/** 构造最小 runResult */
function runResult(messages: any[], usage?: any): RunResult {
  return { content: '', interrupted: false, messages, usage } as unknown as RunResult;
}

describe('ArchiveService.requestArchive', () => {
  it('写 .archive_pending（含参与者）并触发双方整理轮', async () => {
    const triggered: any[] = [];
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async (id: string, opts?: any) => { triggered.push({ id, opts }); return ''; } } as any,
      registry: fakeRegistry({ user: { virtual: true } }),
    });

    svc.requestArchive('agentA', 'agentB');

    const pendingPath = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'), '.archive_pending');
    expect(fs.existsSync(pendingPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    expect(pending.participants).toEqual(['agentA', 'agentB']);

    // 触发双方整理轮（setTimeout 300ms 延迟）
    await new Promise((r) => setTimeout(r, 400));
    expect(triggered.length).toBe(2);
    for (const t of triggered) {
      expect(t.opts.source).toBe('archive-review');
      expect(t.opts.meta?.[META_ARCHIVE_REVIEW]).toBe(true);
      expect(t.opts.hint.startsWith(ARCHIVE_REVIEW_PREFIX)).toBe(true);
    }
    const ids = triggered.map((t) => t.id).sort();
    expect(ids).toEqual(['agentA', 'agentB']);
  });

  it('幂等：已有 pending 不重复触发', async () => {
    const triggered: any[] = [];
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async (id: string, opts?: any) => { triggered.push(id); return ''; } } as any,
    });
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.archive_pending'), '{}', 'utf-8');

    svc.requestArchive('agentA', 'agentB');
    await new Promise((r) => setTimeout(r, 400));
    expect(triggered.length).toBe(0);
  });

  it('虚拟 counterpart：仅触发 agent 侧整理轮', async () => {
    const triggered: any[] = [];
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async (id: string) => { triggered.push(id); return ''; } } as any,
      registry: fakeRegistry({ user: { virtual: true } }),
    });

    svc.requestArchive('agentA', 'user');
    await new Promise((r) => setTimeout(r, 400));
    expect(triggered).toEqual(['agentA']);
  });
});

describe('ArchiveService.archiveAllActiveSessions', () => {
  it('批量触发所有活跃 1:1 会话（跳过空/自对话/群聊/已有 pending）', async () => {
    const triggered: any[] = [];
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async (id: string) => { triggered.push(id); return ''; } } as any,
      registry: fakeRegistry({
        agentA: { 'agent.session': { maxContextTokens: 100, archiveTokenRatio: 0.5 } }, // 阈值 50 tokens
      }),
    });

    // 活跃会话（单条大消息估算 60 tokens > 阈值 50，达标触发归档）
    writeSession(tmp, 'user', 'agentA', [{ role: 'agent', content: 'x'.repeat(200), agent_id: 'user' }]);
    writeSession(tmp, 'agentA', 'agentB', [{ role: 'agent', content: 'y'.repeat(200), agent_id: 'agentA' }]);
    // 空会话（跳过）
    fs.mkdirSync(path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentC')), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentC'), 'messages.jsonl'), '', 'utf-8');
    // 自对话（跳过）
    writeSession(tmp, 'agentA', 'agentA', [{ role: 'agent', content: 'z', agent_id: 'agentA' }]);
    // 群聊（跳过）
    fs.mkdirSync(path.join(tmp, 'sessions', 'group~g1'), { recursive: true });

    const result = svc.archiveAllActiveSessions();

    const notSkipped = result.filter((r) => !r.skipped);
    expect(notSkipped.length).toBe(2);
    const keys = notSkipped.map((r) => chatDialogKey(r.agent, r.counterpart)).sort();
    expect(keys).toEqual([chatDialogKey('agentA', 'agentB'), chatDialogKey('agentA', 'user')].sort());
  });
});

describe('ArchiveService.scanPendingArchives', () => {
  it('超时 pending → 强制 idleArchive（移入 archive + 保留尾部）', async () => {
    const svc = new ArchiveService({ wsRoot: tmp, router: { trigger: async () => '' } as any });
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    fs.mkdirSync(dir, { recursive: true });
    writeSession(tmp, 'agentA', 'agentB', [
      { role: 'agent', content: 'm1', agent_id: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'agent', content: 'm2', agent_id: 'agentA', timestamp: '2026-01-01T00:00:01.000Z' },
      { role: 'agent', content: 'm3', agent_id: 'user', timestamp: '2026-01-01T00:00:02.000Z' },
      { role: 'agent', content: 'm4', agent_id: 'agentA', timestamp: '2026-01-01T00:00:03.000Z' },
    ]);
    fs.writeFileSync(path.join(dir, '.archive_pending'), JSON.stringify({
      agent: 'agentA', counterpart: 'agentB',
      participants: ['agentA', 'agentB'],
      requestedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    }), 'utf-8');

    const handled = await svc.scanPendingArchives();
    expect(handled).toBe(1);
    // pending 已清理
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(false);
    // 消息移入 archive/history_1.jsonl
    const arch = readJsonl(path.join(dir, 'archive', 'history_1.jsonl'));
    expect(arch.length).toBe(4);
    // 重建 messages.jsonl 保留尾部（预算 1000000*0.03=30000，全部保留）
    const rebuilt = readJsonl(path.join(dir, 'messages.jsonl'));
    expect(rebuilt.length).toBe(4);
    // 超时降级（pending-timeout）：记忆不整理（审查标记机制已移除，会话内可 query_history 回忆）
    expect(fs.existsSync(path.join(tmp, 'files', 'agentA', 'memory', 'agentB.memory_review_needed'))).toBe(false);
  });

  it('未超时 pending → 跳过（可能是进行中），不清理不强制归档', async () => {
    const svc = new ArchiveService({ wsRoot: tmp, router: { trigger: async () => '' } as any });
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    fs.mkdirSync(dir, { recursive: true });
    writeSession(tmp, 'agentA', 'agentB', [{ role: 'agent', content: 'm', agent_id: 'user' }]);
    fs.writeFileSync(path.join(dir, '.archive_pending'), JSON.stringify({
      agent: 'agentA', counterpart: 'agentB',
      participants: ['agentA', 'agentB'],
      requestedAt: new Date().toISOString(),
    }), 'utf-8');

    const handled = await svc.scanPendingArchives();
    expect(handled).toBe(0); // 未超时跳过（不误清理进行中的归档）
    // pending 保留（整理轮串行化等待中不能被扫描打断）
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(true);
    // messages.jsonl 未动（不强制归档）
    expect(readJsonl(path.join(dir, 'messages.jsonl')).length).toBe(1);
  });
});

describe('ArchiveService.handleRunEnd', () => {
  it('整理轮（archiveReview=true）：写 done + 全部完成 → archiveAndRebuild', async () => {
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async () => '' } as any,
      registry: fakeRegistry({
        agentA: { name: 'AgentA', 'agent.session': { maxContextTokens: 10000, keepRecentRatio: 0.05, archiveTokenRatio: 0.7 } },
      }),
    });
    // 构造足够大的消息使截断生效（归档区间非空）：20 条 × 每条 200 字符 ≈ 1200 tokens > 500 预算
    const bigHistory: any[] = [];
    for (let i = 0; i < 20; i++) {
      bigHistory.push({
        role: 'agent',
        content: `m${i} ` + 'x'.repeat(200),
        agent_id: i % 2 ? 'agentA' : 'user',
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        message_id: String(i),
      });
    }
    // 会话文件：完整历史（整理轮不落盘，磁盘仍是归档前状态）
    writeSession(tmp, 'agentA', 'agentB', bigHistory);
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    // 模拟 requestArchive 已写 pending（参与者双方）
    fs.writeFileSync(path.join(dir, '.archive_pending'), JSON.stringify({
      agent: 'agentA', counterpart: 'agentB',
      participants: ['agentA', 'agentB'],
      requestedAt: new Date().toISOString(),
    }), 'utf-8');
    // 对方已整理完成（写 done）
    fs.writeFileSync(path.join(dir, '.archive_done_agentB'), '', 'utf-8');

    // ctx.history = 磁盘完整历史（整理轮 loadHistory 读到）
    const ctx = reviewCtx('agentA', 'agentB', readJsonl(path.join(dir, 'messages.jsonl')));
    await svc.handleRunEnd(ctx, runResult([{ role: 'assistant', content: 'review' }]));

    // 全部完成 → 归档执行 → finally 清理 pending 与 done 标记
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.archive_done_agentA'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.archive_done_agentB'))).toBe(false);
    // 归档已生成 history_1.jsonl（被截断的早期消息）
    const arch = readJsonl(path.join(dir, 'archive', 'history_1.jsonl'));
    expect(arch.length).toBeGreaterThan(0);
    expect(arch[0].content.startsWith('m0 ')).toBe(true);
    // 成功归档（整理轮完成）：不写审查标记（审查标记机制已移除）
    expect(fs.existsSync(path.join(tmp, 'files', 'agentA', 'memory', 'agentB.memory_review_needed'))).toBe(false);
  });

  it('整理轮未全部完成：仅写 done，不归档', async () => {
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async () => '' } as any,
      registry: fakeRegistry({}),
    });
    writeSession(tmp, 'agentA', 'agentB', [{ role: 'agent', content: 'm1', agent_id: 'user' }]);
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    fs.writeFileSync(path.join(dir, '.archive_pending'), JSON.stringify({
      agent: 'agentA', counterpart: 'agentB',
      participants: ['agentA', 'agentB'],
      requestedAt: new Date().toISOString(),
    }), 'utf-8');

    const ctx = reviewCtx('agentA', 'agentB', readJsonl(path.join(dir, 'messages.jsonl')));
    await svc.handleRunEnd(ctx, runResult([]));

    expect(fs.existsSync(path.join(dir, '.archive_done_agentA'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive'))).toBe(false); // 未归档
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(true); // pending 保留
  });

  it('超阈值（非整理轮）：触发 requestArchive（写 pending）', async () => {
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async () => '' } as any,
      registry: fakeRegistry({
        agentA: { 'agent.session': { maxContextTokens: 1000, archiveTokenRatio: 0.5 } }, // 阈值 500 tokens
      }),
    });
    writeSession(tmp, 'agentA', 'agentB', [{ role: 'agent', content: 'm1', agent_id: 'user' }]);
    const ctx = {
      agentId: 'agentA',
      dialogId: chatDialogKey('agentA', 'agentB'),
      history: [],
    } as unknown as CurrentContext;

    // 超阈值：触发依据 = 会话消息估算（ctx.history + result.messages），而非 usage.total_tokens
    // （usage 含系统提示固定开销会频繁误触发；估算 > maxContextTokens*archiveTokenRatio = 500）
    const bigMsgs = Array.from({ length: 20 }, (_, i) => ({
      role: 'agent' as const,
      content: `m${i} ` + 'x'.repeat(200), // 约 61 tokens/条，20 条 ≈ 1220 > 500
      agent_id: i % 2 ? 'agentA' : 'user',
    }));
    const result = runResult(bigMsgs);
    await svc.handleRunEnd(ctx, result);

    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(true);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, '.archive_pending'), 'utf-8'));
    expect(pending.agent).toBe('agentA');
    expect(pending.counterpart).toBe('agentB');
  });

  it('未超阈值：不触发归档', async () => {
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async () => '' } as any,
      registry: fakeRegistry({}),
    });
    writeSession(tmp, 'agentA', 'agentB', [{ role: 'agent', content: 'm1', agent_id: 'user' }]);
    const ctx = {
      agentId: 'agentA',
      dialogId: chatDialogKey('agentA', 'agentB'),
      history: [],
    } as unknown as CurrentContext;

    await svc.handleRunEnd(ctx, runResult([], { total_tokens: 100 }));
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));
    expect(fs.existsSync(path.join(dir, '.archive_pending'))).toBe(false);
  });
});

describe('ArchiveService.archiveAndRebuild 二次归档去重', () => {
  it('已有归档时仅归档新增部分（去重上次归档最后一条）', async () => {
    // 通过 registry 提供小 maxContextTokens，使尾部截断生效（归档区间非空）
    const svc = new ArchiveService({
      wsRoot: tmp,
      router: { trigger: async () => '' } as any,
      registry: fakeRegistry({
        agentA: { name: 'AgentA', 'agent.session': { maxContextTokens: 10000, keepRecentRatio: 0.05, archiveTokenRatio: 0.7 } },
      }),
    });
    const dir = path.join(tmp, 'sessions', chatDialogKey('agentA', 'agentB'));

    // 构造 200 条长消息（每条 300 字符 ≈ 100 tokens；200 条 ≈ 20000 tokens）
    const longHistory: any[] = [];
    for (let i = 0; i < 200; i++) {
      longHistory.push({
        role: 'agent',
        content: `x${i} ` + 'y'.repeat(290),
        agent_id: i % 2 ? 'agentA' : 'user',
        message_id: `L${i}`,
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      });
    }
    // 当前会话文件（messages.jsonl）与上次归档一致（含 L150 之后的新增）
    writeSession(tmp, 'agentA', 'agentB', longHistory);
    // 上次归档已覆盖到 L150（history_1 最后一条 = L150）
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive', 'history_1.jsonl'),
      longHistory.slice(0, 151).map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');

    const ctx = reviewCtx('agentA', 'agentB', longHistory);
    await svc.archiveAndRebuild('agentA', 'agentB', ctx);

    // 归档文件：history_1 保持原样（151 条），history_2 = 去重后新增部分
    const h1 = readJsonl(path.join(dir, 'archive', 'history_1.jsonl'));
    expect(h1.length).toBe(151);
    const h2 = readJsonl(path.join(dir, 'archive', 'history_2.jsonl'));
    expect(h2.length).toBeGreaterThan(0);
    // h2 不包含 L150（上次归档最后一条）
    expect(h2.some((m: any) => m.message_id === 'L150')).toBe(false);
    // h2 从 L151 开始
    expect(h2[0].message_id).toBe('L151');
  });
});


