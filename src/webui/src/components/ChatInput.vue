<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useSinglesStore } from '../stores/singles';
import { useWorkspacesStore } from '../stores/workspaces';
import { useFeedStore } from '../stores/feed';
import { fetchPools } from '../api/roster';
import { wireRpc } from '../api/wire';
import { VIEWER_ID } from '../constants';
import type { FileAttachment } from '../types';
import type { SingleSession } from '../api/singles';
import { singleDialog } from '../utils/feed';
import { Avatar, Icon } from '../ui';
import { uploadFile, browseDirs, type BrowseDirsResult } from '../api/files';
import { chatPresence } from '../api/chat-ops';
import { ensurePasteName } from '../utils/clipboard-file';
import { isImageRef, filePreviewUrl, contentHash12 } from '../utils/media';
import { poolModelEntries, visibleModelNames } from '../api/roster';
import { fetchSkills, type SkillsResult } from '../api/skills';
import { detectMention, replaceMentionToken, mentionMatches, buildHighlightSegments, formatFileMention, type MentionTrigger } from '../utils/mention';
import { useUiStore } from '../stores/ui';
import InputMention, { type MentionItem, type MentionGroup } from './chat/InputMention.vue';

const props = defineProps<{
  /** 禁用输入 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 自定义发送回调（提供则替代 store.sendMessage） */
  onSend?: (text: string, files?: import('../types').FileAttachment[]) => void;
  /** 独立会话（非空 = 工具栏显示 Agent/模型选择） */
  single?: SingleSession | null;
  /** 排队消息数（忙态 Cmd/Ctrl+Enter 整队列插话手势的可用性与 placeholder 提示） */
  queuedCount?: number;
  /** 整队列插话（DSH 手势：空草稿 + Cmd/Ctrl+Enter → FIFO 全部插话进运行中轮次） */
  onSteerAllQueued?: () => void;
}>();

const store = useChatStore();
const agentStore = useAgentStore();
const singlesStore = useSinglesStore();
const workspacesStore = useWorkspacesStore();
const feed = useFeedStore();
const uiStore = useUiStore();
const inputText = ref('');
/** 思考强度：默认 high（''=关闭思考；P4：取代独立"深度思考" toggle） */
const reasoningEffort = ref<'' | 'low' | 'high' | 'max'>('high');
const attachedFiles = ref<FileAttachment[]>([]);
const uploading = ref(false);

// ══ 会话模型选择（P6）：独立会话 = singles 覆盖；1v1 直答 = conv-settings ══
const wsMenuOpen = ref(false);
const agentMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const effortMenuOpen = ref(false);
/** 模型选项源：池连接（models 发现缓存）——连接池 = 唯一事实源
 *  （种子已移除：未配置即不在池、不注册、不出现在选项里） */
const llmPools = ref<Record<string, Record<string, unknown>>>({});
/** 池数据已装载（首载完成前"未配置"判定不生效——防误报） */
const poolsLoaded = ref(false);
/** 本地选择态（即时生效：选择即 PATCH/写 conv-settings；刷新后回写校准） */
const selWorkspace = ref('');
const selAgent = ref('');
const selModel = ref('');

/** 可选 Agent（排除虚拟 Agent） */
const selectableAgents = computed(() => agentStore.agents.filter(a => !a.virtual));

/**
 * 会话是否已有消息：lastActivity（消息文件 mtime）或 feed 分区非空
 * （首轮流式期间文件未落盘，feed 先看到）。
 * 规则 1（src 同款）：已有消息的会话禁止更换预设/Agent——历史消息身份与
 * 投递目标绑定（未选 Agent 的会话消息经默认预设路由，同样锁定）。
 */
const sessionLocked = computed(() => {
  if (!props.single) return false;
  if (props.single.lastActivity) return true;
  return feed.getRaw(singleDialog(props.single.id)).length > 0;
});

async function loadPools() {
  // 已有可选模型即短路；空态保持重取（新配置连接后下次打开即出现）
  if (poolsLoaded.value && modelGroups.value.length > 0) return;
  const poolsR = await fetchPools().then((r) => r.llmProviders ?? {}).catch(() => ({}));
  llmPools.value = poolsR as Record<string, Record<string, unknown>>;
  poolsLoaded.value = true;
}

/**
 * 打开菜单/挂载时对「已配置但尚无发现缓存」的连接自动补拉一次 /models
 * （llm/models 非刷新调用：缓存缺失即真拉取并回写 config）。无凭据/
 * 调不通的连接静默失败 → 保持无清单 → 不出现在选项里（选了也没意义）。
 * 每会话每 provider 只尝试一次（attempted 集）。
 */
const discoveryAttempted = new Set<string>();
function ensureDiscovered(): void {
  for (const [name, entry] of Object.entries(llmPools.value)) {
    if (name.startsWith('$') || discoveryAttempted.has(name)) continue;
    const cached = (entry as { models?: unknown })?.models;
    if (Array.isArray(cached) && cached.length > 0) continue;
    discoveryAttempted.add(name);
    void wireRpc
      .call<{ models?: string[] }>('llm/models', { name })
      .then((r) => {
        if (!Array.isArray(r.models) || r.models.length === 0) return;
        // 本地联动（服务端已回写 config 缓存——下次 fetchPools 自然带出）
        llmPools.value = {
          ...llmPools.value,
          [name]: { ...(llmPools.value[name] as Record<string, unknown> ?? {}), models: r.models },
        };
      })
      .catch(() => undefined); // 未配置/网络不通：静默——不可选项
  }
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
  // 打开即装数据 + 对无发现缓存的已注册连接补拉一次 /models（静默失败）
  if (next) void loadPools().then(() => ensureDiscovered());
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

/** 分组模型选项——【只列真实存在的模型】：池条目的发现缓存
 *  （/models 拉取过并回写 config 的清单）。静态缺省清单（种子注册面
 *  meta.models）刻意不进选项——未配置/调不通的连接选了也没意义。
 *  值 = name@model 单值引用（router 边界拆分，跨 provider 快速切换）。
 *  【能力元数据】models 宽容双形态（裸名 | {model,vision?,hidden?}）
 *  归一 + hidden 过滤（隐藏 = 纯 UI 呈现语义——已选该模型的会话不受
 *  影响，只是不再出现在下拉里）。 */
const modelGroups = computed(() => {
  return Object.entries(llmPools.value)
    .filter(([name, entry]) => !name.startsWith('$') && poolModelEntries((entry as { models?: unknown }).models).length > 0)
    .map(([name, entry]) => ({
      name,
      models: visibleModelNames((entry as { models?: unknown }).models),
    }))
    .filter((g) => g.models.length > 0);
});

/** 选择模型：即时生效——singles 走 updateSession；1v1 直答走 conv-settings
 *  （deliver 边界合并生效，服务端持久化）。'' = 清除覆盖。回滚校验当前值：
 *  快速连选时旧请求的迟到失败不得覆盖新选择。 */
function selectModel(value: string) {
  modelMenuOpen.value = false;
  const prev = selModel.value;
  if (value === prev) return;
  selModel.value = value;
  if (props.single) {
    void singlesStore.updateSession(props.single.id, { model: value || null }).catch((err: any) => {
      console.error('[ChatInput] 切换模型失败:', err?.message);
      if (selModel.value === value) selModel.value = prev; // 失败回滚（仅当未被更新选择覆盖）
    });
    return;
  }
  // 1v1 直答会话：覆盖键 = pairKey(viewer, agent)（与后端 deliver 同口径）
  const agentId = agentStore.activeAgentId;
  if (!agentId) return;
  const conversationId = [VIEWER_ID.value, agentId].sort().join('~');
  void wireRpc.call('conv-settings/set', { conversationId, patch: { model: value || null } }).catch((err: any) => {
    console.error('[ChatInput] 会话模型覆盖失败:', err?.message);
    if (selModel.value === value) selModel.value = prev;
  });
}

/** 1v1 直答：激活 Agent 切换 → 回读该会话的模型覆盖（conv-settings） */
watch(() => agentStore.activeAgentId, async (id) => {
  if (props.single || !id) return;
  const conversationId = [VIEWER_ID.value, id].sort().join('~');
  try {
    const r = await wireRpc.call<{ settings?: { model?: string } }>('conv-settings/get', { conversationId });
    selModel.value = r.settings?.model ?? '';
  } catch {
    selModel.value = ''; // 行未装/会话设置面不可用 → 无覆盖语义
  }
}, { immediate: true });

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

/** 未配置任何可用模型（警示态）：无发现清单、无默认连接模型、且本会话
 *  路由目标的 model 不可达（发送即失败）。首载完成前不判定（防误报）。
 *  可达（连接池 = 唯一事实源，判定只看池）：
 *  target 的 provider 不在池 → 不可达；在池且有发现缓存 → 可达；
 *  在池但无缓存 → 探测结算（失败）即不可达，未结算暂按可用（防闪警）。 */
function cachedModelsOf(name: string): string[] {
  const entry = llmPools.value[name] as { models?: unknown } | undefined;
  // 可达性判定看全量清单（含 hidden——隐藏是显示语义，不代表模型不可用）
  return poolModelEntries(entry?.models).map((e) => e.model);
}
const routeTargetHasModel = computed(() => {
  // singles：显式选了 Agent → 看其 model 可达性；未选 = 默认预设
  // （服务端物化默认连接——无 defaultModel 即无 model，视作无）。
  // 1v1：激活 Agent。
  const targetId = props.single
    ? (selAgent.value || '')
    : agentStore.activeAgentId;
  if (!targetId) return false;
  const target = agentStore.agents.find((a) => a.id === targetId);
  const model = target?.model;
  if (typeof model !== 'string' || !model) return false;
  // 解析目标 provider：name@model 左段 > 显式 provider > 裸名命中发现缓存
  const at = model.indexOf('@');
  const providerName = at > 0 && at < model.length - 1
    ? model.slice(0, at)
    : (target?.provider
        ? target.provider
        : Object.keys(llmPools.value).find((n) => !n.startsWith('$') && cachedModelsOf(n).includes(model)));
  if (!providerName) return false;
  if (!(providerName in llmPools.value)) return false; // 不在池 = 未配置
  if (cachedModelsOf(providerName).length > 0) return true; // 有发现缓存 = 拉得通
  // 在池无缓存：探测已结算（失败）→ 不可达；未结算 → 暂按可用（不闪警）
  return !discoveryAttempted.has(providerName);
});
const noModels = computed(() => {
  if (!poolsLoaded.value) return false;
  if (modelGroups.value.length > 0) return false;
  if (routeTargetHasModel.value) return false;
  // 有显式连接默认模型（defaultModel）→ 默认预设可物化 → 可发
  return !Object.entries(llmPools.value).some(
    ([name, entry]) => !name.startsWith('$') && typeof (entry as { defaultModel?: unknown })?.defaultModel === 'string' && (entry as { defaultModel?: string }).defaultModel,
  );
});

/** 模型标签：name@model 显示短名（title 提示全量引用）；未配置 → 警示文案 */
const modelLabel = computed(() => {
  if (!selModel.value) return noModels.value ? '未配置模型' : '默认模型';
  const at = selModel.value.indexOf('@');
  return at > 0 ? selModel.value.slice(at + 1) : selModel.value;
});
const modelTitle = computed(() => {
  if (selModel.value) return `模型覆盖：${selModel.value}`;
  return noModels.value
    ? '未配置任何模型——直接发送会失败。请到 设置 → 模型管理 配置连接（API Key）并「读取模型」'
    : '模型：Agent 原配置';
});
const effortLabel = computed(() => EFFORT_OPTIONS.find(o => o.value === reasoningEffort.value)?.label ?? '思考·关');

function onDocClick() {
  closeMenus();
  closeMention(); // 快捷输入弹层同规则：点击外部即关（弹层内部 @click.stop）
}

/** 忙态判定（DSH primaryStops）：运行中主按钮退化为纯"停止"。
 *  自定义 onSend（群聊等）不参与——保持原发送语义。 */
const busySend = computed(() => !props.onSend && store.contextBusy);

/** 忙态 placeholder（DSH placeholder.steerQueue 同款分流）：空草稿 + 有排队
 *  → 提示整队列插话手势；否则提示排队/插话手势对。 */
const busyPlaceholder = computed(() => {
  if (!inputText.value.trim() && attachedFiles.value.length === 0
    && (props.queuedCount ?? 0) > 0 && props.onSteerAllQueued) {
    return 'Cmd/Ctrl+Enter 插话发送全部排队消息';
  }
  return '运行中——Enter 排队发送，Cmd/Ctrl+Enter 立即插话';
});

onMounted(() => {
  document.addEventListener('click', onDocClick);
  // 预载池数据 + 探测无缓存连接：未配置警示态挂载即可见且自动结算
  // （删除连接后无需打开菜单即翻警示；失败静默——不可选不显示）
  void loadPools().then(() => ensureDiscovered());
});
onUnmounted(() => document.removeEventListener('click', onDocClick));

// ---- 发送消息（DSH 忙态语义）----
// 运行中 Enter 发送 → 排队（lane next-turn，本轮结束后独立投递）；
// 发送不再隐式打断在途 run——停止是停止按钮的唯一职责。
function send() {
  const text = inputText.value.trim();
  if (!text && attachedFiles.value.length === 0) return;

  if (props.onSend) {
    props.onSend(text, attachedFiles.value);
  } else {
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

/** 立即发送（忙态 Cmd/Ctrl+Enter）：steer 注入活跃 run 下一步（DSH next-step）；
 *  空闲时等价普通发送。无按钮——点击位在 QueueDock 行级"立即发送"（DSH 同款）。 */
function sendNow() {
  const text = inputText.value.trim();
  if (!text && attachedFiles.value.length === 0) return;

  if (props.onSend) {
    props.onSend(text, attachedFiles.value);
  } else {
    const effort = reasoningEffort.value;
    store.sendMessage(text, undefined, {
      deepThink: effort !== '',
      ...(effort ? { reasoningEffort: effort } : {}),
      files: attachedFiles.value,
      mode: 'steer',
    });
  }

  inputText.value = '';
  attachedFiles.value = [];
}

/** 主按钮动作：忙态 = 纯停止（DSH input.stop——无复合处理） */
function onPrimary() {
  if (busySend.value) {
    store.interruptGeneration();
    return;
  }
  send();
}

function onKeydown(e: KeyboardEvent) {
  // ── 快捷输入弹层键盘协议（DSH 同款）：↑↓ 移动、Enter/Tab 确认、Esc 关闭。
  //    IME 组合输入期（选字/翻页）不拦截——确认候选的 Enter 不是"选中条目"。
  if (mention.value && !e.isComposing) {
    const items = flatMentionItems.value;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const idx = items.findIndex((i) => i.key === mentionActiveKey.value);
      const next = e.key === 'ArrowDown'
        ? (idx + 1) % items.length
        : idx <= 0 ? items.length - 1 : idx - 1;
      mentionActiveKey.value = items[next]!.key;
      return;
    }
    // Shift+Enter 不拦截（换行意图——修饰键存在时不是"确认条目"）
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const item = items.find((i) => i.key === mentionActiveKey.value) ?? items[0];
      if (item) {
        e.preventDefault();
        // Enter = 主操作（目录进入/条目插入）；Tab = 引用（目录也走插入）
        applyMentionItem(item, e.key === 'Tab' ? 'insert' : 'primary');
        return;
      }
      // 无可选项：按普通文本处理（发送原文）——关闭弹层继续常规 Enter 流程
      closeMention();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  // Cmd/Ctrl+Enter（DSH busy 手势对）：忙态 = 另一种行为——有草稿 = 插话
  // 发送草稿；空草稿 + 有排队 = 整队列 FIFO 插话。空闲 = 等同普通发送。
  if ((e.ctrlKey || e.metaKey) && busySend.value) {
    if (inputText.value.trim() || attachedFiles.value.length > 0) {
      sendNow();
      return;
    }
    if ((props.queuedCount ?? 0) > 0 && props.onSteerAllQueued) props.onSteerAllQueued();
    return;
  }
  // 普通 Enter：忙态排队（lane next-turn），空闲普通发送
  send();
}

// ---- 快捷输入（/ 命令与技能、@ 引用文件/Agent/会话） ----

const textareaEl = ref<HTMLTextAreaElement | null>(null);
/** 当前活跃触发态（null = 弹层关闭）；随输入/光标移动重算 */
const mention = ref<MentionTrigger | null>(null);
/** 键盘 active 条目（跨分组扁平序；hover 同步到这里） */
const mentionActiveKey = ref<string | null>(null);

function closeMention(): void {
  mention.value = null;
  mentionActiveKey.value = null;
}

/** 输入/点击/方向键后重算触发态（v-model 已同步 inputText；caret 从元素读）。
 *  IME 组合输入期（选字）跳过重算——中间态拼音不参与触发判定。 */
function updateMention(e?: Event): void {
  if ((e as KeyboardEvent | undefined)?.isComposing) return;
  const el = textareaEl.value;
  if (!el || props.disabled) {
    closeMention();
    return;
  }
  mention.value = detectMention(inputText.value, el.selectionStart ?? 0);
  if (mention.value) ensureMentionData(mention.value.kind);
}

/** 弹层数据懒加载：/ → 技能目录（per-Agent 缓存）；@ → 本机目录；# → 会话清单 */
function ensureMentionData(kind: 'slash' | 'at' | 'hash'): void {
  if (kind === 'slash') {
    ensureSkills();
    return;
  }
  if (kind === 'hash') {
    if (!singlesStore.loaded) void singlesStore.refresh();
    return;
  }
  ensureFileBrowse();
}

// ── 技能目录（skills/list RPC；键 = 技能视角 Agent × 会话键——换目标或
//    换会话重拉；singles 会话挂载工作区时带出约定目录技能组） ──
const skillsCache = ref<{ cacheKey: string; data: SkillsResult | null } | null>(null);
const skillsLoading = ref(false);
/** 技能视角 Agent：single = 会话登记 Agent；1v1 = 激活 Agent；空 = 默认预设 */
const skillAgentKey = computed(() =>
  props.single ? (props.single.agentId || agentStore.defaultPresetId) : (agentStore.activeAgentId || agentStore.defaultPresetId));
/** 技能视角会话键：singles sid（工作区技能组解析锚点；1v1/群无） */
const skillConversationKey = computed(() => props.single?.id ?? '');
const skillsCacheKey = computed(() => `${skillAgentKey.value}|${skillConversationKey.value}`);

function ensureSkills(): void {
  if (skillsCache.value?.cacheKey === skillsCacheKey.value) return;
  const key = skillsCacheKey.value;
  skillsLoading.value = true;
  void fetchSkills(skillAgentKey.value, skillConversationKey.value || undefined).then((data) => {
    skillsCache.value = { cacheKey: key, data };
    skillsLoading.value = false;
  });
}

const currentSkills = computed<SkillsResult | null>(() =>
  skillsCache.value?.cacheKey === skillsCacheKey.value ? skillsCache.value.data : null);

// ── 本机目录（workspace/browse-dirs RPC；files:true 附带文件清单）──
const fileBrowse = ref<BrowseDirsResult | null>(null);
const fileLoading = ref(false);
const browseRootsList = ref<Array<{ name: string; path: string }>>([]);
const HOME_PREFIX = '家目录';

/** 浏览目录：path 空 = 快捷根清单（首开自动进入家目录——用户最常用的起点） */
async function navigateFiles(path: string): Promise<void> {
  fileLoading.value = true;
  try {
    let res = await browseDirs(path, { files: true });
    if (res.roots) {
      browseRootsList.value = res.roots;
      const home = res.roots.find((r) => r.name.startsWith(HOME_PREFIX));
      if (home && path === '') res = await browseDirs(home.path, { files: true });
    }
    fileBrowse.value = res;
  } catch {
    fileBrowse.value = { path, dirs: [], files: [], error: '目录读取失败' };
  } finally {
    fileLoading.value = false;
  }
}

function ensureFileBrowse(): void {
  if (fileBrowse.value) return;
  void navigateFiles('');
}

// ── 分组构造（过滤词 = 触发符到光标的原文；大小写不敏感包含匹配） ──

/** 群聊上下文（自定义 onSend）：会话域本地命令不适用（interrupt/archive
 *  均按 pair/single 会话键路由），只保留 /goal 脚手架与 /timer 入口 */
const isGroupCtx = computed(() => !!props.onSend);

const slashGroups = computed<MentionGroup[]>(() => {
  if (mention.value?.kind !== 'slash') return [];
  const q = mention.value.query;
  const groups: MentionGroup[] = [];
  const allCommands: MentionItem[] = [
    { key: 'cmd:stop', icon: 'stop', label: '/stop', hint: '停止当前生成', command: 'stop', danger: true },
    { key: 'cmd:archive', icon: 'file-archive', label: '/archive', hint: '整理记忆并归档当前会话', command: 'archive' },
    { key: 'cmd:goal', icon: 'target', label: '/goal', hint: '建立长期目标（经 Agent goal 工具流转）', insert: '请建立并跟踪一个长期目标：' },
    { key: 'cmd:timer', icon: 'clock', label: '/timer', hint: '打开定时任务设置', command: 'timer' },
  ];
  const commands = allCommands.filter((c) => !isGroupCtx.value || (c.command !== 'stop' && c.command !== 'archive'));
  const matchedCmds = commands.filter((c) => mentionMatches(c.label.slice(1), q));
  if (matchedCmds.length > 0) groups.push({ key: 'commands', label: '命令', items: matchedCmds });
  const skills = currentSkills.value;
  if (skills) {
    const items: MentionItem[] = [
      // 会话工作区技能（挂载工作区的约定目录——.claude/skills 等；随会话
      // 挂载的项目资产，不受 Agent 技能门控约束）置顶：当前会话最相关
      ...skills.workspace.map((s) => ({
        key: `skill:w:${s.dir ?? ''}:${s.name}`, icon: 'folder-open', label: `/${s.name}`, hint: s.description,
        detail: s.dir, insert: `/${s.name} `,
      })),
      ...skills.global.map((s) => ({
        key: `skill:g:${s.name}`, icon: 'book-open', label: `/${s.name}`, hint: s.description, insert: `/${s.name} `,
      })),
      ...skills.own.map((s) => ({
        key: `skill:o:${s.name}`, icon: 'sparkles', label: `/${s.name}`, hint: s.description, detail: '专属', insert: `/${s.name} `,
      })),
    ].filter((i) => mentionMatches(i.label.slice(1), q));
    if (items.length > 0) groups.push({ key: 'skills', label: '技能（选中插入 /技能名，Agent 经 load_skill 加载）', items });
  } else if (skillsLoading.value && q === '') {
    groups.push({ key: 'skills-loading', label: '技能', items: [{ key: 'skill:loading', icon: 'book-open', label: '技能目录加载中…' }] });
  }
  return groups;
});

const atGroups = computed<MentionGroup[]>(() => {
  if (mention.value?.kind !== 'at') return [];
  const q = mention.value.query;
  const groups: MentionGroup[] = [];
  const fb = fileBrowse.value;
  if (fb && !fb.error) {
    // 目录行双出口：主操作 = 进入（nav），次操作 = 引用（insert，经
    // formatFileMention 目录形态——尾斜杠；Agent 侧 read 目录即列表）
    const dirItems: MentionItem[] = (fb.dirs ?? [])
      .map((d): MentionItem | null => {
        const token = formatFileMention({ path: d.path, kind: 'directory' });
        if (token === null) return null;
        return { key: `dir:${d.path}`, icon: 'folder', label: d.name, nav: d.path, insert: `${token} ` };
      })
      .filter((i): i is MentionItem => i !== null)
      .filter((i) => mentionMatches(i.label, q));
    const fileItems: MentionItem[] = (fb.files ?? [])
      .map((f): MentionItem | null => {
        // [引用约定] 同语法插入：含空格路径走 @"…" 引号形态（裸形态会在
        // 空格断裂）；无法安全表示（控制字符/内嵌引号）不提供插入项
        const token = formatFileMention({ path: f.path, kind: 'file' });
        if (token === null) return null;
        return { key: `file:${f.path}`, icon: 'file', label: f.name, insert: `${token} ` };
      })
      .filter((i): i is MentionItem => i !== null)
      .filter((i) => mentionMatches(i.label, q));
    const items = [...dirItems, ...fileItems];
    if (items.length > 0) groups.push({ key: 'files', label: '文件与目录（目录 = 进入或引用；文件 = 插入路径引用）', items });
  }
  const agents: MentionItem[] = agentStore.agents
    .filter((a) => !a.virtual && mentionMatches(a.name || a.id, q))
    .map((a) => ({
      key: `agent:${a.id}`, icon: 'bot', label: a.name || a.id,
      hint: a.id === agentStore.activeAgentId ? '当前会话 Agent' : undefined,
      detail: a.id, insert: `@${a.name || a.id} `,
    }));
  if (agents.length > 0) groups.push({ key: 'agents', label: 'Agent（选中插入 @名称，Agent 侧经 list_agents 解析）', items: agents.slice(0, 8) });
  return groups;
});

/** # 模式分组：历史会话（引用内联 sid——Agent 侧无枚举会话的工具，
 *  read_history/grep_history 需要 conversation_id，纯标题是死引用） */
const hashGroups = computed<MentionGroup[]>(() => {
  if (mention.value?.kind !== 'hash') return [];
  const q = mention.value.query;
  const sessions: MentionItem[] = singlesStore.activeSingles
    .filter((s) => s.id !== props.single?.id)
    .map((s) => ({ s, title: singlesStore.titleOf(s, (id) => agentStore.getAgentName(id)) }))
    .filter(({ s, title }) => mentionMatches(title, q) || mentionMatches(s.agentId, q))
    .map(({ s, title }) => ({
      key: `session:${s.id}`, icon: 'message-circle', label: title,
      hint: s.agentId ? agentStore.getAgentName(s.agentId) : '默认预设',
      insert: `#${title}(${s.id}) `,
    }));
  return sessions.length > 0 ? [{ key: 'sessions', label: '会话（选中插入 #标题(会话 id)，Agent 可 read_history 读取）', items: sessions.slice(0, 8) }] : [];
});

const mentionGroups = computed<MentionGroup[]>(() => {
  if (!mention.value) return [];
  if (mention.value.kind === 'slash') return slashGroups.value;
  if (mention.value.kind === 'hash') return hashGroups.value;
  return atGroups.value;
});

const flatMentionItems = computed<MentionItem[]>(() =>
  mentionGroups.value.flatMap((g) => g.items));

/** 列表变化后校准 active（过滤/导航后原条目可能消失） */
watch(flatMentionItems, (items) => {
  if (!items.some((i) => i.key === mentionActiveKey.value)) {
    mentionActiveKey.value = items[0]?.key ?? null;
  }
}, { immediate: true });

/**
 * 选中条目：via='primary'（行点击/Enter）——目录 = 导航（弹层保持）、
 * 其余 = 执行本地动作或替换 token 插入；via='insert'（目录行"引用"按钮/
 * Tab）——目录也走插入（@路径/ 引用，read 目录即列表）。
 */
function applyMentionItem(item: MentionItem, via: 'primary' | 'insert' = 'primary'): void {
  const trig = mention.value;
  const el = textareaEl.value;
  if (item.nav !== undefined && via === 'primary') {
    void navigateFiles(item.nav);
    return; // 弹层保持（浏览中）
  }
  closeMention();
  if (item.command) {
    // 命令不落文本：先摘除 /token 再执行
    if (trig && el) {
      const caret = el.selectionStart ?? inputText.value.length;
      inputText.value = replaceMentionToken(inputText.value, trig.start, caret, '');
    }
    runMentionCommand(item.command);
    return;
  }
  if (item.insert !== undefined && trig) {
    const caret = el?.selectionStart ?? inputText.value.length;
    const insert = item.insert;
    inputText.value = replaceMentionToken(inputText.value, trig.start, caret, insert);
    void nextTick(() => {
      const el2 = textareaEl.value;
      if (!el2) return;
      el2.focus();
      const pos = trig.start + insert.length;
      el2.setSelectionRange(pos, pos);
      updateMention();
    });
  }
}

function runMentionCommand(cmd: NonNullable<MentionItem['command']>): void {
  if (cmd === 'stop') {
    if (busySend.value) store.interruptGeneration();
    return;
  }
  if (cmd === 'archive') {
    store.compressSession();
    return;
  }
  if (cmd === 'timer') {
    uiStore.openGlobalSettings('sys.timer');
  }
}

// 清空草稿（切会话/发送后）即关弹层
watch(inputText, (v) => {
  if (v === '') closeMention();
});

// ---- 快捷输入语义化渲染（overlay 高亮层）----
// textarea 文字透明 + 下层同字体度量 div 渲染彩色 token 芯片；光标/IME/
// 粘贴/选区全保持原生。IME 组合期临时恢复文字可见（组合预览随 color 透明
// 会不可见）；滚动同步（长草稿换行滚动时两层不错位）。
const hlEl = ref<HTMLElement | null>(null);
const isComposing = ref(false);
const highlightSegments = computed(() => buildHighlightSegments(inputText.value));

function onTaScroll(): void {
  const ta = textareaEl.value;
  const hl = hlEl.value;
  if (!ta || !hl) return;
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

// ---- 附件上传（文件选择器与剪贴板粘贴共用） ----

/**
 * 上传并挂附件（文件选择器 / 剪贴板粘贴共用）。上传目标在进入循环前
 * 固定：循环 await 期间用户切换 Agent 的话，后续文件会以 curAgent
 * 漂移后的值上传（附件落到错误 Agent 的目录）。无扩展名的剪贴板文件
 * 按 MIME 补名（ensurePasteName——图片识别/物化依赖扩展名）。
 * 【内容寻址去重】上传前算 sha1-12（与服务端同算法）：当前 compose 已
 * 挂同内容 → 跳过（不重复 chip）；本会话曾上传过（chatPresence.
 * uploadPaths 登记）→ 复用路径零上传零落盘。
 */
async function uploadAndAttach(rawFiles: File[]): Promise<void> {
  if (rawFiles.length === 0) return;
  uploading.value = true;
  const curAgent = useAgentStore().activeAgentId;
  for (const raw of rawFiles) {
    try {
      // 去重（内容哈希——与服务端 saveUpload 同算法，命中登记即复用）
      const hash = await contentHash12(raw);
      if (attachedFiles.value.some((f) => f && f.hash === hash)) continue; // 已挂同内容
      const knownPath = chatPresence.uploadPaths.get(hash);
      if (knownPath) {
        attachedFiles.value.push({
          hash,
          filename: raw.name || 'file',
          filesize: raw.size,
          text: knownPath,
        });
        continue;
      }
      const formData = new FormData();
      formData.append('file', ensurePasteName(raw));
      const data = await uploadFile(formData, curAgent);
      attachedFiles.value.push({
        hash: data.hash ?? hash,
        // 显示名优先原始名（粘贴补名/用户文件名），storedName 哈希名只作
        // 兜底——hash 字段 + uploadPaths 登记保证路径合成不受显示名影响
        filename: data.originalName || data.storedName || 'file',
        filesize: data.size ?? 0,
        text: data.path,
      });
    } catch (err: any) {
      console.error('[ChatInput] Upload failed:', err);
    }
  }
  uploading.value = false;
}

function triggerFileUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    const files = input.files;
    if (!files || files.length === 0) return;
    void uploadAndAttach(Array.from(files));
  };
  input.click();
}

/**
 * 剪贴板粘贴（Ctrl+V）：含文件项（截图位图 / 复制的文件）即拦截上传挂
 * 附件；纯文本粘贴不拦截（走默认插入行为）。多文件逐个上传，与文件
 * 选择器同一状态栏/移除交互。
 */
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length === 0) return;
  e.preventDefault();
  void uploadAndAttach(files);
}

function removeFile(index: number) {
  attachedFiles.value.splice(index, 1);
}

// ---- 预览栏图片缩略图（与 UserMessage 气泡同源：/api/file 直链，
//      加载失败回退文件名 chip）----
const thumbFailed = ref(new Set<number>());

function onThumbError(i: number) {
  thumbFailed.value.add(i);
  thumbFailed.value = new Set(thumbFailed.value);
}
</script>

<template>
  <div class="chat-input">
    <!-- 附件预览（图片附件只显缩略图——文件名退 hover 提示；加载失败回退文件名 chip） -->
    <div v-if="attachedFiles.length > 0" class="file-preview-bar">
      <template v-for="(file, i) in attachedFiles" :key="`${i}-${file.hash}`">
        <div
          v-if="isImageRef(file.text, file.filename) && !thumbFailed.has(i) && file.text"
          class="file-chip file-chip--image"
          :title="file.filename"
        >
          <img class="file-chip-thumb" :src="filePreviewUrl(file.text)" :alt="file.filename" @error="onThumbError(i)" />
          <button class="file-chip-remove" @click="removeFile(i)" title="移除"><Icon name="x" :size="10" /></button>
        </div>
        <div v-else class="file-chip">
          <span class="file-chip-name">{{ file.filename }}</span>
          <button class="file-chip-remove" @click="removeFile(i)" title="移除"><Icon name="x" :size="10" /></button>
        </div>
      </template>
    </div>

    <!-- ask_questions 决策卡片已上移至 DialogView composer 列（TaskDock/
         QueueDock 同族的输入框上方 dock 卡，不再内联在输入卡内） -->

    <!-- 快捷输入弹层（/ 命令与技能、@ 引用；触发检测见 utils/mention.ts） -->
    <InputMention
      v-if="mention"
      :groups="mentionGroups"
      :active-key="mentionActiveKey"
      :cwd="mention.kind === 'at' ? (fileBrowse?.path || '') : undefined"
      :parent="mention.kind === 'at' ? fileBrowse?.parent : undefined"
      :roots="mention.kind === 'at' ? browseRootsList : undefined"
      :loading="mention.kind === 'at' && fileLoading"
      :error="mention.kind === 'at' ? fileBrowse?.error : undefined"
      @select="applyMentionItem"
      @hover="(key: string) => (mentionActiveKey = key)"
      @navigate="(path: string) => void navigateFiles(path)"
    />

    <!-- 输入区（语义化渲染：下层高亮层 + 透明文字 textarea 同度量叠放） -->
    <div class="ta-wrap" :class="{ composing: isComposing }">
      <div ref="hlEl" class="ta-highlight" aria-hidden="true">
        <template v-for="(seg, i) in highlightSegments" :key="i">
          <span v-if="seg.kind" class="tok" :class="`tok-${seg.kind}`">{{ seg.text }}</span>
          <span v-else>{{ seg.text }}</span>
        </template>
      </div>
      <textarea
        ref="textareaEl"
        v-model="inputText"
        :placeholder="store.archivePending ? '当前 Agent 正在归档整理记忆，稍后处理您的回复…' : (busySend ? busyPlaceholder : (placeholder || '输入消息… (Enter 发送, Shift+Enter 换行；/ 命令与技能、@ 文件与Agent、# 历史会话；可直接粘贴图片/文件)'))"
        :disabled="disabled"
        @keydown="onKeydown"
        @input="updateMention"
        @keyup="updateMention"
        @click="updateMention"
        @select="updateMention"
        @paste="onPaste"
        @scroll="onTaScroll"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false; updateMention()"
        rows="3"
      />
    </div>

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

        <!-- 模型选择（P6：所有会话形态——singles/1v1；'' = Agent 原配置；
             未配置任何模型时警示标识——默认模型发不出去，防用户误以为可直接会话） -->
        <div class="dd">
          <button type="button" class="select-btn" :class="{ open: modelMenuOpen, warn: noModels && !selModel }" @click.stop="toggleModelMenu" :title="modelTitle">
            <Icon :name="noModels && !selModel ? 'alert-circle' : 'cpu'" :size="15" />
            <span class="select-text">{{ modelLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: modelMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="modelMenuOpen" class="dd-menu" @click.stop>
              <button type="button" class="dd-option" :class="{ selected: !selModel, warn: noModels }" :title="noModels ? '当前未配置任何模型——选择默认直接发送会失败' : '回落 Agent 原配置'" @click="selectModel('')">
                <span class="dd-option-name">
                  <Icon v-if="noModels" name="alert-circle" :size="13" class="dd-warn-icon" />
                  默认模型<template v-if="noModels">（未配置）</template>
                </span>
                <span class="dd-option-detail" :class="{ 'is-warn': noModels }">{{ noModels ? '发送将失败' : 'Agent 原配置' }}</span>
              </button>
              <template v-for="g in modelGroups" :key="g.name">
                <div class="dd-divider"></div>
                <div class="dd-group-label">{{ g.name }}</div>
                <button
                  v-for="m in g.models" :key="g.name + '@' + m" type="button"
                  class="dd-option" :class="{ selected: selModel === g.name + '@' + m }"
                  @click="selectModel(g.name + '@' + m)"
                >
                  <span class="dd-option-name">{{ m }}</span>
                </button>
              </template>
              <div v-if="modelGroups.length === 0" class="dd-group-label">暂无可选模型（连接未配置或未发现清单——设置 → 模型管理「读取模型」）</div>
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
        <button type="button" class="icon-btn" :disabled="uploading" @click="triggerFileUpload" title="附件上传（也可直接在输入框 Ctrl+V 粘贴图片/文件）">
          <Icon name="paperclip" :size="17" />
          <span v-if="uploading" class="uploading-spinner"></span>
        </button>

        <!-- 输入框不设"立即发送"按钮（DSH 同款）：插话的点击位在 QueueDock
             排队行的行级操作；键盘 = Cmd/Ctrl+Enter（有草稿插话草稿、空草稿
             插话整队列） -->

        <!-- 主按钮：忙态退化为纯"停止"（DSH input.stop——危险操作，红色
             示意会中止在途 run）；空闲 = 发送 -->
        <button
          type="button"
          class="icon-btn send-btn"
          :class="{ stopping: busySend }"
          :disabled="disabled || (!busySend && !inputText.trim() && attachedFiles.length === 0)"
          @click="onPrimary"
          :title="busySend ? '停止生成' : '发送'"
        >
          <Icon :name="busySend ? 'stop' : 'send'" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
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

/* 图片附件 chip（粘贴/选择即显缩略图；只显图——文件名退 hover 提示，
 * 移除按钮悬浮图右上角 hover 显） */
.file-chip--image {
  position: relative;
  padding: 0;
  border: none;
  background: none;
}

.file-chip-thumb {
  display: block;
  width: 72px;
  height: 54px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-primary);
  background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
}

.file-chip--image .file-chip-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 16px;
  height: 16px;
  justify-content: center;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  opacity: 0;
  transition: opacity 0.12s;
}

.file-chip--image:hover .file-chip-remove {
  opacity: 1;
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
  line-height: 1;
  padding: 0;
  opacity: 0.7;
  display: inline-flex;
  align-items: center;
}

.file-chip-remove:hover {
  opacity: 1;
}

/* ---- 输入区（overlay 语义化渲染：.ta-wrap 内两层同字体度量叠放，
        下层芯片 + 上层透明文字 textarea；光标/IME/选区全原生）---- */
.ta-wrap {
  position: relative;
  min-height: 56px;
}

/* 下层高亮层：与 textarea 完全同度量（字号/行高/换行/padding） */
.ta-highlight {
  position: absolute;
  inset: 0;
  border: none;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  /* 卡片内衬已给横向留白，这里补竖向呼吸感——与 textarea 同款 padding */
  padding: 4px 2px;
  box-sizing: border-box;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow: hidden;
  color: var(--color-text-primary);
  pointer-events: none;
  z-index: 0;
}

textarea {
  position: relative;
  z-index: 1;
  width: 100%;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  /* 文字透明：只见下层芯片与自身光标（选中区背景仍可见） */
  color: transparent;
  caret-color: var(--color-text-primary);
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 56px;
  box-sizing: border-box;
  /* 卡片内衬已给横向留白，这里补竖向呼吸感（顶部首行/多行滚动区不贴边） */
  padding: 4px 2px;
}

/* IME 组合期：组合预览随 color 透明会不可见——临时恢复文字可见
 *（组合片段与下层芯片短暂重叠，可接受；结束即恢复） */
.ta-wrap.composing textarea { color: var(--color-text-primary); }

textarea::placeholder {
  color: var(--color-text-muted);
}

textarea:focus {
  outline: none;
}

/* 语义 token 芯片（纯视觉——textarea 值保持字面文本，复制/发送零变化） */
.tok {
  border-radius: 4px;
  padding: 1px 2px;
  font-weight: 500;
}
.tok-skill   { color: #7c5cff; background: color-mix(in srgb, #7c5cff 12%, transparent); }
.tok-file    { color: #2f7ff6; background: color-mix(in srgb, #2f7ff6 12%, transparent); }
.tok-agent   { color: #18a058; background: color-mix(in srgb, #18a058 12%, transparent); }
.tok-session { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
html.dark .tok-skill   { color: #a38bff; background: color-mix(in srgb, #a38bff 14%, transparent); }
html.dark .tok-file    { color: #6aa6ff; background: color-mix(in srgb, #6aa6ff 14%, transparent); }
html.dark .tok-agent   { color: #4cc98a; background: color-mix(in srgb, #4cc98a 14%, transparent); }
html.dark .tok-session { color: #f0a24a; background: color-mix(in srgb, #f0a24a 14%, transparent); }

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

/* 未配置任何模型警示态（默认模型发不出去——防用户误以为可直接会话） */
.select-btn.warn { color: var(--color-warning, #e67e22); }
.select-btn.warn:hover { color: var(--color-warning, #e67e22); background: color-mix(in srgb, var(--color-warning, #e67e22) 10%, transparent); }
.dd-option.warn .dd-option-name { color: var(--color-warning, #e67e22); }
.dd-option-detail.is-warn { color: var(--color-warning, #e67e22); }
.dd-warn-icon { vertical-align: -2px; margin-right: 3px; color: var(--color-warning, #e67e22); }

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

.dd-group-label {
  padding: 2px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-tertiary, #a8abb2);
  letter-spacing: .3px;
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

/* 忙态停止（DSH input.stop）：危险操作红底方停止键——停止是它唯一的职责，
   点击即中止在途 run（红色 = 破坏性动作的视觉预告） */
.send-btn.stopping {
  background: var(--color-error);
  color: #fff;
  box-shadow: none;
  animation: pulse-stop 1.5s ease-in-out infinite;
}

.send-btn.stopping:hover { background: color-mix(in srgb, var(--color-error) 85%, #000); color: #fff; }

@keyframes pulse-stop {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-error) 35%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-error) 0%, transparent); }
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
