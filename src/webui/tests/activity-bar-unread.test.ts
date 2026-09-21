// @vitest-environment jsdom
// ============================================================
// webui/tests/activity-bar-unread.test.ts —— 活动栏「Agent 列表」
// 按钮未读聚合徽章验收
//
// 场景锚：single 会话激活时主侧边栏 Agent 名册不可见，Agent 私信
// 只在名册行有数字徽章——活动栏按钮需同步展示未读总数（同源
// feed 分区 unread 聚合）。口径按按钮归属面板分列（修复：JOB 返回等
// single 机制通知曾被计入 Agent 列表徽章，名册无 single 行无处落点）：
//   · Agent 列表徽章 = direct 对桶 + group 群聊（名册行口径）；
//   · 会话列表徽章 = single 分区（归属面板是 SessionList）；
//   · 未读 >0 才渲染，0/无分区不渲染；多分区求和，>99 封顶「99+」；
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

/** 按钮标题定位其徽章（Agent 列表 / 会话列表各一） */
function badgeText(root: HTMLElement, title: string): string | null {
  const btn = [...root.querySelectorAll('button')].find(b => b.title === title);
  const el = btn?.querySelector('.unread-badge') ?? null;
  return el ? (el.textContent ?? '') : null;
}

describe('活动栏 Agent 列表按钮未读聚合徽章', () => {
  it('Agent 列表徽章：direct+group 求和、>99 封顶「99+」、0 不渲染', async () => {
    const { root, feed, unmount } = await mountBar();
    expect(badgeText(root, 'Agent 列表')).toBeNull(); // 初始无未读 → 无徽章
    seedUnread(feed, 'alpha', 3);
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('3');
    seedUnread(feed, 'beta', 200); // 203 → 封顶
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('99+');
    unmount();
  });

  it('进入会话清除（clearUnread）→ 徽章即时回落', async () => {
    const { root, feed, unmount } = await mountBar();
    seedUnread(feed, 'alpha', 2);
    seedUnread(feed, 'beta', 5);
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('7');
    feed.clearUnread(directDialog('alpha')); // AgentList 选中路径同款调用
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('5');
    feed.clearUnread(directDialog('beta'));
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBeNull();
    unmount();
  });

  it('口径分列：single 未读只进会话列表徽章，不进 Agent 列表（JOB 返回修复）', async () => {
    const { root, feed, unmount } = await mountBar();
    seedUnread(feed, 'alpha', 1);                          // direct 私信
    seedUnread(feed, groupDialog('room-a'), 2);            // 群聊（group/message-posted 增量）
    seedUnread(feed, singleDialog('sess-1'), 4);           // single 会话（JOB 返回等机制通知）
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('3');       // 1+2：single 4 不计入
    expect(badgeText(root, '会话列表')).toBe('4');          // single 归属面板提示位
    feed.setActiveGroup('room-a'); // ui-group selectGroup 同款 → 清群未读
    await nextTick();
    expect(badgeText(root, 'Agent 列表')).toBe('1');
    feed.setActiveSingle('sess-1'); // 进会话即清（setActiveSingle 路径）
    await nextTick();
    expect(badgeText(root, '会话列表')).toBeNull();
    expect(badgeText(root, 'Agent 列表')).toBe('1');       // 互不串扰
    unmount();
  });
});
