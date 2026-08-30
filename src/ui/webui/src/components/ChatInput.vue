<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useSinglesStore } from '../stores/singles';
import { useWorkspacesStore } from '../stores/workspaces';
import { useFeedStore } from '../stores/feed';
import { fetchPools } from '../core/api/endpoints/agents';
import type { FileAttachment } from '../types';
import type { SingleSession } from '../core/api/endpoints/singles';
import { singleDialog } from '../utils/feed';
import InteractionBar from './InteractionBar.vue';
import { Avatar, Icon } from '../ui';
import { uploadFile } from '../core/api/endpoints/system';

const props = defineProps<{
  /** 禁用输入 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 自定义发送回调（提供则替代 store.sendMessage） */
  onSend?: (text: string) => void;
  /** 独立会话（非空 = 工具栏显示 Agent/模型选择） */
  single?: SingleSession | null;
}>();

const store = useChatStore();
const agentStore = useAgentStore();
const singlesStore = useSinglesStore();
const workspacesStore = useWorkspacesStore();
const feed = useFeedStore();
const inputText = ref('');
/** 思考强度：默认 high（''=关闭思考；P4：取代独立"深度思考" toggle） */
const reasoningEffort = ref<'' | 'low' | 'high' | 'max'>('high');
const attachedFiles = ref<FileAttachment[]>([]);
const uploading = ref(false);

// ══ 独立会话：工作区 / Agent / 模型内联选择（P4）══
const wsMenuOpen = ref(false);
const agentMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const effortMenuOpen = ref(false);
const llmPools = ref<Record<string, Record<string, unknown>>>({});
/** 本地选择态（即时生效：选择即 PATCH；props.single 刷新后回写校准） */
const selWorkspace = ref('');
const selAgent = ref('');
const selModel = ref('');

/** 可选 Agent（排除虚拟 Agent） */
const selectableAgents = computed(() => agentStore.agents.filter(a => !a.virtual));

/**
 * 会话是否已有消息：lastActivity（消息文件 mtime）或 feed 分区非空
 * （首轮流式期间文件未落盘，feed 先看到）。
 * 规则 1：已有消息的会话禁止更换预设/Agent（历史消息身份与 Agent 绑定）。
 */
const sessionLocked = computed(() => {
  if (!props.single) return false;
  if (props.single.lastActivity) return true;
  return feed.getRaw(singleDialog(props.single.id)).length > 0;
});

async function loadPools() {
  if (Object.keys(llmPools.value).length > 0) return;
  try { llmPools.value = (await fetchPools()).llmProviders ?? {}; } catch { /* ignore */ }
}

/** 会话元数据 → 本地选择态（切换会话 / PATCH 刷新后校准） */
function syncDraft() {
  selWorkspace.value = props.single?.workspaceId ?? '';
  selAgent.value = props.single?.agentId ?? '';
  selModel.value = typeof props.single?.model === 'string' ? props.single.model : '';
  // 切换会话时清空输入草稿与附件：此前残留会"串台"——A 会话的未发送文本/
  // 附件带到 B 会话（附件 hash 是按 A 的目录上传的，发给 B 无法解析）
  inputText.value = '';
  attachedFiles.value = [];
}

// direct（pair）模式同样要清：feed.activeDialogId 变化即视作切换会话
watch(() => feed.activeDialogId, () => {
  if (!props.single) {
    inputText.value = '';
    attachedFiles.value = [];
  }
});

watch(() => [props.single?.id, props.single?.workspaceId, props.single?.agentId, props.single?.model], syncDraft, { immediate: true });

/** 单开原则：任一下拉打开时关闭其余 */
function closeMenus(except?: 'ws' | 'agent' | 'model' | 'effort') {
  if (except !== 'ws') wsMenuOpen.value = false;
  if (except !== 'agent') agentMenuOpen.value = false;
  if (except !== 'model') modelMenuOpen.value = false;
  if (except !== 'effort') effortMenuOpen.value = false;
}

function toggleWsMenu() {
  const next = !wsMenuOpen.value;
  closeMenus('ws');
  wsMenuOpen.value = next;
  if (next && !workspacesStore.loaded) void workspacesStore.refresh();
}

/** 工作区显示名（'' = 未分组） */
const wsLabel = computed(() =>
  workspacesStore.workspaces.find(w => w.id === selWorkspace.value)?.name ?? '未分组');

/** 选择工作区：即时 PATCH（''=移入未分组；随时可换，不随消息锁定）。
 *  回滚校验当前值：快速连选时旧请求的迟到失败不得覆盖新选择。 */
function selectWorkspace(id: string) {
  wsMenuOpen.value = false;
  const prev = selWorkspace.value;
  if (id === prev) return;
  selWorkspace.value = id;
  if (!props.single) return;
  void singlesStore.updateSession(props.single.id, { workspaceId: id }).catch((err: any) => {
    console.error('[ChatInput] 切换工作区失败:', err?.message);
    if (selWorkspace.value === id) selWorkspace.value = prev; // 失败回滚（仅当未被更新选择覆盖）
  });
}

function toggleAgentMenu() {
  // 规则 1：已有消息的会话锁死预设/Agent（下拉只读展示）
  if (sessionLocked.value) return;
  const next = !agentMenuOpen.value;
  closeMenus('agent');
  agentMenuOpen.value = next;
  if (next) void loadPools();
}
function toggleModelMenu() {
  const next = !modelMenuOpen.value;
  closeMenus('model');
  modelMenuOpen.value = next;
  if (next) void loadPools();
}
function toggleEffortMenu() {
  const next = !effortMenuOpen.value;
  closeMenus('effort');
  effortMenuOpen.value = next;
}

/** 选择 Agent：即时 PATCH（''=清空待选；空会话发送前必须选；已有消息锁定禁选） */
function selectAgent(id: string) {
  agentMenuOpen.value = false;
  if (sessionLocked.value) return;
  const prev = selAgent.value;
  if (id === prev) return;
  selAgent.value = id;
  if (!props.single) return;
  void singlesStore.updateSession(props.single.id, { agentId: id }).catch((err: any) => {
    console.error('[ChatInput] 切换 Agent 失败:', err?.message);
    if (selAgent.value === id) selAgent.value = prev; // 失败回滚（仅当未被更新选择覆盖）
  });
}

/** 模型下拉条目（含"默认模型"空选项） */
const modelOptions = computed(() => [
  { value: '', label: '默认模型', detail: '' },
  ...Object.entries(llmPools.value).map(([name, entry]) => ({
    value: name,
    label: name,
    detail: (entry as any).model && (entry as any).model !== name ? String((entry as any).model) : '',
  })),
]);

/** 选择模型：即时 PATCH（''=清除覆盖，回落 Agent 原配置） */
function selectModel(value: string) {
  modelMenuOpen.value = false;
  const prev = selModel.value;
  if (value === prev) return;
  selModel.value = value;
  if (!props.single) return;
  void singlesStore.updateSession(props.single.id, { model: value || null }).catch((err: any) => {
    console.error('[ChatInput] 切换模型失败:', err?.message);
    if (selModel.value === value) selModel.value = prev; // 失败回滚（仅当未被更新选择覆盖）
  });
}

/** 思考强度档位（''=关闭思考） */
const EFFORT_OPTIONS: Array<{ value: '' | 'low' | 'high' | 'max'; label: string }> = [
  { value: '', label: '思考·关' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

function selectEffort(v: '' | 'low' | 'high' | 'max') {
  reasoningEffort.value = v;
  effortMenuOpen.value = false;
}

/** 未选 Agent = 默认预设（后端路由目标）；其余预设可选（agentId = 预设 id） */
const otherPresets = computed(() =>
  agentStore.presets.filter(p => p.id !== agentStore.defaultPreset?.id));

const agentName = computed(() =>
  selAgent.value ? agentStore.getAgentName(selAgent.value) || selAgent.value
    : (agentStore.defaultPreset?.name ?? '标准'));

const modelLabel = computed(() => selModel.value || '默认模型');
const effortLabel = computed(() => EFFORT_OPTIONS.find(o => o.value === reasoningEffort.value)?.label ?? '思考·关');

function onDocClick() { closeMenus(); }
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));

// ---- 发送消息 ----
function send() {
  const text = inputText.value.trim();
  if (!text && attachedFiles.value.length === 0) return;

  if (props.onSend) {
    props.onSend(text);
  } else {
    // 当前会话上下文在生成中时先打断（chat.interrupt → 会话级精确中止，
    // 不再受全局 turnInProgress 影响——其他会话流式时这里不应误打断）
    if (store.contextBusy) {
      store.interruptGeneration();
    }
    // 思考强度 ''=关闭思考；非空 = 开启并覆写档位
    const effort = reasoningEffort.value;
    store.sendMessage(text, undefined, {
      deepThink: effort !== '',
      ...(effort ? { reasoningEffort: effort } : {}),
      files: attachedFiles.value,
    });
  }

  inputText.value = '';
  attachedFiles.value = [];
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// ---- 附件上传 ----
function triggerFileUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    uploading.value = true;
    // 上传目标在进入循环前固定：循环 await 期间用户切换 Agent 的话，
    // 后续文件会以 curAgent 漂移后的值上传（附件落到错误 Agent 的目录）
    const curAgent = useAgentStore().activeAgentId;
    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const data = await uploadFile(formData, curAgent);
        attachedFiles.value.push({
          hash: data.hash ?? '',
          filename: data.storedName || data.originalName || 'file',
          filesize: data.size ?? 0,
          text: data.path,
        });
      } catch (err: any) {
        console.error('[ChatInput] Upload failed:', err);
      }
    }
    uploading.value = false;
  };
  input.click();
}

function removeFile(index: number) {
  attachedFiles.value.splice(index, 1);
}
</script>

<template>
  <div class="chat-input">
    <!-- 附件预览 -->
    <div v-if="attachedFiles.length > 0" class="file-preview-bar">
      <div
        v-for="(file, i) in attachedFiles"
        :key="`${i}-${file.hash}`"
        class="file-chip"
      >
        <span class="file-chip-name">{{ file.filename }}</span>
        <button class="file-chip-remove" @click="removeFile(i)" title="移除">×</button>
      </div>
    </div>

    <!-- ask_questions 决策触发器（输入框上方；点击展开弹出菜单组） -->
    <InteractionBar />

    <!-- 输入区 -->
    <textarea
      v-model="inputText"
      :placeholder="store.archivePending ? '当前 Agent 正在归档整理记忆，稍后处理您的回复…' : (placeholder || '输入消息… (Enter 发送, Shift+Enter 换行)')"
      :disabled="disabled"
      @keydown="onKeydown"
      rows="3"
    />

    <!-- 底部工具栏：工作区 - Agent - 模型 - 思考强度 ⋯ 附件 - 发送 -->
    <div class="input-toolbar">
      <div class="toolbar-left">
        <!-- 工作区选择（独立会话）：会话挂载的文件夹白名单分组 -->
        <div v-if="single" class="dd">
          <button
            type="button"
            class="select-btn"
            :class="{ open: wsMenuOpen }"
            @click.stop="toggleWsMenu"
            :title="selWorkspace ? `工作区：${wsLabel}\n${workspacesStore.workspaces.find(w => w.id === selWorkspace)?.path ?? ''}` : '未分组（会话不挂任何工作区）'"
          >
            <Icon name="folder" :size="15" />
            <span class="select-text">{{ wsLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: wsMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="wsMenuOpen" class="dd-menu" @click.stop>
              <!-- 未分组 -->
              <button type="button" class="dd-option" :class="{ selected: !selWorkspace }" @click="selectWorkspace('')" title="会话不挂任何工作区">
                <span class="dd-option-icon"><Icon name="folder-open" :size="16" /></span>
                <span>未分组</span>
              </button>
              <!-- 用户工作区（按名称排列） -->
              <button
                v-for="w in workspacesStore.workspaces" :key="w.id" type="button"
                class="dd-option" :class="{ selected: selWorkspace === w.id }"
                :title="w.path" @click="selectWorkspace(w.id)"
              >
                <span class="dd-option-icon"><Icon name="folder" :size="16" /></span>
                <span class="dd-option-name">{{ w.name }}</span>
              </button>
            </div>
          </Transition>
        </div>

        <!-- Agent 选择（独立会话）：头像 + 名称下拉；已有消息 = 锁死（规则 1） -->
        <div v-if="single" class="dd">
          <button
            type="button"
            class="select-btn agent-btn"
            :class="{ open: agentMenuOpen, locked: sessionLocked }"
            @click.stop="toggleAgentMenu"
            :title="sessionLocked
              ? `会话已有消息，预设/Agent 已锁定：${agentName}`
              : (selAgent ? `Agent：${agentName}` : (agentStore.defaultPreset?.description || '默认预设（无人物设定，仅基础工具）'))"
          >
            <Avatar v-if="selAgent" :src="agentStore.getAgentAvatar(selAgent)" :name="agentName" :size="18" fallback-icon="bot" />
            <Icon v-else name="sparkles" :size="16" />
            <span class="select-text">{{ agentName }}</span>
            <Icon v-if="sessionLocked" name="lock" :size="13" class="lock-icon" />
            <Icon v-else name="chevron-down" :size="14" class="chevron" :class="{ open: agentMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="agentMenuOpen" class="dd-menu" @click.stop>
              <!-- 默认预设（= 未选 Agent 的空会话路由目标） -->
              <button type="button" class="dd-option" :class="{ selected: !selAgent }" @click="selectAgent('')" :title="agentStore.defaultPreset?.description || '无人物设定，仅基础工具预设'">
                <span class="dd-option-icon"><Icon name="sparkles" :size="16" /></span>
                <span>{{ agentStore.defaultPreset?.label || '标准' }}（预设）</span>
              </button>
              <!-- 其余预设（多预设时可选；agentId = 预设 id） -->
              <button
                v-for="p in otherPresets" :key="p.id" type="button"
                class="dd-option" :class="{ selected: selAgent === p.id }"
                :title="p.description" @click="selectAgent(p.id)"
              >
                <span class="dd-option-icon"><Icon name="sparkles" :size="16" /></span>
                <span>{{ p.label || p.name }}（预设）</span>
              </button>
              <div v-if="otherPresets.length > 0" class="dd-divider"></div>
              <!-- 常规 Agent -->
              <button
                v-for="a in selectableAgents" :key="a.id" type="button"
                class="dd-option" :class="{ selected: selAgent === a.id }"
                @click="selectAgent(a.id)"
              >
                <span class="dd-option-icon"><Avatar :src="agentStore.getAgentAvatar(a.id)" :name="a.name || a.id" :size="18" fallback-icon="bot" /></span>
                <span class="dd-option-name">{{ a.name || a.id }}</span>
              </button>
            </div>
          </Transition>
        </div>

        <!-- 模型选择（独立会话）：'' = Agent 原配置 -->
        <div v-if="single" class="dd">
          <button type="button" class="select-btn" :class="{ open: modelMenuOpen }" @click.stop="toggleModelMenu" :title="selModel ? `模型覆盖：${selModel}` : '模型：Agent 原配置'">
            <Icon name="cpu" :size="15" />
            <span class="select-text">{{ modelLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: modelMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="modelMenuOpen" class="dd-menu" @click.stop>
              <button
                v-for="opt in modelOptions" :key="opt.value" type="button"
                class="dd-option" :class="{ selected: selModel === opt.value }"
                @click="selectModel(opt.value)"
              >
                <span class="dd-option-name">{{ opt.label }}</span>
                <span v-if="opt.detail" class="dd-option-detail">{{ opt.detail }}</span>
              </button>
            </div>
          </Transition>
        </div>

        <!-- 思考强度：'' = 关闭思考 -->
        <div class="dd">
          <button type="button" class="select-btn" :class="{ open: effortMenuOpen, off: !reasoningEffort }" @click.stop="toggleEffortMenu" :title="reasoningEffort ? `思考强度：${reasoningEffort}` : '思考：关闭'">
            <Icon name="clock" :size="15" />
            <span class="select-text">{{ effortLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: effortMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="effortMenuOpen" class="dd-menu" @click.stop>
              <button
                v-for="opt in EFFORT_OPTIONS" :key="opt.value" type="button"
                class="dd-option" :class="{ selected: reasoningEffort === opt.value }"
                @click="selectEffort(opt.value)"
              >
                <span>{{ opt.label }}</span>
              </button>
            </div>
          </Transition>
        </div>
      </div>

      <div class="toolbar-right">
        <button type="button" class="icon-btn" :disabled="uploading" @click="triggerFileUpload" title="附件上传">
          <Icon name="paperclip" :size="17" />
          <span v-if="uploading" class="uploading-spinner"></span>
        </button>

        <button
          type="button"
          class="icon-btn send-btn"
          :class="{ interrupting: !onSend && store.contextBusy }"
          :disabled="disabled || (!inputText.trim() && attachedFiles.length === 0)"
          @click="send"
          :title="!onSend && store.contextBusy ? '打断并发送' : '发送'"
        >
          <Icon name="send" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  margin: 0 10px 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,.05);
  position: relative;
}

/* ---- 附件预览栏 ---- */
.file-preview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding-bottom: 0;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-primary);
}

.file-chip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chip-remove {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  opacity: 0.7;
}

.file-chip-remove:hover {
  opacity: 1;
}

/* ---- 输入框 ---- */
textarea {
  width: 100%;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 56px;
  box-sizing: border-box;
}

textarea::placeholder {
  color: var(--color-text-muted);
}

textarea:focus {
  outline: none;
}

/* ---- 工具栏 ---- */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 下拉按钮通用（Agent / 模型 / 思考强度：同一视觉密度） */
.select-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
  white-space: nowrap;
}

.select-btn:hover { background: var(--color-bg-subtle); color: var(--color-text-primary); }
.select-btn.open { background: #eff0f1; color: var(--role-selected-text, #4f46e5); }
html.dark .select-btn.open { background: #1a1f2c; }

/* 未选 Agent 提示态 / 思考关闭弱化态 / 会话锁定态（规则 1：已有消息禁换预设） */
.agent-btn.missing { color: var(--color-warning, #e67e22); }
.select-btn.off { color: var(--color-text-tertiary, #a8abb2); }
.agent-btn.locked { cursor: default; color: var(--color-text-secondary); }
.agent-btn.locked:hover { background: transparent; }
.lock-icon { flex-shrink: 0; color: var(--color-text-tertiary, #a8abb2); }

.select-text {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron { flex-shrink: 0; color: var(--color-text-tertiary, #a8abb2); transition: transform .15s ease; }
.chevron.open { transform: rotate(180deg); }

/* ── 统一下拉（Agent / 模型 / 思考强度共用；向上弹出）── */
.dd { position: relative; }

.dd-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 160px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg-raised, var(--color-bg-page));
  border: 1px solid var(--line, var(--color-border-secondary));
  border-radius: 10px;
  box-shadow: var(--shadow-pop, 0 4px 16px rgba(0,0,0,.12));
  padding: 4px;
  z-index: 300;
}

.dd-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-1, var(--color-text-primary));
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.dd-option:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dd-option.selected { color: var(--role-selected-text, #4f46e5); font-weight: 600; }

.dd-option-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.dd-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dd-option-detail {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-tertiary, #a8abb2);
  flex-shrink: 0;
}

.dd-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--color-border-secondary, #e0e0e0);
}

.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity .12s ease, transform .12s ease; }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; transform: translateY(4px); }

/* ---- 图标按钮（附件 / 发送）---- */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
  position: relative;
  flex-shrink: 0;
}

.icon-btn:hover:not(:disabled) { background: var(--color-bg-subtle); color: var(--color-text-primary); }
.icon-btn:disabled { opacity: .5; cursor: not-allowed; }

.send-btn {
  background: var(--color-primary);
  color: #fff;
  box-shadow: var(--shadow-primary);
}

.send-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
  color: #fff;
  box-shadow: 0 6px 22px rgba(99, 102, 241, 0.32);
}

.send-btn:active:not(:disabled) { transform: scale(0.95); }

.send-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }

.send-btn.interrupting {
  background: var(--color-warning, #e67e22);
  animation: pulse-interrupt 1.5s ease-in-out infinite;
}

.send-btn.interrupting:hover:not(:disabled) { background: #d35400; }

@keyframes pulse-interrupt {
  0%, 100% { box-shadow: 0 0 0 0 rgba(230, 126, 34, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(230, 126, 34, 0); }
}

.uploading-spinner {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-border-secondary);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  background: var(--color-bg-page, #fff);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
