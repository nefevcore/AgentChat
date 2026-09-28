// ============================================================
// client/useUnreadBadges.ts —— 未读聚合单源（cr-35，归位 conversation：
// feedStore 的家——徽章聚合 = feed 分区数据的展示工具）
//
// 消费方：ActivityBar（活动栏按钮）+ MobileTabBar（底部标签栏）同源共享。
// 口径按按钮归属面板分列（修复史：此前 Agent 列表徽章全分区求和，
// single 会话的机制通知也计入，而名册只列 Agent/群没有 single 行，
// 徽章亮起却无处落点）：
//   · Agent 列表 = direct 对桶 + group 群聊（名册行口径——single 会话
//     激活时名册不可见，Agent 私信仍经此按钮提示不漏）；
//   · 会话列表   = single 独立会话（SessionList 是其归属面板与唯一提示位）。
// ============================================================
import { computed } from 'vue';
import { useFeedStore } from './feedStore.ts';

export function useUnreadBadges() {
  const feedStore = useFeedStore();

  /** Agent 名册口径（direct + group；single: 前缀排除） */
  const agentsUnreadTotal = computed(() => {
    let n = 0;
    for (const [id, d] of Object.entries(feedStore.dialogs)) {
      if (d && !id.startsWith('single:')) n += d.unread;
    }
    return n;
  });

  /** single 独立会话口径 */
  const singlesUnreadTotal = computed(() => {
    let n = 0;
    for (const [id, d] of Object.entries(feedStore.dialogs)) {
      if (d && id.startsWith('single:')) n += d.unread;
    }
    return n;
  });

  const fmt = (n: number) => (n > 99 ? '99+' : String(n));
  return {
    agentsUnreadTotal,
    singlesUnreadTotal,
    agentsUnreadLabel: computed(() => fmt(agentsUnreadTotal.value)),
    singlesUnreadLabel: computed(() => fmt(singlesUnreadTotal.value)),
  };
}