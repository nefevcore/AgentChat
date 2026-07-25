<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { streamChat } from '../utils/api';
import { addMessage, updateMessage, updateSessionName } from '../utils/storage';
import { uid } from '../types';
import type { Session, ChatMessage, ApiSettings } from '../types';
import MessageItem from './MessageItem.vue';
import ChatInput from './ChatInput.vue';

const props = defineProps<{
  session: Session;
  settings: ApiSettings;
}>();

const emit = defineEmits<{
  updated: [];
}>();

// 本地消息列表（从 session 初始化）
const messages = ref<ChatMessage[]>([...props.session.messages]);
const isStreaming = ref(false);
const titleGenerated = ref(false);
const messagesContainer = ref<HTMLElement>();
let abortController: AbortController | null = null;

// session 切换时重新加载
watch(() => props.session.id, () => {
  messages.value = [...props.session.messages];
  titleGenerated.value = false;
});

// 内容变化时自动滚动
watch(
  () => messages.value.map(m => m.content).join(''),
  async () => {
    await nextTick();
    scrollToBottom();
  }
);

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

/** 通过 ID 从响应式数组中取出消息（修复原始对象不触发响应式的 bug） */
function findMsg(id: string): ChatMessage | undefined {
  return messages.value.find(m => m.id === id);
}

// 发送消息
function handleSend(text: string, deepThink: boolean) {
  if (!text.trim() || isStreaming.value) return;

  // 添加用户消息
  const userMsg: ChatMessage = {
    id: uid(),
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
  messages.value.push(userMsg);
  addMessage(props.session.id, userMsg);

  // 创建助手消息占位
  const assistantId = uid();
  messages.value.push({
    id: assistantId,
    role: 'assistant',
    content: '',
    reasoning: '',
    timestamp: Date.now(),
    isStreaming: true,
  });
  addMessage(props.session.id, messages.value[messages.value.length - 1]);

  // 构建消息历史发送给 API（不包含当前正在流式输出的占位消息）
  const apiMessages = buildApiMessages(assistantId);

  // 开始流式请求
  isStreaming.value = true;
  abortController = new AbortController();

  // 根据 deepThink 设置覆盖 setting
  const effectiveSettings = { ...props.settings, thinking: deepThink };

  streamChat(
    effectiveSettings,
    apiMessages,
    {
      onDelta(content) {
        const m = findMsg(assistantId);
        if (m) {
          m.content += content;
          updateMessage(props.session.id, assistantId, { content: m.content });
        }
      },
      onReasoning(reasoning) {
        const m = findMsg(assistantId);
        if (m) {
          m.reasoning = (m.reasoning || '') + reasoning;
          updateMessage(props.session.id, assistantId, { reasoning: m.reasoning });
        }
      },
      onDone() {
        const m = findMsg(assistantId);
        if (m) {
          m.isStreaming = false;
          updateMessage(props.session.id, assistantId, { isStreaming: false });
        }
        isStreaming.value = false;
        abortController = null;
        emit('updated');

        // 首次对话完成后，用 AI 生成标题
        const userMsgs = messages.value.filter(m => m.role === 'user');
        if (userMsgs.length === 1) {
          generateTitle(userMsgs[0].content);
        }
      },
      onError(err) {
        const m = findMsg(assistantId);
        if (m) {
          if (!m.content) m.content = err;
          m.isStreaming = false;
          updateMessage(props.session.id, assistantId, {
            content: m.content,
            isStreaming: false,
          });
        }
        isStreaming.value = false;
        abortController = null;
        emit('updated');
      },
    },
    abortController.signal,
  );
}

// 停止生成
function handleStop() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// 构建 API 消息数组（排除正在流式输出的消息）
function buildApiMessages(excludeId: string): Array<{ role: string; content: string }> {
  return messages.value
    .filter(m => m.id !== excludeId && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content }));
}

// AI 自动生成会话标题（首次对话完成后调用）
async function generateTitle(userText: string) {
  if (titleGenerated.value) return;
  // 仅当标题为默认格式（"会话 N"）时才自动生成
  if (!/^会话\s*\d+$/.test(props.session.name)) return;
  titleGenerated.value = true;

  try {
    const resp = await fetch(`${props.settings.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${props.settings.apiKey}`,
      },
      body: JSON.stringify({
        model: props.settings.model,
        messages: [
          { role: 'system', content: '你是一个标题生成器。根据用户的第一条消息，生成一个简短的对话标题（3-10个字）。只输出纯标题文本，不要引号、标点、解释或任何额外内容。' },
          { role: 'user', content: userText },
        ],
        max_tokens: 20,
        temperature: 0.3,
      }),
    });
    const data = await resp.json();
    const title = data.choices?.[0]?.message?.content?.trim();
    if (title && title.length >= 2) {
      updateSessionName(props.session.id, title);
      emit('updated');
    }
  } catch {
    // 标题生成失败不影响聊天功能
  }
}
</script>

<template>
  <div class="chat-view">
    <!-- 消息列表 -->
    <div ref="messagesContainer" class="messages-container">
      <div v-if="messages.length === 0" class="empty-chat">
        <div class="empty-icon">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <line x1="9" y1="9" x2="15" y2="9" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="12" y2="17" />
          </svg>
        </div>
        <h2>DeepSeek Chat</h2>
        <p>开始一段新对话吧</p>
      </div>

      <MessageItem
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
      />

      <!-- 生成中指示器 -->
      <div v-if="isStreaming" class="streaming-indicator">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>

    <!-- 底部输入区 -->
    <ChatInput
      :disabled="isStreaming"
      :isStreaming="isStreaming"
      @send="handleSend"
      @stop="handleStop"
    />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  scroll-behavior: smooth;
}

.empty-chat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  gap: 8px;
}

.empty-icon {
  font-size: 56px;
  margin-bottom: 8px;
}

.empty-chat h2 {
  font-size: 24px;
  color: var(--text-primary);
  margin: 0;
}

.empty-chat p {
  font-size: 15px;
  margin: 0;
}

.streaming-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
}

.streaming-indicator .dot {
  width: 6px;
  height: 6px;
  background: var(--text-secondary);
  border-radius: 50%;
  animation: blink 1.4s infinite both;
}

.streaming-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
.streaming-indicator .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
</style>
