<script setup lang="ts">
// ============================================================
// clients/base/AppFrame.vue —— layout 基础件视图（原 App.vue 原样迁入，M27 S1）
//
// 「壳也是插件」（D19）：本组件占 root 席位。页面骨架（2026-11 语义
// 定整——VSCode 布局同款词汇）：
//   [menu-bar 顶部菜单栏·预留]
//   [activity-bar 活动栏][primary-sidebar 主侧边栏][main 主面板]
//   [aux-sidebar 辅助侧边栏]
//   [bottom-panel 底部面板·预留][status-bar 底部状态栏·预留]
//   + overlay 全局覆盖层（非布局区域）。三预留席已 declare 占名，实现
//   时壳重构顶部/底部布局后开口。已开口区域挂载点：
//   · activity-bar    —— ActivityBarHost（壳件出厂贡献）
//   · primary-sidebar —— 三面板壳（壳件出厂贡献）
//   · main            —— 主区视图选举（MainViewHost——keyed 选举多选一：
//                        chat=视角容器兜底 / tracking=运行矩阵 / …；让位
//                        协议随各条目 active() 住 owning 行，壳零域知识）
//   · aux-sidebar     —— 选区选举（AuxSidebarHost——工作区是众多选区之一，
//                        NULL 扩展位与各选区同级；AuxActivityBar 辅助活动
//                        栏按钮资产随条目 def 住 owning 行，壳零域知识）
//   · overlay         —— 全局弹窗（域行/基础件贡献）
// 外部贡献（未出现）经同轴 order 与宿主内置项合并（D16-①）。
// ============================================================
import { ref, provide } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import ResizeHandle from './ResizeHandle.vue';
import MainViewHost from './MainViewHost.vue';
import AuxSidebarHost from './AuxSidebarHost.vue';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import { ToastHost } from '@agentchat/webui-kit';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';

const clientCtx = useClientContext();

// 初始化主题
useThemeStore();

const ui = useUiStore();

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('toggleDrawer', () => ui.toggleDrawer());
provide('closeDrawer', () => ui.closeDrawer());
</script>

<template>
  <div class="app-layout">
    <!-- 移动端遮罩 -->
    <Transition name="drawer-overlay">
      <div v-if="ui.drawerVisible" class="drawer-overlay" @click="ui.closeDrawer" />
    </Transition>

    <!-- ① 活动栏（seat: activity-bar——VSCode Activity Bar 同款；出厂贡献
         = 壳件出厂贡献 ActivityBarHost；2026-11 语义定整：原 sidebar 改名） -->
    <SlotOutlet name="activity-bar" />

    <!-- ② 主侧边栏（seat: primary-sidebar——VSCode Primary Side Bar 同款；
         出厂贡献 = 壳件三面板壳——agents/sessions/tracking 三选一，
         只换主侧边栏，不动主面板；2026-11 语义定整：原 list-panel 改名） -->
    <div v-if="ui.primaryVisible" class="primary-sidebar-wrapper" :class="{ 'drawer-visible': ui.drawerVisible }" :style="{ width: ui.primaryWidth + 'px' }">
      <SlotOutlet name="primary-sidebar" />
      <ResizeHandle kind="primary" />
    </div>

    <!-- ③ 主面板（seat: main——keyed 选举「主区视图」多选一，2026-11
           主区语义纯化）：会话（视角容器）/运行矩阵/未来其他主区视图同轴
           竞争——MainViewHost 按 active × order 选举（tracking(50) 居
           chat(100) 前——激活期间覆盖）；让位协议随各条目 active() 住
           owning 行（选中让位 watch 亦随 ui-runview 行），壳零域知识。
           keepAlive 生命周期策略见 MainViewHost：chat = 文档流保活
           （草稿/滚动/流式态不因主区视图切换丢失），volatile 条目随选
           举挂卸（离开即卸载，后台零轮询） -->
    <div class="main-area">
      <MainViewHost />
    </div>

    <!-- ④ 辅助侧边栏（seat: aux-sidebar——VSCode Auxiliary Side Bar 同款，
            keyed 选举「选区」多选一：席位 = 区域本身，工作区 = 众多选区
            之一，NULL 扩展位与各选区同级）：选区面板 + 辅助活动栏
           （AuxActivityBar——右侧的活动栏同构布局列，DOM 末位 = 最右列）
            全在 AuxSidebarHost + 域行条目 def——壳零域知识；选区缺席
           （行卸载）→ 区域整体消失 -->
    <AuxSidebarHost />

    <!-- 全局覆盖层（seat: overlay）—— 全部弹窗 = 域行/基础件贡献
         （文件预览 90 / 建群 95 / 用量 96 / 版本 97 / 设置 100——M28 P1
          起 AppFrame 零内联 overlay 项） -->
    <SlotOutlet name="overlay" />

    <!-- 全局 Toast 栈（global:toast 原语半件——各面板瞬时反馈统一出口；
         Teleport body + z9500，见 webui-kit/toast.ts） -->
    <ToastHost />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex; height: 100vh; width: 100vw; overflow: hidden; position: relative;
}

.main-area {
  flex: 1; display: flex; min-width: 0; height: 100vh; overflow: hidden;
}

.primary-sidebar-wrapper {
  display: flex; flex-shrink: 0; overflow: hidden;
}

.drawer-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 110;
}
.drawer-overlay-enter-active, .drawer-overlay-leave-active { transition: opacity 0.2s; }
.drawer-overlay-enter-from, .drawer-overlay-leave-to { opacity: 0; }

@media (max-width: 768px) {
  .primary-sidebar-wrapper {
    position: fixed; left: 0; top: 0; bottom: 0;
    z-index: 120; /* 盖住 ChatView header(z-100) 与 overlay(z-110)：移动端抽屉置顶 */
  }
  /* 收起时：无阴影 + 点击穿透（避免透明占位拦截活动栏图标列） */
  .primary-sidebar-wrapper:not(.drawer-visible) {
    pointer-events: none;
  }
  /* 阴影仅在侧边栏展开时显示，收起时避免边缘残留 */
  .primary-sidebar-wrapper.drawer-visible {
    box-shadow: 2px 0 12px rgba(0,0,0,0.15);
    pointer-events: auto;
  }
}
</style>
