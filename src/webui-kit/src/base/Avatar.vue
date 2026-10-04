<!--
  webui-kit/src/base/Avatar.vue —— 基础头像（图片 / 图标回退 / 首字回退）
  shape: circle（星群风格，默认）/ square
  fallbackIcon: 无图（或图挂）时渲染的图标名（见 ui/icons.ts）——小尺寸下
  首字不可读，用图标做默认头像（如 bot）；未提供则回退首字。
  图片加载失败（404/网络错误）时自动回退，不会出现破图。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  src?: string | null;
  name?: string;
  size?: number;
  shape?: 'circle' | 'square';
  /** 无图回退图标（ui/icons.ts 注册名）；缺省 = 首字回退 */
  fallbackIcon?: string;
  /** 纯 icon 占位（配 fallbackIcon）：无图不画 tinted 圆盘，仅一枚中性色图标 */
  plainFallback?: boolean;
  /** 右上角标（cr-157）：数字 = 计数徽章（99+ 封顶）；true = 纯红点 */
  badge?: number | boolean;
}>(), { shape: 'circle', size: 32 });

const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });

const initial = computed(() => (props.name || '?').charAt(0).toUpperCase());
const showImage = computed(() => !!props.src && !failed.value);
</script>

<template>
  <span
    class="ui-avatar"
    :class="`ui-avatar--${shape}`"
    :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' }"
  >
    <img v-if="showImage" :src="src!" :alt="name" class="ui-avatar-img" @error="failed = true" />
    <span v-else-if="fallbackIcon" class="ui-avatar-fallback ui-avatar-icon" :class="{ 'ui-avatar-fallback--plain': plainFallback }">
      <Icon :name="fallbackIcon" :size="plainFallback ? size : Math.max(9, Math.round(size * 0.6))" />
    </span>
    <span v-else class="ui-avatar-fallback">{{ initial }}</span>
    <b v-if="badge !== undefined && badge !== false" class="ui-avatar-badge" :class="{ dot: badge === true }" aria-label="未读">{{ badge === true ? '' : (badge as number) > 99 ? '99+' : badge }}</b>
  </span>
</template>

<style scoped>
.ui-avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; overflow: visible; flex-shrink: 0; }
.ui-avatar--circle { border-radius: var(--r-full); }
.ui-avatar--square { border-radius: var(--r-sm); }
.ui-avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
/* 右上角标配方单源在 badge.css（cr-157 全局——业务自建头像壳共用） */
.ui-avatar-fallback {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  border-radius: inherit; /* cr-182：容器 overflow:visible（cr-157 角标悬挂）不裁剪，圆角须自持——随 shape 取圆/方角 */
  background: var(--primary-light); color: var(--primary); font-weight: 600;
}
.ui-avatar-icon { font-size: 0; /* 图标不参与字号缩放，尺寸由 Icon size 控制 */ }
/* 纯 icon 占位：透明底 + 中性三级色（圆盘内的 0.6 缩放也不适用——图标即占位本体） */
.ui-avatar-fallback--plain { background: transparent; color: var(--text-3); }
</style>
