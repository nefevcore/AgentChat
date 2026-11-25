// ============================================================
// feed-view-mode-reset.test.ts —— 切档清场（cr-1331）
//
// 换投影 = 换血：首屏只拉 HISTORY_PAGE_SIZE 条，其余靠 mergeHistory 保留
// 本地行——不先清场会让轨迹档带 steps 的行残留在 IM 档（折叠链照显）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
beforeAll(async () => { feedCore = await import('../client/feed-core.ts'); });

function spyRpc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return { calls, call: async (m: string, p: Record<string, unknown>) => { calls.push({ method: m, params: p }); return m === 'session/history' ? { records: [] } : {}; }, onEvent: () => {}, onOpen: undefined };
}
const DIRECT = 'pair:alpha|user';

describe('cr-1331：切档清场', () => {
  it('toggleViewMode 清空旧投影行（带 steps 的轨迹行不残留到 IM 档）', async () => {
    const rpc = spyRpc();
    const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
    const d = feed.ensureById(DIRECT as never);
    // 造两条 trace 档行：一条带 steps（折叠链载体）、一条普通
    feed.append(DIRECT as never, { id: 'm1', role: 'agent', content: '带轨迹', timestamp: Date.now(), agent_id: 'alpha', steps: [] } as never);
    feed.append(DIRECT as never, { id: 'm2', role: 'agent', content: '普通', timestamp: Date.now(), agent_id: 'alpha' } as never);
    expect(feed.getRaw(DIRECT as never).length).toBe(2);
    feed.toggleViewMode(DIRECT as never);
    expect(feed.getDialog(DIRECT as never)!.viewMode).toBe('im');
    // 清场：旧行全掉（首屏重建由 RPC 响应驱动）
    expect(feed.getRaw(DIRECT as never).length).toBe(0);
    await new Promise((r) => setTimeout(r, 900));
  });
});
