// ============================================================
// client/searchTabs.ts —— 网络搜索多 tab 状态（aux 'search' 选区）
//
// pinia store（id 'webSearchTabs'——web 域自有）：tab 列表 + activeKey
// + 面板开合意愿（panelOpen——与 auxVisible 分立：选区选举用后者，
// 本 store 只持 tab 语义）。数据 = 工具卡点击时的结果快照（卡片
// data 里有 query/results/answer 等全量，无需按需拉取——与 preview
// 的按 path 现读分立）。
//
// 同 query 复用刷新（重试/翻页同 key 更新内容，不开新 tab）；LRU
// 淘汰上限（MAX_SEARCH_TABS——防长会话无限累积）。开 tab 的联动
// （选区置位 + 区域展开）不住本 store——消费方（ToolResultWeb/
// rail activate）持 uiStore 引用自理，store 保持纯 tab 状态机
// （可单测、零 layout 依赖；同 previewTabs 姿势）。
// ============================================================
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

/** 搜索结果单项（快照形状——web_search 输出 results 元素子集） */
export interface SearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
}

/** 搜索 tab（key = query 归一——同 query 复用刷新） */
export interface SearchTab {
  key: string;
  query: string;
  provider?: string;
  answer?: string | null;
  responseTime?: number;
  credits?: number | null;
  results: SearchHit[];
}

/** tab 数上限（LRU 淘汰：超出关最旧非激活 tab） */
export const MAX_SEARCH_TABS = 8;

export const useWebSearchTabsStore = defineStore('webSearchTabs', () => {
  const tabs = ref<SearchTab[]>([]);
  const activeKey = ref('');
  /** 面板开合意愿（关闭 = 收 tab 不清；重开恢复上次 tab） */
  const panelOpen = ref(false);

  const activeTab = computed(() => tabs.value.find((t) => t.key === activeKey.value) ?? null);
  const count = computed(() => tabs.value.length);

  /** 打开（或刷新既有）tab；超上限 LRU 淘汰最旧非激活 tab。返回 activeKey。
   *  同 query 再搜 = 刷新该 tab 内容（重试/翻页不开重复 tab）。 */
  function openTab(payload: Omit<SearchTab, 'key'> & { key?: string }): string {
    const key = (payload.key ?? payload.query).trim();
    const existing = tabs.value.find((t) => t.key === key);
    if (existing) {
      Object.assign(existing, payload, { key });
      activeKey.value = key;
      panelOpen.value = true;
      return key;
    }
    // LRU 淘汰：满员时移除最旧的非激活 tab（active 永不淘汰）
    if (tabs.value.length >= MAX_SEARCH_TABS) {
      const victim = tabs.value.find((t) => t.key !== activeKey.value) ?? tabs.value[0]!;
      tabs.value = tabs.value.filter((t) => t !== victim);
    }
    tabs.value.push({ ...payload, key });
    activeKey.value = key;
    panelOpen.value = true;
    return key;
  }

  /** 关闭 tab：激活让位给相邻（优先右侧，无则左侧）；全关 → 面板收起 */
  function closeTab(key: string) {
    const idx = tabs.value.findIndex((t) => t.key === key);
    if (idx === -1) return;
    tabs.value.splice(idx, 1);
    if (activeKey.value === key) {
      const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null; // 右邻优先
      if (next) activeKey.value = next.key;
      else {
        activeKey.value = '';
        panelOpen.value = false; // 全关：面板无内容可显
      }
    }
  }

  function activate(key: string) {
    if (tabs.value.some((t) => t.key === key)) activeKey.value = key;
  }

  /** 关闭全部（面板「全部关闭」动作；面板收起语义） */
  function closeAll() {
    tabs.value = [];
    activeKey.value = '';
    panelOpen.value = false;
  }

  function openPanel() { panelOpen.value = true; }
  function closePanel() { panelOpen.value = false; }

  return {
    tabs, activeKey, activeTab, count, panelOpen,
    openTab, closeTab, activate, closeAll, openPanel, closePanel,
  };
});

/**
 * 打开搜索侧边栏面板（共享入口——卡片摘要行点击与工具卡 Label 直达
 * 两处消费）：工具卡 data → tab 快照 + 显式选区 + 舒适宽 + 展开。
 * 窄屏（≤768 抽屉形态）无侧栏空间：返回 false（调用方自行兜底——
 * 卡内原地展开等）。
 */
export function openSearchPanel(data: Record<string, unknown>): boolean {
  if (typeof window !== 'undefined' && window.innerWidth <= 768) return false;
  const tabs = useWebSearchTabsStore();
  const results = Array.isArray(data.results)
    ? (data.results as Array<Record<string, unknown>>).map((r) => ({
        title: String(r.title ?? ''), url: String(r.url ?? ''),
        content: String(r.content ?? ''), score: Number(r.score ?? 0),
      }))
    : [];
  tabs.openTab({
    query: String(data.query ?? ''),
    provider: String(data.provider || '') || undefined,
    answer: String(data.answer || '') || null,
    responseTime: Number(data.response_time ?? 0) || undefined,
    credits: (data.credits_used ?? null) as number | null,
    results,
  });
  const ui = useUiStore();
  ui.selectAuxPanel('search'); // 显式选区（panelOpen 已随 openTab 置真）
  ui.applyAuxPanelWidth('search'); // 舒适宽单源（注册处 480）
  ui.openAux(); // 收起态点击 → 面板弹出
  return true;
}
