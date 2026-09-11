// ============================================================
// client/SingleHeaderActions.vue —— 会话头独立会话动作族
//（会话区重构自 ConversationView 内联迁域归位：conversation:header-widget
//  贡献 order 30——single 形态的更多菜单（归档独立会话）；确认弹窗随件
//  内迁〔GroupDrawer 同款姿势——M29 P1-2 先例〕。ownerProps = { form,
//  single }，非 single 形态整体自隐。）
// ============================================================

<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import { Icon, Modal } from '@agentchat/webui-kit';
import { useClientContext } from 'ac-client-runtime';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import type { SingleSession } from './index.ts';

const props = defineProps<{
  /** 席位 owner 上下文透传（D16-③：ConversationView 经 SlotOutlet data 传入） */
  data: {
    form?: 'direct' | 'group' | 'single' | 'pair';
    /** 独立会话（single 形态非空） */
    single?: SingleSession | null;
  };
}>();

const roster = useRosterCore();
const singlesBoard = useClientContext()?.singleBoard;

const single = toRef(() => props.data.single);

/** 形态 gate：仅 single（direct 的 Agent 动作归 agents 贡献） */
const applicable = computed(() => props.data.form === 'single' && !!single.value);

const title = computed(() => {
  const s = single.value;
  if (!s) return '';
  if (!s.agentId) return s.title || '新会话';
  const name = roster.getAgentName(s.agentId) || s.agentId;
  return s.title || `${name} · 独立会话`;
});

// ── 更多菜单（归档独立会话）──
const showMoreMenu = ref(false);
function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) {
    setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
  }
}
function closeMoreMenu() { showMoreMenu.value = false; }

// ── 归档确认（自内核原样迁入：消息保留，可从数据目录找回）──
const archiveOpen = ref(false);
const archiveError = ref('');
const archiving = ref(false);

function askArchive() {
  showMoreMenu.value = false;
  archiveError.value = '';
  archiveOpen.value = true;
}

async function confirmArchive() {
  const s = single.value;
  if (!s || archiving.value) return;
  archiving.value = true;
  archiveError.value = '';
  try {
    await singlesBoard?.archive(s.id);
    archiveOpen.value = false;
  } catch (err: any) {
    archiveError.value = `归档失败: ${err.message}`;
  } finally {
    archiving.value = false;
  }
}
</script>

<template>
  <template v-if="applicable">
    <div class="more-menu-wrapper">
      <button class="settings-btn" @click.stop="toggleMoreMenu" title="更多操作">
        <Icon name="more-horizontal" :size="18" />
      </button>
      <Transition name="dropdown">
        <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
          <button class="dropdown-item danger" @click="askArchive">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            归档独立会话
          </button>
        </div>
      </Transition>
    </div>

    <!-- 归档确认对话框（随件内迁——状态自理） -->
    <Modal :visible="archiveOpen" :width="380" @close="archiveOpen = false">
      <div class="delete-dialog">
        <div class="delete-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        </div>
        <h4>归档独立会话</h4>
        <p class="delete-warning">确定要归档 <strong>{{ title }}</strong> 吗？</p>
        <p class="delete-detail">此操作将归档该会话（消息保留，可从数据目录找回），<br /><span class="delete-emphasis">归档后不再出现在列表中。</span></p>
        <div v-if="archiveError" class="delete-error">{{ archiveError }}</div>
        <div class="dialog-actions">
          <button class="btn-cancel" @click="archiveOpen = false" :disabled="archiving">取消</button>
          <button class="btn-delete" @click="confirmArchive" :disabled="archiving">{{ archiving ? '归档中…' : '确认归档' }}</button>
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
/* 归档确认对话框（全局，供 Modal 内使用——与 AgentHeaderActions 同款
   词汇；两行各自声明同款规则，行独立卸载互不影响） */
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
