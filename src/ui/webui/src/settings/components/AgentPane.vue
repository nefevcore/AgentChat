<script setup lang="ts">
// ============================================================
// AgentPane.vue —— Agent 配置（tabs：基本信息 / 模型 / 定时任务 / 扩展与工具）
// 展示读 effective（后端解析），编辑写 raw（差异）
// ============================================================
import { ref, computed, watch } from 'vue';
import type { FieldMeta, TimerEntry, PluginMeta } from '../types';
import type { AgentBrief } from '../useSettings';
import { toFields, filterFields } from '../schema';
import { Icon } from '@/ui';
import SettingField from './SettingField.vue';
import NsFieldList from './NsFieldList.vue';
import TimerPane from './TimerPane.vue';
import ExtToolsPane from './ExtToolsPane.vue';
import { fetchAgentModels, uploadAvatar, deleteAvatar } from '../../core/api/endpoints/agents';
import * as api from '../api';
import type { AgentToolInfo } from '../api';

const props = defineProps<{
  agentId: string;
  agents: AgentBrief[];
  raw: Record<string, any>;
  effective: Record<string, any>;
  sysContent: string; sysEnabled: boolean;
  agentContent: string; agentEnabled: boolean;
  timers: TimerEntry[];
  plugins: PluginMeta[];
  llmSchemas: Record<string, any[]>;
  searchSchemas: Record<string, any[]>;
  nsSchemas: Record<string, any[]>;
  pools: { llmProviders: Record<string, any>; searchProviders: Record<string, any> };
  globalConfig: Record<string, any>;
  saving?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:raw', v: Record<string, any>): void;
  (e: 'update:sysContent', v: string): void;
  (e: 'update:sysEnabled', v: boolean): void;
  (e: 'update:agentContent', v: string): void;
  (e: 'update:agentEnabled', v: boolean): void;
  (e: 'update:timers', v: TimerEntry[]): void;
  (e: 'switch', agentId: string): void;
  (e: 'back'): void;
  (e: 'saveTimers'): void;
}>();

const tab = ref<'info' | 'llm' | 'timer' | 'sec' | 'ext'>('info');
/** 切换 Agent 时回到基本信息 tab */
watch(() => props.agentId, () => { tab.value = 'info'; });

// ── 顶部导航：Agent 名 + 上/下切换 ──
const agentName = computed(() => (props.raw.name ?? props.effective.name ?? props.agentId) as string);
const agentIndex = computed(() => props.agents.findIndex(a => a.id === props.agentId));
const prevAgent = computed(() => (agentIndex.value > 0 ? props.agents[agentIndex.value - 1] : null));
const nextAgent = computed(() => (agentIndex.value >= 0 && agentIndex.value < props.agents.length - 1 ? props.agents[agentIndex.value + 1] : null));

// ── plugins 形态（builtin 声明：runStart/runEnd/tools） ──
function builtinDecl(): { name?: string; tools?: string[]; runStart?: string[]; runEnd?: string[]; [k: string]: any } {
  const plugins = props.raw.plugins ?? [];
  return plugins.find((p: any) => (p.name ?? 'builtin') === 'builtin') ?? {};
}
function ensureBuiltin(): { name: string; tools?: string[]; runStart?: string[]; runEnd?: string[]; [k: string]: any } {
  const plugins = props.raw.plugins ?? [];
  let bp = plugins.find((p: any) => (p.name ?? 'builtin') === 'builtin');
  if (!bp) {
    bp = { name: 'builtin' };
    emit('update:raw', { ...props.raw, plugins: [...plugins, bp] });
  }
  return bp;
}
function patchBuiltin(patch: Record<string, string[]>): void {
  const plugins = props.raw.plugins ?? [];
  const idx = plugins.findIndex((p: any) => (p.name ?? 'builtin') === 'builtin');
  const bp = idx >= 0 ? { ...plugins[idx], ...patch } : { name: 'builtin', ...patch };
  const next = idx >= 0 ? plugins.map((p: any, i: number) => (i === idx ? bp : p)) : [...plugins, bp];
  emit('update:raw', { ...props.raw, plugins: next });
}



// ── 工具清单（方案 B：全部目录 + 来源标注 + 可追加显式声明） ──
const agentTools = ref<{ catalog: AgentToolInfo[]; enabled: string[]; explicit: string[] } | null>(null);
const toolsLoading = ref(false);
async function loadAgentTools(): Promise<void> {
  if (!props.agentId) return;
  toolsLoading.value = true;
  try {
    agentTools.value = await api.getAgentTools(props.agentId);
  } catch {
    agentTools.value = null;
  } finally {
    toolsLoading.value = false;
  }
}
watch(() => props.agentId, () => { agentTools.value = null; loadAgentTools(); });
loadAgentTools();
// ── 模型配置（effective 展示 / raw 编辑） ──
const llmEffective = computed<Record<string, any>>(() => {
  const raw = props.effective.llm;
  if (!raw) return {};
  if (typeof raw === 'string') return { $ref: raw };
  return raw;
});
const llmRaw = computed<Record<string, any>>(() => {
  const raw = props.raw.llm;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
});
const llmProvider = computed(() => (llmEffective.value.provider || 'deepseek') as string);
const llmFields = computed<FieldMeta[]>(() => toFields(props.llmSchemas[llmProvider.value]));
const llmFiltered = computed(() => filterFields(llmFields.value, llmRaw.value, ''));

// 模型参数分组：基础（连接）/ 采样 / 边界 / 推理
// 移除：logprobs / top_logprobs / tool_choice（工具默认 auto，无需配置）
const HIDDEN_LLM_KEYS = new Set(['logprobs', 'top_logprobs', 'tool_choice']);
const LLM_GROUPS: { label: string; fields: string[] }[] = [
  { label: '推理', fields: ['reasoning_effort', 'thinking'] },
  { label: '采样', fields: ['temperature', 'top_p'] },
  { label: '边界', fields: ['max_tokens', 'stop', 'response_format'] },
];
const llmVisible = computed(() => llmFiltered.value.filter(f => !HIDDEN_LLM_KEYS.has(f.key)));
const llmBasic = computed(() => llmVisible.value.filter(f => !LLM_GROUPS.some(g => g.fields.includes(f.key))));
/** 扁平化渲染序列：模型池 → 基础字段 → 分组标题 → 分组字段 */
const llmSections = computed(() => {
  const sections: Array<{ type: 'pool' } | { type: 'title'; label: string } | { type: 'field'; f: FieldMeta }> = [
    { type: 'pool' },
    ...llmBasic.value.map(f => ({ type: 'field' as const, f })),
  ];
  for (const g of LLM_GROUPS) {
    const fields = llmVisible.value.filter(f => g.fields.includes(f.key));
    if (fields.length === 0) continue;
    sections.push({ type: 'title', label: g.label });
    sections.push(...fields.map(f => ({ type: 'field' as const, f })));
  }
  return sections;
});

// 模型名称：从 API 地址读取模型列表（OpenAI 兼容 /models；Ollama /api/tags）
const llmModelsLoading = ref(false);
const llmModelsError = ref('');
const llmModelOptions = ref<string[]>([]);
async function loadModelsFromApi() {
  // 解析当前生效 base_url：raw/effective 覆盖 → 池 $ref → 全局默认池 → schema 默认
  let base = String(getLLM('base_url') || '').trim();
  if (!base) {
    const ref = llmEffective.value.$ref || llmRaw.value.$ref;
    if (ref && props.pools.llmProviders[ref]) base = String(props.pools.llmProviders[ref].base_url || '').trim();
  }
  if (!base) {
    const entries = Object.entries(props.pools.llmProviders).filter(([k]) => !k.startsWith('$'));
    const def = entries.find(([, v]) => (v as any)?.default) || entries[0];
    base = String(def?.[1]?.base_url || '').trim();
  }
  if (!base) { llmModelsError.value = '请先填写 API 地址'; return; }
  llmModelsLoading.value = true;
  llmModelsError.value = '';
  try {
    // 走后端代理：从凭据库附加认证，避免浏览器跨域 401
    const ref = llmEffective.value.$ref || llmRaw.value.$ref;
    const params = new URLSearchParams({ base, provider: llmProvider.value });
    if (ref) params.set('ref', ref);
    const data = await fetchAgentModels(params.toString());
    if (!data.models?.length) throw new Error('未获取到模型列表');
    llmModelOptions.value = data.models;
  } catch (err: any) {
    llmModelsError.value = `读取失败：${err.message}`;
  } finally {
    llmModelsLoading.value = false;
  }
}

const selectedLlmPool = ref('');
function applyLlmPool(poolName: string) {
  selectedLlmPool.value = poolName;
  if (!poolName) {
    // 继承全局：清除 agent 级 llm
    const next = { ...props.raw }; delete next.llm; emit('update:raw', next);
    return;
  }
  const pool = props.pools.llmProviders[poolName];
  if (!pool) return;
  const defaults: Record<string, any> = {};
  for (const [k, v] of Object.entries(pool)) {
    if (k !== '$ref' && k !== '$comment' && !k.startsWith('$')) defaults[k] = v;
  }
  emit('update:raw', { ...props.raw, llm: { $ref: poolName, ...defaults } });
}
function setLLM(key: string, v: unknown): void {
  const next = { ...props.raw };
  const cur = (next.llm && typeof next.llm === 'object' ? next.llm : {});
  next.llm = { ...cur, [key]: v };
  emit('update:raw', next);
}
/** 读取字段展示值：优先本 Agent 实时覆盖（raw），否则回退 effective（全局/池合并） */
function getLLM(key: string): any {
  if (key in llmRaw.value && llmRaw.value[key] !== undefined) return llmRaw.value[key];
  return llmEffective.value[key];
}

// ── 字段来源：true=本 Agent 覆盖，false=继承（全局/池） ──
function isLlmOverridden(key: string): boolean {
  return key in llmRaw.value && llmRaw.value[key] !== undefined;
}
/** 恢复字段为"继承"：从 raw.llm 删除该字段 */
function revertLlmToInherit(key: string): void {
  const cur = { ...llmRaw.value };
  delete cur[key];
  const next = { ...props.raw };
  if (Object.keys(cur).length === 0) {
    delete next.llm;
  } else if (Object.keys(cur).length === 1 && '$ref' in cur) {
    next.llm = { $ref: cur.$ref };
  } else {
    next.llm = cur;
  }
  emit('update:raw', next);
}
/** 当前生效模型摘要（展示 effective，含来源；无显式配置时从池默认推导） */
const llmEffectiveSummary = computed(() => {
  const eff = llmEffective.value;
  const ref = eff.$ref || llmRaw.value.$ref;
  const hasOwn = Object.keys(llmRaw.value).some(
    (k) => k !== '$ref' && llmRaw.value[k] !== undefined && llmRaw.value[k] !== null && llmRaw.value[k] !== ''
  );
  // 本 Agent 显式配置优先
  if (hasOwn) {
    const provider = eff.provider || '';
    const model = llmRaw.value.model || eff.model || '';
    return { provider, model, source: '本 Agent 配置' };
  }
  // 显式引用模型池
  if (ref) {
    const provider = eff.provider || '';
    const model = eff.model || '';
    return { provider, model, source: `模型池 · ${ref}` };
  }
  // 全局配置 llm
  if (eff.provider || eff.model) {
    return { provider: eff.provider || '', model: eff.model || '', source: '全局配置' };
  }
  // 兜底：全局默认池
  const entries = Object.entries(props.pools.llmProviders);
  const def = entries.find(([, v]) => (v as any)?.default) || entries[0];
  if (!def) return null;
  const [name, entry] = def as [string, any];
  return { provider: entry.provider || '', model: entry.model || name, source: `全局默认 · ${name}` };
});



// ── 搜索池（web_search 工具） ──
const selectedSearchPool = ref('');
function applySearchPool(poolName: string) {
  selectedSearchPool.value = poolName;
  const next = { ...props.raw };
  if (!poolName) {
    delete (next as any)['tool.web_search'];
    emit('update:raw', next);
    return;
  }
  (next as any)['tool.web_search'] = { $ref: poolName };
  emit('update:raw', next);
}
function resolveToolValue(nsKey: string, key: string): unknown {
  const nsCfg = (props.raw as any)[nsKey] ?? {};
  if (key in nsCfg && nsCfg[key] !== undefined) return nsCfg[key];
  if (nsCfg.$ref && props.pools.searchProviders[nsCfg.$ref]) {
    const pool = props.pools.searchProviders[nsCfg.$ref];
    if (key in pool) return pool[key];
  }
  return undefined;
}

// ── 能力标签 ──
/** 工具 requires 可能用到的标签 → 中文说明（agent 为隐式基础标签，始终启用） */
const TOOL_TAG_LABELS: Record<string, string> = {
  agent: '基础能力',
  admin: '系统管理',
  dev: '开发工具',
  conductor: '子代理编排',
};
/** 第一行徽章：agent/admin/dev/conductor 固定顺序 + 工具 requires 用到的其他标签排后 */
const toolTagBadges = computed(() => {
  const order = ['agent', 'admin', 'dev', 'conductor'];
  const found = new Set<string>(order);
  for (const t of agentTools.value?.catalog ?? []) for (const r of t.requires ?? []) if (r) found.add(r);
  const rest = Array.from(found).filter(t => !order.includes(t)).sort();
  return [...order, ...rest]
    .map(tag => ({ tag, label: `${tag} · ${TOOL_TAG_LABELS[tag] ?? tag}`, fixed: tag === 'agent' }));
});
const toolBadgeSet = computed(() => new Set(toolTagBadges.value.map(b => b.tag)));
const customTagInput = ref('');
const customTags = computed(() => (props.raw.tags ?? []).filter((t: string) => !toolBadgeSet.value.has(t)));
function toggleTag(tag: string, on: boolean): void {
  const tags: string[] = props.raw.tags ?? [];
  emit('update:raw', { ...props.raw, tags: on ? [...tags.filter(t => t !== tag), tag] : tags.filter(t => t !== tag) });
}
/** 徽章点击：agent 隐式固定不可移除 */
function toggleToolTag(tag: string, fixed: boolean): void {
  if (fixed) return;
  toggleTag(tag, !(props.raw.tags ?? []).includes(tag));
}
function addCustomTag(): void {
  const t = customTagInput.value.trim().toLowerCase();
  if (!t) return;
  const tags = props.raw.tags ?? [];
  if (!tags.includes(t)) emit('update:raw', { ...props.raw, tags: [...tags, t] });
  customTagInput.value = '';
}
function removeTag(tag: string): void {
  emit('update:raw', { ...props.raw, tags: (props.raw.tags ?? []).filter((t: string) => t !== tag) });
}

// ── 路径白名单 ──
// 用本地 draft 保留用户原样输入（含空行/中间编辑），输入时同步 raw.allowedPaths（trim 后数组）
const allowedPathsDraft = ref((props.raw.allowedPaths ?? []).join('\n'));
watch(() => props.raw.allowedPaths, (v) => {
  const text = (v ?? []).join('\n');
  if (text !== allowedPathsDraft.value) allowedPathsDraft.value = text;
});
function onAllowedPathsInput(e: Event) {
  const val = (e.target as HTMLTextAreaElement).value;
  allowedPathsDraft.value = val;
  const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
  const next = { ...props.raw };
  if (lines.length > 0) next.allowedPaths = lines; else delete next.allowedPaths;
  emit('update:raw', next);
}

// ── 头像 ──
const avatarPreview = ref('');
const avatarUploading = ref(false);
const avatarError = ref('');
function initAvatar() {
  avatarPreview.value = `/api/agents/${encodeURIComponent(props.agentId)}/avatar?t=${Date.now()}`;
}
initAvatar();
/** 切换 Agent 时重新加载头像 */
watch(() => props.agentId, () => { avatarError.value = ''; initAvatar(); });

async function onAvatarFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { avatarError.value = '文件大小不能超过 2MB'; return; }
  avatarError.value = '';
  avatarPreview.value = URL.createObjectURL(file);
  avatarUploading.value = true;
  const form = new FormData();
  form.append('file', file);
  try {
    await uploadAvatar(props.agentId, file);
    initAvatar();
  } catch (err: any) {
    avatarError.value = `头像上传失败: ${err.message}`;
  } finally {
    avatarUploading.value = false;
  }
}
async function removeAvatar() {
  try {
    await deleteAvatar(props.agentId);
    avatarPreview.value = '';
  } catch (err: any) {
    avatarError.value = `删除头像失败: ${err.message}`;
  }
}
</script>

<template>
  <div class="agent-pane">
    <!-- 顶部导航：返回 + Agent 名 + 上/下切换 + 保存 -->
    <div class="agent-nav">
      <button class="agent-nav-back" @click="emit('back')" title="返回 Agent 列表"><Icon name="arrow-left" :size="13" /><span>返回 Agent 列表</span></button>
      <span class="agent-nav-name" :title="agentId">{{ agentName }}</span>
      <span class="agent-nav-id">{{ agentId }}</span>
      <div class="agent-nav-spacer"></div>
      <button class="agent-nav-btn" :disabled="!prevAgent" :title="prevAgent ? '上一个：' + (prevAgent.name || prevAgent.id) : ''" @click="prevAgent && emit('switch', prevAgent.id)"><Icon name="chevron-left" :size="13" /><span>上一个</span></button>
      <button class="agent-nav-btn" :disabled="!nextAgent" :title="nextAgent ? '下一个：' + (nextAgent.name || nextAgent.id) : ''" @click="nextAgent && emit('switch', nextAgent.id)"><span>下一个</span><Icon name="chevron-right" :size="13" /></button>
    </div>

    <!-- Tabs -->
    <div class="agent-tabs">
      <button class="agent-tab" :class="{ active: tab === 'info' }" @click="tab = 'info'">基本信息</button>
      <button class="agent-tab" :class="{ active: tab === 'llm' }" @click="tab = 'llm'">模型</button>
      <button class="agent-tab" :class="{ active: tab === 'timer' }" @click="tab = 'timer'">定时任务</button>
      <button class="agent-tab" :class="{ active: tab === 'sec' }" @click="tab = 'sec'">安全</button>
      <button class="agent-tab" :class="{ active: tab === 'ext' }" @click="tab = 'ext'">扩展与工具</button>
    </div>

    <!-- ====== 页签内容（导航/页签固定，仅内容滚动） ====== -->
    <div class="agent-tab-body">
      <!-- ====== 基本信息 ====== -->
      <div v-if="tab === 'info'" class="agent-info">
      <div class="info-grid">
        <!-- 身份：头像 + 昵称/ID 合并 -->
        <div class="info-item info-identity">
          <div class="avatar-block">
            <label class="avatar-uploader" :title="avatarUploading ? '上传中...' : '点击更换头像'">
              <div class="avatar-preview">
                <img v-if="avatarPreview" :src="avatarPreview" :alt="raw.name || effective.name || agentId" @error="($event.target as HTMLImageElement).style.display='none'" />
                <span class="avatar-ph">{{ (raw.name || effective.name || agentId).charAt(0).toUpperCase() }}</span>
                <span v-if="avatarUploading" class="avatar-loading">上传中…</span>
              </div>
              <span class="avatar-hint">点击更换</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden @change="onAvatarFile" />
            </label>
            <button v-if="avatarPreview" class="avatar-remove-x" title="移除头像" @click="removeAvatar">×</button>
          </div>
          <div class="identity-fields">
            <input type="text" class="info-input" :value="raw.name ?? effective.name ?? ''" @input="emit('update:raw', { ...raw, name: ($event.target as HTMLInputElement).value })" placeholder="输入 Agent 昵称" />
            <div class="identity-id">{{ effective.agent_id ?? agentId }}</div>
          </div>
          <div v-if="avatarError" class="info-error">{{ avatarError }}</div>
        </div>

        <!-- 能力标签 -->
        <div class="info-item">
          <div class="info-label">能力标签</div>
          <div class="info-desc">组合式能力声明（工具按 requires 匹配）：点击启用/关闭，可自定义领域标签</div>
          <div class="tag-badges">
            <button
              v-for="b in toolTagBadges" :key="b.tag" type="button"
              class="tag-badge" :class="{ on: b.fixed || (raw.tags ?? []).includes(b.tag) }"
              :title="b.fixed ? '基础标签，始终启用' : (raw.tags ?? []).includes(b.tag) ? '点击移除' : '点击启用'"
              @click="toggleToolTag(b.tag, b.fixed)"
            >{{ b.label }}</button>
          </div>
          <div class="tag-custom">
            <input v-model="customTagInput" type="text" class="info-input" placeholder="自定义领域标签（如 sap / math / qa），回车添加" @keyup.enter="addCustomTag" />
            <div v-if="customTags.length" class="tag-chips">
              <span v-for="t in customTags" :key="t" class="tag-chip">{{ t }}<button type="button" class="tag-chip-x" @click="removeTag(t)">×</button></span>
            </div>
          </div>
        </div>

        <!-- SYSTEM.md -->
        <div class="info-item">
          <div class="info-label">SYSTEM.md</div>
          <div class="info-desc">覆盖 builtin.build-system-prompt 装配的系统提示词</div>
          <label class="info-toggle"><input type="checkbox" :checked="sysEnabled" @change="emit('update:sysEnabled', ($event.target as HTMLInputElement).checked)" /><span>启用自定义内容</span></label>
          <textarea v-if="sysEnabled" class="info-textarea code" rows="11" :value="sysContent" @input="emit('update:sysContent', ($event.target as HTMLTextAreaElement).value)" placeholder="输入 SYSTEM.md 内容..."></textarea>
        </div>

        <!-- AGENT.md -->
        <div class="info-item">
          <div class="info-label">AGENT.md</div>
          <div class="info-desc">定义 Agent 的角色、行为和能力边界</div>
          <label class="info-toggle"><input type="checkbox" :checked="agentEnabled" @change="emit('update:agentEnabled', ($event.target as HTMLInputElement).checked)" /><span>启用自定义内容</span></label>
          <textarea v-if="agentEnabled" class="info-textarea code" rows="11" :value="agentContent" @input="emit('update:agentContent', ($event.target as HTMLTextAreaElement).value)" placeholder="输入 AGENT.md 内容..."></textarea>
        </div>
      </div>
    </div>

    <!-- ====== 模型 ====== -->
    <div v-else-if="tab === 'llm'" class="llm-pane">
      <div v-if="llmFields.length > 0" class="llm-fields">
        <template v-for="s in llmSections" :key="s.type === 'title' ? 't-' + s.label : (s.type === 'pool' ? 'pool' : s.f.key)">
          <!-- 模型池：字段项（选择池预设） -->
          <div v-if="s.type === 'pool'" class="llm-item">
            <div class="info-label">模型</div>
            <div class="info-desc">选择池预设；"默认"则继承全局配置</div>
            <div class="llm-control">
              <select class="info-input llm-pool-select" :value="selectedLlmPool" @change="applyLlmPool(($event.target as HTMLSelectElement).value)">
                <option value="">默认（继承全局）</option>
                <option v-for="(entry, name) in pools.llmProviders" :key="name" :value="name">{{ name }}{{ entry.model && entry.model !== name ? ' · ' + entry.model : '' }}</option>
              </select>
            </div>
            <div v-if="llmEffectiveSummary" class="llm-effective">
              <span class="llm-effective-dot"></span>
              当前生效：<strong>{{ llmEffectiveSummary.model || llmEffectiveSummary.provider }}</strong>
              <span class="llm-effective-src">· {{ llmEffectiveSummary.provider }} · {{ llmEffectiveSummary.source }}</span>
            </div>
          </div>
          <div v-else-if="s.type === 'title'" class="llm-group-title">{{ s.label }}</div>
          <div v-else class="llm-item" :class="{ 'is-non-default': isLlmOverridden(s.f.key) }">
            <div class="info-label">
              {{ s.f.label }}
              <span class="llm-source" :class="isLlmOverridden(s.f.key) ? 'is-override' : 'is-inherit'">{{ isLlmOverridden(s.f.key) ? '本 Agent' : '继承' }}</span>
            </div>
            <div v-if="s.f.description" class="info-desc">{{ s.f.description }}</div>
            <div class="llm-control">
              <SettingField :field="s.f" :model-value="getLLM(s.f.key)" @update:model-value="setLLM(s.f.key, $event)" />
              <button v-if="s.f.key === 'model'" class="llm-models-btn" :disabled="llmModelsLoading" title="从 API 地址读取模型列表" @click="loadModelsFromApi">{{ llmModelsLoading ? '读取中…' : '读取' }}</button>
              <button v-if="isLlmOverridden(s.f.key)" class="llm-reset" title="恢复为继承（删除本 Agent 覆盖，回退全局/池）" @click="revertLlmToInherit(s.f.key)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </button>
            </div>
            <div v-if="s.f.key === 'model' && llmModelsError" class="info-error">{{ llmModelsError }}</div>
            <select v-if="s.f.key === 'model' && llmModelOptions.length" class="info-input llm-models-select" :value="getLLM('model')" @change="setLLM('model', ($event.target as HTMLSelectElement).value)">
              <option v-for="m in llmModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </template>
        <div v-if="llmFiltered.length === 0" class="llm-empty">未找到匹配的设置</div>
      </div>
      <div v-else class="llm-empty">当前模型无可用配置项</div>
    </div>

    <!-- ====== 定时任务 ====== -->
    <div v-else-if="tab === 'timer'">
      <TimerPane :entries="timers" :saving="saving" @update:entries="emit('update:timers', $event)" @save="emit('saveTimers')" />
    </div>

    <!-- ====== 安全 ====== -->
    <div v-else-if="tab === 'sec'" class="agent-sec">
      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">路径穿透白名单</div>
          <div class="info-desc">允许 Agent 的工具访问工作区之外的路径。每行一个路径，留空则仅允许工作区内。</div>
          <textarea :value="allowedPathsDraft" @input="onAllowedPathsInput" class="info-textarea code" rows="6" placeholder="例如：&#10;/tmp/agent_scratch/&#10;../shared_data/"></textarea>
          <div v-if="(raw.allowedPaths?.length ?? 0) > 0" class="info-hint">已配置 {{ raw.allowedPaths.length }} 个白名单路径</div>
        </div>
      </div>
    </div>

        <!-- ====== 扩展与工具 ====== -->
      <div v-else class="ext-pane">
        <ExtToolsPane
          mode="agent"
          :hooks="plugins"
          :decl="builtinDecl()"
          :on-decl="patchBuiltin"
          :tools="agentTools ?? { catalog: [], enabled: [], explicit: [] }"
          :tags="raw.tags"
          :ns-schemas="nsSchemas"
          :config="globalConfig"
          :allowed-paths="raw.allowedPaths"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-pane { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; overflow: hidden; }
/* 页签内容统一滚动容器：顶部导航/页签固定，仅内容区滚动 */
.agent-tab-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

/* 顶部导航：返回 + 切换 Agent + 保存 */
.agent-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agent-nav-back { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast, .12s); flex-shrink: 0; }
.agent-nav-back:hover { background: var(--bg-hover); color: var(--text-1); }
.agent-nav-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
.agent-nav-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.agent-nav-spacer { flex: 1; }
.agent-nav-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: none; border-radius: var(--r-md); background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; transition: all var(--dur-fast, .12s); }
.agent-nav-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.agent-nav-btn:disabled { opacity: .4; cursor: not-allowed; }

/* 模型高级参数折叠（已废弃：分组化替代） */

/* Tabs（下划线式） */
.agent-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); }
.agent-tab {
  padding: 8px 16px; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--text-2); font-size: 13px; cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.agent-tab:hover { color: var(--text-1); background: var(--bg-hover); border-radius: var(--r-sm) var(--r-sm) 0 0; }
.agent-tab.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 500; }

/* Info */
.info-grid { display: flex; flex-direction: column; gap: 2px; }
.info-item { padding: 9px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.info-item:last-child { border-bottom: none; }
.info-label { font-size: 13px; font-weight: 500; color: var(--text-1); }
.info-desc { font-size: 11px; color: var(--text-3); }
.info-hint { font-size: 12px; color: var(--text-3); }
.info-error { color: var(--err); font-size: 12px; }
.info-input, .info-select {
  padding: 6px 9px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.info-input:focus, .info-select:focus { outline: none; border-color: var(--input-focus); box-shadow: 0 0 0 3px var(--primary-light); }
.info-input:disabled { opacity: .55; cursor: not-allowed; }
.info-textarea {
  width: 100%; padding: 8px; border: 1px solid var(--input-border); border-radius: var(--r-sm);
  background: var(--input-bg); color: var(--text-1); font-size: 13px;
  resize: vertical; line-height: 1.5;
}
.info-textarea:focus { outline: none; border-color: var(--input-focus); }
.info-textarea.code { font-family: var(--font-mono); }
.info-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.info-toggle input { accent-color: var(--primary); }

/* Avatar（合并布局：点击头像更换 + hover 删除） */
.info-identity { flex-direction: row; align-items: flex-start; gap: 16px; }
.avatar-block { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.avatar-uploader { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; }
.avatar-preview {
  width: 56px; height: 56px; border-radius: var(--r-md); overflow: hidden;
  background: var(--primary-light); display: flex; align-items: center; justify-content: center;
  position: relative; flex-shrink: 0; transition: box-shadow var(--dur-fast);
}
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; position: relative; z-index: 1; }
.avatar-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; color: var(--primary); }
.avatar-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; background: rgba(0,0,0,.5); border-radius: var(--r-md); z-index: 2; }
.avatar-hint { font-size: 10px; color: var(--text-3); transition: color var(--dur-fast); }
.avatar-uploader:hover .avatar-preview { box-shadow: 0 0 0 3px var(--primary-light, rgba(99,102,241,.15)); }
.avatar-uploader:hover .avatar-hint { color: var(--primary); }
.avatar-remove-x {
  position: absolute; top: -5px; right: -5px; width: 16px; height: 16px; border-radius: 50%;
  border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--text-3);
  font-size: 11px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  opacity: 0; z-index: 3;
  transition: opacity var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
}
.avatar-block:hover .avatar-remove-x { opacity: 1; }
.avatar-remove-x:hover { color: var(--err); border-color: var(--err); }
.identity-fields { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; padding-top: 6px; }
.identity-id { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Tags：能力标签徽章（与 tag-chip 风格一致）+ 自定义 chips */
.tag-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-badge {
  padding: 2px 9px; border-radius: var(--r-full); font-size: 11px; cursor: pointer;
  background: var(--bg-hover); border: none; color: var(--text-2);
  transition: all var(--dur-fast);
}
.tag-badge:hover { background: var(--primary-light); color: var(--primary); }
.tag-badge.on { background: var(--primary-light); color: var(--primary); font-weight: 500; }
.tag-custom { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.tag-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: var(--r-full);
  background: var(--bg-hover); border: none; font-size: 11px; color: var(--text-1);
}
.tag-chip-x { border: none; background: none; cursor: pointer; color: var(--text-2); font-size: 13px; padding: 0 2px; }
.tag-chip-x:hover { color: var(--err); }

/* LLM */
.llm-pane { display: flex; flex-direction: column; gap: 12px; }

/* 模型池字段项 */
.llm-pool-select { flex-shrink: 0; min-width: 180px; max-width: 280px; }
.llm-effective {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  font-size: 12px; color: var(--text-2);
  padding: 4px 10px; background: var(--primary-light, rgba(99,102,241,.08));
  border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
  border-radius: var(--r-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.llm-effective .llm-effective-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-effective-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 6px var(--primary); flex-shrink: 0; }
.llm-effective strong { color: var(--text-1); font-weight: 600; }
.llm-effective-src { color: var(--text-3); }

/* 分组标题（采样/边界/推理） */
.llm-group-title {
  margin-top: 8px; padding: 4px 0 4px 10px; border-left: 3px solid var(--primary);
  font-size: 12px; font-weight: 600; color: var(--text-2);
}
.llm-group-title:first-child { margin-top: 0; }

/* 模型读取按钮/下拉 */
.llm-models-btn {
  padding: 4px 10px; border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11px; cursor: pointer; flex-shrink: 0;
  transition: all var(--dur-fast);
}
.llm-models-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-1); }
.llm-models-btn:disabled { opacity: .5; cursor: not-allowed; }
.llm-models-select { margin-top: 6px; max-width: 320px; }
.llm-source {
  margin-left: 6px; padding: 0 7px; border-radius: var(--r-full);
  font-size: 10px; font-weight: 400; line-height: 1.6; vertical-align: 1px;
}
.llm-source.is-override { color: var(--primary); background: var(--primary-light); border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent); }
.llm-source.is-inherit { color: var(--text-3); background: var(--bg-hover); }
.llm-fields { display: flex; flex-direction: column; gap: 2px; }
.llm-item { padding: 8px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; border-left: 3px solid transparent; }
.llm-item.is-non-default { border-left-color: var(--primary); }
.llm-control { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.llm-reset {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 1px solid var(--line-strong); border-radius: var(--r-md); color: var(--text-3); cursor: pointer;
}
.llm-reset:hover { background: var(--bg-hover); color: var(--primary); }
.llm-empty { text-align: center; padding: 20px; color: var(--text-3); font-size: 13px; }


</style>
