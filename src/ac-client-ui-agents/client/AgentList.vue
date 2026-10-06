// AgentChat — Agent + 群组 列表（按时间混排；独立会话已移至 SessionList 会话列表页）

<script setup lang="ts">
import { onMounted, onUnmounted, inject, ref, computed, watch } from 'vue';

import { useChatStore } from 'ac-client-ui-conversation/client/chatStore.ts';
import { createAgent as apiCreateAgent, fetchLlmProviders, type LlmProviderStat } from './index.ts';
import { fetchPools } from 'ac-client-ui-agents/client/rosterApi.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useClientContext } from 'ac-client-runtime';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { Button, Icon, Input, Modal, PullToRefresh, SearchInput, Select, StarAvatar } from '@agentchat/webui-kit';
import { starColor } from '@agentchat/webui-kit';
import { directDialog, groupDialog } from 'ac-client-ui-conversation/client/feed.ts';
import { traceSwitch } from 'ac-client-ui-conversation/client/switchTrace.ts';
import type { AgentInfo, GroupInfo } from 'ac-client-ui-conversation/client/types.ts';

const chatStore = useChatStore();
const roster = useRosterCore();
const singlesBoard = useClientContext()?.singleBoard;
// rpc 契约面（宿主 'rpc' 服务——建档/池发现经此）
const rpc = useClientContext()?.rpc ?? null;
const feedStore = useFeedStore();
const ui = useUiStore();
const themeStore = useThemeStore();

/** Agent 星色（主题响应式：切换主题自动更新） */
function colorOf(id: string) { return starColor(id, themeStore.theme === 'dark' ? 'nebula' : 'aurora'); }

/** Agent 是否正在回复（其 direct 对话处于流式运行中 → 头像显示流转光环） */
function isAgentRunning(id: string): boolean { return feedStore.getDialog(directDialog(id))?.streaming ?? false; }

/* ── 群聊不显示运行光环（设计决定，非遗漏）──
 * 群聊里 Agent 是否发言由其自行调用 send_group 工具决定：发送前的过程流式
 * （thinking/正文增量）在 feed 层就被过滤（group~ 前缀事件不进 direct 分区，
 * 防串台），且这些流式并不代表一定会向群里发消息——本质上是无法从事件流
 * 可靠判断「群聊正在回复」的。因此群头像不做 running 判断，正式回复经
 * send_group → group.message 事件落进群组对话即可。 */

// 窄屏导航（cr-29）：选中即 push 会话页（宽屏 no-op——布局不动）
const pushMainIfNarrow = inject<() => void>('pushMainIfNarrow', () => {});

const emit = defineEmits<{
  (e: 'selectGroup', groupId: string): void;
  (e: 'createGroup'): void;
  (e: 'deselectGroup'): void;
}>();

const props = defineProps<{
  groups: GroupInfo[];
  activeGroupId: string;
  /** 群名册刷新（Host 供——下拉刷新数据面之一，cr-80） */
  refreshGroups: () => Promise<void>;
}>();

const searchQuery = ref('');
const showCreateMenu = ref(false);
const showAddDialog = ref(false);
const newAgentId = ref('');
const newAgentName = ref('');
/** 模型选择（P5：provider × model 双字段——连接定义归模型管理） */
const providerStats = ref<LlmProviderStat[]>([]);
/** 池发现缓存（config.llmProviders[x].models——【只列真实存在的模型】，
 *  静态缺省清单不进选项：未配置/调不通的模型选了没意义） */
const poolModels = ref<Record<string, string[]>>({});
const selProvider = ref('');
const selModel = ref('');
const addError = ref('');

function toggleCreateMenu() { showCreateMenu.value = !showCreateMenu.value; if (showCreateMenu.value) showAddDialog.value = false; }
function openAddAgentDialog() { showCreateMenu.value = false; openAddDialog(); }
function openCreateGroup() { showCreateMenu.value = false; emit('createGroup'); }
async function openAddDialog() {
  showAddDialog.value = true; selProvider.value = ''; selModel.value = '';
  if (providerStats.value.length === 0 && rpc) {
    const [statsR, poolsR] = await Promise.all([
      fetchLlmProviders(rpc).then((r) => r.stats).catch(() => []),
      fetchPools(rpc).then((r) => r.llmProviders).catch(() => ({})),
    ]);
    providerStats.value = statsR;
    const cache: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(poolsR as Record<string, { models?: unknown }>)) {
      if (name.startsWith('$') || !Array.isArray(entry.models)) continue;
      cache[name] = entry.models.filter((m): m is string => typeof m === 'string');
    }
    poolModels.value = cache;
  }
}

/** 所选 provider 的模型选项（发现缓存；空 = 交给服务端默认连接物化） */
const dialogModels = computed(() => poolModels.value[selProvider.value] ?? []);
/** kit Select 选项表（cr-171）：Provider / 模型 */
const dialogProviderOptions = computed(() => [
  { value: '', label: '默认（全局连接）' },
  ...providerStats.value.map((stat) => ({ value: stat.name, label: stat.description ? stat.name + ' · ' + stat.description : stat.name })),
]);
const dialogModelOptions = computed(() => [
  { value: '', label: '默认（该连接的默认模型）' },
  ...dialogModels.value.map((m) => ({ value: m, label: m })),
]);
/** 选 provider 未选 model 时的默认模型（首个已发现模型） */
function onDialogProviderChange(name: string) {
  selProvider.value = name;
  selModel.value = dialogModels.value[0] ?? '';
}

interface UnifiedItem { type: 'agent' | 'group'; id: string; name: string; lastActivity: number; agent?: AgentInfo; group?: GroupInfo; }

/** 自由序（按最近活动浮顶）——数据源，任何 agents/groups 变更都会重算重排 */
const freeOrder = computed<UnifiedItem[]>(() => {
  const items: UnifiedItem[] = [];
  for (const a of roster.agents.value) items.push({ type: 'agent', id: a.id, name: a.name || a.id, lastActivity: a.lastActivity ?? 0, agent: a });
  for (const g of props.groups) items.push({ type: 'group', id: g.group_id, name: g.name, lastActivity: g.lastActivity ?? 0, group: g });
  items.sort((a, b) => b.lastActivity - a.lastActivity);
  return items;
});

// ── 指针交互期间冻结列表行序（快速切换「点击落空/落错行」修复）──
// bumpAgentById（每条消息结束）/ setAgents（agentList 响应）都会按 lastActivity
// 重排整个列表。快速连点 Agent 的间隙一旦发生重排，光标下的行已被顶替：
//   · click 落到被流式活动顶到顶部的「旧 Agent」上 → 主区回到旧会话
//     （正是「未加载新 Agent 的会话，旧 Agent 的会话依然驻留」）；
//   · 或 mousedown/mouseup 目标分离 → click 干脆不触发 → 点击无任何反应。
// 依赖流式/轮询时序，故无法稳定复现。
// 冻结策略：列表容器 pointerdown 冻结；pointerup/leave/cancel 后 600ms 解冻
// （覆盖 0.5s 级连点窗口；解冻后按最新活动自然重排，浮顶语义不受影响）。
const orderFrozen = ref(false);
let unfreezeTimer: ReturnType<typeof setTimeout> | null = null;
const itemKey = (i: UnifiedItem) => `${i.type}-${i.id}`;

function freezeOrder() {
  orderFrozen.value = true;
  if (unfreezeTimer) { clearTimeout(unfreezeTimer); unfreezeTimer = null; }
}
function unfreezeOrderSoon() {
  if (unfreezeTimer) clearTimeout(unfreezeTimer);
  unfreezeTimer = setTimeout(() => { orderFrozen.value = false; unfreezeTimer = null; }, 600);
}
onUnmounted(() => { if (unfreezeTimer) clearTimeout(unfreezeTimer); });

/** 冻结期间的行序快照（keys）：非冻结时同步跟随自由序，冻结时停更 */
const frozenKeys = ref<string[]>([]);
watch(freeOrder, v => { if (!orderFrozen.value) frozenKeys.value = v.map(itemKey); }, { immediate: true, flush: 'sync' });

const unifiedList = computed<UnifiedItem[]>(() => {
  if (!orderFrozen.value) return freeOrder.value;
  const rank = new Map(frozenKeys.value.map((k, i) => [k, i]));
  // 冻结期按快照序展示；冻结期间新出现的条目排尾（保持相对稳定）
  return [...freeOrder.value].sort((a, b) =>
    (rank.get(itemKey(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(itemKey(b)) ?? Number.MAX_SAFE_INTEGER));
});

const filteredItems = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return unifiedList.value;
  return unifiedList.value.filter(i => i.name.toLowerCase().includes(q));
});

/** 未读数量（进入会话后清除，徽章显示具体数字）。direct = chatStore 未读
 *  （viewer⇄agent 对桶）；group = feed 群分区未读（group/message-posted 增量、
 *  setActiveGroup 进入清零——与 direct 同源同语义） */
function unreadCountOf(id: string): number {
  return chatStore.getUnreadCount(id) || feedStore.getDialog(groupDialog(id))?.unread || 0;
}
function unreadLabel(id: string): string { const n = unreadCountOf(id); return n > 99 ? '99+' : String(n); }
const listScrollRef = ref<{ $el: HTMLElement }>();
function onListEnter() { listScrollRef.value?.$el.classList.add('scroll-visible'); }
function onListLeave() { listScrollRef.value?.$el.classList.remove('scroll-visible'); }
onMounted(() => { roster.requestAgents(); document.addEventListener('click', onDocClick); listScrollRef.value?.$el.addEventListener('mouseenter', onListEnter); listScrollRef.value?.$el.addEventListener('mouseleave', onListLeave); });
onUnmounted(() => { document.removeEventListener('click', onDocClick); listScrollRef.value?.$el.removeEventListener('mouseenter', onListEnter); listScrollRef.value?.$el.removeEventListener('mouseleave', onListLeave); });
function onDocClick() { showCreateMenu.value = false; }

// ── 互斥：选中 Agent → 清除群组/single 选中 ──
watch(() => roster.activeAgentId.value, (newVal) => {
  if (newVal) { emit('deselectGroup'); singlesBoard?.deselectSingle(); }
});

/** 列表点击 = 明确的导航意图：① 覆盖层（运行矩阵/pair 只读视角）打开时强制选中
 *  （selectAgent 是 toggle，点"当前已选中"的 Agent 会反选成空 → App 的选中
 *  watch 只认「非空变化」不触发 → 覆盖层不退，表现为点击无变化）；② 无论选中
 *  结果如何都显式收起覆盖层（同值重选时三元组不变，watch 同样不触发）。 */
function selectAgent(id: string) {
  traceSwitch('click-agent', id);
  emit('deselectGroup');
  singlesBoard?.deselectSingle();
  const overlayOpen = ui.trackingViewVisible || !!ui.pairView;
  if (!overlayOpen || roster.activeAgentId.value !== id) roster.selectAgent(id);
  chatStore.clearUnread(id);
  // 历史加载由 ConversationView 的 activeAgentId watch 统一负责（与 single 模式对齐）
  const a = roster.agents.value.find(a => a.id === id);
  if (a?.hasActiveSession) chatStore.subscribeAgent(id);
  ui.exitOverlays(); // 进入会话：收矩阵 + 清 pair 视角（含同值重选边界）
  pushMainIfNarrow(); // 窄屏：push 会话页（cr-29）
}
function selectGroup(groupId: string) { roster.activeAgentId.value = ''; singlesBoard?.deselectSingle(); emit('selectGroup', groupId); ui.exitOverlays(); pushMainIfNarrow(); }

function formatLastMessage(lm: AgentInfo['lastMessage']): string { if (!lm?.content) return ''; return (lm.agent_id === 'user' ? '你: ' : '') + lm.content; }

const adding = ref(false);
/** 新建缺省标签（创建面显式预选——替代写口静默注入，2026-09-16：
 *  后端不再越权代填 tags，基础族预选在创建对话框可见可改） */
const NEW_AGENT_DEFAULT_TAGS = ['fs', 'collab', 'infra', 'memory'] as const;
async function createAgent() {
  if (adding.value) return; // 双击守卫：重复提交会创建两个 Agent
  adding.value = true;
  addError.value = ''; const id = newAgentId.value.trim();
  if (!rpc) { addError.value = 'RPC 不可用'; adding.value = false; return; }
  try {
    const body: Record<string, any> = {}; if (id) body.id = id; if (newAgentName.value.trim()) body.name = newAgentName.value.trim();
    // provider+model 双字段提交（服务端物化/引用拆分同语义）
    if (selProvider.value) body.provider = selProvider.value;
    if (selModel.value) body.llm = { model: selModel.value };
    body.tags = [...NEW_AGENT_DEFAULT_TAGS]; // 显式预选（对话框可见，创建后可在 Agent 面板调整）
    await apiCreateAgent(body, rpc);
    showAddDialog.value = false; newAgentId.value = ''; newAgentName.value = ''; addError.value = ''; roster.requestAgents();
  } catch (err: any) { addError.value = `创建失败: ${err.message}`; }
  finally { adding.value = false; }
}

interface PAv { avatar: string | null; name: string; }
function getGroupAvatars(g: GroupInfo): PAv[] { return g.participants.slice(0, 9).map(id => ({ avatar: roster.getAgentAvatar(id), name: roster.getAgentName(id) })); }
function gridLayout(n: number): { cols: number; rows: number } { if (n <= 1) return { cols: 1, rows: 1 }; if (n === 2) return { cols: 2, rows: 1 }; if (n <= 4) return { cols: 2, rows: 2 }; if (n <= 6) return { cols: 3, rows: 2 }; return { cols: 3, rows: 3 }; }

/** 下拉刷新（cr-80）：名册 + 群名册双源同步（各自失败静默） */
async function refreshAll() {
  await Promise.all([roster.requestAgents(), props.refreshGroups()]);
}
</script>

<template>
  <div class="agent-list">
    <div class="header">
      <div class="search-box"><SearchInput v-model="searchQuery" placeholder="搜索 Agent / 群组..." /></div>
      <div class="add-btn-wrap"><button class="add-btn" aria-label="新建" @click.stop="toggleCreateMenu"><Icon name="plus" :size="16" /></button><Transition name="menu-fade"><div v-if="showCreateMenu" class="ui-dd-menu create-menu" @click.stop><button class="ui-dd-opt" @click="openAddAgentDialog"><span class="ui-dd-opt-icon"><Icon name="bot" :size="14" /></span><span class="ui-dd-opt-body"><span class="ui-dd-opt-name">新增 Agent</span></span></button><button class="ui-dd-opt" @click="openCreateGroup"><span class="ui-dd-opt-icon"><Icon name="users" :size="14" /></span><span class="ui-dd-opt-body"><span class="ui-dd-opt-name">创建群组</span></span></button></div></Transition></div>

    </div>
    <PullToRefresh ref="listScrollRef" class="list-scroll" :on-refresh="refreshAll" @pointerdown="freezeOrder" @pointerup="unfreezeOrderSoon" @pointerleave="unfreezeOrderSoon" @pointercancel="unfreezeOrderSoon">
      <div v-for="item in filteredItems" :key="item.type + '-' + item.id" class="list-item ui-row"
        :class="{ 'is-selected': item.type === 'agent' ? roster.activeAgentId.value === item.id : activeGroupId === item.id }"
        @click="item.type === 'agent' ? selectAgent(item.id) : selectGroup(item.id)">
        <div v-if="item.type === 'agent'" class="item-avatar-wrap"><StarAvatar :src="item.agent?.avatar" :name="item.name" :size="36" :color="colorOf(item.id)" fallback-icon="bot" plain-fallback :running="isAgentRunning(item.id)" /><span v-if="unreadCountOf(item.id) > 0" class="ui-avatar-badge">{{ unreadLabel(item.id) }}</span></div>
        <!-- 群组头像：无运行光环（是否发言由 Agent 自行调用 send_group 决定，无法预判运行态；见 script 内注释）；未读徽章与 Agent 行同款 -->
        <div v-else-if="item.type === 'group' && item.group" class="group-avatar-wrap"><div class="group-avatar" :style="{ display: 'grid', gridTemplateColumns: `repeat(${gridLayout(getGroupAvatars(item.group).length).cols}, 1fr)`, gridTemplateRows: `repeat(${gridLayout(getGroupAvatars(item.group).length).rows}, 1fr)` }"><template v-for="(p, idx) in getGroupAvatars(item.group)" :key="idx"><img v-if="p.avatar" :src="p.avatar" :alt="p.name" class="group-avatar-cell" /><span v-else class="group-avatar-cell group-avatar-placeholder">{{ p.name.charAt(0).toUpperCase() }}</span></template><svg v-if="getGroupAvatars(item.group).length === 0" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></div><span v-if="unreadCountOf(item.id) > 0" class="ui-avatar-badge">{{ unreadLabel(item.id) }}</span></div>
        <div class="item-info"><div class="item-name">{{ item.name }}</div><div v-if="item.type === 'agent' && item.agent" class="item-last-msg">{{ formatLastMessage(item.agent.lastMessage) }}</div><div v-else-if="item.type === 'group' && item.group" class="item-last-msg">{{ item.group.participants.length }} 个参与者</div></div>
      </div>
      <div v-if="filteredItems.length === 0 && unifiedList.length > 0" class="empty">无匹配项</div><div v-else-if="unifiedList.length === 0" class="empty">暂无 Agent / 群组</div>
    </PullToRefresh>
    <Modal :visible="showAddDialog" :width="360" @close="showAddDialog = false"><div class="dialog-panel"><h4>新增 Agent</h4><div class="form-group"><label>Agent ID <span class="optional-hint">（可选，留空自动生成）</span></label><Input v-model="newAgentId" placeholder="如 my_agent，留空则自动生成 UUID" @keyup.enter="createAgent" /></div><div class="form-group"><label>显示名称</label><Input v-model="newAgentName" placeholder="如 我的助手" @keyup.enter="createAgent" /></div><div class="form-group"><label>Provider</label><Select :options="dialogProviderOptions" :model-value="selProvider" @update:model-value="onDialogProviderChange" /></div><div class="form-group"><label>模型</label><Select :options="dialogModelOptions" :model-value="selModel" :disabled="!selProvider" @update:model-value="selModel = $event" /></div><p v-if="!selProvider" class="default-hint">将使用全局默认连接与模型</p><div v-if="addError" class="error-text">{{ addError }}</div><div class="dialog-actions"><Button variant="ghost" @click="showAddDialog = false" :disabled="adding">取消</Button><Button variant="primary" :loading="adding" @click="createAgent">{{ adding ? '创建中…' : '创建' }}</Button></div></div></Modal>
  </div>
</template>

<style scoped>
.agent-list{flex:1;min-width:0;background:var(--bg-surface);display:flex;flex-direction:column;z-index:210;transition:transform .25s ease}
/* 右缘分界线退役：分界统一由布局骨架 ResizeHandle 细线担当（与 handle 线重叠曾呈双线） */
/* 暗色层级修复：列表用最深底，与内容区（--bg-base）拉开层次 */
html.dark .agent-list{background:var(--bg-base)}
/* 窄屏整页形态（cr-289）：surface/base 两种白在单页导航里成「色缝」——统一 base（同 SessionList cr-287） */
@media (max-width:768px){.agent-list{background:var(--bg-base)}}
.header{height:var(--layout-header-height);padding:0 12px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--line);flex-shrink:0}
.search-box{flex:1;display:flex;align-items:center}
.add-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:var(--r-sm);background:none;color:var(--text-2);cursor:pointer;flex-shrink:0}
.add-btn:hover{background:var(--bg-base);color:var(--primary)}
.add-btn-wrap{position:relative;flex-shrink:0}
/* 新建菜单已归 ui-dd-menu/ui-dd-opt 配方（cr-171）；.create-menu 只作定位 */
.create-menu{top:100%;right:0;margin-top:4px;min-width:180px}
.menu-fade-enter-active,.menu-fade-leave-active{transition:opacity .12s ease,transform .12s ease}
.menu-fade-enter-from,.menu-fade-leave-to{opacity:0;transform:translateY(-4px)}
.mobile-close-btn{display:none;background:none;border:none;cursor:pointer;color:var(--text-2);padding:4px;border-radius:var(--radius-sm);line-height:0}
.mobile-close-btn:hover{background:var(--bg-hover);color:var(--text-1)}
/* 列表滚动容器：背景与 .agent-list 一致；滚动条默认零宽度不占位，JS 加 .scroll-visible 时浮现 */
.list-scroll{flex:1;overflow-y:auto;padding:var(--space-xs);background:var(--bg-surface);scrollbar-width:none;scrollbar-color:transparent transparent}
/* 暗色：列表背景为最深底，滚动条区域同色避免杂色带 */
html.dark .list-scroll{background:var(--bg-base)}
@media (max-width:768px){.list-scroll{background:var(--bg-base)}}
.list-scroll::-webkit-scrollbar{width:0;height:0}
/* track 设明确背景（与列表一致），避免滚动条区域透出内容/空白 */
.list-scroll::-webkit-scrollbar-track{background:var(--bg-surface)}
html.dark .list-scroll::-webkit-scrollbar-track{background:var(--bg-base)}
@media (max-width:768px){.list-scroll::-webkit-scrollbar-track{background:var(--bg-base)}}
.list-scroll::-webkit-scrollbar-thumb{background:transparent}
.list-scroll.scroll-visible{scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
.list-scroll.scroll-visible::-webkit-scrollbar{width:6px;height:6px}
/* thumb 与其他滚动条（消息区）对齐：中性边框色，hover 为主色 */
.list-scroll.scroll-visible::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:var(--r-full,999px)}
.list-scroll.scroll-visible::-webkit-scrollbar-thumb:hover{background:var(--primary)}

.list-item{padding:10px 12px;margin-bottom:var(--space-xs);cursor:pointer;gap:10px}
/* hover 亮底由 .ui-row 承担（cr-122：hover 去边框、去微影） */
/* 选中态 = .ui-row.is-selected（--role-selected-bg 角色底 + 主色描边） */
.item-avatar-wrap{position:relative;flex-shrink:0}
.group-avatar-wrap{position:relative;flex-shrink:0}
/* 通知计数色保留字面值（#ef4444 底 + #fff 字）：非语义状态色、kit 无计数徽章原语，
   已归一 kit badge.css .ui-avatar-badge（cr-157——err 令牌族替代 #ef4444 硬编码；
   ActivityBar/MobileTabBar 等同款角标同批切换） */
.item-info{flex:1;min-width:0}
.item-name{font-size:13px;font-weight:600;line-height:17px;margin-bottom:1px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-last-msg{font-size:11px;line-height:18px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-avatar{width:40px;height:40px;border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;background:var(--primary-light);color:var(--primary);flex-shrink:0;gap:1px;padding:2px;box-sizing:border-box;overflow:hidden}
.group-avatar-cell{width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--on-primary);background:var(--primary);min-width:0;min-height:0}
.group-avatar-placeholder{text-transform:uppercase;line-height:1}
.empty{padding:var(--space-lg);text-align:center;color:var(--text-3);font-size:14px}
.dialog-panel{padding:20px 24px}
.dialog-panel h4{margin:0 0 14px;font-size:15px;font-weight:600;color:var(--text-1)}
.dialog-panel .form-group{margin-bottom:10px;display:flex;flex-direction:column;gap:4px}
.dialog-panel label{font-size:12px;font-weight:500;color:var(--text-2)}
/* 表单控件与动作钮已归 kit Input/Select/Button（cr-171） */
.default-hint{font-size:12px;color:var(--text-3);margin:-4px 0 4px;font-style:italic}
.error-text{font-size:12px;color:var(--err);margin-bottom:8px}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.modal-enter-active,.modal-leave-active{transition:opacity .15s ease}
.modal-enter-from,.modal-leave-to{opacity:0}
</style>