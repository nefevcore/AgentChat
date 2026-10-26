<!--
  webui-kit/src/base/PullToRefresh.vue —— 触屏下拉刷新原语（cr-80）
  用法：<PullToRefresh class="滚动容器类" :on-refresh="handler">…列表内容…</PullToRefresh>
  根元素即滚动容器（class/监听器经 fallthrough 落根），内容包一层 track：
  顶部在位 + 竖直下拉过 slop → 接管手势（touchmove preventDefault，阻尼 0.5 跟手），
  过阈值松手 → on-refresh（驻留 spinner，Promise 落定收口）；不足阈值 → 回弹。
  仅监听 touch* —— 桌面鼠标零事件零影响，无需窄屏判断。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** 松手触发；返回的 Promise 落定 = 刷新完成（spinner 收口） */
  onRefresh: () => unknown | Promise<unknown>;
  /** 触发阈值 px（阻尼后位移达到即「松开刷新」） */
  /** @deprecated 零覆写 → 已固化常量 THRESHOLD（P1 批次移除该 prop） */
  threshold?: number;
}>(), {});

/** 触发阈值（cr-121 固化：全仓零覆写——0 消费的旋钮不留在 API 面上） */
const THRESHOLD = 64;

/** 手势态：idle → pulling（跟手）→ refreshing（驻留）→ done（驻留一瞬）→ idle */
const state = ref<'idle' | 'pulling' | 'refreshing' | 'done'>('idle');
/** 阻尼后下拉位移 px（仅 pulling 期跟手；refreshing/done 由态驱动驻留高） */
const pull = ref(0);
const rootEl = ref<HTMLElement>();

const DAMP = 0.5;        // 阻尼：位移 = 手移 × 0.5
const MAX_PULL = 110;    // 位移硬上限
const HOLD = 48;         // refreshing/done 指示器驻留高（track 下移量）
const SLOP = 10;         // 方向判定 slop：竖直分量明确占优才接管
const DONE_MS = 260;     // 「已刷新」驻留时长

let startX = 0;
let startY = 0;
let tracking = false;    // 本轮 touch 序列参与判定
let engaged = false;     // 已判定为下拉刷新（此后 touchmove preventDefault）
let busy = false;        // 刷新进行中（新手势屏蔽）

const armed = computed(() => state.value === 'pulling' && pull.value >= THRESHOLD);
const trackY = computed(() =>
  state.value === 'pulling' ? pull.value : state.value === 'refreshing' || state.value === 'done' ? HOLD : 0);
const trackStyle = computed(() => ({ transform: trackY.value ? 'translateY(' + trackY.value + 'px)' : undefined }));

function reset() {
  engaged = false;
  state.value = 'idle';
  pull.value = 0;
}

function onTouchStart(e: TouchEvent) {
  if (busy) return;
  if (e.touches.length > 1) { tracking = false; reset(); return; } // 多指（捏合）不接管
  startX = e.touches[0].clientX;
  startY = e.touches[0].clientY;
  tracking = true;
  engaged = false;
}

function onTouchMove(e: TouchEvent) {
  if (!tracking || busy) return;
  const dy = e.touches[0].clientY - startY;
  const dx = e.touches[0].clientX - startX;
  if (!engaged) {
    // slop 判定：容器在顶 + 明确竖直下拉 → 接管；横滑/上滑 → 放弃本轮（正常滚动）
    if ((rootEl.value?.scrollTop ?? 0) <= 0 && dy > SLOP && Math.abs(dx) < dy) {
      engaged = true;
      state.value = 'pulling';
    } else {
      if (Math.abs(dx) > SLOP || dy < -SLOP) tracking = false;
      return;
    }
  }
  e.preventDefault(); // 接管后阻止滚动链/长按选择（监听非 passive，元素级可用）
  pull.value = Math.min(MAX_PULL, Math.max(0, dy) * DAMP);
}

function onTouchEnd() {
  if (!tracking) return;
  tracking = false;
  if (!engaged) return;
  engaged = false;
  if (pull.value >= THRESHOLD) void trigger();
  else reset(); // 未过阈值：回弹（track 过渡生效）
}

function onTouchCancel() {
  tracking = false;
  reset();
}

async function trigger() {
  if (busy) return;
  busy = true;
  state.value = 'refreshing';
  pull.value = 0;
  try {
    await Promise.resolve(props.onRefresh());
  } catch {
    /* 刷新失败静默（数据面各自 catch；此处吞掉防 void trigger 悬挂未处理拒绝） */
  } finally {
    state.value = 'done';
    setTimeout(() => {
      state.value = 'idle';
      busy = false;
    }, DONE_MS);
  }
}
</script>

<template>
  <div
    ref="rootEl"
    class="ui-pull-root"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
  >
    <div class="ui-pull-track" :class="{ 'is-gliding': state !== 'pulling' }" :style="trackStyle">
      <div v-show="state !== 'idle'" class="ui-pull-indicator" :class="['is-' + state, { armed }]">
        <span class="ui-pull-bubble">
          <Icon v-if="state === 'refreshing'" name="loader-circle" :size="16" class="ui-pull-spin" />
          <Icon v-else-if="state === 'done'" name="check-circle" :size="16" />
          <Icon v-else name="arrow-down" :size="16" class="ui-pull-arrow" :class="{ armed }" />
        </span>
        <span class="ui-pull-text">{{ state === 'refreshing' ? '刷新中…' : state === 'done' ? '已刷新' : armed ? '松开刷新' : '下拉刷新' }}</span>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* 根 = 滚动容器本身（调用方 class 经 fallthrough 落根；此处只补定位锚） */
.ui-pull-root { position: relative; }
.ui-pull-track { position: relative; }
/* 非跟手期（回弹/驻留/收起）：位移走过渡 */
.ui-pull-track.is-gliding { transition: transform var(--dur-base) var(--ease-out); }

/* 指示器：悬在 track 顶缘上方，随 track 下移露出 */
.ui-pull-indicator {
  position: absolute; top: -46px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  user-select: none; pointer-events: none;
}
.ui-pull-bubble {
  width: 34px; height: 34px; border-radius: var(--r-full, 999px);
  background: var(--bg-raised); border: 1px solid var(--line);
  box-shadow: var(--shadow-pop);
  display: flex; align-items: center; justify-content: center; color: var(--text-2);
}
/* armed/刷新中/完成：主色/成功色点亮（文字 + 颜色双通道） */
.ui-pull-indicator.armed .ui-pull-bubble { color: var(--primary); border-color: var(--primary); }
.ui-pull-indicator.is-refreshing .ui-pull-bubble { color: var(--primary); border-color: var(--primary); }
.ui-pull-indicator.is-done .ui-pull-bubble { color: var(--ok-status); border-color: var(--ok-status); }
.ui-pull-arrow { transition: transform var(--dur-fast) var(--ease-out); }
.ui-pull-arrow.armed { transform: rotate(180deg); }
/* cr-161：刷新旋转是功能语义（同 cr-149 BusyRing 先例）——不经 --motion-scale，
   系统「减少动态」下仍旋转（静止的环被读作卡死） */
.ui-pull-spin { animation: ui-pull-rot 0.7s linear infinite; }
@keyframes ui-pull-rot { to { transform: rotate(360deg); } }
.ui-pull-text { font-size: 11px; color: var(--text-3); white-space: nowrap; }
</style>
