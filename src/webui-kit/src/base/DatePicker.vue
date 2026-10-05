<!--
  webui-kit/src/base/DatePicker.vue —— 日期选择标准件（cr-254）
  归一：原生 input type=date 弹层由 OS 绘制、不可定制（cr-162 Select 存在
  理由同款——color-scheme 只保明暗正确，风格不同构）；本件以自建月历弹层
  走 ui-dd 同语言配方。值面 = YYYY-MM-DD 字符串（与原生件等价），
  消费面（TimerPane 日期、TokenUsage 自定义区间）零语义改动替换。

  骨架复用 Select（cr-162/175/184）：Teleport body + fixed 视口锚定 +
  向下不足翻上 + 祖先链 z 序自适应 + doc pointerdown 关层 + 滚动/resize 收起。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import IconAction from './IconAction.vue';

const props = withDefaults(defineProps<{
  modelValue?: string; // YYYY-MM-DD；空串 = 未选
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', placeholder: '选择日期', disabled: false });

const emit = defineEmits<{ 'update:modelValue': [v: string] }>();

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }
function isLeap(y: number) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysIn(y: number, m: number) { // m: 1-12
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
function dateKey(y: number, m: number, d: number): string { return y + '-' + pad(m) + '-' + pad(d); }
function todayStr(): string {
  const t = new Date();
  return dateKey(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(v: string): { y: number; m: number; d: number } | null {
  const mt = DATE_RE.exec(v);
  if (!mt) return null;
  const y = Number(mt[1]), m = Number(mt[2]), d = Number(mt[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return { y, m, d };
}

const open = ref(false);
const rootEl = ref<HTMLElement>();
const menuEl = ref<HTMLElement>();
const viewYm = ref(''); // 当前视图 yyyymm；空 = 跟随选中值/今天
const viewLevel = ref<'month' | 'year'>('month'); // cr-260：标题上钻两级（月 ↔ 年）
const viewYear = ref(0); // 年视图锚年（进入年视图时初始化）
const gridSeed = ref(0); // 切视图重建网格（清焦点残留）

const selected = computed(() => parseDate(props.modelValue));

const viewInfo = computed(() => {
  const v = viewYm.value || (selected.value
    ? String(selected.value.y) + pad(selected.value.m)
    : todayStr().slice(0, 7).replace('-', ''));
  return { y: Number(v.slice(0, 4)), m: Number(v.slice(4, 6)) };
});

/** 6×7 网格：周一起始，前尾补邻月灰格（补位格禁选——纯导航装饰） */
const cells = computed(() => {
  const y = viewInfo.value.y, m = viewInfo.value.m;
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 周一=0
  const out: Array<{ key: string; day: number; inMonth: boolean }> = [];
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 };
  const prevDays = daysIn(prev.y, prev.m);
  for (let i = lead - 1; i >= 0; i -= 1) out.push({ key: dateKey(prev.y, prev.m, prevDays - i), day: prevDays - i, inMonth: false });
  for (let d = 1; d <= daysIn(y, m); d += 1) out.push({ key: dateKey(y, m, d), day: d, inMonth: true });
  const next = m === 12 ? { y: y + 1, m: 1 } : { y: y, m: m + 1 };
  for (let d = 1; out.length < 42; d += 1) out.push({ key: dateKey(next.y, next.m, d), day: d, inMonth: false });
  return out;
});

function sameDay(k: string): boolean { return props.modelValue === k; }
function isToday(k: string): boolean { return todayStr() === k; }

/** 年视图选中的月（modelValue 的年月 == 视图年月）→ tint 底；当年当月 = 中性环 */
function selMonthClass(m: number): string {
  const s = selected.value;
  if (s && s.y === viewYear.value && s.m === m) return ' is-msel';
  return '';
}
const curMonth = computed(() => {
  const t = todayStr();
  return Number(t.slice(0, 4)) === viewYear.value ? Number(t.slice(5, 7)) : 0;
});

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function chooseMonth(m: number) {
  viewYm.value = String(viewYear.value) + pad(m);
  viewLevel.value = 'month';
  gridSeed.value += 1;
}

/** 翻页随层级：月视图翻月，年视图翻年 */
function shiftView(delta: number) {
  if (viewLevel.value === 'year') viewYear.value += delta;
  else shiftMonth(delta);
}

/** 标题点击：月 → 年（上钻），年 → 回月（下钻到锚年 1 月） */
function toggleZoom() {
  if (viewLevel.value === 'month') {
    viewYear.value = viewInfo.value.y;
    viewLevel.value = 'year';
  } else {
    viewYm.value = String(viewYear.value) + '01';
    viewLevel.value = 'month';
  }
  gridSeed.value += 1;
}

function shiftMonth(delta: number) {
  const y = viewInfo.value.y, m = viewInfo.value.m;
  const total = y * 12 + (m - 1) + delta;
  viewYm.value = String(Math.floor(total / 12)) + pad((total % 12) + 1);
  gridSeed.value += 1;
}

function choose(key: string) {
  emit('update:modelValue', key);
  open.value = false;
}

// ── 弹层定位（Select cr-175/184 同款）──
const menuPos = ref<{ x: number; y: number; down: boolean; w: number; z: number } | null>(null);

function hostZIndex(): number {
  let z = 0;
  let el: Element | null = rootEl.value ?? null;
  while (el instanceof HTMLElement) {
    const v = Number(getComputedStyle(el).zIndex); // '' / 'auto' → NaN 跳过
    if (!Number.isNaN(v) && v > z) z = v;
    el = el.parentElement;
  }
  return z > 0 ? z + 1 : 1100;
}

function placeMenu(): void {
  const tr = rootEl.value?.getBoundingClientRect();
  if (!tr) return;
  const MENU_W = 200; // cr-260：弹层定宽（7×24 矩形日格），不随触发器拉宽
  const est = 240; // 头 + 星期行 + 6 行网格 + padding 的稳定估算
  const below = window.innerHeight - tr.bottom;
  const down = below >= est || below >= tr.top;
  const x = Math.max(8, Math.min(tr.left, window.innerWidth - MENU_W - 8)); // 右缘防溢出
  menuPos.value = { x, y: down ? tr.bottom + 6 : tr.top - 6, down, w: MENU_W, z: hostZIndex() };
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
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    viewYm.value = '';
    viewLevel.value = 'month';
    gridSeed.value += 1;
    await nextTick();
    placeMenu();
  }
}

/** 键盘：Enter/空格开层，Esc 关层，左右箭头翻月（开层态） */
function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (e.key === 'Escape' && open.value) { open.value = false; return; }
  if (e.key === 'Enter' || e.key === ' ') {
    if (!open.value) { e.preventDefault(); toggle(); }
    else e.preventDefault(); // 弹层内日期格自身可达（Tab），触发器 Enter 只防提交
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) { open.value = true; void nextTick().then(placeMenu); }
    return;
  }
  if (open.value && e.key === 'ArrowLeft') { e.preventDefault(); shiftView(-1); }
  if (open.value && e.key === 'ArrowRight') { e.preventDefault(); shiftView(1); }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  if (rootEl.value?.contains(t) || menuEl.value?.contains(t)) return;
  open.value = false;
}

/** 滚动/resize 即收起（cr-175 同款：fixed 弹层不跟随，收起比错位好） */
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
</script>

<template>
  <div ref="rootEl" class="ui-dp" :class="{ open, disabled }">
    <button
      type="button"
      class="ui-dp-trigger"
      role="combobox"
      :aria-expanded="open"
      :aria-haspopup="'dialog'"
      :aria-label="'选择日期' + (modelValue ? '，当前 ' + modelValue : '')"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <Icon name="calendar" :size="14" class="ui-dp-ic" />
      <span class="ui-dp-value" :class="{ empty: !modelValue }">{{ modelValue || placeholder }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open && menuPos"
        ref="menuEl"
        class="ui-dd-menu ui-dp-menu"
        :class="{ up: !menuPos.down }"
        role="dialog"
        aria-label="日期选择"
        :style="menuStyle"
      >
        <div class="ui-dp-head">
          <IconAction :icon="'chevron-left'" :label="viewLevel === 'month' ? '上一月' : '上一年'" @click="shiftView(-1)" />
          <button type="button" class="ui-dp-title" :aria-label="viewLevel === 'month' ? '查看年视图' : '回到月视图'" @click="toggleZoom">{{ viewLevel === 'month' ? viewInfo.y + ' 年 ' + viewInfo.m + ' 月' : viewYear + ' 年' }}</button>
          <IconAction :icon="'chevron-right'" :label="viewLevel === 'month' ? '下一月' : '下一年'" @click="shiftView(1)" />
        </div>
        <template v-if="viewLevel === 'month'">
          <div class="ui-dp-week">
            <span v-for="w in WEEKDAYS" :key="w">{{ w }}</span>
          </div>
          <div :key="gridSeed" class="ui-dp-grid">
            <button
              v-for="c in cells"
              :key="c.key"
              type="button"
              class="ui-dp-cell"
              :class="{ 'is-sel': sameDay(c.key), 'is-today': isToday(c.key), 'is-out': !c.inMonth }"
              :disabled="!c.inMonth"
              :aria-label="c.key"
              :aria-pressed="sameDay(c.key)"
              @click="choose(c.key)"
            >{{ c.day }}</button>
          </div>
        </template>
        <div v-else :key="gridSeed" class="ui-dp-months">
          <button
            v-for="(name, idx) in MONTHS"
            :key="name"
            type="button"
            class="ui-dp-mcell"
            :class="selMonthClass(idx + 1) + (curMonth === idx + 1 ? ' is-mcur' : '')"
            :aria-label="viewYear + ' 年 ' + (idx + 1) + ' 月'"
            @click="chooseMonth(idx + 1)"
          >{{ name }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 触发器与 Select 同语言（ui-sel-trigger 同配方）；弹层壳走 ui-dd-menu 单源，
   此处只补月历网格。z/定位内联（fixed）——与 Select 相同。 */
.ui-dp { position: relative; display: inline-flex; width: 100%; }
.ui-dp-trigger {
  display: inline-flex; align-items: center; gap: 8px;
  width: 100%; height: var(--ctl-h-md); padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--r-sm);
  background: transparent; color: var(--text-1);
  font-size: var(--fs-md); font-family: var(--font-ui); cursor: pointer;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.ui-dp-trigger:hover:not(:disabled) { border-color: var(--line-strong); }
.ui-dp-trigger:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); }
.ui-dp-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.ui-dp-ic { flex-shrink: 0; color: var(--text-3); }
.ui-dp-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.ui-dp-value.empty { color: var(--text-3); }
/* 月历弹层：定宽（7×32 + gap/padding），覆盖 ui-dd-menu 的滚动条假设 */
.ui-dp-menu { width: 200px; padding: 10px; max-height: none; overflow: visible; }
.ui-dp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
/* 标题可点上钻/下钻（cr-260）——按钮语义 + hover 提示 */
.ui-dp-title {
  border: none; background: none; padding: 2px 6px; border-radius: var(--r-sm);
  font-size: var(--fs-md); font-weight: 600; color: var(--text-1); font-family: var(--font-ui);
  cursor: pointer;
}
.ui-dp-title:hover { background: var(--bg-hover); }
.ui-dp-week { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 2px; }
.ui-dp-week span { text-align: center; font-size: var(--fs-xs); color: var(--text-3); padding: 3px 0; }
.ui-dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.ui-dp-cell {
  display: inline-flex; align-items: center; justify-content: center;
  height: 24px; border: none; border-radius: var(--r-sm);
  background: none; color: var(--text-1);
  font-size: var(--fs-xs); font-family: var(--font-ui); font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.ui-dp-cell:hover:not(:disabled) { background: var(--bg-hover); }
.ui-dp-cell:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: calc(-1 * var(--focus-ring-width)); }
.ui-dp-cell.is-out { color: var(--text-3); opacity: 0.45; cursor: default; }
.ui-dp-cell.is-out:hover { background: none; }
/* 今日 = 中性描边环（今日是事实陈述，非状态语义）；选中 = 主色实底 */
.ui-dp-cell.is-today { box-shadow: inset 0 0 0 1px var(--line-strong); }
.ui-dp-cell.is-sel { background: var(--primary); color: var(--on-primary); font-weight: 600; }
.ui-dp-cell.is-sel.is-today { box-shadow: none; }
/* 年视图（cr-260）：3×4 月格；选中月 tint 底 + 当月中性环（与日格同语义） */
.ui-dp-months { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; }
.ui-dp-mcell {
  display: inline-flex; align-items: center; justify-content: center;
  height: 44px; border: none; border-radius: var(--r-sm);
  background: none; color: var(--text-1);
  font-size: var(--fs-sm); font-family: var(--font-ui); cursor: pointer;
}
.ui-dp-mcell:hover { background: var(--bg-hover); }
.ui-dp-mcell:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: calc(-1 * var(--focus-ring-width)); }
.ui-dp-mcell.is-msel { background: var(--primary-tint); color: var(--primary-strong); font-weight: 600; }
.ui-dp-mcell.is-mcur { box-shadow: inset 0 0 0 1px var(--line-strong); }
.ui-dp-mcell.is-msel.is-mcur { box-shadow: none; }
</style>
