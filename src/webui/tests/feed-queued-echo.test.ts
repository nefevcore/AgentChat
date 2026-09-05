// ============================================================
// feed-queued-echo.test.ts —— busy 排队发送不上屏 + 消费回显补气泡
//
// 背景 bug（2026-09-06 反馈）：Agent 运行中发送消息 → 消息成功进入
// next-run 队列（QueueDock 展示），但 sendMessage 同时把用户气泡乐观
// 上屏——消息"既在队列又在会话流"双现，插在在途回复中间，渲染顺序
// 错乱。
//
// 修复语义（DSH queue 姿势）：
//   · 忙时 Enter（排队路径）→ 本地【不上屏】，只登记回显待补——消息
//     唯一可见位是 QueueDock；
//   · 消费投递回显（router/message-received，sender=viewer）→ 按登记
//     补气泡（位置恰在新 run 流式之前；同文多条排队各补各的）；
//   · 普通发送回显 → 跳过（本地已上屏，在场判定）；
//   · 无登记无在场（刷新后消费 / 别处 tab 同账号发送）→ 上屏；
//   · 插话（appendOwnSteered）/ 投递失败 → 回退登记（回显不再到来）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const deliverCalls: Array<Record<string, any>> = [];
/** deliver RPC 行为开关：'pending' = 挂起（等整轮 run，测试内不收束）；
 *  'reject' = 立即失败（投递失败回退登记用） */
let deliverBehavior: 'pending' | 'reject' = 'pending';
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      if (method === 'conversation/deliver') {
        deliverCalls.push({ method, params });
        return deliverBehavior === 'reject'
          ? Promise.reject(new Error('网络不可达'))
          : new Promise(() => {});
      }
      return Promise.reject(new Error('no rpc in test'));
    }),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));
// node 环境无 window：logger 读取 LOG_LEVEL 会抛错（对齐 feed-run-busy 降噪）
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

/** 模拟后端消费排队消息时的回显帧（router.send 先 emit 再开 run） */
function echoOwn(feed: ReturnType<typeof useFeedStore>, content: string): void {
  feed.ingestFrame('router/message-received', [
    A, { role: 'user', content }, conv, 'user', 'user',
  ]);
}

describe('busy 排队发送：不上屏 + 消费回显补气泡', () => {
  beforeEach(() => {
    deliverCalls.length = 0;
    deliverBehavior = 'pending';
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A;
  });

  it('忙时 Enter → 本地不上屏（只住 QueueDock）；消费回显才落会话流', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    // 模拟 run 进行中
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    chat.sendMessage('稍后处理这个');
    // ← 修复前：这里立即出现用户气泡（与 QueueDock 双现、顺序错乱）
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(0);
    // 投递形态：排队（lane next-turn，不插话）
    const params = deliverCalls.at(-1)?.params as Record<string, unknown>;
    expect(params?.lane).toBe('next-turn');

    // 当前 run 结束 → 后端消费队列（queue-changed → message-received 回显 → 新 run）
    echoOwn(feed, '稍后处理这个');
    const bubbles = feed.getRaw(id).filter((m) => m.agent_id === 'user');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ role: 'agent', content: '稍后处理这个' });
  });

  it('同文排队两条 → 消费回显各补一条（计数制登记，内容查重不吞）', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    chat.sendMessage('一样的话');
    chat.sendMessage('一样的话');
    echoOwn(feed, '一样的话');
    echoOwn(feed, '一样的话');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user' && m.content === '一样的话'))
      .toHaveLength(2);
  });

  it('普通发送（空闲）回显 → 跳过（本地已上屏，不重复）', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    chat.sendMessage('普通消息');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1); // 乐观上屏
    echoOwn(feed, '普通消息');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1); // 回显跳过
  });

  it('无登记无在场的回显 → 上屏（刷新后消费 / 别处 tab 发送兜底）', () => {
    const feed = useFeedStore();
    const id = directDialog(A);
    // 不经 sendMessage（模拟页面刷新后登记丢失，消息仍在服务端队列被消费）
    echoOwn(feed, '刷新前排的队');
    const bubbles = feed.getRaw(id).filter((m) => m.agent_id === 'user');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].content).toBe('刷新前排的队');
  });

  it('排队附件消息 → 回显剥 [附件] 行回 chips（与历史同形）', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    chat.sendMessage('看图', undefined, { files: [{ hash: '', filename: 'a.png', filesize: 1 }] });
    expect(feed.getRaw(id)).toHaveLength(0);
    // 后端投递/回显的是组合正文（composeContent：正文 + [附件] 行）
    echoOwn(feed, '看图\n[附件] a.png（已上传，路径未记录）');
    const bubble = feed.getRaw(id).find((m) => m.agent_id === 'user')!;
    expect(bubble.content).toBe('看图');
    expect(bubble.files?.length).toBe(1);
  });

  it('排队条目插话（appendOwnSteered）→ 本地上屏 + 回退登记（回显不双补）', () => {
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    chat.sendMessage('插话我'); // 入队（登记回显）
    chat.appendOwnSteered('插话我'); // QueueDock ⚡：本地补气泡 + 回退登记
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1);
    // 登记已回退 + 气泡在场 → 即使同文回显到来也不重复
    echoOwn(feed, '插话我');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1);
  });

  it('排队投递失败 → 回退登记（同文后续回显不误补）', async () => {
    deliverBehavior = 'reject';
    const feed = useFeedStore();
    const chat = useChatStore();
    const id = directDialog(A);
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    chat.sendMessage('这条会失败');
    await new Promise((r) => setTimeout(r, 0)); // 等 deliver catch 跑完（回退登记）
    expect(feed.getRaw(id)).toHaveLength(0);
    // 在途 run 收束（streaming 回落）后，用户改为普通发送同文：本地气泡
    // 在场 → 回显跳过（登记已回退，不经登记命中误补第二条）
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '' }]);
    deliverBehavior = 'pending';
    chat.sendMessage('这条会失败');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1);
    echoOwn(feed, '这条会失败');
    expect(feed.getRaw(id).filter((m) => m.agent_id === 'user')).toHaveLength(1);
  });
});
