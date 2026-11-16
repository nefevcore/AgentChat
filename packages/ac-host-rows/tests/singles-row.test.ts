// ============================================================
// singles-row.test.ts —— 宿主独立会话行（cr-672 标题面两半）：
// ① 标题请求受理（壳侧 auto-title 行 → 信封 → 本行 write-if-absent 落盘
//    + singles/updated 广播）；② 派生标题兜底（用户行优先 / CRLF 剥尾 /
//    日期快照行跳过 / 上限 24 字）。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeSinglesHostRow, migrateLegacyPrefixSnapshots, HostInbox } from '../src/index.ts';
import { writeAgentConfig } from 'ac-agents-core';
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

/** 短名 → 确定性 uuid 形会话键（cr-1120 词汇锁：singles 会话 id 恒 uuid 形） */
function sidOf(name: string): string {
  let h = '';
  for (let i = 0; i < name.length; i++) h += name.charCodeAt(i).toString(16).padStart(2, '0');
  h = (h + '0'.repeat(32)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
    seedLedger(sidOf('s1'), [{ agent_id: 'alpha', content: 'Agent 开场白' }, { agent_id: 'user', content: '首条用户消息' }]);
    const h = boot(true);
    const out = await h.send(titleRequest(sidOf('s1'), '重建会话标题面'));
    expect(out.fresh).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaFile(sidOf('s1')), 'utf-8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: sidOf('s1'), title: '重建会话标题面', status: 'active', agentId: 'alpha' });
    expect(h.frames.at(-1)).toMatchObject({ type: 'singles/updated' });
    expect((h.frames.at(-1)!.args as unknown[])[1]).toBe('updated');
    // 派生面已被 meta 覆盖（列表回显 = 生成标题）
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('s1'))?.title).toBe('重建会话标题面');
  });

  it('write-if-absent：已有标题（用户手改/fork 继承）不被覆盖', async () => {
    seedLedger(sidOf('s2'), [{ agent_id: 'user', content: '首条用户消息' }]);
    fs.mkdirSync(path.dirname(metaFile(sidOf('s2'))), { recursive: true });
    fs.writeFileSync(metaFile(sidOf('s2')), JSON.stringify({ id: sidOf('s2'), title: '手改标题' }), 'utf-8');
    const h = boot(true);
    await h.send(titleRequest(sidOf('s2'), '生成标题'));
    const meta = JSON.parse(fs.readFileSync(metaFile(sidOf('s2')), 'utf-8')) as Record<string, unknown>;
    expect(meta.title).toBe('手改标题');
    expect(h.frames).toHaveLength(0); // 未变更 = 不广播
  });

  it('非法 payload fail-loud（HostInbox 整体投递失败 → 邮局重投面可见）', async () => {
    seedLedger(sidOf('s3'), [{ agent_id: 'user', content: 'x' }]);
    const h = boot(true);
    await expect(h.send(titleRequest(sidOf('s3'), '   '))).rejects.toThrow(/标题请求非法/);
  });

  it('无收信面（inbox 缺省）→ 行照常装配，singles/* RPC 不受影响', async () => {
    seedLedger(sidOf('s4'), [{ agent_id: 'user', content: '首条用户消息' }]);
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('s4'))?.title).toBe('首条用户消息');
  });
});

describe('session.json 迁居 meta/sessions/（数据分层）', () => {
  it('写侧只写 meta/sessions/<sid>.json（agent 域目录无元数据文件）', async () => {
    seedLedger(sidOf('mv-1'), [{ agent_id: 'user', content: '迁居会话' }]);
    const h = boot(true);
    await h.send(titleRequest(sidOf('mv-1'), '迁居标题'));
    expect(JSON.parse(fs.readFileSync(metaFile(sidOf('mv-1')), 'utf-8'))).toMatchObject({ id: sidOf('mv-1'), title: '迁居标题' });
    expect(fs.existsSync(path.join(sessionDir(sidOf('mv-1')), 'session.json'))).toBe(false);
  });

  it('cr-998 旧位置退役：viewer 旧位 session.json 不再被读（meta 单源）', async () => {
    seedLedger(sidOf('mv-2'), [{ agent_id: 'user', content: '存量会话' }]);
    fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions', sidOf('mv-2')), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', sidOf('mv-2'), 'session.json'), JSON.stringify({ id: sidOf('mv-2'), title: '旧位标题', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), 'utf-8');
    const h = boot(false);
    // 读面：旧位置不再生效（标题走账本派生）
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('mv-2'))?.title).toBe('存量会话');
  });

  it('delete 摘除 meta 元数据 + agent 域账本', async () => {
    seedLedger(sidOf('mv-3'), [{ agent_id: 'user', content: '待删' }]);
    const h = boot(false);
    await h.handlers.get('singles/delete')!({ id: sidOf('mv-3') });
    expect(fs.existsSync(metaFile(sidOf('mv-3')))).toBe(false);
    expect(fs.existsSync(sessionDir(sidOf('mv-3')))).toBe(false);
  });
});

describe('派生标题兜底（cr-672）', () => {
  it('用户行优先于对端行；CRLF 剥尾；日期快照行跳过；超长 24 字 + 省略号', async () => {
    seedLedger(sidOf('d1'), [
      { agent_id: 'alpha', content: 'Agent 先说的开场白' },
      { agent_id: 'user', content: '真正的用户首句\r\n第二行' },
    ]);
    seedLedger(sidOf('d2'), [
      { agent_id: 'user', content: '[当前时间] 2026-10-24 周五' },
      { agent_id: 'user', content: '跳过日期快照后的内容' },
    ]);
    seedLedger(sidOf('d3'), [{ agent_id: 'user', content: '这是一条很长很长的用户消息用来验证二十四字上限与省略号尾巴' }]);
    // 附件路径 / @ 引用开头的消息：材料行筛选跳过引用行（cr-672——存量会话里
    // 192 个标题因此全是同一条仓库路径）
    seedLedger(sidOf('d5'), [{ agent_id: 'user', content: '@docs/cutover/spec.md\n补规格与对账' }]);
    seedLedger(sidOf('d4'), []); // 空会话（只有头行）→ 不进列表
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    const titleOf = (id: string) => list.singles.find((s) => s.id === id)?.title;
    expect(titleOf(sidOf('d1'))).toBe('真正的用户首句');
    expect(titleOf(sidOf('d2'))).toBe('跳过日期快照后的内容');
    expect(titleOf(sidOf('d3'))).toHaveLength(25);
    expect(titleOf(sidOf('d3'))!.endsWith('…')).toBe(true);
    expect(titleOf(sidOf('d5'))).toBe('补规格与对账');
    expect(titleOf(sidOf('d4'))).toBeUndefined();
    expect(list.singles.some((s) => s.id === sidOf('d4'))).toBe(false);
  });
});

describe('摘要缓存（cr-682：size+mtimeMs 失效——写者单源同进程）', () => {
  it('账本追加（size 变）→ 摘要即时失效重算；未变 → 复用（list 两次结果一致）', async () => {
    seedLedger(sidOf('c1'), [{ agent_id: 'user', content: '首句' }]);
    const h = boot(false);
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string; title?: string }> };
    const v1 = first.singles.find((s) => s.id === sidOf('c1'))!;
    expect(v1.title).toBe('首句');
    // 账本追加一行（UserStub 同进程写者形态）：size+mtimeMs 变 → 缓存失效
    fs.appendFileSync(path.join(sessionDir(sidOf('c1')), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '第二句', timestamp: '2026-10-25T00:00:00.000Z' }) + '\n', 'utf-8');
    const second = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    const v2 = second.singles.find((s) => s.id === sidOf('c1'))!;
    expect(v2.lastActivity).toBe('2026-10-25T00:00:00.000Z'); // 追加行被看见——无陈旧缓存
    // 未再写：第三次结果与第二次一致（缓存命中路径行为不变）
    const third = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(third.singles.find((s) => s.id === sidOf('c1'))!.lastActivity).toBe('2026-10-25T00:00:00.000Z');
  });

  it('账本删空（文件消失）→ 摘要回落 count 0（不进列表）', async () => {
    seedLedger(sidOf('c2'), [{ agent_id: 'user', content: '会消失' }]);
    const h = boot(false);
    let list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === sidOf('c2'))).toBe(true);
    fs.rmSync(path.join(sessionDir(sidOf('c2')), 'messages.jsonl'));
    list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === sidOf('c2'))).toBe(false); // stat 失败 = count 0
  });
});

describe('清单注册表落盘（cr-845 摘要索引 → cr-869 全视图清单：跨宿主重启复用）', () => {
  it('重挂（重启模拟）后指纹未变即复用注册表；账本变更后重算', async () => {
    seedLedger(sidOf('x1'), [{ agent_id: 'user', content: '索引跨重启' }]);
    await boot(false).handlers.get('singles/list')!({});
    const indexFile = path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'); // cr-973 迁 meta 层
    expect(fs.existsSync(indexFile)).toBe(true); // 装载对账即落盘注册表
    // 重挂 = 新插件实例（宿主重启形态）：索引文件在场 → 命中复用
    const h2 = boot(false);
    const list2 = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list2.singles.find((s) => s.id === sidOf('x1'))?.title).toBe('索引跨重启');
    // 账本追加（跨重启后的真实写）：指纹变 → 重算，新行被看见
    fs.appendFileSync(path.join(sessionDir(sidOf('x1')), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '重启后新句', timestamp: '2026-11-01T00:00:00.000Z' }) + '\n', 'utf-8');
    const h3 = boot(false);
    const list3 = await h3.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(list3.singles.find((s) => s.id === sidOf('x1'))?.lastActivity).toBe('2026-11-01T00:00:00.000Z');
  });

  it('索引文件损坏（非法 JSON / 形状不对）→ 回落空索引全量重算，不炸 list', async () => {
    seedLedger(sidOf('y1'), [{ agent_id: 'user', content: '损坏回落' }]);
    fs.mkdirSync(path.join(ROOT, 'meta', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), '{oops', 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('y1'))?.title).toBe('损坏回落');
    // 损坏注册表被重算结果覆写（自愈）
    const healed = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { version: number };
    expect(healed.version).toBe(2);
  });

  it('空会话目录（无账本无 meta）不落索引条目；仅 meta 的会话照常列出', async () => {
    fs.mkdirSync(sessionDir(sidOf('z-empty')), { recursive: true }); // 空目录：不进列表也不进索引
    fs.mkdirSync(path.dirname(metaFile(sidOf('z-meta'))), { recursive: true });
    fs.writeFileSync(metaFile(sidOf('z-meta')), JSON.stringify({ id: sidOf('z-meta'), title: '仅元数据', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === sidOf('z-empty'))).toBe(false);
    expect(list.singles.some((s) => s.id === sidOf('z-meta'))).toBe(true);
  });
});
describe('清单注册表（cr-869：写点维护 + list 零读）', () => {
  it('create/update/delete 写点同步注册表——list 直吐且与盘一致；delete 后重启不复活', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    writeAgentConfig(ROOT, { id: 'alpha', name: 'Alpha' }); // cr-1036 批3：v3 写口
    const h = boot(false);
    await h.handlers.get('singles/create')!({ id: sidOf('r1'), agentId: 'alpha' }) as { single: { id: string } };
    await h.handlers.get('singles/update')!({ id: sidOf('r1'), title: '注册表标题' });
    let list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('r1'))?.title).toBe('注册表标题');
    // delete → 条目摘除；新 boot（装载对账）不复活
    await h.handlers.get('singles/delete')!({ id: sidOf('r1') });
    list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list.singles.some((s) => s.id === sidOf('r1'))).toBe(false);
    const h2 = boot(false);
    const list2 = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(list2.singles.some((s) => s.id === sidOf('r1'))).toBe(false);
  });

  it('跨 boot 复用：装载后条目在场，外部账本追加（UserStub 形态）list 仍看见新行', async () => {
    seedLedger(sidOf('k1'), [{ agent_id: 'user', content: '首句' }]);
    await boot(false).handlers.get('singles/list')!({});
    const h2 = boot(false); // 重启模拟：注册表复用
    fs.appendFileSync(path.join(sessionDir(sidOf('k1')), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'user', content: '第二句', timestamp: '2026-11-02T00:00:00.000Z' }) + '\n', 'utf-8');
    const list = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('k1'))?.lastActivity).toBe('2026-11-02T00:00:00.000Z');
  });

  it('手工改 meta/sessions/<sid>.json（指纹变）→ 装载复验回源重算，标题不驻留旧值', async () => {
    seedLedger(sidOf('w1'), [{ agent_id: 'user', content: '派生标题' }]);
    await boot(false).handlers.get('singles/list')!({});
    // 外部手改（绕过本行写点）
    fs.writeFileSync(metaFile(sidOf('w1')), JSON.stringify({ id: sidOf('w1'), title: '手改', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }), 'utf-8');
    const h2 = boot(false);
    const list = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('w1'))?.title).toBe('手改');
  });

  it('旧版索引文件（version 1 / .singles-index.json）在场 → 被新注册表取代（遗留文件不影响）', async () => {
    seedLedger(sidOf('v1'), [{ agent_id: 'user', content: '旧版在场' }]);
    fs.mkdirSync(path.join(ROOT, 'viewer', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'viewer', 'sessions', '.singles-index.json'), JSON.stringify({ version: 1, entries: {} }), 'utf-8');
    const h = boot(false);
    const list = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; title?: string }> };
    expect(list.singles.find((s) => s.id === sidOf('v1'))?.title).toBe('旧版在场');
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'))).toBe(true); // cr-973 迁 meta 层
  });
});

describe('指定 id 物化（cr-847 延迟落盘链路）', () => {
  it('带 id 创建 → 落盘同 id；重复带 id 创建 → 幂等返回现状视图（不重写 meta）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    writeAgentConfig(ROOT, { id: 'alpha', name: 'Alpha' }); // cr-1036 批3：v3 写口
    const h = boot(false);
    const created = await h.handlers.get('singles/create')!({ id: sidOf('fixed-1'), agentId: 'alpha', workspaceId: 'ws1' }) as { single: { id: string; agentId: string; workspaceId?: string } };
    expect(created.single.id).toBe(sidOf('fixed-1'));
    expect(created.single.agentId).toBe('alpha');
    const metaPath = metaFile(sidOf('fixed-1'));
    const meta1 = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta1.workspaceId).toBe('ws1');
    // 幂等重入：已有目录（meta 在场）→ 返回现状视图不重写（updatedAt 不变）
    const again = await h.handlers.get('singles/create')!({ id: sidOf('fixed-1'), agentId: 'alpha' }) as { single: { id: string; updatedAt: string } };
    expect(again.single.id).toBe(sidOf('fixed-1'));
    const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta2.updatedAt).toBe(meta1.updatedAt);
  });

  it('仅账本在场的 id（消息先行）→ 幂等路径也能返回视图（meta 兜底落盘不丢消息会话）', async () => {
    seedLedger(sidOf('m-only'), [{ agent_id: 'user', content: '消息先到' }]);
    const h = boot(false);
    const r = await h.handlers.get('singles/create')!({ id: sidOf('m-only') }) as { single: { id: string; title?: string } };
    expect(r.single.id).toBe(sidOf('m-only'));
    expect(r.single.title).toBe('消息先到'); // 派生面照常工作
  });

  it('非法 id（路径分隔 / 非 uuid 形）→ fail-loud', async () => {
    const h = boot(false);
    await expect(async () => h.handlers.get('singles/create')!({ id: '../evil' })).rejects.toThrow(/非法/);
    // cr-1120 词汇锁：对桶键 / 子Agent 键不是 singles 会话键
    await expect(async () => h.handlers.get('singles/create')!({ id: 'admin~tester' })).rejects.toThrow(/非法/);
    await expect(async () => h.handlers.get('singles/create')!({ id: 'sub_1791001449' })).rejects.toThrow(/非法/);
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
    seedLedger(sidOf('s1'), [{ agent_id: 'alpha', content: '开场' }, { agent_id: 'user', content: '首条' }]);
    const staleCat = catOf([sidOf('s1')]); // 追加前冻结——模拟 index 未对账的陈旧账面
    const h = boot(false, staleCat);
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(first.singles.map((x) => x.id)).toContain(sidOf('s1'));
    // 盘上追加了，但陈旧账面未步进 → list 不触发重算
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', sidOf('s1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    const h2 = boot(false, staleCat); // 重新 boot：registry 落盘复用（装载复验只看 meta mtime）
    const second = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    const row = second.singles.find((x) => x.id === sidOf('s1'))!;
    // 追加未进账面 → 摘要未重算（lastActivity 仍是装载时点）
    expect(row.lastActivity).toBe(first.singles.find((x) => x.id === sidOf('s1'))!.lastActivity);
  });

  it('账面步进（size 变化）→ 条目回源重算（lastActivity 前进）', async () => {
    seedLedger(sidOf('s1'), [{ agent_id: 'alpha', content: '开场' }]);
    const h = boot(false, catOf([sidOf('s1')]));
    const first = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', sidOf('s1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    // 账面已对账（重新 fpOf = 新 stat）→ list 重算
    const h2 = boot(false, catOf([sidOf('s1')]));
    const second = await h2.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(second.singles.find((x) => x.id === sidOf('s1'))!.lastActivity).toBe('2026-10-24T09:00:00.000Z');
    expect(first.singles.find((x) => x.id === sidOf('s1'))!.lastActivity).not.toBe('2026-10-24T09:00:00.000Z');
  });

  it('行缺席 → 逐条目 stat 复验回落（外部写仍被看见）', async () => {
    seedLedger(sidOf('s1'), [{ agent_id: 'alpha', content: '开场' }]);
    const h = boot(false); // 无 sessionIndex
    fs.appendFileSync(path.join(ROOT, 'agents', 'alpha', 'sessions', sidOf('s1'), 'messages.jsonl'),
      JSON.stringify({ role: 'agent', agent_id: 'alpha', content: '追加行', message_id: 's1-x', timestamp: '2026-10-24T09:00:00.000Z' }) + '\n');
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string; lastActivity?: string }> };
    expect(out.singles.find((x) => x.id === sidOf('s1'))!.lastActivity).toBe('2026-10-24T09:00:00.000Z');
  });
});
describe('cr-1100 快照分居：旧位搬空 + 通配不再误收', () => {
  const snapDir = () => path.join(ROOT, 'meta', 'prefix-snapshots');
  /** 旧位寄居快照直投（cr-973~cr-1100 间的历史落点形态） */
  function seedLegacySnapshot(sid: string): void {
    fs.mkdirSync(path.dirname(metaFile(sid)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'meta', 'sessions', sid + '.prefix-snapshot.json'),
      JSON.stringify({ version: 1, createdAt: '2026-11-14T00:00:00.000Z', sections: [], settingsFingerprint: {} }), 'utf-8');
  }

  it('装载 sweep：旧位 *.prefix-snapshot.json 搬至 meta/prefix-snapshots/<sid>.json，旧位归零', () => {
    seedLegacySnapshot('01a1d4c2-7df9-7161-8fa3-b773f21f3e60');
    boot(false);
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', '01a1d4c2-7df9-7161-8fa3-b773f21f3e60.prefix-snapshot.json'))).toBe(false);
    expect(fs.existsSync(path.join(snapDir(), '01a1d4c2-7df9-7161-8fa3-b773f21f3e60.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(snapDir(), '01a1d4c2-7df9-7161-8fa3-b773f21f3e60.json'), 'utf-8'))).toMatchObject({ version: 1 });
    // 新位在场时同名残留即清（壳侧早写新位 → 宿主 sweep 只清旧壳留物）
    seedLegacySnapshot('01a1d4c2-7df9-7161-8fa3-b773f21f3e60');
    boot(false);
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', '01a1d4c2-7df9-7161-8fa3-b773f21f3e60.prefix-snapshot.json'))).toBe(false);
  });

  it('新位在场 → 不搬迁，旧位残留清空（壳宿主换代窗口不回滚）', () => {
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'sid-new.json'), JSON.stringify({ version: 1 }), 'utf-8');
    seedLegacySnapshot('sid-new');
    boot(false);
    expect(fs.readFileSync(path.join(snapDir(), 'sid-new.json'), 'utf-8')).toBe(JSON.stringify({ version: 1 }));
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', 'sid-new.prefix-snapshot.json'))).toBe(false);
  });


  it('单文件搬迁失败不中断整批（活壳持有旧文件——Windows 文件锁场景）', async () => {
    seedLegacySnapshot('sid-lock-1');
    seedLegacySnapshot('sid-lock-2');
    seedLegacySnapshot('sid-lock-3');
    // 注入失败面：首个文件 rename 抛 EPERM（模拟 Windows 文件锁占用）
    let failed = false;
    const realRename = fs.renameSync;
    const fakeFs = {
      readdirSync: fs.readdirSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      existsSync: fs.existsSync.bind(fs),
      rmSync: fs.rmSync.bind(fs),
      renameSync: ((a: fs.PathLike, b: fs.PathLike) => {
        if (!failed && String(a).includes('sid-lock-1')) { failed = true; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }
        return realRename(a, b);
      }) as typeof fs.renameSync,
    };
    const res = migrateLegacyPrefixSnapshots(ROOT, fakeFs);
    expect(failed).toBe(true); // 失败确实发生过
    expect(res.moved).toBe(2); // 其余两个照常搬迁
    expect(fs.existsSync(path.join(snapDir(), 'sid-lock-2.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapDir(), 'sid-lock-3.json'))).toBe(true);
    // 失败者留守（下次装载重试）
    expect(fs.existsSync(path.join(ROOT, 'meta', 'sessions', 'sid-lock-1.prefix-snapshot.json'))).toBe(true);
    // 残留对 list 无害：词汇锁排除含点文件名，不产幻影会话
    const h = boot(false);
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(out.singles.some((s) => s.id.endsWith('.prefix-snapshot'))).toBe(false);
  });
  it('sweep 幂等：二度 boot 旧位仍空（零枚举直通）', () => {
    seedLegacySnapshot('sid-aa');
    boot(false);
    boot(false);
    expect(fs.existsSync(path.join(snapDir(), 'sid-aa.json'))).toBe(true);
    expect(fs.readdirSync(path.join(ROOT, 'meta', 'sessions')).some((n) => n.endsWith('.prefix-snapshot.json'))).toBe(false);
  });

  it('幻影不收：旧位快照在场（迁移前夜形态）→ 不登记 <sid>.prefix-snapshot 假会话', async () => {
    seedLegacySnapshot('01a1b676-e2ac-7935-b201-594631bad288');
    const h = boot(false);
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(out.singles.some((s) => s.id.endsWith('.prefix-snapshot'))).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { entries: Record<string, unknown> };
    expect(Object.keys(reg.entries).some((k) => k.endsWith('.prefix-snapshot'))).toBe(false);
  });
});

describe('cr-1120 会话键词汇锁（对桶键 / 子Agent 键不进 singles 清单）', () => {
  it('agents 域对桶键（a~b / 群成员流 gid~member）与 sub_ 键 → 不进 list 也不进注册表', async () => {
    // agent⇄agent 对桶 + 群成员流 + 子Agent 编排会话：同住 agents 域 sessions/，
    // 均非 singles（历史 bug：listIds 无差别并集 → 未分组幻影行）
    seedLedger('admin~tester', [{ agent_id: 'alpha', content: '对桶对话' }]);
    seedLedger('g1~alpha', [{ agent_id: 'alpha', content: '群成员流' }]);
    seedLedger('sub_1791001449', [{ agent_id: 'alpha', content: '子Agent 会话' }]);
    seedLedger(sidOf('s1'), [{ agent_id: 'user', content: '真独立会话' }]);
    const h = boot(false);
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(out.singles.map((s) => s.id)).toContain(sidOf('s1'));
    expect(out.singles.some((s) => s.id.includes('~'))).toBe(false);
    expect(out.singles.some((s) => s.id.startsWith('sub_'))).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { entries: Record<string, unknown> };
    expect(Object.keys(reg.entries).some((k) => k.includes('~') || k.startsWith('sub_'))).toBe(false);
  });

  it('meta/sessions 非 uuid 残留（title-request 历史误写）→ 装载对账剔除、list 不出', async () => {
    // 历史窗口的 title-request 对对桶键落过 meta/sessions/<a~b>.json——残留即幻影行源
    fs.mkdirSync(path.dirname(metaFile('admin~designer')), { recursive: true });
    fs.writeFileSync(metaFile('admin~designer'), JSON.stringify({ id: 'admin~designer', title: '残留标题', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), 'utf-8');
    const h = boot(false);
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(out.singles.some((s) => s.id === 'admin~designer')).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { entries: Record<string, unknown> };
    expect(reg.entries['admin~designer']).toBeUndefined();
  });

  it('title-request 对非 uuid 键 fail-loud（不落 meta）', async () => {
    seedLedger('admin~nana', [{ agent_id: 'user', content: '对桶' }]);
    const h = boot(true);
    await expect(h.send(titleRequest('admin~nana', '不该落的标题'))).rejects.toThrow(/非法/);
    expect(fs.existsSync(metaFile('admin~nana'))).toBe(false);
  });

  it('注册表历史污染条目（非 uuid 键在册）→ 装载重建剔除', async () => {
    // 旧宿主已落脏注册表：装载对账按 diskIds 重建——非 uuid 条目不在 diskIds 内即剔除
    fs.mkdirSync(path.dirname(metaFile(sidOf('k1'))), { recursive: true });
    const dirty = {
      version: 2,
      entries: {
        'admin~user': { size: 10, mtimeMs: 1, metaMtimeMs: 1, summary: { count: 1 }, view: { id: 'admin~user', agentId: 'admin', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } },
      },
    };
    fs.writeFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), JSON.stringify(dirty), 'utf-8');
    const h = boot(false);
    const out = await h.handlers.get('singles/list')!({}) as { singles: Array<{ id: string }> };
    expect(out.singles.some((s) => s.id === 'admin~user')).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'sessions', '.singles-registry.json'), 'utf-8')) as { entries: Record<string, unknown> };
    expect(reg.entries['admin~user']).toBeUndefined();
  });
});

