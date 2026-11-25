// ============================================================
// local-turn-key.test.ts —— cr-1319 B1a 用户本地行出生带键
//
// 验证目标：sendMessage 本地乐观行 id = requestId = turnId（客户端铸造
// 单源）——纯直播窗口用户轮按键分组（keyedMiss 不触发）；run 收束重拉
// 后权威用户行 message_id/turnId 同值（fold 投影用户行 turnId =
// message_id——mergeHistoryPage 换身键恒等，轮边界不跳变）。
// ============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');
let feedMod: typeof import('../client/feed.ts');
let chatOps: typeof import('../client/chatOps.ts');
let probesMod: typeof import('../client/fallback-probes.ts');

// single 会话键 = uuid 形（isUuidKey 词法闸——非 uuid 形不进 knownSingles）
const SID = '0e5a1319-0000-4000-8000-000000000001';
const DIALOG = 'single:' + SID;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
  feedMod = await import('../client/feed.ts');
  chatOps = await import('../client/chatOps.ts');
  probesMod = await import('../client/fallback-probes.ts');
  probesMod.resetFallbackProbes();
  chatOps.chatPresence.knownSingles.add(SID);
});

const delivered: Array<Record<string, unknown>> = [];
const rpc = {
  call(method: string, args?: unknown) {
    if (method === 'conversation/deliver') { delivered.push((args ?? {}) as Record<string, unknown>); }
    return Promise.resolve(method === 'session/history' ? { records: [], hasMore: false } : {});
  },
  onEvent: () => () => undefined,
};

async function newChat() {
  const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
  const { reactive } = await import('vue');
  const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => new RosterCore());
  core.setSingleContext(SID, 'alpha');
  return { feed, core };
}

describe('cr-1319 B1a 本地行出生带键', () => {
  it('sendMessage：本地行 id = requestId = turnId（同一铸造值）', async () => {
    delivered.length = 0;
    const { feed, core } = await newChat();
    core.sendMessage('问一件事');
    const raw = feed.getRaw(DIALOG as never);
    const local = raw.find((m: any) => m.agent_id === 'user');
    expect(local).toBeTruthy();
    expect(typeof local!.id).toBe('string');
    expect(local!.id.startsWith('send-')).toBe(true);
    expect((local as any).turnId).toBe(local!.id);
    // deliver 收到的 requestId = 同一值（本地行与投递幂等键单源）
    expect(delivered.length).toBeGreaterThan(0);
    const req = delivered.at(-1)!.requestId;
    expect(req).toBe(local!.id);
  });

  it('纯直播窗口：用户轮 turnId 恒定 + agent 步行按键并轮（keyedMiss 不触发）', async () => {
    probesMod.resetFallbackProbes();
    const { feed, core } = await newChat();
    core.sendMessage('问');
    // run 步行（delta 惰性建卡——cr-1289 键驻留）
    feed.ingestFrame('llm/delta', [{
      model: 'm',
      meta: { agent: 'alpha', conversationId: SID, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' },
    }, { delta: '答' }]);
    const raw = feed.getRaw(DIALOG as never);
    const turns = feedMod.buildTurns(raw, false);
    expect(turns).toHaveLength(2);
    // 用户轮 turnId = 本地行 id（键装配）
    const userTurn = turns.find((t: any) => t.agent_id === 'user');
    const local = raw.find((m: any) => m.agent_id === 'user');
    expect(userTurn?.turnId).toBe(local!.id);
    // agent 轮 turnId = run（fold 投影同语义）
    const agentTurn = turns.find((t: any) => t.agent_id === 'alpha');
    expect(agentTurn?.turnId).toBe('r1');
    // 用户本地行出生带键——探针面无计数（tgf 键已随 cr-1321 判据退役）
  });

  it('收束换身恒等：权威用户行 message_id = 本地铸造值——合并后同键并轮不跳变', async () => {
    const { feed, core } = await newChat();
    core.sendMessage('问');
    // run 已收束（无流式占位）——首屏整体替换 + 本地行保护拷贝路径
    feed.ensureById(DIALOG as never).streaming = false;
    const dlg = feed.getDialog(DIALOG as never)!;
    const local = (dlg.rawMessages as any[]).find(m => m.agent_id === 'user');
    const rid = local.id;
    // delta 步卡残留先收口（streaming=false 后仍在——切会话保护路径的原形态）
    // 收束重拉首屏页：权威用户行（message_id = rid，fold 投影 turnId = message_id）
    // + agent 收束行（run 承载 turnId = run）
    feed.mergeHistory(DIALOG as never, [
      { id: rid, role: 'agent', content: '问', agent_id: 'user', message_id: rid, timestamp: local.timestamp, turnId: rid },
      { id: 'reply-1', role: 'agent', content: '答', agent_id: 'alpha', message_id: 'reply-1', timestamp: local.timestamp + 1000, runId: 'r1', turnId: 'r1', steps: [] },
    ] as never, true);
    const merged = feed.getRaw(DIALOG as never);
    // 用户行恰一条（本地行被权威行换身 / 或保留——内容同源不双投）
    const users = merged.filter((m: any) => m.agent_id === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.id.startsWith('send-')).toBe(true);
    // 键恒等：换身后 turnId 仍是本地铸造值（轮 key 不跳变）
    expect((users[0] as any).turnId).toBe(rid);
    // buildTurns：用户轮 + agent 轮，边界与纯直播一致
    const turns = feedMod.buildTurns(merged, false);
    const userTurn = turns.find((t: any) => t.agent_id === 'user');
    const agentTurn = turns.find((t: any) => t.agent_id === 'alpha');
    expect(userTurn?.turnId).toBe(rid);
    expect(agentTurn?.turnId).toBe('r1');
  });
});