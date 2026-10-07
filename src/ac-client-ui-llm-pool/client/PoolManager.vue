<script setup lang="ts">
// ============================================================
// PoolManager.vue —— Provider 连接池管理（llm 连接专属）
//（M28 P2 自 settings 随域迁入 ui-llm-pool；2026-09-11 行拆分——
//  原 kind='llm'/'search' 双形态组件收窄为 llm 单形态，搜索引擎池
//  拆往 ac-client-ui-search-pool/SearchPoolManager——两对象两件，
//  行为与拆分前 kind='llm' 分支逐字节等价。）
// · 条目名 = provider 名；字段 = api_key（凭据侧信道）/ base_url /
//   defaultModel；模型清单由 /models 发现（「读取模型」经后端代理，
//   回写 config 发现缓存 → 热更重挂）。采样参数归 Agent 面，不在此。
// · cr-299 抽取：编辑弹窗体拆往 PoolEntryForm.vue（设置弹窗与首启
//   向导第 2 步共用）；本件保留列表 + Modal 外壳 + 保存落盘编排。
// ============================================================
import { ref } from 'vue';
import type { PoolEntry } from 'ac-client-ui-settings/client/types.ts';
import { Button, Icon, Modal, toastOk } from '@agentchat/webui-kit';
import ConfirmDialog from 'ac-client-ui-settings/client/components/ConfirmDialog.vue';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { deleteLlmPoolCredential, fetchPoolModels, fetchPoolReferences, poolModelEntries } from './poolApi.ts';
import PoolEntryForm from './PoolEntryForm.vue';

const props = defineProps<{
  /** 池数据（直接读写） */
  pools: Record<string, PoolEntry>;
  /** 保存回调（成功刷新后调用） */
  onSaved?: () => void;
}>();

const emit = defineEmits<{ (e: 'update:pools', v: Record<string, PoolEntry>): void }>();

const title = '模型管理（Provider 连接）';

// ── 编辑弹窗状态（表单体 = PoolEntryForm）──
const editingName = ref<string | null>(null); // null=列表视图, ''=新建, 'xxx'=编辑
const error = ref('');

function startAdd() {
  editingName.value = '';
}
function startEdit(name: string) {
  editingName.value = name;
}
function cancelEdit() {
  editingName.value = null;
}

/** 表单体 save 落盘（守门/字段归一已在表单内完成——此处只做池合并落盘） */
function onFormSave(name: string, entry: Record<string, any>): void {
  const pool = { ...props.pools };
  if (editingName.value && editingName.value !== name) {
    // 改名：条目内容（models 等）随 draft 落到新名；旧名凭据由服务端
    // 迁移（pool:<旧> → pool:<新>，见 ac-web-api extractPoolCredentials）
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
  // 落盘完成后，新建连接若无发现缓存 → 自动「读取模型」一次（静默失败：
  // key 无效时用户可经「读取模型」看重试报错）
  if (!(Array.isArray(entry.models) && entry.models.length > 0)) {
    void (async () => {
      try { await props.onSaved?.(); } catch { /* onSaved 自行提示 */ }
      try { await fetchPoolModels(name, true, defaultRpc); } catch { /* 静默 */ }
    })();
  } else {
    props.onSaved?.();
  }
}

/** 注册路径读取模型的服务端缓存回写（表单 models-cache 事件——原直写段迁回编排层） */
function onModelsCache(name: string, models: unknown[]): void {
  const pool = { ...props.pools };
  pool[name] = { ...(props.pools[name] ?? {}), models: models as never };
  emit('update:pools', pool);
  props.onSaved?.();
}

/** 删除连接：确认弹窗（引用清单）后同步删除凭据 pool:<名>——否则内置
 *  种子的 /models 发现回写会凭残留凭据把条目"复活" */
const confirmRef = ref<InstanceType<typeof ConfirmDialog> | null>(null);
async function removeEntry(name: string) {
  let refNote = '引用此 provider 的 Agent 将无法调用，需重新配置。';
  try {
    const { agents: refs } = await fetchPoolReferences(name, defaultRpc);
    if (refs.length > 0) {
      const names = refs.slice(0, 8).map((a) => a.name || a.id).join('、');
      refNote = `以下 ${refs.length} 个 Agent 正在引用此连接，删除后将无法调用：
${names}${refs.length > 8 ? ' …' : ''}
需重新配置后可用。`;
    }
  } catch { /* 引用扫描失败不阻塞删除（回落泛泛提示） */ }
  const ok = await confirmRef.value?.ask({
    title: `删除连接 "${name}"？`,
    message: `将同时删除其 API Key（凭据库）。
${refNote}`,
    confirmLabel: '删除连接',
    danger: true,
  });
  if (!ok) return;
  const pool = { ...props.pools };
  delete pool[name];
  emit('update:pools', pool);
  props.onSaved?.();
  void deleteLlmPoolCredential(name, defaultRpc).catch((err: any) => {
    error.value = `凭据删除失败（条目已删，但 /models 发现可能复活它）: ${err?.message ?? err}`;
  });
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
  const proto = typeof entry.protocol === 'string' && entry.protocol ? entry.protocol : 'openai-compat';
  const parts = [proto !== 'openai-compat' ? entry.base_url + ' · ' + proto : entry.base_url || '内置地址'];
  if (entry.defaultModel) parts.push(String(entry.defaultModel));
  const entries = poolModelEntries(entry.models);
  const n = entries.length;
  if (n > 0) parts.push(`${n} 个模型`);
  // 视觉能力 = 显式 visionModels ∪ 探测标志（models[].vision）
  const visionCount =
    entries.filter((e) => e.vision === true).length + (Array.isArray(entry.visionModels) ? (entry.visionModels as unknown[]).filter((m) => typeof m === 'string' && m && !entries.some((e) => e.model === m)).length : 0);
  if (visionCount > 0) parts.push(`视觉 ×${visionCount}`);
  return parts.join(' · ');
}
</script>

<template>
  <div class="pool">
    <div class="pool-head">
      <span class="pool-title">{{ title }}</span>
      <Button variant="primary" size="sm" icon="plus" @click="startAdd">添加</Button>
    </div>

    <div v-if="Object.keys(pools).filter(k => !k.startsWith('$')).length === 0" class="pool-empty">
      暂无连接——未配置任何模型（会话将无法发送）；点击「添加」接入 OpenAI 兼容端点
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
          <Button v-if="!entry.default" variant="ghost" size="sm" icon="star" title="设为默认连接（未显式选连接的会话与 Agent 使用它）" @click="setDefault(String(name))">设为默认</Button>
          <Button variant="ghost" size="sm" @click="startEdit(String(name))">编辑</Button>
          <Button variant="danger" size="sm" @click="removeEntry(String(name))">删除</Button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（表单体 = PoolEntryForm——cr-299 抽取共用件） -->
    <Modal :visible="editingName !== null" :title="editingName ? '编辑 ' + editingName : '新建条目'" :width="440" :z-index="1200" @close="cancelEdit()">
      <div class="pool-modal-body">
        <PoolEntryForm
          v-if="editingName !== null"
          :pools="pools"
          :editing-name="editingName === '' ? null : editingName"
          @save="onFormSave"
          @cancel="cancelEdit()"
          @models-cache="onModelsCache"
        />
      </div>
    </Modal>

    <!-- 删除确认（通用 ConfirmDialog，替代原生 confirm） -->
    <ConfirmDialog ref="confirmRef" />
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
/* cr-172 实心星标：lucide star 线框 fill 后成实心（默认标记的语义重量） */
.pool-star { color: var(--star); margin-right: 4px; display: inline-flex; align-items: center; }
.pool-star :deep(svg path) { fill: currentColor; }
.pool-entry-detail { font-size: 11px; color: var(--text-3); }
.pool-entry-actions { display: flex; gap: 6px; }
.pool-modal-body { padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; }
</style>
