// ============================================================
// feed-event-wake-streaming.test.ts —— 机制唤醒 run（source='event'）
// 落在用户可见会话的流式放行回归
//
// 背景 bug（2026-09-16 反馈）：ask_questions 提问挂起后 run 已死
// （后端重启/中断），用户作答触发 late-reply 回投——后端 ws-bridge
// 按 2026-09-02 修正口径照常广播 delta（用户可见会话），但前端
// isForCurrentUser 按 sender 一刀切拦截（回投信封 sender=Agent 自身，
// 非 viewer）：表现为回执（系统事件行）可见但整轮隐形、收束瞬间
// 终稿一次性弹出，中途思考与分步正文全部丢失。
//
// 修复后不变量：
//   · source='event' 且分区为 viewer 表面（single / 含 viewer 的 pair）
//     → delta 照常 ingest（流式打字恢复）；
//   · source='agent' 他人委托落 viewer 会话（原串台防御面）→ 仍拦截；
//   · 自会话（a~a）机制 run → 后端本就只广播边界帧，前端行为不变。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('ac-client-ui-renderer/client/logger.ts', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSessionCores, type SessionCores } from './helpers/sessionCores.ts';
import { wireFace } from '../src/runtime/wireFace';
import { directDialog, pairDialog, singleDialog } from '../src/utils/feed';
import { chatPresence } from 'ac-client-ui-conversation/client/chatOps.ts';

const A = 'helper';
const SID = 'sid-late-1';
const NOTICE = '[系统通知] 你此前发起的提问（interaction dur-1）已收到用户回答';
const STEP1_TEXT = '收到回答，';
const STEP2_TEXT = '继续任务的分析正文。';

let cores: SessionCores;

function seed(): void {
  cores.roster.setAgents([{ id: A, name: 'Helper', description: '' }]);
  chatPresence.knownSingles.add(SID);
}

describe('机制唤醒（source=event）落在用户可见会话：流式照常', () => {
  beforeEach(() => {
    cores = createSessionCores(wireFace);
    cores.feed.init();
    seed();
  });

  it('late-reply 回投 run（single，sender=Agent）：delta 流式 ingest，正文逐步可见', () => {
    const feed = cores.feed;
    // 回执（系统事件行——通知面统一后经 session/context-injected 上屏：后端
    // session 在事件行落账时发帧，带注入身份锚；router/message-received 的
    // event 分支已退役，此处不再经它上屏）
    feed.ingestFrame('session/context-injected', [SID, A, { source: 'event', injectionId: 'ctx-lr-1', label: NOTICE }]);
    // 新 run：信封 sender=A（Agent 自身）、source='event'（late-reply 回投）
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: SID, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: SID, sender: A, source: 'event' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: STEP1_TEXT }, { agent: A, conversationId: SID, sender: A, source: 'event' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: STEP2_TEXT }, { agent: A, conversationId: SID, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/after-step', [A, { text: STEP1_TEXT + STEP2_TEXT }, { conversationId: SID, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: SID, sender: A, source: 'event' }, { finish: 'stop', text: STEP1_TEXT + STEP2_TEXT }]);

    const raw = feed.getRaw(singleDialog(SID));
    // 修复点：delta 增量不被 isForCurrentUser 拦截——流式正文在场
    //（修复前：占位空置、收束时 onChatEnd 兜底一次性补终稿）
    expect(raw.some((m) => m.role === 'agent' && m.content === STEP1_TEXT + STEP2_TEXT)).toBe(true);
    // 系统事件行（回执）与流式回复同屏可见
    expect(raw.some((m) => m.role === 'event' && m.content === NOTICE)).toBe(true);
  });

  it('timer 定点唤醒（1v1 对桶，sender=Agent）：viewer 直答分区流式照常', () => {
    const feed = cores.feed;
    const conv = [A, 'user'].sort().join('~'); // a~u 对桶
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: conv, sender: A, source: 'event' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '定点报告' }, { agent: A, conversationId: conv, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/after-step', [A, { text: '定点报告' }, { conversationId: conv, sender: A, source: 'event' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: A, source: 'event' }, { finish: 'stop', text: '定点报告' }]);

    const raw = feed.getRaw(directDialog(A));
    expect(raw.some((m) => m.role === 'agent' && m.content === '定点报告')).toBe(true);
  });

  it('串台防御保持：source=agent（他人委托）落 viewer 会话的 delta 仍拦截', () => {
    const feed = cores.feed;
    const conv = [A, 'user'].sort().join('~');
    // agent B 委托 A，但信封 source='agent'（非机制唤醒）——串台面照旧拦截
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: conv, sender: 'beta', source: 'agent' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { delta: '委托内容' }, { agent: A, conversationId: conv, sender: 'beta', source: 'agent' }]);
    feed.ingestFrame('loop/after-step', [A, { text: '委托内容' }, { conversationId: conv, sender: 'beta', source: 'agent' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'beta', source: 'agent' }, { finish: 'stop', text: '委托内容' }]);

    const raw = feed.getRaw(directDialog(A));
    // after-run 边界兜底（onChatEnd）始终放行——不在防御面（与既有行为一致）
    expect(raw.some((m) => m.content === '委托内容' && m.role === 'agent')).toBe(true);
    // 但 delta 增量与步终 onMessageEnd 不得写入（拦截面不变）：无任何消息
    // 处于流式累积形态——终稿行是收束兜底（id 形如 final-/uid），非步载体
    expect(raw.filter((m) => m.role === 'agent' && m.content === '委托内容').length).toBe(1);
  });

  it('自会话（a~a）机制 run：前端行为不变（边界帧兜底，名册不 bump）', () => {
    const feed = cores.feed;
    // 后端只广播边界帧（流式隐藏）——修复不改变此面
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: `${A}~${A}`, sender: A, source: 'event' }, { finish: 'stop', text: '自会话产物' }]);
    expect(feed.getRaw(pairDialog(A, A)).some((m) => m.content === '自会话产物')).toBe(true);
    expect(feed.getRaw(directDialog(A))).toHaveLength(0);
    const entry = cores.roster.agents.value.find((a) => a.id === A);
    expect(entry?.lastMessage).toBeUndefined();
  });
});
