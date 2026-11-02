// ============================================================
// ac-client-ui-singles/tests/phantom-singles.test.ts ——
// 幻影会话（延迟落盘，cr-847）board 服务面单测：
// createPhantom（本地签发/复用防堆积/激活）/ materialize（同 id 物化 +
// 幻影退役）/ updateSession 本地分流 / 留存恢复（localStorage）。
// 桩 = 真 cordis Context + 手挂最小 ClientContext 面（rpc/sessions/roster）。
// ============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ref } from 'vue';

// 动态 import：index.ts/draftParking.ts 在模块加载时捕获 globalThis.localStorage——
// 桩须先注入（compose-prefs.test.ts 同款姿势）
let SingleBoardService: typeof import('../client/index.ts').SingleBoardService;
let loadPhantoms: typeof import('../client/index.ts').loadPhantoms;
let parkDraft: typeof import('ac-client-ui-conversation/client/draftParking.ts').parkDraft;
let restoreDrafts: typeof import('ac-client-ui-conversation/client/draftParking.ts').restoreDrafts;
let clearParked: typeof import('ac-client-ui-conversation/client/draftParking.ts').__clearParkedForTest;

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

let storage: MemoryStorage;
let rpcCalls: Array<{ method: string; params: unknown }>;
let created: Array<{ id: string; params: unknown }>;
/** singles/list 桩数据源（真值列表——残留对账用例填充） */
const boardTrueListRef = ref<Array<Record<string, unknown>>>([]);

function makeBoard() {
  const ctx = new Context() as unknown as Record<string, unknown>;
  // sessions 面：feed.activeSingleId + chat.setSingleContext + track + prune
  const activeSingleId = ref('');
  const ctxCalls: string[] = [];
  ctx.sessions = {
    feed: { activeSingleId },
    chat: { setSingleContext: (id: string, agent: string) => { ctxCalls.push('ctx:' + id + ':' + agent); activeSingleId.value = id; }, clearSingleContext: () => { activeSingleId.value = ''; } },
    trackKnownSingle: () => undefined,
    pruneSingleUnread: () => undefined,
  };
  ctx.roster = { defaultPresetId: ref('__standard__') };
  ctx.rpc = {
    onEvent: () => () => undefined,
    onOpen: undefined,
    call: async (method: string, params: unknown) => {
      rpcCalls.push({ method, params: params as Record<string, unknown> });
      if (method === 'singles/list') {
        return { singles: (boardTrueListRef.value as unknown[]).map(s => s) };
      }
      if (method === 'singles/create') {
        const id = (params as Record<string, unknown>).id as string;
        created.push({ id, params });
        return { single: { id, agentId: (params as Record<string, unknown>).agentId ?? '', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } };
      }
      if (method === 'singles/update') return { single: { ...(params as Record<string, unknown>) } };
      return {};
    },
  };
  const board = new SingleBoardService(ctx as never);
  return { board, activeSingleId, ctxCalls };
}

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  const idx = await import('../client/index.ts');
  SingleBoardService = idx.SingleBoardService;
  loadPhantoms = idx.loadPhantoms;
  const dp = await import('ac-client-ui-conversation/client/draftParking.ts');
  parkDraft = dp.parkDraft;
  restoreDrafts = dp.restoreDrafts;
  clearParked = dp.__clearParkedForTest;
  restoreDrafts();
});

beforeEach(() => {
  storage.clear();
  clearParked();
  rpcCalls = [];
  created = [];
  boardTrueListRef.value = [];
});

describe('幻影会话（cr-847 延迟落盘）', () => {
  it('createPhantom：本地签发零 RPC；立即激活；单幻影唯一（cr-848——配置不参与复用判定）', () => {
    const { board, activeSingleId } = makeBoard();
    const p1 = board.createPhantom();
    expect(rpcCalls).toHaveLength(0); // 零往返
    expect(p1.id).toMatch(/^[0-9a-f]{8}-/); // UUIDv7 形状
    expect(activeSingleId.value).toBe(p1.id);
    expect(board.isPhantom(p1.id)).toBe(true);
    // 再建（无参）= 复用同一幻影——连点新增不堆积
    const p2 = board.createPhantom();
    expect(p2.id).toBe(p1.id);
    expect(board.phantoms.value).toHaveLength(1);
    // 从另一工作区发起 = 仍复用（只重挂，id 不变——草稿零迁移）
    const p3 = board.createPhantom({ workspaceId: 'ws1' });
    expect(p3.id).toBe(p1.id);
    expect(board.phantoms.value).toHaveLength(1);
    expect(board.phantoms.value[0]).toMatchObject({ workspaceId: 'ws1' });
  });

  it('偏好继承（cr-850）：agentId/model 随创建进幻影元数据（显示+物化落盘的数据源）', () => {
    const { board } = makeBoard();
    const p = board.createPhantom({ agentId: 'alpha', model: 'gpt-x' });
    expect(board.phantoms.value[0]).toMatchObject({ agentId: 'alpha', model: 'gpt-x' });
    const view = board.allSingles.value.find(s => s.id === p.id)!;
    expect(view.model).toBe('gpt-x'); // syncDraft 显示源
    // 用户已显式选过（model 有值）→ 尊重不覆盖
    board.createPhantom({ model: 'other' });
    expect(board.phantoms.value[0]!.model).toBe('gpt-x');
    // 空缺补位：无 model 的幻影在复用时从偏好补
    const b2 = makeBoard();
    const q = b2.board.createPhantom();
    b2.board.createPhantom({ model: 'gpt-y' });
    expect(b2.board.phantoms.value[0]).toMatchObject({ model: 'gpt-y' });
    expect(q.id).toBe(b2.board.phantoms.value[0]!.id);
  });

  it('连点新增 N 次 = 恒 1 个幻影（含中途改过 Agent/模型的场景——配置不参与判定）', () => {
    const { board } = makeBoard();
    for (let i = 0; i < 5; i++) {
      const p = board.createPhantom(i === 2 ? { agentId: 'alpha' } : i === 3 ? { model: 'gpt-x' } : {});
      expect(board.phantoms.value).toHaveLength(1);
      expect(p.id).toBe(board.phantoms.value[0]!.id);
    }
  });

  it('草稿派生 title：幻影视图显示草稿首行（截断 24 字）', () => {
    const { board } = makeBoard();
    const p = board.createPhantom();
    parkDraft('single:' + p.id, '第一行会变成标题\n第二行不显示');
    const view = board.allSingles.value.find(s => s.id === p.id)!;
    expect(view.title).toBe('第一行会变成标题');
    // 清草稿 → title 回落（列表回到「新会话」显示）
    parkDraft('single:' + p.id, '');
    const view2 = board.allSingles.value.find(s => s.id === p.id)!;
    expect(view2.title).toBeUndefined();
  });

  it('materialize：singles/create 带同 id；幻影退役；真值接管；重复调用幂等', async () => {
    const { board, activeSingleId } = makeBoard();
    const p = board.createPhantom({ agentId: 'alpha', workspaceId: 'ws1' });
    const out = await board.materialize(p.id);
    expect(out!.id).toBe(p.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toMatchObject({ id: p.id, agentId: 'alpha', workspaceId: 'ws1' });
    expect(board.isPhantom(p.id)).toBe(false); // 退役
    expect(activeSingleId.value).toBe(p.id); // 仍激活（无缝）
    // 再 materialize（非幻影）= 直接返回真值，不重复 RPC
    const again = await board.materialize(p.id);
    expect(again!.id).toBe(p.id);
    expect(created).toHaveLength(1);
  });

  it('updateSession 幻影分流：设置本地生效（零 RPC），物化时带上', async () => {
    const { board } = makeBoard();
    const p = board.createPhantom();
    await board.updateSession(p.id, { agentId: 'alpha', model: 'gpt-x' });
    expect(rpcCalls).toHaveLength(0); // 幻影期零 RPC
    expect(board.phantoms.value[0]).toMatchObject({ agentId: 'alpha', model: 'gpt-x' });
    // 物化：agentId 随创建带上；model 走 update
    await board.materialize(p.id);
    const createParams = created[0]!.params as Record<string, unknown>;
    expect(createParams.agentId).toBe('alpha');
    expect(rpcCalls.some(c => c.method === 'singles/update')).toBe(true);
  });

  it('留存：刷新形态（新 board 实例）后 loadPhantoms 恢复 + 幻影行可见', () => {
    const { board } = makeBoard();
    const p = board.createPhantom({ agentId: 'alpha' });
    expect(storage.getItem('agentchat.phantomSingles')).toContain(p.id);
    // 刷新形态：新实例读留存
    const restored = loadPhantoms();
    expect(restored.find(x => x.id === p.id)?.agentId).toBe('alpha');
  });

  it('残留幻影对账（cr-849）：留存恢复的幻影遇服务端同 id 真值 → refresh 退役（列表双行/新增恒复用的根修）', async () => {
    // 场景：上次会话物化后浏览器刷新，摘除事件丢失——localStorage 留存里幻影还在
    const { board } = makeBoard();
    const p = board.createPhantom();
    board.phantoms.value = []; // 模拟「内存层已摘」
    // 服务端真值到位（物化已发生——singles/list 会带回同 id）
    boardTrueListRef.value = [
      { id: p.id, status: 'active', agentId: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ];
    // 刷新形态：内存幻影空 → 从留存恢复（旧代码恢复在对账后 → 残留躲过校验）
    await board.refresh();
    expect(board.isPhantom(p.id)).toBe(false); // 恢复的幻影被真值对账退役
  });

  it('archive/remove 幻影 = 本地清除零 RPC（草稿位同清）', async () => {
    const { board, activeSingleId } = makeBoard();
    const p = board.createPhantom();
    parkDraft('single:' + p.id, '草稿');
    await board.remove(p.id);
    expect(rpcCalls).toHaveLength(0);
    expect(board.phantoms.value).toHaveLength(0);
    expect(activeSingleId.value).toBe(''); // 退出
  });
});
