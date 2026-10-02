<!-- ============================================================
  webui-kit/src/base/CollapseRow.vue —— 折叠内容行（cr-121 新原语）
  归一 ToolMessage 工具卡与 AssistantMessage 思考区两份漂移实现：
  label 行（忙指示/图标 + 标题 + meta/差分）+ 左竖线体 + 限高视口。

  可达性（旧两份实现共同缺失的一层）：
  - label 行是真正的 button（键盘可达、aria-expanded / aria-controls）；
  - 正文视口 aria-live=off：流式输出不逐句打断读屏（否则每 token
    都会触发播报），需要播报的状态交给 label 行的 meta 文本；
  - running + 吸底跟随时若用户手动上翻，出现「回到底部」显式出口
    （流式容器默认吸底对读屏与触屏都是骚扰源，故必须能退出跟随）。
  ============================================================ -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import BusyRing from './BusyRing.vue';

/** 进程内自增 id：aria-controls 关联用（useId 需 Vue 3.5+，本包基线 3.4） */
let seq = 0;

const props = withDefaults(defineProps<{
  /** label 行标题（如「思考过程」「pwsh · 运行测试」） */
  title?: string;
  /** label 行右侧元信息（步数 / 耗时 / 状态词） */
  meta?: string;
  /** 展开态（配合 toggle 事件受控使用） */
  open?: boolean;
  /** 执行中：label 行渲染 BusyRing，正文吸底跟随 */
  running?: boolean;
  /** 失败态：label 行转 err 色 */
  failed?: boolean;
  /** 正文视口限高（默认取 L0 令牌 --card-viewport-max） */
  viewport?: string;
}>(), { title: '', meta: '', open: false, running: false, failed: false, viewport: 'var(--card-viewport-max)' });

const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();

const uid = `cr-body-${++seq}`;
const body = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
/** 内容是否处于吸底跟随（用户上翻即退出跟随） */
const stuck = ref(true);

function measure() {
  const el = body.value;
  if (!el) return;
  stuck.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
function toBottom() {
  const el = body.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  stuck.value = true;
}

let ro: ResizeObserver | null = null;
watch(inner, (el) => {
  ro?.disconnect();
  ro = null;
  if (!el || typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => {
    if (!props.running || !stuck.value) return;
    void nextTick(toBottom);
  });
  ro.observe(el);
});
onBeforeUnmount(() => { ro?.disconnect(); ro = null; });
</script>

<template>
  <section class="cr" :class="{ 'is-open': open, 'is-running': running, 'is-failed': failed }">
    <button
      type="button"
      class="cr-label"
      :class="{ 'is-failed': failed }"
      :aria-expanded="open"
      :aria-controls="uid"
      @click="emit('toggle', !open)"
    >
      <BusyRing v-if="running" :size="13" class="cr-label-icon" />
      <Icon v-else name="chevron-down" :size="14" class="cr-label-icon cr-chev" />
      <span class="cr-label-title">{{ title }}</span>
      <span v-if="meta" class="cr-meta">{{ meta }}</span>
      <slot name="meta" />
    </button>
    <div v-show="open" :id="uid" ref="body" class="cr-body" @scroll="measure">
      <div ref="inner" class="cr-body-in" :style="{ maxHeight: viewport }"><slot /></div>
    </div>
    <button v-if="open && running && !stuck" type="button" class="cr-tobottom" @click="toBottom">回到底部</button>
  </section>
</template>

<style scoped>
.cr { display: flex; flex-direction: column; min-width: 0; }
.cr-label {
  display: flex; align-items: center; gap: 6px;
  /* 命中区 ≥ --hit-min：label 行是折叠开关，视觉可紧凑，触发面不可小 */
  min-height: var(--hit-min); padding: 2px 0;
  border: 0; background: transparent; text-align: left;
  font-family: inherit; font-size: var(--fs-sm); font-weight: 500;
  color: var(--text-2); cursor: pointer; user-select: none; min-width: 0;
  transition: color var(--dur-fast) var(--ease-out);
}
.cr-label:hover { color: var(--text-1); }
.cr-label.is-failed, .cr-label.is-failed:hover { color: var(--err); }
.cr-label-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-meta { font-size: var(--fs-2xs); color: var(--text-3); flex-shrink: 0; font-family: var(--font-mono); }
.cr-body { margin-top: 4px; margin-left: 7px; border-left: 1px solid var(--line); padding-left: 14px; min-width: 0; }
/* 正文视口：滚动容器（限高）。aria-live=off —— 流式内容不逐句打断读屏。 */
.cr-body-in { overflow-y: auto; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.cr-chev { transition: transform calc(0.12s * var(--motion-scale)) var(--ease-out); }
.cr.is-open .cr-chev { transform: rotate(180deg); }
.cr-tobottom {
  align-self: flex-start; margin: 4px 0 0 7px; padding: 2px 8px;
  border: 1px solid var(--line); border-radius: var(--r-full); background: var(--bg-raised);
  color: var(--text-2); font-family: var(--font-ui); font-size: var(--fs-2xs); cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.cr-tobottom:hover { color: var(--text-1); border-color: var(--line-strong); }
</style>
