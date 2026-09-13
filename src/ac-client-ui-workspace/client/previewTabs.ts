// ============================================================
// client/previewTabs.ts —— 文件预览多 tab 状态（P1 aux 预览选区）
//
// pinia store（id 'previewTabs'——workspace 域自有）：tab 列表 +
// activeKey + 面板开合意愿（panelOpen——与 auxVisible 分立：选区
// 选举用后者，本 store 只持 tab 语义）。同 path 去重复用（激活既有
// tab）；LRU 淘汰上限（MAX_TABS，缺省 8——防长会话无限累积）。
//
// 开 tab 的联动（选区切换 + 区域展开）不住本 store——消费方
//（FilePreviewPanel/意图 watch）持 uiStore 引用自理，store 保持
// 纯 tab 状态机（可单测、零 layout 依赖）。
// ============================================================
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ReadContext } from './workspaceFile.ts';
import type { PreviewViewMode } from './filePreviewContent.ts';

interface PreviewTab {
  /** 去重键 = 请求路径（含 files/ 前缀形态） */
  key: string;
  /** fallback 候选桶（打开时快照——同 key 复用不覆盖） */
  fallbackAgentId: string;
  /** 会话键快照（M32：服务端按挂载工作区推导相对引用；同 key 复用不覆盖） */
  conversationId: string;
  /** 自动换行（per-tab 记忆——代码类视图生效；缺省关 = 横向滚动） */
  wrap?: boolean;
  /** 视图模式（per-tab 记忆）：'auto' = 按扩展名识别分派；其余为显式格式
   *  （markdown 渲染 / code 高亮 / text 纯文本 / image 图片 / html 网页）——
   *  可选集由文件能力检查（previewModeOptions）先行过滤。缺省 'auto'。 */
  viewMode?: PreviewViewMode;
}

/** tab 数上限（LRU 淘汰：超出关最旧非激活 tab） */
export const MAX_PREVIEW_TABS = 8;

/** 去重比较键：分隔符归一（\ → /）。同一文件的两种写法（src\a/b.ts 与
 *  src/a/b.ts——LLM 输出常见混形）指向同一目标（服务端 path.resolve 双
 *  分隔符同权），不该开两个 tab。仅作比较，tab 保留首开时的原 key。 */
function normKey(p: string): string {
  return p.replace(/\\/g, '/');
}

export const usePreviewTabsStore = defineStore('previewTabs', () => {
  const tabs = ref<PreviewTab[]>([]);
  const activeKey = ref('');
  /** 面板开合意愿（关闭 = 收 tab 不清；重开恢复上次 tab） */
  const panelOpen = ref(false);

  const activeTab = computed(() => tabs.value.find((t) => t.key === activeKey.value) ?? null);
  const count = computed(() => tabs.value.length);

  /** 打开（或激活既有）tab；超上限 LRU 淘汰最旧非激活 tab。返回 activeKey。
   *  ctx（M32 读面推导上下文）：fallback 桶 + 会话键快照进 tab。
   *  去重按分隔符归一键（normKey）——同文件双写法复用既有 tab，不新开。 */
  function openTab(path: string, ctx: ReadContext = {}): string {
    const existing = tabs.value.find((t) => normKey(t.key) === normKey(path));
    if (existing) {
      activeKey.value = existing.key;
      panelOpen.value = true;
      return existing.key;
    }
    // LRU 淘汰：满员时移除最旧的非激活 tab（active 永不淘汰；首开时
    // active 为空/不在 tabs，移除头部即可）
    if (tabs.value.length >= MAX_PREVIEW_TABS) {
      const victim = tabs.value.find((t) => t.key !== activeKey.value) ?? tabs.value[0]!;
      tabs.value = tabs.value.filter((t) => t !== victim);
    }
    tabs.value.push({ key: path, fallbackAgentId: ctx.agentId ?? '', conversationId: ctx.conversationId ?? '' });
    activeKey.value = path;
    panelOpen.value = true;
    return path;
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

  /** per-tab 视图偏好翻转（wrap/viewMode——写回 tab 对象；无关 tab 不动） */
  function toggleWrap(key: string) {
    const t = tabs.value.find((x) => x.key === key);
    if (t) t.wrap = !t.wrap;
  }
  function setViewMode(key: string, mode: PreviewViewMode) {
    const t = tabs.value.find((x) => x.key === key);
    if (t) t.viewMode = mode;
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
    openTab, closeTab, activate, toggleWrap, setViewMode, closeAll, openPanel, closePanel,
  };
});
