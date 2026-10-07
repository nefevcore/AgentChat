<script setup lang="ts">
// ============================================================
// client/steps/SearchStep.vue —— 第 3 步 · 搜索设置（cr-299 批 2）
//
// 内嵌 SearchEntryForm（ui-search-pool 共用表单体）：新建引擎连接
// 即落盘（saveSearchPoolDomain）。cr-21 守门同 LlmStep。已标注
//「最该跳过的一步」——不配不影响任何后续功能。
// ============================================================
import { onMounted, ref } from 'vue';
import type { PoolEntry } from 'ac-client-ui-settings/client/types.ts';
import { FeedbackNotice } from '@agentchat/webui-kit';
import { getPools, getSearchSchemas } from 'ac-client-ui-settings/client/api.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { saveSearchPoolDomain } from 'ac-client-ui-search-pool/client/searchPoolApi.ts';
import SearchEntryForm from 'ac-client-ui-search-pool/client/SearchEntryForm.vue';

const emit = defineEmits<{ (e: 'search-saved'): void }>();

defineProps<{ llmCount?: number }>();

const pools = ref<Record<string, PoolEntry>>({});
const schemas = ref<Record<string, any[]>>({});
const poolsLoaded = ref(false);
const loadError = ref('');
const feedback = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

onMounted(async () => {
  try {
    const [poolsR, schemasR] = await Promise.all([getPools(), getSearchSchemas()]);
    pools.value = poolsR.searchProviders as Record<string, PoolEntry>;
    schemas.value = schemasR;
    poolsLoaded.value = true;
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  }
});

async function onFormSave(name: string, entry: Record<string, any>): Promise<void> {
  if (!poolsLoaded.value) {
    feedback.value = { tone: 'error', text: '搜索池尚未加载成功，已取消保存（此时保存会清空后端现有连接）' };
    return;
  }
  feedback.value = null;
  try {
    const pool = { ...pools.value };
    const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
    if (existingKeys.length === 0) entry.default = true;
    pool[name] = entry as PoolEntry;
    await saveSearchPoolDomain(pool, defaultRpc);
    pools.value = pool;
    feedback.value = { tone: 'ok', text: '已保存' };
    emit('search-saved');
  } catch (err) {
    feedback.value = { tone: 'error', text: `保存失败：${(err as Error).message}` };
  }
}
</script>

<template>
  <div class="search-step">
    <FeedbackNotice v-if="loadError" tone="error" :text="loadError" />
    <template v-else-if="poolsLoaded">
      <SearchEntryForm
        :pools="pools"
        :schemas="schemas"
        :editing-name="null"
        @save="onFormSave"
        @cancel="emit('search-saved')"
      />
      <FeedbackNotice v-if="feedback" :tone="feedback.tone" :text="feedback.text" />
    </template>
    <FeedbackNotice v-else tone="busy" text="加载搜索池…" />
  </div>
</template>

<style scoped>
.search-step { display: flex; flex-direction: column; gap: 12px; }
</style>
