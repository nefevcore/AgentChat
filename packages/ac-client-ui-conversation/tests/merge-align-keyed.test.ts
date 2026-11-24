// ============================================================
// merge-align-keyed.test.ts —— P3-1 合并对齐收敛（cr-1281）：
// inFlight 首屏合并的直播/历史对齐 = 键控单机制（injectionId 同锚 /
// tool_call_id / stepId）+ coveredAnchors 显式兜底；内容猜测层积
//（前缀互验 / 配额抵扣 / 内容等值）退役——缺键行保留，收束重拉
//（run/settled delay=0）换权威行。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';
import { readFallbackProbes, resetFallbackProbes } from '../client/fallback-probes.ts';

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
const CONV = 'alpha~user';

function newFeed() {
  return feedCore.createFeedCore(offlineRpc() as never, () => new RosterCore());
}

/** 制造 inFlight 分区：空结果工具行（mergeHistory 判真入口） */
function inFlightTail(feed: any, dialogId: any, rows: any[]) {
  feed.setRaw(dialogId, [
    { id: 'u1', role: 'agent', agent_id: 'user', content: '问', timestamp: 1000 },
    ...rows,
    { id: 'tz', role: 'tool', tool_call_id: 'call_z', content: '', timestamp: 9999 },
  ]);
}

describe('P3-1 键控单机制：直播/历史对齐', () => {
  it('stepId 键控：同键历史行吸收进直播载体（长度取胜保全内容）', () => {
    const feed = newFeed();
    const dialogId = feedTypes.directDialog(AGENT);
    inFlightTail(feed, dialogId, [
      { id: 's0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: '部分', timestamp: 2000 },
    ]);
    const merged = feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', agent_id: 'user', content: '问', timestamp: new Date(1000).toISOString(), persistedMsgId: 'mu1' },
      { id: 'h-s0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: '部分完整版', timestamp: new Date(2000).toISOString(), persistedMsgId: 'ma1' },
    ] as any, true);
    expect(merged).toBeTruthy();
    const raw = feed.getRaw(dialogId);
    const keyed = raw.filter((m: any) => m.stepId === 'run1:0');
    expect(keyed).toHaveLength(1); // 同键不双卡
    expect(keyed[0].content).toBe('部分完整版'); // 长度取胜
  });

  it('缺键历史行不猜测：旧前缀互验会吸收的行（互为前缀）现保留——收束重拉兜底', () => {
    const feed = newFeed();
    const dialogId = feedTypes.directDialog(AGENT);
    // 直播流式占位（无 stepId——旧后端帧形态）与历史完整行互为前缀：
    // 旧机制按内容前缀互验吸收（cr-2026-09-21 #4 链路）；P3-1 起缺键即保留。
    inFlightTail(feed, dialogId, [
      { id: 's0', role: 'agent', agent_id: AGENT, isStreaming: true, content: '回答的前半', timestamp: 2000 },
    ]);
    feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', agent_id: 'user', content: '问', timestamp: new Date(1000).toISOString(), persistedMsgId: 'mu1' },
      { id: 'h-s0', role: 'agent', agent_id: AGENT, content: '回答的前半段完整', timestamp: new Date(2000).toISOString(), persistedMsgId: 'ma1' },
    ] as any, true);
    const raw = feed.getRaw(dialogId);
    // 保留（不吸收）：历史行与直播行并存——内容猜测退役，权威收敛归
    // run/settled delay=0 收束重拉。
    expect(raw.filter((m: any) => m.role === 'agent' && m.agent_id === AGENT)).toHaveLength(2);
    expect(raw.some((m: any) => m.content === '回答的前半段完整')).toBe(true);
  });

  it('同锚无键终稿行保留（cr-1294 锚兜底删除后）：键控单机制——宁重不丢，收束重拉换权威行', () => {
    const feed = newFeed();
    const dialogId = feedTypes.directDialog(AGENT);
    inFlightTail(feed, dialogId, [
      { id: 's0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: '步零', timestamp: 2000 },
    ]);
    feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', agent_id: 'user', content: '问', timestamp: new Date(1000).toISOString(), persistedMsgId: 'mu1' },
      // 同锚步行（键控吸收——直播载体在场）
      { id: 'h-s0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: '步零', timestamp: new Date(2000).toISOString(), persistedMsgId: 'reply-1' },
      // viewer 侧同锚平文终稿行（无 stepId）——cr-1294 起锚覆盖兜底删除：
      // 缺键即保留（不猜），由收束重拉（run/settled delay=0）换权威行
      { id: 'h-final', role: 'agent', agent_id: AGENT, reasoning_content: '思', content: '终稿正文', timestamp: new Date(2500).toISOString(), persistedMsgId: 'reply-1' },
    ] as any, true);
    const raw = feed.getRaw(dialogId);
    // 同锚无键行保留（不残留去重前部的问题由收束重拉解决——窗口期宁重不丢）
    expect(raw.some((m: any) => m.id === 'h-final')).toBe(true);
    // 键控行单份（直播载体承载）
    expect(raw.filter((m: any) => m.stepId === 'run1:0')).toHaveLength(1);
  });

  it('键族不推论：注入行同锚吸收不推论到 agent 行（cr-1294 后语义同——无键 agent 行保留）', () => {
    const feed = newFeed();
    const dialogId = feedTypes.directDialog(AGENT);
    inFlightTail(feed, dialogId, [
      { id: 'inj1', role: 'event', content: '已加载技能', agent_id: AGENT, timestamp: 1500, persistedMsgId: 'inj-1' },
      { id: 's0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', thinking: '思', content: '步零', timestamp: 2000 },
    ]);
    feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', agent_id: 'user', content: '问', timestamp: new Date(1000).toISOString(), persistedMsgId: 'mu1' },
      // 注入历史行：injectionId 同锚吸收（event 键族——同锚即同一事实）
      { id: 'h-inj1', role: 'event', content: '已加载技能', timestamp: new Date(1500).toISOString(), persistedMsgId: 'inj-1' },
      // 共享注入锚的 agent 行（合成位形）：不被覆盖，保留
      { id: 'h-x', role: 'agent', agent_id: AGENT, content: '同注入锚的 agent 行', timestamp: new Date(2300).toISOString(), persistedMsgId: 'inj-1' },
    ] as any, true);
    const raw = feed.getRaw(dialogId);
    expect(raw.some((m: any) => m.id === 'h-x')).toBe(true); // 不被推论吞掉
    // 注入行本身同锚单份（直播行承载）
    expect(raw.filter((m: any) => m.persistedMsgId === 'inj-1' && m.role === 'event')).toHaveLength(1);
  });

  it('注入行同锚吸收：contextContent 补进直播行（cr-767 不回归）', () => {
    const feed = newFeed();
    const dialogId = feedTypes.directDialog(AGENT);
    const INJ_BODY = '<system-reminder>注入正文</system-reminder>';
    inFlightTail(feed, dialogId, [
      { id: 'inj1', role: 'event', content: '已加载技能 demo', agent_id: AGENT, timestamp: 1500, persistedMsgId: 'inj-1', source: { kind: 'skill', summary: '' } },
      { id: 's0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', content: '答', timestamp: 2000 },
    ]);
    feed.mergeHistory(dialogId, [
      { id: 'h-u', role: 'agent', agent_id: 'user', content: '问', timestamp: new Date(1000).toISOString(), persistedMsgId: 'mu1' },
      { id: 'h-inj1', role: 'event', content: '已加载技能 demo', contextContent: INJ_BODY, timestamp: new Date(1500).toISOString(), persistedMsgId: 'inj-1' },
      { id: 'h-s0', role: 'agent', agent_id: AGENT, stepId: 'run1:0', content: '答', timestamp: new Date(2000).toISOString(), persistedMsgId: 'ma1' },
    ] as any, true);
    const raw = feed.getRaw(dialogId);
    const inj = raw.find((m: any) => m.persistedMsgId === 'inj-1');
    expect(inj).toBeTruthy();
    expect((inj as any).contextContent).toBe(INJ_BODY); // 正文吸收进直播行
    expect(raw.filter((m: any) => m.persistedMsgId === 'inj-1')).toHaveLength(1); // 同锚单份
  });
});

