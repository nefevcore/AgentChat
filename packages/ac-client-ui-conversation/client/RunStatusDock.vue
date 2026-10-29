<!-- RunStatusDock.vue —— 会话运行状态指示（cr-744/751；cr-769~792 重塑）

  视觉立场（用户裁决 2026-10-29，第 3~10 轮定稿）：**透明容器 + 整行双层色域 + 单点**。
  前几版的问题：① 挂 DockCard 壳 + 主色胶囊带 → 读成「dock 列里又一张卡」；
  ② 去壳成纯文字行 → 太轻；③ 悬浮 pill 壳（底/边/影）→ 壳本身与 composer 的
  输入卡几乎同形，反而制造割裂；④ 纯无底行 → 读数与背后的消息文字混在一起，
  密排时看不清；⑤ 光晕叠在色域上 → 发糊（色域已提供视觉承托，光晕是双份）；
  ⑥ 色域分两块（文案区 / 计时区）→ 读起来像两个物件，且各自的 backdrop-filter
  叠上去发糊。本版：**容器保持完全透明**（不铺底、不描边、不投影，绝不遮挡其下
  内容），可读性交给**整行一条**「相位色域」。色带用 .chain-header.expanded 同款
  「渐隐底色」手法：纵向渐变 + 横向 mask 双轴淡出，没有硬边；不用 backdrop-filter。
  色带本身是**双层**（cr-791，用户 F12 调出的配方）：上层相位色、下层实底色——
  只有色相层时读数仍会与背后的消息文字混，垫一层底才真正压得住。底色取 --rs-base
  （默认 --bg-base，随主题走），因此暗色下不是白块、亮色下正好是白。
  行高（cr-793）：纵向内边距 5px（内容 15 + 上下各 5 = 行高 25px）。渐变停点都是
  百分比，行越高过渡的绝对像素越多——加高就是为了让 30%/70% 那段渐隐有地方展开；
  短行（19px）上只有 5.7px 可展开，读起来像一条硬边。

  构图：`[● 文案] [计时]` 一行，整行共用一条色域——**文案在前、计时在后**（cr-782：
  读的人在找「现在在做什么」，时间只是它的注脚，放前面会先被当成主信息读）。
  整行左缩进 = 消息区左 padding + 头像位（32 + 10）− 色域内边距，文字左缘仍精确
  落在消息正文起点——读作正文的一行旁注。
  计时与文案同一层级（--fs-sm / --text-2），唯一的强调是状态点：色相是「现在在
  做什么」的唯一载体，同时也是整条色域的底色来源。计时刻意弱化到与文案同级
  （第 4 轮：读数不做主角），第 6 轮再降一级字号；只留 tabular-nums 让秒进位不抖宽。
  状态点 = 运行语义载体：主呼吸（scale + opacity）+ 外扩余波（心跳—余波）。

  主题正确性（cr-773 根因修复）：文字一律走令牌——--text-2 / 错误 --err，
  点与色域用组件私有 --tone（亮极 html.light 下潜一档）。此前写死 rgba(255,255,255,…)
  且以 [data-theme="aurora"] 判亮极：内置主题 classic 下 data-theme 属性不存在
  （ac-client-ui-theme 对 classic 撤属性，只留 html.dark/.light），选择器永不命中 →
  亮色下白字白底隐形。明暗极一律以 html.light 触发（明暗 class 与色板 id 正交，
  主题包同样带）。无壳后不再有「底」，因此也没有需要令牌化的结构面——只剩文字与光。

  相位 = 色相 × 呼吸周期（读文案之前先读颜色与节律）：
    waking    冷灰 3.6s 慢呼吸——投递/冷启动窗
    calling   蓝   2.8s——模型往返等待
    thinking  紫   2.4s——推理流
    tooling   琥珀 1.6s 急促——工具执行
    replying  绿   2.2s——内容外流
    error     玫红 静止——失败不是活动（呼吸全停，只余静态点）
  语义色只落在点与色域里，文字仍走中性层级——不与 ok/warn/err 墨色轴打架。

  动效分级（cr-770 家法）：点的主呼吸 + 余波是忙指示——豁免 --motion-scale
  （reduce 下不静止，「运行中」不能降级成静止图）；文案呼吸是氛围，时长乘
  --motion-scale → reduce 下自然静止。
  a11y：相位文案独占 role=status（计时每秒进位不进播报面）。 -->
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { formatDurationCn, type RunStatus } from './runStatus.ts';

const props = defineProps<{
  status: RunStatus;
}>();

/** 计时 tick：秒进位驱动（1s setInterval——忙指示豁免 reduce） */
const nowTick = ref(Date.now());
const timer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));

const visible = computed(() => props.status.kind !== 'hidden');
const kind = computed(() => props.status.kind);

/** 状态文案（人性化短句） */
const PHRASES: Record<string, string> = {
  waking: '收到消息，正在唤醒中…',
  calling: '正在等待模型响应…',
  thinking: '正在深度思考…',
  tooling: '正在执行工具…',
  replying: '正在回复…',
};

/** 整体耗时（自发送起算） */
const elapsedText = computed(() => {
  const s = props.status;
  if (!('sinceMs' in s) || s.sinceMs <= 0) return '';
  return formatDurationCn((nowTick.value - s.sinceMs) / 1000);
});

/** 状态文案（error 直接显示错误） */
const phrase = computed(() => {
  const s = props.status;
  return s.kind === 'error' ? s.text : PHRASES[s.kind] ?? '';
});
</script>

<template>
  <!-- 透明容器 + 整行一条相位色域——左对齐，不铺满宽。
       顺序 = 文案在前、计时在后（cr-782）：读的人在找「现在在做什么」，
       时间只是它的注脚——放前面会先被当成主信息读。 -->
  <div v-if="visible" class="run-signal" :class="`phase-${kind}`" :aria-busy="kind !== 'error'">
    <span class="rs-line">
      <span class="rs-status">
        <span class="rs-dot" aria-hidden="true"></span>
        <span class="rs-label" role="status" aria-live="polite">{{ phrase }}</span>
      </span>
      <span v-if="elapsedText" class="rs-clock">{{ elapsedText }}</span>
    </span>
  </div>
</template>

<style scoped>
/* 左对齐消息正文：缩进 = 消息区左 padding + 头像位（头像 32 + 与内容列间距 10
   = 42，与 TurnDisplayItem 的 .turn-chain-row.is-cont 同基准）——状态行读作
   正文的一行旁注，而不是浮在头像位上的独立物件。
   .run-signal 自身不设 background——容器恒透明 */
.run-signal {
  --breath: 2.8s;
  --tone: 148, 163, 184; /* RGB 分量：相位色（点 + 色域共用） */
  --scrim-a: 0.22; /* 色域浓度（亮极减档，见 html.light 覆盖） */
  --ease-breath: cubic-bezier(0.45, 0, 0.55, 1); /* 对称缓动：起伏像呼吸不像脉冲 */
  /* 色域内边距：横向留出的距离（> 横向淡化宽度 10px）；纵向是「色带有多高」——
     越高渐变过渡越有地方展开（cr-793）。行高 = 内容 19px + 2×padding。 */
  --rs-pad-x: 12px;
  --rs-pad-y: 5px;
  /* 底色层：色相底下垫的一层「实色」，读数才真正压得住背后的消息文字。
     默认取 --bg-base（浅色 ≈ #fdfdfb、暗色 ≈ #1a1a1a）——两侧都读作「页面底
     上挖出的一块」。想让色带更像浮起的面片，改 --rs-base: var(--bg-raised)；
     想保留半透，直接写 rgba(...)（渐变按预乘 alpha 插值，不会出灰雾）。 */
  --rs-base: var(--bg-base);
  /* 底色层边缘的软化宽度（占「行高」比例的起点）：越大越柔、越小越像硬边色片。
     百分比随行高自动缩放——行高 29px 时 20% ≈ 上下各 6px 过渡（cr-793 加高后
     的实测值），比原来 19px 行高上的 4px 更舒展。 */
  --rs-base-ramp: 20%;
  display: flex;
  justify-content: flex-start;
  /* 左缩进扣掉色域内边距：文字左缘仍精确落在消息正文起点 */
  margin: 0 16px 4px calc(var(--space-md) + 42px - var(--rs-pad-x));
}

/* 读数行（cr-786）：色域载体从「文案区 / 计时区」两块收敛为整行一条——读数
   因此读作「一句话」而不是两个各自带底色的物件。max-width: 100% 让长错误文案
   能触发 .rs-label 的省略号（否则整行溢出容器）。色带本身见下方 ::before。 */
.rs-line {
  position: relative;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: var(--rs-pad-y) var(--rs-pad-x);
  border-radius: var(--r-full);
}

/* 相位色域（cr-786 → 789）：整行一条，读数读作「一句话」。
   纵向由 background 双层渐变给（色相 + 底色，中段实色承载文字、上下缘化掉），
   横向由 mask 给（左右各 10px 淡出，否则左右两侧会被 border-radius 硬切）。
   不用 backdrop-filter：磨砂对文字-文字叠压的改善有限，却会把背后一切糊成雾。
   ::before + z-index:-1 是因为 mask 会作用到元素全部内容（含文字）；把色域拆到
   伪元素上，mask 只裁伪元素。父级 isolation:isolate 把 -1 锁在元素内部（否则会
   沉到更外层的层叠上下文背景之下，被消息内容盖住）。 */
.rs-line::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  /* 双层（cr-791，用户 F12 调出的配方）：上层色相、下层底色。
     顺序即绘制序——先列的在最上，所以色相压在底色之上。
     底色层的实色段（20%/80%）比色相段（30%/70%）更宽：边缘先漏出一点中性
     底色再过渡到透明，读作「色带坐在一层薄壳里」，而不是纯色相硬贴上去。 */
  background:
    linear-gradient(to bottom,
      transparent,
      rgba(var(--tone), var(--scrim-a)) 30%,
      rgba(var(--tone), var(--scrim-a)) 70%,
      transparent),
    linear-gradient(to bottom,
      transparent,
      var(--rs-base) var(--rs-base-ramp),
      var(--rs-base) calc(100% - var(--rs-base-ramp)),
      transparent);
  /* 横向淡出 10px < 色域内边距 12px：文字与状态点恒落在实色区 */
  -webkit-mask-image: linear-gradient(to right, transparent, #000 10px, #000 calc(100% - 10px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 10px, #000 calc(100% - 10px), transparent);
  pointer-events: none;
}

/* 计时与相位文案同级（cr-773/775：读数不做主角、再降一级）。
   tabular-nums 只保秒进位不抖宽 */
.rs-clock {
  flex: none;
  font-size: var(--fs-sm);
  font-weight: 400;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--text-2);
}

.rs-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  /* 可伸缩：文案在前（cr-782），长错误文案靠它让位给 ellipsis；
     计时是 flex: none——秒进位不因文案长短而跳宽 */
  flex: 0 1 auto;
  min-width: 0;
  /* 文案与计时同级：字号由 .rs-status 统一给（cr-775 再降一级到 --fs-sm） */
  font-size: var(--fs-sm);
}
/* 状态点：运行语义的唯一载体（色相 = 相位）+ 本控件唯一的运动焦点。
   光晕已撤（cr-780：色域的渐隐底色已提供足够的视觉承托，再叠光晕显得糊） */
.rs-dot {
  position: relative;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--tone));
  /* 忙指示：豁免 --motion-scale（reduce 下不静止） */
  animation: rs-dot-breath var(--breath) var(--ease-breath) infinite;
}

/* 外扩余波：与主呼吸同周期（心跳—余波） */
.rs-dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: rgb(var(--tone));
  animation: rs-ping var(--breath) cubic-bezier(0, 0, 0.2, 1) infinite;
}
/* 文案跟着点一起吸气—呼气（氛围档：乘 motion-scale） */
.rs-label {
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 400;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  animation: rs-label calc(2.8s * var(--motion-scale)) var(--ease-breath) infinite;
}

/* ── 相位：色相 × 呼吸周期 ── */
.phase-waking { --tone: 148, 163, 184; --breath: 3.6s; }
.phase-calling { --tone: 96, 165, 250; --breath: 2.8s; }
.phase-thinking { --tone: 167, 139, 250; --breath: 2.4s; }
.phase-tooling { --tone: 251, 191, 36; --breath: 1.6s; }
.phase-replying { --tone: 74, 222, 128; --breath: 2.2s; }
.phase-error { --tone: 251, 113, 133; }
/* 亮极：色域浓度减一档（浅底上同浓度显脏），色相另在下方下潜到 600 级 */
:global(html.light) .run-signal { --scrim-a: 0.16; }

/* 亮极一律以 html.light 触发（明暗 class 与色板 id 正交：内置主题与主题包都带；
   data-theme 属性只在非 classic 主题包存在——不可作为明暗判据） */
:global(html.light) .phase-waking { --tone: 100, 116, 139; }
:global(html.light) .phase-calling { --tone: 37, 99, 235; }
:global(html.light) .phase-thinking { --tone: 124, 58, 237; }
:global(html.light) .phase-tooling { --tone: 180, 83, 9; }
:global(html.light) .phase-replying { --tone: 21, 128, 61; }
:global(html.light) .phase-error { --tone: 190, 18, 60; }

/* ── error：停摆档（失败不是活动——一切呼吸关掉，只余静态点） ── */
.run-signal.phase-error .rs-dot { animation: none; box-shadow: 0 0 8px rgba(var(--tone), 0.5); }
.run-signal.phase-error .rs-dot::after { animation: none; opacity: 0; }
.run-signal.phase-error .rs-label { animation: none; color: var(--err); }


/* 主呼吸只做 scale + opacity：光晕撤掉后，单点自带 box-shadow 会读成「脏点」，
   亮度变化交给 opacity，形状变化交给 scale */
@keyframes rs-dot-breath {
  0%, 100% { transform: scale(0.72); opacity: 0.45; }
  50% { transform: scale(1); opacity: 1; }
}
@keyframes rs-ping {
  0% { transform: scale(1); opacity: 0.45; }
  60%, 100% { transform: scale(3); opacity: 0; }
}
@keyframes rs-label {
  0%, 100% { opacity: 0.62; }
  50% { opacity: 1; }
}
</style>
