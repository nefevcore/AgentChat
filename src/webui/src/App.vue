<script setup lang="ts">
import { ref, provide, onMounted, watch } from 'vue';
import Sidebar from './components/Sidebar.vue';
import AgentList from './components/AgentList.vue';
import SessionList from './components/SessionList.vue';
import RunTrackingPanel from './components/RunTrackingPanel.vue';
import RunTracking from './components/RunTracking.vue';
import DialogView from './components/dialog/DialogView.vue';
import PairDialogView from './components/PairDialogView.vue';
import PerspectiveHost from './components/layout/PerspectiveHost.vue';
import CreateGroupDialog from './components/CreateGroupDialog.vue';
import SettingsPanel from './settings/components/SettingsPanel.vue';
import TokenUsage from './components/TokenUsage.vue';
import VersionDialog from './components/VersionDialog.vue';
import WorkspaceTree from './components/WorkspaceTree.vue';
import FilePreviewModal from './components/chat/FilePreviewModal.vue';
import ResizeHandle from './components/layout/ResizeHandle.vue';
import { Icon } from './ui';
import { useThemeStore } from './stores/theme';
import { useGroupsStore } from './stores/groups';
import { useSinglesStore } from './stores/singles';
import { useAgentStore } from './stores/agents';
import { useUiStore } from './stores/ui';
import { registerPerspective } from './core/registry/perspectives';
import { initUiExtensionHost } from './core/extensions';
import { VIEWER_ID } from './constants';

// 初始化主题
useThemeStore();

const groupsStore = useGroupsStore();
const singlesStore = useSinglesStore();
const ui = useUiStore();
const agentStore = useAgentStore();

// ── 标准布局模型：主区由侧边栏选择驱动 ──
// 选中 Agent / 群 / 独立会话（来自任何列表面板）→ 主区「运行矩阵」视图让位回聊天。
// 只在选中（非空）时收起：清空选择回到 talk 视角不打断矩阵浏览。
// 注意：本 watch 只覆盖「新选中（非空变化）」的快路径——同值重选与 toggle 反选
// （点当前已选中的 Agent）三元组不变/变空，不会触发；列表与运行面板的导航入口
// （AgentList/SessionList/RunTrackingPanel）已各自显式 ui.closeTrackingView()
// 收起覆盖层，不依赖此 watch。
watch(() => [agentStore.activeAgentId, groupsStore.activeGroupId, singlesStore.activeSingleId] as const,
  (cur, prev) => {
    const selected = cur.some((v, i) => v && v !== prev[i]);
    if (selected) {
      ui.closeTrackingView();
      ui.closePairView(); // pair 只读视角让位给真实选中上下文
    }
  });

// ── 视角注册（pair 最先：active 期间覆盖 talk；talk / group / single 共享 DialogView 内核）──
registerPerspective({
  id: 'pair', label: '会话对', icon: 'message-circle',
  active: () => !!ui.pairView,
  component: PairDialogView,
  props: () => ({ a: ui.pairView?.a ?? '', b: ui.pairView?.b ?? '' }),
});
registerPerspective({
  id: 'talk', label: '会话', icon: 'message-circle',
  active: () => !groupsStore.activeGroupId && !singlesStore.activeSingleId,
  component: DialogView,
  props: () => ({ group: null, single: null }),
});
registerPerspective({
  id: 'group', label: '群聊', icon: 'users',
  active: () => !!groupsStore.activeGroupId,
  component: DialogView,
  props: () => ({ group: groupsStore.groups.find(r => r.group_id === groupsStore.activeGroupId) ?? null, single: null }),
});
registerPerspective({
  id: 'single', label: '独立会话', icon: 'edit-3',
  active: () => !!singlesStore.activeSingleId,
  component: DialogView,
  props: () => ({ group: null, single: singlesStore.activeSingle }),
});

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('toggleSidebar', () => ui.toggleSidebar());
provide('closeSidebar', () => ui.closeSidebar());

onMounted(() => {
  groupsStore.init();
  // 刷新恢复：上次在独立会话 → 拉完列表后恢复选中（历史由 DialogView 的 single watch 加载）
  void singlesStore.refresh().then(() => { singlesStore.restoreLastSingle(); });
  // 深度 UI 扩展：内置视角注册在前（见 setup），插件视角等随后动态安装
  void initUiExtensionHost();
});
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="sidebar-overlay">
      <div v-if="ui.sidebarVisible" class="sidebar-overlay" @click="ui.closeSidebar" />
    </Transition>

    <!-- 第一层：侧边栏 -->
    <Sidebar
      :list-visible="ui.listVisible"
      :list-panel="ui.listPanel"
      @open-list-panel="ui.openListPanel"
      @open-global-settings="ui.openGlobalSettings"
      @open-agent-settings="ui.openAgentSettings(VIEWER_ID)"
      @open-token-usage="ui.openTokenUsage"
      @show-version="ui.openVersion"
    />

    <!-- 第二层：列表槽位（活动栏切换：Agent 列表 / 会话列表 / 运行跟踪清单；只换侧边栏，不动主区） -->
    <div v-if="ui.listVisible" class="list-panel-wrapper" :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" :style="{ width: ui.listWidth + 'px' }">
      <AgentList
        v-if="ui.listPanel === 'agents'"
        :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
        :groups="groupsStore.groups"
        :active-group-id="groupsStore.activeGroupId"
        @select-group="groupsStore.selectGroup"
        @deselect-group="groupsStore.deselectGroup"
        @create-group="groupsStore.openCreateGroup"
      />
      <SessionList
        v-else-if="ui.listPanel === 'sessions'"
        :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
        @deselect-group="groupsStore.deselectGroup"
      />
      <RunTrackingPanel
        v-else
        :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }"
      />
      <ResizeHandle kind="list" />
    </div>

    <!-- 第三层：主区 —— 聊天（视角容器驱动）或「运行矩阵」大画布视图；
         主区由侧边栏选择驱动：选中 Agent/群/会话 → 矩阵让位回聊天（上方 watch）。
         矩阵格子进入 pair 只读视角时：矩阵隐藏、聊天区渲染 pair 视角（注册在最前），
         返回（closePairView）→ 矩阵回归，不落在无选中的空白聊天区。
         聊天区用 v-show 保活（流式状态/草稿不因查看矩阵而丢失） -->
    <div class="main-area">
      <RunTracking v-if="ui.trackingViewVisible && !ui.pairView" />
      <div v-show="!ui.trackingViewVisible || ui.pairView" class="chat-area">
        <PerspectiveHost @group-deleted="groupsStore.onGroupDeleted" />
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

    <!-- 文件预览弹窗（全局单例） -->
    <FilePreviewModal
      :visible="ui.previewVisible"
      :file-path="ui.previewFilePath"
      :fallback-agent-id="ui.previewFallbackAgentId"
      @close="ui.closePreview"
    />

    <!-- 创建群组对话框 -->
    <CreateGroupDialog v-if="groupsStore.showCreateGroup" @close="groupsStore.closeCreateGroup" @created="groupsStore.onGroupCreated" />

    <!-- 全局配置面板（含 Agent 设置） -->
    <SettingsPanel
      :visible="ui.globalSettingsVisible"
      :initial-agent-id="ui.settingsAgentTarget"
      :initial-section="ui.settingsSectionTarget"
      @close="ui.closeSettings"
    />

    <!-- Token 用量面板 -->
    <TokenUsage :visible="ui.tokenUsageVisible" @close="ui.closeTokenUsage" />
  </div>

  <!-- 版本信息弹窗 -->
  <VersionDialog :visible="ui.versionVisible" @close="ui.closeVersion" />
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
