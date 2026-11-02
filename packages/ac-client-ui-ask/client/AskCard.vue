<!-- AskCard.vue -->
<script setup lang="ts">
// ============================================================
// 问答卡（cr-765 #4）：ask_questions 的注入行专用卡——Q/A 结构化渲染。
// 经 inject-card:view 席位（kind: durable-interaction）由 ac-client-ui-ask
// 行注册；payload 缺席（旧会话）→ 全量回落通用 ContextInjectCard
//（InjectCardHost 分流，本组件只在有 payload 时接手）。
// 形态（方案 §2 #4）:
//   卡头：help-circle/messages-square + 「询问用户」/「提问回执」；
//   meta = 状态词（等待中/已回答/未响应）+ 题数；
//   体：Q 段（序号 + 灰底左条，选项缩进 ◻）+ A 段（✓ 前缀 + ok 底）。
// ============================================================
import { computed, ref } from 'vue';
import { CardFrame } from '@agentchat/webui-kit';
import type { InjectCard } from 'ac-client-ui-conversation/client/types.ts';

const props = defineProps<{
  card: InjectCard;
  degraded?: boolean;
}>();

const isExpanded = ref(false);
const hasPayload = computed(() => !!props.card.payload?.questions?.length);
const canExpand = computed(() => hasPayload.value || !!props.card.content);

/** 终态：payload.outcome 在场 = 回执（已回答/未响应）；缺席 = 发起（等待中） */
const outcome = computed(() => props.card.payload?.outcome ?? 'pending');
const statusText = computed(() => ({
  pending: '等待中',
  answered: '已回答',
  timeout: '未响应',
} as Record<string, string>)[outcome.value] ?? '');
const title = computed(() => (outcome.value === 'pending' ? '询问用户' : '提问回执'));
const icon = computed(() => (outcome.value === 'pending' ? 'help-circle' : 'messages-square'));
const questions = computed(() => props.card.payload?.questions ?? []);
const answers = computed(() => props.card.payload?.answers ?? []);

/** 答案格式化：多选数组 → A、B；null → (跳过) */
function fmtAnswer(v: string | string[] | null | undefined): string {
  if (Array.isArray(v)) return v.length ? v.join('、') : '(跳过)';
  return v ?? '(跳过)';
}
</script>

<template>
  <CardFrame
    class="ask-card"
    :title="title"
    :icon="icon"
    :meta="`${statusText} · ${questions.length} 题`"
    :open="isExpanded"
    :can-expand="canExpand"
    @toggle="isExpanded = !isExpanded"
  >
    <div v-if="hasPayload" class="ask-body">
      <!-- Q 段 -->
      <div class="ask-sec">
        <div v-for="(q, i) in questions" :key="i" class="ask-q">
          <div class="ask-q-head">Q{{ i + 1 }} {{ q.question }}<span v-if="q.multi" class="ask-multi">多选</span></div>
          <div v-if="q.options?.length" class="ask-opts">
            <div v-for="(o, j) in q.options" :key="j" class="ask-opt">◻ {{ o }}</div>
          </div>
        </div>
      </div>
      <!-- A 段 -->
      <div v-if="outcome === 'answered'" class="ask-sec ask-a">
        <div v-for="(q, i) in questions" :key="i" class="ask-a-row">✓ {{ fmtAnswer(answers[i]) }}</div>
      </div>
      <div v-else-if="outcome === 'timeout'" class="ask-sec ask-a is-timeout">未获响应</div>
      <div v-else class="ask-sec ask-a is-waiting"><span class="ask-wait-ring" aria-hidden="true"></span>等待用户回答</div>
    </div>
    <!-- payload 缺席兜底：正文纯文本（旧会话） -->
    <pre v-else-if="card.content" class="ask-raw">{{ card.content }}</pre>
  </CardFrame>
</template>

<style scoped>
.ask-card { min-width: 0; width: 100%; }
.ask-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ask-sec { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ask-q { border-left: 2px solid var(--line-strong); padding: 2px 0 2px 10px; }
.ask-q-head { font-size: var(--fs-sm); color: var(--text-1); font-weight: 500; }
.ask-multi { font-size: var(--fs-2xs); color: var(--text-3); margin-left: 6px; border: 1px solid var(--line); border-radius: var(--r-full); padding: 0 6px; }
.ask-opts { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.ask-opt { font-size: var(--fs-2xs); color: var(--text-2); padding-left: 12px; }
/* A 段：ok 色调底（方案 §2 #4 定稿视觉） */
.ask-a { background: color-mix(in srgb, var(--ok) 8%, transparent); border-radius: var(--r-sm); padding: 6px 10px; }
.ask-a-row { font-size: var(--fs-sm); color: var(--text-1); }
.ask-a.is-timeout { color: var(--warn); }
.ask-a.is-waiting { color: var(--text-3); flex-direction: row; align-items: center; gap: 8px; }
/* 等待旋转环（BusyRing 同款取色） */
.ask-wait-ring {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--primary-border-soft); border-top-color: var(--primary);
  animation: askSpin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes askSpin { to { transform: rotate(360deg); } }
.ask-raw { margin: 0; font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); color: var(--text-2); }
</style>