// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-conversation.test.ts —— S2 conversation 基础件
// 验收（feed/chat 巨石收口：ctx.sessions 会话服务）
//
// §0.3：feed（信息流核心）+ chat（动作核心）归 conversation 基础件，
// 双模门面回落独立实例（feed 状态机测试族零改动的验证锚）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { createClient } from 'ac-client-runtime';
import { conversationBasePlugin } from '../src/clients/base/conversation';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useFeedStore } from '../src/stores/feed';
import { useChatStore } from '../src/stores/chat';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

describe('S2 · conversation 基础件（ctx.sessions = feed + chat 核心）', () => {
  beforeEach(() => {
    // feed 的 activeDialogId 派生链经 useAgentStore 门面（roster 门面回落
    // 独立 Core——与既有 feed 状态机测试同款前置）
    setActivePinia(createPinia());
  });

  it('服务装载：ctx.sessions.feed/chat 可解析；reactive 视图注入（feed 属性解包访问）', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(conversationBasePlugin);
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
    const app = await bootWebuiRuntime();
    const fiber = await app.ctx.plugin(conversationBasePlugin);
    setActivePinia(createPinia());
    const feedStore = useFeedStore();
    const chatStore = useChatStore();
    // chat 门面 = 服务 chat（视图状态派生自服务 feed：unreadAgents 桥）
    // feed 门面 = 服务 feed（同一 refs：activeGroupId 写入 → 分区派生互通）
    feedStore.setActiveGroup('g1', 'helper');
    expect(app.ctx.sessions.feed.activeGroupId.value).toBe('g1');
    expect(feedStore.activeDialogId).toBe('group:g1');
    expect(app.ctx.sessions.chat.contextBusy.value).toBe(false);
    await fiber.dispose();
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
    const fiber = await ctx.plugin(conversationBasePlugin);
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
});
