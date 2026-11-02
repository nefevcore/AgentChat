<!-- OpenWithButton.vue —— 「打开方式」分体按钮（cr-829）
  左主按钮 = 用记住的应用立即打开；右箭头 = 弹层换默认应用（选择不
  触发打开——下拉+点击复合触发易误开，2026-10-31 用户反馈改 dsh
  OpenTargetButton 分体形态）。弹层配方 = dropdown.css .ui-dd-*
（Select 同源）；Teleport + fixed 定位（cr-175 剪裁教训同款）。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { Icon, IconAction } from '@agentchat/webui-kit';

const props = defineProps<{
  /** 菜单选项（首项 = 系统默认程序，value 空串；icon = 真图标 dataURL） */
  options: Array<{ value: string; label: string; icon?: string | null; iconIcon?: string }>;
  /** 当前生效选择（弹层高亮/勾选项） */
  modelValue: string;
  /** 主按钮态：opening 转圈禁点；error 红警示可重试 */
  state?: 'idle' | 'opening' | 'error';
  /** 动作词（aria-label 前缀：'打开' / '打开文件夹'） */
  action: string;
}>();

const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'select', value: string): void;
}>();

/** 当前生效选项（图标/文案单源） */
const chosen = computed(() => props.options.find((o) => o.value === props.modelValue));
const chosenLabel = computed(() => chosen.value?.label ?? '');
const actionLabel = computed(() => props.action + (chosenLabel.value === '' ? '' : '（' + chosenLabel.value + '）'));
/** 主钮图标：真图标 dataURL 优先，lucide 名回落；opening/error 状态优先覆盖 */
const mainIcon = computed(() => {
  if (props.state === 'opening') return { iconIcon: 'loader-circle', icon: null as string | null };
  if (props.state === 'error') return { iconIcon: 'alert-circle', icon: null as string | null };
  return { iconIcon: chosen.value?.iconIcon ?? 'external-link', icon: chosen.value?.icon ?? null };
});


// ── 弹层（Select.vue 同款骨架：fixed 视口锚定 + z 随宿主层 + 点外/滚动关闭）──
const open = ref(false);
const rootEl = ref<HTMLElement>();
const menuEl = ref<HTMLElement>();
const activeIdx = ref(0);
const menuPos = ref<{ x: number; y: number; down: boolean; w: number; z: number } | null>(null);

/** z 随宿主层（cr-184 同款：扫触发器祖先链取最大 z-index，盖过宿主弹窗） */
function hostZIndex(): number {
  let z = 0;
  let el: Element | null = rootEl.value ?? null;
  while (el instanceof HTMLElement) {
    const v = Number(getComputedStyle(el).zIndex); // '' / auto → NaN 跳过
    if (!Number.isNaN(v) && v > z) z = v;
    el = el.parentElement;
  }
  return z > 0 ? z + 1 : 1100;
}

const MENU_W = 200;

function placeMenu(): void {
  const tr = rootEl.value?.getBoundingClientRect();
  if (!tr) return;
  const est = Math.min(props.options.length * 34 + 8, 268); // 选项高 + padding 上限（Select 同参）
  const below = window.innerHeight - tr.bottom;
  const down = below >= est || below >= tr.top;
  // 右缘对齐触发器（箭头钮窄、弹层宽——右对齐防溢出视口左缘）
  menuPos.value = { x: Math.max(8, tr.right - MENU_W), y: down ? tr.bottom + 6 : tr.top - 6, down, w: MENU_W, z: hostZIndex() };
}

const menuStyle = computed(() => {
  const p = menuPos.value;
  if (!p) return undefined;
  const z = { zIndex: String(p.z) };
  return p.down
    ? { position: 'fixed' as const, ...z, left: p.x + 'px', width: p.w + 'px', top: p.y + 'px' }
    : { position: 'fixed' as const, ...z, left: p.x + 'px', width: p.w + 'px', bottom: (window.innerHeight - p.y) + 'px' };
});

async function toggle() {
  if (props.state === 'opening') return;
  open.value = !open.value;
  if (open.value) {
    activeIdx.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue));
    await nextTick();
    placeMenu();
  }
}

function choose(o: { value: string }): void {
  emit('select', o.value);
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (props.state === 'opening') return;
  if (e.key === 'Escape' && open.value) { open.value = false; return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) { void toggle(); return; }
    const d = e.key === 'ArrowDown' ? 1 : -1;
    for (let i = activeIdx.value + d; i >= 0 && i < props.options.length; i += d) {
      activeIdx.value = i; break;
    }
    return;
  }
  if (e.key === 'Enter' && open.value) {
    e.preventDefault();
    choose(props.options[activeIdx.value]);
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  if (rootEl.value?.contains(t) || menuEl.value?.contains(t)) return;
  open.value = false;
}

/** 滚动/resize 即收起（cr-175 同款：仅滚动源在祖先链上才关——消息区轮询不误关） */
function onScroll(e: Event) {
  if (!open.value) return;
  const t = e.target;
  if (t === document || t === document.documentElement) { open.value = false; return; }
  if (t instanceof Element && rootEl.value) {
    let el: Element | null = rootEl.value;
    while (el) { if (el === t) { open.value = false; return; } el = el.parentElement; }
  }
}
function onResize() { if (open.value) open.value = false; }

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) open.value = false;
}

let bound = false;
function bindDoc() {
  if (bound) return;
  bound = true;
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onDocKeydown);
}
function unbindDoc() {
  if (!bound) return;
  bound = false;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onDocKeydown);
}
onMounted(bindDoc);
onUnmounted(unbindDoc);
</script>

<template>
  <div ref="rootEl" class="owb" @keydown="onKeydown">
    <!-- 主按钮：用记住的应用立即打开（真图标经 #icon 插槽进 kit 钮——
         边框/hover/焦点单源；opening 转圈；error 红警示） -->
    <IconAction
      :icon="mainIcon.iconIcon"
      :label="actionLabel"
      :size="14"
      suppress-title
      :class="{ spin: state === 'opening', error: state === 'error' }"
      :disabled="state === 'opening'"
      @click="emit('open')"
    >
      <template v-if="mainIcon.icon" #icon>
        <img :src="mainIcon.icon" alt="" class="owb-app-icon" draggable="false" />
      </template>
    </IconAction>
    <!-- 箭头：弹层换默认应用（选择不触发打开；opening 期间禁改——dsh 同语义；
         单选项无切换意义藏箭头 = 单按钮形态） -->
    <IconAction
      v-if="options.length > 1"
      icon="chevron-down"
      label="选择打开方式"
      :size="14"
      suppress-title
      :class="{ open }"
      :disabled="state === 'opening'"
      @click="toggle"
    />
    <Teleport to="body">
      <div
        v-if="open && menuPos"
        ref="menuEl"
        class="ui-dd-menu owb-menu"
        :class="{ up: !menuPos.down }"
        role="listbox"
        :style="menuStyle"
      >
        <button
          v-for="(o, i) in options"
          :key="o.value"
          type="button"
          class="ui-dd-opt"
          :class="{ 'is-selected': o.value === modelValue }"
          role="option"
          :aria-selected="o.value === modelValue"
          :style="i === activeIdx ? { background: 'var(--bg-hover)' } : undefined"
          @pointerdown.prevent="choose(o)"
          @click="choose(o)"
        >
          <span class="ui-dd-opt-icon"><img v-if="o.icon" :src="o.icon" alt="" class="owb-app-icon" draggable="false" /><Icon v-else :name="o.iconIcon ?? 'external-link'" :size="16" /></span>
          <span class="ui-dd-opt-body"><span class="ui-dd-opt-name">{{ o.label }}</span></span>
          <Icon v-if="o.value === modelValue" name="check" :size="14" class="ui-dd-opt-check" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 连体分体钮（cr-831）：细边框包裹成一体（dsh 分体按钮同款实体形态）。
   首版曾因「黑边不协调」反馈撤掉边框——后经 F12 确认那圈黑边实为自绘
   button 未继承 kit border:none 的原生边框（已修：#icon 插槽回归单源），
   1px --line 装饰线本身无辜。子钮 hover 各自亮 + 边框整体变亮。 */
.owb {
  display: inline-flex; align-items: stretch;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  position: relative; flex-shrink: 0;
  overflow: hidden; /* 子钮 hover 底裁进容器圆角 */
  transition: border-color var(--dur-fast);
}
.owb:hover { border-color: var(--line-strong); }
.owb :deep(.ui-icon-action) { border-radius: 0; }
.owb :deep(.ui-icon-action + .ui-icon-action) { border-left: 1px solid var(--line); }
.owb :deep(.ui-icon-action.open) { color: var(--primary); }
.owb :deep(.ui-icon-action.error) { color: var(--err); }
.owb :deep(.ui-icon-action.spin) .ui-icon svg { animation: owb-spin 0.9s linear infinite; }
/* 真实应用图标（32px 提取 PNG 视觉缩到 16px 档——与 lucide 尺寸语言对齐） */
.owb-app-icon { width: 16px; height: 16px; object-fit: contain; display: block; }
@keyframes owb-spin { to { transform: rotate(360deg); } }
</style>