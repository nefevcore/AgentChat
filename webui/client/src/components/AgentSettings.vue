<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import type { AgentFullConfig, LLMConfig, PluginMeta } from '../types';
import { useAgentStore } from '../stores/agents';

const props = defineProps<{
  agentId: string;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const agentStore = useAgentStore();

// ── 状态 ──
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const successMsg = ref('');

const config = ref<AgentFullConfig>({ agent_id: '', name: '' });
const sysContent = ref('');
const agentContent = ref('');
const sysEnabled = ref(false);
const agentEnabled = ref(false);

const plugins = ref<PluginMeta[]>([]);

// ── 树状导航 ──
const expanded = reactive<Record<string, boolean>>({ 扩展: true, 工具: true });
const searchQuery = ref('');
const selectedNode = ref('agent');

type TreeNode = { id: string; label: string; type: 'category' | 'leaf'; children?: TreeNode[] };

function pluginLabel(name: string): string {
  return plugins.value.find(p => p.name === name)?.label || name;
}

const tree = computed<TreeNode[]>(() => {
  const allExts = [...enabledPreHooks.value, ...enabledPostHooks.value];
  const extNames = new Set(allExts);
  const sorted = allExts.includes('agent-prompt')
    ? ['agent-prompt', ...[...extNames].filter(n => n !== 'agent-prompt')]
    : [...extNames];
  const extChildren = sorted.map(name => ({
    id: `extension.${name}`, label: pluginLabel(name), type: 'leaf' as const,
  }));
  const toolChildren = enabledTools.value.map(name => ({
    id: `tool.${name}`, label: pluginLabel(name), type: 'leaf' as const,
  }));
  return [
    { id: 'agent', label: 'Agent设置', type: 'leaf' as const },
    { id: 'llm', label: '模型', type: 'leaf' as const },
    { id: 'extensions', label: '扩展', type: 'category' as const, children: extChildren },
    { id: 'tools', label: '工具', type: 'category' as const, children: toolChildren },
  ].filter(n => n.type === 'leaf' || (n.children && n.children.length > 0));
});

function selectNode(id: string) {
  selectedNode.value = id;
  searchQuery.value = '';
}

const selectedNodeType = computed(() => {
  if (selectedNode.value === 'agent') return 'agent';
  if (selectedNode.value === 'llm') return 'llm';
  if (selectedNode.value.startsWith('extension.')) return 'extension';
  if (selectedNode.value.startsWith('tool.')) return 'tool';
  return 'agent';
});

const selectedNodeName = computed(() => {
  if (selectedNodeType.value === 'extension') return selectedNode.value.replace('extension.', '');
  if (selectedNodeType.value === 'tool') return selectedNode.value.replace('tool.', '');
  return '';
});

const currentTitle = computed(() => {
  for (const node of tree.value) {
    if (node.id === selectedNode.value) return node.label;
    if (node.children) {
      const child = node.children.find(c => c.id === selectedNode.value);
      if (child) return `${node.label} › ${child.label}`;
    }
  }
  return '';
});

// ── 派生 ──
const enabledPreHooks = computed(() => config.value.pre_hooks ?? []);
const enabledPostHooks = computed(() => config.value.post_hooks ?? []);
const enabledTools = computed(() => config.value.tools ?? []);

// 如果当前选中的扩展/工具被移除，切回 agent
watch([enabledPreHooks, enabledPostHooks, enabledTools], () => {
  if (selectedNodeType.value === 'extension') {
    const name = selectedNodeName.value;
    const exists = enabledPreHooks.value.includes(name) || enabledPostHooks.value.includes(name);
    if (!exists) selectedNode.value = 'agent';
  }
  if (selectedNodeType.value === 'tool') {
    if (!enabledTools.value.includes(selectedNodeName.value)) selectedNode.value = 'agent';
  }
});

const availablePreHooks = computed(() => plugins.value.filter(p => p.type === 'pre_hook'));
const availablePostHooks = computed(() => plugins.value.filter(p => p.type === 'post_hook'));
const availableTools = computed(() => plugins.value.filter(p => p.type === 'tool'));

const unusedPreHooks = computed(() => availablePreHooks.value.filter(p => !enabledPreHooks.value.includes(p.name)));
const unusedPostHooks = computed(() => availablePostHooks.value.filter(p => !enabledPostHooks.value.includes(p.name)));
const unusedTools = computed(() => availableTools.value.filter(p => !enabledTools.value.includes(p.name) && p.name !== 'list_agents' && p.name !== 'send_agent'));

// agent-prompt 始终排最前
function sortHooksFirst(list: string[], pinned: string): string[] {
  const idx = list.indexOf(pinned);
  if (idx <= 0) return list;
  return [pinned, ...list.filter(h => h !== pinned)];
}
const sortedPreHooks = computed(() => sortHooksFirst(enabledPreHooks.value, 'agent-prompt'));
const sortedPostHooks = computed(() => sortHooksFirst(enabledPostHooks.value, 'agent-prompt'));

// ── LLM ──
const llmConfig = computed(() => config.value.llm ?? ({} as LLMConfig));
const llmSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string }>>>({});
const showSecrets = reactive<Record<string, boolean>>({});

const currentLLMSchema = computed(() => {
  const provider = (llmConfig.value.provider || 'deepseek') as string;
  return buildSchema((llmSchemas.value || {})[provider]);
});

const llmProvider = computed({
  get: () => llmConfig.value.provider ?? '',
  set: (val: string) => {
    if (!val) {
      config.value.llm = undefined;
    } else {
      const schema = (llmSchemas.value || {})[val];
      const defaults: Record<string, any> = {};
      if (schema) for (const [k, v] of Object.entries(schema)) { if (v.default !== undefined) defaults[k] = v.default; }
      config.value.llm = { ...defaults, provider: val } as LLMConfig;
    }
  },
}) as any;

const llmFilteredFields = computed(() => {
  if (!searchQuery.value.trim()) return currentLLMSchema.value;
  const q = searchQuery.value.toLowerCase();
  return currentLLMSchema.value.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
});

function updateLLM(patch: Partial<LLMConfig>) {
  config.value.llm = { ...(config.value.llm ?? {} as LLMConfig), ...patch };
}

function getLLMValue(key: string): any { return llmConfig.value[key as keyof LLMConfig]; }
function setLLMValue(key: string, value: any) { updateLLM({ [key]: value } as any); }

/** 判断配置项当前值与 schema 默认值是否不一致 */
function isNonDefault(f: { key: string; default?: unknown }): boolean {
  if (selectedNodeType.value === 'agent') return isValNonDefault(getLLMValue(f.key), f.default);
  if (selectedNodeType.value === 'extension') return isValNonDefault(getNsConfig('extension.' + nsName(selectedNodeName.value))?.[f.key], f.default);
  if (selectedNodeType.value === 'tool') return isValNonDefault(getNsConfig('tool.' + selectedNodeName.value)?.[f.key], f.default);
  return false;
}
function isValNonDefault(val: any, def: unknown): boolean {
  if (def === undefined || def === null) return val !== undefined && val !== null && val !== '';
  if (val === undefined || val === null) return false;
  return JSON.stringify(val) !== JSON.stringify(def);
}

/** 恢复字段为默认值 */
function resetToDefault(f: { key: string; default?: unknown }) {
  if (selectedNodeType.value === 'agent') {
    setLLMValue(f.key, f.default);
  } else if (selectedNodeType.value === 'extension') {
    updateNsConfig('extension.' + nsName(selectedNodeName.value), { [f.key]: f.default });
  } else if (selectedNodeType.value === 'tool') {
    updateNsConfig('tool.' + selectedNodeName.value, { [f.key]: f.default });
  }
}

// ── 扩展 / 工具 Schema ──
const extSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});
const toolSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});

function buildSchema(raw: Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; sensitive?: boolean; accept?: string }> | undefined) {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([k]) => k !== '_label')
    .map(([k, v]) => ({ key: k, label: v.label || k, description: v.description || '', type: v.type, options: v.options, sensitive: v.sensitive, default: v.default, accept: v.accept }));
}

// 扩展/工具配置 filtered
const currentExtFields = computed(() => {
  if (selectedNodeType.value !== 'extension') return [];
  const schema = buildSchema(extSchemas.value[nsName(selectedNodeName.value)]);
  if (!searchQuery.value.trim()) return schema;
  const q = searchQuery.value.toLowerCase();
  return schema.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
});

const currentToolFields = computed(() => {
  if (selectedNodeType.value !== 'tool') return [];
  const schema = buildSchema(toolSchemas.value[selectedNodeName.value]);
  if (!searchQuery.value.trim()) return schema;
  const q = searchQuery.value.toLowerCase();
  return schema.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
});

// ── 加载 ──
async function loadConfig() {
  if (!props.agentId) return;
  loading.value = true;
  error.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/config`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    config.value = data.config ?? { agent_id: props.agentId, name: props.agentId };
    sysContent.value = data.sysContent ?? '';
    sysEnabled.value = (data.sysContent ?? '').trim().length > 0;
    agentContent.value = data.agentContent ?? '';
    agentEnabled.value = (data.agentContent ?? '').trim().length > 0;
    initAvatarPreview();
    loadPlugins();
  } catch (err: any) {
    error.value = `加载配置失败: ${err.message}`;
  } finally {
    loading.value = false;
  }
}

async function loadPlugins() {
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(props.agentId)}`);
    if (resp.ok) { const data = await resp.json(); plugins.value = data.plugins ?? []; }
  } catch { /* ignore */ }
  try {
    const resp = await fetch(`/api/plugins/schemas`);
    if (resp.ok) { const data = await resp.json(); extSchemas.value = data.extensions ?? {}; toolSchemas.value = data.tools ?? {}; }
  } catch { /* ignore */ }
  try {
    const resp = await fetch(`/api/plugins/llm-schemas`);
    if (resp.ok) { llmSchemas.value = await resp.json(); }
  } catch { /* ignore */ }
}

// ── 保存 ──
async function saveConfig() {
  saving.value = true;
  error.value = '';
  successMsg.value = '';
  try {
    // 先上传头像（如有待上传文件）
    if (pendingAvatarFile) {
      const ok = await uploadAvatar();
      if (!ok) { saving.value = false; return; }
    }

    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: config.value,
        sysContent: sysEnabled.value ? sysContent.value : '',
        agentContent: agentEnabled.value ? agentContent.value : '',
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.success) {
      successMsg.value = '配置已保存，重启后生效';
      // 刷新 Agent 列表以更新头像等信息
      agentStore.requestAgents();
      emit('saved');
      setTimeout(() => { successMsg.value = ''; }, 3000);
    } else {
      error.value = data.error ?? '保存失败';
    }
  } catch (err: any) {
    error.value = `保存失败: ${err.message}`;
  } finally {
    saving.value = false;
  }
}

// ── 钩子/工具 管理 ──
function enableHook(type: 'pre_hooks' | 'post_hooks' | 'tools', name: string) {
  const arr = config.value[type] ?? [];
  if (!arr.includes(name)) config.value[type] = [...arr, name];
}
function disableHook(type: 'pre_hooks' | 'post_hooks' | 'tools', name: string) {
  config.value[type] = (config.value[type] ?? []).filter(n => n !== name);
}

const dragType = ref<'pre_hooks' | 'post_hooks' | 'tools' | ''>('');
const dragIndex = ref(-1);
function onDragStart(type: 'pre_hooks' | 'post_hooks' | 'tools', idx: number) { dragType.value = type; dragIndex.value = idx; }
function onDragOver(e: DragEvent) { e.preventDefault(); }
function onDrop(type: 'pre_hooks' | 'post_hooks' | 'tools', targetIdx: number) {
  if (dragType.value !== type || dragIndex.value === targetIdx) return;
  const arr = [...(config.value[type] ?? [])];
  const [item] = arr.splice(dragIndex.value, 1);
  arr.splice(targetIdx, 0, item);
  config.value[type] = arr;
  resetDrag();
}
function resetDrag() { dragType.value = ''; dragIndex.value = -1; }

// ── ns 配置 helper ──
function getNsConfig(key: string): Record<string, unknown> { return (config.value as any)[key] ?? {}; }
function updateNsConfig(key: string, patch: Record<string, unknown>) { (config.value as any)[key] = { ...(getNsConfig(key)), ...patch }; }
function updateNsConfigRaw(key: string, raw: string) { try { (config.value as any)[key] = JSON.parse(raw); } catch { /* ignore */ } }

function nsName(name: string): string { return name.replace(/-/g, '_'); }
function hookLabel(name: string): string { const p = plugins.value.find(p => p.name === name); return p?.label || ''; }
function hookDesc(name: string): string { const p = plugins.value.find(p => p.name === name); return p?.description || ''; }

function parseNum(val: any): any { const n = Number(val); return isNaN(n) ? val : n; }

// ── 头像上传 ──
const avatarPreviewUrl = ref<string | null>(null);
const avatarUploading = ref(false);
const avatarError = ref('');
let pendingAvatarFile: File | null = null;

/** 初始化头像预览（从 API 加载） */
function initAvatarPreview() {
  avatarPreviewUrl.value = `/api/agents/${encodeURIComponent(props.agentId)}/avatar?t=${Date.now()}`;
}

async function onAvatarFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    avatarError.value = '文件大小不能超过 2MB';
    return;
  }
  avatarError.value = '';
  pendingAvatarFile = file;
  // 本地预览
  avatarPreviewUrl.value = URL.createObjectURL(file);
}

async function uploadAvatar(): Promise<boolean> {
  if (!pendingAvatarFile) return true; // 无变更
  avatarUploading.value = true;
  avatarError.value = '';
  try {
    const form = new FormData();
    form.append('file', pendingAvatarFile);
    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/avatar`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || '上传失败');
    }
    pendingAvatarFile = null;
    return true;
  } catch (err: any) {
    avatarError.value = `头像上传失败: ${err.message}`;
    return false;
  } finally {
    avatarUploading.value = false;
  }
}

async function removeAvatar() {
  avatarError.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/avatar`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || '删除失败');
    }
    avatarPreviewUrl.value = null;
    pendingAvatarFile = null;
    // 刷新 Agent 列表以更新头像
    agentStore.requestAgents();
  } catch (err: any) {
    avatarError.value = `删除头像失败: ${err.message}`;
  }
}

// ── 文件选择 ──
const browsing = ref(false);
async function browseFile(f: { key: string; accept?: string; type: string }) {
  if (browsing.value) return;
  browsing.value = true;
  try {
    const resp = await fetch('/api/browse/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: f.accept, title: `选择 ${f.key === 'mcpFile' ? 'MCP 配置文件' : '文件'}` }),
    });
    const data = await resp.json();
    if (data.success && data.path) {
      const nsPrefix = selectedNodeType.value === 'tool' ? 'tool.' : 'extension.';
      const nsKey = selectedNodeType.value === 'tool' ? selectedNodeName.value : nsName(selectedNodeName.value);
      updateNsConfig(nsPrefix + nsKey, { [f.key]: data.path });
    }
  } catch (err: any) {
    console.warn('[browseFile] 文件选择失败:', err.message);
  } finally {
    browsing.value = false;
  }
}

watch(() => [props.agentId, props.visible] as const, ([id, vis]) => {
  if (id && vis) { selectedNode.value = 'agent'; loadConfig(); }
});
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="settings-overlay" @mousedown.self="emit('close')">
      <div class="settings-panel" @click.stop>
        <!-- Header -->
        <div class="panel-header">
          <h3>Agent 配置</h3>
          <span class="agent-label">{{ agentId }}</span>
          <span v-if="currentTitle" class="panel-subtitle">{{ currentTitle }}</span>
          <button class="close-btn" @click="emit('close')" title="关闭">×</button>
        </div>

        <div class="panel-body">
          <!-- 左侧树 -->
          <div class="settings-sidebar">
            <div v-for="node in tree" :key="node.id" class="tree-group">
              <template v-if="node.type === 'category'">
                <div class="tree-category" @click="expanded[node.id] = !expanded[node.id]">
                  <svg class="tree-arrow" :class="{ open: expanded[node.id] }" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <span>{{ node.label }}</span>
                  <span class="tree-count">{{ node.children?.length }}</span>
                </div>
                <div v-if="expanded[node.id]" class="tree-children">
                  <div
                    v-for="child in node.children" :key="child.id"
                    class="tree-leaf" :class="{ active: selectedNode === child.id }"
                    @click="selectNode(child.id)"
                  >{{ child.label }}</div>
                  <div v-if="!node.children?.length" class="tree-empty">无</div>
                </div>
              </template>
              <div
                v-else class="tree-leaf root-leaf" :class="{ active: selectedNode === node.id }"
                @click="selectNode(node.id)"
              >{{ node.label }}</div>
            </div>
          </div>

          <!-- 右侧内容 -->
          <div class="settings-main">
            <div v-if="loading" class="status-msg">加载中...</div>

            <template v-else>
              <!-- ====== Agent设置 ====== -->
              <template v-if="selectedNodeType === 'agent'">
                <!-- Agent ID -->
                <div class="setting-item">
                  <div class="setting-label">Agent ID</div>
                  <div class="setting-desc">Agent ID 创建后不可修改</div>
                  <div class="setting-control">
                    <input type="text" class="form-input" :value="config.agent_id" disabled />
                  </div>
                </div>

                <!-- 昵称 -->
                <div class="setting-item">
                  <div class="setting-label">昵称</div>
                  <div class="setting-control">
                    <input v-model="config.name" type="text" class="form-input" placeholder="输入 Agent 昵称" />
                  </div>
                </div>

                <!-- 头像 -->
                <div class="setting-item">
                  <div class="setting-label">头像</div>
                  <div class="setting-desc">支持 PNG / JPG / WebP / SVG，最大 2MB</div>
                  <div class="setting-control">
                    <div class="avatar-upload-row">
                      <!-- 预览 -->
                      <div class="avatar-preview-lg">
                        <img v-if="avatarPreviewUrl" :src="avatarPreviewUrl" :alt="config.name" @load="($event.target as HTMLImageElement).style.display=''" @error="($event.target as HTMLImageElement).style.display='none'" />
                        <span class="avatar-preview-placeholder">{{ (config.name || agentId).charAt(0).toUpperCase() }}</span>
                      </div>
                      <div class="avatar-upload-actions">
                        <label class="upload-btn">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          <span>上传图片</span>
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" @change="onAvatarFileChange" hidden />
                        </label>
                        <button v-if="avatarPreviewUrl" class="remove-avatar-btn" @click="removeAvatar" title="移除头像">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          <span>移除头像</span>
                        </button>
                      </div>
                    </div>
                    <div v-if="avatarUploading" class="upload-status">上传中...</div>
                    <div v-if="avatarError" class="error-text">{{ avatarError }}</div>
                  </div>
                </div>

                <!-- SYSTEM.md -->
                <div class="setting-item">
                  <div class="setting-label">SYSTEM.md</div>
                  <div class="setting-desc">覆盖 agent-prompt 装配的系统提示词</div>
                  <div class="setting-control">
                    <label class="toggle-label">
                      <input type="checkbox" v-model="sysEnabled" />
                      <span class="toggle-text">启用自定义内容</span>
                    </label>
                    <textarea v-if="sysEnabled" v-model="sysContent" class="form-textarea code" rows="8" placeholder="输入 SYSTEM.md 内容..."></textarea>
                  </div>
                </div>

                <!-- AGENT.md -->
                <div class="setting-item">
                  <div class="setting-label">AGENT.md</div>
                  <div class="setting-desc">定义 Agent 的角色、行为和能力边界</div>
                  <div class="setting-control">
                    <label class="toggle-label">
                      <input type="checkbox" v-model="agentEnabled" />
                      <span class="toggle-text">启用自定义内容</span>
                    </label>
                    <textarea v-if="agentEnabled" v-model="agentContent" class="form-textarea code" rows="8" placeholder="输入 AGENT.md 内容..."></textarea>
                  </div>
                </div>

                <!-- 前置钩子 -->
                <div class="setting-item">
                  <div class="setting-label">前置钩子</div>
                  <div class="setting-desc">在 Agent 处理请求前依次执行</div>
                  <div class="setting-control">
                    <div v-if="enabledPreHooks.length === 0" class="hint-text">暂无启用的前置钩子</div>
                    <div
                      v-for="(name, idx) in sortedPreHooks" :key="'pre-'+name"
                      class="hook-item"
                      :class="{ 'locked': name === 'agent-prompt', 'drag-over': dragType === 'pre_hooks' && dragIndex !== idx }"
                      :draggable="name !== 'agent-prompt'"
                      @dragstart="name !== 'agent-prompt' && onDragStart('pre_hooks', idx)"
                      @dragover="onDragOver"
                      @drop="onDrop('pre_hooks', idx)"
                      @dragend="resetDrag"
                    >
                      <span v-if="name === 'agent-prompt'" class="lock-icon" title="内置扩展，不可移动"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
                      <span v-else class="drag-handle" title="拖动排序"><svg width="12" height="12" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></span>
                      <span class="hook-label">{{ hookLabel(name) }}</span>
                      <span class="hook-name">{{ name }}</span>
                      <span class="hook-desc">{{ hookDesc(name) }}</span>
                      <button class="remove-btn" @click.stop="disableHook('pre_hooks', name)" title="移除"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                    </div>
                    <select v-if="unusedPreHooks.length" class="add-select" @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { enableHook('pre_hooks', v); (e.target as HTMLSelectElement).value = ''; } }">
                      <option value="">+ 添加前置钩子...</option>
                      <option v-for="p in unusedPreHooks" :key="'pre-'+p.name" :value="p.name">{{ p.name }} — {{ p.description }}</option>
                    </select>
                  </div>
                </div>

                <!-- 后置钩子 -->
                <div class="setting-item">
                  <div class="setting-label">后置钩子</div>
                  <div class="setting-desc">在 Agent 完成响应后依次执行</div>
                  <div class="setting-control">
                    <div v-if="enabledPostHooks.length === 0" class="hint-text">暂无启用的后置钩子</div>
                    <div
                      v-for="(name, idx) in sortedPostHooks" :key="'post-'+name"
                      class="hook-item"
                      :class="{ 'locked': name === 'agent-prompt', 'drag-over': dragType === 'post_hooks' && dragIndex !== idx }"
                      :draggable="name !== 'agent-prompt'"
                      @dragstart="name !== 'agent-prompt' && onDragStart('post_hooks', idx)"
                      @dragover="onDragOver"
                      @drop="onDrop('post_hooks', idx)"
                      @dragend="resetDrag"
                    >
                      <span v-if="name === 'agent-prompt'" class="lock-icon" title="内置扩展，不可移动"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
                      <span v-else class="drag-handle" title="拖动排序"><svg width="12" height="12" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></span>
                    <span class="hook-label">{{ hookLabel(name) }}</span>
                    <span class="hook-name">{{ name }}</span>
                    <span class="hook-desc">{{ hookDesc(name) }}</span>
                    <button class="remove-btn" @click.stop="disableHook('post_hooks', name)" title="移除"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                  </div>
                    <select v-if="unusedPostHooks.length" class="add-select" @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { enableHook('post_hooks', v); (e.target as HTMLSelectElement).value = ''; } }">
                      <option value="">+ 添加后置钩子...</option>
                      <option v-for="p in unusedPostHooks" :key="'post-'+p.name" :value="p.name">{{ p.name }} — {{ p.description }}</option>
                    </select>
                  </div>
                </div>

                <!-- 工具 -->
                <div class="setting-item">
                  <div class="setting-label">工具</div>
                  <div class="setting-desc">Agent 可调用的工具列表</div>
                  <div class="setting-control">
                    <div v-if="enabledTools.length === 0" class="hint-text">暂无启用的工具</div>
                  <div
                    v-for="(name, idx) in enabledTools" :key="'tool-'+name"
                    class="hook-item"
                    :class="{ 'drag-over': dragType === 'tools' && dragIndex !== idx }"
                    :draggable="true"
                    @dragstart="onDragStart('tools', idx)"
                    @dragover="onDragOver"
                    @drop="onDrop('tools', idx)"
                    @dragend="resetDrag"
                  >
                    <span class="drag-handle" title="拖动排序"><svg width="12" height="12" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></span>
                    <span class="hook-label">{{ hookLabel(name) }}</span>
                    <span class="hook-name">{{ name }}</span>
                    <span class="hook-desc">{{ hookDesc(name) }}</span>
                    <button class="remove-btn" @click.stop="disableHook('tools', name)" title="移除"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                  </div>
                    <select v-if="unusedTools.length" class="add-select" @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v) { enableHook('tools', v); (e.target as HTMLSelectElement).value = ''; } }">
                      <option value="">+ 添加工具...</option>
                      <option v-for="p in unusedTools" :key="'tool-'+p.name" :value="p.name">{{ p.name }} — {{ p.description }}</option>
                    </select>
                  </div>
                </div>
              </template>

              <!-- ====== 模型 ====== -->
              <template v-else-if="selectedNodeType === 'llm'">
                <!-- 搜索 -->
                <div class="search-box">
                  <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input v-model="searchQuery" class="search-input" placeholder="搜索模型设置" />
                </div>

                <div class="setting-item">
                  <div class="setting-label">选择模型</div>
                  <div class="setting-desc">选择空值时默认使用全局模型设置</div>
                  <div class="setting-control">
                    <select class="form-select" :value="llmProvider" @change="llmProvider = ($event.target as HTMLSelectElement).value as any">
                      <option value="">使用全局模型配置</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="openai">OpenAI</option>
                      <option value="ollama">Ollama</option>
                    </select>
                  </div>
                </div>

                <template v-if="llmProvider">
                  <div class="settings-list">
                    <div v-for="f in llmFilteredFields" :key="f.key" class="setting-item" :class="{ 'non-default': isNonDefault(f) }">
                      <div class="setting-label">{{ f.label }}</div>
                      <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                      <div class="setting-control">
                        <template v-if="f.type === 'checkbox'">
                          <label class="toggle-label">
                            <input type="checkbox" :checked="getLLMValue(f.key) !== false" @change="setLLMValue(f.key, ($event.target as HTMLInputElement).checked)" />
                            <span class="toggle-text">{{ f.label }}</span>
                          </label>
                        </template>
                        <template v-else-if="f.type === 'select'">
                          <select class="form-select" :value="getLLMValue(f.key) ?? f.options?.[0]" @change="setLLMValue(f.key, ($event.target as HTMLSelectElement).value)">
                            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                          </select>
                        </template>
                        <template v-else-if="f.type === 'number'">
                          <input type="number" class="form-input short" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, parseFloat(($event.target as HTMLInputElement).value) || undefined)" />
                        </template>
                        <template v-else-if="f.type === 'password'">
                          <div class="secret-input-wrap">
                            <input :type="showSecrets[f.key] ? 'text' : 'password'" class="form-input secret-input" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, ($event.target as HTMLInputElement).value)" />
                            <button class="eye-toggle" @mousedown.prevent="showSecrets[f.key] = true" @mouseup.prevent="showSecrets[f.key] = false" @mouseleave="showSecrets[f.key] = false" :title="showSecrets[f.key] ? '隐藏' : '按住显示'">
                              <svg v-if="!showSecrets[f.key]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                            </button>
                          </div>
                        </template>
                        <template v-else>
                          <input type="text" class="form-input" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, ($event.target as HTMLInputElement).value)" />
                        </template>
                        <button v-if="isNonDefault(f)" class="reset-btn" title="恢复默认值" @click="resetToDefault(f)">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      </div>
                    </div>
                    <div v-if="llmFilteredFields.length === 0" class="status-msg">未找到匹配的设置</div>
                  </div>
                </template>
              </template>

              <!-- ====== 扩展配置 ====== -->
              <template v-else-if="selectedNodeType === 'extension'">
                <div class="search-box">
                  <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input v-model="searchQuery" class="search-input" placeholder="搜索配置" />
                </div>

                <template v-if="currentExtFields.length > 0">
                  <div class="settings-list">
                    <div v-for="f in currentExtFields" :key="f.key" class="setting-item" :class="{ 'non-default': isNonDefault(f) }">
                      <div class="setting-label">{{ f.label }}</div>
                      <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                      <div class="setting-control">
                        <template v-if="f.type === 'checkbox'">
                          <label class="toggle-label">
                            <input type="checkbox" :checked="getNsConfig('extension.' + nsName(selectedNodeName))[f.key] !== false" @change="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: ($event.target as HTMLInputElement).checked })" />
                            <span class="toggle-text">{{ f.label }}</span>
                          </label>
                        </template>
                        <template v-else-if="f.type === 'select' && f.options">
                          <select class="form-select" :value="getNsConfig('extension.' + nsName(selectedNodeName))[f.key] ?? f.options[0]" @change="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: ($event.target as HTMLSelectElement).value })">
                            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                          </select>
                        </template>
                        <template v-else-if="f.type === 'number'">
                          <input type="number" class="form-input short" :value="parseNum(getNsConfig('extension.' + nsName(selectedNodeName))[f.key])" @input="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: parseNum(($event.target as HTMLInputElement).value) })" />
                        </template>
                        <template v-else-if="f.type === 'file'">
                          <div class="file-input-wrap">
                            <input type="text" class="form-input" :value="getNsConfig('extension.' + nsName(selectedNodeName))[f.key] ?? ''" @input="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: ($event.target as HTMLInputElement).value })" placeholder="输入路径或点击选择文件..." />
                            <button class="browse-btn" @click="browseFile(f)" title="选择文件">…</button>
                          </div>
                        </template>
                        <template v-else>
                          <input type="text" class="form-input" :value="getNsConfig('extension.' + nsName(selectedNodeName))[f.key] ?? ''" @input="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: ($event.target as HTMLInputElement).value })" />
                        </template>
                        <button v-if="isNonDefault(f)" class="reset-btn" title="恢复默认值" @click="resetToDefault(f)">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div class="config-raw">
                    <div class="setting-label">{{ selectedNodeName }} 配置 (JSON)</div>
                    <textarea class="form-textarea code" rows="6" :value="JSON.stringify(getNsConfig('extension.' + nsName(selectedNodeName)), null, 2)" @input="updateNsConfigRaw('extension.' + nsName(selectedNodeName), ($event.target as HTMLTextAreaElement).value)"></textarea>
                  </div>
                </template>
              </template>

              <!-- ====== 工具配置 ====== -->
              <template v-else-if="selectedNodeType === 'tool'">
                <div class="search-box">
                  <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input v-model="searchQuery" class="search-input" placeholder="搜索配置" />
                </div>

                <template v-if="currentToolFields.length > 0">
                  <div class="settings-list">
                    <div v-for="f in currentToolFields" :key="f.key" class="setting-item" :class="{ 'non-default': isNonDefault(f) }">
                      <div class="setting-label">{{ f.label }}</div>
                      <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                      <div class="setting-control">
                        <template v-if="f.type === 'select' && f.options">
                          <select class="form-select" :value="getNsConfig('tool.' + selectedNodeName)[f.key] ?? f.options[0]" @change="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLSelectElement).value })">
                            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                          </select>
                        </template>
                        <template v-else-if="f.type === 'number'">
                          <input type="number" class="form-input short" :value="parseNum(getNsConfig('tool.' + selectedNodeName)[f.key])" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: parseNum(($event.target as HTMLInputElement).value) })" />
                        </template>
                        <template v-else-if="f.type === 'file'">
                          <div class="file-input-wrap">
                            <input type="text" class="form-input" :value="getNsConfig('tool.' + selectedNodeName)[f.key] ?? ''" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLInputElement).value })" placeholder="输入路径或点击选择文件..." />
                            <button class="browse-btn" @click="browseFile(f)" title="选择文件">…</button>
                          </div>
                        </template>
                        <template v-else>
                          <input type="text" class="form-input" :value="getNsConfig('tool.' + selectedNodeName)[f.key] ?? ''" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLInputElement).value })" />
                        </template>
                        <button v-if="isNonDefault(f)" class="reset-btn" title="恢复默认值" @click="resetToDefault(f)">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div class="config-raw">
                    <div class="setting-label">{{ selectedNodeName }} 配置 (JSON)</div>
                    <textarea class="form-textarea code" rows="6" :value="JSON.stringify(getNsConfig('tool.' + selectedNodeName), null, 2)" @input="updateNsConfigRaw('tool.' + selectedNodeName, ($event.target as HTMLTextAreaElement).value)"></textarea>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <div class="footer-left">
            <span v-if="error" class="error-text">{{ error }}</span>
            <span v-if="successMsg" class="success-text">{{ successMsg }}</span>
          </div>
          <div class="footer-actions">
            <button class="btn-cancel" @click="emit('close')">关闭</button>
            <button class="btn-save" :disabled="saving || loading" @click="saveConfig">{{ saving ? '保存中...' : '保存配置' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 头像上传 */
.avatar-upload-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.avatar-preview-lg {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}

.avatar-preview-lg img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: relative;
  z-index: 1;
}

.avatar-preview-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 600;
  color: var(--color-primary, #4f46e5);
  user-select: none;
}

.avatar-upload-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--color-bg-hover, rgba(255,255,255,0.08));
  color: var(--color-text-primary, #fff);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.1));
}

.upload-btn:hover {
  background: var(--color-bg-active, rgba(255,255,255,0.14));
}

.remove-avatar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-tertiary, rgba(255,255,255,0.5));
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, background 0.15s;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
}

.remove-avatar-btn:hover {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.upload-status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-secondary, rgba(255,255,255,0.5));
}

/* ── Overlay & Panel ── */
.settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.settings-panel { background: var(--color-bg-primary, #fff); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 10px; width: 80vw; max-width: 95vw; height: 80vh; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }

/* ── Header ── */
.panel-header { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.agent-label { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); background: var(--color-bg-tertiary, #e8eaed); padding: 1px 7px; border-radius: 4px; }
.panel-subtitle { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin-left: 4px; }
.close-btn { margin-left: auto; background: none; border: none; color: var(--color-text-secondary, #7f8c8d); font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1; }
.close-btn:hover { color: var(--color-text-primary, #2c3e50); }

/* ── Body ── */
.panel-body { flex: 1; overflow: hidden; display: flex; }

/* ── Left sidebar ── */
.settings-sidebar {
  width: 180px; flex-shrink: 0; overflow-y: auto;
  border-right: 1px solid var(--color-border-secondary, #e0e0e0);
  padding: 8px 0;
}
.tree-group { margin-bottom: 2px; }
.tree-category {
  display: flex; align-items: center; gap: 4px;
  padding: 5px 12px; font-size: 13px; font-weight: 600;
  color: var(--color-text-primary, #2c3e50); cursor: pointer;
  user-select: none;
}
.tree-category:hover { color: var(--color-text-primary, #2c3e50); }
.tree-arrow { transition: transform 0.15s; color: var(--color-text-tertiary, #a8abb2); flex-shrink: 0; }
.tree-arrow.open { transform: rotate(90deg); }
.tree-count { font-size: 10px; color: var(--color-text-tertiary, #a8abb2); margin-left: auto; }
.tree-children { }
.tree-leaf {
  padding: 4px 12px 4px 28px; font-size: 13px;
  color: var(--color-text-primary, #2c3e50); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tree-leaf:hover { background: var(--color-bg-secondary, #f5f5f5); }
.tree-leaf.active { background: var(--color-primary-light, #ecf5ff); color: var(--color-primary, #3498db); font-weight: 500; }
.root-leaf { padding-left: 12px; }
.tree-empty { padding: 4px 12px 4px 28px; font-size: 12px; color: var(--color-text-tertiary, #a8abb2); font-style: italic; }

/* ── Right content ── */
.settings-main { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 0; }
.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }

/* Search */
.search-box { position: relative; display: flex; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); }
.search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary, #a8abb2); pointer-events: none; }
.search-input { width: 100%; padding: 6px 10px 6px 28px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 5px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; outline: none; }
.search-input:focus { border-color: var(--color-primary, #3498db); }
.search-input::placeholder { color: var(--color-text-tertiary, #a8abb2); }

/* Setting groups & items */
.settings-list { display: flex; flex-direction: column; gap: 2px; }
.setting-item { padding: 7px 12px; border-bottom: 1px solid var(--color-border-secondary, #f0f0f0); display: flex; flex-direction: column; gap: 6px; border-left: 3px solid transparent; }
.setting-item:last-child { border-bottom: none; }
.setting-item.non-default { border-left-color: var(--color-primary, #3498db); }
.setting-label { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #2c3e50); }
.setting-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.setting-desc { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }

/* Config raw (JSON fallback) */
.config-raw { display: flex; flex-direction: column; gap: 8px; }
.form-input, .form-select { padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; transition: border-color 0.15s; }
.form-input:focus, .form-select:focus { outline: none; border-color: var(--color-primary, #3498db); }
.form-input.short { width: 120px; }
.form-input:disabled { opacity: 0.5; cursor: not-allowed; background: var(--color-bg-tertiary, #f0f0f0); }
/* File browse */
.file-input-wrap { display: flex; align-items: center; gap: 4px; flex: 1; }
.file-input-wrap .form-input { flex: 1; }
.browse-btn {
  flex-shrink: 0; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px; background: var(--color-bg-primary, #fff);
  color: var(--color-text-secondary, #666); font-size: 16px;
  cursor: pointer; transition: all 0.15s; font-weight: 700; line-height: 1;
}
.browse-btn:hover { border-color: var(--color-primary, #3498db); color: var(--color-primary, #3498db); background: var(--color-primary-light, #ecf5ff); }
.form-hint { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }
.form-textarea { width: 100%; padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; resize: vertical; line-height: 1.5; transition: border-color 0.15s; }
.form-textarea:focus { outline: none; border-color: var(--color-primary, #3498db); }

/* Dividers & checkboxes */
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.toggle-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--color-primary, #3498db); }
.toggle-text { font-size: 13px; color: var(--color-text-primary, #2c3e50); }

/* Secret input */
.secret-input-wrap { position: relative; display: inline-flex; align-items: center; }
.secret-input { padding-right: 32px !important; width: 220px; }
.eye-toggle { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; line-height: 0; border-radius: 3px; }
.eye-toggle:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-tertiary, #e8eaed); }
.reset-btn { flex-shrink: 0; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 4px; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 0; margin-left: 2px; transition: all 0.15s; }
.reset-btn:hover { color: var(--color-primary, #3498db); border-color: var(--color-primary, #3498db); background: var(--color-primary-light, #ecf5ff); }

/* Hook / Tool list */
.hint-text { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); padding: 4px 0; }

.hook-item { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; cursor: grab; transition: background 0.15s, opacity 0.15s; margin-bottom: 1px; border: 1px solid transparent; }
.hook-item:active { cursor: grabbing; }
.hook-item:hover { background: var(--color-bg-secondary, #f8f9fa); }
.hook-item:hover .remove-btn { opacity: 1; }
.hook-item.locked { cursor: default; opacity: 0.85; }
.hook-item.locked:hover { background: transparent; }
.hook-item.drag-over { opacity: 0.4; }
.drag-handle { width: 14px; height: 18px; display: flex; align-items: center; justify-content: center; color: var(--color-text-tertiary, #ccc); cursor: grab; flex-shrink: 0; }
.lock-icon { width: 14px; height: 18px; display: flex; align-items: center; justify-content: center; color: var(--color-text-tertiary, #a8abb2); flex-shrink: 0; opacity: 0.5; }
.hook-label { width: 70px; font-size: 13px; font-weight: 600; color: var(--color-text-primary, #2c3e50); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.hook-name { width: 90px; font-size: 13px; font-weight: 400; color: var(--color-text-secondary, #7f8c8d); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.hook-desc { flex: 1; font-size: 13px; color: var(--color-text-tertiary, #a8abb2); word-break: break-word; }

.remove-btn { width: 18px; height: 18px; border: none; border-radius: 50%; background: transparent; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; }
.remove-btn:hover { background: #e74c3c; color: #fff; opacity: 1; }

.add-select { margin-top: 6px; width: 100%; padding: 6px; border: 1px dashed var(--color-border-secondary, #bdc3c7); border-radius: 6px; background: var(--color-bg-primary, #fff); color: var(--color-text-secondary, #7f8c8d); font-size: 12px; cursor: pointer; transition: border-color 0.15s; }
.add-select:focus { outline: none; border-color: var(--color-primary, #3498db); }
.add-select option { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-primary, #fff); }

/* ── Footer ── */
.panel-footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; border-top: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.footer-left { flex: 1; min-width: 0; }
.error-text { color: #e74c3c; font-size: 12px; }
.success-text { color: #27ae60; font-size: 12px; }
.footer-actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn-cancel, .btn-save { padding: 6px 16px; border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer; }
.btn-cancel { background: var(--color-bg-primary, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-cancel:hover { background: var(--color-bg-tertiary, #e8eaed); }
.btn-save { background: var(--color-primary, #3498db); border: none; color: #fff; }
.btn-save:hover:not(:disabled) { background: var(--color-primary-hover, #2980b9); }
.btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Transitions ── */
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-active .settings-panel, .modal-leave-active .settings-panel { transition: transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .settings-panel { transform: scale(0.95); }
.modal-leave-to .settings-panel { transform: scale(0.95); }
</style>
