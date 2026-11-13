// ============================================================
// draft-single.test.ts —— 单例草稿态（cr-894 幻影壳层退役）board
// 服务面单测：startDraft（唯一草稿/偏好补位/零 RPC）/ dispatchDraft
//（首发签发 id + 失败留存同 id 重试 + 真值接管）/ discardDraft /
// 留存恢复 + 真值接管清理（cr-849 同义收敛）。
// 桩 = 真 cordis Context + 手挂最小 ClientContext 面（同款姿势）。
// ============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Context } from '@agentchat/cordis';
import { ref } from 'vue';

let SingleBoardService: typeof import('../client/index.ts').SingleBoardService;
let PENDING_SINGLE_ID: typeof import('../client/index.ts').PENDING_SINGLE_ID;
let loadPending: typeof import('../client/index.ts').loadPending;
let parkDraft: typeof import('ac-client-ui-conversation/client/draftParking.ts').parkDraft;
let takeDraft: typeof import('ac-client-ui-conversation/client/draftParking.ts').takeDraft;
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
/** singles/list 桩数据源（真值列表——对账用例填充） */
const boardTrueListRef = ref<Array<Record<string, unknown>>>([]);

function makeBoard() {
  const ctx = new Context() as unknown as Record<string, unknown>;
  const activeSingleId = ref('');
  ctx.sessions = {
    feed: { activeSingleId },
    chat: { setSingleContext: (id: string, agent: string) => { activeSingleId.value = id; }, clearSingleContext: () => { activeSingleId.value = ''; } },
    trackKnownSingle: () => undefined,
    pruneSingleUnread: () => undefined,
  };
  ctx.roster = { defaultPresetId: ref('__standard__') };
  ctx.rpc = {
    onEvent: () => () => undefined,
    onOpen: undefined,
    call: async (method: string, params: unknown) => {
      rpcCalls.push({ method, params: params as Record<string, unknown> });
      if (method === 'singles/list') return { singles: boardTrueListRef.value.map(s => s) };
      if (method === 'singles/create') return { single: { id: (params as Record<string, unknown>).id, status: 'active', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' } };
      if (method === 'singles/update') return { single: { ...(params as Record<string, unknown>) } };
      return {};
    },
  };
  const board = new SingleBoardService(ctx as never);
  return { board, activeSingleId };
}

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  const idx = await import('../client/index.ts');
  SingleBoardService = idx.SingleBoardService;
  PENDING_SINGLE_ID = idx.PENDING_SINGLE_ID;
  loadPending = idx.loadPending;
  const dp = await import('ac-client-ui-conversation/client/draftParking.ts');
  parkDraft = dp.parkDraft;
  takeDraft = dp.takeDraft;
  restoreDrafts = dp.restoreDrafts;
  clearParked = dp.__clearParkedForTest;
  restoreDrafts();
});

beforeEach(() => {
  storage.clear();
  clearParked();
  rpcCalls = [];
  boardTrueListRef.value = [];
});

describe('单例草稿态（cr-894）', () => {
  it('startDraft：零 RPC 即进入草稿位（哨兵 id 激活）；重复 start = 回到同一草稿（偏好补位不覆盖显式选择）', () => {
    const { board, activeSingleId } = makeBoard();
    const v = board.startDraft();
    expect(rpcCalls).toHaveLength(0);
    expect(v.id).toBe('__pending__');
    expect(activeSingleId.value).toBe(PENDING_SINGLE_ID);
    // 偏好补位（cr-850 同义）：agentId 首次随偏好进，再次 start 不覆盖显式改过的值
    board.startDraft({ agentId: 'alpha', model: 'gpt-x' });
    expect(board.pending.value).toMatchObject({ agentId: 'alpha', model: 'gpt-x' });
    board.updateSession(PENDING_SINGLE_ID, { agentId: 'beta' });
    expect(board.pending.value!.agentId).toBe('beta'); // 显式选择不回跳
    board.startDraft({ agentId: 'gamma' });
    expect(board.pending.value!.agentId).toBe('beta');
  });

  it('草稿不占列表行（activeSingles = 真值）；activeSingle 经哨兵可见；title 不从草稿正文派生（cr-937：正文预览不得顶掉「新会话」）', () => {
    const { board } = makeBoard();
    parkDraft('single:' + PENDING_SINGLE_ID, '第一行草稿');
    board.startDraft();
    expect(board.activeSingles.value).toHaveLength(0); // 不占行
    expect(board.activeSingle.value).not.toBeNull(); // 哨兵视图可见
    expect(board.activeSingle.value!.title ?? '').toBe(''); // 无派生 title——会话头回落「新会话」
  });

  it('dispatchDraft：首发签发 id；create 带同 id；成功后草稿退役 + 切到真值行', async () => {
    const { board, activeSingleId } = makeBoard();
    board.startDraft({ agentId: 'alpha', workspaceId: 'ws1' });
    await board.dispatchDraft();
    expect(rpcCalls.filter(c => c.method === 'singles/create')).toHaveLength(1);
    const created = rpcCalls.find(c => c.method === 'singles/create')!.params as Record<string, unknown>;
    expect(created.id).toMatch(/^[0-9a-f]{8}-/); // UUIDv7
    expect(created.agentId).toBe('alpha');
    expect(created.workspaceId).toBe('ws1');
    expect(board.pending.value).toBeNull(); // 草稿退役
    expect(activeSingleId.value).toBe(created.id); // 真值行接管
  });

  it('失败留存同 id 重试（幂等锚）：create 失败 → pendingId 不动 → 再发同 id', async () => {
    const { board } = makeBoard();
    board.startDraft();
    // 注入一次 create 失败
    const orig = (board as unknown as { own: { rpc: { call: (m: string, p: unknown) => Promise<unknown> } } }).own.rpc;
    let failOnce = true;
    const realCall = orig.call.bind(orig);
    orig.call = async (m: string, p: unknown) => {
      if (m === 'singles/create' && failOnce) {
        failOnce = false;
        rpcCalls.push({ method: m, params: p }); // 失败调用也入账（观察 id）
        throw new Error('网络闪断');
      }
      return realCall(m, p);
    };
    await expect(board.dispatchDraft()).rejects.toThrow();
    const id1 = board.pending.value?.pendingId;
    expect(id1).toMatch(/^[0-9a-f]{8}-/); // 失败留存
    await board.dispatchDraft(); // 重试
    const creates = rpcCalls.filter(c => c.method === 'singles/create');
    expect(creates).toHaveLength(2);
    expect((creates[1]!.params as Record<string, unknown>).id).toBe(id1); // 同 id
    expect(board.pending.value).toBeNull(); // 成功退役
  });

  it('留存恢复 + 真值接管清理：pendingId 已在服务端 → refresh 退役（cr-849 同义）', async () => {
    const { board } = makeBoard();
    board.startDraft({ agentId: 'alpha' });
    // 模拟：create 实际成功但响应丢失（pendingId 留存，服务端已有同 id 真值）
    await board.dispatchDraft().catch(() => undefined);
    // 直接构造：把 pendingId 写回并留存（等效失败窗口形态）
    const pid = rpcCalls.find(c => c.method === 'singles/create')?.params as Record<string, unknown> | undefined;
    board.pending.value = { agentId: '', ...(pid ? { pendingId: pid.id as string } : {}) };
    (board as unknown as { savePending: () => void }).savePending();
    // 服务端真值带上同 id
    boardTrueListRef.value = pid ? [{ id: pid.id, status: 'active', agentId: '', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' }] : [];
    await board.refresh();
    expect(board.pending.value).toBeNull(); // 真值接管清理
  });

  it('discardDraft：身份清空 + 草稿清位 + 退出草稿视角', () => {
    const { board, activeSingleId } = makeBoard();
    parkDraft('single:' + PENDING_SINGLE_ID, '半截话');
    board.startDraft();
    board.discardDraft();
    expect(board.pending.value).toBeNull();
    expect(loadPending()).toBeNull();
    expect(activeSingleId.value).toBe('');
  });

  it('updateSession 草稿分流：零 RPC 本地生效（物化时带上）', async () => {
    const { board } = makeBoard();
    board.startDraft();
    await board.updateSession(PENDING_SINGLE_ID, { agentId: 'alpha', model: 'gpt-x' });
    expect(rpcCalls).toHaveLength(0); // 草稿期零 RPC
    expect(board.pending.value).toMatchObject({ agentId: 'alpha', model: 'gpt-x' });
  });

  it('cr-937 串台防线：dispatchDraft 成功退役时清哨兵正文位——下一个新会话 takeDraft 哨兵键取空', async () => {
    const { board, activeSingleId } = makeBoard();
    board.startDraft();
    parkDraft('single:' + PENDING_SINGLE_ID, '会话 1 的首发正文'); // 模拟发送链 watcher/兜底回写哨兵键
    await board.dispatchDraft();
    expect(board.pending.value).toBeNull();
    expect(takeDraft('single:' + PENDING_SINGLE_ID)).toBe(''); // 哨兵位已清——新会话 2 不再串台
    expect(JSON.parse(storage.getItem('agentchat.drafts')!)).toEqual([]); // 留存层同步清
    expect(activeSingleId.value).toMatch(/^[0-9a-f]{8}-/); // 已切真值行
  });

  it('cr-937 串台防线：真值帧对账（mergeUpdate created）同样清哨兵正文位', async () => {
    const { board } = makeBoard();
    await board.refresh(); // 外部帧路径有未装载守卫（!loaded 提前返回）——真世界 board 恒已装载
    board.startDraft();
    const pid = (board.pending.value!.pendingId = '11111111-2222-3333-4444-555555555555'); // 模拟失败窗口留存
    parkDraft('single:' + PENDING_SINGLE_ID, '失败窗口的半截正文');
    // created 帧到达（create 实际成功但响应丢失的恢复路径）
    (board as unknown as { mergeUpdate: (m: unknown, a: string) => void }).mergeUpdate(
      { id: pid, status: 'active', agentId: '', createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' },
      'created',
    );
    expect(board.pending.value).toBeNull();
    expect(takeDraft('single:' + PENDING_SINGLE_ID)).toBe(''); // 哨兵位已清
  });

  it('cr-1058 哨兵对拍：conversation 内联副本（ChatInput）与 pending.ts 本体一致——防双源漂移', async () => {
    // conversation 侧字面量内联（跨包值导入会造 bundle 模块环——cr-1058 踩坑），
    // 漂移即门禁失效；此处静态对拍：读源断言内联值与本模块导出一致。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../../ac-client-ui-conversation/client/ChatInput.vue', import.meta.url)), 'utf8');
    expect(src).toContain("const PENDING_SINGLE_ID = '" + PENDING_SINGLE_ID + "'");
  });

  it('cr-1060 草稿派发判据对拍：ChatInput 发送面只认哨兵位（props.single.id === 哨兵），不认全局草稿态——切离草稿位后发送不得派发新会话', async () => {
    // 判据在 ChatInput.vue 发送面（send/sendNow）；此处静态对拍（与 cr-1058
    // 同款手法）：断言两处判据都带哨兵 id 比较——只看 isPending() 的旧判据
    // （props.single && isPending()）会在「草稿留存 + 切去其他会话」时把
    // 别的会话的发送误派发成新会话。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../../ac-client-ui-conversation/client/ChatInput.vue', import.meta.url)), 'utf8');
    expect((src.match(/props\.single\?\.id === PENDING_SINGLE_ID && singlesBoard\?\.isPending\(\)/g) ?? []).length).toBe(2);
    expect(src).not.toContain('props.single && singlesBoard?.isPending()');
  });

  it('cr-1058 草稿工作区三态：未选择（undefined）与显式未分组（\'\'）分流保留——门禁判据', async () => {
    const { board } = makeBoard();
    board.startDraft();
    // 未选择：键缺席（undefined）——fresh 门禁锁输入
    expect(board.pending.value?.workspaceId).toBeUndefined();
    expect(board.activeSingle.value?.workspaceId).toBeUndefined();
    // 显式选「未分组」：空串保留（不塌缩回 undefined）——门禁解除
    await board.updateSession(PENDING_SINGLE_ID, { workspaceId: '' });
    expect(board.pending.value?.workspaceId).toBe('');
    expect(board.activeSingle.value?.workspaceId).toBe('');
    // 留存往返：'' 不丢（loadPending 不再过滤空串）
    const restored = loadPending();
    expect(restored?.workspaceId).toBe('');
    // 挂指定工作区
    await board.updateSession(PENDING_SINGLE_ID, { workspaceId: 'ws1' });
    expect(board.pending.value?.workspaceId).toBe('ws1');
  });

  it('留存：刷新形态（新 board 实例）后 loadPending 恢复', () => {
    const { board } = makeBoard();
    board.startDraft({ agentId: 'alpha' });
    expect(storage.getItem('agentchat.pendingSingle')).toContain('alpha');
    expect(loadPending()?.agentId).toBe('alpha');
  });

  it('旧幻影留存迁移：agentchat.phantomSingles 数组 → 单例草稿态（身份 + 草稿正文键改哨兵）', async () => {
    // 预置旧形状：一个幻影 + 其草稿正文
    storage.setItem('agentchat.phantomSingles', JSON.stringify([{ id: 'old-uuid', agentId: 'alpha', model: 'm1', createdAt: '2026-11-01T00:00:00.000Z' }]));
    storage.setItem('agentchat.drafts', JSON.stringify([['single:old-uuid', '旧草稿正文']]));
    makeBoard(); // 构造器触发迁移
    expect(storage.getItem('agentchat.phantomSingles')).toBeNull(); // 旧键清除
    expect(loadPending()).toMatchObject({ agentId: 'alpha', model: 'm1' });
    expect(storage.getItem('agentchat.drafts')).toContain('__pending__'); // 正文键迁移
    expect(storage.getItem('agentchat.drafts')).not.toContain('old-uuid');
  });
});

describe('refresh 在途共享（cr-980 perf #4）', () => {
  it('refreshFlight 用例：并发 refresh 只发一趟 singles/list', async () => {
    const { board } = makeBoard();
    // 首轮装载（顺带把桩数据源置非空）
    boardTrueListRef.value = [{ id: 's1', status: 'active', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' }];
    await board.refresh();
    const callsBefore = rpcCalls.filter((c) => c.method === 'singles/list').length;
    await Promise.all([board.refresh(), board.refresh(), board.refresh()]);
    expect(rpcCalls.filter((c) => c.method === 'singles/list').length - callsBefore).toBe(1);
    // 航班落定后再次 refresh 正常新发
    await board.refresh();
    expect(rpcCalls.filter((c) => c.method === 'singles/list').length - callsBefore).toBe(2);
    expect(board.singles.value.map((s) => s.id)).toEqual(['s1']);
  });
});
