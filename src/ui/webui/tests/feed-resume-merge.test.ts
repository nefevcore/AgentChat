// ============================================================
// feed-resume-merge.test.ts —— resume 快照合并去重（结果堆叠回归）
//
// 背景 bug：切换到正在运行的 Agent（chat.subscribe → chat.session.resume
// 即时合并路径）时出现「结果堆叠」——两个气泡分别显示 渗出前缀（"测"）与
// 继续累积的正文（"测试"），历史首屏返回后被替换消失（短暂闪现）。
//
// 根因（双端错位）：
//   · 后端 handleChatSubscribe 序列化快照时把 currentStep（进行中的部分
//     内容）并入 steps —— steps = 已归档 + 进行中；
//   · 前端 mergeResumeSnapshot 的复用判定按「steps = 仅已归档」设计
//     （persistedAssistants > steps.length 才复用流式载体）→ 恒差一位：
//     直播分区里已有 k+1 个 assistant（含流式占位）时仍走"新建占位"分支，
//     第二个占位成为 lastStreaming，直播占位冻结在部分内容 → 堆叠。
//
// 本文件钉住两条不变量：
//   ① 切回运行中的 Agent：当前轮只有一个 agent 流式载体，内容连续累积；
//   ② 快照内容落后于直播（subscribe 往返期间 delta 已继续到达）时不回卷。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/stores/websocket', () => ({
  useWebSocketStore: () => ({
    init: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onConnect: vi.fn(() => () => {}),
  }),
}));

// node 环境无 window：logger 读取 LOG_LEVEL 会抛错（store 逻辑不受影响，仅降噪）
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';

const A = 'alpha';

describe('mergeResumeSnapshot：切回运行中的 Agent（即时合并路径）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init(); // 注册 FEED_HANDLERS（websocket store 已 mock）
    const agents = useAgentStore();
    agents.activeAgentId = A; // 直写 ref，避开 lastContext 持久化副作用
  });

  it('steps 含进行中步骤（后端现行序列化）→ 不新建第二个流式占位', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    // ① 用户消息 + 直播流式（用户此前在查看别的会话，分区照收广播事件）
    feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });
    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.thinking.start', { agentId: A });
    feed.ingest('chat.thinking.update', { agentId: A, delta: '思考' });
    feed.ingest('chat.message.update', { agentId: A, delta: '测' });

    // ② 切回该 Agent：chat.subscribe → 快照（currentStep 并入 steps）
    feed.ingest('chat.session.resume', {
      active: true, agentId: A, phase: 'message',
      content: '测', thinking: '思考',
      steps: [{ thinking: '思考', content: '测', tool_calls: [], ts: Date.now() }],
    });

    // ③ 直播继续
    feed.ingest('chat.message.update', { agentId: A, delta: '试' });

    const raw = feed.getRaw(id);
    const agentMsgs = raw.filter(m => m.role === 'agent' && m.agent_id === A);
    expect(agentMsgs.length).toBe(1);          // 唯一流式载体（修复前为 2）
    expect(agentMsgs[0].content).toBe('测试');  // 连续累积，无冻结前缀
  });

  it('steps 不含进行中步骤（后端修正后形态）→ 同样只有一个载体', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });
    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.thinking.start', { agentId: A });
    feed.ingest('chat.thinking.update', { agentId: A, delta: '思考' });
    feed.ingest('chat.message.update', { agentId: A, delta: '测' });

    feed.ingest('chat.session.resume', {
      active: true, agentId: A, phase: 'message',
      content: '测', thinking: '思考',
      steps: [], // 已归档步骤为空，进行中部分由顶层 content/thinking 承载
    });

    feed.ingest('chat.message.update', { agentId: A, delta: '试' });

    const raw = feed.getRaw(id);
    const agentMsgs = raw.filter(m => m.role === 'agent' && m.agent_id === A);
    expect(agentMsgs.length).toBe(1);
    expect(agentMsgs[0].content).toBe('测试');
  });

  it('快照内容落后于直播（subscribe 往返竞态）→ 不回卷已渗出的正文', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    feed.append(id, { id: 'u1', role: 'agent', content: '你好', timestamp: Date.now(), agent_id: 'user' });
    feed.ingest('chat.step.start', { agentId: A });
    feed.ingest('chat.message.update', { agentId: A, delta: '测试完成' });

    // 快照在 subscribe 时刻只累积到「测」——合并不得把直播内容倒回去
    feed.ingest('chat.session.resume', {
      active: true, agentId: A, phase: 'message',
      content: '测', thinking: '',
      steps: [{ thinking: '', content: '测', tool_calls: [], ts: Date.now() }],
    });

    feed.ingest('chat.message.update', { agentId: A, delta: '！' });

    const raw = feed.getRaw(id);
    const agentMsgs = raw.filter(m => m.role === 'agent' && m.agent_id === A);
    expect(agentMsgs.length).toBe(1);
    expect(agentMsgs[0].content).toBe('测试完成！');
  });

  it('空分区（页面刷新，历史未到）→ resume 挂起，历史首屏后合并出唯一载体', () => {
    const feed = useFeedStore();
    const id = directDialog(A);

    // 分区为空：快照先存起来（resumeSnapshot），等待历史首屏
    feed.ingest('chat.session.resume', {
      active: true, agentId: A, phase: 'message',
      content: '测', thinking: '思考',
      steps: [{ thinking: '思考', content: '测', tool_calls: [], ts: Date.now() }],
    });
    expect(feed.getRaw(id).length).toBe(0);

    // 历史首屏（当前轮 user 消息已落盘；assistant 未 checkpoint）
    feed.ingest('history.response', {
      agentId: A,
      messages: [
        { message_id: 'm1', role: 'user', content: '你好', agent_id: 'user', timestamp: new Date().toISOString() },
      ],
    });

    const raw = feed.getRaw(id);
    const agentMsgs = raw.filter(m => m.role === 'agent' && m.agent_id === A);
    expect(agentMsgs.length).toBe(1);          // 快照 steps 的进行中步骤不重复成两条
    expect(agentMsgs[0].isStreaming).toBe(true);
    expect(agentMsgs[0].content).toBe('测');
    expect(agentMsgs[0].thinking).toBe('思考');
  });
});
