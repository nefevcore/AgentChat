<!--
  TagChoice.vue —— 抉择组胶囊（2026-12 标签配置语义升级：分组内 tag
  合一为「启停胶囊 + 换档弹层」）

  形态：三段胶囊 [tag-name | tag-label | 下拉]——左段 raw 词名（mono；
  关闭态 = 缺省词/组键兜底），中段展示短名（关闭态 = 缺省词描述或组
  offDesc），左中两段合体为启停开关（on 态亮色，点击停用回组缺省；
  off 态幽灵态，点击启用恢复上次档/首档），右段 chevron 弹出换档弹层
  （两行选项：短名 + 完整描述 + check 选中态，选中即关弹层）。与普通
  tag-badge 同视觉语系（圆角胶囊 + --tag-hue 色相驱动；普通徽章同为
  [tag | label] 两段形式），交互模式对标 ChatInput dd-menu（单开原则 +
  document 点外关闭 + menu-fade 过渡）。

  落词全部经 applyExclusiveChoice 单源（父组件 AgentPane 传入的
  onChoose 回调）：选普通词 → 互斥换档；选 exclusiveNone 词 → 不落词
  （缺席即语义）；tier 族选高层连带写齐低层。判定面（tierOf /
  toolModeOf / browser 层级门禁）零感知。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Icon } from '@agentchat/webui-kit';
import { noneTagOf, pickRestoreTag, type ExclusiveGroup } from './tagExclusive.ts';

const props = defineProps<{
  /** 抉择组（tagExclusive 聚合产物） */
  group: ExclusiveGroup;
  /** 组内词 → 展示短名（父级 label 表单源） */
  labelOf: (tag: string) => string;
  /** 组内词 → 悬浮提示（父级 tooltip 单源） */
  titleOf: (tag: string) => string;
  /** 当前在册词（'' = 缺省/关闭态） */
  value: string;
  /** 换档/启停落词回调（applyExclusiveChoice 在父级执行——tags 写通道单源） */
  onChoose: (nextTag: string | null) => void;
}>();

const open = ref(false);
/** 组件根元素（点外关闭的容器判定） */
const rootEl = ref<HTMLElement | null>(null);
/** 停用时的恢复记忆（上次显式选择的组内词；启用左半时优先恢复） */
const restoreTag = ref<string | null>(null);

/** 组的「都不选」词（exclusiveNone；无 → null） */
const noneTag = computed(() => noneTagOf(props.group));
/** 胶囊是否启用（value 命中组内非缺省词） */
const enabled = computed(() => {
  if (!props.value) return false;
  const item = props.group.items.find((i) => i.tag === props.value);
  return !!item && !item.exclusiveNone;
});
/**
 * 中段展示名（三段 [tag-name | tag-label | 下拉] 的 tag-label 段）：
 * 启用 = 当前档短名；关闭 = 描述文案直接入胶囊（置灰已表达状态，
 * 文案承载语义——不写「关闭」占位）：有缺省词的组 = 缺省词 description
 * （目录单源）；无缺省词的组 = 声明方 exclusiveOffDesc。两源皆无的
 * 极端组 → 兜底「关闭」（无语义可显）
 */
const chipLabel = computed(() => {
  if (enabled.value) return props.labelOf(props.value);
  if (noneTag.value) return props.titleOf(noneTag.value);
  return props.group.offDesc ?? '关闭';
});
/** 左段 raw 词名（tag-name 段）：当前在册词；关闭态 = 缺省词（缺席即
 *  语义的有效词）；无缺省词的组 = 组键（胶囊的身份兜底） */
const chipName = computed(() => props.value || noneTag.value || props.group.key);
/** 弹层顶部「关闭」选项（仅无缺省词的组——有缺省词的组关闭即选缺省词，
 *  弹层已有该项）；desc = offDesc（全关后果） */
const offOption = computed(() =>
  noneTag.value ? null : { value: '', label: '关闭（都不选）', desc: props.group.offDesc ?? '停用本组全部标签' },
);
/** 弹层选项（组内词按 order 序） */
const options = computed(() => props.group.items);
const selectedOf = (tag: string) =>
  props.value === tag || (!props.value && tag === noneTag.value);

/**
 * 点外关闭：捕获阶段 pointerdown + 容器判定（target 不在本组件内 → 关）。
 * 捕获阶段从 document 往下走，冒泡路径上任何祖先的 @click.stop（如设置
 * 面板壳 sp-panel）都拦不住——ChatInput 的 document click 方案在设置壳
 * 内恰好失效（事件被 stop 在壳层，到不了 document），这是弹层外点关闭
 * 的结构性修法；contains 判定兼顾组件内点击（胶囊/选项）不打扰。
 */
function onPointerDown(e: PointerEvent) {
  if (!open.value) return;
  if (rootEl.value && e.target instanceof Node && rootEl.value.contains(e.target)) return;
  open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', onPointerDown, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown, true));

function toggleOpen() {
  open.value = !open.value;
}

/** 左半启停：启用 = 恢复记忆（或组内首档）；停用 = 落缺省词（或 null 剔除） */
function toggleEnabled() {
  open.value = false; // 启停与弹层互斥（单开）
  if (enabled.value) {
    restoreTag.value = props.value;
    props.onChoose(noneTag.value);
  } else {
    const restore = restoreTag.value ?? pickRestoreTag(props.group);
    if (restore) props.onChoose(restore);
  }
}

/** 弹层换档：记忆非缺省选择后落词，即关弹层 */
function choose(tag: string) {
  const item = props.group.items.find((i) => i.tag === tag);
  if (item && !item.exclusiveNone) restoreTag.value = tag;
  open.value = false;
  props.onChoose(tag);
}

/** 弹层「关闭」选项（无缺省词组）：落 null（剔除组内全部词） */
function chooseOff() {
  open.value = false;
  props.onChoose(noneTag.value); // noneTag 为 null → onChoose(null) 剔除
}
</script>

<template>
  <div ref="rootEl" class="tc-dd" @click.stop>
    <div class="tc-pill" :class="{ on: enabled }">
      <button
        type="button" class="tc-toggle"
        :title="enabled ? props.titleOf(props.value) + '\n点击停用（回缺省档）' : '点击启用（恢复上次选择或首档）'"
        @click="toggleEnabled"
      >
        <span class="tc-dot" />
        <span class="tc-name">{{ chipName }}</span>
        <span class="tc-label">{{ chipLabel }}</span>
      </button>
      <button
        type="button" class="tc-trigger"
        :class="{ open }"
        :title="'选择' + (enabled ? '其他档' : '档位')"
        @click="toggleOpen"
      >
        <Icon name="chevron-down" :size="12" class="tc-chevron" :class="{ open }" />
      </button>
    </div>
    <Transition name="menu-fade">
      <div v-if="open" class="tc-menu">
        <button
          v-if="offOption" type="button"
          class="tc-option tc-option--off" :class="{ selected: !props.value }"
          :title="offOption.desc"
          @click="chooseOff()"
        >
          <span class="tc-option-body">
            <span class="tc-option-name">{{ offOption.label }}</span>
            <span class="tc-option-desc">{{ offOption.desc }}</span>
          </span>
          <Icon v-if="!props.value" name="check" :size="14" class="tc-option-check" />
        </button>
        <button
          v-for="o in options" :key="o.tag" type="button"
          class="tc-option" :class="{ selected: selectedOf(o.tag) }"
          :title="titleOf(o.tag)"
          @click="choose(o.tag)"
        >
          <span class="tc-option-body">
            <span class="tc-option-name">{{ labelOf(o.tag) }}</span>
            <span class="tc-option-desc">{{ titleOf(o.tag) }}</span>
          </span>
          <Icon v-if="selectedOf(o.tag)" name="check" :size="14" class="tc-option-check" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tc-dd { position: relative; display: inline-flex; }
.tc-pill {
  display: inline-flex; align-items: stretch; border-radius: var(--r-full);
  border: 1px solid color-mix(in srgb, var(--text-3) 14%, transparent);
  background: color-mix(in srgb, var(--text-3) 6%, transparent);
  overflow: hidden;
  transition: background var(--dur-fast), border-color var(--dur-fast);
}
.tc-pill.on {
  border-color: color-mix(in srgb, var(--tag-hue, var(--primary)) 20%, transparent);
  background: color-mix(in srgb, var(--tag-hue, var(--primary)) 8%, transparent);
}
.tc-pill.on:hover { background: color-mix(in srgb, var(--tag-hue, var(--primary)) 12%, transparent); }
.tc-pill:not(.on):hover { background: color-mix(in srgb, var(--text-3) 11%, transparent); }
/* 左半：启停 */
.tc-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 4px 3px 10px; border: none; background: none;
  font-size: 11px; color: var(--text-3); cursor: pointer;
  transition: color var(--dur-fast);
  min-width: 0;
}
/* 左段 raw 词名（mono；与中段的段界 = 细分隔线） */
.tc-name {
  font-family: var(--font-mono);
  font-size: 10.5px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 中段文案（关闭态 = 描述较长）：截断收敛，全文在 title（toggle 的
 * title 已含描述语义时的悬浮与弹层选项描述同源） */
.tc-label {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 7px;
  border-left: 1px solid color-mix(in srgb, var(--text-3) 18%, transparent);
}
.tc-pill.on .tc-label { border-left-color: color-mix(in srgb, var(--tag-hue, var(--primary)) 22%, transparent); }
.tc-pill.on .tc-toggle { color: color-mix(in srgb, var(--tag-hue, var(--primary)) 75%, var(--text-1)); font-weight: 500; }
.tc-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: color-mix(in srgb, var(--text-3) 45%, transparent);
  transition: background var(--dur-fast), box-shadow var(--dur-fast);
}
.tc-pill.on .tc-dot {
  background: var(--tag-hue, var(--primary));
  box-shadow: 0 0 5px color-mix(in srgb, var(--tag-hue, var(--primary)) 60%, transparent);
}
/* 右半：换档弹层触发 */
.tc-trigger {
  display: inline-flex; align-items: center;
  padding: 3px 6px; border: none; background: none; cursor: pointer;
  color: var(--text-3);
  border-left: 1px solid color-mix(in srgb, var(--text-3) 14%, transparent);
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.tc-trigger:hover { color: var(--text-1); }
.tc-pill.on .tc-trigger { border-left-color: color-mix(in srgb, var(--tag-hue, var(--primary)) 20%, transparent); }
.tc-chevron { transition: transform .15s ease; }
.tc-chevron.open { transform: rotate(180deg); }
/* 弹层（对标 ChatInput dd-menu 视觉，向下弹出——分组区在页面上方） */
.tc-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 300;
  min-width: 230px; max-width: 340px; max-height: 280px; overflow-y: auto;
  background: var(--bg-raised, var(--bg));
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-pop, 0 4px 16px rgba(0, 0, 0, .12));
  padding: 4px;
}
.tc-option {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  padding: 6px 10px; border: none; border-radius: 6px; background: none;
  color: var(--text-1); font-size: 12px; cursor: pointer; text-align: left;
}
.tc-option:hover { background: var(--bg-hover); }
/* 「关闭」选项：与档位选项分隔（细分隔线——组头感） */
.tc-option--off { border-bottom: 1px solid var(--line); border-radius: 6px 6px 0 0; margin-bottom: 2px; }
.tc-option--off .tc-option-name { color: var(--text-2); }
.tc-option.selected .tc-option-name { font-weight: 600; }
.tc-option-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tc-option-name { white-space: nowrap; }
.tc-option-desc {
  font-size: 10.5px; color: var(--text-3); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tc-option-check { margin-left: auto; flex-shrink: 0; color: var(--primary); }
.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity .12s ease, transform .12s ease; }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
