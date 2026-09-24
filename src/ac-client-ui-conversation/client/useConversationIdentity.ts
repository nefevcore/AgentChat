// ============================================================
// client/useConversationIdentity.ts —— 会话视图身份派生层
//（conversation-view-split-plan ①：自 ConversationView 抽取的纯 computed
//  族——四形态判定/对话寻址/头部目标/标题徽标/席位与 dock 键。零行为零
//  watch，唯一职责 = 把 props × 名册 × feed 派生成视图各处共用的身份
//  事实；消费方 = ConversationView（接线/透传）与 useConversationHistory。）
//
// 踩坑注释自 ConversationView 逐字随迁——它们约束派生式本身，属行为
// 规约（见 src/docs/conversation-view-split-plan.md §四）。
// ============================================================

import { computed } from 'vue';
import type { GroupInfo, ChatMessage } from './types.ts';
import { VIEWER_ID } from './viewer.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useFeedStore } from './feedStore.ts';
import { directDialog, groupDialog, singleDialog, pairDialog, bucketKey } from './feed.ts';

/** ConversationView props 契约（拆分后主文件 defineProps 同源引用） */
export interface ConversationViewProps {
  group: GroupInfo | null;
  /** 独立会话（非空 = single 视角，消息渲染/direct 输入复用） */
  single?: SingleSession | null;
  /** pair 视角端点（runview 跨包 async 引用注册；两端点都非 viewer） */
  a?: string | null;
  b?: string | null;
  /** 只读形态（pair 视角传入：仅阅读消息，禁止编辑类操作——输入/dock/仪表/轮内动作全关） */
  readonly?: boolean;
}

/** 头部席位 owner 上下文形状（conversation:header-widget 的 SlotOutlet data） */
export interface HeaderWidgetOwnerData {
  form: 'direct' | 'group' | 'single' | 'pair';
  agentId: string | null;
  conversationId: string | null;
  single: SingleSession | null;
}

export function useConversationIdentity(props: ConversationViewProps) {
  const roster = useRosterCore();
  const feed = useFeedStore();

  const isGroup = computed(() => !!props.group);
  const isSingle = computed(() => !!props.single);
  /** pair 只读形态（a/b 端点 + readonly——runview 注册时恒同真） */
  const isPair = computed(() => !!(props.a && props.b));

  const dialogId = computed(() => {
    if (props.single) return singleDialog(props.single.id);
    if (props.group) return groupDialog(props.group.group_id);
    if (isPair.value) return pairDialog(props.a!, props.b!);
    const a = roster.activeAgentId.value;
    return a ? directDialog(a) : null;
  });

  /** rawMessages 来自统一信息流（单一真相源） */
  const rawMessages = computed<ChatMessage[]>(() => (dialogId.value ? feed.getRaw(dialogId.value) : []));
  const feedDialog = computed(() => (dialogId.value ? feed.getDialog(dialogId.value) : undefined));

  // ── 头部目标/标题 ──
  /** single 承载 Agent（元数据 agentId 空 = 默认预设——与 singles store
   *  selectSingle 同款补 defaultPresetId；空串会令后端把 sid 当 viewer 估算） */
  const singleAgentId = computed(() =>
    props.single ? (props.single.agentId || roster.defaultPresetId.value) : null);
  /** 群主（记忆属主）——群形态的头部目标 Agent：Token 仪表/系统提示词预览
   *  以群主视角分析（未配群主回落首成员；无成员 = null 不出仪表） */
  const groupOwnerAgentId = computed(() => {
    if (!props.group) return null;
    return props.group.memory_owner || props.group.participants[0] || null;
  });
  /** 头部目标 Agent（single 场景 = 会话承载 Agent；群 = 群主；否则当前激活 Agent） */
  const headerAgentId = computed(() =>
    singleAgentId.value ?? (isGroup.value ? groupOwnerAgentId.value : roster.activeAgentId.value));

  const activeAgentName = computed(() => {
    const id = headerAgentId.value;
    if (!id) return '';
    // getAgentName 含预设目录解析（预设 Agent 不在 agents 列表）
    return roster.getAgentName(id) || id;
  });
  /** 会话头预设徽标（single 形态：开场固化后的身份回显——默认预设也
   *  显式点名，工具栏身份组已退役，会话头是唯一的身份显示位）。 */
  const presetChipLabel = computed(() => {
    if (!props.single) return '';
    if (!props.single.agentId) return roster.defaultPreset.value?.label || '标准';
    return roster.getAgentName(props.single.agentId) || props.single.agentId;
  });
  const title = computed(() => {
    if (props.single) {
      if (!props.single.agentId) return props.single.title || '新会话';
      return props.single.title
        || `${activeAgentName.value || props.single.agentId} · 独立会话`;
    }
    if (props.group) return props.group.name;
    return roster.activeAgentId.value ? activeAgentName.value : '选择一个 Agent 开始对话';
  });

  /** 会话头任务清单的会话键（发起会话过滤口径）：single sid / 群 gid /
   *  1v1 对桶键——与任务登记侧（call.conversationId）同词表；pair 无归属 → null */
  const jobsConversationId = computed(() => {
    if (isPair.value) return null;
    if (props.single) return props.single.id;
    if (props.group) return props.group.group_id;
    const a = roster.activeAgentId.value;
    return a ? bucketKey(VIEWER_ID.value, a) : null;
  });

  /** 头部席位 owner 上下文（D16-③：贡献按 form 自取自gate）——群形态
   *  agentId = 群主（memoryOwner 回落首成员），conversationId = gid：
   *  Token 仪表/系统提示词预览按群主视角请求（session/tokens 群分支 +
   *  agents/system-prompt 带 conversationId） */
  const headerWidgetData = computed<HeaderWidgetOwnerData>(() => ({
    form: (isPair.value ? 'pair' : props.single ? 'single' : props.group ? 'group' : 'direct'),
    agentId: isPair.value ? null : headerAgentId.value,
    conversationId: jobsConversationId.value,
    single: props.single ?? null,
  }));

  // ── next-turn 排队座位键（DSH queue 姿势；per-conversation 核心态住 store
  //    座位实例轴——conversation:dock-widget × 'queue' × convId，
  //    QueueDockHost 贡献与 ConversationView 同轴同实例〔useQueueSeat 并源
  //    接线住视图〕；行级动作在贡献容器内编排）──
  // agentId 兜底与 headerAgentId 同规（singleAgentId 同款）：single 元数据
  // agentId 空 = 默认预设承载——直接回落 activeAgentId 在 single 视角下
  // 恒 null → 座位 store.agentId 恒 null → 行级 remove/steer 的 RPC 参数
  // 拼不齐而静默 no-op（「排队消息显示得出、删不掉」根因）；补默认预设
  // 兜底后行级动作恢复寻址。
  const dockAgentId = computed(() =>
    props.single ? (props.single.agentId || roster.defaultPresetId.value) : roster.activeAgentId.value || null);
  const dockConversationId = computed(() =>
    props.single ? props.single.id
      : (roster.activeAgentId.value ? bucketKey(VIEWER_ID.value, roster.activeAgentId.value) : null));

  return {
    isGroup, isSingle, isPair,
    dialogId, rawMessages, feedDialog,
    singleAgentId, groupOwnerAgentId, headerAgentId, activeAgentName,
    presetChipLabel, title, jobsConversationId, headerWidgetData,
    dockAgentId, dockConversationId,
  };
}

export type ConversationIdentity = ReturnType<typeof useConversationIdentity>;