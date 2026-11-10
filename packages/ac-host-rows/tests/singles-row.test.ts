// ============================================================
// singles-row.test.ts —— 宿主独立会话行（cr-672 标题面两半）：
// ① 标题请求受理（壳侧 auto-title 行 → 信封 → 本行 write-if-absent 落盘
//    + singles/updated 广播）；② 派生标题兜底（用户行优先 / CRLF 剥尾 /
//    日期快照行跳过 / 上限 24 字）。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeSinglesHostRow, HostInbox } from '../src/index.ts';
import { makeTitleRequestEnvelope, type Envelope } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-singles-title-' + process.pid);
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

type Receiver = (env: Envelope) => Promise<{ ack: string; fresh: boolean }>;
type Handler = (params: unknown) => unknown;

/** agent 域会话目录（cr-973 起消息流单源——viewer 域退役） */
function sessionDir(id: string): string {
  return path.join(ROOT, 'agents', 'alpha', 'sessions', id);
}

/** 元数据新落点（数据分层第二层：meta/sessions/<sid>.json） */
function metaFile(id: string): string {
  return path.join(ROOT, 'meta', 'sessions', id + '.json');
}

function seedLedger(id: string, rows: Array<Record<string, unknown>>): void {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ type: 'session-header', version: 1, createdAt: '2026-10-24T00:00:00.000Z', participants: ['user', 'alpha'], kind: 'user' }];
  const body = rows.map((r, i) => ({ role: 'agent', message_id: id + '-' + i, timestamp: '2026-10-24T00:00:0' + i + '.000Z', ...r }));
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), [...lines, ...body].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

type SessionIndexFace = { messagesCatalog(): Array<{ conv: string; size: number; mtimeMs: number }> };

function boot(withInbox: boolean, sessionIndex?: SessionIndexFace) {
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
  // 桩 ctx：webServer + get + 最小事件面（conv-settings/updated 订阅——cordis on 形状）
  plugin.apply({ webServer: web, get: (k: string) => (k === 'sessionIndex' ? sessionIndex ?? undefined : undefined), on: () => {} });
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
    const meta = JSON.parse(fs.readFileSync(metaFile('s1'), 'utf-8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: 's1', title: '重建会话标题面', status: 'active', agentId: 'alpha' });
    expect(h.frames.at(-1)).toMatchObject({ type: 'singles/updated' });
    expect((h.frames.at(-1)!.args as unknown[])[1]).toBe('updated');
    // 派生面已被 meta 覆盖（列表回显 = 生成标题）
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 's1')?.title).toBe('重建会话标题面');
  });

  it('write-if-absent：已有标题（用户手改/fork 继承）不被覆盖', async () => {
    seedLedger('s2', [{ agent_id: 'user', content: '首条用户消息' }]);
    fs.mkdirSync(path.dirname(metaFile('s2')), { recursive: true });
    fs.writeFileSync(metaFile('s2'), JSON.stringify({ id: 's2', title: '手改标题' }), 'utf-8');
    const h = boot(true);
    await h.send(titleRequest('s2', '生成标题'));
    const meta = JSON.parse(fs.readFileSync(metaFile('s2'), 'utf-8')) as Record<string, unknown>;
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

describe('session.json 迁居 meta/sessions/（数据分层）', () => {
  it('写侧只写 meta/sessions/<sid>.json（agent 域目录无元数据文件）', async () => {
    seedLedger('mv-1', [{ agent_id: 'user', content: '迁居会话' }]);
    const h = boot(true);
    await h.send(titleRequest('mv-1', '迁居标题'));
    expect(JSON.parse(fs.readFileSync(metaFile('mv-1'), 'utf-8'))).toMatchObject({ id: 'mv-1', title: '迁居标题' });
    expect(fs.existsSync(path.join(sessionDir('mv-1'), 'session.json'))).toBe(false);
  });

  it('cr-998 旧位置退役：viewer 旧位 session.json 不再被读（meta 单源）', async () => {
    seedLedger('mv-2', [{ agent_id: 'user', content: '存量会话' }]);
    fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions', 'mv-2'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', 'mv-2', 'session.json'), JSON.stringify({ id: 'mv-2', title: '旧位标题', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), 'utf-8');
    const h = boot(false);
    // 读面：旧位置不再生效（标题走账本派生）
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 'mv-2')?.title).toBe('存量会话');
  });

  it('delete 摘除 meta 元数据 + agent 域账本', async () => {
    seedLedger('mv-3', [{ agent_id: 'user', content: '待删' }]);
    const h = boot(false);
    await h.handlers.get('singles/delete')!({ id: 'mv-3' });
    expect(fs.existsSync(metaFile('mv-3'))).toBe(false);
    expect(fs.existsSync(sessionDir('mv-3'))).toBe(false);
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
    seedLedger('d5', [{ agent_id: 'user', content: '@docs/cutover/spec.md\n补规格与对账' }]);
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

describe('摘要缓存（cr-682：size+mtimeMs 失效——写者单源同进程）', () => {
  it('账本追加（size 变）→ 摘要即时失效重算；未变 → 复用（list 两次结果一致）', async () => {
    seedLedger('c1', [{ agent_id: 'user', content: '首句' }]);
    const h = boot(false);
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string; title?: string }> };
    const v1 = first.singles.find((s) => s.id === 'c1')!;
    expect(v1.title).toBe('首句');
    // 账本追加一行（UserStub 同进程写者形态）：size+mtimeMs 变 → 缓存失效
    fs.appendFileSync(path.join(sessionDir('c1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '第二句', timestamp: '2026-10-25T00:00:00.000Z' }) + '\n', 'utf-8');
    const second = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    const v2 = second.singles.find((s) => s.id === 'c1')!;
    expect(v2.lastActivity).toBe('2026-10-25T00:00:00.000Z'); // 追加行被看见——无陈旧缓存
    // 未再写：第三次结果与第二次一致（缓存命中路径行为不变）
    const third = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(third.singles.find((s) => s.id === 'c1')!.lastActivity).toBe('2026-10-25T00:00:00.000Z');
  });

  it('账本删空（文件消失）→ 摘要回落 count 0（不进列表）', async () => {
    seedLedger('c2', [{ agent_id: 'user', content: '会消失' }]);
    const h = boot(false);
    let list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === 'c2')).toBe(true);
    fs.rmSync(path.join(sessionDir('c2'), 'messages.jsonl'));
    list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === 'c2')).toBe(false); // stat 失败 = count 0
  });
});

describe('清单注册表落盘（cr-845 摘要索引 → cr-869 全视图清单：跨宿主重启复用）', () => {
  it('重挂（重启模拟）后指纹未变即复用注册表；账本变更后重算', async () => {
    seedLedger('x1', [{ agent_id: 'user', content: '索引跨重启' }]);
    await boot(false).handlers.get('singles/list')!({});
    const indexFile = path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'); // cr-973 迁 meta 层
    expect(fs.existsSync(indexFile)).toBe(true); // 装载对账即落盘注册表
    // 重挂 = 新插件实例（宿主重启形态）：索引文件在场 → 命中复用
    const h2 = boot(false);
    const list2 = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list2.singles.find((s) => s.id === 'x1')?.title).toBe('索引跨重启');
    // 账本追加（跨重启后的真实写）：指纹变 → 重算，新行被看见
    fs.appendFileSync(path.join(sessionDir('x1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '重启后新句', timestamp: '2026-11-01T00:00:00.000Z' }) + '\n', 'utf-8');
    const h3 = boot(false);
    const list3 = await h3.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(list3.singles.find((s) => s.id === 'x1')?.lastActivity).toBe('2026-11-01T00:00:00.000Z');
  });

  it('索引文件损坏（非法 JSON / 形状不对）→ 回落空索引全量重算，不炸 list', async () => {
    seedLedger('y1', [{ agent_id: 'user', content: '损坏回落' }]);
    fs.mkdirSync(path.join(ROOT, 'meta', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), '{oops', 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 'y1')?.title).toBe('损坏回落');
    // 损坏注册表被重算结果覆写（自愈）
    const healed = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { version: number };
    expect(healed.version).toBe(2);
  });

  it('空会话目录（无账本无 meta）不落索引条目；仅 meta 的会话照常列出', async () => {
    fs.mkdirSync(sessionDir('z-empty'), { recursive: true }); // 空目录：不进列表也不进索引
    fs.mkdirSync(path.dirname(metaFile('z-meta')), { recursive: true });
    fs.writeFileSync(metaFile('z-meta'), JSON.stringify({ id: 'z-meta', title: '仅元数据', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === 'z-empty')).toBe(false);
    expect(list.singles.some((s) => s.id === 'z-meta')).toBe(true);
  });
});
describe('清单注册表（cr-869：写点维护 + list 零读）', () => {
  it('create/update/delete 写点同步注册表——list 直吐且与盘一致；delete 后重启不复活', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', name: 'Alpha' }), 'utf-8');
    const h = boot(false);
    await h.handlers.get('singles/create')!({ id: 'r1', agentId: 'alpha' }) as { single: { id: string } };
    await h.handlers.get('singles/update')!({ id: 'r1', title: '注册表标题' });
    let list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 'r1')?.title).toBe('注册表标题');
    // delete → 条目摘除；新 boot（装载对账）不复活
    await h.handlers.get('singles/delete')!({ id: 'r1' });
    list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === 'r1')).toBe(false);
    const h2 = boot(false);
    const list2 = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list2.singles.some((s) => s.id === 'r1')).toBe(false);
  });

  it('跨 boot 复用：装载后条目在场，外部账本追加（UserStub 形态）list 仍看见新行', async () => {
    seedLedger('k1', [{ agent_id: 'user', content: '首句' }]);
    await boot(false).handlers.get('singles/list')!({});
    const h2 = boot(false); // 重启模拟：注册表复用
    fs.appendFileSync(path.join(sessionDir('k1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '第二句', timestamp: '2026-11-02T00:00:00.000Z' }) + '\n', 'utf-8');
    const list = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(list.singles.find((s) => s.id === 'k1')?.lastActivity).toBe('2026-11-02T00:00:00.000Z');
  });

  it('手工改 meta/sessions/<sid>.json（指纹变）→ 装载复验回源重算，标题不驻留旧值', async () => {
    seedLedger('w1', [{ agent_id: 'user', content: '派生标题' }]);
    await boot(false).handlers.get('singles/list')!({});
    // 外部手改（绕过本行写点）
    fs.writeFileSync(metaFile('w1'), JSON.stringify({ id: 'w1', title: '手改', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }), 'utf-8');
    const h2 = boot(false);
    const list = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 'w1')?.title).toBe('手改');
  });

  it('旧版索引文件（version 1 / .singles-index.json）在场 → 被新注册表取代（遗留文件不影响）', async () => {
    seedLedger('v1', [{ agent_id: 'user', content: '旧版在场' }]);
    fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', '.singles-index.json'), JSON.stringify({ version: 1, entries: {} }), 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === 'v1')?.title).toBe('旧版在场');
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'))).toBe(true); // cr-973 迁 meta 层
  });
});

describe('指定 id 物化（cr-847 延迟落盘链路）', () => {
  it('带 id 创建 → 落盘同 id；重复带 id 创建 → 幂等返回现状视图（不重写 meta）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), JSON.stringify({ id: 'alpha', name: 'Alpha' }), 'utf-8');
    const h = boot(false);
    const created = await h.handlers.get('singles/create')!({ id: 'fixed-1', agentId: 'alpha', workspaceId: 'ws1' }) as { single: { id: string; agentId: string; workspaceId?: string } };
    expect(created.single.id).toBe('fixed-1');
    expect(created.single.agentId).toBe('alpha');
    const metaPath = metaFile('fixed-1');
    const meta1 = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta1.workspaceId).toBe('ws1');
    // 幂等重入：已有目录（meta 在场）→ 返回现状视图不重写（updatedAt 不变）
    const again = await h.handlers.get('singles/create')!({ id: 'fixed-1', agentId: 'alpha' }) as { single: { id: string; updatedAt: string } };
    expect(again.single.id).toBe('fixed-1');
    const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta2.updatedAt).toBe(meta1.updatedAt);
  });

  it('仅账本在场的 id（消息先行）→ 幂等路径也能返回视图（meta 兜底落盘不丢消息会话）', async () => {
    seedLedger('m-only', [{ agent_id: 'user', content: '消息先到' }]);
    const h = boot(false);
    const r = await h.handlers.get('singles/create')!({ id: 'm-only' }) as { single: { id: string; title?: string } };
    expect(r.single.id).toBe('m-only');
    expect(r.single.title).toBe('消息先到'); // 派生面照常工作
  });

  it('非法 id（路径分隔）→ fail-loud', async () => {
    const h = boot(false);
    await expect(async () => h.handlers.get('singles/create')!({ id: '../evil' })).rejects.toThrow(/非法/);
  });
});

describe('singles/list 指纹复验走 sessionIndex 账面（cr-981）', () => {
  /** 与 ledgerFingerprint 同公式（测试侧直算——账面值的生产源是 files 表） */
  const fpOf = (id: string): { size: number; mtimeMs: number } | null => {
    let size = 0;
    let mtimeMs = 0;
    let any = false;
    for (const dir of [path.join(ROOT, 'agents', 'alpha', 'sessions', id)]) {
      try {
        const st = fs.statSync(path.join(dir, 'messages.jsonl'));
        size += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        any = true;
      } catch { /* 该域无 messages 文件 */ }
    }
    return any ? { size, mtimeMs } : null;
  };
  /** 账面快照（构造时冻结——模拟 index 未对账的陈旧态；惰性直算会把
   *  追加后的新 stat 带进账面，测不出「信任账面」语义） */
  const catOf = (ids: string[]): { messagesCatalog(): Array<{ conv: string; size: number; mtimeMs: number }> } => {
    const frozen = ids.flatMap((id) => { const f = fpOf(id); return f ? [{ conv: id, ...f }] : []; });
    return { messagesCatalog: () => frozen.map((r) => ({ ...r })) };
  };

  it('账面未步进（index 陈旧）→ 条目视为未变，不回源重算（信任账面）', async () => {
    seedLedger('s1', [{ agent_id: 'alpha', content: '开场' }, { agent_id: 'user', content: '首条' }]);
    const staleCat = catOf(['s1']); // 追加前冻结——模拟 index 未对账的陈旧账面
    const h = boot(false, staleCat);
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(first.singles.map((x) => x.id)).toContain('s1');
    // 盘上追加了，但陈旧账面未步进 → list 不触发重算
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', 's1', 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    const h2 = boot(false, staleCat); // 重新 boot：registry 落盘复用（装载复验只看 meta mtime）
    const second = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    const row = second.singles.find((x) => x.id === 's1')!;
    // 追加未进账面 → 摘要未重算（lastActivity 仍是装载时点）
    expect(row.lastActivity).toBe(first.singles.find((x) => x.id === 's1')!.lastActivity);
  });

  it('账面步进（size 变化）→ 条目回源重算（lastActivity 前进）', async () => {
    seedLedger('s1', [{ agent_id: 'alpha', content: '开场' }]);
    const h = boot(false, catOf(['s1']));
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', 's1', 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    // 账面已对账（重新 fpOf = 新 stat）→ list 重算
    const h2 = boot(false, catOf(['s1']));
    const second = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(second.singles.find((x) => x.id === 's1')!.lastActivity).toBe('2026-10-24T09:00:00.000Z');
    expect(first.singles.find((x) => x.id === 's1')!.lastActivity).not.toBe('2026-10-24T09:00:00.000Z');
  });

  it('行缺席 → 逐条目 stat 复验回落（外部写仍被看见）', async () => {
    seedLedger('s1', [{ agent_id: 'alpha', content: '开场' }]);
    const h = boot(false); // 无 sessionIndex
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', 's1', 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(out.singles.find((x) => x.id === 's1')!.lastActivity).toBe('2026-10-24T09:00:00.000Z');
  });
});
