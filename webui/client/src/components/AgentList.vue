// AgentChat — 统一 Agent + 群组 列表（按时间混排）

<script setup lang="ts">
import { onMounted, onUnmounted, inject, ref, computed, watch } from 'vue';

import { useChatStore } from '../stores/chat';
import { VIEWER_ID } from '../constants';
import { useAgentStore } from '../stores/agents';
import { useWebSocketStore } from '../stores/websocket';
import type { AgentInfo, GroupInfo } from '../types';

const chatStore = useChatStore();
const agentStore = useAgentStore();
const wsStore = useWebSocketStore();

const closeSidebar = inject<() => void>('closeSidebar', () => {});

const emit = defineEmits<{
  (e: 'selectGroup', groupId: string): void;
  (e: 'createGroup'): void;
  (e: 'deselectGroup'): void;
}>();

const props = defineProps<{
  groups: GroupInfo[];
  activeGroupId: string;
}>();

const searchQuery = ref('');
const showCreateMenu = ref(false);
const showAddDialog = ref(false);
const newAgentId = ref('');
const newAgentName = ref('');
const selectedLlmPool = ref('');
const llmPools = ref<Record<string, Record<string, unknown>>>({});
const addError = ref('');

function toggleCreateMenu() { showCreateMenu.value = !showCreateMenu.value; if (showCreateMenu.value) showAddDialog.value = false; }
function openAddAgentDialog() { showCreateMenu.value = false; openAddDialog(); }
function openCreateGroup() { showCreateMenu.value = false; emit('createGroup'); }
async function openAddDialog() {
  showAddDialog.value = true; selectedLlmPool.value = '';
  if (Object.keys(llmPools.value).length === 0) {
    try { const r = await fetch('/api/config/pools'); if (r.ok) { const d = await r.json(); llmPools.value = d.llmProviders ?? {}; } } catch { /* ignore */ }
  }
}

interface UnifiedItem { type: 'agent' | 'group'; id: string; name: string; lastActivity: number; agent?: AgentInfo; group?: GroupInfo; }

const unifiedList = computed<UnifiedItem[]>(() => {
  const items: UnifiedItem[] = [];
  for (const a of agentStore.agents) items.push({ type: 'agent', id: a.id, name: a.name || a.id, lastActivity: a.lastActivity ?? 0, agent: a });
  for (const g of props.groups) items.push({ type: 'group', id: g.group_id, name: g.name, lastActivity: g.lastActivity ?? 0, group: g });
  items.sort((a, b) => b.lastActivity - a.lastActivity);
  return items;
});

const filteredItems = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return unifiedList.value;
  return unifiedList.value.filter(i => i.name.toLowerCase().includes(q));
});

const unreadAgents = computed(() => chatStore.unreadAgents);
onMounted(() => { agentStore.requestAgents(); fetchAllSessionTokens(); document.addEventListener('click', onDocClick); });
onUnmounted(() => { document.removeEventListener('click', onDocClick); });
function onDocClick() { showCreateMenu.value = false; }

// ── 互斥：选中 Agent → 清除群组选中 ──
watch(() => agentStore.activeAgentId, (newVal) => {
  if (newVal) emit('deselectGroup');
});

function selectAgent(id: string) { emit('deselectGroup'); agentStore.selectAgent(id); chatStore.loadHistory(VIEWER_ID.value, id); const a = agentStore.agents.find(a => a.id === id); if (a?.hasActiveSession) wsStore.send('chat.subscribe', { to: id }); closeSidebar(); }
function selectGroup(groupId: string) { agentStore.activeAgentId = ''; localStorage.removeItem('agentchat.lastAgent'); emit('selectGroup', groupId); closeSidebar(); }

function formatLastMessage(lm: AgentInfo['lastMessage']): string { if (!lm?.content) return ''; return (lm.agent_id === 'user' ? '你: ' : '') + lm.content; }

async function createAgent() {
  addError.value = ''; const id = newAgentId.value.trim();
  try {
    const body: Record<string, any> = {}; if (id) body.id = id; if (newAgentName.value.trim()) body.name = newAgentName.value.trim();
    if (selectedLlmPool.value) { const pool = llmPools.value[selectedLlmPool.value]; if (pool) { const pd: Record<string, any> = { $ref: selectedLlmPool.value }; for (const [k, v] of Object.entries(pool)) { if (k !== '$ref' && k !== '$comment' && !k.startsWith('$')) pd[k] = v; } body.llm = pd; } }
    const resp = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok) { addError.value = data.error || '创建失败'; return; }
    showAddDialog.value = false; newAgentId.value = ''; newAgentName.value = ''; addError.value = ''; agentStore.requestAgents();
  } catch (err: any) { addError.value = `创建失败: ${err.message}`; }
}

interface PAv { avatar: string | null; name: string; }
function getGroupAvatars(g: GroupInfo): PAv[] { return g.participants.slice(0, 9).map(id => ({ avatar: agentStore.getAgentAvatar(id), name: agentStore.getAgentName(id) })); }
function gridLayout(n: number): { cols: number; rows: number } { if (n <= 1) return { cols: 1, rows: 1 }; if (n === 2) return { cols: 2, rows: 1 }; if (n <= 4) return { cols: 2, rows: 2 }; if (n <= 6) return { cols: 3, rows: 2 }; return { cols: 3, rows: 3 }; }
</script>

<template>
  <div class="agent-list">
    <div class="header">
      <div class="search-box"><svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg><input v-model="searchQuery" type="text" class="search-input" placeholder="搜索会话..." /></div>
      <div class="add-btn-wrap"><button class="add-btn" @click.stop="toggleCreateMenu" title="新建"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg></button><Transition name="menu-fade"><div v-if="showCreateMenu" class="create-menu" @click.stop><button class="menu-item" @click="openAddAgentDialog"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.5" /><path d="M9 15c1.67 2 4.33 2 6 0" /></svg>新增 Agent</button><button class="menu-item" @click="openCreateGroup"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/></svg>创建群组</button></div></Transition></div>

      <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
    </div>
    <div class="list-scroll">
      <div v-for="item in filteredItems" :key="item.type + '-' + item.id" class="list-item"
        :class="{ active: item.type === 'agent' ? agentStore.activeAgentId === item.id : activeGroupId === item.id }"
        @click="item.type === 'agent' ? selectAgent(item.id) : selectGroup(item.id)">
        <div v-if="item.type === 'agent'" class="item-avatar-wrap"><div class="item-avatar"><img v-if="item.agent?.avatar" :src="item.agent.avatar" :alt="item.name" /><div v-else class="avatar-placeholder">{{ item.name.charAt(0).toUpperCase() }}</div></div><span v-if="unreadAgents.has(item.id)" class="unread-dot" /></div>
        <div v-else-if="item.group" class="group-avatar" :style="{ display: 'grid', gridTemplateColumns: `repeat(${gridLayout(getGroupAvatars(item.group).length).cols}, 1fr)`, gridTemplateRows: `repeat(${gridLayout(getGroupAvatars(item.group).length).rows}, 1fr)` }"><template v-for="(p, idx) in getGroupAvatars(item.group)" :key="idx"><img v-if="p.avatar" :src="p.avatar" :alt="p.name" class="group-avatar-cell" /><span v-else class="group-avatar-cell group-avatar-placeholder">{{ p.name.charAt(0).toUpperCase() }}</span></template><svg v-if="getGroupAvatars(item.group).length === 0" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></div>
        <div class="item-info"><div class="item-name">{{ item.name }}</div><div v-if="item.type === 'agent' && item.agent" class="item-last-msg">{{ formatLastMessage(item.agent.lastMessage) }}</div><div v-else-if="item.type === 'group' && item.group" class="item-last-msg">{{ item.group.participants.length }} 个参与者</div></div>
      </div>
      <div v-if="filteredItems.length === 0 && unifiedList.length > 0" class="empty">无匹配的会话</div><div v-else-if="unifiedList.length === 0" class="empty">暂无会话</div>
    </div>
    <Transition name="modal"><div v-if="showAddDialog" class="dialog-overlay" @mousedown.self="showAddDialog = false"><div class="dialog-panel" @click.stop><h4>新增 Agent</h4><div class="form-group"><label>Agent ID <span class="optional-hint">（可选，留空自动生成）</span></label><input v-model="newAgentId" type="text" placeholder="如 my_agent，留空则自动生成 UUID" @keyup.enter="createAgent" /></div><div class="form-group"><label>显示名称</label><input v-model="newAgentName" type="text" placeholder="如 我的助手" @keyup.enter="createAgent" /></div><div class="form-group"><label>模型</label><select v-model="selectedLlmPool"><option value="">默认（全局配置）</option><option v-for="(entry, name) in llmPools" :key="name" :value="name">{{ name }}{{ (entry as any).model && (entry as any).model !== name ? ' · ' + (entry as any).model : '' }}</option></select></div><p v-if="!selectedLlmPool" class="default-hint">将使用全局默认模型配置</p><div v-if="addError" class="error-text">{{ addError }}</div><div class="dialog-actions"><button class="btn-cancel" @click="showAddDialog = false">取消</button><button class="btn-save" @click="createAgent">创建</button></div></div></div></Transition>
  </div>
</template>

<style scoped>
.agent-list{flex:1;min-width:0;background:var(--color-bg-surface);border-right:1px solid var(--color-border-secondary);display:flex;flex-direction:column;z-index:210;transition:transform .25s ease}
.header{height:var(--layout-header-height);padding:0 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--color-border-secondary);flex-shrink:0}
.search-box{flex:1;position:relative;display:flex;align-items:center}
.search-icon{position:absolute;left:8px;color:var(--color-text-tertiary,#a8abb2);pointer-events:none}
.search-input{width:100%;padding:5px 8px 5px 28px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);font-size:13px;outline:none;transition:border-color .15s}
.search-input:focus{border-color:var(--color-primary,#6366f1)}
.search-input::placeholder{color:var(--color-text-tertiary,#a8abb2)}
.add-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:6px;background:none;color:var(--color-text-secondary,#7f8c8d);cursor:pointer;flex-shrink:0}
.add-btn:hover{background:var(--color-bg-page,#fff);color:var(--color-primary,#6366f1)}
.add-btn-wrap{position:relative;flex-shrink:0}
.create-menu{position:absolute;top:100%;right:0;margin-top:4px;background:var(--color-bg-page,#fff);border:1px solid var(--color-border-secondary,#ddd);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:4px;min-width:150px;z-index:300}
.menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;border-radius:6px;background:none;color:var(--color-text-primary,#2c3e50);font-size:13px;cursor:pointer;text-align:left}
.menu-item:hover{background:var(--color-primary-light,rgba(79,70,229,.08));color:var(--color-primary,#6366f1)}
.menu-fade-enter-active,.menu-fade-leave-active{transition:opacity .12s ease,transform .12s ease}
.menu-fade-enter-from,.menu-fade-leave-to{opacity:0;transform:translateY(-4px)}
.mobile-close-btn{display:none;background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:4px;border-radius:var(--radius-sm);line-height:0}
.mobile-close-btn:hover{background:var(--color-bg-subtle);color:var(--color-text-primary)}
.list-scroll{flex:1;overflow-y:auto;padding:var(--space-sm)}
.list-item{display:flex;align-items:center;padding:10px 12px;margin-bottom:var(--space-xs);border-radius:var(--radius-md);cursor:pointer;transition:background var(--transition-fast),border-color var(--transition-fast);border:1px solid transparent;gap:10px}
.list-item:hover{background:var(--color-bg-page);border-color:var(--color-border-secondary)}
.list-item.active{background:var(--color-primary-light);border:1px solid var(--color-primary)}
.item-avatar-wrap{position:relative;flex-shrink:0}
.item-avatar{width:40px;height:40px;border-radius:6px;overflow:hidden}
.unread-dot{position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:50%;background:#ef4444;border:2px solid var(--color-bg-surface,#fff);z-index:1}
.item-avatar img{width:100%;height:100%;object-fit:cover}
.avatar-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--color-primary-light,rgba(79,70,229,.12));color:var(--color-primary,#4f46e5);font-size:15px;font-weight:600}
.item-info{flex:1;min-width:0}
.item-name{font-size:13px;font-weight:600;line-height:19px;margin-bottom:2px;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-last-msg{font-size:11px;line-height:19px;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-avatar{width:40px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:var(--color-primary-light,rgba(79,70,229,.12));color:var(--color-primary,#4f46e5);flex-shrink:0;gap:1px;padding:2px;box-sizing:border-box;overflow:hidden}
.group-avatar-cell{width:100%;height:100%;object-fit:cover;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;background:var(--color-primary,#4f46e5);min-width:0;min-height:0}
.group-avatar-placeholder{text-transform:uppercase;line-height:1}
.item-token-gauge{display:flex;align-items:center;gap:4px;margin-top:3px}
.list-gauge-track{flex:1;height:3px;border-radius:1.5px;background:var(--color-bg-hover,rgba(0,0,0,.06));overflow:hidden;min-width:20px}
.list-gauge-fill{height:100%;border-radius:1.5px;transition:width .4s ease}
.list-gauge-fill.low{background:#22c55e}
.list-gauge-fill.moderate{background:#eab308}
.list-gauge-fill.high{background:#f97316}
.list-gauge-fill.critical{background:#ef4444}
.list-gauge-pct{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0}
.list-gauge-pct.low{color:#22c55e}
.list-gauge-pct.moderate{color:#eab308}
.list-gauge-pct.high{color:#f97316}
.list-gauge-pct.critical{color:#ef4444}
.empty{padding:var(--space-lg);text-align:center;color:var(--color-text-muted);font-size:14px}
.dialog-overlay{position:fixed;inset:0;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;z-index:600}
.dialog-panel{background:var(--color-bg-page,#fff);border-radius:10px;padding:20px 24px;width:360px;max-width:90vw;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.15)}
.dialog-panel h4{margin:0 0 14px;font-size:15px;font-weight:600;color:var(--color-text-primary,#2c3e50)}
.dialog-panel .form-group{margin-bottom:10px;display:flex;flex-direction:column;gap:4px}
.dialog-panel label{font-size:12px;font-weight:500;color:var(--color-text-secondary,#7f8c8d)}
.dialog-panel input,.dialog-panel select{padding:7px 10px;border:1px solid var(--color-border-secondary,#ddd);border-radius:6px;font-size:13px;background:var(--color-bg-page,#fff);color:var(--color-text-primary,#2c3e50);outline:none;width:100%;box-sizing:border-box}
.dialog-panel input:focus,.dialog-panel select:focus{border-color:var(--color-primary,#6366f1)}
.default-hint{font-size:12px;color:var(--color-text-tertiary,#a8abb2);margin:-4px 0 4px;font-style:italic}
.error-text{font-size:12px;color:#e74c3c;margin-bottom:8px}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.btn-cancel,.btn-save{padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer}
.btn-cancel{background:var(--color-bg-page,#fff);border:1px solid var(--color-border-secondary,#ddd);color:var(--color-text-secondary,#7f8c8d)}
.btn-save{background:var(--color-primary,#6366f1);border:none;color:#fff}
.btn-save:hover{background:var(--color-primary-hover,#4f46e5)}
.modal-enter-active,.modal-leave-active{transition:opacity .15s ease}
.modal-enter-from,.modal-leave-to{opacity:0}
@media(max-width:768px){.agent-list{position:fixed;top:0;left:0;bottom:0;width:min(280px,80vw);transform:translateX(-100%);box-shadow:2px 0 16px rgba(0,0,0,.15)}.agent-list.sidebar-mobile-visible{transform:translateX(0)}.mobile-close-btn{display:flex;align-items:center;justify-content:center}}
</style>
