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

// 全局连接条（cr-274）：wire 断开时顶部提示（此前只有会话页内局部条——布局
// 外壳未加载/切到其他主区视图时断线无提示，移动端回前台慢重连期尤其明显）。
// 初值取现态（注册顺序竞态防线——与 ConversationView 同款裁决），桩缺省按已
// 连接处理（离线桩不误显断连条）。
const rpc = clientCtx?.rpc;
const wireConnected = ref(rpc?.connected?.() ?? true);
rpc?.onOpen?.(() => { wireConnected.value = true; });
rpc?.onClose?.(() => { wireConnected.value = false; });
// 链路级断线（cr-274 真机实锤）：桥与链路解耦（cr-49）后链路死而桥活——wire
// WS（连本地回环桥）无感断线，connected 恒 true。安卓壳把 RemoteSession 状态
// 以 remote/link-state 事件帧广播（online | reconnecting），此处消费：非 online
// 即打横幅（与 wire 断线同一条，语义都是「与核心端的链路断了」）。缺帧 = 桌面
// 端（无壳广播）或旧壳，不误显。
const offLinkState = rpc?.onEvent((type, args) => {
  if (type !== 'remote/link-state') return;
  wireConnected.value = args[0] === 'online';
}) ?? (() => undefined);
onBeforeUnmount(() => { offLinkState(); });

// 初始化主题
useThemeStore();

const ui = useUiStore();

/** 消息左右对齐基准（用户消息靠右） */
provide('settingsAgentId', ref(VIEWER_ID.value));
/** Agent 设置入口（聊天页/侧边栏调用，打开设置面板并定位到该 Agent） */
provide('openAgentSettings', (agentId: string) => ui.openAgentSettings(agentId));
provide('pushMainIfNarrow', () => ui.pushMainIfNarrow());
provide('closeMobileMain', () => ui.closeMobileMain());

// ── 窄屏 root/push 导航（cr-29）：narrow 单源 + Android 返回键消费链 ──
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

    <!-- 全局连接条（cr-274）：wire 断开 = 顶部横幅（重连由 wire 自身退避处理，
         此处纯提示）。绝对定位不占布局流，窄屏同样可见。 -->
    <div v-if="!wireConnected" class="conn-banner" role="status">
      连接已断开，正在重连…
    </div>

    <!-- ① 活动栏（seat: activity-bar——VSCode Activity Bar 同款；出厂贡献
         = 壳件出厂贡献 ActivityBarHost；2026-09-11 语义定整：原 sidebar 改名）。
         窄屏不渲染（cr-29：底部 tab 栏接管导航） -->
    <SlotOutlet v-if="!narrow" name="activity-bar" />

    <!-- ② 主侧边栏（seat: primary-sidebar——VSCode Primary Side Bar 同款；
         出厂贡献 = 壳件三面板壳——agents/sessions/tracking 三选一，
         只换主侧边栏，不动主面板；2026-09-11 语义定整：原 list-panel 改名） -->
    <!-- 窄屏 root 层（cr-29）：列表页整页 + 底部 tab 栏——抽屉/把手退役 -->
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
    <!-- 窄屏 push 层（cr-29）：会话页整页覆盖（transform 滑入——keepAlive 的
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
    <!-- ④ 辅助侧边栏（窄屏 cr-30：区域宿主内部换全屏 Sheet 排布——选区注册面零改动） -->
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

/* 全局连接条（cr-274）：warn 语义墨 + 浮面底，安全区顶部避让（移动端刘海） */
.conn-banner {
  position: absolute; top: 0; left: 0; right: 0; z-index: 900;
  padding: calc(var(--safe-top, 0px) + 6px) 12px 6px;
  text-align: center; font-size: var(--fs-xs); color: var(--warn);
  background: var(--bg-raised);
}

.main-area {
  flex: 1; display: flex; min-width: 0; height: 100vh; overflow: hidden;
}

.primary-sidebar-wrapper {
  display: flex; flex-shrink: 0; overflow: hidden;
}

/* ── 窄屏 root/push 双层（cr-29；抽屉态已全链退役）── */
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
  padding-top: var(--safe-top, 0px); /* 状态栏避让（cr-34：会话头被遮的次因） */
}
.mobile-main.open { transform: translateX(0); }
</style>
