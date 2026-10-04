<!-- webui-kit/src/feedback/FeedbackNotice.vue —— 语义反馈条（tone 状态 → 图标/配色派生）
  语义控件化：文案只承载文本，成功/失败/提示由 tone 表达（替代文案内嵌
  emoji 前缀的旧形态——形态与文本解耦，主题/读屏/复用三受益）。
    · ok    成功终态（check-circle，success 色）
    · error 失败警告（alert-circle，error 色）
    · info  中性提示（info，弱化色）
    · busy  进行中（loader-circle 旋转，primary 色——灰色与"正在做"语义不符）
  形态恒 chip 胶囊（cr-122 删 inline 变体——业务消费 3 处全 chip，
  inline 0 消费）。定位（absolute 等）由调用方 class 叠加。 -->
<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../base/Icon.vue';
import BusyRing from '../base/BusyRing.vue';

const props = withDefaults(defineProps<{
  /** 反馈文案（空 = 不渲染；外层 v-if 亦可） */
  text?: string;
  /** 语义态 */
  tone?: 'ok' | 'error' | 'info' | 'busy';
  /** 图标尺寸 */
  size?: number;
}>(), { text: '', tone: 'info', size: 13 });

const TONE_ICON = { ok: 'check-circle', error: 'alert-circle', info: 'info', busy: 'loader-circle' } as const;
const icon = computed(() => TONE_ICON[props.tone]);
</script>

<template>
  <span
    v-if="text"
    class="feedback-notice"
    :class="`is-${tone}`"
    role="status"
  >
    <BusyRing v-if="tone === 'busy'" tone="running" :size="size" />
    <Icon v-else :name="icon" :size="size" class="feedback-icon" />
    <span class="feedback-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.feedback-notice {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-sm);
  line-height: 1.4;
  min-width: 0;
}

.feedback-icon { flex-shrink: 0; }
.feedback-text { overflow: hidden; text-overflow: ellipsis; }

/* 语义配色（chip 胶囊：浅语义底 + 描边，文字随本色；图标不再单独着色——
   由 chip 底色统一承载。进行中：形状轴（旋转）由 BusyRing 承担） */
.feedback-notice {
  padding: 2px 8px;
  border-radius: var(--r-sm);
  white-space: nowrap;
}

.is-ok {
  color: var(--ok);
  background: rgba(var(--ok-rgb), 0.08);
  border: 1px solid rgba(var(--ok-rgb), 0.25);
}

.is-error {
  color: var(--err);
  background: rgba(var(--err-rgb), 0.08);
  border: 1px solid rgba(var(--err-rgb), 0.25);
}

.is-info {
  color: var(--text-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
}

.is-busy {
  color: var(--primary-strong);
  background: var(--primary-tint);
  border: 1px solid var(--primary-border-soft);
}

</style>
