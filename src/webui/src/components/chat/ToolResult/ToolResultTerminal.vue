<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import ScrollableViewport from '@/components/chat/ScrollableViewport.vue';
import { Icon } from '@/ui';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// 终端输入（bash 工具返回 command）+ 执行环境
const command = computed(() => String(props.data.command || ''));
const cwd = computed(() => String(props.data.cwd || ''));
const exitCode = computed(() => {
  const c = props.data.exit_code;
  return c === undefined || c === null ? null : Number(c);
});
const stdout = computed(() => String(props.data.stdout || props.data.output || ''));
const stderr = computed(() => String(props.data.stderr || ''));
// 执行失败时的错误信息 + 引导
const errorMessage = computed(() => String(props.data.message || ''));
const guidance = computed(() => String(props.data.guidance || ''));
const truncated = computed(() => Boolean(props.data.truncated));
const timedOut = computed(() => Boolean(props.data.timed_out));
const hasCommand = computed(() => !!command.value);
const hasOutput = computed(() => !!(stdout.value || stderr.value));
const isError = computed(() => exitCode.value !== null && exitCode.value !== 0);

/** OUT 区是否渲染（有输出 / 执行中 / 有提示；无 command 时也兜底渲染避免整卡空白） */
const showOut = computed(() =>
  hasOutput.value || !!errorMessage.value || !!guidance.value || !!props.loading || !hasCommand.value,
);
/** IN/OUT 之间的 --- 分隔线（两侧都有内容时才有意义） */
const showDivider = computed(() => hasCommand.value && showOut.value);

// ---- 流式输出自动贴底：执行中（loading）新输出到达时滚到底部；
// 用户向上滚动查看历史时不抢滚动位置（松手回到接近底部后恢复贴底）。
const viewportRef = ref<{ $el?: HTMLElement }>();
const stickToBottom = ref(true);
function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}
watch([stdout, stderr, () => props.loading], async () => {
  if (!props.loading || !stickToBottom.value) return;
  await nextTick();
  const el = viewportRef.value?.$el;
  if (el) el.scrollTop = el.scrollHeight;
});
</script>

<template>
  <div class="tool-result-terminal">
    <!-- 单卡片终端：IN / --- / OUT 以文本标记区分输入与输出 -->
    <div class="term-card">
      <ScrollableViewport ref="viewportRef" max-height="50vh" class="term-scroll" @scroll="onScroll">
        <!-- IN：输入命令 -->
        <div v-if="hasCommand" class="term-row term-in">
          <span class="term-mark term-mark-in">IN:</span>
          <code class="term-cmd">{{ command }}</code>
          <span v-if="cwd" class="term-cwd" :title="cwd">{{ cwd }}</span>
        </div>

        <!-- ---：IN/OUT 分隔线，非零退出码以徽标居中呈现 -->
        <div v-if="showDivider" class="term-divider">
          <span class="term-rule"></span>
          <span v-if="isError" class="term-exit">exit {{ exitCode }}</span>
          <span class="term-rule"></span>
        </div>

        <!-- OUT：输出结果 -->
        <div v-if="showOut" class="term-row term-out">
          <span class="term-mark term-mark-out">OUT:</span>
          <div class="term-out-body">
            <pre v-if="stdout"><code>{{ stdout }}</code></pre>
            <pre v-if="stderr" class="term-stderr"><code>{{ stderr }}</code></pre>

            <!-- 执行中：输出尚未返回 -->
            <div v-if="loading && !hasOutput" class="term-loading">
              <span class="loading-dot dot-yellow"></span>
              <span class="loading-dot dot-gray"></span>
              <span class="loading-dot dot-gray"></span>
              <span class="term-loading-text">正在执行...</span>
            </div>

            <!-- 执行失败信息：无输出时红色展示；有输出时作为黄色引导展示，避免吞掉修复提示 -->
            <div v-if="errorMessage && !hasOutput" class="term-error">{{ errorMessage }}</div>
            <div v-if="errorMessage && hasOutput" class="term-guidance">{{ errorMessage }}</div>
            <div v-if="guidance" class="term-guidance">{{ guidance }}</div>

            <div v-if="truncated || timedOut" class="term-truncated">
              <Icon name="alert-circle" :size="12" /> {{ truncated ? '输出已截断' : '' }}{{ truncated && timedOut ? '；' : '' }}{{ timedOut ? '命令超时' : '' }}
            </div>

            <div v-if="!hasCommand && !hasOutput && !errorMessage && !guidance && !loading" class="term-empty">(无输出)</div>
          </div>
        </div>
      </ScrollableViewport>
    </div>
  </div>
</template>

<style scoped>
.tool-result-terminal {
  padding: 4px 0;
}

/* ---- 单卡片终端 ---- */
.term-card {
  background: #0f1117;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 10px;
  padding: 10px 14px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
}

.term-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

/* IN: / OUT: 文本标记 */
.term-mark {
  font-weight: 700;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: 0.3px;
}
.term-mark-in { color: #4ade80; }
.term-mark-out { color: #38bdf8; }

/* ---- IN 行 ---- */
.term-cmd {
  flex: 1 1 auto;
  min-width: 0;
  color: #e2e8f0;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-all;
}

.term-cwd {
  margin-left: auto;
  flex-shrink: 1;
  max-width: 40%;
  color: #64748b;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

/* ---- --- 分隔线 ---- */
.term-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.term-rule {
  flex: 1;
  border-top: 1px dashed rgba(148, 163, 184, 0.3);
}

.term-exit {
  color: #f87171;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  user-select: none;
}

/* ---- OUT 行 ---- */
.term-out-body {
  flex: 1 1 auto;
  min-width: 0;
}

.term-out-body pre {
  margin: 0;
  color: #cbd5e1;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.term-out-body pre code {
  font-family: inherit;
  color: inherit;
}

.term-stderr {
  color: #f87171 !important;
}

/* ---- 错误 / 引导 / 提示 ---- */
.term-error {
  color: #f87171;
  white-space: pre-wrap;
  word-break: break-word;
}

.term-guidance {
  color: #fbbf24;
  white-space: pre-wrap;
  word-break: break-word;
}

.term-truncated {
  color: #fbbf24;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.term-empty {
  color: #64748b;
  user-select: none;
}

/* ---- 执行中 loading ---- */
.term-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #94a3b8;
  user-select: none;
}
.term-loading .loading-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  animation: term-dot-pulse 1.4s infinite ease-in-out;
}
.term-loading .loading-dot.dot-yellow { background: #e6a817; }
.term-loading .loading-dot.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.term-loading .loading-dot.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes term-dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.term-loading-text { margin-left: 2px; }
</style>
