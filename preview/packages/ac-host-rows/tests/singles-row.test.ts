// ============================================================
// singles-row.test.ts —— 宿主独立会话行（cr-672 标题面两半）：
// ① 标题请求受理（壳侧 auto-title 行 → 信封 → 本行 write-if-absent 落盘
//    + singles/updated 广播）；② 派生标题兜底（用户行优先 / CRLF 剥尾 /
//    日期快照行跳过 / 上限 24 字）。数据根恒 preview/sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeSinglesHostRow, HostInbox } from '../src/index.ts';
import { makeTitleRequestEnvelope, type Envelope } from 'ac-envelope-core';

const ROOT = path.join('preview', 'sandbox', 'test-singles-title-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Receiver = (env: Envelope) => Promise<{ ack: string; fresh: boolean }>;
type Handler = (params: unknown) => unknown;

function sessionDir(id: string): string {
  return path.join(ROOT, 'viewer', 'sessions', id);
}

function seedLedger(id: string, rows: Array<Record<string, unknown>>): void {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: 'session-header', version: 1, createdAt: '2026-10-24T00:00:00.000Z', participants: ['user', 'alpha'], kind: 'user' }];
  const body = rows.map((r, i) => ({ role: 'agent', message_id: id + '-' + i, timestamp: '2026-10-24T00:00:0' + i + '.000Z', ...r }));
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), [...lines, ...body].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function boot(withInbox: boolean) {
  const handlers = new Map<string, Handler>();
  const frames: Array<{ type: string; args?: unknown }> = [];
  let receiver: Receiver | null = null;
  const inbox = new HostInbox({ registerLocal: (_id: string, r: Receiver) => { receiver = r; } });
  if (withInbox) inbox.start();
  const web = {
    registerRpc: (method: string, handler: Handler) => { handlers.set(method, handler); },
    broadcast: (type: string, data?: unknown) => { frames.push({ type, ...(data as { args?: unknown }) }); },
  };
  const plugin = makeSinglesHostRow({ dataRoot: ROOT, ...(withInbox ? { inbox } : {}) }) as unknown as { apply(ctx: unknown): void };
  plugin.apply({ webServer: web, get: () => undefined });
  const send = (env: Envelope) => {
    if (receiver === null) throw new Error('收信面未注册');
    return receiver(env);
  };
  return { handlers, frames, send };
}

const titleRequest = (conversationId: string, title: string): Envelope => makeTitleRequestEnvelope({
  conversationId,
  requestId: 'title-' + conversationId + '-' + Math.random().toString(36).slice(2),
  sender: 'alpha',
  payload: { conversationId, title, agent: 'alpha' },
});

describe('标题请求受理（cr-672）', () => {
  it('落盘 session.json（元数据取派生值）+ singles/updated 广播', async () => {
    // 对端行在场 → agentId 由派生面带入 session.json（纯增量不迁移）
    seedLedger('s1', [{ agent_id: 'alpha', content: 'Agent 开场白' }, { agent_id: 'user', content: '首条用户消息' }]);
    const h = boot(true);
    const out = await h.send(titleRequest('s1', '重建会话标题面'));
    expect(out.fresh).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir('s1'), 'session.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: 's1', title: '重建会话标题面', status: 'active', agentId: 'alpha' });
    expect(h.frames.at(-1)).toMatchObject({ type: 'singles/updated' });
    expect((h.frames.at(-1)!.args as unknown[])[1]).toBe('updated');
    // 派生面已被 meta 覆盖（列表回显 = 生成标题）
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 's1')?.title).toBe('重建会话标题面');
  });

  it('write-if-absent：已有标题（用户手改/fork 继承）不被覆盖', async () => {
    seedLedger('s2', [{ agent_id: 'user', content: '首条用户消息' }]);
    fs.writeFileSync(path.join(sessionDir('s2'), 'session.json'), JSON.stringify({ id: 's2', title: '手改标题' }), 'utf-8');
    const h = boot(true);
    await h.send(titleRequest('s2', '生成标题'));
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir('s2'), 'session.json'), 'utf-8')) as Record<string, unknown>;
    expect(meta.title).toBe('手改标题');
    expect(h.frames).toHaveLength(0); // 未变更 = 不广播
  });

  it('非法 payload fail-loud（HostInbox 整体投递失败 → 邮局重投面可见）', async () => {
    seedLedger('s3', [{ agent_id: 'user', content: 'x' }]);
    const h = boot(true);
    await expect(h.send(titleRequest('s3', '   '))).rejects.toThrow(/标题请求非法/);
  });

  it('无收信面（inbox 缺省）→ 行照常装配，singles/* RPC 不受影响', async () => {
    seedLedger('s4', [{ agent_id: 'user', content: '首条用户消息' }]);
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 's4')?.title).toBe('首条用户消息');
  });
});

describe('派生标题兜底（cr-672）', () => {
  it('用户行优先于对端行；CRLF 剥尾；日期快照行跳过；超长 24 字 + 省略号', async () => {
    seedLedger('d1', [
      { agent_id: 'alpha', content: 'Agent 先说的开场白' },
      { agent_id: 'user', content: '真正的用户首句\r\n第二行' },
    ]);
    seedLedger('d2', [
      { agent_id: 'user', content: '[当前时间] 2026-10-24 周五' },
      { agent_id: 'user', content: '跳过日期快照后的内容' },
    ]);
    seedLedger('d3', [{ agent_id: 'user', content: '这是一条很长很长的用户消息用来验证二十四字上限与省略号尾巴' }]);
    // 附件路径 / @ 引用开头的消息：材料行筛选跳过引用行（cr-672——存量会话里
    // 192 个标题因此全是同一条仓库路径）
    seedLedger('d5', [{ agent_id: 'user', content: '@preview/docs/spec.md\n补规格与对账' }]);
    seedLedger('d4', []); // 空会话（只有头行）→ 不进列表
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    const titleOf = (id: string) => list.singles.find((s) => s.id === id)?.title;
    expect(titleOf('d1')).toBe('真正的用户首句');
    expect(titleOf('d2')).toBe('跳过日期快照后的内容');
    expect(titleOf('d3')).toHaveLength(25);
    expect(titleOf('d3')!.endsWith('…')).toBe(true);
    expect(titleOf('d5')).toBe('补规格与对账');
    expect(titleOf('d4')).toBeUndefined();
    expect(list.singles.some((s) => s.id === 'd4')).toBe(false);
  });
});
