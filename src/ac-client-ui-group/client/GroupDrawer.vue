<script setup lang="ts">
// ============================================================
// ac-client-ui-group/client/GroupDrawer.vue —— 群聊信息面板
//（成员/名称/简介/群主/删除）
//
// M29 P1-2 自 conversation 迁域归位（复审 F4 漏迁）：群域视图随域走。
// 会话区重构再迁形：group:drawer 席位（chat-body 内嵌抽屉）→ aux-sidebar
// 选区（右侧第四区域的标准选区之一——与工作区同级；右缘切换条按钮 +
// 二次点击收起，AuxSidebarHost 供给）。当选即整体渲染（开合态 =
// 选区 active：drawerOpen 域态 + 显式选区），零 props：当前群取自本域
// ctx.groups 服务（与群视角 perspective def 同一查找式，同一对象引用
// ——面板内的本地回写〔改名/简介/属主〕天然同步主视图）；删除编排
//（确认弹窗 + deleteGroup RPC + onGroupDeleted 收口）随件内迁。
// ============================================================

import { ref, computed, watch } from 'vue';
import type { GroupInfo } from './index.ts';
import { VIEWER_ID } from 'ac-client-runtime';
import { useClientContext } from 'ac-client-runtime';
import { updateGroup, deleteGroup } from './groupApi.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { Avatar, Button, ConfirmBody, Icon, Modal, Tooltip } from '@agentchat/webui-kit';

const roster = useRosterCore();
const ui = useUiStore();
const groupSvc = useClientContext()?.groups;
// rpc 契约面（宿主 'rpc' 服务——群写侧经此）
const rpc = useClientContext()?.rpc ?? null;

/** 当前群（= 活跃群；与群视角 perspective props() 同源同引用） */
const group = computed<GroupInfo | null>(() =>
  groupSvc?.groups.value.find(g => g.group_id === groupSvc.activeGroupId.value) ?? null);

const editingName = ref('');
const editingDescription = ref('');
const memberSearchQuery = ref('');
const renameError = ref('');
const renameSaved = ref(false);
const saving = ref(false);

/** 关闭面板（面板内关闭钮/移动端覆盖态）：域态收起 + 区域折叠 */
function closePanel() {
  groupSvc?.closeDrawer();
  if (ui.auxVisible) ui.toggleAux();
  // 窄屏 aux 已隐藏（cr-29）——本调用主要服务宽屏；窄屏回 root 由返回键/返回钮承担
}

// ── 删除编排（确认弹窗 + RPC + onGroupDeleted）──
const deleteOpen = ref(false);
const deleteError = ref('');
const deleting = ref(false);

async function confirmDeleteGroup() {
  if (!group.value || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    if (rpc) await deleteGroup(group.value.group_id, rpc);
    deleteOpen.value = false;
    groupSvc?.onGroupDeleted(group.value.group_id);
  } catch (err: any) {
    deleteError.value = `删除失败: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}

function getMemberAvatar(agentId: string): string | undefined {
  return roster.getAgentAvatar(agentId) || undefined;
}
function getMemberName(agentId: string): string {
  return roster.getAgentName(agentId) || agentId;
}

const filteredParticipants = computed(() => {
  const q = memberSearchQuery.value.toLowerCase().trim();
  // 完整参与面：user（viewer）是隐式成员——后端 members 不入册，展示面
  // 首位并入，与「我能在这里说话」的事实一致
  const ps = (() => {
    const list = group.value?.participants ?? [];
    return list.includes(VIEWER_ID.value) ? list : [VIEWER_ID.value, ...list];
  })();
  if (!q) return ps;
  return ps.filter(p => p.toLowerCase().includes(q));
});

const memberItems = computed(() =>
  filteredParticipants.value.map(id => ({
    id,
    name: getMemberName(id),
    avatar: getMemberAvatar(id) ?? null,
    isViewer: id === VIEWER_ID.value,
    // 成员私有转录流可查看（cr-4：run 推理/工具/终稿的回放材料；viewer 成员行不显示——user 端点无成员流）
    canViewStream: id !== VIEWER_ID.value,
  }))
);

// ── 成员转录流查看（cr-4：会话视图入口——session/history 标准桶 gid~member）──
const streamOpen = ref(false);
const streamMember = ref('');
const streamMemberName = ref('');
const streamRows = ref<Array<{ role: string; content: string }>>([]);
const streamLoading = ref(false);
const streamError = ref('');

async function openMemberStream(memberId: string, name: string) {
  if (!rpc || !group.value) return;
  streamMember.value = memberId;
  streamMemberName.value = name;
  streamOpen.value = true;
  streamLoading.value = true;
  streamError.value = '';
  streamRows.value = [];
  try {
    const r = await rpc.call<{ messages?: Array<{ role: string; content: string | null }> }>('session/history', {
      conversationId: `${group.value.group_id}~${memberId}`,
      viewer: memberId,
    });
    streamRows.value = (r.messages ?? [])
      .filter((m) => typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) }));
  } catch (err: any) {
    streamError.value = `读取失败: ${err.message}`;
  } finally {
    streamLoading.value = false;
  }
}

/** 名称/简介任一变更即脏（仅改简介也可保存——曾因禁用条件只看名称，
 *  简介改动后保存钮恒禁用，改了也存不进） */
const infoDirty = computed(() => {
  const g = group.value;
  return editingName.value.trim() !== (g?.name ?? '')
    || editingDescription.value !== (g?.description ?? '');
});

/** 挂载（或切换群组）时初始化编辑字段——此前初始化函数从未被调用，
 *  名称输入框永远为空、保存按钮恒禁用。（aux 选区当选即挂载——
 *  volatile 生命周期随选举，无 visible 维度） */
watch(() => group.value?.group_id, () => {
  if (!group.value) return;
  editingName.value = group.value.name;
  editingDescription.value = group.value.description ?? '';
  memberSearchQuery.value = '';
  renameError.value = '';
}, { immediate: true });

async function saveGroupInfo() {
  if (saving.value || !editingName.value.trim() || !group.value) return;
  // 只发变更字段（仅改简介不再附带 rename——群名未变不发 group/renamed）
  const body: Record<string, string> = {};
  if (editingName.value.trim() !== group.value.name) body.name = editingName.value.trim();
  if (editingDescription.value !== (group.value.description ?? '')) body.description = editingDescription.value;
  if (!body.name && !body.description) return;
  saving.value = true;
  renameError.value = '';
  renameSaved.value = false;
  if (!rpc) { renameError.value = 'RPC 不可用'; saving.value = false; return; }
  try {
    await updateGroup(group.value.group_id, body, rpc);
    // 本地回写（名称此前不回写，标题/列表残留旧名）+ 刷新列表保持一致；
    // 简介清空 = 删键（与后端"空 → undefined 清空"对齐）
    group.value.name = editingName.value.trim();
    if (editingDescription.value) group.value.description = editingDescription.value;
    else delete group.value.description;
    void groupSvc?.fetchGroups();
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) {
    renameError.value = `保存失败: ${err.message}`;
  } finally {
    saving.value = false;
  }
}
// 退出群聊：后端尚无对应契约（WS_SEND 无 group.leave），功能入口已移除
</script>

<template>
  <div v-if="group" class="drawer-panel" :style="ui.auxPaneStyle" @click.stop>
      <div class="drawer-head">
        <span class="drawer-head-title">群聊信息</span>
        <Tooltip text="收起面板" placement="bottom">
          <button class="drawer-close-btn" aria-label="收起面板" @click="closePanel">
            <Icon name="x" :size="15" />
          </button>
        </Tooltip>
      </div>
      <div class="drawer-section">
        <div class="drawer-section-title">群成员 ({{ group.participants.length }})</div>
        <div class="drawer-search-box">
          <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input v-model="memberSearchQuery" type="text" class="drawer-search-input" placeholder="搜索成员..." />
        </div>
        <div class="drawer-member-list">
          <div v-for="m in memberItems" :key="m.id" class="drawer-member-item" :title="m.id">
            <div class="member-avatar-wrap">
              <Avatar :src="m.avatar" :name="m.name" :size="40" shape="circle" />
              <span v-if="m.isViewer" class="member-me">我</span>
            </div>
            <span class="member-name" :title="m.name">{{ m.name }}</span>
            <Tooltip v-if="m.canViewStream" text="查看该成员的私有会话流（推理/工具/发言回放）" placement="top">
              <button class="member-stream-btn" aria-label="查看该成员的私有会话流（推理/工具/发言回放）" @click.stop="openMemberStream(m.id, m.name)">会话</button>
            </Tooltip>
          </div>
          <div v-if="memberItems.length === 0" class="drawer-empty">未找到匹配的成员</div>
        </div>
      </div>

      <!-- 名称 + 简介合并为一节共用保存钮：简介区曾只有孤立 textarea、无任何保存
           入口（唯一保存钮在名称行）——「简介改了存不了」即此；Enter 在名称框直接
           保存，简介为多行字段改用 Ctrl+Enter -->
      <div class="drawer-section">
        <div class="drawer-section-title">群聊信息（名称与简介）</div>
        <div class="drawer-name-row">
          <input v-model="editingName" type="text" class="drawer-name-input" placeholder="输入群聊名称..." @keyup.enter="saveGroupInfo" />
          <button class="drawer-save-btn" :class="{ saved: renameSaved }" @click="saveGroupInfo" :disabled="saving || !editingName.trim() || !infoDirty">{{ renameSaved ? '已保存' : '保存' }}</button>
        </div>
        <textarea v-model="editingDescription" class="drawer-desc-input" placeholder="添加群聊简介..." rows="3" @keydown.ctrl.enter.prevent="saveGroupInfo"></textarea>
        <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
      </div>

      <div class="drawer-section drawer-section-bottom">
        <button class="drawer-delete-btn" @click="deleteOpen = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
          删除群组
        </button>
      </div>

      <!-- ═══ 删除确认弹窗（kit ConfirmBody——cr-157）═══ -->
      <Modal :visible="deleteOpen" :width="380" @close="deleteOpen = false">
        <ConfirmBody
          title="删除群聊群组"
          confirm-text="确认删除"
          danger
          :busy="deleting"
          @cancel="deleteOpen = false"
          @confirm="confirmDeleteGroup"
        >
          <template #default>
            <p class="delete-warning">确定要删除 <strong>{{ group.name }}</strong> 吗？</p>
            <p class="delete-detail">此操作将删除该群组的所有消息记录，<span class="delete-emphasis">不可恢复，不可撤销。</span></p>
            <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
          </template>
        </ConfirmBody>
      </Modal>

      <!-- ═══ 成员私有转录流查看（cr-4：run 推理/工具/终稿回放——session/history 标准桶）═══ -->
      <Modal :visible="streamOpen" :width="560" @close="streamOpen = false">
        <div class="stream-dialog">
          <h4>{{ streamMemberName }} 的群会话流</h4>
          <p class="stream-hint">该成员在本群的私有上下文（推理/工具调用/发言回放）——其他成员不可见</p>
          <div v-if="streamLoading" class="stream-loading">读取中…</div>
          <div v-else-if="streamError" class="drawer-error">{{ streamError }}</div>
          <div v-else-if="streamRows.length === 0" class="stream-loading">（暂无记录）</div>
          <div v-else class="stream-list">
            <div v-for="(row, i) in streamRows" :key="i" class="stream-row" :class="'sr-' + row.role">
              <span class="stream-role">{{ row.role }}</span>
              <span class="stream-content">{{ row.content }}</span>
            </div>
          </div>
          <div class="stream-actions">
            <Button variant="ghost" size="sm" @click="streamOpen = false">关闭</Button>
          </div>
        </div>
      </Modal>
    </div>
</template>

<style scoped>
.drawer-panel {
  /* 左缘分界线退役：分界统一由布局骨架 ResizeHandle 细线担当（重叠曾呈双线） */
  flex-shrink: 0;
  background: var(--bg-surface); display: flex; flex-direction: column;
  overflow-y: auto; min-width: 180px;
}
/* 面板头（标题 + 关闭钮——移动端覆盖态唯一关闭入口） */
.drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  /* 高度对齐会话头（--layout-header-height）——三区顶部齐线 */
  height: var(--layout-header-height, 48px); padding: 0 16px;
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; background: var(--bg-surface); z-index: 5;
}
.drawer-head-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.drawer-close-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: var(--r-sm);
  background: none; color: var(--text-2); cursor: pointer;
}
.drawer-close-btn:hover { background: var(--bg-base); color: var(--text-1); }
.drawer-section { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.drawer-section-title { font-size: 13px; font-weight: 600; color: var(--text-1); margin-bottom: 8px; }
.drawer-search-box { position: relative; display: flex; align-items: center; margin-bottom: 8px; }
.drawer-search-box .search-icon { position: absolute; left: 8px; color: var(--text-3); pointer-events: none; }
.drawer-search-input { width: 100%; padding: 5px 8px 5px 28px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 12px; background: transparent; color: var(--text-1); outline: none; }
.drawer-search-input:focus { border-color: var(--primary); }
/* 成员格子固定宽自动换行：面板随 aux 侧栏可自由拖宽（180px+），写死一行 4 个
   太死板——auto-fill + minmax 让列数随宽度自适应（窄 2 列、宽 6+ 列） */
.drawer-member-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 8px 4px; max-height: 320px; overflow-y: auto; padding: 4px 0; }
.drawer-member-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 2px; border-radius: var(--r-md); cursor: default; min-width: 0; transition: background 0.15s ease; }
.drawer-member-item:hover { background: var(--bg-hover); }
.member-avatar-wrap { position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; line-height: 0; }
.member-me { position: absolute; right: -5px; bottom: -3px; font-size: 9px; font-weight: 600; color: var(--on-primary); line-height: 14px; padding: 0 4px; border-radius: var(--r-full, 999px); background: var(--primary); border: 1.5px solid var(--bg-surface); }
.member-name { font-size: 11px; color: var(--text-1); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; max-width: 100%; margin-top: 2px; }
.member-stream-btn { padding: 1px 6px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 10px; background: none; color: var(--text-3); cursor: pointer; }
.member-stream-btn:hover { color: var(--primary); border-color: var(--primary); }
.drawer-empty { padding: 12px 0; font-size: 12px; color: var(--text-3); text-align: center; }
.drawer-name-row { display: flex; gap: 6px; }
.drawer-name-input { flex: 1; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 13px; background: transparent; color: var(--text-1); outline: none; }
.drawer-name-input:focus { border-color: var(--primary); }
.drawer-save-btn { padding: 4px 12px; border: none; border-radius: var(--r-sm); font-size: 12px; background: var(--primary); color: var(--on-primary); cursor: pointer; white-space: nowrap; }
.drawer-save-btn:disabled { opacity: 0.5; cursor: default; }
.drawer-save-btn.saved { background: var(--ok); }
.drawer-desc-input { width: 100%; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 12px; background: transparent; color: var(--text-1); outline: none; resize: vertical; font-family: inherit; line-height: 1.5; min-height: 52px; }
.drawer-desc-input:focus { border-color: var(--primary); }
.drawer-error { font-size: 11px; color: var(--err); margin-top: 4px; }
/* 成员转录流查看弹层（cr-4） */
.stream-dialog { padding: 20px 18px 16px; }
.stream-dialog h4 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.stream-hint { margin: 0 0 10px; font-size: 11px; color: var(--text-3); }
.stream-loading { padding: 20px 0; font-size: 12px; color: var(--text-3); text-align: center; }
.stream-list { max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.stream-row { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
.stream-role { flex-shrink: 0; width: 56px; text-align: right; color: var(--text-3); font-size: 10px; padding-top: 2px; }
.sr-assistant .stream-role { color: var(--primary); }
.sr-system .stream-role { color: var(--warn); }
.stream-content { flex: 1; white-space: pre-wrap; word-break: break-word; color: var(--text-1); }
.drawer-section-bottom { border-bottom: none; display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.drawer-leave-btn, .drawer-delete-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: var(--r-sm); font-size: 13px; cursor: pointer; text-align: left; }
.drawer-delete-btn { background: none; color: var(--err); }
.drawer-delete-btn:hover { background: rgba(var(--err-rgb), 0.1); }
/* 删除弹体框架已迁 kit ConfirmBody（cr-157）；此处仅留富文本正文修饰与流弹窗底钮 */
.delete-warning { margin: 0 0 4px; font-size: 14px; color: var(--text-2); }
.delete-warning strong { color: var(--err); }
.delete-detail { margin: 0 0 4px; font-size: 12px; color: var(--text-3); line-height: 1.6; }
.delete-emphasis { color: var(--err); font-weight: 600; }
.delete-error { font-size: 12px; color: var(--err); margin-bottom: 8px; }
.stream-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
