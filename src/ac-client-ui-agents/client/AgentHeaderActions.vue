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
import { Icon, Modal } from '@agentchat/webui-kit';
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
    <button v-if="showSettings" class="settings-btn" @click="openSettings" title="Agent 配置">
      <Icon name="settings" :size="18" />
    </button>

    <!-- 更多操作菜单（危险操作：删除 Agent；工具定义预览已移除——
         Agent 配置的插件工具面覆盖） -->
    <div class="more-menu-wrapper">
      <button class="settings-btn" @click.stop="toggleMoreMenu" title="更多操作">
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

    <!-- 删除确认对话框（随件内迁——状态自理） -->
    <Modal :visible="deleteOpen" :width="380" @close="deleteOpen = false">
      <div class="delete-dialog">
        <div class="delete-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        </div>
        <h4>永久删除 Agent</h4>
        <p class="delete-warning">确定要删除 <strong>{{ agentName }}</strong> 吗？</p>
        <p class="delete-detail">此操作将删除该 Agent 的所有配置、会话历史和凭据，<br /><span class="delete-emphasis">不可恢复，不可撤销。</span></p>
        <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
        <div class="dialog-actions">
          <button class="btn-cancel" @click="deleteOpen = false" :disabled="deleting">取消</button>
          <button class="btn-delete" @click="confirmDelete" :disabled="deleting">{{ deleting ? '删除中…' : '确认删除' }}</button>
        </div>
      </div>
    </Modal>
  </template>
</template>

<style scoped>
.settings-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer; color: var(--color-text-secondary);
  padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.settings-btn:hover, .settings-btn.active { background: var(--color-bg-surface); color: var(--color-text-primary); }
.settings-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 更多菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown { position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--bg-raised, var(--color-bg-page)); border: 1px solid var(--line, var(--color-border-secondary)); border-radius: 10px; box-shadow: var(--shadow-pop, 0 4px 16px rgba(0,0,0,0.1)); min-width: 180px; z-index: 300; padding: 4px; overflow: hidden; }
.dropdown-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: 6px; background: none; color: var(--text-1, var(--color-text-primary)); font-size: 13px; cursor: pointer; text-align: left; }
.dropdown-item:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dropdown-item.danger { color: var(--err, #e74c3c); }
.dropdown-item.danger:hover { background: color-mix(in srgb, var(--err) 12%, transparent); color: var(--err); }
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }
</style>

<style>
/* 删除确认对话框（全局，供 Modal 内使用） */
.delete-dialog { padding: 28px 24px 20px; text-align: center; }
.delete-icon { margin-bottom: 12px; }
.delete-dialog h4 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.delete-warning { margin: 0 0 4px; font-size: 14px; color: var(--color-text-secondary); }
.delete-warning strong { color: #e74c3c; }
.delete-detail { margin: 0 0 16px; font-size: 12px; color: var(--color-text-tertiary); line-height: 1.6; }
.delete-emphasis { color: #e74c3c; font-weight: 600; }
.delete-error { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: center; gap: 10px; }
.btn-cancel { padding: 8px 20px; border: 1px solid var(--color-border-secondary); border-radius: 6px; background: var(--color-bg-page); color: var(--color-text-secondary); font-size: 13px; cursor: pointer; }
.btn-cancel:hover { background: var(--color-bg-surface); }
.btn-delete { padding: 8px 20px; border: none; border-radius: 6px; background: #e74c3c; color: #fff; font-size: 13px; cursor: pointer; font-weight: 500; }
.btn-delete:hover { background: #c0392b; }
.btn-delete:disabled, .btn-cancel:disabled { opacity: 0.6; cursor: default; }
</style>
