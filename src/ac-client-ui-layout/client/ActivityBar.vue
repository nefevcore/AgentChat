<script setup lang="ts">
// ActivityBar.vue —— 活动栏（2026-09-11 命名对齐区域席 activity-bar；原 Sidebar 随 sidebar 行归并壳件）
// 跨件消费走客户端服务面（原 pinia 门面改直连）：roster（ctx.roster——
// ui-agents 行提供）+ theme（ctx.theme——本族基础件）；viewer 端点 id
// 单源住 ac-client-runtime（M29 P1-1 收敛）。
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { Avatar, Icon, toastBusy, toastOk, toastError } from '@agentchat/webui-kit';
import { useActivityBarActions, type ActivityBarActionDef } from './activityBarActions.ts';
import { useUnreadBadges } from 'ac-client-ui-conversation/client/useUnreadBadges.ts';
import { backupNow, fetchVersion } from 'ac-client-ui-system/client/systemApi.ts';

const emit = defineEmits<{
  (e: 'openPrimaryPanel', panel: 'agents' | 'sessions' | 'tracking'): void;
  (e: 'openGlobalSettings'): void;
  (e: 'openAgentSettings'): void;
  (e: 'showVersion'): void;
}>();

defineProps<{
  primaryVisible: boolean;
  /** 列表槽位当前页面（活动栏高亮用） */
  primaryPanel: 'agents' | 'sessions' | 'tracking';
}>();

const clientCtx = useClientContext();
const roster = clientCtx?.roster;
const themeSvc = clientCtx?.theme;

const currentAvatar = computed(() => roster?.getAgentAvatar(VIEWER_ID.value) ?? null);
const currentAgentName = computed(() => roster?.getAgentName(VIEWER_ID.value) || 'User');

// ── 未读聚合徽章（Agent 列表 / 会话列表按钮）──
// 口径与实现迁 layout 共享模块 useUnreadBadges（cr-29：MobileTabBar 同源消费，
// 不复制实现）；口径注释见该模块头注。
const { agentsUnreadTotal, singlesUnreadTotal, agentsUnreadLabel, singlesUnreadLabel } = useUnreadBadges();

// activity-bar:plugin-actions 贡献面（ctx 参数化解析——order 升序稳定）
const sortedActivityBarActions = useActivityBarActions(clientCtx);

// activity-bar:more-menu 贡献面（cr-301：更多菜单数据席位——两项硬编码之后按 order 升序追加）
const moreMenuItems = computed(() => {
  if (!clientCtx) return [];
  void clientCtx.slots.version('activity-bar:more-menu');
  return clientCtx.slots.entries('activity-bar:more-menu')
    .map((e) => ({ order: e.order ?? 100, ...(e.meta?.def as { id: string; label: string; icon?: string; onClick: () => void }) }))
    .filter((d) => typeof d.id === 'string' && typeof d.onClick === 'function')
    .sort((a, b) => a.order - b.order);
});

// ── 更多菜单 ──
const moreOpen = ref(false);
const moreTriggerRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const hasUpdate = ref(false);
const backupBusy = ref(false);

/** 备份反馈走全局 toast（原菜单内 FeedbackNotice 随「点菜单即关」消失——
 *  结果不可见的真 bug；同 key 'backup' 刷新：busy → ok/error 原位更新） */
async function runBackup() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  toastBusy('正在备份…', { key: 'backup' });
  try {
    const d = await backupNow(clientCtx!.rpc);
    if (d.status === 'ok') {
      toastOk(`备份完成：${d.file}（${((d.size ?? 0) / 1024 / 1024).toFixed(1)}MB，保留 ${d.keep} 份）`, { key: 'backup' });
    } else {
      toastError(`备份失败：${d.error || '未知错误'}`, { key: 'backup' });
    }
  } catch (err: any) {
    toastError(`备份失败：${err?.message || '网络错误'}`, { key: 'backup' });
  } finally {
    backupBusy.value = false;
  }
}

let closeTimeout: ReturnType<typeof setTimeout> | null = null;

function updateMenuPosition() {
  if (!moreTriggerRef.value) return;
  const rect = moreTriggerRef.value.getBoundingClientRect();
  menuStyle.value = {
    position: 'fixed',
    left: `${rect.right + 4}px`,
    bottom: `${window.innerHeight - rect.bottom}px`,
  };
}

function openMore() {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
  moreOpen.value = !moreOpen.value;
  if (moreOpen.value) nextTick(() => updateMenuPosition());
}

function onMoreMouseLeave() {
  closeTimeout = setTimeout(() => { moreOpen.value = false; }, 300);
}

function onMoreMouseEnter() {
  if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
}

function onItemClick(action: () => void) {
  moreOpen.value = false;
  action();
}

function runActivityBarAction(action: ActivityBarActionDef) {
  try {
    action.onClick();
  } catch (err) {
    console.error(`[ui-ext] 活动栏动作 "${action.id}" 出错:`, err);
  }
}

onMounted(async () => {
  try {
    const simulate = localStorage.getItem('agentchat.simulateUpdate') === '1';
    const data = await fetchVersion(simulate, clientCtx!.rpc);
    hasUpdate.value = data.hasUpdate || false;
  } catch { /* ignore */ }
});

onUnmounted(() => {
  if (closeTimeout) clearTimeout(closeTimeout);
});
</script>

<template>
  <div class="activity-bar">
    <button class="activity-bar-avatar-btn" :aria-label="`${currentAgentName} 配置`" :title="`${currentAgentName} 配置`" @click="emit('openAgentSettings')">
      <Avatar :src="currentAvatar" :name="currentAgentName" :size="30" />
    </button>

    <!-- Agent 列表（活动栏第一位：Agent + 群组名册）；徽章 = 名册行口径未读聚合
         （direct 私信 + 群聊；single 会话时名册不可见，Agent 私信仍经此按钮提示） -->
    <button class="activity-bar-btn" :class="{ active: primaryVisible && primaryPanel === 'agents' }" aria-label="Agent 列表" title="Agent 列表" @click="emit('openPrimaryPanel', 'agents')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <span v-if="agentsUnreadTotal > 0" class="ui-avatar-badge unread-badge">{{ agentsUnreadLabel }}</span>
    </button>

    <!-- 会话列表（独立会话页，与 Agent 列表同级）；徽章 = single 分区未读聚合
         （single 无名册行，SessionList 是其归属面板——本按钮为唯一未读提示位） -->
    <button class="activity-bar-btn" :class="{ active: primaryVisible && primaryPanel === 'sessions' }" aria-label="会话列表" title="会话列表" @click="emit('openPrimaryPanel', 'sessions')">
      <Icon name="message-circle" :size="22" />
      <span v-if="singlesUnreadTotal > 0" class="ui-avatar-badge unread-badge">{{ singlesUnreadLabel }}</span>
    </button>

    <!-- 运行跟踪入口已迁辅助活动栏（aux 'tracking' 选区 rail 按钮，A5）——
         左右两栏各一是冗余，本栏不再保留；主侧边栏回归纯导航（agents/sessions） -->

    <div class="activity-bar-spacer" />

    <!-- Token 用量入口已迁辅助活动栏（aux 'usage' 选区 rail 按钮，P2）——
         本栏不再重复入口 -->

    <button class="activity-bar-btn" :aria-label="themeSvc?.theme.value === 'dark' ? '切换亮色主题' : '切换暗色主题'" :title="themeSvc?.theme.value === 'dark' ? '切换亮色主题' : '切换暗色主题'" @click="themeSvc?.toggleTheme()">
      <svg v-if="themeSvc?.theme.value === 'light'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
      <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    </button>

    <!-- 活动栏插件动作（activity-bar:plugin-actions 数据席）：宿主决定位置（底部），插件只填空 -->
    <button
      v-for="action in sortedActivityBarActions" :key="action.id"
      class="activity-bar-btn" :aria-label="action.label" :title="action.label" @click="runActivityBarAction(action)"
    >
      <Icon :name="action.icon" :size="22" />
    </button>

    <button class="activity-bar-btn" aria-label="全局设置" title="全局设置" @click="emit('openGlobalSettings')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>

    <div class="more-wrapper">
      <button ref="moreTriggerRef" class="activity-bar-btn more-trigger" :class="{ active: moreOpen }" aria-label="更多" @click="openMore">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
        <span v-if="hasUpdate" class="more-dot" />
      </button>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="more-fade">
      <div v-if="moreOpen" class="agentchat-more-menu" :style="menuStyle" @mouseenter="onMoreMouseEnter" @mouseleave="onMoreMouseLeave">
        <button class="agentchat-more-item" @click="onItemClick(runBackup)" :disabled="backupBusy">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span>{{ backupBusy ? '备份中…' : '数据备份' }}</span>
        </button>
        <button class="agentchat-more-item" @click="onItemClick(() => emit('showVersion'))">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>检查更新</span>
          <span v-if="hasUpdate" class="agentchat-more-item-dot" />
        </button>
        <!-- more-menu 席位贡献（cr-301：行卸载即消失，不残留） -->
        <button v-for="item in moreMenuItems" :key="item.id" class="agentchat-more-item" @click="onItemClick(item.onClick)">
          <Icon v-if="item.icon" :name="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.activity-bar {
  width: 48px;
  background: var(--bg-nav); /* cr-139：容器底归位——bg-hover 是悬停反馈色不是容器底 */
  display: flex; flex-direction: column; align-items: center;
  flex-shrink: 0; padding: 8px 0; gap: 4px;
  border-right: 1px solid var(--line);
  position: relative; z-index: 10;
}

.activity-bar-avatar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: none; border-radius: var(--r-sm);
  background: transparent; /* 无底色：圆形头像外不再露出色块 */
  cursor: pointer; transition: transform 0.15s, box-shadow 0.15s;
  margin-bottom: 8px; padding: 0; overflow: hidden; flex-shrink: 0; position: relative;
}
.activity-bar-avatar-btn:hover { transform: scale(1.1); box-shadow: 0 0 0 2px var(--primary); }

.activity-bar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border: none; border-radius: var(--r-sm); background: none;
  color: var(--text-3); cursor: pointer;
  transition: color 0.15s, background 0.15s; position: relative;
}
.activity-bar-btn:hover { color: var(--text-1); background: var(--primary-light); } /* cr-139：bg-nav 上 bg-hover 对比仅 1.1，悬停改主色染 */
.activity-bar-btn.active { color: var(--text-1); }
.activity-bar-btn.active::before {
  content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px; background: var(--primary); border-radius: 0 2px 2px 0;
}

/* 未读聚合徽章配方 = kit badge.css .ui-avatar-badge（cr-157 归一——#ef4444 字面值退役，
   「跨包单源待裁决 A」就此收口）；.unread-badge 锚点类保留（webui 测试锁），
   本地只补定位：右上限位在按钮内（cr-196 描边退役） */
.unread-badge { top: 3px; right: 3px; z-index: 1; }

.activity-bar-spacer { flex: 1; }
.more-wrapper { position: relative; z-index: 10; }

/* 更新可用提示点（非语义 attention 色，同上计数徽章例外族） */
.more-dot {
  position: absolute; top: 6px; right: 6px; width: 8px; height: 8px;
  background: #ef4444; border-radius: 50%; border: 1.5px solid var(--bg-nav); z-index: 1;
}

.more-fade-enter-active, .more-fade-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.more-fade-enter-from, .more-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

<style>
.agentchat-more-menu {
  min-width: 180px;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--r-md); box-shadow: var(--shadow-pop);
  padding: 4px; overflow: hidden; z-index: 9999;
}

.agentchat-more-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px; border: none; border-radius: var(--r-sm); background: none;
  color: var(--text-1); font-size: 13px;
  cursor: pointer; text-align: left; transition: background 0.1s; position: relative;
}
.agentchat-more-item:hover { background: var(--role-hover-bg); }
.agentchat-more-item svg { flex-shrink: 0; color: var(--text-3); }

/* 菜单内同款提示点 */
.agentchat-more-item-dot {
  margin-left: auto; width: 7px; height: 7px;
  background: #ef4444; border-radius: 50%; flex-shrink: 0;
}
.agentchat-more-item:disabled { opacity: 0.6; cursor: wait; }
</style>
