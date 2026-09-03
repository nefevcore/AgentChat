<script setup lang="ts">
// ============================================================
// ExtensionSettingsModal.vue —— 配置弹窗双实例（M24 P4）
//   · mode 'global'（插件库「插件配置」· 插件卡片）：全局默认层——写
//     config/set → settings.<configNs>，文案"全局默认，Agent 层覆盖"。
//   · mode 'agent'（Agent「插件配置」· 插件卡片）：差异层——写
//     agents/update-config（assembly 契约），文案"只存差异项，空 = 继承
//     全局默认"；生效 = settingsOf 合成。
// 启停不在此弹窗（2026-10 双实例统一移除 enabled 分区——两处卡片行尾
// 各有软停用开关，弹窗勾选与之重复）：软停用 = 卡片行尾开关
// （settings.enabled 行为门控）；强制停用 = 插件库「插件目录」页签
// （cordis.patch.yml）。已存的 enabled 值不受影响（draft 为全量快照，
// 未渲染字段原样带回保存）。
// 数据源 = 扩展目录条目（A1 注册制：行包自述 extension 经 registry 聚合；
// fields 声明 + configNs 锚点；字段级描述与类型提示 type/enum/min/max/
// step/default 随目录透出——按声明渲染控件：布尔/数字/枚举下拉/列表 chips/
// JSON 校验/多行文本，未声明时按现值推断兜底。缺省值呈现：常显缺省行 +
// 已自定义/覆盖中标记 + 恢复缺省（清键）；agent 模式附生效值三层归因
// （本 Agent 差异 / 全局默认 / 行缺省——前端合成，零后端）。
// ============================================================
import { ref, watch, computed } from 'vue';
import type { ExtensionEntry } from '../types';
import * as api from '../api';
import { Modal, Button, Icon } from '@/ui';
import EntryPickerModal from './EntryPickerModal.vue';

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

/** 字段定义归一（string | {name, 描述, 类型/缺省提示} → 对象） */
interface NormField {
  name: string;
  description?: string;
  type?: 'string' | 'text' | 'number' | 'boolean' | 'list' | 'json' | 'file';
  enum?: string[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
}
const fieldDefs = computed<NormField[]>(() =>
  (props.entry?.fields ?? []).map((f) => (typeof f === 'string' ? { name: f } : f)),
);
/** 参数分区：全部声明字段；enabled（行为门控）不渲染——启停在卡片行尾开关 */
const paramDefs = computed(() => fieldDefs.value.filter((f) => f.name !== 'enabled'));

function descOf(f: { name: string; description?: string }): string {
  return f.description ?? '';
}

// ── 控件类型：声明优先（type/enum），未声明按现值推断（存量值兜底） ──
type FieldKind = 'bool' | 'number' | 'enum' | 'list' | 'json' | 'text' | 'string' | 'file';
const KIND_LABELS: Record<FieldKind, string> = {
  bool: '布尔', number: '数字', enum: '枚举', list: '列表', json: 'JSON', text: '多行', string: '文本', file: '文件',
};
function kindOf(f: NormField): FieldKind {
  if (f.enum?.length) return 'enum';
  const v = draft.value[f.name];
  if (f.type === 'boolean') return 'bool';
  if (f.type) return f.type;
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'list';
  if (v !== null && typeof v === 'object') return 'json';
  return 'string';
}
/** 类型徽记悬浮提示：枚举候选 / 数字范围 */
function kindTitle(f: NormField): string {
  const parts: string[] = [];
  if (f.enum?.length) parts.push(`候选：${f.enum.join(' / ')}`);
  if (f.type === 'number' && (f.min !== undefined || f.max !== undefined)) {
    parts.push(`范围：${f.min ?? '−∞'} ~ ${f.max ?? '∞'}${f.step ? `（步进 ${f.step}）` : ''}`);
  }
  return parts.join('；');
}

// ── 缺省值呈现：常显缺省行 + 已自定义/覆盖中标记 + 恢复缺省（清键）──
/** 值格式化（缺省行 / 归因行 / 枚举空选项标签共用） */
function fmtVal(v: unknown): string {
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (v === undefined || v === null || v === '') return '（空）';
  if (Array.isArray(v)) return v.length ? v.map(String).join('、') : '（空列表）';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
/** 值相等（标量/JSON 序列化对比——"已自定义"判定用） */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** 本字段已显式配置（draft 有键） */
function isSet(f: NormField): boolean {
  return draft.value[f.name] !== undefined;
}
/** agent 模式归因：差异层之下的继承基准（全局默认层值 ?? 行缺省） */
function inheritedOf(f: NormField): { value: unknown; source: '全局默认' | '行缺省' } | undefined {
  const ns = props.entry?.configNs ?? props.entry?.name;
  const g = ns ? globalLayer.value[ns] : undefined;
  const gv = g && typeof g === 'object' && !Array.isArray(g) ? (g as Record<string, unknown>)[f.name] : undefined;
  if (gv !== undefined) return { value: gv, source: '全局默认' };
  if (f.default !== undefined) return { value: f.default, source: '行缺省' };
  return undefined;
}
/** 字段元信息行文本：global = 缺省；agent = 生效值 + 来源归因 */
function metaText(f: NormField): string {
  if (isAgent.value) {
    if (isSet(f)) return `生效 ${fmtVal(fieldValue(f.name))} · 本 Agent 差异`;
    const inh = inheritedOf(f);
    if (inh) return `生效 ${fmtVal(inh.value)} · ${inh.source}`;
    return '未配置';
  }
  if (f.default !== undefined) return `缺省 ${fmtVal(f.default)}`;
  return isSet(f) ? '已配置（行未声明缺省）' : '';
}
/** 自定义标记：global = 与行缺省不同；agent = 差异层覆盖了下层继承值 */
function metaMark(f: NormField): string {
  if (!isSet(f)) return '';
  if (isAgent.value) {
    const inh = inheritedOf(f);
    return inh && !sameValue(draft.value[f.name], inh.value) ? '覆盖中' : '';
  }
  return f.default !== undefined && !sameValue(draft.value[f.name], f.default) ? '已自定义' : '';
}
/** 恢复缺省 = 清键（global 回归行缺省；agent 回归继承：全局默认 ?? 行缺省） */
function restoreDefault(f: NormField): void {
  delete draft.value[f.name];
  delete jsonRaw.value[f.name];
  delete jsonErr.value[f.name];
  delete listInput.value[f.name];
}

// ── 文件路径选择（type:'file'——EntryPickerModal 服务端浏览，裸名/绝对路径均可手输） ──
const pickField = ref<NormField | null>(null);
function onFilePicked(p: string): void {
  const f = pickField.value;
  if (f) draft.value[f.name] = p;
}
/** 枚举候选：声明集 ∪ 现值（现值不在声明集时置顶保留——不丢存量配置） */
function enumOpts(f: NormField): string[] {
  const v = draft.value[f.name];
  const declared = f.enum ?? [];
  return typeof v === 'string' && v && !declared.includes(v) ? [v, ...declared] : declared;
}

function fieldValue(f: string): unknown {
  return draft.value[f];
}
function textOf(f: string): string {
  const v = draft.value[f];
  return v === undefined || v === null ? '' : String(v);
}
function setBool(f: string, on: boolean): void {
  draft.value[f] = on;
}
/** 布尔字段勾选态 = 当前生效值：显式配置优先；未配置回退生效基准
 *  （global = 行缺省；agent = 全局默认层 ?? 行缺省）——默认"开"的选项
 *  勾选框也默认勾选（首次点按 = 写显式值；不动 = 仍走继承，保存零差异） */
function boolOn(f: NormField): boolean {
  const v = draft.value[f.name];
  if (typeof v === 'boolean') return v;
  if (isAgent.value) {
    const inherited = inheritedOf(f);
    if (inherited) return inherited.value === true;
  }
  return f.default === true;
}
function setField(f: string, raw: string): void {
  draft.value[f] = raw === '' ? undefined : raw;
}
function setNum(f: string, raw: string): void {
  if (raw === '') { delete draft.value[f]; return; }
  const n = Number(raw);
  draft.value[f] = Number.isFinite(n) ? n : undefined;
}
function setEnum(f: string, raw: string): void {
  if (raw === '') delete draft.value[f];
  else draft.value[f] = raw;
}

// ── 列表 chips 编辑（声明 list / 现值为数组） ──
const listInput = ref<Record<string, string>>({});
function listVal(f: NormField): string[] {
  const v = draft.value[f.name];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function addListItem(f: NormField): void {
  const raw = (listInput.value[f.name] ?? '').trim();
  if (!raw) return;
  const cur = listVal(f);
  if (!cur.includes(raw)) cur.push(raw);
  draft.value[f.name] = cur;
  listInput.value[f.name] = '';
}
function removeListItem(f: NormField, item: string): void {
  draft.value[f.name] = listVal(f).filter((x) => x !== item);
}

// ── JSON 编辑（声明 json / 现值为对象）——原文暂存 + 即时校验，无效阻止保存 ──
const jsonRaw = ref<Record<string, string>>({});
const jsonErr = ref<Record<string, string>>({});
const jsonInvalid = computed(() => Object.values(jsonErr.value).some((x) => x !== ''));
function jsonTextOf(f: NormField): string {
  if (jsonRaw.value[f.name] !== undefined) return jsonRaw.value[f.name];
  const v = draft.value[f.name];
  if (v === undefined || v === null || v === '') return '';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function setJson(f: NormField, raw: string): void {
  jsonRaw.value[f.name] = raw;
  if (raw.trim() === '') { delete draft.value[f.name]; jsonErr.value[f.name] = ''; return; }
  try {
    draft.value[f.name] = JSON.parse(raw);
    jsonErr.value[f.name] = '';
  } catch (e: any) {
    jsonErr.value[f.name] = `JSON 无效：${e.message}`;
  }
}

/** agent 模式归因数据：全局默认层现值（差异层之下的继承基准；fail-soft） */
const globalLayer = ref<Record<string, unknown>>({});

// 全局模式：打开时拉当前全局默认层；agent 模式：差异层快照进 draft + 全局层归因
watch(
  () => [props.entry, props.mode, props.agentValue] as const,
  async ([entry, mode]) => {
    if (!entry) return;
    error.value = '';
    // 编辑态复位（JSON 原文/校验、列表输入——防跨条目串味）
    jsonRaw.value = {};
    jsonErr.value = {};
    listInput.value = {};
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
      try { globalLayer.value = await api.getGlobalSettings(); } catch { globalLayer.value = {}; }
    }
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const entry = props.entry;
  if (!entry) return;
  // 清 undefined（未携带 = 不动）；agent 差异层【空值 = 显式清除该字段】：
  // 空列表/空串/空对象发 null（后端字段级删除语义），而非原样落盘——
  // 差异层 `allowedPaths: []` 会按 settingsOf"数组整体替换"顶掉全局默认层
  // 授予（UI 物化未填列表为 [] 的陷阱），且浅合并无删除出口时脏键永存。
  // 全局默认层保持原样：空数组 = 合法的"清空默认"表达。
  const isEmptyValue = (v: unknown): boolean =>
    Array.isArray(v)
      ? v.length === 0
      : v === '' || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft.value)) {
    if (v === undefined) continue;
    if (isAgent.value && isEmptyValue(v)) {
      clean[k] = null;
      continue;
    }
    clean[k] = v;
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
    :width="520"
    :z-index="1250"
    @close="emit('close')"
  >
    <div class="esm-body" v-if="entry">
      <div class="esm-note">
        <template v-if="isAgent">
          只存差异项（空 = 继承全局默认）；生效 = settingsOf 合成（全局默认 ∪ 差异层，差异优先）。保存写 agents/update-config。
          启停不在此弹窗：本页卡片行尾软停用开关。
        </template>
        <template v-else>
          全局默认，Agent 层覆盖——保存写 config.json → settings.{{ entry.configNs ?? entry.name }}（config/changed 热更）。
          启停不在此弹窗：软停用 = 卡片行尾开关；强制停用 = 插件库「插件目录」页签。
        </template>
      </div>
      <div class="esm-desc">{{ entry.description }}</div>

      <!-- 参数分区（字段级描述 + 按声明类型/现值推断渲染控件：
           布尔/数字/枚举下拉/列表 chips/JSON 校验/多行文本/单行文本） -->
      <div v-if="paramDefs.length > 0" class="esm-section">
        <div class="esm-section-title">参数</div>
        <div v-for="f in paramDefs" :key="f.name" class="esm-field">
          <div class="esm-field-label">
            <code>{{ f.name }}</code>
            <span class="ui-badge kind" :title="kindTitle(f)">{{ KIND_LABELS[kindOf(f)] }}</span>
          </div>
          <div v-if="descOf(f)" class="esm-field-desc">{{ descOf(f) }}</div>
          <!-- 元信息行：缺省值常显（不随输入消失）+ 已自定义/覆盖中标记 +
               恢复缺省（清键）。agent 模式 = 生效值 + 三层归因
               （本 Agent 差异 / 全局默认 / 行缺省） -->
          <div v-if="metaText(f) || metaMark(f) || isSet(f)" class="esm-field-meta">
            <span v-if="metaText(f)">{{ metaText(f) }}</span>
            <span v-if="metaMark(f)" class="esm-meta-mark">{{ metaMark(f) }}</span>
            <button
              v-if="isSet(f)"
              class="esm-restore"
              type="button"
              :title="isAgent
                ? '清除本 Agent 差异键——回归继承（全局默认 ?? 行缺省）'
                : '清除全局配置键——回归行缺省'"
              @click="restoreDefault(f)"
            >恢复缺省</button>
          </div>

          <!-- 布尔（勾选态 = 生效值：显式配置优先，未配置回退行缺省/继承——
               默认"开"的选项勾选框默认勾选；点按 = 写显式值） -->
          <label v-if="kindOf(f) === 'bool'" class="esm-bool">
            <input
              type="checkbox"
              :checked="boolOn(f)"
              @change="setBool(f.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="esm-bool-note">开</span>
          </label>

          <!-- 枚举下拉 -->
          <select
            v-else-if="kindOf(f) === 'enum'"
            class="esm-input"
            :value="textOf(f.name)"
            @change="setEnum(f.name, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ f.default !== undefined ? `未配置（缺省 ${fmtVal(f.default)}）` : '未配置（继承缺省）' }}</option>
            <option v-for="opt in enumOpts(f)" :key="opt" :value="opt">{{ opt }}</option>
          </select>

          <!-- 数字（声明 min/max/step 时带范围与步进） -->
          <input
            v-else-if="kindOf(f) === 'number'"
            class="esm-input"
            type="number"
            placeholder="未配置（继承缺省）"
            :min="f.min"
            :max="f.max"
            :step="f.step"
            :value="textOf(f.name)"
            @change="setNum(f.name, ($event.target as HTMLInputElement).value)"
          />

          <!-- 列表 chips -->
          <div v-else-if="kindOf(f) === 'list'" class="esm-list">
            <div v-if="listVal(f).length" class="esm-chips">
              <span v-for="item in listVal(f)" :key="item" class="esm-chip">
                {{ item }}
                <button class="esm-chip-x" type="button" title="移除" @click="removeListItem(f, item)"><Icon name="x" :size="10" /></button>
              </span>
            </div>
            <div class="esm-list-add">
              <input
                class="esm-input esm-list-input"
                type="text"
                placeholder="输入后回车或点添加"
                v-model="listInput[f.name]"
                @keyup.enter="addListItem(f)"
              />
              <button class="esm-add-btn" type="button" @click="addListItem(f)">添加</button>
            </div>
          </div>

          <!-- JSON（对象/数组——即时校验，无效阻止保存） -->
          <template v-else-if="kindOf(f) === 'json'">
            <textarea
              class="esm-input esm-textarea esm-json"
              rows="5"
              spellcheck="false"
              placeholder="未配置（继承缺省）——对象/数组，JSON 格式"
              :value="jsonTextOf(f)"
              @change="setJson(f, ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
            <div v-if="jsonErr[f.name]" class="esm-error">{{ jsonErr[f.name] }}（保存被阻止——修正或清空）</div>
          </template>

          <!-- 文件路径（type:'file'：手输 + 「浏览…」服务端文件选择） -->
          <div v-else-if="kindOf(f) === 'file'" class="esm-file-row">
            <input
              class="esm-input esm-file-input"
              type="text"
              placeholder="未配置（继承缺省）——裸名走 Agent 目录，或绝对路径"
              :value="textOf(f.name)"
              @change="setField(f.name, ($event.target as HTMLInputElement).value)"
            />
            <button class="esm-browse-btn" type="button" title="浏览本机文件选择路径（workspace/browse-dirs）" @click="pickField = f">
              <Icon name="folder-open" :size="12" />浏览…
            </button>
          </div>

          <!-- 多行文本 -->
          <textarea
            v-else-if="kindOf(f) === 'text'"
            class="esm-input esm-textarea"
            rows="4"
            placeholder="未配置（继承缺省）"
            :value="textOf(f.name)"
            @change="setField(f.name, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>

          <!-- 单行文本 -->
          <input
            v-else
            class="esm-input"
            type="text"
            placeholder="未配置（继承缺省）"
            :value="textOf(f.name)"
            @change="setField(f.name, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <div v-if="paramDefs.length === 0" class="esm-none">
        {{ isAgent
          ? '此行无声明参数——启停 = 本页卡片行尾软停用开关'
          : '本行无参数配置——启停入口：软停用 = 卡片行尾开关；强制停用 = 插件库「插件目录」页签' }}
      </div>
      <div v-if="error" class="esm-error">{{ error }}</div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">取消</Button>
      <Button variant="primary" :disabled="saving || jsonInvalid" @click="save">{{ saving ? '保存中…' : isAgent ? '保存（agents/update-config）' : '保存（config/set）' }}</Button>
    </template>
  </Modal>

  <!-- 文件路径选择（type:'file' 字段的「浏览…」——层叠在本弹窗之上） -->
  <EntryPickerModal
    :visible="!!pickField"
    mode="file"
    title="选择文件"
    :z-index="1300"
    @close="pickField = null"
    @pick="onFilePicked"
  />
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
.esm-field-label { font-size: 12px; color: var(--text-1); display: flex; align-items: center; }
.esm-field-label code { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); background: var(--bg-hover); padding: 1px 6px; border-radius: 999px; }
/* 字段类型徽记 = ui/badge.css .ui-badge.kind（统一徽章语言） */
.esm-field-desc { font-size: 11px; color: var(--text-3); line-height: 1.5; }
/* ── 字段元信息行（缺省值常显 + 标记 + 恢复缺省） ── */
.esm-field-meta { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--text-3); }
.esm-meta-mark { color: var(--warn); font-family: var(--font-mono); font-size: 10px; white-space: nowrap; }
.esm-restore {
  margin-left: auto; padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: 999px;
  background: transparent; color: var(--text-3); font-size: 10px; cursor: pointer; flex: none;
}
.esm-restore:hover { color: var(--text-1); background: var(--bg-hover); }
/* ── 文件路径字段（手输 + 浏览按钮） ── */
.esm-file-row { display: flex; align-items: center; gap: 6px; }
.esm-file-input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11px; }
.esm-browse-btn {
  display: inline-flex; align-items: center; gap: 4px; flex: none;
  padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11.5px; cursor: pointer;
}
.esm-browse-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.esm-bool { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.esm-bool input { accent-color: var(--primary); cursor: pointer; margin-top: 2px; }
.esm-bool-note { font-size: 12px; color: var(--text-2); line-height: 1.5; }
/* ── 列表 chips 编辑 ── */
.esm-list { display: flex; flex-direction: column; gap: 6px; }
.esm-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.esm-chip {
  display: inline-flex; align-items: center; gap: 2px;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  background: var(--bg-hover); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 4px 2px 9px; max-width: 100%;
  overflow-wrap: anywhere;
}
.esm-chip-x {
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-3); cursor: pointer;
  padding: 0 4px; border-radius: 999px;
}
.esm-chip-x:hover { color: var(--err); }
.esm-list-add { display: flex; gap: 6px; }
.esm-list-input { flex: 1; min-width: 0; }
.esm-add-btn {
  padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font-size: 11.5px; cursor: pointer; flex: none;
}
.esm-add-btn:hover { background: var(--bg-hover); color: var(--text-1); }
.esm-json { font-family: var(--font-mono); font-size: 11px; }
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
