// ============================================================
// viewer-anchor-order.test.ts —— 首屏合并的未落盘 viewer 消息保护拷贝按时间戳
// 插入正确位置（2026-12「首条 user 消息跑到最后」错位修复）。
// 场景：run 空闲 + 后端 flush 延迟——viewer 行本地在、历史 incoming 缺，
// 但 incoming 已含更晚的 agent 收束行。尾部追加 = 错位；按 ts 插入 = 正确。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user' as never;

describe('mergeHistory viewer 保护拷贝插位', () => {
  it('run 空闲窗口：viewer 行缺失但更晚 agent 行在场 → 拷贝插到 agent 行前（非末尾）', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    // 本地态：viewer 首条（ts=1000）+ agent 回复（ts=2000，本地无——只有 viewer）
    // 模拟：本地已上屏 viewer 消息（发送后）；分区其余空
    feed.append(DIALOG, {
      id: 'local-u1', role: 'agent', content: '第一条用户消息', agent_id: 'user',
      timestamp: 1000,
    } as never);
    // 历史首屏 incoming：agent 收束行已落盘（ts=2000）——viewer 行 flush 未完成缺席
    const merged = feed.mergeHistory(DIALOG, [
      { id: 'h-a1', role: 'agent', content: '回复正文', agent_id: 'alpha', timestamp: 2000, persistedMsgId: 'ma1' },
    ] as never, true);
    expect(merged).toBeTruthy();
    const raw = feed.getRaw(DIALOG);
    // 顺序：viewer(1000) 在前，agent(2000) 在后——不是 [agent, viewer]
    expect(raw[0].agent_id).toBe('user');
    expect(raw[0].content).toBe('第一条用户消息');
    expect(raw[1].agent_id).toBe('alpha');
  });

  it('anchor 最新（无更晚行）→ 拷贝仍在尾部', () => {
    const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
    feed.append(DIALOG, {
      id: 'local-u2', role: 'agent', content: '最新提问', agent_id: 'user',
      timestamp: 5000,
    } as never);
    const merged = feed.mergeHistory(DIALOG, [
      { id: 'h-a2', role: 'agent', content: '旧回复', agent_id: 'alpha', timestamp: 2000, persistedMsgId: 'ma2' },
    ] as never, true);
    expect(merged).toBeTruthy();
    const raw = feed.getRaw(DIALOG);
    expect(raw[raw.length - 1].content).toBe('最新提问'); // anchor 最新 → 尾部正确
  });
});