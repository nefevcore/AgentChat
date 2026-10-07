<script setup lang="ts">
// ============================================================
// client/steps/AgentStep.vue —— 第 4 步 · Agent 设置（cr-300 批 3）
//
// 内嵌创建表单（最小字段集——计划 §3.2：名称 / 模型（下拉来自第 2 步
// 连接，格式 provider@model；留空 = 跟随全局默认连接）/ 人格（system）/
// 能力标签（默认勾出厂标准档最小可用集））。写口 = agents/create。
// 建完即刻出现在左侧 Agent 列表（agents/updated 帧贯通——R5）。
//
// 表单与 AgentPane/AgentListPane 的关系：字段集差异大（引导是「首次
// 创建」的定向表单，AgentListPane 是快建、AgentPane 是长期编辑），
// 共用 provider/模型缓存加载已并源 poolModelCache（ui-agents）——
// 表单本体各自维护（§4.3 债务标注：字段变更时双处修改）。
// ============================================================
import { computed, onMounted, ref } from 'vue';
import { Button, FeedbackNotice, Input, Select, Textarea } from '@agentchat/webui-kit';
import { loadPoolModelCache } from 'ac-client-ui-agents/client/poolModelCache.ts';
import { createAgent } from 'ac-client-ui-agents/client/index.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';

const emit = defineEmits<{ (e: 'agent-created'): void }>();

defineProps<{ llmCount?: number }>();

/** 出厂标准档最小可用集（R7 定稿：与 __standard__ 预设对齐——ac-agent-presets-builtin） */
const DEFAULT_TAGS = ['fs', 'infra', 'shell', 'web', 'delegation', 'issue-report'];

const TAG_OPTIONS: Array<{ tag: string; label: string; hint: string }> = [
  { tag: 'fs', label: 'fs', hint: '文件读写' },
  { tag: 'shell', label: 'shell', hint: '命令执行' },
  { tag: 'web', label: 'web', hint: 'Web 浏览（含搜索）' },
  { tag: 'delegation', label: 'delegation', hint: '任务委派（子 Agent）' },
  { tag: 'dev', label: 'dev', hint: '开发工具' },
  { tag: 'admin', label: 'admin', hint: '系统管理工具' },
];

// ── 表单状态 ──
const name = ref('');
const system = ref('');
const selectedTags = ref<string[]>([...DEFAULT_TAGS]);
const provider = ref('');
const model = ref('');

// ── provider × 模型缓存（并源 poolModelCache——与 AgentListPane 共用）──
const providers = ref<Array<{ name: string; label: string }>>([]);
const poolModels = ref<Record<string, string[]>>({});

onMounted(async () => {
  const c = await loadPoolModelCache();
  providers.value = c.stats.map((s) => ({ name: s.name, label: s.description ? `${s.name} · ${s.description}` : s.name }));
  poolModels.value = c.models;
});

const providerOptions = computed(() => [
  { value: '', label: '跟随全局默认连接', disabled: false },
  ...providers.value.map((p) => ({ value: p.name, label: p.label, disabled: false })),
]);

const modelOptions = computed(() => [
  { value: '', label: '该连接默认模型', disabled: false },
  ...(poolModels.value[provider.value] ?? []).map((m) => ({ value: m, label: m, disabled: false })),
]);

function onProviderChange(p: string) {
  provider.value = p;
  model.value = (poolModels.value[p] ?? [])[0] ?? '';
}

function toggleTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag);
  if (idx >= 0) selectedTags.value = selectedTags.value.filter((t) => t !== tag);
  else selectedTags.value = [...selectedTags.value, tag];
}

// ── 创建 ──
const creating = ref(false);
const feedback = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);
const createdName = ref('');

async function submit(): Promise<void> {
  const trimmed = name.value.trim();
  if (!trimmed) { feedback.value = { tone: 'error', text: '请输入 Agent 名称' }; return; }
  creating.value = true;
  feedback.value = null;
  try {
    await createAgent({
      name: trimmed,
      ...(provider.value ? { provider: provider.value, llm: { provider: provider.value, ...(model.value ? { model: model.value } : {}) } } : {}),
      tags: [...selectedTags.value],
      ...(system.value.trim() ? { system: system.value.trim() } : {}),
    }, defaultRpc);
    createdName.value = trimmed;
    feedback.value = { tone: 'ok', text: '已创建——左侧 Agent 列表即刻可见' };
    emit('agent-created');
  } catch (err) {
    feedback.value = { tone: 'error', text: `创建失败：${(err as Error).message}` };
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="ag-step">
    <!-- 已创建：成功态 -->
    <template v-if="createdName">
      <FeedbackNotice tone="ok" :text="`已创建 Agent「${createdName}」——左侧列表即刻可见，可继续下一步或回头再建。`" />
      <div class="ag-create-again">
        <Button variant="ghost" size="sm" icon="plus" @click="createdName = ''; name = ''; system = ''">再建一个</Button>
      </div>
    </template>

    <!-- 创建表单 -->
    <template v-else>
      <div class="ag-field">
        <label class="ag-label" for="ag-name">名称</label>
        <Input id="ag-name" v-model="name" placeholder="如 我的助手" :disabled="creating" />
      </div>

      <div class="ag-field">
        <label class="ag-label">模型</label>
        <div class="ag-model-row">
          <Select :options="providerOptions" :model-value="provider" @update:model-value="onProviderChange" />
          <Select v-if="provider" :options="modelOptions" :model-value="model" @update:model-value="model = $event" />
        </div>
        <p class="ag-hint">下拉来自第 2 步配置的连接（格式 provider@model）；留空 = 跟随全局默认连接。</p>
      </div>

      <div class="ag-field">
        <label class="ag-label" for="ag-system">人格（可选）</label>
        <Textarea id="ag-system" v-model="system" :rows="4" placeholder="用一段话告诉它你是谁、它该怎么帮你——这就是它的人格。" :disabled="creating" />
      </div>

      <div class="ag-field">
        <label class="ag-label">能力标签</label>
        <div class="ag-tags">
          <button
            v-for="t in TAG_OPTIONS" :key="t.tag"
            type="button"
            class="ag-tag" :class="{ on: selectedTags.includes(t.tag) }"
            :title="t.hint"
            @click="toggleTag(t.tag)"
          >{{ t.label }}</button>
        </div>
        <p class="ag-hint">默认勾选出厂标准档最小可用集；这些标签决定它能用哪些工具，之后可在 Agent 设置里细调。</p>
      </div>

      <FeedbackNotice v-if="feedback" :tone="feedback.tone" :text="feedback.text" />
      <div class="ag-actions">
        <Button variant="primary" :loading="creating" @click="submit">创建</Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ag-step { display: flex; flex-direction: column; gap: 14px; }
.ag-field { display: flex; flex-direction: column; gap: 5px; }
.ag-label { font-size: var(--fs-xs); color: var(--text-2); font-weight: 500; }
.ag-hint { margin: 2px 0 0; font-size: var(--fs-2xs); color: var(--text-3); line-height: 1.6; }
.ag-model-row { display: flex; gap: 8px; flex-wrap: wrap; }
.ag-model-row :deep(.ui-select) { flex: 1; min-width: 160px; }
.ag-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.ag-tag {
  padding: 3px 12px; border-radius: var(--r-full);
  border: 1px solid rgba(var(--text-3-rgb), 0.25);
  background: transparent; color: var(--text-3);
  font-size: var(--fs-2xs); font-family: var(--font-mono); cursor: pointer;
  transition: all var(--dur-fast);
}
.ag-tag:hover { border-color: rgba(var(--text-3-rgb), 0.45); color: var(--text-2); }
.ag-tag.on {
  border-color: rgba(var(--primary-rgb), 0.4);
  background: rgba(var(--primary-rgb), 0.1);
  /* cr-303：同 PoolEntryForm——静态混静态改写 --primary-strong 档位 */
  color: var(--primary-strong);
}
.ag-actions { display: flex; justify-content: flex-end; }
.ag-create-again { display: flex; justify-content: center; }
</style>
