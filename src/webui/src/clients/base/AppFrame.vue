<script setup lang="ts">
// ============================================================
// clients/base/AppFrame.vue —— layout 基础件视图（原 App.vue 原样迁入，M27 S1）
//
// 「壳也是插件」（D19）：本组件占 root 席位；原三层布局 DOM / 样式
// 原样保留，四个区域的挂载点改经 SlotOutlet（零包裹——D23-A，DOM
// 结构不变，视觉基线 diff 为零）：
//   · sidebar seat   —— Sidebar（活动栏）
//   · list-panel seat —— 三面板壳（agents/sessions/tracking 三选一）
//   · main seat      —— PerspectiveHost（视角专座容器）+ 工作区分屏
//   · overlay seat   —— 全局弹窗（FilePreview/建群/设置/用量/版本）
// 外部贡献（未出现）经同轴 order 与宿主内置项合并（D16-①）。
// ============================================================
import { ref, provide, onMounted, watch, computed, type Component } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import Sidebar from '../../components/Sidebar.vue';
import AgentList from '../../components/AgentList.vue';
import SessionList from '../../components/SessionList.vue';
import RunTrackingPanel from '../../components/RunTrackingPanel.vue';
import RunTracking from '../../components/RunTracking.vue';
import DialogView from '../../components/dialog/DialogView.vue';
import PairDialogView from '../../components/PairDialogView.vue';
import PerspectiveHost from '../../components/layout/PerspectiveHost.vue';
import CreateGroupDialog from '../../components/CreateGroupDialog.vue';
import SettingsPanel from '../../settings/components/SettingsPanel.vue';
import TokenUsage from '../../components/TokenUsage.vue';
import VersionDialog from '../../components/VersionDialog.vue';
import WorkspaceTree from '../../components/WorkspaceTree.vue';
import FilePreviewModal from '../../components/chat/FilePreviewModal.vue';
import ResizeHandle from '../../components/layout/ResizeHandle.vue';
import SlotOutlet from '../../components/SlotOutlet.vue';
import { SlotOutletItem } from '../../components/SlotOutletItem';
import { Icon } from '../../ui';
import { useThemeStore } from '../../stores/theme';
import { useAgentStore } from '../../stores/agents';
import { useUiStore } from '../../stores/ui';
import { SLOT_KEY as PERSPECTIVE_SLOT } from '../../core/registry/perspectives';
import { VIEWER_ID } from '../../constants';

// 初始化主题
useThemeStore();

// group 域投影（M27 S2）：跨域消费走客户端服务面（ctx.groups）——
// 域件未装载/已摘除 → undefined → 群入口/群聊视角消失（可摘除性，D19）
const groupSvc = useClientContext()?.groups;
const groups = computed(() => groupSvc?.groups.value ?? []);
const activeGroupId = computed(() => groupSvc?.activeGroupId.value ?? '');
const showCreateGroup = computed(() => groupSvc?.showCreateGroup.value ?? false);
function selectGroup(id: string) { groupSvc?.selectGroup(id); }
function deselectGroup() { groupSvc?.deselectGroup(); }
function onGroupCreated(id: string) { groupSvc?.onGroupCreated(id); }
function onGroupDeleted(id: string) { groupSvc?.onGroupDeleted(id); }

// singles 域投影（M27 S2）：跨域消费走客户端服务面（ctx.singleBoard）
// ——域件未装载/已摘除 → undefined → 独立会话视角消失（可摘除性，D19）
const singlesBoard = useClientContext()?.singleBoard;
const activeSingleId = computed(() => singlesBoard?.activeSingleId.value ?? '');
const activeSingle = computed(() => singlesBoard?.activeSingle.value ?? null);

const ui = useUiStore();
const agentStore = useAgentStore();

// ── 标准布局模型：主区由侧边栏选择驱动 ──
// 选中 Agent / 群 / 独立会话（来自任何列表面板）→ 主区「运行矩阵」视图让位回聊天。
// 只在选中（非空）时收起：清空选择回到 talk 视角不打断矩阵浏览。
// 注意：本 watch 只覆盖「新选中（非空变化）」的快路径——同值重选与 toggle 反选
// （点当前已选中的 Agent）三元组不变/变空，不会触发；列表与运行面板的导航入口
// （AgentList/SessionList/RunTrackingPanel）已各自显式 ui.closeTrackingView()
// 收起覆盖层，不依赖此 watch。
watch(() => [agentStore.activeAgentId, activeGroupId.value, activeSingleId.value] as const,
  (cur, prev) => {
    const selected = cur.some((v, i) => v && v !== prev[i]);
    if (selected) {
      ui.closeTrackingView();
      ui.closePairView(); // pair 只读视角让位给真实选中上下文
    }
  });

// ── 视角注册（pair 最先：active 期间覆盖 talk；talk / group / single 共享 DialogView 内核）──
// D8 收窄（M27 S3）：宿主内部出厂批次走 slots 直注册（旧注册面唯一
// 入口 = bridge 第三方转发；对齐 tool 基础件 BUILTIN 批次形态）
{
  const clientCtx = useClientContext();
  const builtins: Array<{ id: string; label: string; icon: string; active: () => boolean; component: unknown; props?: () => Record<string, unknown> }> = [
    {
      id: 'pair', label: '会话对', icon: 'message-circle',
      active: () => !!ui.pairView,
      component: PairDialogView,
      props: () => ({ a: ui.pairView?.a ?? '', b: ui.pairView?.b ?? '' }),
    },
    {
      id: 'talk', label: '会话', icon: 'message-circle',
      active: () => !activeGroupId.value && !activeSingleId.value,
      component: DialogView,
      props: () => ({ group: null, single: null }),
    },
    {
      id: 'group', label: '群聊', icon: 'users',
      active: () => !!activeGroupId.value,
      component: DialogView,
      props: () => ({ group: groups.value.find(r => r.group_id === activeGroupId.value) ?? null, single: null }),
    },
    {
      id: 'single', label: '独立会话', icon: 'edit-3',
      active: () => !!activeSingleId.value,
      component: DialogView,
      props: () => ({ group: null, single: activeSingle.value }),
    },
  ];
  for (const p of builtins) {
    clientCtx?.slots.register(PERSPECTIVE_SLOT, {
      id: p.id,
      component: p.component as Component,
      meta: { def: p },
    });
  }
}

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('toggleSidebar', () => ui.toggleSidebar());
provide('closeSidebar', () => ui.closeSidebar());

onMounted(() => {
  groupSvc?.init(); // group 域件未装载 → 跳过（群消费面消失，可摘除性）
  // 刷新恢复：上次在独立会话 → 拉完列表后恢复选中（历史由 DialogView 的 single watch 加载）
  void singlesBoard?.refresh().then(() => { singlesBoard?.restoreLastSingle(); });
});
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="sidebar-overlay">
      <div v-if="ui.sidebarVisible" class="sidebar-overlay" @click="ui.closeSidebar" />
    </Transition>

    <!-- 第一层：侧边栏（seat: sidebar） -->
    <SlotOutlet name="sidebar">
      <SlotOutletItem>
        <Sidebar
          :list-visible="ui.listVisible"
          :list-panel="ui.listPanel"
          @open-list-panel="ui.openListPanel"
          @open-global-settings="ui.openGlobalSettings"
          @open-agent-settings="ui.openAgentSettings(VIEWER_ID)"
          @open-token-usage="ui.openTokenUsage"
          @show-version="ui.openVersion"
        />
      </SlotOutletItem>
    </SlotOutlet>

    <!-- 第二层：列表槽位（seat: list-panel；活动栏切换：Agent 列表 / 会话列表 /
         运行跟踪清单三选一，只换侧边栏，不动主区） -->
    <div v-if="ui.listVisible" class="list-panel-wrapper" :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" :style="{ width: ui.listWidth + 'px' }">
      <SlotOutlet name="list-panel">
        <SlotOutletItem v-if="ui.listPanel === 'agents'">
          <AgentList
            :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
            :groups="groups"
            :active-group-id="activeGroupId"
            @select-group="selectGroup"
            @deselect-group="deselectGroup"
            @create-group="groupSvc?.openCreateGroup"
          />
        </SlotOutletItem>
        <SlotOutletItem v-else-if="ui.listPanel === 'sessions'">
          <SessionList
            :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
            @deselect-group="deselectGroup"
          />
        </SlotOutletItem>
        <SlotOutletItem v-else>
          <RunTrackingPanel :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" />
        </SlotOutletItem>
      </SlotOutlet>
      <ResizeHandle kind="list" />
    </div>

    <!-- 第三层：主区（seat: main）—— 聊天（视角容器驱动）或「运行矩阵」大画布视图；
          主区由侧边栏选择驱动：选中 Agent/群/会话 → 矩阵让位回聊天（上方 watch）。
          矩阵格子进入 pair 只读视角时：矩阵隐藏、聊天区渲染 pair 视角（注册在最前），
          返回（closePairView）→ 矩阵回归，不落在无选中的空白聊天区。
          聊天区用 v-show 保活（流式状态/草稿不因查看矩阵而丢失） -->
    <div class="main-area">
      <RunTracking v-if="ui.trackingViewVisible && !ui.pairView" />
      <div v-show="!ui.trackingViewVisible || ui.pairView" class="chat-area">
        <SlotOutlet name="main">
          <SlotOutletItem>
            <PerspectiveHost @group-deleted="onGroupDeleted" />
          </SlotOutletItem>
        </SlotOutlet>
        <template v-if="ui.workspaceVisible">
          <ResizeHandle kind="workspace" />
          <WorkspaceTree
            :style="{ width: ui.workspaceWidth + 'px' }"
            @preview-file="ui.openPreview"
            @close="ui.workspaceVisible = false"
          />
        </template>
        <!-- 右侧悬浮工作区把手：不占布局，点击展开；展开后隐藏（面板自带关闭按钮） -->
        <button
          v-show="!ui.workspaceVisible"
          class="workspace-rail"
          @click="ui.toggleWorkspace"
          title="工作区"
        >
          <Icon name="panel-right" :size="18" />
        </button>
      </div>
    </div>

    <!-- 全局覆盖层（seat: overlay）—— 全局弹窗与各域覆盖层 -->
    <SlotOutlet name="overlay">
      <SlotOutletItem>
        <!-- 文件预览弹窗（全局单例） -->
        <FilePreviewModal
          :visible="ui.previewVisible"
          :file-path="ui.previewFilePath"
          :fallback-agent-id="ui.previewFallbackAgentId"
          @close="ui.closePreview"
        />
      </SlotOutletItem>
      <SlotOutletItem>
        <!-- 创建群组对话框 -->
        <CreateGroupDialog v-if="showCreateGroup" @close="groupSvc?.closeCreateGroup()" @created="onGroupCreated" />
      </SlotOutletItem>
      <SlotOutletItem>
        <!-- 全局配置面板（含 Agent 设置） -->
        <SettingsPanel
          :visible="ui.globalSettingsVisible"
          :initial-agent-id="ui.settingsAgentTarget"
          :initial-section="ui.settingsSectionTarget"
          @close="ui.closeSettings"
        />
      </SlotOutletItem>
      <SlotOutletItem>
        <!-- Token 用量面板 -->
        <TokenUsage :visible="ui.tokenUsageVisible" @close="ui.closeTokenUsage" />
      </SlotOutletItem>
      <SlotOutletItem>
        <!-- 版本信息弹窗 -->
        <VersionDialog :visible="ui.versionVisible" @close="ui.closeVersion" />
      </SlotOutletItem>
    </SlotOutlet>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex; height: 100vh; width: 100vw; overflow: hidden; position: relative;
}

.main-area {
  flex: 1; display: flex; min-width: 0; height: 100vh; overflow: hidden;
  position: relative; /* 悬浮把手的定位上下文 */
}

/* 聊天区分屏容器（跟踪页打开时 display:none 保活隐藏） */
.chat-area {
  flex: 1; display: flex; min-width: 0; overflow: hidden; height: 100%;
}

.list-panel-wrapper {
  display: flex; flex-shrink: 0; overflow: hidden;
}

/* 右侧悬浮工作区把手：小块贴右缘，避开顶部 header，不挤压会话区布局 */
.workspace-rail {
  position: absolute;
  /* 避开 chat-header + 首行消息头像（16px 容器 padding + 32px 头像 + 16px 间隔）：
     首次会话第一条用户消息靠右上，12px 间隔时把手正好盖住头像 */
  top: calc(var(--layout-header-height, 48px) + 64px);
  right: 0;
  width: 36px;
  height: 40px; /* 对齐工具按钮高度 */
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-right: none;
  border-radius: 8px 0 0 8px;
  background: var(--color-bg-page, #fff);
  cursor: pointer;
  color: var(--color-text-muted, #999);
  z-index: 90; /* 低于 ChatView header(z-100)，高于消息内容 */
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.06);
}
.workspace-rail:hover {
  background: var(--color-bg-surface, #f5f5f5);
  color: var(--color-text-primary);
}

.sidebar-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 110;
}
.sidebar-overlay-enter-active, .sidebar-overlay-leave-active { transition: opacity 0.2s; }
.sidebar-overlay-enter-from, .sidebar-overlay-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .list-panel-wrapper {
    position: fixed; left: 0; top: 0; bottom: 0;
    z-index: 120; /* 盖住 ChatView header(z-100) 与 overlay(z-110)：移动端抽屉置顶 */
  }
  /* 移动端工作区为覆盖式面板（自带关闭按钮），隐藏右侧把手 */
  .workspace-rail { display: none; }
  /* 收起时：无阴影 + 点击穿透（避免透明占位拦截 sidebar 图标栏） */
  .list-panel-wrapper:not(.sidebar-mobile-visible) {
    pointer-events: none;
  }
  /* 阴影仅在侧边栏展开时显示，收起时避免边缘残留 */
  .list-panel-wrapper.sidebar-mobile-visible {
    box-shadow: 2px 0 12px rgba(0,0,0,0.15);
    pointer-events: auto;
  }
}
</style>
