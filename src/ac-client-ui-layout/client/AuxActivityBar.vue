<script setup lang="ts">
// ============================================================
// client/AuxActivityBar.vue —— 辅助活动栏（右侧区域的活动栏同构物）
//
// 会话区重构二轮：原「右缘悬浮切换条」（absolute 贴右缘——覆盖消息/
// 头像，须用 top 偏移避让）整体换为**常规布局列**——与左侧活动栏
//（ActivityBar 48px 列）同构：占布局位、零覆盖、常驻可见。
//   · 内容 = aux-sidebar 各选区的 rail 资产同级按钮（工作区/群组配置/…，
//     available 谓词控可见性——域态驱动，壳零域知识）；
//   · 交互 = 活动栏同款：点非当选区 = 展开该选区（显式选区置位 +
//     activate 域侧激活），点当选且展开 = 二次点击收起区域；
//   · 活动指示条镜像：左侧活动栏在按钮左缘，本栏在右缘。
// 宿主 = AuxSidebarHost（DOM 序末位 = app-layout 行最右列）。
// ============================================================
import { Icon } from '@agentchat/webui-kit';
import type { AuxSidebarPanelDef } from './auxSidebarViews.ts';

defineProps<{
  /** 切换条候选（带 rail 资产且 available——AuxSidebarHost 供） */
  defs: AuxSidebarPanelDef[];
  /** 当选选区 id（展开中才高亮；收起态无高亮） */
  activeId: string | null | undefined;
}>();

const emit = defineEmits<{
  (e: 'toggle', def: AuxSidebarPanelDef): void;
}>();

/** 徽章安全求值：抛错/0/空 = 不渲染（同 available 谓词姿势——缺陷 def 不击穿栏） */
function badgeOf(d: AuxSidebarPanelDef): number | string | null {
  try {
    const v = d.rail?.badge?.() ?? null;
    // 0 / 空串 = 无可计数态 → 不渲染（真值文本「√」等照常）
    if (v === null || v === 0 || v === '') return null;
    return v;
  } catch (err) {
    console.warn(`[aux-sidebar] 区域选区 "${d.id}" 的 badge() 徽章源抛错——按不渲染跳过`, err);
    return null;
  }
}

/** 数字徽章文案：>99 封顶「99+」（文本徽章原样透传） */
function badgeLabel(v: number | string | null): string {
  if (typeof v === 'number' && v > 99) return '99+';
  return String(v ?? '');
}
</script>

<template>
  <nav class="aux-activity-bar" aria-label="辅助面板">
    <button
      v-for="d in defs"
      :key="d.id"
      class="aux-ab-btn"
      :class="{ active: d.id === activeId }"
      :title="d.rail!.title"
      :aria-pressed="d.id === activeId"
      @click="emit('toggle', d)"
    >
      <Icon :name="d.rail!.icon" :size="22" />
      <span v-if="badgeOf(d) !== null" class="aux-ab-badge">{{ badgeLabel(badgeOf(d)) }}</span>
    </button>
  </nav>
</template>

<style scoped>
/* 辅助活动栏列（左侧活动栏同构；无底色透页面背景、窄列 40px、
   按钮竖向居中；内侧描边 + 指示条镜像到右缘） */
.aux-activity-bar {
  width: 40px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex-shrink: 0; gap: 4px;
  border-left: 1px solid var(--color-border-secondary, rgba(0, 0, 0, 0.08));
  position: relative; z-index: 10;
}

.aux-ab-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 40px; border: none; border-radius: 6px; background: none;
  color: var(--color-text-tertiary, #999); cursor: pointer;
  transition: color 0.15s, background 0.15s; position: relative;
}
.aux-ab-btn:hover { color: var(--color-text-primary, #fff); background: var(--color-bg-hover, rgba(0, 0, 0, 0.06)); }
.aux-ab-btn.active { color: var(--color-text-primary, #fff); }
.aux-ab-btn.active::before {
  content: ''; position: absolute; right: 0; top: 8px; bottom: 8px;
  width: 2px; background: var(--color-primary, #4f46e5); border-radius: 2px 0 0 2px;
}

/* 数字徽章（域行 rail.badge 供数——主题色底白字，右上角；数据源/格式
   随 owning 行，壳只管渲染） */
.aux-ab-badge {
  position: absolute; top: 3px; right: 1px;
  min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px;
  background: var(--color-primary, #4f46e5); color: #fff;
  font-size: 9px; font-weight: 600; line-height: 1;
  border: 1.5px solid var(--color-bg-page, transparent);
  z-index: 1; pointer-events: none;
}
</style>
