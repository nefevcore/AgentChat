<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const loading = ref(false); const saving = ref(false);
const error = ref(''); const successMsg = ref('');
const config = ref<Record<string, any>>({});
/** 需要重启才能生效的配置项 */
const restartKeys = ['maxHops', 'messageQueryDefaultLimit', 'webuiDefaultPort'];
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
  const toolChildren = Object.keys(toolSchemas.value).map(name => ({
    id: `tool.${name}`, label: schemaLabel(toolSchemas.value, name), type: 'leaf' as const,
  }));
  return [
    { id: 'llm', label: '模型', type: 'leaf' as const },
    { id: 'extensions', label: '扩展', type: 'category' as const, children: extChildren },
    { id: 'tools', label: '工具', type: 'category' as const, children: toolChildren },
    { id: 'core', label: '系统', type: 'leaf' as const },
  ].filter(n => n.type === 'leaf' || (n.children && n.children.length > 0));
});
const selectedNode = ref('llm');

function selectNode(id: string) { selectedNode.value = id; }

// ── LLM schema ──
const llmSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; sensitive?: boolean }>>>({});
const defaultLLM = computed(() => (config.value.llm || { provider: 'deepseek' }) as Record<string, any>);
const currentLLMSchema = computed(() => buildSchema((llmSchemas.value || {})[defaultLLM.value.provider || 'deepseek']));

function updateDefaultLLM(patch: Record<string, any>) {
  if (patch.provider && patch.provider !== defaultLLM.value.provider) {
    const s = (llmSchemas.value || {})[patch.provider];
    if (s) {
      const defs: Record<string, any> = {};
      for (const [k, v] of Object.entries(s)) { if (v.default !== undefined) defs[k] = v.default; }
      config.value.llm = { ...defs, ...patch }; return;
    }
  }
  config.value.llm = { ...defaultLLM.value, ...patch };
}

// ── 扩展 / 工具 schema ──
const extSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});
const toolSchemas = ref<Record<string, Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[] }>>>({});

// 字段类型
type SchemaField = { nsKey: string; key: string; label: string; type: string; description: string; options?: string[] };

// 当前选中节点对应的 schema fields
const currentFields = computed<SchemaField[]>(() => {
  const node = selectedNode.value;
  if (node === 'llm') return currentLLMSchema.value.map(f => ({ ...f, nsKey: 'llm' }));
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
  if (!searchQuery.value.trim()) return currentFields.value;
  const q = searchQuery.value.toLowerCase();
  return currentFields.value.filter(f => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
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

function buildSchema(raw: Record<string, { type: string; default: unknown; label?: string; description?: string; options?: string[]; sensitive?: boolean }> | undefined): Array<{ key: string; label: string; description: string; type: string; options?: string[]; sensitive?: boolean }> {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([k]) => k !== '_label')
    .map(([k, v]) => ({ key: k, label: v.label || k, description: v.description || '', type: v.type, options: v.options, sensitive: v.sensitive }));
}

// ── 核心配置 ──
const knownFields: SchemaField[] = [
  { nsKey: '', key: 'maxHops', label: '最大跳数', type: 'number', description: 'Router 最大跳数（防死循环）' },
  { nsKey: '', key: 'messageQueryDefaultLimit', label: '消息查询默认条数', type: 'number', description: '历史消息查询默认返回条数' },
  { nsKey: '', key: 'webuiDefaultPort', label: 'WebUI 默认端口', type: 'number', description: 'WebUI 服务器默认监听端口' },
];

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
function getLLMValue(key: string): any { return defaultLLM.value[key]; }
function setLLMValue(key: string, value: any) { updateDefaultLLM({ [key]: value }); }

function parseNum(val: any): any { const n = Number(val); return isNaN(n) ? val : n; }

// ── 加载 ──
async function loadConfig() {
  loading.value = true; error.value = '';
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    config.value = (await r.json()).config ?? {};
    restartSnap.value = JSON.parse(JSON.stringify(config.value));
  } catch (err: any) { error.value = `加载失败: ${err.message}`; }
  const [llmR, extR] = await Promise.allSettled([fetch('/api/plugins/llm-schemas'), fetch('/api/plugins/schemas')]);
  if (llmR.status === 'fulfilled' && llmR.value.ok) llmSchemas.value = await llmR.value.json();
  if (extR.status === 'fulfilled' && extR.value.ok) {
    const d = await extR.value.json();
    extSchemas.value = d.extensions ?? {}; toolSchemas.value = d.tools ?? {};
  }
  if (!config.value.llm) config.value.llm = { provider: 'deepseek' };
  const s = (llmSchemas.value || {})[config.value.llm.provider || 'deepseek'];
  if (s) for (const [k, v] of Object.entries(s)) { if (v.default !== undefined && config.value.llm[k] === undefined) config.value.llm[k] = v.default; }
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

              <!-- LLM provider selector (only for llm node) -->
              <div v-if="selectedNode === 'llm'" class="setting-item">
                <div class="setting-label">选择模型</div>
                <div class="setting-control">
                  <select class="form-select" :value="defaultLLM.provider ?? 'deepseek'" @change="updateDefaultLLM({ provider: ($event.target as HTMLSelectElement).value })">
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </div>
              </div>

              <!-- 配置字段 -->
              <div class="settings-list">
                <div v-for="f in filteredFields" :key="f.key" class="setting-item">
                  <div class="setting-label">{{ f.label }}</div>
                  <div v-if="f.description" class="setting-desc">{{ f.description }}</div>
                  <div class="setting-control">
                      <!-- LLM checkbox -->
                      <template v-if="f.nsKey === 'llm' && f.type === 'checkbox'">
                        <label class="toggle-label">
                          <input type="checkbox" :checked="getLLMValue(f.key) !== false" @change="setLLMValue(f.key, ($event.target as HTMLInputElement).checked)" />
                          <span class="toggle-text">{{ f.label }}</span>
                        </label>
                      </template>
                      <!-- LLM select -->
                      <template v-else-if="f.nsKey === 'llm' && f.type === 'select'">
                        <select class="form-select" :value="getLLMValue(f.key) ?? f.options?.[0]" @change="setLLMValue(f.key, ($event.target as HTMLSelectElement).value)"><option v-for="o in f.options" :key="o" :value="o">{{ o }}</option></select>
                      </template>
                      <!-- LLM number -->
                      <template v-else-if="f.nsKey === 'llm' && f.type === 'number'">
                        <input type="number" class="form-input short" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, parseFloat(($event.target as HTMLInputElement).value) || undefined)" />
                      </template>
                      <!-- LLM password -->
                      <template v-else-if="f.nsKey === 'llm' && f.type === 'password'">
                        <div class="secret-input-wrap">
                          <input :type="showSecrets[f.key] ? 'text' : 'password'" class="form-input secret-input" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, ($event.target as HTMLInputElement).value)" />
                          <button class="eye-toggle" @mousedown.prevent="showSecrets[f.key] = true" @mouseup.prevent="showSecrets[f.key] = false" @mouseleave="showSecrets[f.key] = false" :title="showSecrets[f.key] ? '隐藏' : '按住显示'">
                            <svg v-if="!showSecrets[f.key]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          </button>
                        </div>
                      </template>
                      <!-- LLM text -->
                      <template v-else-if="f.nsKey === 'llm'">
                        <input type="text" class="form-input" :value="getLLMValue(f.key) ?? ''" @input="setLLMValue(f.key, ($event.target as HTMLInputElement).value)" />
                      </template>
                      <!-- checkbox -->
                      <template v-else-if="f.type === 'checkbox'">
                        <label class="toggle-label">
                          <input type="checkbox" :checked="getNsValue(f.nsKey, f.key) !== false" @change="setNsValue(f.nsKey, f.key, ($event.target as HTMLInputElement).checked)" />
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
                      <!-- text -->
                      <template v-else>
                        <input type="text" class="form-input" :value="getNsValue(f.nsKey, f.key) ?? ''" @input="setNsValue(f.nsKey, f.key, ($event.target as HTMLInputElement).value)" />
                      </template>
                    </div>
                </div>
                <div v-if="filteredFields.length === 0" class="status-msg">未找到匹配的设置</div>
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
</template>

<style scoped>
/* ── Overlay & Panel ── */
.settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.settings-panel { background: var(--color-bg-primary, #fff); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 10px; width: 80vw; max-width: 95vw; height: 80vh; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.12); }
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
.tree-leaf:hover { background: var(--color-bg-secondary, #f5f5f5); }
.tree-leaf.active { background: var(--color-primary-light, #ecf5ff); color: var(--color-primary, #3498db); font-weight: 500; }
.root-leaf { padding-left: 12px; }

/* ── Right content ── */
.settings-main { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }

/* Search */
.search-box { position: relative; display: flex; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); }
.search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary, #a8abb2); pointer-events: none; }
.search-input { width: 100%; padding: 6px 10px 6px 28px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 5px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; outline: none; }
.search-input:focus { border-color: var(--color-primary, #3498db); }
.search-input::placeholder { color: var(--color-text-tertiary, #a8abb2); }

/* Setting groups & items */
.settings-list { display: flex; flex-direction: column; gap: 2px; }
.setting-item { padding: 14px 0; border-bottom: 1px solid var(--color-border-secondary, #f0f0f0); display: flex; flex-direction: column; gap: 6px; }
.setting-label { font-size: 13px; font-weight: 500; color: var(--color-text-primary, #2c3e50); }
.setting-control { }
.setting-desc { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }

/* Form controls */
.form-input, .form-select { padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; transition: border-color 0.15s; }
.form-input:focus, .form-select:focus { outline: none; border-color: var(--color-primary, #3498db); }
.form-input.short { width: 120px; }
.form-input:disabled { opacity: 0.5; cursor: not-allowed; background: var(--color-bg-tertiary, #f0f0f0); }
.form-hint { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); }
.form-textarea { width: 100%; padding: 6px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; background: var(--color-bg-primary, #fff); color: var(--color-text-primary, #2c3e50); font-size: 13px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; resize: vertical; line-height: 1.5; transition: border-color 0.15s; }
.form-textarea:focus { outline: none; border-color: var(--color-primary, #3498db); }
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.toggle-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--color-primary, #3498db); }
.toggle-text { font-size: 13px; color: var(--color-text-primary, #2c3e50); }
.secret-input-wrap { position: relative; display: inline-flex; align-items: center; }
.secret-input { padding-right: 32px !important; width: 220px; }
.eye-toggle { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--color-text-tertiary, #a8abb2); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; line-height: 0; border-radius: 3px; }
.eye-toggle:hover { color: var(--color-text-primary, #2c3e50); background: var(--color-bg-tertiary, #e8eaed); }

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

.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-active .settings-panel, .modal-leave-active .settings-panel { transition: transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .settings-panel { transform: scale(0.95); }
.modal-leave-to .settings-panel { transform: scale(0.95); }
</style>
