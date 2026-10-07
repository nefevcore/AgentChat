<script setup lang="ts">
// ============================================================
// client/steps/TourStep.vue —— 第 5 步 · 界面导览（plan §3.2 D4：
// 独立成步，只做概念地图——线框 + 两句话，不写逐元素说明书）
//
// 按钮「开始使用」= 走完流程（写首启标记并关闭）——由向导壳的
// 下一步/完成按钮承担（isLast 时文案即「完成」），本组件不再放
// 重复按钮。
// ============================================================
defineProps<{ llmCount?: number }>();
</script>

<template>
  <div class="tour">
    <!-- 线框地图（纯 CSS 线框，不截图——随 UI 演进不漂移） -->
    <div class="tour-map" aria-hidden="true">
      <div class="tm-activity" /><div class="tm-primary" /><div class="tm-main" /><div class="tm-aux" />
      <span class="tm-label tm-l1">活动栏</span>
      <span class="tm-label tm-l2">Agent / 群 / 会话列表</span>
      <span class="tm-label tm-l3">会话流</span>
      <span class="tm-label tm-l4">辅助侧栏</span>
    </div>
    <div class="tour-notes">
      <p><b>Agent 会话</b>：与某个 Agent 的长期对话——人格与记忆都在这儿，点活动栏第一个图标进入。</p>
      <p><b>独立会话</b>：与名册解耦的一次性会话页——可单独指定模型，适合临时任务，点会话列表图标进入。</p>
      <p class="tour-more">所有设置随时可改：左下角<b>更多 → 新手引导</b>可重播本向导。</p>
    </div>
  </div>
</template>

<style scoped>
.tour { display: flex; flex-direction: column; gap: 16px; }
/* 线框地图：4 列比例示意（48 / 260 / flex / 280） */
.tour-map {
  position: relative; display: flex; gap: 6px; height: 150px;
  padding: 10px; border: 1px dashed var(--line-strong); border-radius: var(--r-md);
}
.tm-activity { width: 28px; flex-shrink: 0; background: var(--bg-inset); border-radius: var(--r-sm); }
.tm-primary { width: 120px; flex-shrink: 0; background: var(--bg-inset); border-radius: var(--r-sm); }
.tm-main { flex: 1; background: rgba(var(--primary-rgb), 0.08); border: 1px solid rgba(var(--primary-rgb), 0.25); border-radius: var(--r-sm); }
.tm-aux { width: 110px; flex-shrink: 0; background: var(--bg-inset); border-radius: var(--r-sm); }
.tm-label { position: absolute; font-size: var(--fs-2xs); color: var(--text-3); background: var(--bg-raised); padding: 1px 6px; border-radius: var(--r-full); }
.tm-l1 { left: 10px; top: 8px; }
.tm-l2 { left: 62px; top: 8px; }
.tm-l3 { left: 200px; top: 8px; }
.tm-l4 { right: 10px; top: 8px; }
.tour-notes { display: flex; flex-direction: column; gap: 8px; }
.tour-notes p { margin: 0; font-size: var(--fs-sm); color: var(--text-2); line-height: 1.7; }
.tour-notes b { color: var(--text-1); }
.tour-more { color: var(--text-3); font-size: var(--fs-xs); }

@media (max-width: 768px) {
  .tm-primary { width: 80px; }
  .tm-aux { display: none; }
  .tm-l4 { display: none; }
  .tm-l3 { left: 160px; }
}
</style>
