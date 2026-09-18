// @vitest-environment jsdom
// ============================================================
// webui/tests/session-list-buckets.test.ts —— 会话列表工作区
// 「按时间分批展开」组件级验收（SessionList.vue）
//
// 覆盖（用户反馈两项优化）：
//   1. 工作区内会话按时间分桶（今天/一周/其他）分批展开——
//      首桶缺省展开、其余桶收起；点击桶头各自开合（不再一次
//      铺出全量「展开其余记录」）。
//   2. 工作区节点折叠后再展开，恢复缺省分批展开态（不记住
//      「展开全部」）。
//
// 手法：createApp + provide(CLIENT_CONTEXT_KEY, 桩 ctx)——
// 单测孤立挂载（无 runtime）。SessionList 经 useClientContext()
// 取 rpc/singleBoard/workspaceBoard/feedStore——桩 ctx 全部空面，
// 数据靠 singlesBoard.activeSingles / workspaceBoard.workspaces
// 喂入。桶边界用真实 Date.now（本地时区自然日——与实现同口径，
// 时刻点相对「现在」取偏移，不依赖具体日历日）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp, nextTick, provide, h, ref, type App } from 'vue';
import SessionList from 'ac-client-ui-singles/client/SessionList.vue';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

/** 单测桩：activeSingles 喂入会话数组（lastActivity 相对现在的天数偏移） */
function makeCtx(singles: Array<{ id: string; workspaceId?: string; daysAgo?: number }>) {
  const now = Date.now();
  const activeSingles = singles.map((s) => ({
    id: s.id,
    title: s.id,
    agentId: '',
    status: 'active',
    workspaceId: s.workspaceId ?? '',
    lastActivity: new Date(now - (s.daysAgo ?? 0) * 86_400_000).toISOString(),
    createdAt: new Date(now - (s.daysAgo ?? 0) * 86_400_000).toISOString(),
  }));
  return {
    rpc: null,
    singleBoard: {
      activeSingles: ref(activeSingles),
      activeSingleId: ref(''),
      refresh: () => Promise.resolve(),
      selectSingle: () => {},
      titleOf: (s: { title: string }) => s.title,
      create: () => Promise.resolve({ single: null }),
      createQuick: () => Promise.resolve({ single: null }),
      remove: () => Promise.resolve(),
    },
    workspaceBoard: {
      workspaces: ref([{ id: 'ws-a', name: '项目甲', path: 'C:/proj/a' }]),
      refresh: () => Promise.resolve(),
      create: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    },
  } as unknown as ClientContext;
}

let app: App | null = null;

async function mountSessionList(ctx: ClientContext): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  app = createApp({
    setup() {
      provide(CLIENT_CONTEXT_KEY, ctx);
      return () => h(SessionList);
    },
  });
  // pinia（feedStore）面：挂载前 install 桩（defineStore 需 active pinia）
  const { createPinia } = await import('pinia');
  app.use(createPinia());
  app.mount(root);
  await nextTick();
  return root;
}

beforeEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

function bucketHeads(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.bucket-head')];
}

function visibleSessionNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.ws-children .list-item .item-name')].map((el) => el.textContent ?? '');
}

describe('SessionList 工作区内会话按时间分批展开', () => {
  it('分桶呈现：桶头缺省只开首桶一页（5 条）、其余收起；桶头可开合', async () => {
    // today 桶 7 条：缺省只显前 5 + 「展开更多」闸门
    const ctx = makeCtx([
      { id: 't1', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't2', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't3', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't4', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't5', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't6', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't7', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 'y1', workspaceId: 'ws-a', daysAgo: 1 },
      { id: 'o1', workspaceId: 'ws-a', daysAgo: 45 },
    ]);
    const root = await mountSessionList(ctx);
    const heads = bucketHeads(root);
    expect(heads.map((h) => h.textContent)).toEqual(['今天7', '一周1', '其他1']);
    // 首桶（今天）缺省展开一页：前 5 条 + 展开更多闸门（2）
    expect(visibleSessionNames(root)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    const more = root.querySelector<HTMLElement>('.expand-more');
    expect(more?.textContent).toContain('2');
    // 点击「一周」桶头 → 展开一页
    heads[1].click();
    await nextTick();
    expect(visibleSessionNames(root)).toEqual(['t1', 't2', 't3', 't4', 't5', 'y1']);
    // 再点「今天」→ 收起
    heads[0].click();
    await nextTick();
    expect(visibleSessionNames(root)).toEqual(['y1']);
  });

  it('桶内分页：展开更多每次追加一页；桶头收起再开回一页（不记住展开很多）', async () => {
    const ctx = makeCtx([
      { id: 't1', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't2', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't3', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't4', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't5', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't6', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't7', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 't8', workspaceId: 'ws-a', daysAgo: 0 },
    ]);
    const root = await mountSessionList(ctx);
    expect(visibleSessionNames(root)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // 展开更多 → 追加一页（+3 条到 8 全显；闸门消失）
    root.querySelector<HTMLElement>('.expand-more')!.click();
    await nextTick();
    expect(visibleSessionNames(root)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    expect(root.querySelector('.expand-more')).toBeNull();
    // 桶头收起再开 → 回一页（不记住 8）
    const head = bucketHeads(root)[0];
    head.click(); await nextTick();
    head.click(); await nextTick();
    expect(visibleSessionNames(root)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('首桶顺延：无今天会话时首桶 = 一周（缺省展开一页）', async () => {
    const ctx = makeCtx([
      { id: 'w1', workspaceId: 'ws-a', daysAgo: 1 },
      { id: 'o1', workspaceId: 'ws-a', daysAgo: 10 },
    ]);
    const root = await mountSessionList(ctx);
    expect(bucketHeads(root).map((h) => h.textContent)).toEqual(['一周1', '其他1']);
    expect(visibleSessionNames(root)).toEqual(['w1']);
  });

  it('折叠重置：工作区节点折叠→再展开，桶展开态与分页进度回缺省', async () => {
    const ctx = makeCtx([
      { id: 't1', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 'y1', workspaceId: 'ws-a', daysAgo: 1 },
      { id: 'o1', workspaceId: 'ws-a', daysAgo: 60 },
    ]);
    const root = await mountSessionList(ctx);
    // 展开全部桶
    for (const head of bucketHeads(root)) {
      if (head.getAttribute('aria-expanded') === 'false') head.click();
    }
    await nextTick();
    expect(visibleSessionNames(root)).toEqual(['t1', 'y1', 'o1']);
    // 折叠工作区节点（.ws-node 首个 = 项目甲）
    root.querySelector<HTMLElement>('.ws-node')!.click();
    await nextTick();
    expect(root.querySelectorAll('.ws-children').length).toBe(0); // 已折叠
    // 再展开 → 恢复缺省分批态（只有首桶一页）
    root.querySelector<HTMLElement>('.ws-node')!.click();
    await nextTick();
    expect(visibleSessionNames(root)).toEqual(['t1']);
    // 桶头仍在（其余桶可再点击）
    expect(bucketHeads(root).length).toBe(3);
  });

  it('单桶组（全部会话同桶 ≤ 一页）无分页闸门：缺省全显', async () => {
    const ctx = makeCtx([
      { id: 'a', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 'b', workspaceId: 'ws-a', daysAgo: 0 },
    ]);
    const root = await mountSessionList(ctx);
    expect(bucketHeads(root).map((h) => h.textContent)).toEqual(['今天2']);
    expect(visibleSessionNames(root)).toEqual(['a', 'b']);
    expect(root.querySelector('.expand-more')).toBeNull();
  });

  it('未分组会话同样分桶分页（固定根与工作区同规则）', async () => {
    const ctx = makeCtx([
      { id: 'u1', daysAgo: 0 },
      { id: 'u2', daysAgo: 20 },
    ]);
    const root = await mountSessionList(ctx);
    // 未分组根出现在末尾，含分桶
    const groups = [...root.querySelectorAll<HTMLElement>('.ws-node')];
    expect(groups.map((g) => g.textContent)).toContain('未分组');
    expect(bucketHeads(root).map((h) => h.textContent)).toEqual(['今天1', '其他1']);
    expect(visibleSessionNames(root)).toEqual(['u1']);
  });
});

describe('SessionList 标题搜索', () => {
  /** 搜索态结果行标题（.search-results 内——树选择器不含搜索结果） */
  function searchNames(root: HTMLElement): string[] {
    return [...root.querySelectorAll('.search-results .list-item .item-name')].map((el) => el.textContent ?? '');
  }

  async function setSearch(root: HTMLElement, q: string) {
    const input = root.querySelector<HTMLInputElement>('.search-input')!;
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
  }

  it('输入关键字：树/桶让位扁平结果（跨工作区含未分组，按最近活动降序），行带归属副标', async () => {
    const ctx = makeCtx([
      { id: 'api-设计', workspaceId: 'ws-a', daysAgo: 0 },
      { id: '别的会话', workspaceId: 'ws-a', daysAgo: 0 },
      { id: 'api-重构', daysAgo: 2 }, // 未分组
    ]);
    const root = await mountSessionList(ctx);
    await setSearch(root, 'api');
    expect(root.querySelectorAll('.ws-node').length).toBe(0);   // 树让位
    expect(root.querySelectorAll('.bucket-head').length).toBe(0); // 桶让位
    expect(searchNames(root)).toEqual(['api-设计', 'api-重构']); // 不匹配的被滤掉
    const subs = [...root.querySelectorAll('.item-sub')].map((el) => el.textContent ?? '');
    expect(subs[0]).toContain('项目甲'); // 归属副标 = 工作区名
    expect(subs[1]).toContain('未分组');
  });

  it('无匹配：空态提示含关键字', async () => {
    const root = await mountSessionList(makeCtx([{ id: 't1', workspaceId: 'ws-a' }]));
    await setSearch(root, '不存在');
    expect(searchNames(root)).toEqual([]);
    expect(root.querySelector('.empty')?.textContent).toContain('不存在');
  });

  it('清空/ Esc 回树视图（分桶恢复）', async () => {
    const root = await mountSessionList(makeCtx([{ id: 't1', workspaceId: 'ws-a', daysAgo: 0 }]));
    await setSearch(root, 't1');
    expect(root.querySelectorAll('.ws-node').length).toBe(0);
    await setSearch(root, '');
    expect(root.querySelectorAll('.ws-node').length).toBe(1);
    expect(visibleSessionNames(root)).toEqual(['t1']);
    // Esc 直接清空
    await setSearch(root, 't');
    root.querySelector<HTMLInputElement>('.search-input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(root.querySelectorAll('.ws-node').length).toBe(1);
  });
});
