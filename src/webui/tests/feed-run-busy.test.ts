// ============================================================
// feed-run-busy.test.ts —— run 级忙态（streaming）回归
//
// 背景 bug（2026-09-05 反馈：前端消息队列没生效，Enter 直接进 next-step）：
// 分区 streaming 原是步级信号——onStepEnd 每步熄灭，而后端 after-step
// 先于工具执行（ac-agent-loop：step() 收束 → execute() 内再跑工具），
// 工具执行窗口（agentic run 的主要耗时）分区被判空闲：
//   · 忙时 Enter → sendMessage busy 判定失败 → 投递不带 lane → 后端
//     缺省 lane next-step + placement steer 直接插话进运行中 run，
//     QueueDock 永远是空的（消息队列形同虚设）；
//   · 同窗口停止按钮 / QueueDock ⚡（busy 门控）一并失效。
//
// 修复语义：streaming = run 级信号——
//   · loop/run-started（可见 run）点亮；隐藏 run（归档整理 meta /
//     a~a 自会话桶）照旧不点亮（与 ws-bridge isHiddenRun 同口径）；
//   · 带工具调用的 after-step 不熄灭（工具即将执行、下一步必来）；
//   · 自然收束步（无工具调用）/ after-run / 中断 / 错误熄灭。
// 派生修复：忙时 Enter → lane next-turn（排队）；Cmd/Ctrl+Enter →
// placement steer（插话）；看门狗把未闭合工具行算作在途（长工具不误报断连）。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const deliverCalls: Array<Record<string, any>> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      if (method === 'conversation/deliver') {
        deliverCalls.push({ method, params });
        return new Promise(() => {}); // deliver 等整轮 run 收束——测试内恒挂起
      }
      return Promise.reject(new Error('no rpc in test'));
    }),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));
// node 环境无 window：logger 读取 LOG_LEVEL 会抛错（store 逻辑不受影响，仅降噪）
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useChatStore } from '../src/stores/chat';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';
const conv = `${A}~user`;
const env = { conversationId: conv, sender: 'user' };

describe('run 级 streaming（工具执行窗口忙态不失真）', () => {
  beforeEach(() => {
    deliverCalls.length = 0;
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A; // 直写 ref，避开 lastContext 持久化副作用
  });

  it('run-started 点亮；带工具调用的 after-step 不熄灭；after-run 熄灭', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    // run 开始（首步 LLM 调用前）即忙——run 级信号
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    expect(feed.getDialog(id)?.streaming).toBe(true);

    // step1 收束：带工具调用 → 工具即将执行、run 继续 → 不熄灭
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta-end', [undefined, { agent: A, conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('loop/after-step', [A, { text: '', toolCalls: [{ id: 'tc1', name: 'bash', arguments: '{}' }] }, env]);
    expect(feed.getDialog(id)?.streaming).toBe(true); // ← 修复前：此处已熄灭

    // 工具执行窗口（after-execute 未回）仍忙——Enter 排队判定的依据
    // run 收束：after-run 恒广播 → 熄灭
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '完成' }]);
    expect(feed.getDialog(id)?.streaming).toBe(false);
  });

  it('自然收束步（无工具调用）after-step 即熄灭——光环/忙态及时回落', () => {
    const feed = useFeedStore();
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('loop/after-step', [A, { text: '直接回答', toolCalls: [] }, env]);
    expect(feed.getDialog(id)?.streaming).toBe(false);
  });

  it('隐藏 run 不点亮：归档整理（meta）与 a~a 自会话桶', () => {
    const feed = useFeedStore();
    // 归档整理 run：点亮的是 archivePending，不是 streaming
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, meta: { 'archive-review': true } }]);
    expect(feed.getDialog(directDialog(A))?.streaming ?? false).toBe(false);
    expect(feed.archivePending).toBe(true);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, meta: { 'archive-review': true } }, { finish: 'stop', text: '' }]);
    expect(feed.archivePending).toBe(false);
    // a~a 自会话桶：机制 run 隐藏面——不点亮对应对分区
    feed.ingestFrame('loop/run-started', [{ agent: 'beta', conversationId: 'beta~beta', source: 'event' }]);
    expect(feed.getDialog(directDialog('beta'))?.streaming ?? false).toBe(false);
  });
});

describe('忙态投递分流（Enter 排队 / Cmd+Ctrl+Enter 插话）', () => {
  beforeEach(() => {
    deliverCalls.length = 0;
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  const deliverParams = () => deliverCalls.at(-1)?.params as Record<string, unknown>;

  it('忙时 Enter → lane next-turn（排队等本轮结束独立投递，不插话）', () => {
    const feed = useFeedStore();
    // 模拟 run 进行中（工具执行窗口）：run-started 点亮 + 未闭合工具行
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    useChatStore().sendMessage('稍后处理这个');
    expect(deliverParams()?.lane).toBe('next-turn');
    expect(deliverParams()?.placement).toBeUndefined();
  });

  it('忙时 Cmd/Ctrl+Enter（mode steer）→ placement steer（注入运行中 run）', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    useChatStore().sendMessage('着急，现在就改', undefined, { mode: 'steer' });
    expect(deliverParams()?.placement).toBe('steer');
    expect(deliverParams()?.lane).toBeUndefined();
  });

  it('空闲发送 → 不带 lane/placement（后端缺省路径）', () => {
    useChatStore().sendMessage('新问题');
    expect(deliverParams()?.lane).toBeUndefined();
    expect(deliverParams()?.placement).toBeUndefined();
  });
});

describe('发送看门狗：未闭合工具行算在途（长工具不误报断连）', () => {
  beforeEach(() => {
    deliverCalls.length = 0;
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('工具执行 >30s（占位已关、结果未回）→ 不回落不误报', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    chat.sendMessage('跑个长任务');
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    // after-step 关闭占位（isStreaming=false）但工具结果未回（content 空）
    feed.getRaw(id).push({ id: 'tool-tc9', role: 'tool', content: '', name: 'bash', tool_call_id: 'tc9', timestamp: Date.now() } as any);
    vi.advanceTimersByTime(30_000);
    expect(feed.getDialog(id)?.streaming).toBe(true);
    expect(chat.busyFeedback).toBe('');
  });

  it('事件链真断裂（无任何在途行）→ 回落 + 断连提示', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    chat.sendMessage('这条会断');
    vi.advanceTimersByTime(30_000);
    expect(feed.getDialog(id)?.streaming).toBe(false);
    expect(chat.busyFeedback).toContain('无响应');
  });
});
