<!-- ContextInjectCard.vue -->
<script setup lang="ts">
// ============================================================
// 注入卡：context 注入行（source:skill 等）的卡片渲染——label 收起行
// + 展开体（注入体 markdown 渲染，限高滚动）。
// cr-765 批次A：骨架换 CardFrame（CollapseRow 升级形态——语义图标 /
// tone / controls 契约扩展）。
// cr-765 #2：kind → 语义图标（skill/book-open 等——与工具卡图标位
// 语言对齐）。#3：注入体走 MarkdownCard（思考卡同款渲染管线），
// 默认渲染态；「原文」出口按会话持久化（注入体是给模型看的原文，
// 评审/排障需要逐字节可复制的纯文本——Q2 定案）。
// 挂位：TurnDisplayItem chain-body 头/尾（随链栏折叠）或 TranscriptList
// 独立降级位——本组件无位置假设，数据即 InjectCard。
// ============================================================
import { ref } from 'vue';
import { CardFrame } from '@agentchat/webui-kit';
import MarkdownCard from 'ac-client-ui-renderer/client/MarkdownCard.vue';
import type { InjectCard } from '../types.ts';

/** kind（= 存储 source 决策词）→ 语义图标（cr-765 #2）：注入卡与工具卡/
 *  思考卡的「图标位」语言对齐——未识别 kind 落 puzzle 不空白。图标名一律
 *  取 icons.ts 注册名（§1.7）。 */
const INJECT_ICONS: Record<string, string> = {
  skill: 'book-open',            // 技能正文
  memory: 'scroll-text',         // 记忆材料（增量）
  'memory-timeline': 'history',  // 记忆时间线
  'ask-question': 'help-circle', // 询问用户（发起）
  'durable-interaction': 'messages-square', // 用户答复/交互回执
  event: 'info',                 // 机制通知
  error: 'alert-circle',         // 错误语义
};
const injectIcon = (kind?: string) => (kind && INJECT_ICONS[kind]) || 'puzzle';

const props = defineProps<{
  card: InjectCard;
  /** 独立降级位（会话无 agent 轮可挂）：label 右侧标「独立上下文」meta（cr-765 #6） */
  degraded?: boolean;
}>();

// 默认折叠（与工具卡一致：仅用户点击展开）；直播行（content 缺席）
// 不可展开——settlement 重拉权威行后展开体自然在场。
// CardFrame 是受控形态（open prop + toggle 事件）：canExpand 为假时
// toggle 不写回，展开态恒不成立（与迁移前「点击无反应」等价）。
const isExpanded = ref(false);
const canExpand = () => !!props.card.content;
const toggle = () => { if (canExpand()) isExpanded.value = !isExpanded.value; };

// 直播载入态（cr-765 #5）：content 缺席窗口（落账 → settlement 重拉完成）
// 显示「载入中 · N KB」+ 旋转环（running 语义）——不再是「点击无反应」。
const isLoading = () => !props.card.content && !!props.card.bytes;
const fmtKB = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// 原文态会话持久化（showThinking 键式同款）：一次选择对全部注入卡生效
const RAW_KEY = 'agentchat.injectRaw';
const showRaw = ref((() => { try { return localStorage.getItem(RAW_KEY) === '1'; } catch { return false; } })());
function onToggleRaw(raw: boolean) {
  showRaw.value = raw;
  try { localStorage.setItem(RAW_KEY, raw ? '1' : '0'); } catch { /* ignore */ }
}
</script>

<template>
  <CardFrame
    class="inject-card"
    :title="card.label"
    :icon="injectIcon(card.kind)"
    :meta="degraded ? '独立上下文' : isLoading() ? `载入中 · ${fmtKB(card.bytes ?? 0)}` : ''"
    :open="isExpanded"
    :running="isLoading()"
    :can-expand="canExpand()"
    @toggle="toggle"
  >
    <MarkdownCard v-if="card.content" :text="card.content" raw-toggle :initial-raw="showRaw" @toggle-raw="onToggleRaw" />
  </CardFrame>
</template>

<style scoped>
/* 卡片根：占位与链体内其余卡同宽（无独立背景——链内嵌卡不浮面）；
   标签行/左竖线/限高视口由 CardFrame 提供 */
.inject-card {
  min-width: 0;
  width: 100%;
}
</style>