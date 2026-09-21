<!-- AssistantMessage.vue -->
<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useMarkdown } from 'ac-client-ui-renderer/client/useMarkdown.ts';
import { useChunkedMarkdown } from '../useChunkedMarkdown.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { Avatar, Icon } from '@agentchat/webui-kit';
import { fmtElapsed } from '../feed.ts';
import type { ChatMessage } from '../types.ts';

const props = withDefaults(defineProps<{
    message: ChatMessage;
    isStreaming?: boolean;
    showCopy?: boolean;
    /** 是否显示操作按钮（重新推理/删除）；群聊等只读场景传 false */
    showActions?: boolean;
    /** 在 ThinkingToolGroup 内使用时不额外加 padding（由外层提供） */
    compact?: boolean;
    /** 去气泡壳模式：链内中间口述等场景——正文退化为纯文本流（无底色/
        边框/阴影/内边距），仅保留 markdown 渲染与流式能力 */
    flat?: boolean;
    /** 分支按钮可见性（single 形态 + 收束行有服务端锚点时宿主传入 true） */
    showFork?: boolean;
    /** 发送者头像 URL */
    senderAvatar?: string | null;
    /** 发送者显示名称 */
    senderName?: string;
}>(), {
    showCopy: true,
    showActions: true,
    compact: false,
    flat: false,
});

const emit = defineEmits<{
    previewFile: [filePath: string];
    /** 重新推理（重试） */
    regenerate: [];
    /** 删除此消息 */
    deleteMessage: [];
    /** 会话分支：以此消息（含）为终点复制出新会话 */
    fork: [];
}>();

const { render, renderPlain } = useMarkdown();

// ── markdown 渲染结果缓存（性能优化核心） ──
// 流式输出每次 token 都会触发重渲染；若直接在 v-html 里调 render()，
// 每条消息每帧都会全量重跑 markdown-it + highlight.js，出字卡顿。
//
// v1（此前）：rAF 合并 + 缓存 HTML —— 每帧只渲染一次，但仍对"全部已累积内容"全量渲染，
//             长消息呈 O(n²)（这就是"逐帧刷新"仍不够流畅的根源）。
// v2（现在）：分块渲染 —— 内容切成"已提交前缀 + 待提交尾部"：
//             已提交部分仅在跨越安全边界（代码围栏外的空行）时增长，HTML 缓存复用；
//             待提交尾部转义后以纯文本追加显示（几乎零成本）。
//             每帧渲染成本 ≈ 增量而非全部内容；与内容无关的更新命中缓存不再重渲染。
const {
  html: contentHtml,
  pendingText: contentPendingText,
  update: updateContentRender,
  flush: flushContentRender,
} = useChunkedMarkdown(render);
const {
  html: reasoningHtml,
  pendingText: reasoningPendingText,
  update: updateReasoningRender,
  flush: flushReasoningRender,
} = useChunkedMarkdown(renderPlain);

const reasoningText = computed(() => props.message.reasoning_content || props.message.thinking || '');

watch(() => props.message.content, (v) => updateContentRender(v ?? '', !!props.isStreaming), { immediate: true });
watch(reasoningText, (v) => updateReasoningRender(v ?? '', !!props.isStreaming), { immediate: true });
// 流式结束 → 立即全量渲染一次，保证最终输出与完整渲染完全一致
watch(() => props.isStreaming, (v) => {
  if (!v) {
    flushContentRender(props.message.content || '');
    flushReasoningRender(props.message.reasoning_content || props.message.thinking || '');
  }
});

const hasThinking = computed(() => {
    const rc = props.message.reasoning_content || props.message.thinking || '';
    return rc.trim().length > 0;
});

// ── 思维链全局可见性（会话头部 switch）：关闭时思考区整体不渲染 ──
const ui = useUiStore();
const thinkingVisible = computed(() => ui.showThinking);

const hasOnlyThinking = computed(() => {
    return hasThinking.value && (!props.message.content || props.message.content.trim() === '');
});

const hasContent = computed(() => {
    return !!(props.message.content && props.message.content.trim().length > 0);
});

// ── 思考消息折叠态与 label ──
// 折叠不受流式过程控制（整链显隐由全局思维链开关承担）：默认折叠（与
// 链内工具卡一致——链栏流式默认展开时，折叠态 label 以预览文本实时反映
// 思考进展），仅用户点击切换。
const showThinking = ref(false);

// 行首图标位：hover 换折叠方向箭头，平时保持思考涟漪图标（与
// ToolMessage 工具卡、TurnDisplayItem 链栏同款交互）。
const rowHover = ref(false);
const rowIcon = computed(() => {
    if (rowHover.value) return showThinking.value ? 'chevron-up' : 'chevron-down';
    return 'thought';
});

function isThinkingExpanded(): boolean {
    return showThinking.value;
}

function toggleThinking() {
    showThinking.value = !showThinking.value;
}

// ── 思考卡限高滚动 + 流式平滑跟随 ──
// 展开态思考正文超长时收进固定高度视口内滚动；流式跟随为 useChatShell
// 同款算法的卡片级微缩：token 突发/代码块提交造成的高度跳变经 rAF 指数
// 缓动追赶柔化（一顿一顿 → 连续流动），距底极近时直接吸收增量（视口
// 视觉静止）；程序写入与用户滚动按「记账对账」区分——用户上滚帧粒度
// 即察觉并停机让位，滚回底部附近自动恢复跟随。
const thinkBodyEl = ref<HTMLElement | null>(null);

/** 用户停在底部附近（scroll 事件回读；跟随拉起的意图门槛） */
const thinkAtBottom = ref(true);

/** 指数缓动时间常数（ms）——与 useChatShell GLIDE_TAU 一致 */
const THINK_GLIDE_TAU = 80;
/** 距底容差（px）：scroll 事件判定「仍在底部附近」的阈值 */
const THINK_BOTTOM_EPS = 16;
/** 用户上滚察觉容差（px）：忽略亚像素/触控板噪声 */
const THINK_USER_EPS = 2;
let thinkFollowRaf = 0;
let thinkGlideY = 0;
let thinkGlideT = 0;
/** 最近一次程序写入的 scrollTop（scroll 回声对账基线） */
let thinkExpectedTop = NaN;
/** 系统减弱动效偏好：跳过缓动，仅贴底吸收（rAF 写入不受 CSS 豁免管辖） */
const thinkReduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function syncThinkScrollState() {
    const el = thinkBodyEl.value;
    if (!el) return;
    thinkAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < THINK_BOTTOM_EPS;
}

/** 跟随心跳：向实时底部指数逼近（目标随流式增长每帧重读 scrollHeight）；
 *  用户上滚（当前值低于记账值超容差且未贴最大值）→ 帧粒度停机让位，
 *  用户向下助力 → 从用户当前位置续接缓动 */
function thinkFollowTick() {
    const el = thinkBodyEl.value;
    if (!el) { thinkFollowRaf = 0; return; }
    const cur = el.scrollTop;
    if (cur < thinkExpectedTop - THINK_USER_EPS && cur < el.scrollHeight - el.clientHeight - THINK_USER_EPS) {
        thinkFollowRaf = 0;
        return;
    }
    if (cur > thinkGlideY + 0.5) thinkGlideY = cur;
    const now = performance.now();
    const target = el.scrollHeight - el.clientHeight;
    const dt = Math.max(1, now - thinkGlideT);
    let y = thinkGlideY + (target - thinkGlideY) * (1 - Math.exp(-dt / THINK_GLIDE_TAU));
    if (y > target) y = target;
    el.scrollTop = y;
    thinkExpectedTop = el.scrollTop;
    thinkGlideY = el.scrollTop;
    thinkGlideT = now;
    if (target - thinkGlideY <= 0.5) { thinkFollowRaf = 0; return; }
    thinkFollowRaf = requestAnimationFrame(thinkFollowTick);
}

/** 流式增量到达：用户在底部附近 → 距底极小直接吸收（视觉静止），否则
 *  平滑缓动追赶；用户在阅读上文 → 不打扰 */
watch(reasoningText, () => {
    requestAnimationFrame(() => {
        const el = thinkBodyEl.value;
        if (!el || !isThinkingLive.value || !thinkAtBottom.value) return;
        if (thinkFollowRaf) return; // 引擎在跑：目标每帧重读，自动追新增量
        const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
        if (thinkReduceMotion || dist <= 1) {
            el.scrollTop = el.scrollHeight; // 贴底吸收
            thinkExpectedTop = el.scrollTop;
        } else {
            thinkGlideY = el.scrollTop;
            thinkGlideT = performance.now();
            thinkFollowRaf = requestAnimationFrame(thinkFollowTick);
        }
    });
});

// 展开初始化（nextTick 等 v-show 完成 display 切换，display:none 下
// scrollHeight 恒为 0 读不到真实值）：历史思考停在顶部；流式思考中
// 展开 → 吸底直接看最新输出。收起时停机跟随引擎。
watch(showThinking, (expanded) => {
    if (!expanded) {
        if (thinkFollowRaf) { cancelAnimationFrame(thinkFollowRaf); thinkFollowRaf = 0; }
        return;
    }
    nextTick(() => {
        const el = thinkBodyEl.value;
        if (!el) return;
        if (isThinkingLive.value) {
            el.scrollTop = el.scrollHeight;
            thinkExpectedTop = el.scrollTop;
        }
        syncThinkScrollState();
    });
});

// 思考相位 = 流式中且思考文本在场（由 TurnDisplayItem 步级判定：正文或
// 工具调用任一到场即思考收束，经 isStreaming 传入）。label 形态（段间
// 统一以「·」连接——与工具卡「执行命令 · npm test」同款构造）：
//   展开态：思考中 / 已思考 · XmYs
//   折叠态：思考中 · <思考内容随流式输出不断更新>
//           已思考 · XmYs · <思考内容前置部分文本>
// 耗时（XmYs）由 feed 在思考收束时定格写入 message.label（随消息驻留，
// 跨步重建/组件重挂载不丢失）；无计时信息（历史/中断）→ 仅「已思考」。
const isThinkingLive = computed(() => props.isStreaming && hasThinking.value);

// ── 思考中实时耗时（2026-12 计时反馈）：「思考中 · 12s」每秒跳动 ──
// 起点复用直播相位源（feed 的 StreamState.reasoningStartAt 派生入口）——
// 组件无直接访问；此处用消息落位时刻近似（onThinkingStart 建占位/首片
// 到达即挂 thinking），误差 ≤1 个 tick 且收束时被后端 reasoningMs 覆盖。
const thinkNow = ref(Date.now());
let thinkTimer: ReturnType<typeof setInterval> | null = null;
watch(isThinkingLive, (live) => {
  if (live && !thinkTimer) {
    thinkTimer = setInterval(() => { thinkNow.value = Date.now(); }, 1000);
  } else if (!live && thinkTimer) {
    clearInterval(thinkTimer);
    thinkTimer = null;
  }
}, { immediate: true });
/** 思考中已耗时（秒；不足 1s 显示空——与「已思考」1s 门槛一致） */
const thinkingElapsedSec = computed(() => {
  if (!isThinkingLive.value) return 0;
  // 起点同源（feed 首个 reasoning 片到达时驻留；与收束 label/后端
  // reasoningMs 同源定义）——缺省回落消息落位时刻（历史/重放兜底）
  const t0 = props.message.reasoningStartAt ?? props.message.timestamp;
  const sec = Math.floor((thinkNow.value - t0) / 1000);
  return sec >= 1 ? sec : 0;
});

/** 折叠态预览文本：单行化后截断——思考中看最新尾部（随流式输出不断
 *  更新），已思考看前置部分文本 */
const THINKING_PREVIEW_CHARS = 80;
const thinkingPreview = computed(() => {
    if (showThinking.value) return '';
    const flat = reasoningText.value.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    if (isThinkingLive.value) {
        return flat.length > THINKING_PREVIEW_CHARS ? `…${flat.slice(-THINKING_PREVIEW_CHARS)}` : flat;
    }
    return flat.length > THINKING_PREVIEW_CHARS ? `${flat.slice(0, THINKING_PREVIEW_CHARS)}…` : flat;
});

const thinkingLabel = computed(() => {
    if (isThinkingLive.value) {
        // 思考中带实时秒数（每秒跳动；无预览文本时也单独可见）：
        // 「思考中 · 12s」/「思考中 · 12s · …最新预览」
        const sec = thinkingElapsedSec.value;
        const head = sec > 0 ? `思考中 · ${fmtElapsed(sec)}` : '思考中';
        return thinkingPreview.value ? `${head} · ${thinkingPreview.value}` : head;
    }
    const head = props.message.label?.trim() || '已思考';
    return thinkingPreview.value ? `${head} · ${thinkingPreview.value}` : head;
});

// 代码块复制按钮事件委托
const messageRoot = ref<HTMLElement | null>(null);

function handleCodeBlockClick(e: Event) {
    const target = e.target as HTMLElement;

    // 文件路径链接点击（正则匹配的路径 + <file> 标签）
    const fileLink = target.closest('.file-path-link') as HTMLElement | null
        || target.closest('.file-tag') as HTMLElement | null;
    if (fileLink) {
        const path = fileLink.dataset.filePath;
        if (path) {
            e.preventDefault();
            e.stopPropagation();
            emit('previewFile', path);
            return;
        }
    }

    // "复制" 按钮
    const copyBtn = target.closest('.md-code-block-btn[data-action="copy"]') as HTMLElement | null;
    if (!copyBtn) return;

    const block = copyBtn.closest('.md-code-block');
    const codeEl = block?.querySelector('pre code');
    if (!codeEl) return;

    const text = codeEl.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('copied');
        const textSpan = copyBtn.querySelector('.md-code-block-btn-text');
        if (textSpan) textSpan.textContent = '已复制';
        setTimeout(() => {
            copyBtn.classList.remove('copied');
            if (textSpan) textSpan.textContent = '复制';
        }, 2000);
    }).catch(() => {
        const textSpan = copyBtn.querySelector('.md-code-block-btn-text');
        if (textSpan) textSpan.textContent = '失败';
        setTimeout(() => {
            if (textSpan) textSpan.textContent = '复制';
        }, 1500);
    });
}

watch(messageRoot, (el, oldEl) => {
    // 根节点随 v-if 显隐（空消息不渲染）：元素可能在挂载之后才出现/消失
    // （如 final 气泡先空后出正文），不能只在 onMounted 一次性绑定
    if (oldEl) oldEl.removeEventListener('click', handleCodeBlockClick);
    if (el) el.addEventListener('click', handleCodeBlockClick);
});

// 是否渲染根节点。多步轮次中"仅工具调用、无思考无正文"的 step（以及仅以
// 工具调用收尾的空 final）会得到一个全空壳消息：此前仍渲染占位骨架，
// 在思维链 flex gap 中产生多余空隙（微妙错位）→ 整个节点不渲染。
// （流式活动指示统一由链栏 header 的 dots 承担，本组件不再渲染
//  typing dots/typing indicator）
const shouldRender = computed(() => (hasThinking.value && thinkingVisible.value) || hasContent.value);

// 判断是否为错误消息
const isError = computed(() => props.message.isError === true);

// 复制消息全文
const copyState = ref<'idle' | 'copied' | 'error'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function copyMessageContent() {
    const text = props.message.content || '';
    navigator.clipboard.writeText(text).then(() => {
        copyState.value = 'copied';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    }).catch(() => {
        copyState.value = 'error';
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
    });
}

onBeforeUnmount(() => {
    if (copyTimer) clearTimeout(copyTimer);
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    if (thinkFollowRaf) { cancelAnimationFrame(thinkFollowRaf); thinkFollowRaf = 0; }
});
</script>

<template>
    <div v-if="shouldRender" ref="messageRoot" class="message-item message-assistant">
        <div class="assistant-row">
            <!-- 左侧头像：显式传了头像才渲染（链内思考卡/口述/final 不传 →
                 无头像位，与旧版一致——恒渲染会让每条链内消息都冒出 bot 兜底
                 图标）。无 URL = 纯 icon 占位，不打 404 探测请求；图片真挂时
                 Avatar 内部仍回退 bot 图标 -->
            <div v-if="senderAvatar || senderName" class="msg-avatar">
                <Avatar :src="senderAvatar" :name="senderName" :size="32" fallback-icon="bot" plain-fallback />
            </div>

            <!-- 右侧列：名称 → 思维链 → 最终回复 -->
            <div class="assistant-col">
                <!-- ① 名称 -->
                <div v-if="senderName" class="sender-name">{{ senderName }}</div>

                <!-- ② 思考过程（受全局思维链开关控制）：图标位 hover 切换折叠箭头 -->
                <div v-if="hasThinking && thinkingVisible" class="think-content-section" :class="{ 'in-group': compact, 'no-content-below': hasOnlyThinking && !isStreaming }">
                    <div
                        class="think-content-label"
                        :class="{ 'is-expanded': isThinkingExpanded() }"
                        @click="toggleThinking()"
                        @mouseenter="rowHover = true"
                        @mouseleave="rowHover = false"
                    >
                        <!-- 图标位：思考中且非 hover → 琥珀旋转环（2026-12 全前端
                             统一选型：工具卡/思考卡/链栏同色同款"忙"指示）；
                             hover 显示折叠箭头（交互优先） -->
                        <span v-if="isThinkingLive && !rowHover" class="think-spin-ring" aria-hidden="true"></span>
                        <Icon v-else :name="rowIcon" :size="14" class="think-icon" />
                        <span class="think-label-text" :title="thinkingLabel">{{ thinkingLabel }}</span>
                    </div>
                    <div v-show="isThinkingExpanded()" ref="thinkBodyEl" class="think-content-body markdown-body" @scroll="syncThinkScrollState">
                        <div class="think-content-rendered" v-html="reasoningHtml" />
                        <span v-if="reasoningPendingText" class="streaming-pending">{{ reasoningPendingText }}</span>
                    </div>
                </div>

                <!-- ③ AI 回复正文（md-bleed：启用代码块全出血等气泡调和样式；
                     flat：去气泡壳——链内中间口述为纯文本流，全出血/裁剪一并关闭） -->
                <div v-if="hasContent" class="assistant-bubble" :class="flat ? 'is-flat' : 'md-bleed'">
                    <div v-if="isError" class="markdown-body error-message" v-html="contentHtml" />
                    <div v-else class="markdown-body" v-html="contentHtml" />
                    <span v-if="contentPendingText" class="streaming-pending">{{ contentPendingText }}</span>
                </div>

                <div v-if="showCopy !== false && hasContent" class="copy-btn-row">
                    <button
                        class="copy-message-btn"
                        :class="{ copied: copyState === 'copied', error: copyState === 'error' }"
                        @click="copyMessageContent"
                        :title="copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制全文'"
                    >
                        <svg v-if="copyState === 'idle'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        <svg v-else-if="copyState === 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                    <!-- 操作序：非破坏（复制/分支）→ 改写（重新推理）→ 破坏（删除）收尾 -->
                    <button
                        v-if="showFork"
                        class="msg-action-btn"
                        :disabled="isStreaming"
                        @click="emit('fork')"
                        title="从此处新建分支会话"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="6" cy="6" r="3"/>
                            <circle cx="6" cy="18" r="3"/>
                            <circle cx="18" cy="6" r="3"/>
                            <path d="M18 9a9 9 0 0 1-9 9"/>
                            <path d="M6 9v6"/>
                        </svg>
                    </button>
                    <button
                        v-if="showActions"
                        class="msg-action-btn"
                        :disabled="isStreaming"
                        @click="emit('regenerate')"
                        title="重新推理"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                    </button>
                    <button
                        v-if="showActions"
                        class="msg-action-btn danger"
                        :disabled="isStreaming"
                        @click="emit('deleteMessage')"
                        title="删除消息"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6"/>
                            <path d="M14 11v6"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.message-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    /* chain-body 的 flex item：允许收缩（长内容不撑破容器宽） */
    min-width: 0;
}

.message-assistant {
    align-items: flex-start;
}

/* 左右区域：左侧头像 + 右侧列（名称 → 思维链 → 最终回复） */
.assistant-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    /* width 由 TurnDisplayItem 的 .turn-item max-width:70% 统一管控 */
}

.assistant-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}


.msg-avatar {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    align-self: flex-start;
    display: flex;
    align-items: center;
    justify-content: center;
}
/* 头像与纯 icon 占位（plainFallback）共用圆坑裁切：图片模式由 Avatar
 * 内部 border-radius 承担，这里不裁 icon 模式的透明占位 */
.msg-avatar:has(.ui-avatar--circle) {
    border-radius: 50%;
    overflow: hidden;
}
.msg-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    position: relative;
    z-index: 1;
}
.avatar-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 600;
    color: var(--color-primary, #4f46e5);
}

.sender-name {
    font-size: 12px;
    color: var(--color-text-secondary, rgba(255,255,255,0.55));
    padding: 0 2px;
    line-height: 1;
}

.assistant-bubble {
    padding: 12px 16px;
    background: var(--color-bg-assistant, rgba(79, 70, 229, 0.04));
    /* 描边与气泡底色一致，视觉上无描边感 */
    border: 1px solid var(--color-bg-assistant, rgba(79, 70, 229, 0.04));
    border-radius: var(--radius-lg, 14px);
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
}

/* flat：去气泡壳（链内中间口述）——无底色/描边/阴影/内边距/圆角/裁剪，
   纯文本流；不带 md-bleed（无内边距可出血），代码块为方正轻块 */
.assistant-bubble.is-flat {
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    box-shadow: none;
    overflow: visible;
}
.assistant-bubble.is-flat .md-code-block {
    margin: 8px 0;
    border-radius: 0;
}
.assistant-bubble.is-flat .md-code-block pre {
    padding: 8px 12px;
    border-radius: 0;
}
.assistant-bubble.is-flat .md-code-block-banner {
    height: 24px;
}
.assistant-bubble.is-flat .streaming-pending {
    display: inline;
}

/* 流式待提交尾部：转义纯文本，等下一个安全边界并入已提交区 */
.streaming-pending {
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.85;
}
.think-content-rendered {
    min-width: 0;
}

.error-message {
    color: var(--color-error);
    background: var(--color-danger-light);
    padding: 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-error);
}

/* ===== 思考过程 ===== */
/* 群聊（in-group）思考区必须约束宽度，否则被内部代码块（hljs-string 超长）撑破
   父级 turn-item 的 70% 限制，溢出屏幕（如 impc-dev 群聊 1148px > 容器 589px） */
.think-content-section {
    min-width: 0;
    max-width: 100%;
}
.think-content-section:not(.in-group) {
    /* width 由 TurnDisplayItem 统一管控；头像已移至顶部 header，此处与气泡左对齐 */
    padding: 0;
    margin-bottom: 8px;
}

.think-content-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    user-select: none;
    cursor: pointer;
    padding: 2px 0;
    transition: color 0.15s;
}

.think-content-label:hover {
    color: var(--color-text-primary);
}

/* 仅展开态：label 吸附会话可视区顶（chain-header 同款）——渐隐底色常驻，
   卷入 label 下缘的思考内容经此渐变带柔化淡出（macOS 式纯色渐变遮罩，
   无需 JS 判定吸附态）。底部 8px 遮蔽余量带（padding 撑高 + 负 margin
   抵消，不占布局）盖过正文首行——刚卷入的内容先经渐隐带淡出，而非在
   label 下缘被硬切；未吸附（常态）时余量带覆于正文上方，仅渐变尾端
   （alpha ≤25% 的 page 色）薄扫 ~2px，视觉不可辨。 */
.think-content-label.is-expanded {
    position: sticky;
    /* 吸附位叠加偏移变量：链内思考卡由 chain-body 提供 chain-header 吸顶
       实底遮挡高（label 行盒 19.2 + 上下 padding 2×2 + 渐隐带 8 ≈ 30px），
       使两者吸顶时错层不互覆；独立思考卡无链栏 → 变量缺省 0，吸附位不变 */
    top: calc(var(--space-md) * -1 + var(--think-label-stack, 0px));
    z-index: 5;
    padding-bottom: 8px;
    margin-bottom: -8px;
    background: linear-gradient(to bottom, var(--color-bg-page) calc(100% - 8px), transparent);
}

/* label 单行截断：折叠态携带思考预览文本时，超宽部分尾部省略 */
.think-label-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.think-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-text-secondary);
    /* 图标位切换（涟漪 ⇄ 折叠箭头）：无位移淡入淡出 */
    transition: opacity 0.12s ease;
}

/* 思考中旋转环（2026-12 全前端统一选型）：琥珀——与工具卡
 * （tool-spin-ring）/链栏（chain-spin-ring）同色同款"忙"指示。 */
.think-spin-ring {
    width: 13px;
    height: 13px;
    margin: 0.5px; /* 14px 图标位内居中（(14-13)/2） */
    border-radius: 50%;
    border: 2px solid var(--color-warning-light, rgba(245,158,11,0.15));
    border-top-color: var(--color-warning, #f59e0b);
    animation: thinkSpin 0.8s linear infinite;
    flex-shrink: 0;
}
@keyframes thinkSpin { to { transform: rotate(360deg); } }

.think-content-body {
    font-size: 12px;
    line-height: 1.7;
    color: var(--color-text-secondary);
    display: flex;
    flex-direction: column;
    min-height: calc(12px * 1.7 + 12px);
    /* 限高滚动：超长思考收进固定视口（--card-viewport-max 统一令牌——
       与各工具卡同高，流式随输出自动吸底见 script），不再把消息流撑出
       数屏。原 justify-content: center 在滚动容器中会把溢出内容两端
       裁掉（无法滚到顶部），故移除 */
    max-height: var(--card-viewport-max);
    overflow-y: auto;
    overscroll-behavior: contain;
    /* 槽位常驻：滚动条出现/消失时内容宽度不跳变 */
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--color-border-secondary) transparent;
    margin-left: 7px;
    border-left: 1px solid var(--color-border-secondary);
    /* 右侧避让滚动条 */
    padding: 0 8px 0 14px;
    /* 防止思考区代码块（含 hljs-string 超长）撑破 */
    min-width: 0;
    max-width: 100%;
}
.think-content-body::-webkit-scrollbar { width: 5px; }
.think-content-body::-webkit-scrollbar-track { background: transparent; }
.think-content-body::-webkit-scrollbar-thumb { background: var(--color-border-secondary); border-radius: 3px; }
.think-content-body::-webkit-scrollbar-thumb:hover { background: var(--color-border-primary); }

.think-content-body :deep(p) {
    /* 对齐全局行距节奏（--md-gap-line）：换行/分段等距 */
    margin: var(--md-gap-line, 7px) 0;
}

.think-content-body :deep(p:first-child) {
    margin-top: 0;
}

.think-content-body :deep(p:last-child) {
    margin-bottom: 0;
}

.think-content-body :deep(code) {
    font-size: 11px;
}

/* 思考卡内代码块：字号与行内 code 同档（11px，经 --md-code-fs 联动），
   间距/内边距/横幅同步收紧——与链内口述正文（is-flat）同款紧凑节奏，
   消除"12px 正文旁嵌 13px 大代码块"的割裂感 */
.think-content-body {
    --md-code-fs: 11px;
}
.think-content-body :deep(.md-code-block) {
    margin: 8px 0;
}
.think-content-body :deep(.md-code-block pre) {
    padding: 8px 12px;
}
.think-content-body :deep(.md-code-block-banner) {
    height: 24px;
}

.think-content-body :deep(h1),
.think-content-body :deep(h2),
.think-content-body :deep(h3) {
    font-size: 12px;
    font-weight: 600;
    margin: 8px 0 4px;
    color: var(--color-text-secondary);
}

.think-content-body :deep(ul),
.think-content-body :deep(ol) {
    /* 缩进对齐正文基准（markdown.css：ul/ol padding-left 4px + li 24px）——
       此前 18px 使每级列表比正文多缩进 14px，嵌套列表累积错位 */
    padding-left: 4px;
    margin: 4px 0;
}

.think-content-section.no-content-below {
    margin-bottom: 0;
}

/* ===== 复制按钮 ===== */
.copy-btn-row {
    display: flex;
    justify-content: flex-start;
    margin-top: 4px;
    padding-left: 2px;
    gap: 2px;
}

.copy-message-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    color: var(--color-text-tertiary, #a8abb2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s ease;
    line-height: 0;
}

.copy-message-btn:hover {
    color: var(--color-text-secondary);
}

.copy-message-btn.copied {
    color: #22c55e;
}

.copy-message-btn.error {
    color: var(--color-error);
}

.msg-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    color: var(--color-text-tertiary, #a8abb2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s ease;
    line-height: 0;
}

.msg-action-btn:hover:not(:disabled) {
    color: var(--color-text-secondary);
}

.msg-action-btn.danger:hover:not(:disabled) {
    color: var(--color-error, #e74c3c);
}

.msg-action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* ===== 文件路径链接 ===== */
:deep(.file-path-link) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-primary-light, rgba(79,70,229,0.1));
    color: var(--color-primary, #7c7cf8);
    cursor: pointer;
    font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.9em;
    text-decoration: none;
    border: 1px solid transparent;
    transition: all 0.15s ease;
    word-break: break-all;
}
:deep(.file-path-link):hover {
    background: var(--color-primary-light, rgba(79,70,229,0.18));
    border-color: var(--color-primary, rgba(124,124,248,0.3));
    color: var(--color-primary-hover, #918cf8);
    text-decoration: underline;
}

/* ===== <file> 标签（带文件图标） ===== */
:deep(.file-tag) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: var(--radius-sm);
    background: var(--color-primary-light, rgba(79,70,229,0.1));
    color: var(--color-primary, #7c7cf8);
    cursor: pointer;
    font-size: 0.9em;
    text-decoration: none;
    border: 1px solid transparent;
    transition: all 0.15s ease;
}
:deep(.file-tag):hover {
    background: var(--color-primary-light, rgba(79,70,229,0.18));
    border-color: var(--color-primary, rgba(124,124,248,0.3));
    color: var(--color-primary-hover, #918cf8);
    text-decoration: underline;
}

</style>
