// ============================================================
// client/AgentHeaderActions.vue —— 会话头 Agent 动作族
//（会话区重构自 ConversationView 内联迁域归位：conversation:header-widget
//  贡献 order 30——direct 形态的「Agent 配置」按钮 + 更多菜单（删除
//  Agent）；确认弹窗随件内迁〔GroupDrawer 同款姿势——M29 P1-2 先例〕，
//  conversation 零删除编排。ownerProps = { form, agentId }，非 direct
//  形态整体自隐。）
// ============================================================

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import { ConfirmBody, Icon, Modal, Tooltip } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { useRosterCore } from './rosterAccess.ts';
import { deleteAgent } from './rosterApi.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    form?: 'direct' | 'group' | 'single' | 'pair';
    /** 头部目标 Agent（direct = 激活 Agent） */
    agentId?: string | null;
  };
}>();

const roster = useRosterCore();
const ui = useUiStore();
// rpc 契约面（宿主 'rpc' 服务——删除经此）
const rpc = useClientContext()?.rpc ?? null;

const agentId = toRef(() => props.data.agentId);

/** 形态 gate：仅 direct（group/single/pair 各归其域贡献） */
const applicable = computed(() => props.data.form === 'direct' && !!agentId.value);

const agentName = computed(() => {
  const id = agentId.value;
  if (!id) return '';
  return roster.getAgentName(id) || id;
});

/** 打开 Agent 配置（预设 Agent 无实体配置，不显示设置入口） */
const showSettings = computed(() => applicable.value && !roster.isPreset(agentId.value || ''));
function openSettings() {
  if (agentId.value) ui.openAgentSettings(agentId.value);
}

// ── 更多菜单（危险操作：删除 Agent）──
const showMoreMenu = ref(false);
function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) {
    setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
  }
}
function closeMoreMenu() { showMoreMenu.value = false; }

// ── 删除确认（自内核原样迁入；群删除已随 GroupDrawer 住 ui-group）──
const deleteOpen = ref(false);
const deleteError = ref('');
const deleting = ref(false);

function askDelete() {
  showMoreMenu.value = false;
  deleteError.value = '';
  deleteOpen.value = true;
}

async function confirmDelete() {
  if (!agentId.value || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    if (rpc) await deleteAgent(agentId.value, rpc);
    if (roster.activeAgentId.value === agentId.value) roster.selectAgent(agentId.value);
    roster.requestAgents();
    deleteOpen.value = false;
  } catch (err: any) {
    deleteError.value = `删除失败: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <template v-if="applicable">
    <!-- Agent 配置（预设 Agent 无实体配置，不显示设置入口） -->
    <Tooltip v-if="showSettings" text="Agent 配置" placement="bottom">
      <button class="settings-btn" aria-label="Agent 配置" @click="openSettings">
        <Icon name="settings" :size="18" />
      </button>
    </Tooltip>

    <!-- 更多操作菜单（危险操作：删除 Agent；工具定义预览已移除——
         Agent 配置的插件工具面覆盖） -->
    <div class="more-menu-wrapper">
      <button class="settings-btn" aria-label="更多操作" @click.stop="toggleMoreMenu">
        <Icon name="more-horizontal" :size="18" />
      </button>
      <Transition name="dropdown">
        <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
          <button class="dropdown-item danger" @click="askDelete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
            删除 Agent
          </button>
        </div>
      </Transition>
    </div>

    <!-- 删除确认对话框（kit ConfirmBody——cr-157 归一三份 delete-dialog 副本） -->
    <Modal :visible="deleteOpen" :width="380" @close="deleteOpen = false">
      <ConfirmBody
        title="永久删除 Agent"
        confirm-text="确认删除"
        danger
        :busy="deleting"
        @cancel="deleteOpen = false"
        @confirm="confirmDelete"
      >
        <template #default>
          <p class="delete-warning">确定要删除 <strong>{{ agentName }}</strong> 吗？</p>
          <p class="delete-detail">此操作将删除该 Agent 的所有配置、会话历史和凭据，<span class="delete-emphasis">不可恢复，不可撤销。</span></p>
          <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
        </template>
      </ConfirmBody>
    </Modal>
  </template>
</template>

<style scoped>
.settings-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer; color: var(--text-2);
  padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.settings-btn:hover, .settings-btn.active { background: var(--bg-surface); color: var(--text-1); }
.settings-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 更多菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown { position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--bg-raised, var(--bg-base)); border: 1px solid var(--line, var(--line)); border-radius: 10px; box-shadow: var(--shadow-pop); min-width: 180px; z-index: 300; padding: 4px; overflow: hidden; }
.dropdown-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: 6px; background: none; color: var(--text-1, var(--text-1)); font-size: 13px; cursor: pointer; text-align: left; }
.dropdown-item:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dropdown-item.danger { color: var(--err); }
.dropdown-item.danger:hover { background: rgba(var(--err-rgb), 0.12); color: var(--err); }
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

<style>
/* 弹体框架已迁 kit ConfirmBody（cr-157）；此处仅留富文本正文修饰 */
.delete-warning { margin: 0 0 4px; font-size: 14px; color: var(--text-2); }
.delete-warning strong { color: var(--err); }
.delete-detail { margin: 0 0 4px; font-size: 12px; color: var(--text-3); line-height: 1.6; }
.delete-emphasis { color: var(--err); font-weight: 600; }
.delete-error { font-size: 12px; color: var(--err); margin-bottom: 8px; }
</style>
