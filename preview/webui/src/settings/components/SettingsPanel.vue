<script setup lang="ts">
// ============================================================
// SettingsPanel.vue —— 统一设置面板（替代 GlobalSettings + AgentSettings）
// 树：Agent 设置 / 模型管理 / 搜索引擎 / 扩展 / 工具 / 系统
// 数据：schema 驱动；展示 effective、编辑 raw
// ============================================================
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useSettings } from '../useSettings';
import { toFields, filterFields, isNonDefault, applySearchPoolDefault, applyLlmPoolDefault } from '../schema';
import type { TimerEntry, PoolEntry } from '../types';
import { Modal, Button } from '@/ui';
import SettingField from './SettingField.vue';
import NsFieldList from './NsFieldList.vue';
import PoolManager from './PoolManager.vue';
import AgentListPane from './AgentListPane.vue';
import AgentPane from './AgentPane.vue';
import PluginLibraryPane from './PluginLibraryPane.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { sortedSettingsTabs, resolveTabProps } from '@/core/extensions/slots';

const props = defineProps<{ visible: boolean; initialAgentId?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const settings = useSettings();

// 组件卸载时撤销插件域 WS 订阅（避免重开面板重复刷新）
onBeforeUnmount(() => {
  settings.disposePluginWs();
});

// ── 状态 ──
const selectedNode = ref('llmPools');
const expanded = ref<Record<string, boolean>>({ agents: true, extensions: true, tools: true, system: true });
const saving = ref(false);
const restarting = ref(false);
const successMsg = ref('');
const errorText = computed(() => settings.error.value);

// ── 树 ──
type TreeNode = { id: string; label: string; type: 'category' | 'leaf'; children?: TreeNode[] };

function schemaLabel(nsKey: string): string {
  const map: Record<string, string> = {
    'tool.bash': 'Bash 命令',
    'tool.web_search': '网页搜索',
    'agent.session': '会话与归档',
    'agent.memory': '记忆',
    'agent.prompt': '提示词',
    'agent.security': '安全',
  };
  if (map[nsKey]) return map[nsKey];
  const seg = nsKey.split('.').pop() || nsKey;
  return seg.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const tree = computed<TreeNode[]>(() => {
  return [
    { id: 'agents', label: 'Agent 设置', type: 'leaf' as const },
    { id: 'llmPools', label: '模型管理', type: 'leaf' as const },
    { id: 'searchPools', label: '搜索引擎', type: 'leaf' as const },
    // （M22 D1：全局「扩展与工具」叶子已并入插件库「装配行」页签）
    { id: 'pluginLibrary', label: '插件库', type: 'leaf' as const },
    { id: 'sys.timer', label: '定时任务', type: 'leaf' as const },
    { id: 'sys.session', label: '会话回放', type: 'leaf' as const },
    // 动态全局插件页签（settings-tab:global）：宿主树形结构不变，只追加叶子节点
    ...sortedSettingsTabs.value.map(tab => ({
      id: `ui-tab:${tab.id}`,
      label: tab.label,
      type: 'leaf' as const,
    })),
  ];
});

/** 当前选中的插件全局设置页签（若 selectedNode 命中 ui-tab:*） */
const currentPluginSettingsTab = computed(() => {
  if (!selectedNode.value.startsWith('ui-tab:')) return null;
  return sortedSettingsTabs.value.find(t => `ui-tab:${t.id}` === selectedNode.value) ?? null;
});

const globalPluginTabProps = computed<Record<string, unknown>>(() => {
  const tab = currentPluginSettingsTab.value;
  if (!tab) return {};
  return resolveTabProps(tab, {
    globalConfig: settings.globalConfig.value,
    nsSchemas: settings.nsSchemas.value,
    pools: settings.pools.value,
  });
});

const currentTitle = computed(() => {
  for (const n of tree.value) {
    if (n.id === selectedNode.value) return n.label;
    const child = n.children?.find(c => c.id === selectedNode.value);
    if (child) return `${n.label} › ${child.label}`;
  }
  return '';
});

function selectNode(id: string) {
  selectedNode.value = id;
}

// ── 池更新：同步全局引用指向默认条目 ──
// 池"设为默认"若不同步全局引用，残留的显式引用对象（旧版写入或 GET 展开
// 回写）会静默遮蔽池默认，表现为"设为默认不生效"（详见 apply*PoolDefault 注释）。
function onSearchPoolsUpdate(pools: Record<string, PoolEntry>) {
  settings.pools.value = { ...settings.pools.value, searchProviders: pools };
  settings.globalConfig.value.searchProviders = pools;
  applySearchPoolDefault(pools, settings.globalConfig.value as Record<string, any>);
}

function onLlmPoolsUpdate(pools: Record<string, PoolEntry>) {
  settings.pools.value = { ...settings.pools.value, llmProviders: pools };
  settings.globalConfig.value.llmProviders = pools;
  applyLlmPoolDefault(pools, settings.globalConfig.value as Record<string, any>);
}

// ── Agent 池编辑导航 ──
const editingAgent = ref('');
function openAgentEditor(agentId: string) {
  if (agentId !== settings.agentId.value) settings.loadAgent(agentId);
  editingAgent.value = agentId;
}
function backToAgentList() {
  editingAgent.value = '';
}
async function createAgent(payload: { id?: string; name: string; provider?: string; llm?: Record<string, any> }) {
  const ok = await settings.createAgent(payload);
  if (ok && payload.id) openAgentEditor(payload.id);
}
async function removeAgent(agentId: string) {
  await settings.removeAgent(agentId);
  if (editingAgent.value === agentId) editingAgent.value = '';
}

// ── 全局定时任务（timer.tasks 模型：time/hint/targets） ──
interface GlobalTask { time: string; hint?: string; targets?: string[]; builtin?: boolean }

/** 系统机制任务特殊 hint（不走 LLM，纯机制执行） */
const SPECIAL_HINTS: Record<string, { label: string; desc: string }> = {
  '__archive_all__': { label: '全局归档', desc: '批量归档所有活跃 1:1 会话（深夜执行，不走 LLM）' },
  '__backup_all__': { label: '数据备份', desc: '自动打包备份全部数据（每周一次，不走 LLM）' },
};
type SysHint = keyof typeof SPECIAL_HINTS;
function specialHint(hint?: string): { label: string; desc: string } | undefined {
  return hint ? SPECIAL_HINTS[hint.trim()] : undefined;
}
function isSysTask(t: GlobalTask): boolean { return !!specialHint(t.hint); }
/** 内置系统任务（config 预置，builtin=true）：不可删除、类型锁定；用户新建的系统任务不受此保护 */
function isProtectedTask(t: GlobalTask): boolean { return isSysTask(t) && t.builtin === true; }
/** 目标展示：'*' 通配视为全部 */
function targetsText(t: GlobalTask): string {
  const ts = (t.targets ?? []).filter(x => x && x !== '*');
  return ts.length ? '→ ' + ts.join(', ') : '→ 全部';
}

const gTaskDraft = ref<GlobalTask>({ time: '', hint: '', targets: [] });
const gTaskType = ref<'custom' | SysHint>('custom');
const gTaskBuiltin = ref(false);
const gTaskTargetsText = ref('');
const gTaskEditIdx = ref<number | null>(null);
const gTaskEditing = ref(false);
const gTaskError = ref('');

const gTasks = computed<GlobalTask[]>(() => settings.globalConfig.value.timer?.tasks ?? []);

// ── 会话回放（M21/D14：session.replayTrajectory 布尔两态）──
const replayTrajectory = computed<boolean>(() => settings.globalConfig.value.session?.replayTrajectory === true);
function setReplayTrajectory(v: boolean): void {
  if (!settings.globalConfig.value.session) settings.globalConfig.value.session = {};
  settings.globalConfig.value.session.replayTrajectory = v;
}
function timerCfg() { return settings.globalConfig.value.timer ?? {}; }
function ensureTimer() {
  if (!settings.globalConfig.value.timer) settings.globalConfig.value.timer = { enabled: true, tasks: [] };
  if (!settings.globalConfig.value.timer.tasks) settings.globalConfig.value.timer.tasks = [];
}
function startAddTask() {
  gTaskEditing.value = true; gTaskEditIdx.value = null;
  gTaskDraft.value = { time: '', hint: '', targets: [] };
  gTaskType.value = 'custom';
  gTaskBuiltin.value = false;
  gTaskTargetsText.value = ''; gTaskError.value = '';
}
function startEditTask(idx: number) {
  gTaskEditing.value = true; gTaskEditIdx.value = idx;
  const t = gTasks.value[idx];
  const sp = specialHint(t.hint);
  gTaskType.value = sp ? (t.hint!.trim() as SysHint) : 'custom';
  gTaskBuiltin.value = isProtectedTask(t);
  gTaskDraft.value = { time: t.time, hint: sp ? t.hint : (t.hint || ''), targets: [...(t.targets || [])] };
  gTaskTargetsText.value = (t.targets || []).join('\n'); gTaskError.value = '';
}
function saveTask() {
  const time = gTaskDraft.value.time.trim();
  if (!/^\d{2}:\d{2}$/.test(time)) { gTaskError.value = '时间格式需为 HH:mm（如 08:30）'; return; }
  ensureTimer();
  const isSpecial = gTaskType.value !== 'custom';
  const task: GlobalTask = {
    time,
    hint: isSpecial ? gTaskType.value : (gTaskDraft.value.hint?.trim() || undefined),
    targets: gTaskTargetsText.value.split(/[\n,，]/).map(s => s.trim()).filter(Boolean) || undefined,
  };
  const tasks = settings.globalConfig.value.timer.tasks as GlobalTask[];
  if (gTaskEditIdx.value !== null) tasks[gTaskEditIdx.value] = task;
  else tasks.push(task);
  gTaskEditing.value = false; gTaskEditIdx.value = null;
}
function removeTask(idx: number) {
  const tasks = settings.globalConfig.value.timer?.tasks;
  if (!tasks) return;
  const t = tasks[idx];
  if (isProtectedTask(t)) return; // 内置系统任务：删除按钮已禁用，双保险
  tasks.splice(idx, 1);
}

// ── 保存 / 重启 / 关闭 ──
/** 装配字段需要保存（tools/hooks 有编辑） */
const assemblyNeedsSave = computed(() => settings.agentAssemblyDirty.value);

async function saveAll() {
  saving.value = true;
  settings.error.value = '';
  const savedAgent = settings.agentId.value
    && (settings.agentDirty.value || assemblyNeedsSave.value);
  const savedGlobal = settings.globalDirty.value;
  let ok = true;
  if (savedGlobal) ok = await settings.saveGlobal() && ok;
  if (savedAgent) ok = await settings.saveAgent() && ok;
  if (ok) {
    // 按上下文提示生效时点
    const msgs: string[] = [];
    if (savedAgent) msgs.push('Agent 配置已保存 · 下次运行生效');
    if (savedGlobal) msgs.push('全局配置已保存 · 下次运行生效');
    successMsg.value = msgs.join('；') || '已保存';
    setTimeout(() => { successMsg.value = ''; }, 3500);
  }
  saving.value = false;
}

const isDirty = computed(() => settings.globalDirty.value || settings.agentDirty.value || assemblyNeedsSave.value);

// ── 通用确认弹窗（ConfirmDialog 组件，替代原生 confirm） ──
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);

async function requestClose() {
  if (isDirty.value) {
    const ok = await confirmRef.value?.ask({
      title: '放弃未保存的更改？',
      message: '有未保存的更改，关闭后这些更改将丢失。是否仍要关闭？',
      confirmLabel: '放弃更改并关闭',
      danger: true,
    });
    if (!ok) return;
  }
  emit('close');
}

function requestRestart() {
  if (restarting.value) return;
  void confirmRef.value?.ask({
    title: '重启后端？',
    message: '将完全重启后端，进行中的任务会被中断，几秒后自动恢复。',
    confirmLabel: '确认重启',
  }).then((ok) => {
    if (!ok) return;
    restarting.value = true;
    // 兜底解锁：此前只有 send 同步抛错才复位——WS 事件链路无回调时按钮永久
    // 卡在"正在重启"（后端 15s 内未发 systemRestarting 或事件丢失的场合）
    if (restartResetTimer) clearTimeout(restartResetTimer);
    restartResetTimer = setTimeout(() => { restarting.value = false; }, 30_000);
    try {
      settings.restartBackend();
    } catch {
      restarting.value = false;
    }
  });
}
let restartResetTimer: ReturnType<typeof setTimeout> | null = null;

// ── 加载 ──
watch([() => props.visible, () => props.initialAgentId], ([v, agentId]) => {
  if (v) {
    settings.error.value = '';
    settings.loadMeta();
    settings.loadGlobal();
    // 定位到指定 Agent（来自聊天页/侧边栏的入口）；面板已开时换目标也要导航
    if (agentId) {
      selectedNode.value = 'agents';
      openAgentEditor(agentId);
    }
  } else {
    // 关闭：重置 Agent 编辑态——面板常驻挂载，不清理会让"已放弃"的编辑
    // 在重开同一 Agent 时复活（同 id 不重载）且可被误保存
    editingAgent.value = '';
    settings.resetAgent();
  }
});
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="sp-overlay" @mousedown.self="requestClose()">
      <div class="sp-panel" @click.stop>
        <!-- Header -->
        <div class="sp-header">
          <span class="sp-accent"></span>
          <h3 class="sp-title">设置</h3>
          <span v-if="currentTitle" class="sp-subtitle">{{ currentTitle }}</span>
          <span v-if="isDirty" class="sp-dirty-badge">● 未保存</span>
          <button class="sp-close" @click="requestClose()" title="关闭">×</button>
        </div>

        <div class="sp-body">
          <!-- 左侧树 -->
          <div class="sp-sidebar">
            <div v-for="node in tree" :key="node.id" class="sp-tree-group">
              <template v-if="node.type === 'category'">
                <div class="sp-tree-cat" @click="expanded[node.id] = !expanded[node.id]">
                  <svg class="sp-arrow" :class="{ open: expanded[node.id] }" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  <span>{{ node.label }}</span>
                  <span class="sp-tree-count">{{ node.children?.length }}</span>
                </div>
                <div v-if="expanded[node.id]" class="sp-tree-children">
                  <div
                    v-for="child in node.children" :key="child.id"
                    class="sp-tree-leaf" :class="{ active: selectedNode === child.id }"
                    @click="selectNode(child.id)"
                  >{{ child.label }}</div>
                  <div v-if="!node.children?.length" class="sp-tree-empty">暂无</div>
                </div>
              </template>
              <div
                v-else class="sp-tree-leaf sp-root-leaf" :class="{ active: selectedNode === node.id }"
                @click="selectNode(node.id)"
              >{{ node.label }}</div>
            </div>
          </div>

          <!-- 右侧内容 -->
          <div class="sp-main">
            <div v-if="settings.loading.value" class="sp-status">加载中...</div>
            <template v-else>
              <!-- Agent 设置：列表（池模式） -->
              <template v-if="selectedNode === 'agents'">
                <div v-if="editingAgent" class="agent-editor">
                  <AgentPane
                    :agent-id="editingAgent"
                    :agents="settings.agents.value"
                    :raw="settings.agentRaw.value"
                    :effective="settings.agentEffective.value"
                    :sys-content="settings.sysContent.value"
                    :sys-enabled="settings.sysEnabled.value"
                    :agent-content="settings.agentContent.value"
                    :agent-enabled="settings.agentEnabled.value"
                    :timers="settings.agentTimers.value"
                    :assembly="settings.agentAssembly.value"
                    :assembly-error="settings.agentAssemblyError.value"
                    :extensions="settings.pluginCatalog.value?.extensions ?? []"
                    :plugins="settings.pluginCatalog.value?.plugins ?? []"
                    :permissions="settings.pluginPermissions.value"
                    :event-chains="settings.eventChains.value"
                    :event-descriptions="settings.eventDescriptions.value"
                    :llm-schemas="settings.llmSchemas.value"
                    :search-schemas="settings.searchSchemas.value"
                    :pools="settings.pools.value"
                    :saving="saving"
                    @update:raw="settings.agentRaw.value = $event"
                    @update:sys-content="settings.sysContent.value = $event"
                    @update:sys-enabled="settings.sysEnabled.value = $event"
                    @update:agent-content="settings.agentContent.value = $event"
                    @update:agent-enabled="settings.agentEnabled.value = $event"
                    @update:timers="settings.agentTimers.value = $event"
                    @switch="openAgentEditor"
                    @back="backToAgentList"
                    @save-timers="settings.saveTimers()"
                  />
                </div>
                <AgentListPane
                  v-else
                  :agents="settings.agents.value"
                  :llm-schemas="settings.llmSchemas.value"
                  @edit="openAgentEditor"
                  @create="createAgent"
                  @delete="removeAgent"
                />
              </template>

              <!-- 模型池 -->
              <PoolManager
                v-else-if="selectedNode === 'llmPools'"
                kind="llm"
                :pools="settings.pools.value.llmProviders"
                :schemas="settings.llmSchemas.value"
                @update:pools="onLlmPoolsUpdate"
              />

              <!-- 搜索池 -->
              <PoolManager
                v-else-if="selectedNode === 'searchPools'"
                kind="search"
                :pools="settings.pools.value.searchProviders"
                :schemas="settings.searchSchemas.value"
                @update:pools="onSearchPoolsUpdate"
              />

              <!-- 插件库（M24 P4：目录 | 插件市场 两页签；目录 = 插件/工具/事件
                   三视图左导航——M23 四页签退役） -->
              <PluginLibraryPane
                v-else-if="selectedNode === 'pluginLibrary'"
                :catalog-builtin="settings.pluginCatalogData.value?.builtin ?? []"
                :catalog-local="settings.pluginCatalogData.value?.local ?? []"
                :catalog-pending="settings.pluginCatalogData.value?.pending ?? []"
                :catalog-note="settings.pluginCatalogData.value?.note"
                :catalog-error="settings.pluginCatalogError.value || undefined"
                :root="settings.pluginLibrary.value?.root"
                :session="settings.sessionPlugins.value"
                :permissions="settings.pluginPermissions.value"
                :rows="settings.pluginCatalog.value?.rows ?? []"
                :extensions="settings.pluginCatalog.value?.extensions ?? []"
                :tools="settings.pluginCatalog.value?.tools ?? []"
                :safe-mode="settings.pluginCatalog.value?.safeMode === true"
                :event-chains="settings.eventChains.value"
                :event-descriptions="settings.eventDescriptions.value"
                :event-chains-by-event="settings.eventChainsByEvent.value"
                :event-policy="settings.eventPolicy.value"
                @refresh="settings.loadPluginCatalog()"
              />

              <!-- 插件全局设置页签（settings-tab:global slot） -->
              <div v-else-if="currentPluginSettingsTab" class="plugin-settings-tab">
                <component :is="currentPluginSettingsTab.component" v-bind="globalPluginTabProps" />
              </div>

              <!-- 命名空间配置（扩展/工具/系统） -->
              <NsFieldList
                v-else-if="selectedNode.startsWith('ns.')"
                :ns-key="selectedNode.slice(3)"
                :config="settings.globalConfig.value"
                :schema="(settings.nsSchemas.value as any)[selectedNode.slice(3)]"
                :title="currentTitle"
              />

              <!-- 全局定时任务 -->
              <div v-else-if="selectedNode === 'sys.timer'" class="g-timer">
                <div class="g-timer-head">
                  <div>
                    <div class="g-timer-title">定时任务</div>
                    <div class="g-timer-desc">每个任务 = 时间点 + 提示内容 + 目标 Agent（空=全部）。提示支持占位符：&#123;&#123;now&#125;&#125; / &#123;&#123;time&#125;&#125; / &#123;&#123;date&#125;&#125;</div>
                  </div>
                  <button class="g-timer-add" @click="startAddTask()">+ 添加任务</button>
                </div>

                <div class="g-timer-list">
                  <div v-for="(t, i) in gTasks" :key="i" class="g-timer-item">
                    <div class="g-timer-info">
                      <span class="g-timer-time">{{ t.time }}</span>
                      <span class="g-timer-hint" :class="{ 'is-sys': isSysTask(t) }">
                        {{ specialHint(t.hint)?.label ?? (t.hint || '（报时）') }}
                        <span v-if="isSysTask(t)" class="g-timer-sys-badge">系统</span>
                      </span>
                      <span class="g-timer-targets">{{ targetsText(t) }}</span>
                    </div>
                    <div class="g-timer-actions">
                      <button class="g-timer-btn" @click="startEditTask(i)">编辑</button>
                      <button class="g-timer-btn danger" :disabled="isProtectedTask(t)" :title="isProtectedTask(t) ? '内置系统任务不可删除' : ''" @click="removeTask(i)">删除</button>
                    </div>
                  </div>
                  <div v-if="gTasks.length === 0" class="g-timer-empty">暂无任务</div>
                </div>
              </div>

              <!-- 会话回放（M21/D14：轨迹回放布尔开关） -->
              <div v-else-if="selectedNode === 'sys.session'" class="g-session">
                <div class="g-timer-head">
                  <div>
                    <div class="g-timer-title">会话回放</div>
                    <div class="g-timer-desc">控制 Agent 回看自己的历史对话时，是否保留自己当时的工具调用轨迹（思考与工具结果对）。</div>
                  </div>
                </div>
                <label class="g-session-item">
                  <input
                    type="checkbox"
                    :checked="replayTrajectory"
                    @change="setReplayTrajectory(($event.target as HTMLInputElement).checked)"
                  />
                  <span class="g-session-text">
                    <span class="g-session-name">轨迹回放（session.replayTrajectory）</span>
                    <span class="g-session-desc">
                      关（缺省）= 对话级回放：只保留每轮最终回复，成本最优。
                      开 = 质量优先：Agent 跨轮记住自己的工具轨迹、少重复调用，但历史轮边界的缓存命中会失效、token 消耗略增。
                      仅影响 Agent 自己的视角（他方发言恒为对话级）。翻转后从下一轮起生效。
                    </span>
                  </span>
                </label>
              </div>
            </template>
          </div>
        </div>

        <!-- Footer -->
        <div class="sp-footer">
          <div class="sp-footer-left">
            <span v-if="errorText" class="sp-error">{{ errorText }}</span>
            <span v-if="successMsg" class="sp-success">{{ successMsg }}</span>
            <span v-else-if="isDirty && !errorText" class="sp-hint">有未保存的更改</span>
            <button
              class="sp-restart-minor" :disabled="restarting"
              @click="requestRestart" title="完全重启后端（会中断所有进行中的任务，几秒后自动恢复）"
            >{{ restarting ? '正在重启…' : '重启后端' }}</button>
          </div>
          <div class="sp-footer-actions">
            <Button variant="ghost" @click="requestClose()">关闭</Button>
            <Button variant="primary" :disabled="saving" @click="saveAll">{{ saving ? '保存中...' : '保存配置' }}</Button>
          </div>
        </div>

        <!-- 全局定时任务编辑弹窗 -->
        <!-- 全局定时任务编辑弹窗（ui/Modal 统一外壳） -->
        <Modal :visible="gTaskEditing" :title="gTaskEditIdx !== null ? '编辑定时任务' : '新建定时任务'" :width="440" :z-index="1200" @close="gTaskEditing = false">
          <div class="sp-modal-body">
            <div class="sp-field">
              <label>时间（HH:mm）</label>
              <input v-model="gTaskDraft.time" type="text" class="sp-input" placeholder="08:30" />
            </div>
            <div class="sp-field">
              <label>任务类型</label>
              <div class="sp-desc">系统任务为纯机制操作（不走 LLM）；自定义任务为报时提醒</div>
              <select v-model="gTaskType" class="sp-input" :disabled="gTaskBuiltin">
                <option value="custom">自定义报时</option>
                <option value="__archive_all__">全局归档（系统）</option>
                <option value="__backup_all__">数据备份（系统）</option>
              </select>
            </div>
            <template v-if="gTaskType === 'custom'">
              <div class="sp-field">
                <label>提示内容</label>
                <div class="sp-desc">留空则使用默认报时文本。占位符：&#123;&#123;now&#125;&#125; / &#123;&#123;time&#125;&#125; / &#123;&#123;date&#125;&#125;</div>
                <textarea v-model="gTaskDraft.hint" class="sp-textarea" rows="3" placeholder="现在是 {{now}}，巡检提醒..."></textarea>
              </div>
            </template>
            <template v-else>
              <div class="sp-field">
                <label>机制说明</label>
                <div class="sp-desc">{{ specialHint(gTaskType)?.desc }}</div>
                <div class="sp-sys-fixed">hint 固定为 <code>{{ gTaskType }}</code>，{{ gTaskBuiltin ? '仅可调整时间与目标' : '保存后仍可删除或改回自定义' }}</div>
              </div>
            </template>
            <div class="sp-field">
              <label>目标 Agent</label>
              <div class="sp-desc">每行一个 Agent ID，留空 = 全部 Agent</div>
              <textarea v-model="gTaskTargetsText" class="sp-textarea" rows="3" placeholder="agent_chat_dev&#10;news"></textarea>
            </div>
            <div v-if="gTaskError" class="sp-error">{{ gTaskError }}</div>
          </div>
          <template #footer>
            <Button variant="ghost" @click="gTaskEditing = false">取消</Button>
            <Button variant="primary" @click="saveTask">保存</Button>
          </template>
        </Modal>

        <!-- 通用确认弹窗（未保存关闭 / 重启后端，替代原生 confirm） -->
        <ConfirmDialog ref="confirmRef" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ── Shell ── */
.sp-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.sp-panel {
  width: 82vw; max-width: 1100px; height: 82vh; max-height: 88vh;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: var(--shadow-panel);
  display: flex; flex-direction: column; overflow: hidden;
}

.sp-header { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.sp-accent { width: 4px; height: 14px; border-radius: 2px; background: var(--primary); flex-shrink: 0; }
.sp-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-1); }
.sp-subtitle { font-size: 11px; color: var(--text-3); }
.sp-dirty-badge { font-size: 10px; color: var(--warn); margin-left: 4px; }
.sp-close { margin-left: auto; background: none; border: none; color: var(--text-3); font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1; }
.sp-close:hover { color: var(--text-1); }

/* 注意：ChatView 非 scoped 的 .sp-body { padding:16px 20px } 会泄漏全局，
   这里显式 padding:0 覆盖（scoped 特异性更高） */
.sp-body { flex: 1; overflow: hidden; display: flex; padding: 0; }

/* ── 左侧树（星卡风格） ── */
.sp-sidebar {
  width: 200px; flex-shrink: 0; overflow-y: auto;
  border-right: 1px solid var(--line);
  padding: 12px 8px;
}
.sp-tree-group { margin-bottom: 2px; }
.sp-tree-cat {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 13px; font-weight: 600;
  color: var(--text-1); cursor: pointer; user-select: none;
  border-radius: var(--r-md);
  transition: background var(--dur-fast), color var(--dur-fast);
}
.sp-tree-cat:hover { background: var(--role-hover-bg); }
.sp-tree-cat:hover .sp-arrow { color: var(--primary); }
.sp-arrow { transition: transform .15s, color .15s, filter .15s; color: var(--text-3); flex-shrink: 0; }
.sp-arrow.open { transform: rotate(90deg); color: var(--primary); filter: drop-shadow(0 0 2px var(--primary)); }
.sp-tree-count {
  font-size: 10px; color: var(--text-3); margin-left: auto;
  background: var(--bg-hover); padding: 0 7px; border-radius: var(--r-full);
}
.sp-tree-leaf {
  padding: 6px 10px 6px 24px; font-size: 13px;
  color: var(--text-2); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-radius: var(--r-md); margin: 1px 0;
  border: 1px solid transparent;
  transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.sp-tree-leaf:hover { background: var(--role-hover-bg); color: var(--text-1); }
.sp-tree-leaf.active {
  background: var(--primary-light);
  color: var(--primary); font-weight: 500;
  border-color: color-mix(in srgb, var(--primary) 45%, transparent);
}
.sp-root-leaf { padding-left: 10px; }
.sp-tree-empty { padding: 4px 10px 4px 24px; font-size: 12px; color: var(--text-3); font-style: italic; }

/* ── 右侧内容 ── */
.sp-main { flex: 1; overflow-y: auto; }
/* 移除 sp-body 外层留白：内容组件根容器统一紧凑内边距（避免贴死面板边缘） */
.sp-main > * { padding: 12px 16px 12px; }
.sp-status { text-align: center; padding: 40px; color: var(--text-3); font-size: 14px; }

/* ── Footer ── */
.sp-footer { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--line); flex-shrink: 0; }
.sp-footer-left { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sp-restart-minor {
  padding: 2px 8px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-3); font-size: 11px; cursor: pointer;
  transition: all var(--dur-fast); margin-left: 4px;
}
.sp-restart-minor:hover:not(:disabled) { background: var(--role-active-bg); color: var(--warn); }
.sp-restart-minor:disabled { opacity: .5; cursor: not-allowed; }
.sp-error { color: var(--err); font-size: 12px; }
.sp-success { color: var(--ok); font-size: 12px; }
.sp-hint { color: var(--warn); font-size: 12px; }
.sp-footer-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* ── Agent 编辑 ── */
.agent-editor { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }

/* ── 全局定时任务 ── */
.g-timer { display: flex; flex-direction: column; gap: 12px; }
.g-timer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }

/* ── 会话回放（sys.session）── */
.g-session .g-session-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--border-color, #333); border-radius: 8px; cursor: pointer; margin-top: 12px; }
.g-session .g-session-item input { margin-top: 3px; }
.g-session .g-session-text { display: flex; flex-direction: column; gap: 4px; }
.g-session .g-session-name { font-weight: 600; }
.g-session .g-session-desc { font-size: 12px; opacity: 0.75; line-height: 1.6; }
.g-timer-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.g-timer-desc { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.g-timer-add { padding: 5px 14px; border: 1px solid var(--primary); border-radius: var(--r-md); background: transparent; color: var(--primary); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.g-timer-add:hover { background: var(--primary-light); }
.g-timer-list { display: flex; flex-direction: column; gap: 6px; }
.g-timer-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-surface);
}
.g-timer-info { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.g-timer-time { font-family: var(--font-mono); font-weight: 600; color: var(--primary); flex-shrink: 0; }
.g-timer-hint { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.g-timer-hint.is-sys { color: var(--primary); font-weight: 500; }
.g-timer-sys-badge { margin-left: 6px; font-size: 10px; padding: 2px 6px; border-radius: var(--r-full); background: var(--primary-light); color: var(--primary); flex-shrink: 0; vertical-align: 1px; }
.g-timer-targets { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
.g-timer-actions { display: flex; gap: 4px; flex-shrink: 0; }
.g-timer-btn { padding: 3px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; }
.g-timer-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.g-timer-btn.danger { color: var(--err); }
.g-timer-btn.danger:hover { border-color: var(--err); }
.g-timer-btn:disabled { opacity: .4; cursor: not-allowed; }
.g-timer-btn:disabled:hover { border-color: var(--line-strong); color: var(--err); }
.g-timer-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }

/* ── 弹窗 body（ui/Modal 外壳，内容区间距） ── */
.sp-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; }
.sp-field { display: flex; flex-direction: column; gap: 5px; }
.sp-field label { font-size: 12px; color: var(--text-2); }
.sp-desc { font-size: 11px; color: var(--text-3); }
.sp-input, .sp-textarea {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
}
.sp-input:focus, .sp-textarea:focus { outline: none; border-color: var(--input-focus); }
.sp-textarea { resize: vertical; font-family: var(--font-mono); }
.sp-sys-fixed { font-size: 11px; color: var(--text-3); background: var(--bg-hover); padding: 6px 10px; border-radius: var(--r-sm); }
.sp-sys-fixed code { font-family: var(--font-mono); color: var(--primary); }
.sp-field select.sp-input:disabled { opacity: .6; cursor: not-allowed; }

.modal-enter-active, .modal-leave-active { transition: opacity .2s ease; }
.modal-enter-active .sp-panel, .modal-leave-active .sp-panel { transition: transform .2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .sp-panel { transform: scale(.96) translateY(8px); }
.modal-leave-to .sp-panel { transform: scale(.96) translateY(8px); }
</style>
