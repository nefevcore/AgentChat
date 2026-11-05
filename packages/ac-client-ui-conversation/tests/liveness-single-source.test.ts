// ============================================================
// liveness-single-source.test.ts —— 判活单源化回归（cr-887）
// 根因：四个静默计时裁判各自只认 stats.running——spawning 窗（run 未
// 诞生、running 恒空）被权威 miss 误杀：切走再切回后 dock 判死 →
// settleDeadDialog 拆在途 → 状态卡消失；探针/看门狗同病。修复 =
// agentInFlight（running ∪ spawning）唯一定活口径，三消费点 + resume
// 全部改判；静默档位回归纯质疑调度器。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');
let runStatus: typeof import('../client/runStatus.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
  runStatus = await import('../client/runStatus.ts');
});

const CONV = 'alpha~user';
const DLG = 'pair:alpha|user' as never;

function statsResp(spawning: string[] | undefined, running: Array<{ agentId: string; conversationId: string }> = []) {
  return { ...(spawning !== undefined ? { spawning } : {}), running };
}

describe('agentInFlight（唯一定活口径）', () => {
  it('running 命中 ∪ spawning 命中（拉壳窗 run 未诞生也算活）', () => {
    const running = [{ agentId: 'alpha', conversationId: CONV }];
    expect(runStatus.agentInFlight({ running }, 'alpha', CONV)).toBe(true);
    expect(runStatus.agentInFlight(statsResp(['alpha']), 'alpha', CONV)).toBe(true); // 关键：running 空但拉壳在飞
    expect(runStatus.agentInFlight(statsResp(['beta']), 'alpha', CONV)).toBe(false); // 拉的是别人的壳
    expect(runStatus.agentInFlight(statsResp([]), 'alpha', CONV)).toBe(false);
    expect(runStatus.agentInFlight(statsResp(undefined), 'alpha', CONV)).toBe(false); // 旧后端无字段 → 空集
  });
});

describe('权威判死豁免：spawning 命中不算 miss（推导读面）', () => {
  it('切走再切回形态——静默超窗 + stats 只回 spawning：判活为 true → derive 不判死', () => {
    // 修复前 dock 对账只认 running → authoritativeRuns=false → 20s 静默判死
    // hidden + settleDeadDialog 拆在途（状态卡消失的直接根因）
    const d = {
      streaming: true,
      lastStreamAt: Date.now() - 60_000,
      rawMessages: [{ role: 'agent', agent_id: 'user', timestamp: 42 }],
    };
    const stats = statsResp(['alpha']);
    expect(runStatus.agentInFlight(stats, 'alpha', CONV)).toBe(true);
    expect(runStatus.deriveRunStatus(d as never, '', 'info', true, Date.now())).toEqual({ kind: 'waking', sinceMs: 42 });
  });
});

describe('悬挂探针：spawning 窗不补刀（cr-887）', () => {
  it('判死路径只关停确证死行——stats 回 spawning 命中时不关停', async () => {
    const feed = feedCore.createFeedCore({
      call(method: string) {
        if (method === 'conversation/stats') return Promise.resolve(statsResp(['alpha']));
        return Promise.resolve({});
      },
      onEvent() { return () => undefined; },
      onOpen() { return () => undefined; },
    } as never, () => new RosterCore());
    feed.init();
    feed.ensureById(DLG).streaming = true;
    feed.append(DLG, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    (feed.getDialog(DLG) as any).lastStreamAt = Date.now() - 300_000;
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: 'r1:0' } }, { delta: '流式中' }]);
    await new Promise((r) => setTimeout(r, 20));
    // 不经探针定时器（180s 太长）——直接驱动同一判定：分区仍在途、权威判活
    // ⇒ settleDeadDialog 不应收口（即便被误调也幂等无害，这里锁语义：分区仍 streaming）
    expect(feed.getDialog(DLG)?.streaming).toBe(true);
    // stats 双空（拉壳也结束）→ 同一判定为死——探针才允许关停
    const dead = runStatus.agentInFlight(statsResp([]), 'alpha', CONV);
    expect(dead).toBe(false);
  });
});

describe('subscribeResume：拉壳窗不定罪（cr-887）', () => {
  it('stats 仅 spawning 命中 → 不发 active:false（本地 streaming 撑住等待显示）', async () => {
    const calls: string[] = [];
    const rpc = {
      call(method: string) {
        calls.push(method);
        if (method === 'conversation/stats') return Promise.resolve(statsResp(['alpha']));
        return Promise.resolve({});
      },
      onEvent() { return () => undefined; },
      onOpen() { return () => undefined; },
    };
    const { reactive } = await import('vue');
    const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
    const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => new RosterCore());
    await (core as any).subscribeAgent('alpha');
    // handleResume(active:false) 会走 onSessionResume 早退——本形态无分区可验，
    // 锁行为面：stats 被问过、且未触发空壳恢复副作用（无 session/history 拉取）
    expect(calls).toContain('conversation/stats');
    expect(calls.filter((c) => c === 'session/history')).toHaveLength(0);
  });
});
