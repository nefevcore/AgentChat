<script setup lang="ts">
// ============================================================
// ExtensionSettingsModal.vue —— 配置弹窗双实例（M24 P4）
//   · mode 'global'（插件库 · 插件卡片）：全局默认层——写 config/set →
//     settings.<configNs>，文案"全局默认，Agent 层覆盖"
//   · mode 'agent'（Agent 装配 · 插件卡片）：差异层——写
//     agents/update-config（assembly 契约），文案"只存差异项，空 = 继承
//     全局默认"；生效 = settingsOf 合成
// 数据源 = 扩展目录条目（A1 注册制：行包自述 extension 经 registry 聚合；
// fields 声明 + configNs 锚点；
// 2026-08-30 起字段级描述随目录透出，此处渲染）。
// enabled 与卡片 toggle 不冗余但分层：卡片 toggle = 装配开关（cordis.patch，
// 重启级）；本弹窗 enabled = 行为门控（软停用——行仍装载、监听器跳过，
// Agent 差异层可覆盖回 true）。分区渲染明示差异。
// ============================================================
import { ref, watch, computed } from 'vue';
import type { ExtensionEntry } from '../types';
import * as api from '../api';
import { Modal, Button } from '@/ui';

const props = defineProps<{
  entry: ExtensionEntry | null;
  mode: 'global' | 'agent';
  /** agent 模式：差异层现值（decl.settings[name]） */
  agentValue?: Record<string, unknown>;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  /** agent 模式：差异层补丁（per-name 浅合并 / null 删除键由调用方组） */
  (e: 'patch', name: string, next: Record<string, unknown> | null): void;
  (e: 'saved'): void;
}>();

const isAgent = computed(() => props.mode === 'agent');
const draft = ref<Record<string, unknown>>({});
const saving = ref(false);
const error = ref('');

/** 字段定义归一（string | {name, description} → {name, description}） */
const fieldDefs = computed(() =>
  (props.entry?.fields ?? []).map((f) => (typeof f === 'string' ? { name: f } : f)),
);
/** 行为门控分区：enabled 单独渲染（与卡片装配开关分层） */
const enabledDef = computed(() => fieldDefs.value.find((f) => f.name === 'enabled'));
/** 参数分区：enabled 以外的字段 */
const paramDefs = computed(() => fieldDefs.value.filter((f) => f.name !== 'enabled'));

function descOf(f: { name: string; description?: string }): string {
  if (f.description) return f.description;
  if (f.name === 'enabled') return '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层';
  return '';
}

// 全局模式：打开时拉当前全局默认层；agent 模式：差异层快照进 draft
watch(
  () => [props.entry, props.mode, props.agentValue] as const,
  async ([entry, mode]) => {
    if (!entry) return;
    error.value = '';
    if (mode === 'global') {
      try {
        const all = await api.getGlobalSettings();
        const v = all?.[entry.configNs ?? entry.name];
        draft.value = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
      } catch (e: any) {
        error.value = `读取全局默认层失败: ${e.message}`;
        draft.value = {};
      }
    } else {
      draft.value = { ...(props.agentValue ?? {}) };
    }
  },
  { immediate: true },
);

function fieldValue(f: string): unknown {
  return draft.value[f];
}
function isBool(f: string): boolean {
  return typeof draft.value[f] === 'boolean' || f === 'enabled';
}
function isNum(f: string): boolean {
  return typeof draft.value[f] === 'number';
}
function isList(f: string): boolean {
  return Array.isArray(draft.value[f]);
}
function textOf(f: string): string {
  const v = draft.value[f];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join('\n') : v === undefined || v === null ? '' : String(v);
}
function setField(f: string, raw: string): void {
  if (isList(f)) {
    draft.value[f] = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    return;
  }
  if (isNum(f)) {
    const n = Number(raw);
    draft.value[f] = Number.isFinite(n) ? n : undefined;
    return;
  }
  draft.value[f] = raw === '' ? undefined : raw;
}
function setBool(f: string, on: boolean): void {
  draft.value[f] = on;
}

async function save(): Promise<void> {
  const entry = props.entry;
  if (!entry) return;
  // 清 undefined（空文本 = 恢复继承/默认）
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft.value)) {
    if (v !== undefined) clean[k] = v;
  }
  saving.value = true;
  error.value = '';
  try {
    if (isAgent.value) {
      emit('patch', entry.name, Object.keys(clean).length > 0 ? clean : null);
    } else {
      await api.setGlobalSetting(entry.configNs ?? entry.name, Object.keys(clean).length > 0 ? clean : null);
    }
    emit('saved');
    emit('close');
  } catch (e: any) {
    error.value = `保存失败: ${e.message}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :visible="!!entry"
    :title="entry ? `${entry.label} · ${isAgent ? '本 Agent 设置（差异层）' : '可配置项（全局默认层）'}` : ''"
    :width="460"
    :z-index="1250"
    @close="emit('close')"
  >
    <div class="esm-body" v-if="entry">
      <div class="esm-note">
        <template v-if="isAgent">
          只存差异项（空 = 继承全局默认）；生效 = settingsOf 合成（全局默认 ∪ 差异层，差异优先）。保存写 agents/update-config。
        </template>
        <template v-else>
          全局默认，Agent 层覆盖——保存写 config.json → settings.{{ entry.configNs ?? entry.name }}（config/changed 热更）。
        </template>
      </div>
      <div class="esm-desc">{{ entry.description }}</div>

      <!-- 行为开关分区（与卡片"装配开关"分层：装配 = 重启级；此处 = 软停用，Agent 可覆盖） -->
      <div v-if="enabledDef" class="esm-section">
        <div class="esm-section-title">行为开关（软停用）</div>
        <div class="esm-field esm-enabled-row">
          <label class="esm-bool">
            <input
              type="checkbox"
              :checked="fieldValue('enabled') === true"
              @change="setBool('enabled', ($event.target as HTMLInputElement).checked)"
            />
            <span class="esm-bool-note">
              启用本扩展的行为
              <span class="esm-field-desc-inline">{{ descOf(enabledDef) }}</span>
            </span>
          </label>
        </div>
      </div>

      <!-- 参数分区（字段级描述） -->
      <div v-if="paramDefs.length > 0" class="esm-section">
        <div class="esm-section-title">参数</div>
        <div v-for="f in paramDefs" :key="f.name" class="esm-field">
          <div class="esm-field-label"><code>{{ f.name }}</code></div>
          <div v-if="descOf(f)" class="esm-field-desc">{{ descOf(f) }}</div>
          <label v-if="isBool(f.name)" class="esm-bool">
            <input
              type="checkbox"
              :checked="fieldValue(f.name) === true"
              @change="setBool(f.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="esm-bool-note">开</span>
          </label>
          <textarea
            v-else-if="isList(f.name)"
            class="esm-input esm-textarea"
            rows="3"
            placeholder="每行一个值（留空 = 未配置）"
            :value="textOf(f.name)"
            @change="setField(f.name, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
          <input
            v-else
            class="esm-input"
            :type="isNum(f.name) ? 'number' : 'text'"
            placeholder="未配置（继承缺省）"
            :value="textOf(f.name)"
            @change="setField(f.name, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <div v-else-if="!enabledDef" class="esm-none">此行无声明参数</div>
      <div v-if="error" class="esm-error">{{ error }}</div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">取消</Button>
      <Button variant="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : isAgent ? '保存（agents/update-config）' : '保存（config/set）' }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.esm-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.esm-note {
  font-size: 11.5px; color: var(--warn); padding: 7px 10px; border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
}
.esm-desc { font-size: 12px; color: var(--text-3); }
.esm-section {
  border: 1px solid var(--line); border-radius: var(--r-md); padding: 9px 11px;
  display: flex; flex-direction: column; gap: 9px;
}
.esm-section-title {
  font-size: 10.5px; letter-spacing: .5px; color: var(--text-3);
  text-transform: uppercase; font-weight: 600;
}
.esm-field { display: flex; flex-direction: column; gap: 4px; }
.esm-field + .esm-field { margin-top: 4px; }
.esm-field-label { font-size: 12px; color: var(--text-1); }
.esm-field-label code { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); background: var(--bg-hover); padding: 1px 6px; border-radius: 999px; }
.esm-field-desc { font-size: 11px; color: var(--text-3); line-height: 1.5; }
.esm-field-desc-inline { display: block; font-size: 10.5px; color: var(--text-3); }
.esm-enabled-row { padding: 0; }
.esm-bool { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.esm-bool input { accent-color: var(--primary); cursor: pointer; margin-top: 2px; }
.esm-bool-note { font-size: 12px; color: var(--text-2); line-height: 1.5; }
.esm-input {
  padding: 5px 9px; font-size: 12px; color: var(--text-1);
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--input-bg, var(--bg-surface)); outline: none;
}
.esm-input:focus { border-color: var(--primary); }
.esm-textarea { resize: vertical; font-family: var(--font-mono); }
.esm-none { font-size: 12px; color: var(--text-3); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--r-sm); }
.esm-error { font-size: 12px; color: var(--err); }
</style>
