<!-- ============================================================ -->
<!-- client/MobileMoreSheet.vue —— 移动端「更多」面板（cr-35 建，cr-36 迁 Sheet）

TabBar「更多」的承载，三段：
  ① 头像行（点按 = openAgentSettings(viewer)，同 ActivityBar 头像钮）；
  ② 常用项（主题切换/全局设置/数据备份/检查更新）；
  ③ 面板区（cr-36）：aux 选区全量入口（auxSidebarRailDefs——各域行
     声明的 rail 资产 + available 谓词；含 badge）。窄屏辅助活动栏不渲染
     （Phase①），此区是九个选区在手机端的唯一入口；点按 → openAuxPanel
     （域侧激活 + 显式置位 + 展开）→ AuxSidebarHost 窄屏全屏 Sheet 呈现。
  ④ 插件动作（activity-bar:plugin-actions 数据席同款消费）。
形态 = webui-kit Sheet 原语（Teleport + 底部滑入 ≤200ms）。
-->
<script setup lang="ts">
import { ref, computed, inject, watch, onMounted, onBeforeUnmount } from 'vue';
import { Avatar, Icon, Sheet, toastBusy, toastOk, toastError } from '@agentchat/webui-kit';
import { useClientContext, VIEWER_ID } from 'ac-client-runtime';
import { useUiStore } from './uiStore.ts';
import { useActivityBarActions, type ActivityBarActionDef } from './activityBarActions.ts';
import { auxSidebarRailDefs, type AuxSidebarPanelDef } from './auxSidebarViews.ts';
import { backupNow, fetchVersion } from 'ac-client-ui-system/client/systemApi.ts';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const ui = useUiStore();
const clientCtx = useClientContext();
const roster = clientCtx?.roster;
const themeSvc = clientCtx?.theme;

const currentAvatar = computed(() => roster?.getAgentAvatar(VIEWER_ID.value) ?? null);
const currentAgentName = computed(() => roster?.getAgentName(VIEWER_ID.value) || 'User');
const sortedActivityBarActions = useActivityBarActions(clientCtx);

// ── 面板区（aux 选区入口——域行声明驱动，壳零域知识）──
// 清单与徽章在「每次打开时」重算：available()/badge() 读的是各域 store 态，
// computed 追踪不到（安全求值契约本就是命令式读取）——打开时快照即正确观感。
const panelList = ref<Array<{ def: AuxSidebarPanelDef; badge: string }>>([]);
function badgeOf(def: AuxSidebarPanelDef): string {
  try {
    const v = def.rail?.badge?.() ?? null;
    if (v === null || v === 0 || v === '') return '';
    return typeof v === 'number' && v > 99 ? '99+' : String(v);
  } catch { return ''; }
}
function openPanel(def: AuxSidebarPanelDef) {
  emit('close');
  ui.openAuxPanel(def);
}
watch(() => props.visible, (v) => {
  if (!v) return;
  panelList.value = auxSidebarRailDefs().map((def) => ({ def, badge: badgeOf(def) }));
}, { immediate: true });

function act(fn: () => void) { emit('close'); fn(); }

/** 插件动作执行（同 ActivityBar.runActivityBarAction：缺陷动作不击穿面板） */
function runAction(action: ActivityBarActionDef) {
  try {
    action.onClick();
  } catch (err) {
    console.error('[ui-ext] 活动栏动作 "' + action.id + '" 出错:', err);
  }
}

// ── 返回键消费（cr-36）：面板开着时消费返回（关面板，不退后台）──
const registerBack = inject<((fn: () => boolean) => () => void) | null>('registerBackConsumer', null);
let offBack: (() => void) | null = null;
if (registerBack) {
  offBack = registerBack(() => {
    if (!props.visible) return false;
    emit('close');
    return true;
  });
}
onBeforeUnmount(() => offBack?.());

// ── 备份（与 ActivityBar 同款，toast 反馈同 key 原位刷新）──
const backupBusy = ref(false);
async function runBackup() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  toastBusy('正在备份…', { key: 'backup' });
  try {
    const d = await backupNow(clientCtx!.rpc);
    if (d.status === 'ok') {
      const mb = ((d.size ?? 0) / 1024 / 1024).toFixed(1);
      toastOk('备份完成：' + d.file + '（' + mb + 'MB，保留 ' + d.keep + ' 份）', { key: 'backup' });
    } else {
      toastError('备份失败：' + (d.error || '未知错误'), { key: 'backup' });
    }
  } catch (err: any) {
    toastError('备份失败：' + (err?.message || '网络错误'), { key: 'backup' });
  } finally {
    backupBusy.value = false;
  }
}

const hasUpdate = ref(false);
onMounted(async () => {
  try {
    const simulate = localStorage.getItem('agentchat.simulateUpdate') === '1';
    const data = await fetchVersion(simulate, clientCtx!.rpc);
    hasUpdate.value = data.hasUpdate || false;
  } catch { /* ignore */ }
});
</script>

<template>
  <Sheet :visible="visible" title="更多" @close="emit('close')">
    <!-- ① 头像行（同 ActivityBar 头像钮语义：viewer 配置） -->
    <button class="ms-profile" @click="act(() => ui.openAgentSettings(VIEWER_ID))">
      <Avatar :src="currentAvatar" :name="currentAgentName" :size="36" />
      <span class="ms-profile-name">{{ currentAgentName }}</span>
      <Icon name="chevron-right" :size="16" />
    </button>

    <div class="ms-divider" />

    <!-- ② 常用项 -->
    <button class="ms-item" @click="act(() => themeSvc?.toggleTheme())">
      <Icon :name="themeSvc?.theme.value === 'light' ? 'moon' : 'sun'" :size="18" />
      <span>{{ themeSvc?.theme.value === 'light' ? '切换暗色主题' : '切换亮色主题' }}</span>
    </button>
    <button class="ms-item" @click="act(() => ui.openGlobalSettings())">
      <Icon name="settings" :size="18" />
      <span>全局设置</span>
    </button>
    <button class="ms-item" @click="act(runBackup)" :disabled="backupBusy">
      <Icon name="download" :size="18" />
      <span>{{ backupBusy ? '备份中…' : '数据备份' }}</span>
    </button>
    <button class="ms-item" @click="act(() => ui.openVersion())">
      <Icon name="refresh-cw" :size="18" />
      <span>检查更新</span>
      <span v-if="hasUpdate" class="ms-dot" />
    </button>

    <!-- ③ 面板区（aux 选区全量入口——窄屏唯一通路） -->
    <template v-if="panelList.length > 0">
      <div class="ms-divider" />
      <div class="ms-section">面板</div>
      <button
        v-for="p in panelList"
        :key="p.def.id"
        class="ms-item"
        :title="p.def.rail?.title"
        @click="openPanel(p.def)"
      >
        <Icon :name="p.def.rail!.icon" :size="18" />
        <span>{{ p.def.rail!.title }}</span>
        <span v-if="p.badge" class="ms-badge">{{ p.badge }}</span>
      </button>
    </template>

    <!-- ④ 插件动作 -->
    <template v-if="sortedActivityBarActions.length > 0">
      <div class="ms-divider" />
      <button
        v-for="action in sortedActivityBarActions"
        :key="action.id"
        class="ms-item"
        @click="act(() => runAction(action))"
      >
        <Icon :name="action.icon" :size="18" />
        <span>{{ action.label }}</span>
      </button>
    </template>
  </Sheet>
</template>

<style scoped>
.ms-section { padding: 6px 16px 2px; font-size: 11.5px; font-weight: 600; color: var(--text-3); letter-spacing: .3px; }
.ms-profile {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px;
  border: none; background: none; cursor: pointer; text-align: left;
  color: var(--text-1); font-size: 15px; font-weight: 600;
}
.ms-profile:hover { background: var(--bg-hover); }
.ms-profile-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-divider { height: 1px; background: var(--line); margin: 6px 16px; }
.ms-item {
  display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 16px;
  border: none; background: none; cursor: pointer; text-align: left;
  color: var(--text-1); font-size: 14px; position: relative;
}
.ms-item:hover { background: var(--bg-hover); }
.ms-item:disabled { opacity: .6; cursor: wait; }
.ms-item svg { color: var(--text-3); flex-shrink: 0; }
.ms-dot { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.ms-badge {
  margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; background: var(--primary); color: #fff;
  font-size: 10.5px; font-weight: 600; line-height: 1;
}
</style>