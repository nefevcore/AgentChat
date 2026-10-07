<script setup lang="ts">
// ============================================================
// client/steps/LlmStep.vue —— 第 2 步 · 模型设置（cr-299 批 2）
//
// 内嵌 PoolEntryForm（ui-llm-pool 共用表单体）：新建连接即落盘
//（saveLlmPoolDomain——api_key 侧信道语义在服务端）。cr-21 防覆盖
// 守门：池未成功加载禁止整域写（否则一次保存清光后端连接）。
// 已有连接时显示清单（可继续追加）。保存成功 → emit llm-saved
//（壳刷新模型状态 + 本步 ✓）。
// ============================================================
import { onMounted, ref } from 'vue';
import type { PoolEntry } from 'ac-client-ui-settings/client/types.ts';
import { FeedbackNotice } from '@agentchat/webui-kit';
import { getPools } from 'ac-client-ui-settings/client/api.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';
import { saveLlmPoolDomain } from 'ac-client-ui-llm-pool/client/poolApi.ts';
import PoolEntryForm from 'ac-client-ui-llm-pool/client/PoolEntryForm.vue';

const emit = defineEmits<{ (e: 'llm-saved'): void }>();

defineProps<{ llmCount?: number }>();

// ── 池加载（cr-21 守门判据）──
const pools = ref<Record<string, PoolEntry>>({});
const poolsLoaded = ref(false);
const loadError = ref('');
const saving = ref(false);
const feedback = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

onMounted(async () => {
  try {
    const d = await getPools();
    pools.value = d.llmProviders as Record<string, PoolEntry>;
    poolsLoaded.value = true;
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  }
});

/** 表单 save → 合并默认标记 → 落盘（cr-21 守门：未加载成功拒写） */
async function onFormSave(name: string, entry: Record<string, any>): Promise<void> {
  if (!poolsLoaded.value) {
    feedback.value = { tone: 'error', text: '连接池尚未加载成功，已取消保存（此时保存会清空后端现有连接）' };
    return;
  }
  saving.value = true;
  feedback.value = null;
  try {
    const pool = { ...pools.value };
    // 池中无条目时，首个自动设为默认（引导场景常态）
    const existingKeys = Object.keys(pool).filter(k => !k.startsWith('$'));
    if (existingKeys.length === 0) entry.default = true;
    pool[name] = entry as PoolEntry;
    await saveLlmPoolDomain(pool, defaultRpc);
    pools.value = pool;
    feedback.value = { tone: 'ok', text: '已保存并设为默认连接' };
    emit('llm-saved');
  } catch (err) {
    feedback.value = { tone: 'error', text: `保存失败：${(err as Error).message}` };
  } finally {
    saving.value = false;
  }
}

/** 注册路径读取模型的服务端缓存回写（编辑态才有——引导以新建为主，仍保持同款落盘） */
async function onModelsCache(name: string, models: unknown[]): Promise<void> {
  if (!poolsLoaded.value) return;
  try {
    const pool = { ...pools.value };
    pool[name] = { ...(pool[name] ?? {}), models: models as never };
    await saveLlmPoolDomain(pool, defaultRpc);
    pools.value = pool;
  } catch { /* 缓存回写失败不阻塞表单 */ }
}
</script>

<template>
  <div class="llm-step">
    <FeedbackNotice v-if="loadError" tone="error" :text="loadError" />
    <template v-else-if="poolsLoaded">
      <PoolEntryForm
        :pools="pools"
        :editing-name="null"
        @save="onFormSave"
        @cancel="emit('llm-saved')"
        @models-cache="onModelsCache"
      />
      <FeedbackNotice v-if="feedback" :tone="feedback.tone" :text="feedback.text" />
    </template>
    <FeedbackNotice v-else tone="busy" text="加载连接池…" />
  </div>
</template>

<style scoped>
.llm-step { display: flex; flex-direction: column; gap: 12px; }
</style>
