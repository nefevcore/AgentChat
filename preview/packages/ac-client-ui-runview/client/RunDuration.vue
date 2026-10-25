// AgentChat — 运行时长微组件（秒针渲染作用域收窄）
//
// 性能：now 秒针（ctx.runs.now）每秒打点。此前消费方式是大组件顶层
// computed now → 模板插值，秒针每跳驱动整个宿主组件（矩阵 400+ 格 /
// 面板全树）re-render，而真正的消费面只是几处时长文本。本组件把
// 「now − startedAt」的求值与渲染收进自身微小作用域——秒针每跳只
// patch 这些 span 的文本节点，宿主组件零渲染。
// 时长显示只存在于 running 行/格（run 结束即随条目消失），与 RunsClient
// 的秒针按需启停（running 空时停表）配套：零运行时零打点零渲染。

<script setup lang="ts">
import { computed } from 'vue';
import { useClientContext } from 'ac-client-runtime';
import { formatDurationMs } from '@agentchat/webui-kit';

const props = defineProps<{ startedAt: number }>();

const runSvc = useClientContext()?.runs;
const now = computed(() => runSvc?.now.value ?? 0);
const text = computed(() => formatDurationMs(now.value - props.startedAt));
</script>

<template>{{ text }}</template>
