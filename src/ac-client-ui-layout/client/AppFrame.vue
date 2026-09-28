<script setup lang="ts">
// ============================================================
// clients/base/AppFrame.vue —— layout 基础件视图（原 App.vue 原样迁入，M27 S1）
//
// 「壳也是插件」（D19）：本组件占 root 席位。页面骨架（2026-09-11 语义
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
import { ref, computed, onMounted, onBeforeUnmount, provide } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import ResizeHandle from './ResizeHandle.vue';
import MainViewHost from './MainViewHost.vue';
import AuxSidebarHost from './AuxSidebarHost.vue';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import { ToastHost } from '@agentchat/webui-kit';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import MobileTabBar from './MobileTabBar.vue';
import { registerBackHandler } from './historyFlag.ts';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';

const clientCtx = useClientContext();

// 初始化主题
useThemeStore();

const ui = useUiStore();

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('pushMainIfNarrow', () => ui.pushMainIfNarrow());
provide('closeMobileMain', () => ui.closeMobileMain());

// ── 窄屏 root/push 导航（cr-35）：narrow 单源 + Android 返回键消费链 ──
const narrow = computed(() => ui.narrow);

/** 返回键消费判定（逐层：sheet 在前——MobileTabBar moreOpen 是组件本地态，
 *  经 provide/inject 通道上提消费；push 页次之；root 页未消费 = 退后台） */
const backConsumers = new Set<() => boolean>();
provide('registerBackConsumer', (fn: () => boolean) => {
  backConsumers.add(fn);
  return () => { backConsumers.delete(fn); };
});

const offBack = registerBackHandler(() => {
  // 0) 设置面板（z1000 全屏表单流——比 sheet 更顶层的 overlay）
  if (ui.globalSettingsVisible) { ui.closeSettings(); return { handled: true, via: 'settings' }; }
  // 1) 最顶层覆盖（more sheet / aux 全屏 sheet）：注册消费者逐层询问
  //    （后注册者在上层——倒序遍历；任一消费即止）
  for (const fn of [...backConsumers].reverse()) {
    if (fn()) return { handled: true, via: 'overlay' };
  }
  // 2) push 会话页：关之
  if (ui.mobileMainOpen) { ui.closeMobileMain(); return { handled: true, via: 'mobile-main' }; }
  // 3) root 层：未消费（壳执行默认 = moveTaskToBack 退后台）
  return { handled: false, via: 'root' };
});
onBeforeUnmount(() => offBack());
</script>

<template>
  <div class="app-layout">

    <!-- ① 活动栏（seat: activity-bar——VSCode Activity Bar 同款；出厂贡献
         = 壳件出厂贡献 ActivityBarHost；2026-09-11 语义定整：原 sidebar 改名）。
         窄屏不渲染（cr-35：底部 tab 栏接管导航） -->
    <SlotOutlet v-if="!narrow" name="activity-bar" />

    <!-- ② 主侧边栏（seat: primary-sidebar——VSCode Primary Side Bar 同款；
         出厂贡献 = 壳件三面板壳——agents/sessions/tracking 三选一，
         只换主侧边栏，不动主面板；2026-09-11 语义定整：原 list-panel 改名） -->
    <!-- 窄屏 root 层（cr-35）：列表页整页 + 底部 tab 栏——抽屉/把手退役 -->
    <div v-if="narrow" class="mobile-root">
      <div class="mobile-root-body">
        <SlotOutlet name="primary-sidebar" />
      </div>
      <MobileTabBar />
    </div>

    <div v-else-if="ui.primaryVisible" class="primary-sidebar-wrapper" :style="{ width: ui.primaryWidth + 'px' }">
      <SlotOutlet name="primary-sidebar" />
      <ResizeHandle kind="primary" />
    </div>

    <!-- ③ 主面板（seat: main——keyed 选举「主区视图」多选一，2026-09-11
           主区语义纯化）：会话（视角容器）/运行矩阵/未来其他主区视图同轴
           竞争——MainViewHost 按 active × order 选举（tracking(50) 居
           chat(100) 前——激活期间覆盖）；让位协议随各条目 active() 住
           owning 行（选中让位 watch 亦随 ui-runview 行），壳零域知识。
           keepAlive 生命周期策略见 MainViewHost：chat = 文档流保活
           （草稿/滚动/流式态不因主区视图切换丢失），volatile 条目随选
           举挂卸（离开即卸载，后台零轮询） -->
    <!-- 窄屏 push 层（cr-35）：会话页整页覆盖（transform 滑入——keepAlive 的
         chat DOM 隐藏期间流式帧继续上屏，回来即最新帧） -->
    <div v-if="narrow" class="mobile-main" :class="{ open: ui.mobileMainOpen }">
      <MainViewHost />
    </div>

    <div v-else class="main-area">
      <MainViewHost />
    </div>

    <!-- ④ 辅助侧边栏（seat: aux-sidebar——VSCode Auxiliary Side Bar 同款，
            keyed 选举「选区」多选一：席位 = 区域本身，工作区 = 众多选区
            之一，NULL 扩展位与各选区同级）：选区面板 + 辅助活动栏
           （AuxActivityBar——右侧的活动栏同构布局列，DOM 末位 = 最右列）
            全在 AuxSidebarHost + 域行条目 def——壳零域知识；选区缺席
           （行卸载）→ 区域整体消失 -->
    <!-- ④ 辅助侧边栏（窄屏 cr-36：区域宿主内部换全屏 Sheet 排布——选区注册面零改动） -->
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

/* ── 窄屏 root/push 双层（cr-35；抽屉态已全链退役）── */
.mobile-root {
  position: absolute; inset: 0; z-index: 20;
  display: flex; flex-direction: column;
  background: var(--bg-base);
  padding-top: var(--safe-top, 0px);
}
.mobile-root-body { flex: 1; min-height: 0; display: flex; }
.mobile-main {
  position: absolute; inset: 0; z-index: 30;
  transform: translateX(100%);
  transition: transform 0.2s var(--ease-out, ease-out);
  background: var(--bg-base);
  display: flex;
  padding-top: var(--safe-top, 0px); /* 状态栏避让（cr-40：会话头被遮的次因） */
}
.mobile-main.open { transform: translateX(0); }
</style>
