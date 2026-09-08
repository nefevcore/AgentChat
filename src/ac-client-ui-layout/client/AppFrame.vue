<script setup lang="ts">
// ============================================================
// clients/base/AppFrame.vue —— layout 基础件视图（原 App.vue 原样迁入，M27 S1）
//
// 「壳也是插件」（D19）：本组件占 root 席位；原三层布局 DOM / 样式
// 原样保留，四个区域的挂载点改经 SlotOutlet（零包裹——D23-A，DOM
// 结构不变，视觉基线 diff 为零）：
//   · sidebar seat   —— sidebar 基础件贡献（SidebarHost，M27.2-1 迁出）
//   · list-panel seat —— 三面板壳（sidebar 基础件贡献，M27.2-1 迁出）
//   · main seat      —— PerspectiveHost（视角专座容器）+ 工作区分屏
//                      （树体 = ui-workspace 行 main:workspace 贡献，M28 P1）
//   · overlay seat   —— 全局弹窗（设置/建群/用量/版本内联；文件预览 =
//                      ui-workspace 行贡献，M28 P1）
// 外部贡献（未出现）经同轴 order 与宿主内置项合并（D16-①）。
// ============================================================
import { ref, provide, watch, computed, onBeforeUnmount } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import PerspectiveHost from './PerspectiveHost.vue';
import TokenUsage from './TokenUsage.vue';
import VersionDialog from './VersionDialog.vue';
import ResizeHandle from './ResizeHandle.vue';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import { SlotOutletItem } from 'ac-client-ui-renderer/client/SlotOutletItem.ts';
import { Icon } from '@agentchat/webui-kit';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { useAgentStore } from 'ac-client-ui-conversation/client/agentsStore.ts';
import { useUiStore } from 'ac-client-ui-sidebar/client/uiStore.ts';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';

const clientCtx = useClientContext();

// 初始化主题
useThemeStore();

// group 域投影（M27 S2）：跨域消费走客户端服务面（ctx.groups）——
// 域件未装载/已摘除 → undefined → 群视角/建群弹窗消失（可摘除性，D19）
const groupSvc = clientCtx?.groups;
const activeGroupId = computed(() => groupSvc?.activeGroupId.value ?? '');
function onGroupDeleted(id: string) { groupSvc?.onGroupDeleted(id); }

// singles 域投影（M27 S2）：跨域消费走客户端服务面（ctx.singleBoard）
// ——域件未装载/已摘除 → undefined → 独立会话视角消失（可摘除性，D19）
const singlesBoard = clientCtx?.singleBoard;
const activeSingleId = computed(() => singlesBoard?.activeSingleId.value ?? '');

const ui = useUiStore();
const agentStore = useAgentStore();

// ── 工作区树席位占用（M28 P1）：树体 = ui-workspace 行的 main:workspace
// 贡献；无贡献（行卸载）→ 分屏容器/把手整体隐藏（壳不残废）。响应式 =
// 席位版本计数 + slots/changed 事件桥（SlotOutlet 同款轴）。 ──
const wsSlotVersion = ref(clientCtx?.slots.version('main:workspace') ?? 0);
const offWsSlot = clientCtx?.on('slots/changed', (key: string) => {
  if (key === 'main:workspace') wsSlotVersion.value++;
});
onBeforeUnmount(() => offWsSlot?.());
const hasWorkspaceTree = computed(() => {
  void wsSlotVersion.value; // 依赖锚（key 级细粒度失效轴——D14）
  return (clientCtx?.slots.entries('main:workspace').length ?? 0) > 0;
});

// ── 运行矩阵席位占用（M28 P1）：矩阵 = ui-runview 行的 main:tracking
// 贡献；无贡献（行卸载）→ 矩阵视图消失且 chat 区直显（同轴门控，
// 壳不残废——不会停在「矩阵开关开着却两头全空」的空白态）。 ──
const tkSlotVersion = ref(clientCtx?.slots.version('main:tracking') ?? 0);
const offTkSlot = clientCtx?.on('slots/changed', (key: string) => {
  if (key === 'main:tracking') tkSlotVersion.value++;
});
onBeforeUnmount(() => offTkSlot?.());
const hasTrackingMatrix = computed(() => {
  void tkSlotVersion.value;
  return (clientCtx?.slots.entries('main:tracking').length ?? 0) > 0;
});
/** 矩阵视图有效显示（开关 + 席位占用 + pair 让位） */
const trackingVisible = computed(() => ui.trackingViewVisible && hasTrackingMatrix.value && !ui.pairView);

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

// ── 视角（M28 P0-2 退役内置注册批次）：四视角出厂贡献随 owning 行
//    走——talk = conversation 行（slots.inject 声明存活期效应落位）；
//    group/single/pair = ui-group/ui-singles/ui-runview 行 client
//    （domain 批次，席位已声明）。本件只剩 PerspectiveHost 容器与
//    选中让位 watch。 ──

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('toggleSidebar', () => ui.toggleSidebar());
provide('closeSidebar', () => ui.closeSidebar());
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="sidebar-overlay">
      <div v-if="ui.sidebarVisible" class="sidebar-overlay" @click="ui.closeSidebar" />
    </Transition>

    <!-- 第一层：侧边栏（seat: sidebar；出厂贡献 = sidebar 基础件 SidebarHost） -->
    <SlotOutlet name="sidebar" />

    <!-- 第二层：列表槽位（seat: list-panel；出厂贡献 = sidebar 基础件三面板壳
         ——agents/sessions/tracking 三选一，只换侧边栏，不动主区） -->
    <div v-if="ui.listVisible" class="list-panel-wrapper" :class="{ 'sidebar-mobile-visible': ui.sidebarVisible }" :style="{ width: ui.listWidth + 'px' }">
      <SlotOutlet name="list-panel" />
      <ResizeHandle kind="list" />
    </div>

    <!-- 第三层：主区（seat: main）—— 聊天（视角容器驱动）或「运行矩阵」大画布视图；
          主区由侧边栏选择驱动：选中 Agent/群/会话 → 矩阵让位回聊天（上方 watch）。
          矩阵格子进入 pair 只读视角时：矩阵隐藏、聊天区渲染 pair 视角（注册在最前），
          返回（closePairView）→ 矩阵回归，不落在无选中的空白聊天区。
          聊天区用 v-show 保活（流式状态/草稿不因查看矩阵而丢失） -->
    <div class="main-area">
      <!-- 运行矩阵大画布（seat: main:tracking——ui-runview 行贡献；让位协议壳留本件） -->
      <SlotOutlet v-if="trackingVisible" name="main:tracking" />
      <div v-show="!trackingVisible" class="chat-area">
        <SlotOutlet name="main">
          <SlotOutletItem>
            <PerspectiveHost @group-deleted="onGroupDeleted" />
          </SlotOutletItem>
        </SlotOutlet>
        <template v-if="ui.workspaceVisible && hasWorkspaceTree">
          <ResizeHandle kind="workspace" />
          <!-- 工作区树（seat: main:workspace——ui-workspace 行贡献；壳/把手留本件） -->
          <SlotOutlet name="main:workspace" />
        </template>
        <!-- 右侧悬浮工作区把手：不占布局，点击展开；展开后隐藏（面板自带关闭按钮） -->
        <button
          v-show="!ui.workspaceVisible && hasWorkspaceTree"
          class="workspace-rail"
          @click="ui.toggleWorkspace"
          title="工作区"
        >
          <Icon name="panel-right" :size="18" />
        </button>
      </div>
    </div>

    <!-- 全局覆盖层（seat: overlay）—— 全局弹窗与各域覆盖层
         （文件预览/建群 = 域行贡献〔M28 P1〕；设置/用量/版本 = 内联） -->
    <SlotOutlet name="overlay">
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
