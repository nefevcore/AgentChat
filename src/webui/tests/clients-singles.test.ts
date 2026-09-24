// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-singles.test.ts —— singles 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-singles/client（D19 改裁——前端
// 行独立包；协调走服务面互调：ctx.sessions.chat / feed +
// ctx.roster.defaultPresetId）。「域投影 + ctx.singleBoard 服务面」+
// 可摘除性（D19）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { type Fiber } from 'ac-client-runtime';
import { singlesClientPlugin } from 'ac-client-ui-singles/client';
import { rosterClientPlugin } from 'ac-client-ui-agents/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { makeRpcStub } from './lib/rpcStub';

/** 域行 client 装载前提：rpc 桩 + conversation（sessions）+ roster */
async function bootDomainRuntime() {
  const boot = await bootWebuiRuntime(makeRpcStub().impl);
  await boot.ctx.plugin(rosterClientPlugin);
  return boot;
}

describe('S3-1b · singles 域行 client（域投影 + ctx.singleBoard 服务面）', () => {
  it('服务装载：ctx.singleBoard 可解析；列表/激活态派生（activeSingles 过滤归档）', async () => {
    const boot = await bootDomainRuntime();
    const fiber: Fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    expect(board).toBeDefined();
    expect(board.singles.value).toEqual([]);
    expect(board.loaded.value).toBe(false);

    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: 1 } as never,
      { id: 's2', status: 'archived', agentId: '', title: 'B', createdAt: 2 } as never,
    ];
    expect(board.activeSingles.value.map((s) => s.id)).toEqual(['s1']);
    expect(board.titleOf({ agentId: '', title: '' } as never, () => '?')).toBe('新会话');
    await fiber.dispose();
  });

  it('上下文协调（服务面互调）：selectSingle → sessions.chat.setSingleContext + feed 活跃分区派生', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: 1 } as never,
    ];
    board.selectSingle('s1');
    // feed 活跃分区派生（activeSingleId 唯一事实源在会话服务）
    expect(board.activeSingleId.value).toBe('s1');
    expect(boot.ctx.sessions.feed.activeSingleId.value).toBe('s1');
    board.deselectSingle();
    expect(board.activeSingleId.value).toBe('');
    await fiber.dispose();
  });

  it('可摘除性（D19）：fiber dispose → ctx.singleBoard 消失 + 帧订阅回收', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(boot.ctx.singleBoard).toBeDefined();
    await fiber.dispose();
    expect((boot.ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.singleBoard = undefined（列表空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 singles 域件
    expect((ctx as { singleBoard?: unknown }).singleBoard).toBeUndefined();
  });

  it('M28 P0-2 · single 视角出厂贡献：装载 → main:perspective 含 single；卸载 → 消失', async () => {
    const boot = await bootDomainRuntime();
    const ids = () => boot.ctx.slots.entries('main:perspective').map((e) => e.id);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(ids()).toContain('single');
    await fiber.dispose();
    expect(ids()).not.toContain('single');
  });

  it('M28 P2 · sessions 会话列表面板贡献：装载 → primary-sidebar:domain 含 sessions 面板；卸载 → 消失', async () => {
    const boot = await bootDomainRuntime();
    const panelOf = (id: string) => boot.ctx.slots.entries('primary-sidebar:domain').find((e) => e.meta?.panel === id);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    expect(panelOf('sessions')?.id).toBe('webui-domain-singles.panel');
    await fiber.dispose();
    expect(panelOf('sessions')).toBeUndefined();
  });

  it('重连即刷：loaded 后 WS 重连（onOpen）→ refresh 补拉（断线丢 singles/updated 帧的补偿位）', async () => {
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    await board.refresh();
    const before = stub.seen.filter(([m]) => m === 'singles/list').length;
    expect(before).toBeGreaterThan(0);
    stub.reopen(); // 模拟重连
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.seen.filter(([m]) => m === 'singles/list').length).toBe(before + 1);
    await fiber.dispose();
  });

  // ── 启动进入 single 会话（openDefaultSingle 三级回落）──

  it('首启无上下文记录 + 已有会话 → 选中最近活跃会话（lastActivity 最新者优先）', async () => {
    localStorage.clear(); // 首启语义：无 lastContext / primaryPanel 记录
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 'old', status: 'active', agentId: '', title: '旧', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never,
      { id: 'recent', status: 'active', agentId: '', title: '新', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', lastActivity: '2026-03-01T00:00:00Z' } as never,
    ];
    const entered = await board.openDefaultSingle();
    expect(entered).toBe('recent');
    expect(board.activeSingleId.value).toBe('recent');
    await fiber.dispose();
  });

  it('首启无上下文记录 + 列表为空 → 快速创建空白会话并进入（reuse 通道）', async () => {
    localStorage.clear();
    const stub = makeRpcStub();
    // 有状态桩（对齐真实后端：create 入册，list 回显——create() 内 refresh
    // 后 selectSingle 依赖列表含新会话）
    const store: Array<Record<string, unknown>> = [];
    stub.impl.call = async (method: string, params?: unknown) => {
      stub.seen.push([method, params]);
      if (method === 'singles/create') {
        const single = { id: 'fresh', status: 'active', agentId: '', createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z' };
        store.push(single);
        return { single };
      }
      if (method === 'singles/list') return { singles: store };
      return {};
    };
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    await board.refresh();
    const entered = await board.openDefaultSingle();
    expect(stub.seen.some(([m, p]) => m === 'singles/create' && (p as { reuse?: boolean })?.reuse === true)).toBe(true);
    expect(entered).toBe('fresh');
    expect(board.activeSingleId.value).toBe('fresh');
    await fiber.dispose();
  });

  it('上次在独立会话（lastContext single 记录）→ 原恢复语义（openDefaultSingle 复用 restoreLastSingle）', async () => {
    localStorage.clear();
    localStorage.setItem('agentchat.lastContext', JSON.stringify({ kind: 'single', id: 'keep' }));
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 'keep', status: 'active', agentId: '', title: 'K', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never,
      { id: 'newer', status: 'active', agentId: '', title: 'N', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' } as never,
    ];
    const entered = await board.openDefaultSingle();
    expect(entered).toBe('keep'); // 恢复优先于「最近活跃」
    expect(board.activeSingleId.value).toBe('keep');
    await fiber.dispose();
  });

  it('上次在 Agent/群（lastContext 非 single 记录）→ 不抢上下文（尊重既有恢复链）', async () => {
    localStorage.clear();
    localStorage.setItem('agentchat.lastContext', JSON.stringify({ kind: 'agent', id: 'alpha' }));
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never,
    ];
    const entered = await board.openDefaultSingle();
    expect(entered).toBeNull();
    expect(board.activeSingleId.value).toBe('');
    await fiber.dispose();
  });

  // ── 增量合并（2026-12 卡顿优化：singles/updated 帧本地 upsert，零 refresh）──

  it('created 帧 → 新条目插到列表最前；零 RPC（不触发 singles/list）', async () => {
    localStorage.clear();
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never,
    ];
    board.loaded.value = true; // 已装载（冷启动首帧忽略语义）
    const listCallsBefore = stub.seen.filter(([m]) => m === 'singles/list').length;
    stub.emit('singles/updated',
      { id: 's2', status: 'active', agentId: '', title: 'B', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' },
      'created');
    expect(board.singles.value.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(stub.seen.filter(([m]) => m === 'singles/list').length).toBe(listCallsBefore); // 零 refresh
    await fiber.dispose();
  });

  it('updated 帧（标题生成）→ 原地替换且保留 lastActivity；removed 帧 → 摘除', async () => {
    localStorage.clear();
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: '旧标题', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastActivity: '2026-03-01T00:00:00Z' } as never,
      { id: 's2', status: 'active', agentId: '', title: 'B', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' } as never,
    ];
    board.loaded.value = true;
    stub.emit('singles/updated',
      { id: 's1', status: 'active', agentId: '', title: '自动生成的新标题', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' },
      'updated');
    const s1 = board.singles.value.find((s) => s.id === 's1') as { title?: string; lastActivity?: string };
    expect(s1.title).toBe('自动生成的新标题');
    expect(s1.lastActivity).toBe('2026-03-01T00:00:00Z'); // 帧不带——沿用旧值
    stub.emit('singles/updated',
      { id: 's2', status: 'active', agentId: '', title: 'B', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      'removed');
    expect(board.singles.value.map((s) => s.id)).toEqual(['s1']);
    await fiber.dispose();
  });

  it('archived 帧 → status 终值合并，activeSingles 视图即时消失', async () => {
    localStorage.clear();
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    board.singles.value = [
      { id: 's1', status: 'active', agentId: '', title: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as never,
    ];
    board.loaded.value = true;
    stub.emit('singles/updated',
      { id: 's1', status: 'archived', agentId: '', title: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-03T00:00:00Z' },
      'archived');
    expect(board.singles.value[0].status).toBe('archived'); // 全量列表保留（可查归档）
    expect(board.activeSingles.value).toEqual([]); // 视图过滤即时生效
    await fiber.dispose();
  });

  it('未装载（冷启动首帧先于首次 fetch）→ 忽略（避免空列表上合并残缺快照）', async () => {
    localStorage.clear();
    const stub = makeRpcStub();
    const boot = await bootWebuiRuntime(stub.impl);
    await boot.ctx.plugin(rosterClientPlugin);
    const fiber = await boot.ctx.plugin(singlesClientPlugin);
    const board = boot.ctx.singleBoard;
    expect(board.loaded.value).toBe(false);
    stub.emit('singles/updated',
      { id: 'sX', status: 'active', agentId: '', title: 'X', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      'created');
    expect(board.singles.value).toEqual([]); // 未装载不合并
    await fiber.dispose();
  });
});
