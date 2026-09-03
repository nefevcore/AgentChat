<!-- FeedbackNotice.vue —— 语义反馈条（tone 状态 → 图标/配色派生）
  语义控件化：文案只承载文本，成功/失败/提示由 tone 表达（替代文案内嵌
  emoji 前缀的旧形态——形态与文本解耦，主题/读屏/复用三受益）。
    · ok    成功终态（check-circle，success 色）
    · error 失败警告（alert-circle，error 色）
    · info  中性进行中提示（info，弱化色）
  variant：chip = 浅底描边胶囊（输入区/列表反馈）；inline = 裸图标+文字
  （空间受限的角落提示）。定位（absolute 等）由调用方 class 叠加。 -->
<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** 反馈文案（空 = 不渲染；外层 v-if 亦可） */
  text?: string;
  /** 语义态 */
  tone?: 'ok' | 'error' | 'info';
  /** 视觉形态：chip = 浅底描边胶囊；inline = 裸图标+文字 */
  variant?: 'chip' | 'inline';
  /** 图标尺寸 */
  size?: number;
}>(), { text: '', tone: 'info', variant: 'inline', size: 13 });

const TONE_ICON = { ok: 'check-circle', error: 'alert-circle', info: 'info' } as const;
const icon = computed(() => TONE_ICON[props.tone]);
</script>

<template>
  <span
    v-if="text"
    class="feedback-notice"
    :class="[`is-${tone}`, `as-${variant}`]"
    role="status"
  >
    <Icon :name="icon" :size="size" class="feedback-icon" />
    <span class="feedback-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.feedback-notice {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  line-height: 1.4;
  min-width: 0;
}

.feedback-icon { flex-shrink: 0; }
.feedback-text { overflow: hidden; text-overflow: ellipsis; }

/* 语义配色（图标恒着色；文字仅 inline 形态着色——chip 由底色承载体） */
.is-ok .feedback-icon { color: var(--color-success); }
.is-error .feedback-icon { color: var(--color-error); }
.is-info .feedback-icon { color: var(--color-text-tertiary, #a8abb2); }

.as-inline.is-ok .feedback-text { color: var(--color-success); }
.as-inline.is-error .feedback-text { color: var(--color-error); }
.as-inline.is-info .feedback-text { color: var(--color-text-secondary); }

/* 胶囊形态（浅语义底 + 描边） */
.as-chip {
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

.as-chip.is-ok {
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-success) 25%, transparent);
}

.as-chip.is-error {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-error) 25%, transparent);
}

.as-chip.is-info {
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--color-border-secondary);
}
</style>
