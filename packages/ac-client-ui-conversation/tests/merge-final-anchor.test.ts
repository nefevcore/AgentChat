// ============================================================
// merge-final-anchor.test.ts —— 首屏合并终稿行语义（cr-671 起；
// P3-1 cr-1281 键控单机制；cr-1294 锚覆盖兜底删除）：同轮步行与终稿
// 行共享收束行 message_id——键控（stepId）吸收步行后，同锚无键终稿
// 行保留（宁重不丢）；帧缺键的终稿步行（历史行带 stepId、直播载体
// 无键）不内容猜测，保留至收束（run/settled delay=0）重拉换权威行。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let feedTypes: typeof import('../client/feed.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  feedTypes = await import('../client/feed.ts');
});

function offlineRpc() {
  return {
    call: () => Promise.reject(new Error('no rpc')),
    onEvent: () => () => undefined,
    onOpen: () => () => undefined,
    onAck: () => () => undefined,
  };
}

const AGENT = 'alpha';
const FINAL1 = '两个工具实测完成——都已受理。';
const FINAL2 = '重启已兑现，全链路实测通过。';

describe('mergeHistory 首屏终稿行归并（cr-671；P3-1 cr-1281）', () => {
  it('inFlight 首屏合并：同锚无键终稿行不上浮、不误删（键控吸收 + 宁重不丢）', () => {
    const feed = feedCore.createFeedCore(offlineRpc() as never, () => new RosterCore());
    const dialogId = feedTypes.directDialog(AGENT);
    const T0 = Date.parse('2026-10-24T08:53:35Z');

    // —— 直播分区（收束后：全部行已关停，但残留一张空结果工具行 →
    //    inFlight 判真（run-settled 重拉与 chatEnd 关帧竞态的等价现场）——
    const live: any[] = [
      { id: 'u1', role: 'agent', agent_id: 'user', content: '测试两个重启工具', timestamp: T0 },
    ];
    for (let i = 0; i < 5; i++) {
      live.push(
        { id: 's' + i, role: 'agent', agent_id: AGENT, stepId: 'run1:' + i, thinking: '思' + i, content: '步' + i + '正文', timestamp: T0 + 1000 * (i + 1) },
        { id: 't' + i, role: 'tool', tool_call_id: 'call_' + i, content: '结果' + i, timestamp: T0 + 1000 * (i + 1) },
      );
    }
    // run1 末步（终稿载体）：thinking = 末步 reasoning，无 stepId（帧缺键现场）
    live.push({ id: 's5', role: 'agent', agent_id: AGENT, thinking: '末步思考', content: FINAL1, timestamp: T0 + 6000 });
    // run2（重启后续跑）：一步即终稿
    live.push({ id: 'r2s0', role: 'agent', agent_id: AGENT, stepId: 'run2:0', thinking: '续跑思考', content: FINAL2, timestamp: T0 + 9000 });
    // 空结果工具行 → mergeHistory inFlight 判真入口
    live.push({ id: 'tz', role: 'tool', tool_call_id: 'call_z', content: '', timestamp: T0 + 9500 });
    feed.setRaw(dialogId, live);

    // —— 历史首屏（journal 投影）：agent 侧 reply 展开（带 stepId）+
    //    viewer 侧同锚平文终稿行（无 stepId、行级 reasoning = 整轮拼接）——
    //    timestamp 用 number（真实管线 historyRowToChatMessage 产物形态：
    //    new Date(...).getTime()——mergeTimeOrdered 归并假设双方同型）。
    const joinedReasoning = ['思0', '思1', '思2', '思3', '思4', '末步思考'].join('\n\n');
    const incoming: any[] = [
      { id: 'hist-u1', role: 'agent', agent_id: 'user', content: '测试两个重启工具', persistedMsgId: 'send-1', timestamp: T0 },
    ];
    for (let i = 0; i < 5; i++) {
      incoming.push(
        { id: 'reply-1-s' + i, role: 'agent', agent_id: AGENT, stepId: 'run1:' + i, thinking: '思' + i, content: '步' + i + '正文', persistedMsgId: 'reply-1', timestamp: T0 + 1000 * (i + 1) },
        { id: 'tool-call_' + i, role: 'tool', tool_call_id: 'call_' + i, content: '结果' + i, persistedMsgId: 'call_' + i, timestamp: T0 + 1000 * (i + 1) },
      );
    }
    // 步 5（终稿步，带 stepId；直播载体缺键 → 键控 miss 现场——P3-1 起保留）
    incoming.push({ id: 'reply-1-s5', role: 'agent', agent_id: AGENT, stepId: 'run1:5', thinking: '末步思考', content: FINAL1, persistedMsgId: 'reply-1', timestamp: T0 + 6000 });
    // viewer 侧同锚平文终稿行（与直播末步 thinking 形态不同 → 前缀互验必败）
    incoming.push({ id: 'reply-1', role: 'agent', agent_id: AGENT, reasoning_content: joinedReasoning, content: FINAL1, persistedMsgId: 'reply-1', timestamp: T0 + 6001 });
    incoming.push({ id: 'reply-2-s0', role: 'agent', agent_id: AGENT, stepId: 'run2:0', thinking: '续跑思考', content: FINAL2, persistedMsgId: 'reply-2', timestamp: T0 + 9000 });
    incoming.push({ id: 'reply-2', role: 'agent', agent_id: AGENT, reasoning_content: '续跑思考', content: FINAL2, persistedMsgId: 'reply-2', timestamp: T0 + 9001 });

    feed.mergeHistory(dialogId, incoming, true);

    const raw = feed.getRaw(dialogId);
    const agentTexts = raw.filter((m: any) => m.role === 'agent' && m.agent_id === AGENT).map((m: any) => m.content);
    // cr-1294 后语义（锚覆盖兜底删除）：步 0-4 键控吸收（同 stepId 直播
    // 载体在场）；run2:0 键控吸收；run1:5 与 viewer 侧同锚平文终稿行
    // （reply-1/reply-2 无键）均保留——宁重不丢，收束重拉（delay=0）换
    // 权威行。FINAL2 = 直播载体 r2s0 + 保留的 reply-2 平文行两份。
    expect(agentTexts.filter((t: string) => t === FINAL2)).toHaveLength(2);
    // 保序：步骤链在前，终稿在后（终稿不得上浮到任何步骤之前）
    const firstFinalIdx = agentTexts.findIndex((t: string) => t === FINAL1);
    for (let i = 0; i < 5; i++) expect(agentTexts.indexOf('步' + i + '正文')).toBeLessThan(firstFinalIdx);
    // user 行在最前
    expect(raw[0].agent_id).toBe('user');
  });

  it('跨轮同文行不误删：早于本轮锚的历史行保留', () => {
    const feed = feedCore.createFeedCore(offlineRpc() as never, () => new RosterCore());
    const dialogId = feedTypes.directDialog(AGENT);
    const T0 = Date.parse('2026-10-24T08:53:35Z');
    const T_OLD = T0 - 3600_000;

    const live: any[] = [
      { id: 'u1', role: 'agent', agent_id: 'user', content: '再发一次', timestamp: T0 },
      { id: 's0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: FINAL2, timestamp: T0 + 1000 },
      { id: 'tz', role: 'tool', tool_call_id: 'call_z', content: '', timestamp: T0 + 2000 },
    ];
    feed.setRaw(dialogId, live);

    const incoming: any[] = [
      { id: 'hist-u0', role: 'agent', agent_id: 'user', content: '更早的一句', persistedMsgId: 'send-0', timestamp: new Date(T_OLD).toISOString() },
      // 上一轮同文终稿（跨轮同文）：P3-1 起内容等值兜底退役——键控/锚推论
      // 不触及（异锚、无键），保留（内容猜测层积的误删风险面随之消失）
      { id: 'reply-old', role: 'agent', agent_id: AGENT, content: FINAL2, persistedMsgId: 'reply-old', timestamp: new Date(T_OLD + 5000).toISOString() },
      { id: 'hist-u1', role: 'agent', agent_id: 'user', content: '再发一次', persistedMsgId: 'send-1', timestamp: new Date(T0).toISOString() },
      { id: 'reply-1-s0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: FINAL2, persistedMsgId: 'reply-1', timestamp: new Date(T0 + 1000).toISOString() },
    ];
    feed.mergeHistory(dialogId, incoming, true);

    const raw = feed.getRaw(dialogId);
    const finals = raw.filter((m: any) => m.role === 'agent' && m.agent_id === AGENT && m.content === FINAL2);
    expect(finals).toHaveLength(2); // 上一轮同文行保留 + 本轮直播行
    expect(raw[0].content).toBe('更早的一句');
  });
});
