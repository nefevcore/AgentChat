// @vitest-environment jsdom
// ============================================================
// webui/tests/activity-bar-unread.test.ts —— 活动栏「Agent 列表」
// 按钮未读聚合徽章验收
//
// 场景锚：single 会话激活时主侧边栏 Agent 名册不可见，Agent 私信
// 只在名册行有数字徽章——活动栏按钮需同步展示未读总数（同源
// feed 分区 unread 聚合）。契约：
//   · 未读 >0 才渲染，0/无分区不渲染；
//   · 多 Agent 求和，>99 封顶「99+」；
//   · 清除对应会话未读（clearUnread）→ 徽章即时回落。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import ActivityBar from 'ac-client-ui-layout/client/ActivityBar.vue';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import { directDialog, groupDialog, singleDialog } from 'ac-client-ui-conversation/client/feed.ts';

type FeedStore = ReturnType<typeof useFeedStore>;

async function mountBar(): Promise<{ root: HTMLElement; feed: FeedStore; unmount: () => void }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(ActivityBar, { primaryVisible: false, primaryPanel: 'agents' }) });
  const pinia = createPinia();
  app.use(pinia); // install 即 setActivePinia——测试侧 useFeedStore 与组件内同实例
  const feed = useFeedStore();
  app.mount(root);
  await nextTick();
  return { root, feed, unmount: () => { app.unmount(); root.remove(); } };
}

/** 造未读：ensureById 建分区后直接置 unread（与 showInbound / group/message-posted
 *  增量路径同字段——agent=direct 对桶 / group / single 按前缀自分发） */
function seedUnread(feed: FeedStore, agentId: string, n: number) {
  const id = agentId.startsWith('group:') || agentId.startsWith('single:')
    ? (agentId as never)
    : directDialog(agentId);
  feed.ensureById(id);
  (feed.dialogs as Record<string, { unread: number }>)[id].unread = n;
}

function badgeText(root: HTMLElement): string | null {
  const el = root.querySelector('.unread-badge');
  return el ? (el.textContent ?? '') : null;
}

describe('活动栏 Agent 列表按钮未读聚合徽章', () => {
  it('未读聚合：多 Agent 求和、>99 封顶「99+」、0 不渲染', async () => {
    const { root, feed, unmount } = await mountBar();
    expect(badgeText(root)).toBeNull(); // 初始无未读 → 无徽章
    seedUnread(feed, 'alpha', 3);
    await nextTick();
    expect(badgeText(root)).toBe('3');
    seedUnread(feed, 'beta', 200); // 203 → 封顶
    await nextTick();
    expect(badgeText(root)).toBe('99+');
    unmount();
  });

  it('进入会话清除（clearUnread）→ 徽章即时回落', async () => {
    const { root, feed, unmount } = await mountBar();
    seedUnread(feed, 'alpha', 2);
    seedUnread(feed, 'beta', 5);
    await nextTick();
    expect(badgeText(root)).toBe('7');
    feed.clearUnread(directDialog('alpha')); // AgentList 选中路径同款调用
    await nextTick();
    expect(badgeText(root)).toBe('5');
    feed.clearUnread(directDialog('beta'));
    await nextTick();
    expect(badgeText(root)).toBeNull();
    unmount();
  });

  it('聚合口径含群聊与 single 分区（全分区求和——群徽章需求连带）', async () => {
    const { root, feed, unmount } = await mountBar();
    seedUnread(feed, 'alpha', 1);                          // direct 私信
    seedUnread(feed, groupDialog('room-a'), 2);            // 群聊（group/message-posted 增量）
    seedUnread(feed, singleDialog('sess-1'), 4);           // single 会话
    await nextTick();
    expect(badgeText(root)).toBe('7');
    feed.setActiveGroup('room-a'); // ui-group selectGroup 同款 → 清群未读
    await nextTick();
    expect(badgeText(root)).toBe('5');
    unmount();
  });
});
