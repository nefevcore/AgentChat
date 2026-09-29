<!-- ============================================================ -->
<!-- client/MobileTabBar.vue —— 移动端底部标签栏（cr-29 Phase①）

root 页专属（会话页 push 态不渲染——键盘弹出不与 tab 栏打架）。四 tab：
  会话（sessions）/ Agent（agents）/ 运行（tracking）/ 更多（sheet）。
未读徽章单源 useUnreadBadges（与 ActivityBar 同源）；面板切换复用
ui.openPrimaryPanel（tab 语义 = 整页切换 primaryPanel，窄屏停在 root 层）。
「更多」= MobileMoreSheet（头像配置/主题/全局设置/备份/版本/插件动作）。
桌面不渲染（AppFrame v-if narrow 分支控制）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon, Avatar } from '@agentchat/webui-kit';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { useUiStore } from './uiStore.ts';
import { useUnreadBadges } from 'ac-client-ui-conversation/client/useUnreadBadges.ts';
import MobileMoreSheet from './MobileMoreSheet.vue';

const ui = useUiStore();
const clientCtx = useClientContext();
const roster = clientCtx?.roster;

const { agentsUnreadTotal, singlesUnreadTotal, agentsUnreadLabel, singlesUnreadLabel } = useUnreadBadges();

const moreOpen = ref(false);

const tabs = computed(() => [
  { id: 'sessions', icon: 'message-circle', label: '会话', badge: singlesUnreadTotal.value, badgeLabel: singlesUnreadLabel.value },
  { id: 'agents', icon: 'users', label: 'Agent', badge: agentsUnreadTotal.value, badgeLabel: agentsUnreadLabel.value },
  { id: 'tracking', icon: 'activity', label: '运行', badge: 0, badgeLabel: '' },
]);

function onTab(id: string) {
  if (id === 'more') { moreOpen.value = !moreOpen.value; return; }
  ui.openPrimaryPanel(id as 'sessions' | 'agents' | 'tracking');
}
</script>

<template>
  <nav class="mobile-tab-bar" aria-label="主导航">
    <button
      v-for="t in tabs"
      :key="t.id"
      class="mtab"
      :class="{ active: ui.primaryPanel === t.id }"
      :aria-current="ui.primaryPanel === t.id ? 'page' : undefined"
      @click="onTab(t.id)"
    >
      <span class="mtab-icon"><Icon :name="t.icon" :size="22" /><span v-if="t.badge > 0" class="mtab-badge">{{ t.badgeLabel }}</span></span>
      <span class="mtab-label">{{ t.label }}</span>
    </button>

    <button class="mtab" :class="{ active: moreOpen }" @click="onTab('more')" aria-label="更多">
      <span class="mtab-icon"><Icon name="more-horizontal" :size="22" /></span>
      <span class="mtab-label">更多</span>
    </button>
  </nav>

  <MobileMoreSheet :visible="moreOpen" @close="moreOpen = false" />
</template>

<style scoped>
.mobile-tab-bar {
  display: flex; align-items: stretch;
  border-top: 1px solid var(--line);
  background: var(--bg-base);
  padding: 2px 4px calc(2px + var(--safe-bottom, 0px));
  flex-shrink: 0;
}
.mtab {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; padding: 4px 0 2px; border: none; background: none; cursor: pointer;
  color: var(--text-3); font-size: 10px;
}
.mtab.active { color: var(--primary); }
.mtab-icon { position: relative; display: grid; place-items: center; height: 24px; }
.mtab-label { line-height: 1.2; }
.mtab-badge {
  position: absolute; top: -2px; right: -12px;
  min-width: 15px; height: 15px; padding: 0 4px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; background: #ef4444; color: #fff;
  font-size: 9.5px; font-weight: 600; line-height: 1;
}
</style>