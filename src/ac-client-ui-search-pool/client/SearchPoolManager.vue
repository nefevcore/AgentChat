<script setup lang="ts">
// ============================================================
// SearchPoolManager.vue —— 搜索引擎池管理（2026-09-11 自 ui-llm-pool
// PoolManager〔kind='search'〕拆分行迁：模型池与搜索池两对象各自
// 成件——本件只含 search 形态，llm 连接管理留 ui-llm-pool
// PoolManager。行为与拆分前 kind='search' 分支逐字节等价。）
// · 条目 = 搜索引擎连接（provider 类型 + api_key〔凭据侧信道〕+
//   调优字段 defaultResults/defaultDepth/…）。
// · cr-299 抽取：编辑弹窗体拆往 SearchEntryForm.vue（设置弹窗与首启
//   向导第 3 步共用）；本件保留列表 + Modal 外壳 + 落盘编排。
// ============================================================
import { ref } from 'vue';
import type { PoolEntry } from 'ac-client-ui-settings/client/types.ts';
import { Button, Icon, Modal, toastOk } from '@agentchat/webui-kit';
import SearchEntryForm from './SearchEntryForm.vue';

const props = defineProps<{
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** provider → 原始 schema（真 schema 优先；空则基线 + 观测字段） */
  schemas: Record<string, any[]>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();

const title = '搜索引擎';

// ── 编辑弹窗状态（表单体 = SearchEntryForm）──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑

function startAdd() {
  editingName.value = '';
}
function startEdit(name: string) {
  editingName.value = name;
}
function cancelEdit() {
  editingName.value = null;
}

/** 表单体 save 落盘（守门已在表单内；此处只做池合并 + 默认标记） */
function onFormSave(name: string, entry: Record<string, any>): void {
  const pool = { ...props.pools };
  if (editingName.value && editingName.value !== name) {
    delete pool[editingName.value];
  }
  // 池中无条目时，首个自动设为默认
  const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
  if (existingKeys.length === 0 || (existingKeys.length === 1 && existingKeys[0] === name)) {
    entry.default = true;
    for (const k of existingKeys) {
      if (k !== name && pool[k].default) delete pool[k].default;
    }
  }
  pool[name] = entry as PoolEntry;
  emit('update:pools', pool);
  editingName.value = null;
  toastOk('已保存');
  props.onSaved?.();
}

/** 删除条目（搜索池无凭据联动/确认弹窗——与拆分前 kind='search'
 *  行为一致；llm 连接的确认 + 凭据删除留 ui-llm-pool） */
function removeEntry(name: string) {
  const pool = { ...props.pools };
  delete pool[name];
  emit('update:pools', pool);
  props.onSaved?.();
}

function setDefault(name: string) {
  const pool: Record<string, PoolEntry> = {};
  for (const [k, v] of Object.entries(props.pools)) {
    if (!k.startsWith('$') && typeof v === 'object') pool[k] = { ...v, default: k === name };
    else pool[k] = v;
  }
  emit('update:pools', pool);
  props.onSaved?.();
}

/** 条目 detail（列表第二行） */
function detailOf(name: string, entry: PoolEntry): string {
  void name;
  return `${entry.provider ?? ''}${entry.model && entry.model !== name ? ' / ' + entry.model : ''}`;
}
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <Button variant="primary" size="sm" icon="plus" @click="startAdd">添加</Button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">
      暂无条目，点击「添加」创建
    </div>
    <div v-else class="pool-list">
      <div
        v-for="(entry, name) in pools" :key="name"
        v-show="!String(name).startsWith('$')"
        class="pool-entry ui-row" :class="{ 'is-selected': entry.default }"
      >
        <div class="pool-entry-info">
          <span class="pool-entry-name">
            <span v-if="entry.default" class="pool-star" title="当前默认"><Icon name="star" :size="10" /></span>
            {{ name }}
          </span>
          <span class="pool-entry-detail">{{ detailOf(String(name), entry) }}</span>
        </div>
        <div class="pool-entry-actions">
          <Button v-if="!entry.default" variant="ghost" size="sm" icon="star" title="设为默认搜索引擎（全局缺省使用它）" @click="setDefault(String(name))">设为默认</Button>
          <Button variant="ghost" size="sm" @click="startEdit(String(name))">编辑</Button>
          <Button variant="danger" size="sm" @click="removeEntry(String(name))">删除</Button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（表单体 = SearchEntryForm——cr-299 抽取共用件） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <SearchEntryForm
          v-if="editingName !== null"
          :pools="pools"
          :schemas="schemas"
          :editing-name="editingName === '' ? null : editingName"
          @save="onFormSave"
          @cancel="cancelEdit()"
        />
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.pool { display: flex; flex-direction: column; gap: 12px; }
.pool-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.pool-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
/* 动作钮已归 kit Button（cr-171）；.pool-empty 空态保留 */
.pool-empty { text-align: center; padding: 24px; color: var(--text-3); font-size: 13px; }
.pool-list { display: flex; flex-direction: column; gap: 6px; }
.pool-entry {
  /* C8 收敛 A 语言：底座 = ui/row.css .ui-row（cr-171 起行语言无边框，星标走 --star 语义色） */
  justify-content: space-between; padding: 8px 12px;
}
.pool-entry-info { display: flex; flex-direction: column; gap: 2px; }
.pool-entry-name { font-size: 13px; font-weight: 500; color: var(--text-1); }
/* cr-172 实心星标：与 PoolManager 同款 */
.pool-star { color: var(--star); margin-right: 4px; display: inline-flex; align-items: center; }
.pool-star :deep(svg path) { fill: currentColor; }
.pool-entry-detail { font-size: 11px; color: var(--text-3); }
.pool-entry-actions { display: flex; gap: 6px; }
/* cr-169：表单控件已归 kit（Input/Select） */
.pool-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
</style>
