<!-- ============================================================
  webui-kit/src/base/CardFrame.vue —— 卡片骨架（cr-765 批次A：CollapseRow 升级）
  所有会话流卡片共用：label 行（图标位 + 标题 + 右侧 meta/控件）+ 左竖线体
  + 限高视口 + 吸底跟随。原 CollapseRow 契约全保留（aria-expanded /
  aria-controls / aria-live=off / running 吸底 / 回到底部出口）。

  新增契约（optimization.md §1.2）：
  - icon：语义图标名（icons.ts 注册表）；hover 让位折叠箭头，running 让位
    旋转环——与 ToolMessage/AssistantMessage 手写行为同构；
  - tone：warn/err 状态色（#7 无输出标黄等）；failed 是 err 的旧别名；
  - canExpand=false：无展开体（#7 无输出卡）——label 不再是 button，
    仅状态展示行；
  - controls slot：右侧控件锚点（复制/展开全文等——布局与顺序归骨架，
    业务只声明「有哪些钮」）。
  ============================================================ -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import BusyRing from './BusyRing.vue';

/** 进程内自增 id：aria-controls 关联用（useId 需 Vue 3.5+，本包基线 3.4） */
let seq = 0;

const props = withDefaults(defineProps<{
  /** label 行标题（如「思考过程」「pwsh · 运行测试」） */
  title?: string;
  /** label 行语义图标名（icons.ts 注册表；hover 让位折叠箭头，running 让位旋转环） */
  icon?: string;
  /** label 行右侧元信息（步数 / 耗时 / 状态词） */
  meta?: string;
  /** 展开态（配合 toggle 事件受控使用） */
  open?: boolean;
  /** 执行中：label 行渲染 BusyRing，正文吸底跟随 */
  running?: boolean;
  /** 状态色：err=失败红 / warn=警示黄（failed 为 err 旧别名保留） */
  tone?: 'err' | 'warn' | '';
  /** 失败态（= tone err 的旧入口，迁移期保留） */
  failed?: boolean;
  /** 无展开体：label 退化为纯状态行（非 button、无 aria 折叠语义） */
  canExpand?: boolean;
  /** 正文视口限高（默认取 L0 令牌 --card-viewport-max） */
  viewport?: string;
}>(), { title: '', icon: '', meta: '', open: false, running: false, tone: '', failed: false, canExpand: true, viewport: 'var(--card-viewport-max)' });

const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();

const uid = `cf-body-${++seq}`;
const hover = ref(false);
const body = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
/** 内容是否处于吸底跟随（用户上翻即退出跟随） */
const stuck = ref(true);

/** 状态色归一：failed 是 err 的旧别名 */
const toneClass = computed(() => props.failed ? 'err' : props.tone);

/** 图标位：running 旋转环 > hover 折叠箭头 > 语义图标 > 默认 chevron（可展开时） */
const leadIcon = computed(() => {
  if (props.running) return '';
  if (hover.value && props.canExpand) return props.open ? 'chevron-up' : 'chevron-down';
  return props.icon || 'chevron-down';
});

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
  <section class="cf" :class="{ 'is-open': open && canExpand, 'is-running': running, ['is-' + toneClass]: toneClass }">
    <component
      :is="canExpand ? 'button' : 'div'"
      :type="canExpand ? 'button' : undefined"
      class="cf-label"
      :class="{ ['is-' + toneClass]: toneClass, 'no-expand': !canExpand }"
      :aria-expanded="canExpand ? open : undefined"
      :aria-controls="canExpand ? uid : undefined"
      @click="canExpand && emit('toggle', !open)"
      @mouseenter="hover = true"
      @mouseleave="hover = false"
    >
      <BusyRing v-if="running" :size="13" class="cf-label-icon" />
      <Icon v-else-if="leadIcon" :name="leadIcon" :size="14" class="cf-label-icon cf-chev" :class="{ 'is-fold': !icon && !hover && canExpand }" />
      <span class="cf-label-title">{{ title }}</span>
      <span v-if="meta" class="cf-meta">{{ meta }}</span>
      <slot name="meta" />
      <span v-if="$slots.controls" class="cf-controls" @click.stop>
        <slot name="controls" />
      </span>
    </component>
    <div v-show="open && canExpand" :id="uid" ref="body" class="cf-body" @scroll="measure">
      <div ref="inner" class="cf-body-in" :style="{ maxHeight: viewport }"><slot /></div>
    </div>
    <button v-if="open && canExpand && running && !stuck" type="button" class="cf-tobottom" @click="toBottom">回到底部</button>
  </section>
</template>

<style scoped>
.cf { display: flex; flex-direction: column; min-width: 0; }
.cf-label {
  display: flex; align-items: center; gap: 6px;
  /* 命中区 ≥ --hit-min：label 行是折叠开关，视觉可紧凑，触发面不可小 */
  min-height: var(--hit-min); padding: 2px 0;
  border: 0; background: transparent; text-align: left;
  font-family: inherit; font-size: var(--fs-sm); font-weight: 500;
  color: var(--text-2); cursor: pointer; user-select: none; min-width: 0;
  transition: color var(--dur-fast) var(--ease-out);
}
.cf-label:hover { color: var(--text-1); }
.cf-label.is-err, .cf-label.is-err:hover { color: var(--err); }
.cf-label.is-warn, .cf-label.is-warn:hover { color: var(--warn); }
.cf-label.no-expand { cursor: default; }
.cf-label-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf-meta { font-size: var(--fs-2xs); color: var(--text-3); flex-shrink: 0; font-family: var(--font-mono); }
/* 控件锚点：布局与间距归骨架；hover 可见性由消费方控件自带（此处常驻防跳） */
.cf-controls { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-shrink: 0; }
.cf-body { margin-top: 4px; margin-left: 7px; border-left: 1px solid var(--line); padding-left: 14px; min-width: 0; }
/* 正文视口：滚动容器（限高）。aria-live=off —— 流式内容不逐句打断读屏。 */
.cf-body-in { overflow-y: auto; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.cf-chev { transition: transform calc(0.12s * var(--motion-scale)) var(--ease-out); }
.cf.is-open .cf-chev { transform: rotate(180deg); }
.cf-tobottom {
  align-self: flex-start; margin: 4px 0 0 7px; padding: 2px 8px;
  border: 1px solid var(--line); border-radius: var(--r-full); background: var(--bg-raised);
  color: var(--text-2); font-family: var(--font-ui); font-size: var(--fs-2xs); cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.cf-tobottom:hover { color: var(--text-1); border-color: var(--line-strong); }
</style>