<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useChatStore } from './chatStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useClientContext } from 'ac-client-runtime';
import { useFeedStore, offlineRpc } from './feedStore.ts';
import { fetchPools } from 'ac-client-ui-agents/client/rosterApi.ts';
// 池模型归一化经 ui-llm-pool（2026-11 语义归位：池域词汇——模型菜单
// 消费；base→domain 契约词汇边，白名单显式裁决）
import { poolModelEntries, visibleModelNames } from 'ac-client-ui-llm-pool/client/poolApi.ts';
import { VIEWER_ID } from './viewer.ts';
import type { FileAttachment } from './types.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { singleDialog } from './feed.ts';
import { Avatar, Icon } from '@agentchat/webui-kit';
import { uploadFile, browseDirs, type BrowseDirsResult } from './fileApi.ts';
import { chatPresence } from './chatOps.ts';
import { parkDraft, takeDraft } from './draftParking.ts';
import { ensurePasteName } from './clipboardFile.ts';
import { isImageRef, filePreviewUrl, contentHash12 } from './media.ts';
import { fetchSkills, type SkillsResult } from 'ac-client-ui-skill/client/skillsApi.ts';
import { detectMention, replaceMentionToken, mentionMatches, buildHighlightSegments, formatFileMention, buildSessionMentionCandidates, type MentionTrigger } from './mention.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { loadComposePrefs, saveComposePrefs, type ComposeEffort, type ComposeElevation } from './composePrefs.ts';

import { persistToolMode } from './toolModeInherit.ts';
import InputMention, { type MentionItem, type MentionGroup } from './InputMention.vue';

const props = defineProps<{
  /** 禁用输入 */
  disabled?: boolean;
  /** 新会话开场模式（single 空会话）：顶部"工作区 | 预设模式"选择行 +
   *  输入卡整体由父视图居中；发送后父视图切回常规布局（本组件随之
   *  重挂载为常规形态）。 */
  fresh?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 自定义发送回调（提供则替代 store.sendMessage） */
  onSend?: (text: string, files?: import('./types.ts').FileAttachment[]) => void;
  /** 独立会话（非空 = 工具栏显示 Agent/模型选择） */
  single?: SingleSession | null;
  /** 排队消息数（忙态 Cmd/Ctrl+Enter 整队列插话手势的可用性与 placeholder 提示） */
  queuedCount?: number;
  /** 整队列插话（DSH 手势：空草稿 + Cmd/Ctrl+Enter → FIFO 全部插话进运行中轮次） */
  onSteerAllQueued?: () => void;
}>();

const store = useChatStore();
const roster = useRosterCore();
const singlesBoard = useClientContext()?.singleBoard;
// rpc 契约面（宿主 'rpc' 服务——模型发现/会话设置/技能目录/目录浏览经此）
const rpc = useClientContext()?.rpc ?? null;
const singlesLoaded = computed(() => singlesBoard?.loaded.value ?? false);
const activeSingles = computed(() => singlesBoard?.activeSingles.value ?? []);
const wsBoard = useClientContext()?.workspaceBoard;
const wsList = computed(() => wsBoard?.workspaces.value ?? []);
const wsLoaded = computed(() => wsBoard?.loaded.value ?? false);
const feed = useFeedStore();
const uiStore = useUiStore();
const inputText = ref('');
/** 上次组合偏好（agentId/model 在新建会话处消费；effort/elevation 在此回放） */
const lastPrefs = loadComposePrefs();
/** 思考强度：回放上次选择（缺省 high；''=关闭思考；P4：取代独立"深度思考" toggle） */
const reasoningEffort = ref<'' | 'low' | 'high' | 'max'>((lastPrefs?.effort as ComposeEffort) ?? 'high');
/** 快捷提权（access-tier §七 / webui 按钮）：武装后续消息的执行档位。
 *  持续生效——保持武装直到手动改回（武装态警示色常显）；不随发送复位
 *  （2026-09 反馈：提权后连续作业不应每条重新武装）。持久授权正路仍是
 *  Agent 配置 tags 升档。视角切换重挂载回放上次选择（与思考强度同款）。 */
const elevation = ref<'' | 'sandbox-access' | 'full-access'>((lastPrefs?.elevation as ComposeElevation) ?? '');
/** 工具调用模式（2026-09-17 tc-* 标签轴统一重构：与提权档位同构——
 *  Agent tags 定默认档、conv-settings.toolMode 会话覆盖）：'' = 跟随
 *  Agent（tags 档，缺省 tc-base）；'tc-base' | 'tc-programmatic' |
 *  'tc-none' = 会话覆盖。选择即写会话 conv-settings（键面同 elevation
 *  口径，全形态生效）。旧 programmatic 布尔开关与「新会话继承写」
 *  （toolModeInherit）已随重构退役——持久程序化 = 给 Agent 配
 *  tc-programmatic 标签。退役预设防御见 presetRetired。 */
const toolMode = ref<'' | 'tc-base' | 'tc-programmatic' | 'tc-none'>('');
const attachedFiles = ref<FileAttachment[]>([]);
const uploading = ref(false);

// ══ 会话模型选择（P6）：独立会话 = singles 覆盖；1v1 直答 = conv-settings ══
const agentMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const elevMenuOpen = ref(false);
const toolModeMenuOpen = ref(false);
/** 组合菜单下钻面板（root = 一级设置项列表；点某项下钻二级选项） */
const agentPanel = ref<'root' | 'ws' | 'agent'>('root');
const modelPanel = ref<'root' | 'model' | 'effort'>('root');
/* 执行组拆分（2026-12：提权与工具调用模式分立两钮——组合菜单项过多，
 * 且「程序化调用模式」需要用户先单独熟悉）。单项菜单直开选项列表
 * （无下钻）：打开即档位，选择即生效，菜单保持开可连续调整。 */
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
const selectableAgents = computed(() => roster.agents.value.filter(a => !a.virtual));

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

/**
 * 退役预设防御（research §十 迁移裁决）：会话登记 Agent 为
 * __programmatic__（存量实测会话以该预设身份运行）且预设目录已不含
 * 该 id → 该会话无可用 Agent 身份，续聊将 404/落空——输入框禁用 +
 * 迁移提示（历史只读保留）。
 */
const presetRetired = computed(() =>
  props.single?.agentId === '__programmatic__'
  && !roster.presets.value.some(p => p.id === '__programmatic__'));

/** 输入禁用 = 调用方禁用 ∪ 退役预设防御 */
const inputDisabled = computed(() => props.disabled || presetRetired.value);

async function loadPools() {
  // 已有可选模型即短路；空态保持重取（新配置连接后下次打开即出现）
  if (poolsLoaded.value && modelGroups.value.length > 0) return;
  const poolsR = await fetchPools(rpc ?? offlineRpc).then((r) => r.llmProviders ?? {}).catch(() => ({}));
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
    if (!rpc) return;
    void rpc
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

/** 会话元数据 → 本地选择态（PATCH 刷新后校准）。会话内切换工作区/
 *  Agent/模型不再清空输入草稿——草稿跟随会话而非路由配置（2026-09
 *  体验修复：切模型/工作区丢半截输入）。 */
function syncDraft() {
  selWorkspace.value = props.single?.workspaceId ?? '';
  selAgent.value = props.single?.agentId ?? '';
  selModel.value = typeof props.single?.model === 'string' ? props.single.model : '';
}

// ── 草稿转场（draft parking）：切会话时暂存/恢复未发送草稿 ──
// 暂存位 = 模块级单例（draftParking.ts）——ChatInput 随视角切换重挂载
// （PerspectiveHost <component :is> 换 async wrapper），实例内状态不可
// 依赖；卸载兜底暂存（onUnmounted——离开视角时草稿不丢）。附件不跟随：
// hash 按 Agent 目录上传，跨会话/跨 Agent 无法解析（见 uploadAndAttach），
// 转场即弃。
const lastDraftKey = ref<string | null>(null);

/** 转场：暂存当前草稿（若有键），恢复目标键草稿（无草稿 = 空） */
function parkAndRestoreDraft(from: string | null, to: string | null): void {
  if (from === to) return;
  if (from) parkDraft(from, inputText.value);
  inputText.value = to ? takeDraft(to) : '';
  attachedFiles.value = []; // 附件不跨会话（路径按原会话 Agent 目录解析）
  // 提权武装不随转场复位：持续生效直到手动改回（后端只升不降兜底）
}

/** 当前草稿位键：single = singleDialog(id)；direct/群 = 活跃 dialog 键 */
function currentDraftKey(): string | null {
  return props.single ? singleDialog(props.single.id) : (feed.activeDialogId ?? null);
}

// 会话身份 + 选择态校准源。草稿只在身份变化（single.id）时转场；
// PATCH 回流（会话内切工作区/Agent/模型）不再触碰草稿——输入不丢。
watch(() => [props.single?.id, props.single?.agentId], ([id, agent], old) => {
  // immediate 首调 old = undefined（首次无前值：prevId 取哨兵让 id 分支必胜）
  const [prevId, prevAgent] = old ?? [];
  if (id !== prevId) {
    const to = currentDraftKey();
    parkAndRestoreDraft(lastDraftKey.value, to);
    lastDraftKey.value = to;
  } else if (agent !== prevAgent) {
    // 会话内换 Agent：草稿保留，附件弃（上传路径按旧 Agent 目录解析）；
    // 提权武装保留（持续生效直到手动改回——后端按新目标自有档位 clamp）
    attachedFiles.value = [];
  }
  syncDraft();
}, { immediate: true });

// direct（pair）模式：feed.activeDialogId 变化即切换会话 → 草稿转场
// （切 Agent / 群 ↔ 直答互切都走这里；single 模式由上面的 watch 覆盖）。
// immediate：视角切换重挂载后 dialog 已是当前值（无变化可观察）——
// 首调即恢复暂存草稿（from=null → 只恢复不误存）。
watch(() => feed.activeDialogId, (dialog) => {
  if (props.single) return;
  const to = dialog ?? null;
  parkAndRestoreDraft(lastDraftKey.value, to);
  lastDraftKey.value = to;
}, { immediate: true });

// 卸载兜底：视角切换重挂载（instance 内 inputText 随之销毁）前把当前
// 草稿存回暂存位——切回该会话（或同视角重建）时可恢复。
onUnmounted(() => {
  const key = lastDraftKey.value;
  if (key) parkDraft(key, inputText.value);
});

/** 单开原则：任一下拉打开时关闭其余 */
function closeMenus(except?: 'agent' | 'model' | 'elev' | 'toolmode') {
  if (except !== 'agent') { agentMenuOpen.value = false; agentPanel.value = 'root'; }
  if (except !== 'model') { modelMenuOpen.value = false; modelPanel.value = 'root'; }
  if (except !== 'elev') elevMenuOpen.value = false;
  if (except !== 'toolmode') toolModeMenuOpen.value = false;
}

/** fresh 顶行菜单开合（工作区/预设直开对应二级；单开原则经 closeMenus） */
function openFreshMenu(panel: 'ws' | 'agent') {
  const target = panel === 'ws' ? 'agent' : 'ws';
  const same = agentMenuOpen.value && agentPanel.value === panel;
  closeMenus();
  if (same) return; // 再点同钮 = 关
  agentMenuOpen.value = true;
  agentPanel.value = panel;
  if (panel === 'ws' && !wsLoaded.value) void wsBoard?.refresh();
}

/** 工作区显示名（'' = 未分组） */
const wsLabel = computed(() =>
  wsList.value.find(w => w.id === selWorkspace.value)?.name ?? '未分组');

/** 选择工作区：即时 PATCH（''=移入未分组；随时可换，不随消息锁定）。
 *  回滚校验当前值：快速连选时旧请求的迟到失败不得覆盖新选择。 */
function selectWorkspace(id: string) {
  agentMenuOpen.value = false; // 身份类选择即关整组
  agentPanel.value = 'root';
  const prev = selWorkspace.value;
  if (id === prev) return;
  selWorkspace.value = id;
  if (!props.single) return;
  void singlesBoard?.updateSession(props.single.id, { workspaceId: id }).catch((err: any) => {
    console.error('[ChatInput] 切换工作区失败:', err?.message);
    if (selWorkspace.value === id) selWorkspace.value = prev; // 失败回滚（仅当未被更新选择覆盖）
  });
}

// toggleAgentMenu 退役（2026-12 身份组收口）：常规工具栏不再放身份入口，
// fresh 顶行经 openFreshMenu 开合（单开原则同走 closeMenus）。
function toggleModelMenu() {
  const next = !modelMenuOpen.value;
  closeMenus('model');
  modelMenuOpen.value = next;
  modelPanel.value = 'root'; // 重开回一级
  // 打开即装数据 + 对无发现缓存的已注册连接补拉一次 /models（静默失败）
  if (next) void loadPools().then(() => ensureDiscovered());
}
function toggleElevMenu() {
  const next = !elevMenuOpen.value;
  closeMenus('elev');
  elevMenuOpen.value = next;
}
function toggleToolModeMenu() {
  const next = !toolModeMenuOpen.value;
  closeMenus('toolmode');
  toolModeMenuOpen.value = next;
}

/** 选择 Agent：即时 PATCH（''=清空待选；空会话发送前必须选；已有消息锁定禁选）。
 *  选择写回组合偏好（新开会话回放）。 */
function selectAgent(id: string) {
  agentMenuOpen.value = false; // 身份类选择即关整组
  agentPanel.value = 'root';
  if (sessionLocked.value) return;
  const prev = selAgent.value;
  if (id === prev) return;
  selAgent.value = id;
  saveComposePrefs({ agentId: id });
  if (!props.single) return;
  void singlesBoard?.updateSession(props.single.id, { agentId: id }).catch((err: any) => {
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
 *  快速连选时旧请求的迟到失败不得覆盖新选择。选择写回组合偏好（新开会话回放）。 */
function selectModel(value: string) {
  modelPanel.value = 'root'; // 参数类选择回一级（可连续调整）
  const prev = selModel.value;
  if (value === prev) return;
  selModel.value = value;
  saveComposePrefs({ model: value });
  if (props.single) {
    void singlesBoard?.updateSession(props.single.id, { model: value || null }).catch((err: any) => {
      console.error('[ChatInput] 切换模型失败:', err?.message);
      if (selModel.value === value) selModel.value = prev; // 失败回滚（仅当未被更新选择覆盖）
    });
    return;
  }
  // 1v1 直答会话：覆盖键 = pairKey(viewer, agent)（与后端 deliver 同口径）
  const agentId = roster.activeAgentId.value;
  if (!agentId) return;
  const conversationId = [VIEWER_ID.value, agentId].sort().join('~');
  if (!rpc) return;
  void rpc.call('conv-settings/set', { conversationId, patch: { model: value || null } }).catch((err: any) => {
    console.error('[ChatInput] 会话模型覆盖失败:', err?.message);
    if (selModel.value === value) selModel.value = prev;
  });
}

/** 1v1 直答：激活 Agent 切换 → 回读该会话的模型覆盖（conv-settings） */
watch(() => roster.activeAgentId.value, async (id) => {
  if (props.single || !id) return;
  const conversationId = [VIEWER_ID.value, id].sort().join('~');
  if (!rpc) { selModel.value = ''; return; }
  try {
    const r = await rpc.call<{ settings?: { model?: string } }>('conv-settings/get', { conversationId });
    selModel.value = r.settings?.model ?? '';
  } catch {
    selModel.value = ''; // 行未装/会话设置面不可用 → 无覆盖语义
  }
}, { immediate: true });

/** 会话覆盖键（工具调用模式）：single = sid；1v1 = pairKey(viewer, agent)
 *  （与后端 deliver 同口径；模型覆盖键的同款双形态） */
const toolModeConvKey = computed(() => {
  if (props.single) return props.single.id;
  const agentId = roster.activeAgentId.value;
  return agentId ? [VIEWER_ID.value, agentId].sort().join('~') : null;
});

/** 目标 Agent 的 tags 工具调用模式档（toolModeOf 同款判定——前端复刻；
 *  single = 会话登记 Agent/默认预设；1v1 = 激活 Agent/默认预设）。
 *  名册/presets 目录均无 tags 数据 = 视为 tc-base（缺席宽容——不误伤
 *  旧后端）。用于跟随态的实际生效档显示。 */
const agentToolMode = computed<'tc-base' | 'tc-programmatic' | 'tc-none'>(() => {
  const targetId = props.single
    ? (selAgent.value || roster.defaultPresetId.value)
    : (roster.activeAgentId.value || roster.defaultPresetId.value);
  if (!targetId) return 'tc-base';
  const tags = roster.agents.value.find(a => a.id === targetId)?.tags
    ?? roster.presets.value.find(p => p.id === targetId)?.tags;
  if (!tags) return 'tc-base';
  if (tags.includes('tc-none')) return 'tc-none';
  if (tags.includes('tc-programmatic')) return 'tc-programmatic';
  return 'tc-base';
});
/** 程序化可用性：Agent 工具面含 run_code（infra 能力族——2026-09-17
 *  优化裁决：程序化是形态选择非授权门槛，选「程序化」= 临时程序化档）。
 *  无 infra（或 run-code 行未装）时覆盖惰性——router warn 忽略，UI
 *  禁选并说明，防「勾了不生效」的静默落差（实测 3a8ea4f7 坑）。名册/
 *  presets 目录均无 tags 数据 = 视为可用（缺席宽容——不误伤旧后端）。 */
const programmaticAvailable = computed(() => {
  if (agentToolMode.value === 'tc-none') return false; // 无工具档：程序化无意义
  const targetId = props.single
    ? (selAgent.value || roster.defaultPresetId.value)
    : (roster.activeAgentId.value || roster.defaultPresetId.value);
  if (!targetId) return true;
  const tags = roster.agents.value.find(a => a.id === targetId)?.tags
    ?? roster.presets.value.find(p => p.id === targetId)?.tags;
  if (!tags) return true; // 两目录均无 tags（旧后端/未拉取）——宽容不拦截
  return tags.includes('infra');
});

/** 挂载/会话切换：回读会话工具调用模式覆盖（conv-settings toolMode）。
 *  会话有显式键 = 存储为准（用户在该会话的覆盖）；无键（新会话）=
 *  **跟随上次选择**——回放组合偏好并写该会话 conv-settings（2026-09-17
 *  恢复：覆盖必须落存储才生效——router 收窄读的是它；'' 跟随态无需写，
 *  tags 档天然生效）。写入经 toolModeInherit 登记，deliver 前 await 兜底
 *  ——首条消息不抢在继承写之前出门。Agent 不支持目标档（如无 infra 的
 *  程序化）时不写：跟随态兜底（该会话选了也不生效，防「假象继承」）。 */
watch(toolModeConvKey, async (conversationId) => {
  if (!conversationId || !rpc) { toolMode.value = ''; return; }
  try {
    const r = await rpc.call<{ settings?: { toolMode?: string } }>('conv-settings/get', { conversationId });
    if (conversationId !== toolModeConvKey.value) return; // 快速连切：迟到响应不覆盖当前会话
    const stored = r.settings?.toolMode;
    if (stored === 'tc-base' || stored === 'tc-programmatic' || stored === 'tc-none') {
      toolMode.value = stored;
      store.setConvToolMode(stored); // 会话切换回读也同步快照（预览面 watch）
      return;
    }
    // 无显式键：回放偏好（缺记录 = 跟随态，不动存储）
    const pref = loadComposePrefs()?.toolMode;
    if (pref === undefined || pref === '') { toolMode.value = ''; store.setConvToolMode(''); return; }
    if (pref === 'tc-programmatic' && !programmaticAvailable.value) {
      toolMode.value = ''; // Agent 无 infra：程序化对其惰性——不继承（跟随态兜底）
      store.setConvToolMode('');
      return;
    }
    toolMode.value = pref;
    store.setConvToolMode(pref);
    const writing = rpc.call('conv-settings/set', { conversationId, patch: { toolMode: pref } })
      .catch((err: unknown) => {
        console.warn('[ChatInput] 工具调用模式继承写失败:', (err as { message?: string })?.message ?? String(err));
      });
    persistToolMode(conversationId, writing);
  } catch {
    toolMode.value = ''; // 行未装/面不可用 → 无覆盖语义（跟随态）
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
  saveComposePrefs({ effort: v });
  modelPanel.value = 'root'; // 参数类选择回一级（可连续调整）
}

/** 快捷提权档位（access-tier §三 档位词汇）：'' = 跟随 Agent 自有档位
 *  （tags 判定——并非无权限）。持续生效——武装后续所有消息，直到手动
 *  改回；后端 deliver 边界只升不降（武装档 ≤ 自有档位时无效果）。 */
const ELEV_OPTIONS: Array<{
  value: '' | 'sandbox-access' | 'full-access';
  label: string;
  icon: string;
  detail: string;
  title: string;
}> = [
  { value: '', label: '默认', icon: 'shield', detail: '', title: '按 Agent 自有档位（tags）执行——需要权限时弹出审批卡询问' },
  { value: 'sandbox-access', label: '沙箱访问', icon: 'shield-check', detail: '白名单内自由', title: '后续消息驱动的 run 至少按 sandbox-access 执行：工作区白名单内自由写、bash 软边界内自由；越界视同基础档。持续生效直到改回；Agent 自有档位更高时按自有档位执行（只升不降）' },
  { value: 'full-access', label: '完全访问', icon: 'shield-check', detail: '不受限', title: '后续消息驱动的 run 按 full-access 执行：跳过路径复检与命令扫描（系统域黑名单仍生效）。持续生效直到改回；持久授权请改 Agent 配置 tags；自有档位更高时按自有档位执行' },
];

function selectElevation(v: '' | 'sandbox-access' | 'full-access') {
  elevation.value = v;
  saveComposePrefs({ elevation: v });
  // 菜单保持开——扁平选项列表可连续调整
}

// ── 工具调用模式（2026-09-17 tc-* 标签轴统一重构：与提权档位同构）──
// 与 ELEV 同族的 dd 下拉（跟随 Agent + 三值覆盖）；选择即写会话
// conv-settings.toolMode（router 按「覆盖 ?? toolModeOf(agent)」收窄——
// run 间隙生效，非 run 中途翻转）。覆盖键见 toolModeConvKey。

/** 选择工具调用模式：即时生效——写会话 conv-settings（singles sid 与
 *  1v1 对键同走该 RPC，显式键 = 本会话权威态；'' = 删键回到跟随态）。 */
function selectToolMode(v: '' | 'tc-base' | 'tc-programmatic' | 'tc-none') {
  // 菜单保持开——扁平选项列表可连续调整
  if (toolMode.value === v) return;
  if (v === 'tc-programmatic' && !programmaticAvailable.value) return; // 无标签禁选（惰性对齐）
  const prev = toolMode.value;
  toolMode.value = v;
  saveComposePrefs({ toolMode: v }); // 新会话跟随上次选择（挂载回读回放并落该会话）
  const conversationId = toolModeConvKey.value;
  if (!conversationId || !rpc) return;
  // wire 值域：合法枚举原样；''/null = 删键（web-api set 面）
  void rpc.call('conv-settings/set', { conversationId, patch: { toolMode: v === '' ? null : v } })
    .then(() => {
      // 写入成功 → bump 会话模式快照：system-prompt 预览（aux 侧栏常驻
      // 面板）/ Token 估算面 watch 得知装配面已变，重取反映 SDK 投影块
      // 注入/工具 schema 收窄（2026-12 预览失真修复）。
      store.setConvToolMode(v);
    })
    .catch((err: any) => {
      console.error('[ChatInput] 工具调用模式写入失败:', err?.message);
      if (toolMode.value === v) toolMode.value = prev; // 失败回滚
    });
}

/** 工具调用模式档位词表（跟随项 detail 按 Agent tags 档分流显示；程序化
 *  覆盖项在 Agent 无 tc-programmatic 标签时禁选） */
const TOOL_MODE_OPTIONS = computed<Array<{ value: '' | 'tc-base' | 'tc-programmatic' | 'tc-none'; label: string; icon: string; detail: string; title: string; disabled?: boolean }>>(() => [
  {
    value: '',
    label: '默认',
    icon: 'wrench',
    detail: agentToolModeLabel.value,
    title: `按 Agent tags 决定的模式执行（当前：${agentToolModeLabel.value}）——程序化持久生效请给 Agent 配 tc-programmatic 标签`,
  },
  { value: 'tc-base', label: '标准', icon: 'wrench', detail: '逐个调用', title: '本会话覆盖为标准档：模型逐个调用工具（每个工具独立 schema，直接直调）——压制 Agent 的 tc-programmatic/tc-none 标签档' },
  programmaticAvailable.value
    ? { value: 'tc-programmatic', label: '程序化', icon: 'braces', detail: 'run_code 编排', title: '本会话覆盖为程序化档：工具面收窄为 run_code 单入口——模型写一段 TypeScript 程序经 tools.* API 编排成批工具调用，只有最终返回值回上下文（大幅降低 token 消耗）。run 间隙生效' }
    : { value: 'tc-programmatic', label: '程序化', icon: 'braces', detail: '需 infra 标签', title: '当前 Agent（含预设）未授予 infra 能力标签（run_code 不可见）——程序化对其惰性（勾选不生效，后端 warn 并回落）。请到 Agent 设置添加该标签，或换用已授权的 Agent', disabled: true },
  { value: 'tc-none', label: '无工具', icon: 'message-square', detail: '纯聊天', title: '本会话覆盖为无工具档：移除 LLM 工具面（纯聊天——模型只输出文本，不调用任何工具）' },
]);

/** Agent tags 档显示词（跟随态的实际生效档） */
const AGENT_TOOL_MODE_LABEL: Record<'tc-base' | 'tc-programmatic' | 'tc-none', string> = {
  'tc-base': '标准',
  'tc-programmatic': '程序化',
  'tc-none': '无工具',
};
const agentToolModeLabel = computed(() => AGENT_TOOL_MODE_LABEL[agentToolMode.value]);

/** 档位显示词（与后端 tierOf 同词表：full > sandbox > 缺省 base） */
const TIER_LABEL: Record<'sandbox-access' | 'full-access', string> = {
  'sandbox-access': '沙箱访问',
  'full-access': '完全访问',
};
/** 会话目标 Agent 的自有档位（tags 判定，底座——未武装即按此执行）：
 *  single = 会话登记 Agent（空 = 默认预设）；1v1 = 激活 Agent。
 *  名册无 tags 数据（预设/未同步）= 基础档。 */
const agentTier = computed<'' | 'sandbox-access' | 'full-access'>(() => {
  const targetId = props.single
    ? (selAgent.value || roster.defaultPresetId.value)
    : (roster.activeAgentId.value || roster.defaultPresetId.value);
  const tags = roster.agents.value.find(a => a.id === targetId)?.tags;
  if (!tags) return '';
  if (tags.includes('full-access')) return 'full-access';
  if (tags.includes('sandbox-access')) return 'sandbox-access';
  return '';
});
/** 底座档位显示（默认项 detail + 未武装 title） */
const agentTierLabel = computed(() => (agentTier.value ? TIER_LABEL[agentTier.value] : '基础档'));

/** 未选 Agent = 默认预设（后端路由目标）；其余预设可选（agentId = 预设 id） */
const otherPresets = computed(() =>
  roster.presets.value.filter(p => p.id !== roster.defaultPreset.value?.id));

const agentName = computed(() =>
  selAgent.value ? roster.getAgentName(selAgent.value) || selAgent.value
    : (roster.defaultPreset.value?.name ?? '标准'));

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
    : roster.activeAgentId.value;
  if (!targetId) return false;
  const target = roster.agents.value.find((a) => a.id === targetId);
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

/** 模型标签：name@model 完整引用显示（title 提示覆盖语义）；未配置 → 警示文案 */
const modelLabel = computed(() => {
  if (!selModel.value) return noModels.value ? '未配置模型' : '默认模型';
  return selModel.value;
});
const modelTitle = computed(() => {
  if (selModel.value) return `模型覆盖：${selModel.value}`;
  return noModels.value
    ? '未配置任何模型——直接发送会失败。请到 设置 → 模型管理 配置连接（API Key）并「读取模型」'
    : '模型：Agent 原配置';
});
const effortLabel = computed(() => EFFORT_OPTIONS.find(o => o.value === reasoningEffort.value)?.label ?? '思考·关');
/** 工具调用模式按钮显示（'braces' 图标 = 程序卡象形同源）：覆盖态直名，
 *  跟随态显 Agent tags 档 */
const toolModeLabel = computed(() => {
  if (toolMode.value === '') return `默认·${agentToolModeLabel.value}`;
  const opt = TOOL_MODE_OPTIONS.value.find(o => o.value === toolMode.value);
  return opt?.label ?? '默认';
});
const toolModeTitle = computed(() => {
  if (toolMode.value === 'tc-programmatic' && !programmaticAvailable.value) {
    return '工具调用模式：当前 Agent（含预设）未授予 infra 能力标签（run_code 不可见）——程序化对其惰性（不生效）。请到 Agent 设置添加该标签，或换用已授权的 Agent';
  }
  const opt = TOOL_MODE_OPTIONS.value.find(o => o.value === toolMode.value);
  return opt?.title ?? '工具调用模式（tc-* 标签轴）';
});

const elevTitle = computed(() => {
  if (!elevation.value) {
    return `快捷提权：未武装——消息按 Agent 自有档位执行（当前：${agentTierLabel.value}）；高于自有档位可临时提权（持续生效直到改回）`;
  }
  const armed = elevation.value === 'sandbox-access' ? 'sandbox-access（至少沙箱访问档）' : 'full-access（完全访问档）';
  return `已武装 ${armed}：后续消息均按此执行（持续生效直到改回；不低于 Agent 自有档位——只升不降）`;
});

/** 提权按钮显示：默认"权限"；武装态显主动摘要（警示色由类承担） */
const elevBtnLabel = computed(() => {
  if (elevation.value === 'full-access') return '提权·完全';
  if (elevation.value === 'sandbox-access') return '提权·沙箱';
  return '权限';
});

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
    // 提权随消息透传（持续武装——不随发送复位）；忙态 Enter 排队时随
    // 消息入队，本轮结束后按本条档位开 run
    const elev = elevation.value;
    store.sendMessage(text, undefined, {
      deepThink: effort !== '',
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(elev ? { elevation: elev } : {}),
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
    // steer 注入不改在途 run 档位（run 的 elevation 在开跑时已定）——
    // 提权参数随信封送达但不生效；空闲时等价普通发送（生效）
    const elev = elevation.value;
    store.sendMessage(text, undefined, {
      deepThink: effort !== '',
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(elev ? { elevation: elev } : {}),
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
  if ((e as KeyboardEvent | undefined)?.isComposing) {
    // 组合期伴随 input 事件——同步镜像（compositionupdate 缺席的浏览器兜底）
    syncCompositionMirror();
    return;
  }
  const el = textareaEl.value;
  if (!el || props.disabled) {
    closeMention();
    return;
  }
  mention.value = detectMention(inputText.value, el.selectionStart ?? 0);
  if (mention.value) ensureMentionData(mention.value.kind);
}

/** 弹层数据懒加载：/ → 技能目录（per-Agent 缓存）；@ → 本机目录；# → 会话清单。
 *  # 的过期重拉（stale-while-open）：快照只在 singles/updated（元数据事件）
 *  时刷新，消息活动不触发——弹层每次触发时轻校准一次，保证新会话/新近
 *  活动即时可引用（另一端创建、事件帧丢失等场景兜底）。 */
const singlesRefreshAt = ref(0);
function ensureMentionData(kind: 'slash' | 'at' | 'hash'): void {
  if (kind === 'slash') {
    ensureSkills();
    return;
  }
  if (kind === 'hash') {
    const now = Date.now();
    if (!singlesLoaded.value || now - singlesRefreshAt.value > 30_000) {
      singlesRefreshAt.value = now;
      void singlesBoard?.refresh();
    }
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
  props.single ? (props.single.agentId || roster.defaultPresetId.value) : (roster.activeAgentId.value || roster.defaultPresetId.value));
/** 技能视角会话键：singles sid（工作区技能组解析锚点；1v1/群无） */
const skillConversationKey = computed(() => props.single?.id ?? '');
const skillsCacheKey = computed(() => `${skillAgentKey.value}|${skillConversationKey.value}`);

function ensureSkills(): void {
  if (skillsCache.value?.cacheKey === skillsCacheKey.value) return;
  const key = skillsCacheKey.value;
  skillsLoading.value = true;
  void fetchSkills(skillAgentKey.value, skillConversationKey.value || undefined, rpc ?? offlineRpc).then((data) => {
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
    let res = await browseDirs(path, { files: true }, rpc ?? offlineRpc);
    if (res.roots) {
      browseRootsList.value = res.roots;
      const home = res.roots.find((r) => r.name.startsWith(HOME_PREFIX));
      if (home && path === '') res = await browseDirs(home.path, { files: true }, rpc ?? offlineRpc);
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
  const agents: MentionItem[] = roster.agents.value
    .filter((a) => !a.virtual && mentionMatches(a.name || a.id, q))
    .map((a) => ({
      key: `agent:${a.id}`, icon: 'bot', label: a.name || a.id,
      hint: a.id === roster.activeAgentId.value ? '当前会话 Agent' : undefined,
      detail: a.id, insert: `@${a.name || a.id} `,
    }));
  if (agents.length > 0) groups.push({ key: 'agents', label: 'Agent（选中插入 @名称，Agent 侧经 list_agents 解析）', items: agents.slice(0, 8) });
  return groups;
});

/** # 模式分组：历史会话（引用内联 sid——Agent 侧无枚举会话的工具，
 *  read_history/grep_history 需要 conversation_id，纯标题是死引用）。
 *  候选构造经 buildSessionMentionCandidates（过滤+排序+截断纯函数）：
 *  按最近活动降序在截断前——singles 快照只在元数据事件时重拉，消息
 *  活动不触发，按快照序截断会把新聊会话挡在弹层外（"要刷新页面才
 *  能 # 引用新会话"根因）。 */
const hashGroups = computed<MentionGroup[]>(() => {
  if (mention.value?.kind !== 'hash') return [];
  const sessions: MentionItem[] = buildSessionMentionCandidates(activeSingles.value, {
    query: mention.value.query,
    excludeId: props.single?.id,
    titleOf: (s) => singlesBoard?.titleOf(s, (id) => roster.getAgentName(id)) ?? s.title ?? s.id,
  }).map(({ source, title }) => ({
    key: `session:${source.id}`, icon: 'message-circle', label: title,
    hint: source.agentId ? roster.getAgentName(source.agentId) : '默认预设',
    insert: `#` + title + '(' + source.id + ') ',
  }));
  return sessions.length > 0 ? [{ key: 'sessions', label: '会话（选中插入 #标题(会话 id)，Agent 可 read_history 读取）', items: sessions }] : [];
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
    uiStore.openTimers(); // 直达 aux timers 选区（settings sys.timer 节已撤——单一入口）
  }
}

// 清空草稿（切会话/发送后）即关弹层；程序性改值后校准高亮层滚动
watch(inputText, (v) => {
  if (v === '') closeMention();
  void nextTick(syncHighlightScroll);
});

// ---- 快捷输入语义化渲染（overlay 高亮层）----
// textarea 文字透明 + 下层同字体度量 div 渲染彩色 token 芯片；光标/IME/
// 粘贴/选区全保持原生。IME 组合期切换为文字单层渲染（textarea 可见 +
// 高亮层文字隐藏，防两层亚像素错位重影；token 底色药丸保留）；滚动同步
// （长草稿换行滚动时两层不错位）。
const hlEl = ref<HTMLElement | null>(null);
const isComposing = ref(false);
/** 组合期实时镜像（textarea DOM value——含 IME 组合预览）。v-model 在组合
 *  期刻意不同步（Vue 语义），若高亮层仍渲染旧 inputText：组合期上层文字
 *  临时恢复可见，插入点之后的文本被预览推向右侧，与下层旧位置文本重影
 *  互遮（文本中间打字遮盖反馈）。组合中随 composition 事件镜像实时值，
 *  两层逐字符同内容对齐。 */
const compositionMirror = ref('');
/** 高亮渲染源：组合期 = DOM 实时值（与上层可见文本同内容）；常态 = v-model 值 */
const highlightText = computed(() => (isComposing.value ? compositionMirror.value : inputText.value));
const highlightSegments = computed(() => buildHighlightSegments(highlightText.value));

/** 镜像同步：读 textarea 实时 DOM 值（组合期 v-model 值未含预览） */
function syncCompositionMirror(): void {
  compositionMirror.value = textareaEl.value?.value ?? inputText.value;
}

function onCompositionStart(): void {
  isComposing.value = true;
  syncCompositionMirror();
}
function onCompositionUpdate(): void {
  syncCompositionMirror();
}
function onCompositionEnd(): void {
  isComposing.value = false;
  compositionMirror.value = '';
  updateMention();
}

/** 滚动同步：高亮层跟随 textarea 滚动偏移（长草稿内部滚动时两层不错位）。
 *  覆盖两类触发：用户滚动（scroll 事件直调）与程序性改值（发送清空/
 *  草稿恢复/mention 插入——textarea 可能自动滚到光标处但不派发 scroll，
 *  watch inputText 经 nextTick 手动校准）。 */
function syncHighlightScroll(): void {
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
  const curAgent = roster.activeAgentId.value;
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
  <!-- 新会话开场选择行（fresh，多根 fragment 第一根）：移出输入卡——
       独立成行、靠左对齐（输入卡保持自身布局不受影响）。两项均为开场
       身份设定（开始会话即固化：工作区不可再改、预设显示在会话头） -->
  <div v-if="fresh && single" class="fresh-setup-row">
    <!-- 工作区选择（开场身份之一：开始会话即固化，不可再改）。菜单直开
         工作区二级列表（复用 agentMenuOpen/agentPanel 状态——fresh 模式
         下常规身份组隐藏，单开不冲突；选择即 PATCH 生效） -->
    <div class="dd">
        <button
          type="button"
          class="select-btn"
          :class="{ open: agentMenuOpen && agentPanel === 'ws' }"
          @click.stop="openFreshMenu('ws')"
          title="工作区（开始会话后固化，不可再改）"
        >
          <Icon name="folder" :size="15" />
          <span class="select-text">{{ wsLabel }}</span>
          <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: agentMenuOpen && agentPanel === 'ws' }" />
        </button>
        <Transition name="menu-fade">
          <div v-if="agentMenuOpen && agentPanel === 'ws'" class="dd-menu" @click.stop>
            <button type="button" class="dd-option dd-option--2line" :class="{ selected: !selWorkspace }" @click="selectWorkspace('')" title="会话不挂任何工作区">
              <span class="dd-option-icon"><Icon name="folder-open" :size="16" /></span>
              <span class="dd-option-body">
                <span class="dd-option-name">未分组</span>
                <span class="dd-option-desc">会话不挂任何工作区</span>
              </span>
              <Icon v-if="!selWorkspace" name="check" :size="15" class="dd-option-check" />
            </button>
            <button
              v-for="w in wsList" :key="w.id" type="button"
              class="dd-option dd-option--2line" :class="{ selected: selWorkspace === w.id }"
              :title="w.path" @click="selectWorkspace(w.id)"
            >
              <span class="dd-option-icon"><Icon name="folder" :size="16" /></span>
              <span class="dd-option-body">
                <span class="dd-option-name">{{ w.name }}</span>
                <span class="dd-option-desc">{{ w.path }}</span>
              </span>
              <Icon v-if="selWorkspace === w.id" name="check" :size="15" class="dd-option-check" />
            </button>
          </div>
        </Transition>
      </div>
      <!-- 预设模式选择（开场身份之二：首条消息后锁定，身份显示在会话头） -->
      <div class="dd">
        <button
          type="button"
          class="select-btn"
          :class="{ open: agentMenuOpen && agentPanel === 'agent' }"
          @click.stop="openFreshMenu('agent')"
          :title="selAgent ? '预设/Agent：' + agentName : (roster.defaultPreset.value?.description || '默认预设（无人物设定，仅基础工具）')"
        >
          <Avatar v-if="selAgent" :src="roster.getAgentAvatar(selAgent)" :name="agentName" :size="18" fallback-icon="bot" plain-fallback />
          <Icon v-else name="sparkles" :size="15" />
          <span class="select-text">{{ agentName }}</span>
          <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: agentMenuOpen && agentPanel === 'agent' }" />
        </button>
        <Transition name="menu-fade">
          <div v-if="agentMenuOpen && agentPanel === 'agent'" class="dd-menu" @click.stop>
            <button
              type="button" class="dd-option dd-option--2line"
              :class="{ selected: !selAgent, 'is-disabled': sessionLocked }"
              :disabled="sessionLocked"
              @click="selectAgent('')"
              :title="roster.defaultPreset.value?.description || '无人物设定，仅基础工具预设'"
            >
              <span class="dd-option-icon"><Icon name="sparkles" :size="16" /></span>
              <span class="dd-option-body">
                <span class="dd-option-name">{{ roster.defaultPreset.value?.label || '标准' }}（预设）</span>
                <span class="dd-option-desc">{{ roster.defaultPreset.value?.description || '无人物设定，仅基础工具' }}</span>
              </span>
              <Icon v-if="!selAgent" name="check" :size="15" class="dd-option-check" />
            </button>
            <button
              v-for="p in otherPresets" :key="p.id" type="button"
              class="dd-option dd-option--2line" :class="{ selected: selAgent === p.id, 'is-disabled': sessionLocked }"
              :disabled="sessionLocked"
              :title="p.description" @click="selectAgent(p.id)"
            >
              <span class="dd-option-icon"><Icon name="sparkles" :size="16" /></span>
              <span class="dd-option-body">
                <span class="dd-option-name">{{ p.label || p.name }}（预设）</span>
                <span class="dd-option-desc">{{ p.description }}</span>
              </span>
              <Icon v-if="selAgent === p.id" name="check" :size="15" class="dd-option-check" />
            </button>
            <div v-if="selectableAgents.length > 0" class="dd-divider"></div>
            <button
              v-for="a in selectableAgents" :key="a.id" type="button"
              class="dd-option dd-option--2line" :class="{ selected: selAgent === a.id, 'is-disabled': sessionLocked }"
              :disabled="sessionLocked"
              @click="selectAgent(a.id)"
            >
              <span class="dd-option-icon"><Avatar :src="roster.getAgentAvatar(a.id)" :name="a.name || a.id" :size="18" fallback-icon="bot" plain-fallback /></span>
              <span class="dd-option-body">
                <span class="dd-option-name">{{ a.name || a.id }}</span>
                <span class="dd-option-desc">{{ a.description }}</span>
              </span>
              <Icon v-if="selAgent === a.id" name="check" :size="15" class="dd-option-check" />
            </button>
          </div>
        </Transition>
      </div>
    </div>

  <!-- 输入卡（fresh 缺席期本根仍渲染——常规会话的唯一根；fresh 态
       加 fresh-card：限宽 + 水平居中——居中画面下拉满全宽观感失衡） -->
  <div class="chat-input" :class="{ 'fresh-card': fresh && single }">
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

    <!-- ask_questions 决策卡片已上移至 ConversationView composer 列（ComposerDock/
         QueueDock 同族的输入框上方 dock 卡，不再内联在输入卡内） -->

    <!-- 退役预设迁移提示（research §十）：存量 __programmatic__ 会话禁止
         续聊（预设已退役，续聊将 404）——历史只读保留 -->
    <div v-if="presetRetired" class="retire-banner" role="note">
      <Icon name="alert-circle" :size="14" />
      <span>程序化模式预设已退役，本会话无法续聊（历史保留只读）。请开新会话，并在输入框下方工具栏选择「程序化」工具使用模式。</span>
    </div>

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
        :placeholder="presetRetired ? '程序化模式预设已退役——请开新会话并从工具栏选择「程序化」模式' : (store.archivePending ? '当前 Agent 正在归档整理记忆，稍后处理您的回复…' : (busySend ? busyPlaceholder : (placeholder || '输入消息… (Enter 发送, Shift+Enter 换行；/ 命令与技能、@ 文件与Agent、# 历史会话；可直接粘贴图片/文件)')))"
        :disabled="inputDisabled"
        @keydown="onKeydown"
        @input="updateMention"
        @keyup="updateMention"
        @click="updateMention"
        @select="updateMention"
        @paste="onPaste"
        @scroll="syncHighlightScroll"
        @compositionstart="onCompositionStart"
        @compositionupdate="onCompositionUpdate"
        @compositionend="onCompositionEnd"
        rows="3"
      />
    </div>

    <!-- 底部工具栏：模型（模型+思考）- 工具模式 - 权限 ⋯ 附件 - 发送
         （身份组退役 2026-12：开场身份在 fresh 顶行设定，开始会话后
         预设固化到会话头、工作区不可再改——工具栏不再放身份入口） -->
    <div class="input-toolbar">
      <div class="toolbar-left">
        <!-- 模型组：模型 + 思考强度（同为推理参数语义域）——一级 = 设置项
             列表（右显当前值），点行下钻二级选项；选择回一级可连续调整 -->
        <div v-if="!isGroupCtx" class="dd">
          <button type="button" class="select-btn" :class="{ open: modelMenuOpen, warn: noModels && !selModel }" @click.stop="toggleModelMenu" :title="modelTitle">
            <Icon :name="noModels && !selModel ? 'alert-circle' : 'cpu'" :size="15" />
            <span class="select-text">{{ selModel || (noModels ? '未配置模型' : '模型') }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: modelMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="modelMenuOpen" class="dd-menu" @click.stop>
              <!-- 一级：设置项列表 -->
              <template v-if="modelPanel === 'root'">
                <button
                  type="button" class="dd-option"
                  :class="{ selected: !!selModel }"
                  @click="modelPanel = 'model'"
                  :title="modelTitle"
                >
                  <span class="dd-option-icon"><Icon name="cpu" :size="16" /></span>
                  <span class="dd-option-name">模型</span>
                  <span class="dd-option-detail" :class="{ 'is-warn': noModels }">
                    {{ modelLabel }}
                    <Icon name="chevron-right" :size="14" class="dd-arrow" />
                  </span>
                </button>
                <button
                  type="button" class="dd-option"
                  :class="{ selected: !!reasoningEffort }"
                  @click="modelPanel = 'effort'"
                  :title="reasoningEffort ? `思考强度：${reasoningEffort}` : '思考：关闭'"
                >
                  <span class="dd-option-icon"><Icon name="clock" :size="16" /></span>
                  <span class="dd-option-name">思考强度</span>
                  <span class="dd-option-detail">
                    {{ effortLabel }}
                    <Icon name="chevron-right" :size="14" class="dd-arrow" />
                  </span>
                </button>
              </template>
              <!-- 二级：模型选项 -->
              <template v-else-if="modelPanel === 'model'">
                <button type="button" class="dd-option dd-back" @click="modelPanel = 'root'" title="返回">
                  <span class="dd-option-icon"><Icon name="chevron-left" :size="16" /></span>
                  <span class="dd-option-name">模型</span>
                </button>
                <div class="dd-divider"></div>
              <button type="button" class="dd-option dd-option--2line" :class="{ selected: !selModel, warn: noModels }" :title="noModels ? '当前未配置任何模型——选择默认直接发送会失败' : '回落 Agent 原配置'" @click="selectModel('')">
                <span class="dd-option-icon">
                  <Icon v-if="noModels" name="alert-circle" :size="16" class="dd-warn-icon" />
                  <Icon v-else name="cpu" :size="16" />
                </span>
                <span class="dd-option-body">
                  <span class="dd-option-name">
                    默认模型<template v-if="noModels">（未配置）</template>
                  </span>
                  <span class="dd-option-desc" :class="{ 'is-warn': noModels }">{{ noModels ? '发送将失败——请到设置 → 模型管理配置连接' : '使用 Agent 原配置的模型' }}</span>
                </span>
                <Icon v-if="!selModel" name="check" :size="15" class="dd-option-check" />
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
              </template>
              <!-- 二级：思考强度选项 -->
              <template v-else>
                <button type="button" class="dd-option dd-back" @click="modelPanel = 'root'" title="返回">
                  <span class="dd-option-icon"><Icon name="chevron-left" :size="16" /></span>
                  <span class="dd-option-name">思考强度</span>
                </button>
                <div class="dd-divider"></div>
                <button
                  v-for="opt in EFFORT_OPTIONS" :key="opt.value" type="button"
                  class="dd-option" :class="{ selected: reasoningEffort === opt.value }"
                  @click="selectEffort(opt.value)"
                >
                  <span>{{ opt.label }}</span>
                </button>
              </template>
            </div>
          </Transition>
        </div>

        <!-- 工具调用模式（独立按钮）：与提权分立——程序化调用模式需要
             用户先单独熟悉。单项菜单直开档位列表（无下钻）：选择即写
             会话 conv-settings，菜单保持开可连续调整 -->
        <div v-if="!isGroupCtx" class="dd">
          <button
            type="button"
            class="select-btn"
            :class="{ open: toolModeMenuOpen, prog: toolMode === 'tc-programmatic' }"
            @click.stop="toggleToolModeMenu"
            :title="toolModeTitle"
          >
            <Icon name="braces" :size="15" />
            <span class="select-text">{{ toolModeLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: toolModeMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="toolModeMenuOpen" class="dd-menu" @click.stop>
              <button
                v-for="opt in TOOL_MODE_OPTIONS" :key="String(opt.value)" type="button"
                class="dd-option dd-option--2line" :class="{ selected: toolMode === opt.value, 'is-disabled': opt.disabled }"
                :title="opt.title"
                :disabled="opt.disabled"
                @click="selectToolMode(opt.value)"
              >
                <span class="dd-option-icon"><Icon :name="opt.icon" :size="16" /></span>
                <span class="dd-option-body">
                  <span class="dd-option-name">{{ opt.label }}</span>
                  <span class="dd-option-desc" :class="{ 'is-warn': opt.disabled }">{{ opt.detail }}</span>
                </span>
                <Icon v-if="toolMode === opt.value" name="check" :size="15" class="dd-option-check" />
              </button>
            </div>
          </Transition>
        </div>

        <!-- 权限（快捷提权）：与工具模式分立的独立按钮（2026-12 拆分）。
             单项菜单直开档位列表（无下钻）：选择即武装/解除，菜单保持开；
             武装态警示色常显 -->
        <div v-if="!isGroupCtx" class="dd">
          <button
            type="button"
            class="select-btn"
            :class="{ open: elevMenuOpen, armed: !!elevation, 'armed-full': elevation === 'full-access' }"
            @click.stop="toggleElevMenu"
            title="快捷提权（权限档位）"
          >
            <Icon :name="elevation ? 'shield-check' : 'shield'" :size="15" />
            <span class="select-text">{{ elevBtnLabel }}</span>
            <Icon name="chevron-down" :size="14" class="chevron" :class="{ open: elevMenuOpen }" />
          </button>
          <Transition name="menu-fade">
            <div v-if="elevMenuOpen" class="dd-menu" @click.stop>
              <button
                v-for="opt in ELEV_OPTIONS" :key="opt.value" type="button"
                class="dd-option dd-option--2line" :class="{ selected: elevation === opt.value }"
                :title="opt.title"
                @click="selectElevation(opt.value)"
              >
                <span class="dd-option-icon"><Icon :name="opt.icon" :size="16" /></span>
                <span class="dd-option-body">
                  <span class="dd-option-name">{{ opt.label }}</span>
                  <span class="dd-option-desc">{{ opt.value === '' ? agentTierLabel : opt.detail }}</span>
                </span>
                <Icon v-if="elevation === opt.value" name="check" :size="15" class="dd-option-check" />
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
          :disabled="inputDisabled || (!busySend && !inputText.trim() && attachedFiles.length === 0)"
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
  /* 双层浅影（贴边 + 4px/12px 柔光；原硬编码 0 1px 3px rgba(0,0,0,.05) 在深色底上不可见）——
     双主题值见 webui-kit tokens.css --shadow-input */
  box-shadow: var(--shadow-input, 0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 12px rgba(0, 0, 0, 0.08));
  position: relative;
}

/* ── 新会话开场（fresh）：限宽 + 水平居中——开场画面是居中构图，
   拉满全宽会失衡；960px 为实测最舒适宽度（F12 调试值），留出两侧呼吸 ── */
.chat-input.fresh-card {
  width: min(960px, calc(100% - 20px));
  align-self: center;
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
  /* 与 textarea 同高（恰好 3 整行 = 63px）——高亮层 inset:0 铺满本层 */
  min-height: 63px;
}

/* 下层高亮层：与 textarea 完全同度量（字号/行高/换行/padding） */
.ta-highlight {
  position: absolute;
  inset: 0;
  border: none;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  /* 与 textarea 完全同度量（字号/行高/换行/padding）；表单控件不继承
     body 的 optimizeLegibility——显式 auto 与 textarea 渲染模式对齐
     （kerning/连字策略不同会改变字符步进 → 软折行点分歧） */
  text-rendering: auto;
  padding: 0 2px;
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
  /* block 化：inline-block 基线对齐会在控件下方撑出 ~7px 行框下沉
     （63px 控件 → 容器 70px），高亮层 inset:0 跟随容器变高 → 滚动到底
     时 scrollTop 钳制值不同（63 vs 56），最后两行错位。block 消除基线
     支撑，容器精确 = 3 整行。 */
  display: block;
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
  /* 表单控件 UA 默认渲染模式即 auto——显式声明与高亮层对齐（body 的
     optimizeLegibility 不进控件；两层 kerning 策略不同会错位） */
  text-rendering: auto;
  /* 总高 = 恰好 3 整行（整数行数，杜绝"三行半"式截断观感）：行高
     1.5 × 14px × 3 = 63px。竖向内衬归零——原 4px×2 衬垫令总高 71px ≈
     3.38 行；行上下呼吸由卡片内衬（12px）承担。em 跟随字号，改字号仍保持整行 */
  height: calc(1.5em * 3);
  box-sizing: border-box;
  padding: 0 2px;
  /* 长草稿内部滚动：隐藏滚动条（滚动能力保留——滚轮/光标跟随照常滚）。
   *  经典滚动条（Windows Chrome 常驻 ~17px）会占内容宽度：textarea 实际
   *  换行变窄、高亮层（overflow hidden 无滚动条）仍按全宽换行 → 两层换行
   *  点错位，token 药丸与透明文字错开（编辑正常、显示错位的根因）。隐藏
   *  后两层度量一致，滚动偏移经 scroll 事件同步高亮层。 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

textarea::-webkit-scrollbar {
  display: none;
}

/* IME 组合期：组合预览随 color 透明会不可见——临时恢复文字可见。
 * 文字单层渲染：高亮层文字同时隐藏——div 与 textarea 的文字光栅化存在
 * 亚像素级差异，两层同内容文字同时可见即重影。token 仅保留底色药丸
 * （textarea 文字叠于其上 = 荧光笔标记观感），组合结束恢复双层分工 */
.ta-wrap.composing textarea { color: var(--color-text-primary); }
.ta-wrap.composing .ta-highlight,
.ta-wrap.composing .ta-highlight .tok { color: transparent; }

textarea::placeholder {
  color: var(--color-text-muted);
}

textarea:focus {
  outline: none;
}

/* 语义 token 芯片（纯视觉——textarea 值保持字面文本，复制/发送零变化）。
 * 度量零偏差：不加粗、无水平 padding（任何水平占位都会把芯片后文推向
 * 右侧，与上层透明文字层错位——组合期文字可见时即重影遮盖）。芯片感
 * 由颜色 + 底色承担，圆角保留。 */
.tok {
  border-radius: var(--radius-sm);
  padding: 1px 0;
  font-weight: inherit;
}
.tok-skill   { color: #7c5cff; background: color-mix(in srgb, #7c5cff 12%, transparent); }
.tok-file    { color: #2f7ff6; background: color-mix(in srgb, #2f7ff6 12%, transparent); }
.tok-agent   { color: #18a058; background: color-mix(in srgb, #18a058 12%, transparent); }
.tok-session { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
html.dark .tok-skill   { color: #a38bff; background: color-mix(in srgb, #a38bff 14%, transparent); }
html.dark .tok-file    { color: #6aa6ff; background: color-mix(in srgb, #6aa6ff 14%, transparent); }
html.dark .tok-agent   { color: #4cc98a; background: color-mix(in srgb, #4cc98a 14%, transparent); }
html.dark .tok-session { color: #f0a24a; background: color-mix(in srgb, #f0a24a 14%, transparent); }

/* ---- 新会话开场顶行（fresh，输入卡外独立行）：工作区 | 预设模式
     （开场身份设定——开始会话即固化）。靠左，但与限宽居中的输入卡
     对齐——同样的 min(960px) 宽度容器内左对齐，随窗口缩放跟随 ---- */
.fresh-setup-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  width: min(960px, calc(100% - 20px));
  margin: 0 auto 8px;
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

/* 会话锁定态图标（规则 1：已有消息禁换预设——fresh 预设面板内 lock 象形） */
.lock-icon { flex-shrink: 0; color: var(--color-text-tertiary, #a8abb2); }

/* 快捷提权武装态（持续生效直到改回）：警示色常显——防"忘记已武装"；
 * full 档用危险色（不受限的执行档，视觉重量最高） */
.select-btn.armed { color: var(--color-warning, #e67e22); font-weight: 600; }
.select-btn.armed:hover { color: var(--color-warning, #e67e22); background: color-mix(in srgb, var(--color-warning, #e67e22) 10%, transparent); }
.select-btn.armed-full { color: var(--color-error, #e5484d); }
.select-btn.armed-full:hover { color: var(--color-error, #e5484d); background: color-mix(in srgb, var(--color-error, #e5484d) 10%, transparent); }

/* 程序化模式激活态（工具使用模式 = 程序化）：主色微亮——模式在场的持续提示 */
.select-btn.prog { color: var(--color-primary, #4f46e5); font-weight: 600; }
.select-btn.prog:hover { color: var(--color-primary, #4f46e5); background: color-mix(in srgb, var(--color-primary, #4f46e5) 10%, transparent); }
/* 档位不可选（Agent 无 tc-programmatic 标签——覆盖惰性对齐） */
.dd-option.is-disabled { opacity: .55; cursor: not-allowed; }
.dd-option.is-disabled:hover { background: none; }

/* 退役预设迁移提示条（research §十防御）：警示色整行——存量会话只读 */
.retire-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--color-warning, #e67e22) 45%, transparent);
  background: color-mix(in srgb, var(--color-warning, #e67e22) 8%, transparent);
  border-radius: var(--radius-md);
  color: var(--color-warning, #e67e22);
  font-size: 12px;
  line-height: 1.5;
}

/* 未配置任何模型警示态（默认模型发不出去——防用户误以为可直接会话） */
.select-btn.warn { color: var(--color-warning, #e67e22); }
.select-btn.warn:hover { color: var(--color-warning, #e67e22); background: color-mix(in srgb, var(--color-warning, #e67e22) 10%, transparent); }
.dd-option.warn .dd-option-name { color: var(--color-warning, #e67e22); }
.dd-option-detail.is-warn { color: var(--color-warning, #e67e22); }
.dd-warn-icon { vertical-align: -2px; margin-right: 3px; color: var(--color-warning, #e67e22); }

.select-text {
  max-width: 220px;
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

/* 选中态 = 行尾 check 勾（主色）——正文/名称保持常态色；此前整行染
 * --role-selected-text（主题靛蓝）是下拉里"文字发蓝"的观感来源（分组
 * 标题邻近选中项时尤显突兀——它本身是灰色 var(--color-text-tertiary)） */
.dd-option:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dd-option.selected .dd-option-name { font-weight: 600; }

.dd-option-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

/* 选中勾（行尾）：主色象形替代整行染色 */
.dd-option-check {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-primary, #4f46e5);
  display: inline-flex;
  align-items: center;
}

/* ── 二级选项双层布局（上层 ICON+名称，下层描述）──
 * 描述获得整行宽度（不再与名称/箭头同行挤压），释放更多说明空间；
 * 单层行不受影响（模型清单名等仍单行）。 */
.dd-option--2line {
  align-items: flex-start;
  padding: 6px 10px;
}

.dd-option-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.dd-option-desc {
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-tertiary, #a8abb2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 60%;
  /* 文本部分超长省略（内嵌箭头图标不参与压缩） */
  white-space: nowrap;
  overflow: hidden;
}

.dd-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--color-border-secondary, #e0e0e0);
}

.dd-back { color: var(--color-text-secondary); font-weight: 500; }
.dd-back:hover { color: var(--text-1, var(--color-text-primary)); }

.dd-arrow { margin-left: 4px; color: var(--color-text-tertiary, #a8abb2); }

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
