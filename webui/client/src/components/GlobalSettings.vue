<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const loading = ref(false); const saving = ref(false);
const error = ref(''); const successMsg = ref('');
const config = ref<Record<string, any>>({});
/** 需要重启才能生效的配置项 */
const restartKeys = ['maxHops', 'messageQueryDefaultLimit'];
const restartSnap = ref<Record<string, any>>({});

// ── 树状导航 ──
const showSecrets = reactive<Record<string, boolean>>({});
const searchQuery = ref('');
const expanded = ref<Record<string, boolean>>({ 模型: true, 扩展: true, 工具: true });
type TreeNode = { id: string; label: string; type: 'category' | 'leaf'; children?: TreeNode[] };

// 从 schema 的 _label 提取显示名称
function schemaLabel(schemas: Record<string, Record<string, any>>, key: string): string {
  return schemas[key]?._label?.default || key.replace(/_/g, ' ');
}

// 动态构建树
const tree = computed<TreeNode[]>(() => {
  const extChildren = Object.keys(extSchemas.value).map(name => ({
    id: `extension.${name}`, label: schemaLabel(extSchemas.value, name), type: 'leaf' as const,
  }));
  const toolChildren = Object.keys(toolSchemas.value)
    .filter(name => name !== 'web_search') // 由 Search 池管理
    .map(name => ({
    id: `tool.${name}`, label: schemaLabel(toolSchemas.value, name), type: 'leaf' as const,
  }));
  return [
    { id: 'llmPools', label: '模型管理', type: 'leaf' as const },
    { id: 'searchPools', label: '搜索引擎', type: 'leaf' as const },
    { id: 'extensions', label: '扩展', type: 'category' as const, children: extChildren },
    { id: 'tools', label: '工具', type: 'category' as const, children: toolChildren },
    { id: 'core', label: '系统', type: 'leaf' as const },
  ].filter(n => n.type === 'leaf' || (n.children && n.children.length > 0));
});
const selectedNode = ref('llmPools');

function selectNode(id: string) { selectedNode.value = id; }

// ── LLM schema ──
const llmPools = ref<Record<string, Record<string, unknown>>>({});

// ── 扩展 / 工具 schema ──
const extSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});
const toolSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});

// 字段类型
type SchemaField = { nsKey: string; key: string; label: string; type: string; description: string; options?: string[]; default?: unknown; showWhen?: Record<string, unknown> };

// 当前选中节点对应的 schema fields
const currentFields = computed<SchemaField[]>(() => {
  const node = selectedNode.value;
  if (node.startsWith('extension.')) {
    const name = node.replace('extension.', '');
    return buildSchema(extSchemas.value[name]).map(f => ({ ...f, nsKey: node }));
  }
  if (node.startsWith('tool.')) {
    const name = node.replace('tool.', '');
    return buildSchema(toolSchemas.value[name]).map(f => ({ ...f, nsKey: node }));
  }
  if (node === 'core') return knownFields.map(f => ({ ...f, nsKey: '' }));
  return [];
});

// 搜索过滤
const filteredFields = computed(() => {
  let fields = currentFields.value;
  // showWhen 过滤
  fields = fields.filter(f => {
    if (!f.showWhen) return true;
    const nsCfg = f.nsKey ? (config.value[f.nsKey] ?? {}) as Record<string, unknown> : config.value;
    return Object.entries(f.showWhen).every(([k, v]) => nsCfg[k] === v);
  });
  if (!searchQuery.value.trim()) return fields;
  const q = searchQuery.value.toLowerCase();
  return fields.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
});

// 当前节点的标题
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

function buildSchema(raw: Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; sensitive?: boolean; accept?: string; showWhen?: Record<string, unknown> }> | undefined): Array<{ key: string; label: string; description: string; type: string; options?: string[]; sensitive?: boolean; default?: unknown; accept?: string; showWhen?: Record<string, unknown> }> {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([k]) => k !== '_label')
    .map(([k, v]) => ({ key: k, label: v.label || k, description: v.description || '', type: v.type, options: v.options, sensitive: v.sensitive, default: v.default, accept: v.accept, showWhen: v.showWhen }));
}

// ── 核心配置 ──
const knownFields: SchemaField[] = [
  { nsKey: '', key: 'maxHops', label: '最大跳数', type: 'number', description: 'Router 最大跳数（防死循环）', default: 5 },
  { nsKey: '', key: 'messageQueryDefaultLimit', label: '消息查询默认条数', type: 'number', description: '历史消息查询默认返回条数', default: 50 },
];

// ── 报时配置 ──
const chimeEnabled = computed(() => !!(config.value.chime?.enabled));
function toggleChime() {
  if (!config.value.chime) config.value.chime = { enabled: false, times: [] };
  config.value.chime.enabled = !config.value.chime.enabled;
}
const chimeTimesText = computed({
  get: () => (config.value.chime?.times || []).join('\n'),
  set: (v: string) => {
    if (!config.value.chime) config.value.chime = { enabled: false, times: [] };
    config.value.chime.times = v.split(/[\n,，]/).map(t => t.trim()).filter(Boolean);
  },
});

// ── helpers ──
function getNsValue(nsKey: string, fieldKey: string): any {
  if (!nsKey) return config.value[fieldKey];
  const ns = config.value[nsKey] ?? {};
  return ns[fieldKey];
}
function setNsValue(nsKey: string, fieldKey: string, value: any) {
  if (!nsKey) { config.value[fieldKey] = value; return; }
  if (!config.value[nsKey]) config.value[nsKey] = {};
  config.value[nsKey][fieldKey] = value;
}
function parseNum(val: any): any { const n = Number(val); return isNaN(n) ? val : n; }
function formatRatio(val: number, display?: string): string {
  if (display === 'percent') return Math.round(val * 100) + '%';
  return String(val);
}

// ── 文件选择 ──
const browsing = ref(false);
async function browseFile(f: { nsKey: string; key: string; accept?: string; type: string }) {
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
      setNsValue(f.nsKey, f.key, data.path);
    }
  } catch (err: any) {
    console.warn('[browseFile] 文件选择失败:', err.message);
  } finally {
    browsing.value = false;
  }
}

/** 判断配置项当前值与 schema 默认值是否不一致 */
function isNonDefault(f: SchemaField): boolean {
  if (!f.nsKey) return isValNonDefault(config.value[f.key], f.default);
  return isValNonDefault(getNsValue(f.nsKey, f.key), f.default);
}
function isValNonDefault(val: any, def: unknown): boolean {
  if (def === undefined || def === null) return val !== undefined && val !== null && val !== '';
  if (val === undefined || val === null) return false;
  return JSON.stringify(val) !== JSON.stringify(def);
}

/** 恢复字段为默认值 */
function resetToDefault(f: SchemaField) {
  if (!f.nsKey) {
    config.value[f.key] = f.default;
  } else {
    setNsValue(f.nsKey, f.key, f.default);
  }
}

// ── Provider 池管理 ──
const poolEditName = ref<string | null>(null);  // null=列表视图, ''=新建, 'xxx'=编辑
const poolEditData = ref<Record<string, any>>({});

/** 当前选中的池类型对应的 config key 和数据 */
const currentPoolKey = computed(() => {
  if (selectedNode.value === 'llmPools') return 'llmProviders';
  if (selectedNode.value === 'searchPools') return 'searchProviders';
  return '';
});
const currentPoolEntries = computed(() => {
  const raw = config.value[currentPoolKey.value];
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('$')) result[k] = v;
  }
  return result;
});

function startAddPoolEntry() {
  poolEditName.value = '';
  error.value = ''; successMsg.value = '';
  if (selectedNode.value === 'llmPools') {
    const provider = 'deepseek';
    const schema = poolLLMSchemas.value[provider];
    const defaults: Record<string, any> = { provider };
    if (schema) {
      for (const [k, v] of Object.entries(schema)) {
        if (v.default !== undefined && k !== '_label') defaults[k] = v.default;
      }
    }
    poolEditData.value = defaults;
  } else {
    const provider = 'tavily';
    const schema = searchSchemasForPool.value[provider];
    const defaults: Record<string, any> = { provider };
    if (schema) {
      for (const [k, v] of Object.entries(schema)) {
        if (v.default !== undefined && k !== '_label') defaults[k] = v.default;
      }
    }
    poolEditData.value = defaults;
  }
}
function startEditPoolEntry(name: string) {
  poolEditName.value = name;
  const entry = JSON.parse(JSON.stringify(currentPoolEntries.value[name] ?? {}));
  // 合并 schema 默认值（未设置的字段用默认值填充，保证 ratio slider 等有初始值）
  const provider = entry.provider || 'deepseek';
  const schemaMap = selectedNode.value === 'llmPools' ? poolLLMSchemas.value : searchSchemasForPool.value;
  const schema = schemaMap[provider];
  if (schema) {
    for (const [k, v] of Object.entries(schema)) {
      if (v.default !== undefined && k !== '_label' && entry[k] === undefined) {
        entry[k] = v.default;
      }
    }
  }
  poolEditData.value = entry;
}
function cancelPoolEdit() {
  poolEditName.value = null;
  poolEditData.value = {};
}

/** 编辑时切换 provider 类型：保留名称，应用新 provider 的 schema 默认值 */
function onPoolProviderChange(newProvider: string) {
  if (selectedNode.value === 'llmPools') {
    const schema = poolLLMSchemas.value[newProvider];
    const defaults: Record<string, any> = { provider: newProvider };
    if (schema) {
      for (const [k, v] of Object.entries(schema)) {
        if (v.default !== undefined && k !== '_label') defaults[k] = v.default;
      }
    }
    const name = poolEditData.value.poolName;
    poolEditData.value = defaults;
    if (name !== undefined) poolEditData.value.poolName = name;
  } else {
    const schema = searchSchemasForPool.value[newProvider];
    const defaults: Record<string, any> = { provider: newProvider };
    if (schema) {
      for (const [k, v] of Object.entries(schema)) {
        if (v.default !== undefined && k !== '_label') defaults[k] = v.default;
      }
    }
    const name = poolEditData.value.poolName;
    poolEditData.value = defaults;
    if (name !== undefined) poolEditData.value.poolName = name;
  }
}
async function savePoolEntry() {
  const key = currentPoolKey.value;
  if (!key) return;
  const name = (poolEditData.value.poolName || poolEditName.value || '').trim();
  if (!name) { error.value = '请输入模型名称'; return; }
  const { poolName, ...entry } = poolEditData.value;
  // 清理空字符串（v-model.number 空值会返回 ""，导致 API 400: invalid type: string）
  for (const [k, v] of Object.entries(entry)) {
    if (v === '' || v === undefined) delete entry[k];
  }
  // 对于 schema 中 default=undefined 的 ratio 字段，值==min 时视为"使用 API 默认"，不保存
  const provider = poolEditData.value.provider || 'deepseek';
  const schemaMap = selectedNode.value === 'llmPools' ? poolLLMSchemas.value : searchSchemasForPool.value;
  const schema = schemaMap[provider];
  if (schema) {
    for (const [k, field] of Object.entries(schema)) {
      if (field.type === 'ratio' && field.default === undefined && entry[k] === field.min) {
        delete entry[k];
      }
    }
  }
  if (!config.value[key]) config.value[key] = {};
  if (poolEditName.value && poolEditName.value !== name) {
    delete config.value[key][poolEditName.value];
  }
  // 池中无条目时，首个自动设为默认
  const pool = config.value[key];
  const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
  if (existingKeys.length === 0 || (existingKeys.length === 1 && existingKeys[0] === name)) {
    entry.default = true;
    // 清除其他条目的 default
    for (const k of existingKeys) {
      if (k !== name && pool[k]?.default) delete pool[k].default;
    }
  }
  config.value[key] = { ...pool, [name]: entry };
  poolEditData.value = {};
  await persistConfig();
  // 仅成功后才关闭弹窗
  poolEditName.value = null;
}

async function deletePoolEntry(name: string) {
  const key = currentPoolKey.value;
  if (!key || !config.value[key]) return;
  delete config.value[key][name];
  if (Object.keys(config.value[key]).length === 0) delete config.value[key];
  poolEditName.value = null;
  await persistConfig();
}

/** 将指定池条目设为默认（取消其他条目的默认标记） */
async function setDefaultPool(name: string) {
  const key = currentPoolKey.value;
  if (!key || !config.value[key]) return;
  // 清除所有默认标记
  for (const [k, v] of Object.entries(config.value[key])) {
    if (!k.startsWith('$') && typeof v === 'object') (v as any).default = false;
  }
  // 设当前条目为默认
  if (config.value[key][name]) config.value[key][name].default = true;
  await persistConfig();
}

/** 立即持久化当前配置到磁盘，并刷新池列表 */
async function persistConfig() {
  try {
    const cleaned = JSON.parse(JSON.stringify(config.value, (k, v) => v ?? undefined));
    // 删除旧的 llm 字段（由池 default 自动决定）
    if (cleaned.llm) delete cleaned.llm;
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cleaned }) });
    if (r.ok) {
      const poolR = await fetch('/api/config/pools');
      if (poolR.ok) {
        const d = await poolR.json();
        llmPools.value = d.llmProviders ?? {};
      }
      successMsg.value = '已保存';
      setTimeout(() => { if (successMsg.value === '已保存') successMsg.value = ''; }, 2000);
    }
  } catch (err: any) {
    error.value = `保存失败: ${err.message || '网络错误'}`;
    setTimeout(() => { error.value = ''; }, 5000);
  }
}

/** 获取池条目对应的 LLM schema（用于 LLM 池编辑时显示字段） */
const poolLLMSchemas = ref<Record<string, Record<string, any>>>({});
const currentPoolSchema = computed(() => {
  if (selectedNode.value !== 'llmPools') return [];
  const provider = (poolEditData.value.provider || 'deepseek') as string;
  return buildSchema(poolLLMSchemas.value[provider]);
});
const currentSearchPoolSchema = computed(() => {
  if (selectedNode.value !== 'searchPools') return [];
  return buildSchema(searchSchemasForPool.value[poolEditData.value.provider || 'tavily']);
});
const searchSchemasForPool = ref<Record<string, Record<string, any>>>({});

// ── 加载 ──
async function loadConfig() {
  loading.value = true; error.value = '';
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    config.value = (await r.json()).config ?? {};
    restartSnap.value = JSON.parse(JSON.stringify(config.value));
  } catch (err: any) { error.value = `加载失败: ${err.message}`; }
  const [llmR, extR, searchR, poolR] = await Promise.allSettled([
    fetch('/api/plugins/llm-schemas'),
    fetch('/api/plugins/schemas'),
    fetch('/api/plugins/search-schemas'),
    fetch('/api/config/pools'),
  ]);
  if (llmR.status === 'fulfilled' && llmR.value.ok) {
    poolLLMSchemas.value = await llmR.value.json();
  }
  if (extR.status === 'fulfilled' && extR.value.ok) {
    const d = await extR.value.json();
    extSchemas.value = d.extensions ?? {}; toolSchemas.value = d.tools ?? {};
  }
  if (searchR.status === 'fulfilled' && searchR.value.ok) {
    searchSchemasForPool.value = await searchR.value.json();
  }
  if (poolR.status === 'fulfilled' && poolR.value.ok) {
    const d = await poolR.value.json();
    llmPools.value = d.llmProviders ?? {};
  }
  loading.value = false;
}

async function saveConfig() {
  saving.value = true; error.value = ''; successMsg.value = '';
  try {
    const cleaned = JSON.parse(JSON.stringify(config.value, (k, v) => v ?? undefined));
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cleaned }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.success) {
      const needRestart = restartKeys.some(k => JSON.stringify(config.value[k]) !== JSON.stringify(restartSnap.value[k]));
      successMsg.value = needRestart ? '已保存，重启后生效' : '已保存';
      if (needRestart) restartSnap.value = JSON.parse(JSON.stringify(config.value));
      setTimeout(() => successMsg.value = '', 4000);
    }
    else error.value = d.error ?? '保存失败';
  } catch (err: any) { error.value = `保存失败: ${err.message}`; }
  saving.value = false;
}

watch(() => props.visible, v => { if (v) loadConfig(); });
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="settings-overlay" @mousedown.self="emit('close')">
      <div class="settings-panel" @click.stop>
        <!-- Header -->
        <div class="panel-header">
          <h3>设置</h3>
          <span v-if="currentTitle" class="panel-subtitle">{{ currentTitle }}</span>
          <button class="close-btn" @click="emit('close')" title="关闭">×</button>
        </div>

        <div class="panel-body">
          <!-- 左侧树 -->
          <div class="settings-sidebar">
            <div
              v-for="node in tree" :key="node.id"
              class="tree-group"
            >
              <!-- category -->
              <template v-if="node.type === 'category'">
                <div class="tree-category" @click="expanded[node.id] = !expanded[node.id]">
                  <svg class="tree-arrow" :class="{ open: expanded[node.id] }" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <span>{{ node.label }}</span>
                </div>
                <div v-if="expanded[node.id]" class="tree-children">
                  <div
                    v-for="child in node.children" :key="child.id"
                    class="tree-leaf" :class="{ active: selectedNode === child.id }"
                    @click="selectNode(child.id)"
                  >{{ child.label }}</div>
                </div>
              </template>
              <!-- leaf -->
              <div
                v-else class="tree-leaf root-leaf" :class="{ active: selectedNode === node.id }"
                @click="selectNode(node.id)"
              >{{ node.label }}</div>
            </div>
          </div>

          <!-- 右侧配置区域 -->
          <div class="settings-main">
            <div v-if="loading" class="status-msg">加载中...</div>
            <template v-else>
              <!-- 搜索 -->
              <div class="search-box">
                <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input v-model="searchQuery" class="search-input" placeholder="搜索设置" />
              </div>

              <!-- LLM 配置字段（由 Provider 池中的默认条目决定） -->

              <!-- ========== Provider 池管理 ========== -->
              <template v-if="currentPoolKey">
                <div class="pool-header">
                  <span class="pool-title">{{ selectedNode === 'llmPools' ? '模型管理' : '搜索引擎' }}</span>
                  <button class="btn-add-pool" @click="startAddPoolEntry()">+ 添加</button>
                </div>
                <div v-if="Object.keys(currentPoolEntries).length === 0" class="status-msg">暂无条目，点击"+ 添加"创建</div>
                <div v-else class="pool-list">
                  <div v-for="(entry, name) in currentPoolEntries" :key="name" class="pool-entry" :class="{ 'is-default': (entry as any).default }">
                    <div class="pool-entry-info">
                      <span class="pool-entry-name">
                        <span v-if="(entry as any).default" class="default-badge" title="当前默认模型">★</span>
                        {{ name }}
                      </span>
                      <span class="pool-entry-detail">{{ (entry as any).provider }}{{ (entry as any).model ? ' / ' + (entry as any).model : '' }}</span>
                    </div>
                    <div class="pool-entry-actions">
                      <button v-if="!(entry as any).default" class="btn-set-default" @click="setDefaultPool(name)" title="设为默认">设为默认</button>
                      <button class="btn-edit" @click="startEditPoolEntry(name)">编辑</button>
                      <button class="btn-delete" @click="deletePoolEntry(name)">删除</button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- 配置字段 -->
              <div v-if="!currentPoolKey" class="settings-list">
                <div v-for="f in filteredFields" :key="f.key" class="setting-item" :class="{ 'non-default': isNonDefault(f) }">
                  <div class="setting-label">{{ f.label }}</div>
                  <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                  <div class="setting-control">
                      <!-- checkbox -->
                      <template v-if="f.type === 'checkbox'">
                        <label class="toggle-label">
                          <input type="checkbox" :checked="(getNsValue(f.nsKey, f.key) ?? f.default) !== false" @change="setNsValue(f.nsKey, f.key, ($event.target as HTMLInputElement).checked)" />
                          <span class="toggle-text">{{ f.label }}</span>
                        </label>
                      </template>
                      <!-- select -->
                      <template v-else-if="f.type === 'select' && f.options">
                        <select class="form-select" :value="getNsValue(f.nsKey, f.key) ?? f.options[0]" @change="setNsValue(f.nsKey, f.key, ($event.target as HTMLSelectElement).value)"><option v-for="o in f.options" :key="o" :value="o">{{ o }}</option></select>
                      </template>
                      <!-- number -->
                      <template v-else-if="f.type === 'number'">
                        <input type="number" class="form-input short" :value="parseNum(getNsValue(f.nsKey, f.key))" @input="setNsValue(f.nsKey, f.key, parseNum(($event.target as HTMLInputElement).value))" />
                      </template>
                      <!-- ratio slider -->
                      <template v-else-if="f.type === 'ratio'">
                        <div class="ratio-wrap">
                          <input type="range" class="ratio-slider"
                            :min="(f as any).min ?? 0" :max="(f as any).max ?? 1" :step="(f as any).step ?? 0.01"
                            :value="getNsValue(f.nsKey, f.key) ?? (f as any).min ?? 0"
                            @input="setNsValue(f.nsKey, f.key, parseFloat(($event.target as HTMLInputElement).value))" />
                          <span class="ratio-value">{{ formatRatio(getNsValue(f.nsKey, f.key) ?? (f as any).min ?? 0, (f as any).display) }}</span>
                        </div>
                      </template>
                      <!-- file -->
                      <template v-else-if="f.type === 'file'">
                        <div class="file-input-wrap">
                          <input type="text" class="form-input" :value="getNsValue(f.nsKey, f.key) ?? ''" @input="setNsValue(f.nsKey, f.key, ($event.target as HTMLInputElement).value)" placeholder="输入路径或点击选择文件..." />
                          <button class="browse-btn" @click="browseFile(f)" title="选择文件">…</button>
                        </div>
                      </template>
                      <!-- text -->
                      <template v-else>
                        <input type="text" class="form-input" :value="getNsValue(f.nsKey, f.key) ?? ''" @input="setNsValue(f.nsKey, f.key, ($event.target as HTMLInputElement).value)" />
                      </template>
                      <button v-if="isNonDefault(f)" class="reset-btn" title="恢复默认值" @click="resetToDefault(f)">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                      </button>
                    </div>
                </div>
                <div v-if="filteredFields.length === 0" class="status-msg">未找到匹配的设置</div>
              </div>

              <!-- 报时配置（仅系统页面） -->
              <div v-if="selectedNode === 'core' && !currentPoolKey" class="chime-section">
                <div class="chime-header">全局报时机制</div>
                <div class="setting-item">
                  <div class="setting-label">报时机制</div>
                  <div class="setting-desc">启用后，系统将在设定的时间点向所有 Agent 发送报时通知</div>
                  <div class="setting-control">
                    <label class="toggle-label">
                      <input type="checkbox" :checked="chimeEnabled" @change="toggleChime" />
                      <span class="toggle-text">{{ chimeEnabled ? '已启用' : '已禁用' }}</span>
                    </label>
                  </div>
                </div>
                <div v-if="chimeEnabled" class="setting-item">
                  <div class="setting-label">报时时间清单</div>
                  <div class="setting-desc">每行一个时间（HH:mm 格式），如 08:00、12:00、18:00。支持换行或逗号分隔。</div>
                  <div class="setting-control" style="flex-direction: column; align-items: stretch;">
                    <textarea
                      class="chime-textarea"
                      :value="chimeTimesText"
                      @input="chimeTimesText = ($event.target as HTMLTextAreaElement).value"
                      rows="5"
                      placeholder="08:00&#10;12:00&#10;18:00"
                    ></textarea>
                    <div v-if="config.chime?.times?.length" class="chime-preview">
                      当前报时点：{{ config.chime?.times?.join('、') }}
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Footer -->
        <div class="panel-footer">
          <div class="footer-left"><span v-if="error" class="error-text">{{ error }}</span><span v-if="successMsg" class="success-text">{{ successMsg }}</span></div>
          <div class="footer-actions">
            <button class="btn-cancel" @click="emit('close')">关闭</button>
            <button class="btn-save" :disabled="saving || loading" @click="saveConfig">{{ saving ? '保存中...' : '保存配置' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 池编辑弹窗 -->
  <Transition name="modal">
    <div v-if="poolEditName !== null && currentPoolKey" class="timer-modal-overlay" @mousedown.self="cancelPoolEdit()">
      <div class="timer-modal-card" @click.stop>
        <div class="timer-modal-header">
          <h3>{{ poolEditName ? '编辑 ' + poolEditName : '新建条目' }}</h3>
          <button class="close-btn" @click="cancelPoolEdit()" title="关闭">&times;</button>
        </div>
        <div class="timer-modal-body">
          <div class="setting-item">
            <div class="setting-label">名称</div>
            <div class="setting-control">
              <input type="text" class="form-input" v-model="poolEditData.poolName" :placeholder="poolEditName || '输入条目名称'" />
            </div>
          </div>
          <template v-if="selectedNode === 'llmPools'">
            <div class="setting-item">
              <div class="setting-label">Provider 类型</div>
              <div class="setting-control">
                <select class="form-select" :value="poolEditData.provider" @change="onPoolProviderChange(($event.target as HTMLSelectElement).value)">
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>
            </div>
            <div v-for="f in currentPoolSchema" :key="f.key" class="setting-item">
              <div class="setting-label">{{ f.label }}</div>
              <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
              <div class="setting-control">
                <template v-if="f.type === 'checkbox'">
                  <label class="toggle-label">
                    <input type="checkbox" :checked="poolEditData[f.key] !== false" @change="poolEditData[f.key] = ($event.target as HTMLInputElement).checked" />
                  </label>
                </template>
                <template v-else-if="f.type === 'select' && f.options">
                  <select class="form-select" v-model="poolEditData[f.key]">
                    <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                  </select>
                </template>
                <template v-else-if="f.type === 'number'">
                  <input type="number" class="form-input short" v-model.number="poolEditData[f.key]" />
                </template>
                <template v-else-if="f.type === 'ratio'">
                  <div class="ratio-wrap">
                    <input type="range" class="ratio-slider"
                      :min="(f as any).min ?? 0" :max="(f as any).max ?? 1" :step="(f as any).step ?? 0.01"
                      :value="poolEditData[f.key] ?? (f as any).min ?? 0"
                      @input="poolEditData[f.key] = parseFloat(($event.target as HTMLInputElement).value)" />
                    <span class="ratio-value">{{ formatRatio(poolEditData[f.key] ?? (f as any).min ?? 0, (f as any).display) }}</span>
                  </div>
                </template>
                <template v-else>
                  <input type="text" class="form-input" v-model="poolEditData[f.key]" />
                </template>
              </div>
            </div>
          </template>
          <template v-if="selectedNode === 'searchPools'">
            <div class="setting-item">
              <div class="setting-label">Provider 类型</div>
              <div class="setting-control">
                <select class="form-select" :value="poolEditData.provider" @change="onPoolProviderChange(($event.target as HTMLSelectElement).value)">
                  <option value="tavily">Tavily</option>
                  <option value="serpapi">SerpAPI</option>
                  <option value="brave">Brave Search</option>
                  <option value="duckduckgo">DuckDuckGo</option>
                </select>
              </div>
            </div>
            <div v-for="f in currentSearchPoolSchema" :key="f.key" class="setting-item">
              <div class="setting-label">{{ f.label }}</div>
              <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
              <div class="setting-control">
                <template v-if="f.type === 'select' && f.options">
                  <select class="form-select" v-model="poolEditData[f.key]">
                    <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                  </select>
                </template>
                <template v-else-if="f.type === 'number'">
                  <input type="number" class="form-input short" v-model.number="poolEditData[f.key]" />
                </template>
                <template v-else>
                  <input type="text" class="form-input" v-model="poolEditData[f.key]" />
                </template>
              </div>
            </div>
          </template>
        </div>
        <div class="timer-modal-footer">
          <span v-if="error" class="error-text">{{ error }}</span>
          <span v-else-if="successMsg" class="success-text">{{ successMsg }}</span>
          <span v-else />
          <button class="btn-cancel" @click="cancelPoolEdit()">取消</button>
          <button class="btn-save" @click="savePoolEntry()">保存</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ── Overlay & Panel ── */
.settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.settings-panel { background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 10px; width: 80vw; max-width: 95vw; height: 80vh; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
.panel-header { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.panel-subtitle { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin-left: 4px; }
.close-btn { margin-left: auto; background: none; border: none; color: var(--color-text-secondary, #7f8c8d); font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1; }
.close-btn:hover { color: var(--color-text-primary, #2c3e50); }

/* ── Body: left tree + right content ── */
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
.tree-children { }
.tree-leaf {
  padding: 4px 12px 4px 28px; font-size: 13px;
  color: var(--color-text-primary, #2c3e50); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tree-leaf:hover { background: var(--color-bg-surface, #f5f5f5); }
.tree-leaf.active { background: var(--color-primary-light, #eef2ff); color: var(--color-primary, #6366f1); font-weight: 500; }
.root-leaf { padding-left: 12px; }

/* ── Right content ── */
.settings-main { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 0; }
.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }

/* Search */
.search-box { position: relative; display: flex; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); }
.search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary, #a8abb2); pointer-events: none; }
.search-input { width: 100%; padding: 6px 10px 6px 28px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 5px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; outline: none; }
.search-input:focus { border-color: var(--color-primary, #6366f1); }
.search-input::placeholder { color: var(--color-text-tertiary, #a8abb2); }

/* Setting groups & items */
.settings-list { display: flex; flex-direction: column; gap: 2px; }
.setting-item { padding: 7px 12px; border-bottom: 1px solid var(--color-border-secondary, #f0f0f0); display: flex; flex-direction: column; gap: 6px; border-left: 3px solid transparent; }
.setting-item:last-child { border-bottom: none; }
.setting-item.non-default { border-left-color: var(--color-primary, #6366f1); }
.setting-label { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #2c3e50); }
.setting-control { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.setting-desc { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }

/* Form controls */
.form-input, .form-select { padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; transition: border-color 0.15s; }
.form-input:focus, .form-select:focus { outline: none; border-color: var(--color-primary, #6366f1); }
.form-input.short { width: 120px; }

.ratio-wrap { display: flex; align-items: center; gap: 8px; }
.ratio-slider { flex: 1; max-width: 200px; height: 4px; accent-color: var(--accent, #4a9eff); cursor: pointer; }
.ratio-value { font-size: 12px; color: var(--text-secondary, #888); min-width: 36px; text-align: right; }
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
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.toggle-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--color-primary, #6366f1); }
.toggle-text { font-size: 13px; color: var(--color-text-primary, #2c3e50); }
.secret-input-wrap { position: relative; display: inline-flex; align-items: center; }
.secret-input { padding-right: 32px !important; width: 220px; }
.eye-toggle { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; line-height: 0; border-radius: 3px; }
.eye-toggle:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-subtle, #e8eaed); }
.reset-btn { flex-shrink: 0; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 4px; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 0; margin-left: 6px; transition: all 0.15s; }
.reset-btn:hover { color: var(--color-primary, #6366f1); border-color: var(--color-primary, #6366f1); background: var(--color-primary-light, #eef2ff); }

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

.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-active .settings-panel, .modal-leave-active .settings-panel { transition: transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .settings-panel { transform: scale(0.95); }
.modal-leave-to .settings-panel { transform: scale(0.95); }

/* ── 弹窗样式 ── */
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

/* ── Provider 池管理 ── */
.pool-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); }
.pool-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.btn-add-pool { padding: 4px 12px; border: 1px solid var(--color-primary, #6366f1); border-radius: 5px; background: var(--color-bg-page, #fff); color: var(--color-primary, #6366f1); font-size: 12px; cursor: pointer; transition: all 0.15s; }
.btn-add-pool:hover { background: var(--color-primary-light, #eef2ff); }
.pool-list { display: flex; flex-direction: column; gap: 4px; }
.pool-entry { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 6px; background: var(--color-bg-page, #fff); }
.pool-entry-info { display: flex; flex-direction: column; gap: 2px; }
.pool-entry-name { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #2c3e50); }
.pool-entry-detail { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }
.pool-entry-actions { display: flex; gap: 6px; }
.pool-entry.is-default { border-color: var(--color-primary, #6366f1); background: var(--color-primary-light, #eef2ff); }
.default-badge { color: #f39c12; margin-right: 4px; font-size: 14px; }
.btn-set-default { padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: 1px solid #f39c12; background: var(--color-bg-page, #fff); color: #f39c12; transition: all 0.15s; }
.btn-set-default:hover { background: #fef9e7; }
.btn-edit, .btn-delete { padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all 0.15s; border: 1px solid var(--color-border-secondary, #ddd); }
.btn-edit { background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); }
.btn-edit:hover { border-color: var(--color-primary, #6366f1); color: var(--color-primary, #6366f1); }
.btn-delete { background: var(--color-bg-page, #fff); color: #e74c3c; border-color: #f5c6cb; }
.btn-delete:hover { background: #fef0f0; }

/* ── 报时配置 ── */
.chime-section {
  margin-top: 16px; padding-top: 12px;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
}
.chime-header {
  font-size: 14px; font-weight: 600;
  color: var(--color-text-primary, #2c3e50);
  padding: 0 12px; margin-bottom: 8px;
}
.chime-textarea {
  width: 100%; padding: 8px 10px;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary, #2c3e50);
  font-size: 13px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  resize: vertical; line-height: 1.6;
  transition: border-color 0.15s;
}
.chime-textarea:focus {
  outline: none;
  border-color: var(--color-primary, #6366f1);
}
.chime-textarea::placeholder {
  color: var(--color-text-tertiary, #a8abb2);
}
.chime-preview {
  font-size: 12px; color: var(--color-text-secondary, #888);
  padding-top: 4px;
}
</style>
