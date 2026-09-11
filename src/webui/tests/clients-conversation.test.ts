// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-conversation.test.ts —— conversation 基础件验收
//（feed/chat 巨石收口：ctx.sessions 会话服务；M27.2-2 出包后
// owning = ac-client-ui-conversation/client——rpc 契约面注入）
//
// §0.3：feed（信息流核心）+ chat（动作核心）归 conversation 基础件。
// M28 §4.2：webui stores/{feed,chat}.ts 双模对子退役——包内 pinia 门面
//（feedStore.ts/chatStore.ts，组件消费面）是唯一双模形态；状态机测试
// 族经 tests/helpers/sessionCores.ts 直连构造（独立实例显式注入）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createClient, type ClientContext } from 'ac-client-runtime';
import { conversationClientPlugin } from 'ac-client-ui-conversation/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import { useChatStore } from 'ac-client-ui-conversation/client/chatStore.ts';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

/** rpc 桩（conversationClientPlugin inject ['slots','rpc']——离线空态） */
async function stubRpc(ctx: ClientContext): Promise<void> {
  await ctx.plugin({
    name: 'test-rpc-stub',
    apply(c: ClientContext) {
      c.provide('rpc', {
        call<T>(_method: string, _params?: unknown): Promise<T> {
          return Promise.reject(new Error('stub offline'));
        },
        onEvent(_h: (type: string, args: unknown[]) => void): () => void {
          return () => undefined;
        },
      });
    },
  });
}

describe('M27.2 · conversation 基础件（ctx.sessions = feed + chat 核心）', () => {
  beforeEach(() => {
    // feed 的 activeDialogId 派生链经 roster 取用口（useRosterCore 无
    // runtime 回落单例——与既有 feed 状态机测试同款前置）
    setActivePinia(createPinia());
  });

  it('服务装载：ctx.sessions.feed/chat 可解析；reactive 视图注入（feed 属性解包访问）', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(conversationClientPlugin);
    const svc = ctx.sessions;
    expect(svc).toBeDefined();
    expect(svc.chat).toBeDefined();
    // chat 核心经 reactive(feed) 视图访问（公开面：contextBusy/turns 等——
    // activeDialogId 归 feed 面，chat 不重复暴露；服务直取 .value——
    // pinia 门面 unwrap 同值）
    expect(svc.chat.contextBusy.value).toBe(false);
    expect(svc.feed.activeDialogId.value).toBe(null);
    // feed 原语可用（append-only 分区）
    const id = svc.feed.ensureById('direct' as never, 'helper', 'helper');
    void id;
    await fiber.dispose();
  });

  it('门面（runtime 在场）：useFeedStore/useChatStore 绑服务核心（单一事实源）', async () => {
    const app = await bootWebuiRuntime(); // ③ 已装 conversation（webuiBoot）
    setActivePinia(createPinia());
    const feedStore = useFeedStore();
    const chatStore = useChatStore();
    // chat 门面 = 服务 chat（视图状态派生自服务 feed：unreadAgents 桥）
    // feed 门面 = 服务 feed（同一 refs：activeGroupId 写入 → 分区派生互通）
    feedStore.setActiveGroup('g1', 'helper');
    expect(app.ctx.sessions.feed.activeGroupId.value).toBe('g1');
    expect(feedStore.activeDialogId).toBe('group:g1');
    expect(app.ctx.sessions.chat.contextBusy.value).toBe(false);
    await app.fibers.conversation.dispose();
  });

  it('门面（无 runtime）：独立实例 + 创建即 init（旧行为原样）', async () => {
    resetClientRuntime();
    setActivePinia(createPinia());
    const feed1 = useFeedStore();
    const chat1 = useChatStore();
    expect(chat1.contextBusy).toBe(false);
    // 新 pinia → 新独立核心（测试间不串扰）
    setActivePinia(createPinia());
    const feed2 = useFeedStore();
    expect(feed2.dialogs).toEqual({});
    void feed1;
  });

  it('可摘除性（D19）：fiber dispose → ctx.sessions 消失；门面回落独立实例', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(conversationClientPlugin);
    expect(ctx.sessions).toBeDefined();
    await fiber.dispose();
    expect((ctx as { sessions?: unknown }).sessions).toBeUndefined();
    // 无 runtime → 门面回落（宿主不残废）
    resetClientRuntime();
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.setActiveGroup('g9', 'helper');
    expect(feed.activeGroupId).toBe('g9');
    await nextTick();
  });

  it('M28 P0-2 · talk 视角出厂贡献：boot（layout 声明席位后经 inject 落位）；卸载 → 消失', async () => {
    const { ctx, fibers } = await bootWebuiRuntime(); // webuiBoot 装载序含 layout → 席位已声明
    const ids = () => ctx.slots.entries('main:perspective').map((e) => e.id);
    expect(ids()).toContain('talk'); // inject 声明存活期效应已注册
    await fibers.conversation.dispose();
    expect(ids()).not.toContain('talk');
  });

  it('M28 §4.2 · queue/ask dock 出厂贡献 + 排队态 store 座位实例轴（注记 0b）', async () => {
    const { ctx, fibers } = await bootWebuiRuntime();
    const ids = () => ctx.slots.entries('conversation:dock-widget').map((e) => e.id);
    expect(ids()).toContain('queue');
    expect(ids()).toContain('interaction');
    // DSH dock 序：排队(30)/决策(40) 居 todo(10)/goal(20) 位后（原内联 DOM 序）
    const orders = Object.fromEntries(ctx.slots.entries('conversation:dock-widget').map((e) => [e.id, e.order]));
    expect(orders['queue']).toBe(30);
    expect(orders['interaction']).toBe(40);
    // 轴：entry.store 工厂 × scopeKey=conversationId——同 scope 同实例、
    // 异 scope 异实例；release 归零即回收（dispose 随清）
    const s1 = ctx.slots.acquireStore('conversation:dock-widget', 'queue', 'a~user');
    const s2 = ctx.slots.acquireStore('conversation:dock-widget', 'queue', 'a~user');
    expect(s2.value).toBe(s1.value);
    const s3 = ctx.slots.acquireStore('conversation:dock-widget', 'queue', 's-single-9');
    expect(s3.value).not.toBe(s1.value);
    // store 形状（离线桩 rpc：拉取拒绝 → 空态收敛）
    const store = s1.value as { agentId: { value: string | null }; items: { value: unknown[] }; dispose(): void };
    expect(store.items.value).toEqual([]);
    expect(store.agentId.value).toBe(null);
    s1.release();
    s2.release();
    expect(ctx.slots.stores.snapshot()['conversation:dock-widget\u0000queue\u0000a~user']).toBeUndefined();
    s3.release();
    // 卸载级联：conversation fiber dispose → 出厂贡献一并消失
    await fibers.conversation.dispose();
    expect(ids()).not.toContain('queue');
    expect(ids()).not.toContain('interaction');
  });
});
