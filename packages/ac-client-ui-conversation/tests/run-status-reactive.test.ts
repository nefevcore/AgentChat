// @vitest-environment jsdom
// ============================================================
// run-status-reactive.test.ts —— Host 响应式链回归（cr-749 根修）
// 根因：流式写入部分经 feed-core 的非 reactive 载体 Map（原始引用改属性
// 不触发 computed）——thinking 逐帧到达但状态卡不重算。修复 = Host
// computed 读 lastStreamAt 挂依赖锚（bump 每帧经代理更新）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import RunStatusDockHost from '../client/RunStatusDockHost.vue';
import { useFeedStore } from '../client/feedStore.ts';

describe('探针：真实组件挂载 + 逐帧 reasoning', () => {
  it('Host 渲染文案随思考流更新', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp({ render: () => h(RunStatusDockHost, { data: { agentId: 'alpha', conversationId: 'alpha~user' } }) });
    app.use(pinia);
    app.mount(root);
    await nextTick();
    const feed = useFeedStore();
    feed.init();
    const meta = { agent: 'alpha', conversationId: 'alpha~user', sender: 'user', source: 'user' };
    feed.append('pair:alpha|user' as never, { id: 'u1', role: 'agent', content: 'hi', timestamp: Date.now(), agent_id: 'user' });
    feed.ensureById('pair:alpha|user' as never).streaming = true;
    feed.ingestFrame('loop/run-started', [meta]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    await nextTick();
    console.log('T1 started:', root.textContent?.trim());
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { reasoning: '思' }]);
    await nextTick();
    console.log('T2 reasoning1:', root.textContent?.trim());
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId: 'r1:0' } }, { reasoning: '考' }]);
    await nextTick();
    console.log('T3 reasoning2:', root.textContent?.trim());
    expect(root.textContent).toContain('思考');
    app.unmount();
  });
});