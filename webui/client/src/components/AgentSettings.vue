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

// ── 定时任务 ──
interface TimerEntry {
  id: string;
  enabled: boolean;
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  time?: string;
  delay?: string;
  delayMin?: string;
  delayMax?: string;
  /** 重复次数：0=永久，N=N次 */
  repeatCount?: number;
  hint: string;
  target?: string;
  source?: string;
  maxTurns?: number;
}
const timerEntries = ref<TimerEntry[]>([]);
const editingTimer = ref<TimerEntry | null>(null);
const timerError = ref('');

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/** datetime-local 格式互转 */
function toDatetimeLocal(v?: string): string { if (!v) return ''; return v.replace(' ', 'T').slice(0, 16); }
function fromDatetimeLocal(v: string): string { return v.replace('T', ' '); }
function toDateOnly(v?: string): string { if (!v) return ''; return v.slice(0, 10); }
function toTimeOnly(v?: string): string { if (!v) return ''; return v.slice(11, 16) || v; }
function updateTimeDate(datePart: string, timePart: string): string {
  if (datePart && timePart) return `${datePart} ${timePart}`;
  return timePart || datePart;
}
function formatTimeLabel(t?: string): string {
  if (!t) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : `每天 ${t}`;
}

function addTimer() {
  editingTimer.value = { id: uid('timer'), enabled: true, mode: 'delay', delay: '1h', repeatCount: 1, hint: '', target: 'user' };
}

function editTimer(entry: TimerEntry) {
  editingTimer.value = { ...entry };
}

function removeTimer(id: string) {
  timerEntries.value = timerEntries.value.filter(e => e.id !== id);
}

function saveTimer() {
  if (!editingTimer.value) return;
  const e = editingTimer.value;
  const val = e.mode === 'time' ? e.time : e.delay;
  if (!val?.trim() || !e.hint.trim()) {
    timerError.value = '时间/间隔和提示内容不能为空';
    return;
  }
  const idx = timerEntries.value.findIndex(t => t.id === e.id);
  if (idx >= 0) timerEntries.value[idx] = { ...e };
  else timerEntries.value.push({ ...e });
  editingTimer.value = null;
  timerError.value = '';
}

async function saveTimers() {
  saving.value = true;
  timerError.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: timerEntries.value }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error((data as any).error || '保存失败');
    }
    const data = await resp.json();
    timerEntries.value = (data as any).entries || [];
    successMsg.value = '定时任务已保存';
    setTimeout(() => { successMsg.value = ''; }, 2000);
  } catch (e: any) {
    timerError.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function loadTimers() {
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/timer`);
    if (resp.ok) {
      const data = await resp.json();
      timerEntries.value = (data as any).entries || [];
    }
  } catch { /* ignore */ }
}

// ── 路径穿透白名单（多行文本 ↔ 数组） ──
const allowedPathsText = computed({
  get: () => (config.value.allowedPaths ?? []).join('\n'),
  set: (val: string) => {
    const lines = val.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    config.value.allowedPaths = lines.length > 0 ? lines : undefined;
  },
});

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
    { id: 'timer', label: '定时任务', type: 'leaf' as const },
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
  if (selectedNode.value === 'timer') return 'timer';
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
const unusedTools = computed(() => availableTools.value.filter(p => !enabledTools.value.includes(p.name) && !p.autoInject));

// agent-prompt 始终排最前
function sortHooksFirst(list: string[], pinned: string): string[] {
  const idx = list.indexOf(pinned);
  if (idx <= 0) return list;
  return [pinned, ...list.filter(h => h !== pinned)];
}
const sortedPreHooks = computed(() => sortHooksFirst(enabledPreHooks.value, 'agent-prompt'));
const sortedPostHooks = computed(() => sortHooksFirst(enabledPostHooks.value, 'agent-prompt'));

// ── LLM ──
const llmConfig = computed(() => {
  const raw = config.value.llm;
  if (!raw) return {} as LLMConfig;
  if (typeof raw === 'string') return { $ref: raw } as unknown as LLMConfig;
  return raw as LLMConfig;
});
const llmSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string }>>>({});
const llmPools = ref<Record<string, Record<string, unknown>>>({});
const searchPools = ref<Record<string, Record<string, unknown>>>({});
const selectedLlmPool = ref('');  // 当前选中的池条目名，空=自定义
const selectedSearchPool = ref('');  // 当前选中的搜索池条目名，空=自定义
const showSecrets = reactive<Record<string, boolean>>({});

function applyLlmPool(poolName: string) {
  selectedLlmPool.value = poolName;
  if (!poolName) {
    // 使用全局模型配置：清除 Agent 级 llm 设置
    config.value.llm = undefined;
    return;
  }
  const pool = llmPools.value[poolName];
  if (!pool) return;
  const defaults: Record<string, any> = {};
  for (const [k, v] of Object.entries(pool)) {
    if (k !== '$ref' && k !== '$comment' && !k.startsWith('$')) {
      defaults[k] = v;
    }
  }
  config.value.llm = { $ref: poolName, ...defaults } as any;
}

function applySearchPool(poolName: string) {
  selectedSearchPool.value = poolName;
  if (!poolName) {
    // 使用默认配置：清除 tool.web_search 命名空间
    delete (config.value as any)['tool.web_search'];
    return;
  }
  // 只设置 $ref，不复制池字段 —— 字段值从池回退读取
  updateNsConfig('tool.web_search', { $ref: poolName });
}

/** 解析工具字段值：agent 配置优先，无值时从搜索池回退 */
function resolveToolFieldValue(key: string): unknown {
  const nsCfg = getNsConfig('tool.' + selectedNodeName.value);
  if (key in nsCfg && nsCfg[key] !== undefined) return nsCfg[key];
  if (nsCfg.$ref && searchPools.value[nsCfg.$ref as string]) {
    const pool = searchPools.value[nsCfg.$ref as string];
    if (key in pool) return pool[key];
  }
  return undefined;
}

const currentLLMSchema = computed(() => {
  const provider = (llmConfig.value.provider || 'deepseek') as string;
  return buildSchema((llmSchemas.value || {})[provider]);
});

const llmProvider = computed({
  get: () => llmConfig.value.provider ?? '',
  set: (val: string) => {
    if (!val) {
      config.value.llm = undefined;
      selectedLlmPool.value = '';
    } else {
      const schema = (llmSchemas.value || {})[val];
      const defaults: Record<string, any> = {};
      if (schema) for (const [k, v] of Object.entries(schema)) { if (v.default !== undefined) defaults[k] = v.default; }
      const existing = typeof config.value.llm === 'object' ? config.value.llm : {};
      const ref = (existing as any)?.$ref;
      config.value.llm = { ...defaults, provider: val, ...(ref ? { $ref: ref } : {}) } as LLMConfig;
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
  if (selectedNodeType.value === 'tool') {
    const nsCfg = getNsConfig('tool.' + selectedNodeName.value);
    if (nsCfg.$ref) {
      // 有池引用：agent 配置中存在即为覆盖（non-default）
      return f.key in nsCfg && nsCfg[f.key] !== undefined;
    }
    return isValNonDefault(nsCfg?.[f.key], f.default);
  }
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
    const nsKey = 'tool.' + selectedNodeName.value;
    const nsCfg = getNsConfig(nsKey);
    if (nsCfg.$ref) {
      // 删除覆盖值，回退到池默认
      const newCfg = { ...nsCfg, [f.key]: undefined };
      delete newCfg[f.key];
      (config.value as any)[nsKey] = newCfg;
    } else {
      updateNsConfig(nsKey, { [f.key]: f.default });
    }
  }
}

// ── 扩展 / 工具 Schema ──
const extSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});
const toolSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});
const searchSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});

function buildSchema(raw: Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; sensitive?: boolean; accept?: string; showWhen?: Record<string, unknown> }> | undefined) {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([k]) => k !== '_label')
    .map(([k, v]) => ({ key: k, label: v.label || k, description: v.description || '', type: v.type, options: v.options, sensitive: v.sensitive, default: v.default, accept: v.accept, showWhen: v.showWhen }));
}

// 扩展/工具配置 filtered
const currentExtFields = computed(() => {
  if (selectedNodeType.value !== 'extension') return [];
  const schema = buildSchema(extSchemas.value[nsName(selectedNodeName.value)]);
  // showWhen 过滤
  const nsCfg = getNsConfig('extension.' + nsName(selectedNodeName.value));
  let filtered = schema.filter(f => {
    if (!f.showWhen) return true;
    return Object.entries(f.showWhen).every(([k, v]) => nsCfg[k] === v);
  });
  if (!searchQuery.value.trim()) return filtered;
  const q = searchQuery.value.toLowerCase();
  return filtered.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
});

const currentToolFields = computed(() => {
  if (selectedNodeType.value !== 'tool') return [];
  const toolName = selectedNodeName.value;
  const baseSchema = buildSchema(toolSchemas.value[toolName]);

  // web_search：选"默认"或未配置时隐藏字段
  if (toolName === 'web_search') {
    if (!selectedSearchPool.value) return [];
    const nsCfg = getNsConfig('tool.web_search');
    const provider = (nsCfg.provider as string) || (searchPools.value[selectedSearchPool.value] as any)?.provider || 'tavily';
    const providerSchema = buildSchema(searchSchemas.value[provider]);
    // 合并：baseSchema（provider 选择器）+ providerSchema（具体配置）
    const merged = [...baseSchema, ...providerSchema];
    if (!searchQuery.value.trim()) return merged;
    const q = searchQuery.value.toLowerCase();
    return merged.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
  }

  if (!searchQuery.value.trim()) return baseSchema;
  const q = searchQuery.value.toLowerCase();
  return baseSchema.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
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
    loadTimers();
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
  try {
    const resp = await fetch(`/api/plugins/search-schemas`);
    if (resp.ok) { searchSchemas.value = await resp.json(); }
  } catch { /* ignore */ }
  try {
    const resp = await fetch(`/api/config/pools`);
    if (resp.ok) {
      const data = await resp.json();
      llmPools.value = data.llmProviders ?? {};
      searchPools.value = data.searchProviders ?? {};
      // 如果当前 llm 配置有 $ref，回填 pool 选择器状态；否则重置
      const llm = config.value.llm;
      if (llm && typeof llm === 'object' && (llm as any).$ref) {
        selectedLlmPool.value = (llm as any).$ref;
      } else {
        selectedLlmPool.value = '';
      }
      // 如果当前 web_search 配置有 $ref，回填搜索池选择器状态；否则重置
      const wsCfg = (config.value as any)['tool.web_search'];
      if (wsCfg && typeof wsCfg === 'object' && wsCfg.$ref) {
        selectedSearchPool.value = wsCfg.$ref;
      } else {
        selectedSearchPool.value = '';
      }
    }
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

// ── web_search provider 切换（应用默认值） ──
function onSearchProviderChange(val: string) {
  const schema = searchSchemas.value[val];
  const defaults: Record<string, unknown> = {};
  if (schema) {
    for (const [k, v] of Object.entries(schema)) {
      if (v.default !== undefined) defaults[k] = v.default;
    }
  }
  updateNsConfig('tool.web_search', { provider: val, ...defaults });
}

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

                <!-- 路径穿透白名单 -->
                <div class="setting-item">
                  <div class="setting-label">路径穿透白名单</div>
                  <div class="setting-desc">允许 Agent 的工具访问工作区之外的路径。每行一个路径，支持绝对路径和相对路径（相对于工作区）。留空则仅允许工作区内的路径。</div>
                  <div class="setting-control">
                    <textarea
                      v-model="allowedPathsText"
                      class="form-textarea code"
                      rows="4"
                      placeholder="例如：&#10;/tmp/agent_scratch/&#10;../shared_data/"
                    ></textarea>
                    <div v-if="(config.allowedPaths?.length ?? 0) > 0" class="hint-text">
                      已配置 {{ config.allowedPaths?.length }} 个白名单路径
                    </div>
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

                <!-- Agent 模型选择：从池中选择或自定义/继承全局 -->
                <div class="setting-item">
                  <div class="setting-label">模型</div>
                  <div class="setting-desc">从模型池中选择预设模型</div>
                  <div class="setting-control">
                    <select class="form-select" :value="selectedLlmPool" @change="applyLlmPool(($event.target as HTMLSelectElement).value)">
                      <option value="">默认</option>
                      <option v-for="(entry, name) in llmPools" :key="name" :value="name">{{ name }}{{ (entry as any).model && (entry as any).model !== name ? ' · ' + (entry as any).model : '' }}</option>
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

              <!-- ====== 定时任务 ====== -->
              <template v-else-if="selectedNodeType === 'timer'">
                <div class="setting-item">
                  <div class="setting-label">定时触发</div>
                  <div class="setting-desc">配置定时自动触发 Agent，结果发送给 target</div>
                </div>

                <div v-if="timerEntries.length > 0" class="settings-list">
                  <div v-for="entry in timerEntries" :key="entry.id" class="setting-item timer-entry">
                    <div class="timer-entry-header">
                      <div class="timer-entry-info">
                        <span class="timer-entry-id">{{ entry.id }}</span>
                        <span class="timer-entry-schedule" :class="{ disabled: !entry.enabled }">
                          {{ entry.mode === 'workday' ? '工作日 ' + entry.time : entry.mode === 'holiday' ? '节假日 ' + entry.time : entry.mode === 'time' ? formatTimeLabel(entry.time) : entry.mode === 'random' ? '随机 ' + (entry.delayMin || '30s') + '~' + (entry.delayMax || '5m') : '每 ' + entry.delay }}
                          · {{ (entry.repeatCount ?? 0) <= 0 ? '永久' : (entry.repeatCount + '次') }}
                        </span>
                      </div>
                      <div class="timer-entry-actions">
                        <label class="toggle-label small">
                          <input type="checkbox" v-model="entry.enabled" />
                        </label>
                        <button class="icon-btn" @click="editTimer(entry)" title="编辑">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="icon-btn danger" @click="removeTimer(entry.id)" title="删除">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                      </div>
                    </div>
                    <div class="timer-entry-hint">{{ entry.hint }}</div>
                  </div>
                </div>
                <div v-else class="hint-text">暂无定时任务，点击下方按钮添加</div>

                <button v-if="!editingTimer" class="add-btn" @click="addTimer">+ 添加定时任务</button>

                <div v-if="timerEntries.length > 0" class="save-section">
                  <button class="btn-save" :disabled="saving" @click="saveTimers">{{ saving ? '保存中...' : '保存定时配置' }}</button>
                </div>
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
                            <input type="checkbox" :checked="(getNsConfig('extension.' + nsName(selectedNodeName))[f.key] ?? f.default) !== false" @change="updateNsConfig('extension.' + nsName(selectedNodeName), { [f.key]: ($event.target as HTMLInputElement).checked })" />
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
                <!-- web_search：搜索池选择器（参考模型配置） -->
                <template v-if="selectedNodeName === 'web_search'">
                  <div class="setting-item">
                    <div class="setting-label">搜索引擎</div>
                    <div class="setting-desc">从搜索池中选择预设配置</div>
                    <div class="setting-control">
                      <select class="form-select" :value="selectedSearchPool" @change="applySearchPool(($event.target as HTMLSelectElement).value)">
                        <option value="">默认</option>
                        <option v-for="(entry, name) in searchPools" :key="name" :value="name">{{ name }}{{ (entry as any).provider && (entry as any).provider !== name ? ' · ' + (entry as any).provider : '' }}</option>
                      </select>
                    </div>
                  </div>
                  <!-- 选择"默认"时显示提示，隐藏后续配置 -->
                  <div v-if="!selectedSearchPool" class="pool-active-hint">使用工具内置默认搜索引擎与参数</div>
                </template>

                <template v-if="!(selectedNodeName === 'web_search' && !selectedSearchPool)">
                  <div class="search-box">
                    <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input v-model="searchQuery" class="search-input" placeholder="搜索配置" />
                  </div>
                </template>

                <template v-if="currentToolFields.length > 0">
                  <div class="settings-list">
                    <div v-for="f in currentToolFields" :key="f.key" class="setting-item" :class="{ 'non-default': isNonDefault(f) }">
                      <div class="setting-label">{{ f.label }}</div>
                      <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                      <div class="setting-control">
                        <template v-if="f.type === 'select' && f.options">
                          <select v-if="selectedNodeName === 'web_search' && f.key === 'provider'" class="form-select" :value="resolveToolFieldValue(f.key) ?? f.options[0]" @change="onSearchProviderChange(($event.target as HTMLSelectElement).value)">
                            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                          </select>
                          <select v-else class="form-select" :value="resolveToolFieldValue(f.key) ?? f.options[0]" @change="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLSelectElement).value })">
                            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                          </select>
                        </template>
                        <template v-else-if="f.type === 'number'">
                          <input type="number" class="form-input short" :value="parseNum(resolveToolFieldValue(f.key))" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: parseNum(($event.target as HTMLInputElement).value) })" />
                        </template>
                        <template v-else-if="f.type === 'file'">
                          <div class="file-input-wrap">
                            <input type="text" class="form-input" :value="resolveToolFieldValue(f.key) ?? ''" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLInputElement).value })" placeholder="输入路径或点击选择文件..." />
                            <button class="browse-btn" @click="browseFile(f)" title="选择文件">…</button>
                          </div>
                        </template>
                        <template v-else>
                          <input type="text" class="form-input" :value="resolveToolFieldValue(f.key) ?? ''" @input="updateNsConfig('tool.' + selectedNodeName, { [f.key]: ($event.target as HTMLInputElement).value })" />
                        </template>
                        <button v-if="isNonDefault(f)" class="reset-btn" title="恢复默认值" @click="resetToDefault(f)">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <template v-else-if="!(selectedNodeName === 'web_search' && !selectedSearchPool)">
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

  <!-- 定时任务编辑弹窗 -->
  <Transition name="modal">
    <div v-if="editingTimer" class="timer-modal-overlay" @mousedown.self="editingTimer = null; timerError = ''">
      <div class="timer-modal-card" @click.stop>
        <div class="timer-modal-header">
          <h3>{{ timerEntries.find(t => t.id === editingTimer!.id) ? '编辑' : '新增' }}定时任务</h3>
          <button class="close-btn" @click="editingTimer = null; timerError = ''" title="关闭">&times;</button>
        </div>
        <div class="timer-modal-body">
          <div class="setting-item">
            <div class="setting-label">模式</div>
            <div class="setting-control">
              <select v-model="editingTimer.mode" class="form-select">
                <option value="delay">延时（间隔触发）</option>
                <option value="random">随机（范围触发）</option>
                <option value="time">定时（每天）</option>
                <option value="workday">法定工作日</option>
                <option value="holiday">法定节假日</option>
              </select>
            </div>
          </div>
          <div v-if="editingTimer.mode === 'time'" class="setting-item">
            <div class="setting-label">日期</div>
            <div class="setting-desc">留空则为每天</div>
            <div class="setting-control">
              <input type="date" :value="toDateOnly(editingTimer.time)" @input="editingTimer.time = updateTimeDate(($event.target as HTMLInputElement).value, toTimeOnly(editingTimer.time))" class="form-input" />
            </div>
          </div>
          <div v-if="editingTimer.mode === 'time' || editingTimer.mode === 'workday' || editingTimer.mode === 'holiday'" class="setting-item">
            <div class="setting-label">时间</div>
            <div class="setting-desc">24 小时制</div>
            <div class="setting-control">
              <input type="time" :value="toTimeOnly(editingTimer.time)" @input="editingTimer.time = updateTimeDate(toDateOnly(editingTimer.time), ($event.target as HTMLInputElement).value)" class="form-input short" />
            </div>
          </div>
          <div v-if="editingTimer.mode === 'delay'" class="setting-item">
            <div class="setting-label">间隔</div>
            <div class="setting-desc">支持 30s / 5m / 1h / 2h30m</div>
            <div class="setting-control">
              <input v-model="editingTimer.delay" class="form-input short" placeholder="1h" />
            </div>
          </div>
          <div v-if="editingTimer.mode === 'random'" class="setting-item">
            <div class="setting-label">随机范围</div>
            <div class="setting-desc">每次触发间隔在最小~最大之间随机</div>
            <div class="setting-control timer-datetime-row">
              <input v-model="editingTimer.delayMin" class="form-input short" placeholder="30s" />
              <span class="range-sep">~</span>
              <input v-model="editingTimer.delayMax" class="form-input short" placeholder="5m" />
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">重复次数</div>
            <div class="setting-desc">0 = 永久重复</div>
            <div class="setting-control">
              <input v-model.number="editingTimer.repeatCount" type="number" min="0" class="form-input short" placeholder="0" />
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">提示内容</div>
            <div class="setting-desc">触发时发送给 Agent 的指令</div>
            <div class="setting-control">
              <textarea v-model="editingTimer.hint" class="form-textarea" rows="3" placeholder="例如：检查系统状态并报告" />
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">目标</div>
            <div class="setting-desc">结果发送给谁，逗号分隔多个，默认 user</div>
            <div class="setting-control">
              <input v-model="editingTimer.target" class="form-input" placeholder="user, coding_agent" />
            </div>
          </div>
          <div v-if="timerError" class="error-text">{{ timerError }}</div>
        </div>
        <div class="timer-modal-footer">
          <button class="btn-cancel" @click="editingTimer = null; timerError = ''">取消</button>
          <button class="btn-save" @click="saveTimer">确认</button>
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
.settings-panel { background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 10px; width: 80vw; max-width: 95vw; height: 80vh; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }

/* ── Header ── */
.panel-header { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.agent-label { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); background: var(--color-bg-subtle, #e8eaed); padding: 1px 7px; border-radius: 4px; }
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
.tree-leaf:hover { background: var(--color-bg-surface, #f5f5f5); }
.tree-leaf.active { background: var(--color-primary-light, #eef2ff); color: var(--color-primary, #6366f1); font-weight: 500; }
.root-leaf { padding-left: 12px; }
.tree-empty { padding: 4px 12px 4px 28px; font-size: 12px; color: var(--color-text-tertiary, #a8abb2); font-style: italic; }

/* ── Right content ── */
.settings-main { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 0; }
.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }

/* Search */
.search-box { position: relative; display: flex; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); }
.search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary, #a8abb2); pointer-events: none; }
.search-input { width: 100%; padding: 6px 10px 6px 28px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 5px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; outline: none; }
.search-input:focus { border-color: var(--color-primary, #6366f1); }
.search-input::placeholder { color: var(--color-text-tertiary, #a8abb2); }

/* Pool active hint */
.pool-active-hint {
  padding: 12px 0;
  font-size: 13px;
  color: var(--color-text-secondary, #666);
}

/* Setting groups & items */
.settings-list { display: flex; flex-direction: column; gap: 2px; }
.setting-item { padding: 7px 12px; border-bottom: 1px solid var(--color-border-secondary, #f0f0f0); display: flex; flex-direction: column; gap: 6px; border-left: 3px solid transparent; }
.setting-item:last-child { border-bottom: none; }
.setting-item.non-default { border-left-color: var(--color-primary, #6366f1); }
.setting-label { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #2c3e50); }
.setting-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.setting-desc { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }

/* Config raw (JSON fallback) */
.config-raw { display: flex; flex-direction: column; gap: 8px; }
.form-input, .form-select { padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; transition: border-color 0.15s; }
.form-input:focus, .form-select:focus { outline: none; border-color: var(--color-primary, #6366f1); }
.form-input.short { width: 120px; }
.form-input:disabled { opacity: 0.5; cursor: not-allowed; background: var(--color-bg-subtle, #f0f0f0); }
/* File browse */
.file-input-wrap { display: flex; align-items: center; gap: 4px; flex: 1; }
.file-input-wrap .form-input { flex: 1; }
.browse-btn {
  flex-shrink: 0; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px; background: var(--color-bg-page, #fff);
  color: var(--color-text-secondary, #666); font-size: 16px;
  cursor: pointer; transition: all 0.15s; font-weight: 700; line-height: 1;
}
.browse-btn:hover { border-color: var(--color-primary, #6366f1); color: var(--color-primary, #6366f1); background: var(--color-primary-light, #eef2ff); }
.form-hint { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }
.form-textarea { width: 100%; padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; resize: vertical; line-height: 1.5; transition: border-color 0.15s; }
.form-textarea:focus { outline: none; border-color: var(--color-primary, #6366f1); }

/* Dividers & checkboxes */
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.toggle-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--color-primary, #6366f1); }
.toggle-text { font-size: 13px; color: var(--color-text-primary, #2c3e50); }

/* Secret input */
.secret-input-wrap { position: relative; display: inline-flex; align-items: center; }
.secret-input { padding-right: 32px !important; width: 220px; }
.eye-toggle { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; line-height: 0; border-radius: 3px; }
.eye-toggle:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-subtle, #e8eaed); }
.reset-btn { flex-shrink: 0; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 4px; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 0; margin-left: 2px; transition: all 0.15s; }
.reset-btn:hover { color: var(--color-primary, #6366f1); border-color: var(--color-primary, #6366f1); background: var(--color-primary-light, #eef2ff); }

/* Hook / Tool list */
.hint-text { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); padding: 4px 0; }

.hook-item { display: flex; align-items: center; gap: 4px; width: 100%; padding: 2px 6px; border-radius: 4px; cursor: grab; transition: background 0.15s, opacity 0.15s; margin-bottom: 1px; border: 1px solid transparent; }
.hook-item:active { cursor: grabbing; }
.hook-item:hover { background: var(--color-bg-surface, #f8f9fa); }
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

.add-select { margin-top: 6px; width: 100%; padding: 6px; border: 1px dashed var(--color-border-secondary, #bdc3c7); border-radius: 6px; background: var(--color-bg-page, #fff); color: var(--color-text-secondary, #7f8c8d); font-size: 12px; cursor: pointer; transition: border-color 0.15s; }
.add-select:focus { outline: none; border-color: var(--color-primary, #6366f1); }
.add-select option { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-page, #fff); }

/* ── 定时任务 ── */
.timer-entry {
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 8px;
  padding: 10px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.timer-entry:hover { border-color: var(--color-primary, #6366f1); box-shadow: 0 1px 4px rgba(52,152,219,0.08); }
.timer-entry-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.timer-entry-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
.timer-entry-id { font-size: 12px; font-weight: 600; color: var(--color-primary, #6366f1); white-space: nowrap; }
.timer-entry-schedule { font-size: 12px; color: var(--color-text-secondary, #7f8c8d); white-space: nowrap; }
.timer-entry-schedule.disabled { text-decoration: line-through; opacity: 0.5; }
.timer-entry-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.timer-entry-hint { font-size: 13px; color: var(--color-text-primary, #2c3e50); margin-top: 6px; padding-left: 2px; line-height: 1.5; }
.timer-edit-form { display: none; }
.add-btn { padding: 6px 16px; border: 1px dashed var(--color-primary, #6366f1); border-radius: 6px; background: transparent; color: var(--color-primary, #6366f1); font-size: 12px; cursor: pointer; margin-top: 10px; transition: background 0.15s; }
.add-btn:hover { background: rgba(52,152,219,0.06); }
.icon-btn { width: 28px; height: 28px; border: none; border-radius: 6px; background: transparent; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.15s, color 0.15s; }
.icon-btn:hover { background: var(--color-bg-subtle, #e8eaed); color: var(--color-text-primary, #2c3e50); }
.icon-btn.danger:hover { background: rgba(231,76,60,0.08); color: #e74c3c; }
.save-section { margin-top: 18px; display: flex; justify-content: flex-end; }
.timer-datetime-row { display: flex; gap: 8px; align-items: center; }
.range-sep { font-size: 13px; color: var(--color-text-secondary, #7f8c8d); flex-shrink: 0; }
.form-actions { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }

/* ── Footer ── */
.panel-footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; border-top: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.footer-left { flex: 1; min-width: 0; }
.error-text { color: #e74c3c; font-size: 12px; }
.success-text { color: #27ae60; font-size: 12px; }
.footer-actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn-cancel, .btn-save { padding: 6px 16px; border-radius: 5px; font-size: 12px; font-weight: 500; cursor: pointer; }
.btn-cancel { background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-cancel:hover { background: var(--color-bg-subtle, #e8eaed); }
.btn-save { background: var(--color-primary, #6366f1); border: none; color: #fff; }
.btn-save:hover:not(:disabled) { background: var(--color-primary-hover, #4f46e5); }
.btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Transitions ── */
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-active .settings-panel, .modal-leave-active .settings-panel { transition: transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .settings-panel { transform: scale(0.95); }
.modal-leave-to .settings-panel { transform: scale(0.95); }

/* ── 定时任务弹窗 ── */
.timer-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35);
  display: flex; align-items: center; justify-content: center;
  z-index: 1100;
}
.timer-modal-card {
  background: var(--color-bg-page, #fff);
  border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
  width: 420px; max-width: 92vw; max-height: 85vh; overflow-y: auto;
}
.timer-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--color-border-secondary, #e8eaed);
}
.timer-modal-header h3 { margin: 0; font-size: 16px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.timer-modal-body { padding: 16px 20px; }
.timer-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 20px 18px;
  border-top: 1px solid var(--color-border-secondary, #e8eaed);
}
.modal-enter-active .timer-modal-card, .modal-leave-active .timer-modal-card { transition: transform 0.2s ease; }
.modal-enter-from .timer-modal-card { transform: scale(0.92); }
.modal-leave-to .timer-modal-card { transform: scale(0.92); }
</style>
