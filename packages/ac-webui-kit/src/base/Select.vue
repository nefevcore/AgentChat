<!--
  webui-kit/src/base/Select.vue —— 表单下拉标准件（cr-162）
  归一：表单里原生 <select> 的弹层由 OS 绘制、不可定制，与页面风格割裂
  （2026-10-03 gallery 反馈）；本件以 ui-dd-menu/ui-dd-opt 配方为弹层与
  选项行，表单弹层与 Dropdown 菜单同语言。

  与 Dropdown.vue 的分工：Dropdown = 无状态菜单族容器（trigger/menu 皆 slot，
  开合归业务）；本件 = 有状态单选 select（开合/高亮/选中自持，键盘可达），
  面向表单场景替代原生 <select>。

  cr-175 弹层根修：absolute 定位在滚动容器（overflow:auto）内会被纵向剪裁
  ——靠下字段的下拉底部选项 hit-test 穿透到外层遮罩（mousedown.self 关面板）
  且视觉被裁。弹层改 Teleport 到 body + fixed 视口坐标锚定，完全脱离任何
  剪裁上下文；向下空间不足自动翻上（.up）；滚动/resize 即收起（表单场景
  标准行为——跟随滚动需持续重算，收益低复杂度高）。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** 选项（icon = 行首图标名，iconColor = 品牌色覆盖；缺省继承 currentColor） */
  options: Array<{ value: string; label: string; disabled?: boolean; icon?: string; iconColor?: string }>;
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', placeholder: '请选择', disabled: false });

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const rootEl = ref<HTMLElement>();
const menuEl = ref<HTMLElement>();
const activeIdx = ref(0);

const selected = computed(() => props.options.find(o => o.value === props.modelValue));

/** 弹层视口坐标（fixed）：打开时锚定触发器；down = 向下开（不足翻上）。
 *  y 语义随方向：down = 弹层顶的 top；up = 弹层底的 y（换算距视口底）。
 *  z 随宿主层（cr-184）：弹层 Teleport 到 body 后与弹窗/面板在 body 层
 *  比序——固定值会被高 z Modal（1200+）压住（弹窗内下拉「无弹层」）。
 *  打开时扫触发器祖先链取最大 z-index，盖过宿主所在层；无定位祖先
 *  = 页面平层，维持缺省 1100（高于面板 overlay 1000）。 */
const menuPos = ref<{ x: number; y: number; down: boolean; w: number; z: number } | null>(null);

function hostZIndex(): number {
  let z = 0;
  let el: Element | null = rootEl.value ?? null;
  while (el instanceof HTMLElement) {
    const v = Number(getComputedStyle(el).zIndex); // '' / 'auto' → NaN 跳过
    if (!Number.isNaN(v) && v > z) z = v;
    el = el.parentElement;
  }
  // 宿主 z + 1：确定盖过自家弹窗（同 z 靠 DOM 序胜负，Modal 重挂即反压）；
  // 更上层的弹窗（如弹窗内的确认框 1250）仍盖住本弹层——局部 stacking 语义。
  return z > 0 ? z + 1 : 1100;
}

function placeMenu(): void {
  const tr = rootEl.value?.getBoundingClientRect();
  if (!tr) return;
  const est = Math.min(props.options.length * 34 + 8, 268); // 选项高 + 容器 padding 上限
  const below = window.innerHeight - tr.bottom;
  const down = below >= est || below >= tr.top;
  menuPos.value = { x: tr.left, y: down ? tr.bottom + 6 : tr.top - 6, down, w: tr.width, z: hostZIndex() };
}

/** 模板定位样式（down 用 top 锚、up 用 bottom 锚距视口底换算） */
const menuStyle = computed(() => {
  const p = menuPos.value;
  if (!p) return undefined;
  const z = { zIndex: String(p.z) };
  return p.down
    ? { position: 'fixed' as const, ...z, left: p.x + 'px', width: p.w + 'px', top: p.y + 'px' }
    : { position: 'fixed' as const, ...z, left: p.x + 'px', width: p.w + 'px', bottom: (window.innerHeight - p.y) + 'px' };
});

async function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    activeIdx.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue));
    await nextTick();
    placeMenu();
  }
}

function choose(o: { value: string }) {
  emit('update:modelValue', o.value);
  open.value = false;
}

/** 选项 pointerdown 即选中（mousedown 默认行为会移动焦点——focusout 关菜单
 *  与 click 竞态曾致「点选项无效」（cr-175 复盘：pd→md→菜单卸载→click 落空）。
 *  pointerdown 先于焦点移动，此时选择最稳；click 兜底幂等（菜单已关则无目标）。 */
function onOptPointerDown(e: PointerEvent, o: { value: string }) {
  if (e.button !== 0) return;
  e.preventDefault(); // 阻止焦点移动（保持触发器焦点，避免 focusout 竞态）
  choose(o);
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === 'Escape' && open.value) { open.value = false; return; }
  if (e.key === 'Enter' || e.key === ' ') {
    if (!open.value) { e.preventDefault(); toggle(); return; }
    e.preventDefault();
    const o = props.options[activeIdx.value];
    if (!o.disabled) choose(o);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) { open.value = true; return; }
    const d = e.key === 'ArrowDown' ? 1 : -1;
    for (let i = activeIdx.value + d; i >= 0 && i < props.options.length; i += d) {
        if (!props.options[i].disabled) { activeIdx.value = i; break; }
    }
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  if (rootEl.value?.contains(t) || menuEl.value?.contains(t)) return;
  open.value = false;
}

/** 焦点移出组件即收起（键盘 Tab 离开场景；pointer 走 doc 监听）。
 *  Teleport 弹层不在 rootEl 子树——焦点移入弹层选项（mousedown 默认行为）
 *  不算离开；menuEl ref 在 v-if 重挂时可能滞后，判定兜底扫 DOM 内本实例
 *  弹层（.ui-dd-menu 含 activeElement 即不关）。 */
function onFocusOut() {
  if (open.value) queueMicrotask(() => {
    const active = document.activeElement;
    if (rootEl.value?.contains(active)) return;
    if (menuEl.value?.contains(active)) return;
    if (active instanceof Element && active.closest('.ui-dd-menu')) return;
    open.value = false;
  });
}

/** 滚动/resize 即收起（cr-175：fixed 弹层不跟随，收起比错位好）。
 *  仅当滚动源在 rootEl 祖先链上（弹层锚点会移动）才关；无关元素的
 *  内部滚动（消息区轮询等，target 不在祖先链）不误关。 */
function onScroll(e: Event) {
  if (!open.value) return;
  const t = e.target;
  if (t === document || t === document.documentElement) { open.value = false; return; }
  if (t instanceof Element && rootEl.value) {
    let el: Element | null = rootEl.value;
    while (el) { if (el === t) { open.value = false; return; } el = el.parentElement; }
  }
}
function onResize() {
  if (open.value) open.value = false;
}

let bound = false;
function bindDoc() {
  if (bound) return;
  bound = true;
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
}
function unbindDoc() {
  if (!bound) return;
  bound = false;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
}
onMounted(bindDoc);
onUnmounted(unbindDoc);
watch(() => props.options, () => { if (open.value) placeMenu(); });
</script>

<template>
  <div ref="rootEl" class="ui-sel" :class="{ open, disabled }" @focusout="onFocusOut">
    <button
      type="button"
      class="ui-sel-trigger"
      role="combobox"
      :aria-expanded="open"
      :aria-haspopup="'listbox'"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <Icon v-if="selected?.icon" :name="selected.icon" :size="14" class="ui-sel-icon" :style="selected.iconColor ? { color: selected.iconColor } : undefined" />
      <span class="ui-sel-value" :class="{ empty: !selected }" :title="selected ? selected.label : undefined">{{ selected ? selected.label : placeholder }}</span>
      <Icon name="chevron-down" :size="14" class="ui-sel-chev" :class="{ open }" />
    </button>
    <Teleport to="body">
      <div
        v-if="open && menuPos"
        ref="menuEl"
        class="ui-dd-menu ui-sel-menu"
        :class="{ up: !menuPos.down }"
        role="listbox"
        :style="menuStyle"
      >
        <button
          v-for="(o, i) in options"
          :key="o.value"
          type="button"
          class="ui-dd-opt"
          :class="{ 'is-selected': o.value === modelValue, 'is-disabled': o.disabled }"
          role="option"
          :aria-selected="o.value === modelValue"
          :style="i === activeIdx ? { background: 'var(--bg-hover)' } : undefined"
          @pointerdown="onOptPointerDown($event, o)"
          @click="choose(o)"
        >
          <span v-if="o.icon" class="ui-dd-opt-icon" :style="o.iconColor ? { color: o.iconColor } : undefined"><Icon :name="o.icon" :size="16" /></span>
          <span class="ui-dd-opt-body"><span class="ui-dd-opt-name">{{ o.label }}</span></span>
          <Icon v-if="o.value === modelValue" name="check" :size="14" class="ui-dd-opt-check" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 弹层选项行配方单源：base/dropdown.css（.ui-dd-menu / .ui-dd-opt）——
   本件只补触发器与 fixed 弹层定位；弹层 Teleport 到 body（cr-175：
   脱离滚动容器剪裁），宽度 = 触发器同宽（长选项名 ellipsis 收敛）。 */
.ui-sel { position: relative; display: inline-flex; width: 100%; }
.ui-sel-trigger {
  display: inline-flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; height: var(--ctl-h-md); padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: transparent; color: var(--text-1); /* cr-181：去填充底——与 Input/Textarea 同语言 */
  font-size: var(--fs-md); font-family: var(--font-ui); cursor: pointer;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.ui-sel-trigger:hover:not(:disabled) { border-color: var(--line-strong); }
.ui-sel-trigger:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); }
.ui-sel-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
/* cr-176 长值省略：值行收缩 + 单行 ellipsis（长 label 曾换行撑破固定高触发器）；箭头不缩 */
.ui-sel-value {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 选中项品牌图标（cr-205）：与弹层行首同源（options[].icon），text-3 弱化 */
.ui-sel-icon { flex-shrink: 0; color: var(--text-3); }
.ui-sel-value.empty { color: var(--text-3); }
.ui-sel-chev { flex-shrink: 0; transition: transform var(--dur-fast) var(--ease-out); color: var(--text-3); }
.ui-sel-chev.open { transform: rotate(180deg); }
/* fixed 弹层：top（向下）/bottom（向上）由内联样式锚定；此处只清 absolute 残留 */
.ui-sel-menu { left: 0; }
</style>
