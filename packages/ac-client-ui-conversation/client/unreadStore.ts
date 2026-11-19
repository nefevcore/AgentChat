// ============================================================
// unreadStore.ts —— 未读徽章状态（cr-1157 计数器方案前端面）
//
// 轴键 = host 计数器键（对桶 a~b / 群 gid / single uuid——与 routeDialog
// 分区键同构的词法域）。数据面：启动/重连 take 对齐（session/unread
// 取走并清零）+ live 帧乐观 +1（cr-1139 语义）+ 点开即清（mark-read
// 定向）+ 10min 慢周期 take 兜底（帧丢失防护）。
//
// 独立于 feed-core（轴键映射与帧分发零耦合）：自订阅 wire 事件流
//（rpc.onEvent 多订阅者），进会话的清零由消费方调 markRead。
// ============================================================
import { ref, computed, type Ref } from 'vue';
import type { RpcClientFace } from 'ac-client-runtime';
import { unreadAxisKeyOf, userPairAxisKey } from 'ac-wire-format';
import { SINGLE_SESSION_ID_RE } from './dialogIdLex.ts';

/** 徽章轴键 → Agent/群行键：对桶取对端（非 viewer 端），群/ single 直用 */
function badgeKeyToAgentKey(axisKey: string, viewer: string): string {
  if (axisKey.includes('~')) {
    const [a, b] = axisKey.split('~');
    return a === viewer ? (b as string) : a;
  }
  return axisKey;
}

/** live 帧派生的轴键提取（三源同款词法） */
function axisKeyOfFrame(type: string, args: unknown[]): string | undefined {
  if (type === 'group/message-posted') {
    const gid = args[0];
    return typeof gid === 'string' && gid ? gid : undefined;
  }
  if (type === 'router/message-received') {
    const agentId = args[0];
    if (typeof agentId !== 'string' || !agentId) return undefined;
    // 私信轴 = viewer⇄agent 对桶（判据单源 ac-wire-format）
    return userPairAxisKey(agentId, VIEWER);
  }
  if (type === 'run/settled') {
    const [p] = args as [{ agent?: string; conversationId?: string }?];
    // 轴键归一判据单源（ac-core-utils 纯库——host tap 桥同款消费）
    return unreadAxisKeyOf(p?.agent, p?.conversationId, VIEWER);
  }
  return undefined;
}

export interface UnreadStore {
  /** 轴键 → n（响应式） */
  counts: Ref<Record<string, number>>;
  /** Agent/群行键聚合（AgentList 行徽章） */
  countOfAgent: (agentKey: string) => number;
  /** 总数（全部轴） */
  total: () => number;
  /** 名册行口径聚合（对桶 + 群轴——Agent 列表按钮徽章） */
  agentsTotal: () => number;
  /** single 口径聚合（uuid 轴——会话列表按钮徽章） */
  sessionsTotal: () => number;
  /** 点开即清（axisKey = host 计数器键；本地即时 + mark-read RPC fire-and-forget） */
  markRead: (axisKey: string) => void;
  /** 活跃轴取值器（正在看的会话不计数——cr-1057 语义；装配方注入） */
  setActiveAxis: (fn: () => string | undefined) => void;
  /** 启动/重连对齐（take 水合）；幂等 */
  init: () => void;
}

const VIEWER = 'user';

export function createUnreadStore(rpc: RpcClientFace): UnreadStore {
  const counts = ref<Record<string, number>>({});
  let initialized = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeAxis: () => string | undefined = () => undefined;

  const bump = (axisKey: string): void => {
    // 正在看的会话不计数（cr-1057 语义——live 已可见，计了即「人在看还亮角标」）
    if (activeAxis() === axisKey) return;
    counts.value = { ...counts.value, [axisKey]: (counts.value[axisKey] ?? 0) + 1 };
  };

  async function syncTake(): Promise<void> {
    try {
      const res = await rpc.call<{ entries: Record<string, { n: number }> }>('session/unread', {});
      // take 已清零 host 面：本地以 take 结果为基线重放（live 键在 take 后
      // 到达的帧重新 +1——先取快照再替换，竞争窗内的帧不丢）
      const base: Record<string, number> = {};
      for (const [k, v] of Object.entries(res.entries)) {
        if (v.n > 0) base[k] = v.n;
      }
      counts.value = base;
    } catch { /* RPC 失败静默——下次重连/周期兜底 */ }
  }

  function markRead(axisKey: string): void {
    if (!counts.value[axisKey]) return;
    const next = { ...counts.value };
    delete next[axisKey];
    counts.value = next;
    void rpc.call('session/mark-read', { conversationId: axisKey }).catch(() => { /* 失败静默 */ });
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    rpc.onEvent((type, args) => {
      const key = axisKeyOfFrame(type, args);
      if (key !== undefined) bump(key);
    });
    rpc.onOpen?.(() => { void syncTake(); });
    void syncTake();
    // 慢周期兜底（D3：帧丢失防护——非高频 take）
    timer = setInterval(() => { void syncTake(); }, 10 * 60 * 1000);
  }

  const agentTotals = computed(() => {
    const by: Record<string, number> = {};
    let total = 0;
    let agents = 0; // 名册行口径（对桶 + 群轴——AgentList/Agent 列表按钮徽章）
    let sessions = 0; // single 口径（uuid 轴——SessionList/会话列表按钮徽章）
    for (const [k, n] of Object.entries(counts.value)) {
      total += n;
      if (SINGLE_SESSION_ID_RE.test(k)) sessions += n;
      else agents += n;
      const ak = badgeKeyToAgentKey(k, VIEWER);
      by[ak] = (by[ak] ?? 0) + n;
    }
    return { by, total, agents, sessions };
  });

  return {
    counts,
    countOfAgent: (agentKey) => agentTotals.value.by[agentKey] ?? 0,
    total: () => agentTotals.value.total,
    // 活动栏双按钮聚合（cr-1157 微调：名册行口径 / single 口径——词法归本包，
    // ActivityBar 零词法知识消费）
    agentsTotal: () => agentTotals.value.agents,
    sessionsTotal: () => agentTotals.value.sessions,
    markRead,
    setActiveAxis: (fn) => { activeAxis = fn; },
    init,
  };
}
