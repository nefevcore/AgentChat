// ============================================================
// Chat Store —— 消息状态、流式输出、事件分发
//
// 依赖 useWebSocketStore（连接）和 useAgentStore（Agent 选择）
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { ChatMessage, Turn, TurnStep } from '../types';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';
import { logger } from '../utils/logger';

interface AgentMsg { thinking: string; tool_calls: any[]; content: string; ts: number; label?: string; }
interface AgentTurnEntry { agent_id: string; turns: AgentMsg[]; final: AgentMsg | null; }

const HISTORY_PAGE_SIZE = 5;
const TURN_DONE_DELAY = 300;

export const useChatStore = defineStore('chat', () => {
  // ── State ──
  /** Per-agent 消息缓冲：切换对话时不再丢失流式输出 */
  const _agentMessages = ref<Record<string, ChatMessage[]>>({});
  /** 有未读消息的 Agent ID 集合（虚拟 Agent 消息实时推送时标记） */
  const _unreadAgents = ref(new Set<string>(restoreUnread()));
  const _agentTurns = ref<Record<string, AgentTurnEntry[]>>({});
  /** 已完成 turn 的缓存（增量构建，历史加载一次，流式 onTurnEnd 追加） */
  const _turns = ref<Record<string, Turn[]>>({});

  // ── 小红点持久化 ──
  const UNREAD_KEY = 'agentchat.unreadAgents';
  function persistUnread() {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([..._unreadAgents.value]));
  }
  function restoreUnread(): string[] {
    try { return JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]'); } catch { return []; }
  }
  const loadingHistory = ref(false);
  const hasMoreHistory = ref(false);
  const turnInProgress = ref(false);

  // ── System Prompt 预览 ──
  const systemPromptLoading = ref(false);
  const systemPromptContent = ref('');
  const systemPromptError = ref('');

  // ── 工具定义预览 ──
  const toolDefsLoading = ref(false);
  const toolDefs = ref<any[]>([]);
  const toolDefsError = ref('');

  // ── 复制反馈 ──
  const copyFeedback = ref(false);

  let pendingDoneTimer: ReturnType<typeof setTimeout> | null = null;
  const _historyOffset: Record<string, number> = {};

  // ── Per-agent 消息缓冲辅助 ──
  function getMsgs(agentId: string): ChatMessage[] {
    if (!_agentMessages.value[agentId]) {
      _agentMessages.value[agentId] = [];
    }
    return _agentMessages.value[agentId]!;
  }
  function setMsgs(agentId: string, msgs: ChatMessage[]): void {
    _agentMessages.value[agentId] = msgs;
  }

  // ── Getters ──
  const messages = computed(() => getMsgs(activeAgent()));
  const currentMessages = computed(() =>
    messages.value.filter(m => m.role === 'agent' || m.role === 'tool')
  );

  // ── Turns（增量构建 ref + 流式 computed 追加）──
  const turns = computed<Turn[]>(() => {
    const agentId = activeAgent();
    const base = _turns.value[agentId] || [];

    // 检查是否有流式中的 entry（final 不为 null 表示正在进行中）
    const entries = _agentTurns.value[agentId];
    if (!entries?.length) return base;
    const last = entries[entries.length - 1];
    if (!last.final || last.agent_id !== agentId) return base;

    // 流式 entry：将 turns + final 合成一个 Turn 追加到末尾
    const allMsgs = [...last.turns, last.final];
    if (!allMsgs.some(m => m.thinking || m.content || m.tool_calls?.length)) return base;

    const turn = _agentMsgsToSteps(allMsgs, true, agentId);  // Turn 已含 agent_id+steps+final
    return [...base, turn];
  });

  // ── 内部辅助 ──
  function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

    /** 将 AgentMsg 数组转换为 TurnStep[] + final ChatMessage */
  function _agentMsgsToSteps(msgs: AgentMsg[], streaming: boolean, agentId: string): Turn {
    const steps: TurnStep[] = msgs.map((t, i) => {
      const ts = t.ts || Date.now();
      const asst: ChatMessage = {
        id: `step-${ts}-${i}`, role: 'agent', content: t.content || '',
        label: t.label || '', thinking: t.thinking, reasoning_content: t.thinking,
        toolCalls: (t.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) as any,
        isStreaming: streaming && i === msgs.length - 1, timestamp: ts,
      };
      const tools: ChatMessage[] = (t.tool_calls || []).map((tc: any) => ({
        id: `tool-${tc.id}`, role: "tool", content: tc.result || "",
        name: tc.name, toolName: tc.name, tool_call_id: tc.id, label: tc.label || tc.name || "",
        isStreaming: !tc.result, status: tc.result ? undefined : "running", timestamp: ts,
      } as ChatMessage));
      return { assistant: asst, tools, isStreaming: streaming && i === msgs.length - 1 };
    });
    const last = msgs[msgs.length - 1];
    const final: ChatMessage = {
      id: `final-${last.ts || Date.now()}`, role: 'agent',
      content: last.content || '',
      reasoning_content: '', thinking: '',
      isStreaming: false, timestamp: last.ts || Date.now(),
    };
    return { agent_id: agentId, steps, final };
  }

  function newAssistant(agentId: string): ChatMessage {
    return { id: uid('asst'), role: 'agent', content: '', isStreaming: true, timestamp: Date.now(), agent_id: agentId };
  }

  function _addToolToAgentTurn(agentId: string, callId: string, name: string, args: any) {
    const et = _agentTurns.value[agentId];
    if (et?.length && et[et.length - 1].final) {
      const f = et[et.length - 1].final!;
      f.tool_calls = f.tool_calls || [];
      if (!f.tool_calls.find((tc: any) => tc.id === callId)) {
        f.tool_calls.push({ id: callId, name, arguments: args, result: '', label: '' });
      }
    }
  }

  function _buildAgentTurnsForHistory(agentId: string, msgs: ChatMessage[]) {
    const entries: AgentTurnEntry[] = [];
    const allTurns: Turn[] = [];
    let cur: AgentTurnEntry | null = null;
    for (const msg of msgs) {
      if (msg.role === "agent") {
        const senderId = msg.agent_id || agentId;
        if (!cur || cur.agent_id !== senderId) {
          if (cur?.turns.length) { entries.push(cur); allTurns.push(_agentMsgsToSteps([...cur.turns], false, cur.agent_id)); }
          cur = { agent_id: senderId, turns: [], final: null };
        }
        cur.turns.push({
          thinking: msg.reasoning_content || msg.thinking || '',
          label: (msg as any).label || '',
          tool_calls: (msg.toolCalls || []).map((tc: any) => ({ id: tc.id, name: tc.name || tc.function?.name || '', arguments: tc.arguments || tc.function?.arguments || '', result: '', label: tc.label || tc.name || '' })),
          content: msg.content || '',
          ts: msg.timestamp || Date.now(),
        });
      }
      if (msg.role === "tool" && cur?.turns.length) {
        const last = cur.turns[cur.turns.length - 1];
        const tc = last.tool_calls.find((t: any) => t.id === msg.tool_call_id);
        if (tc) { tc.result = msg.content || ""; tc.label = msg.label || msg.name || tc.name; }
      }
    }
    if (cur?.turns.length) { entries.push(cur); allTurns.push(_agentMsgsToSteps([...cur.turns], false, cur.agent_id)); }
    if (entries.length) _agentTurns.value = { ..._agentTurns.value, [agentId]: entries };
    if (allTurns.length) _turns.value = { ..._turns.value, [agentId]: allTurns };
  }


  /** 向 _turns 中追加一个纯文本 Turn，用于 sendMessage/regenerate/trigger 等场景 */
  function _pushTurn(session: string, agentId: string, msg: ChatMessage) {
    const turn: Turn = { agent_id: agentId, steps: [], final: msg };
    const existing = _turns.value[session] || [];
    _turns.value = { ..._turns.value, [session]: [...existing, turn] };
  }

function lastStreaming(msgs: ChatMessage[], role?: 'agent' | 'tool'): ChatMessage | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.isStreaming && (!role || m.role === role)) return m;
    }
    return null;
  }

  function markActive() {
    if (pendingDoneTimer) { clearTimeout(pendingDoneTimer); pendingDoneTimer = null; }
    turnInProgress.value = true;
  }

  function scheduleDone(msgs: ChatMessage[]) {
    if (pendingDoneTimer) clearTimeout(pendingDoneTimer);
    pendingDoneTimer = setTimeout(() => {
      pendingDoneTimer = null;
      if (!lastStreaming(msgs, 'agent')) turnInProgress.value = false;
    }, TURN_DONE_DELAY);
  }

  function closeAllStreaming(msgs: ChatMessage[]) {
    for (const m of msgs) { if (m.isStreaming) m.isStreaming = false; }
  }

  // ── Agent 事件委托 ──
  function activeAgent() { return useAgentStore().activeAgentId; }

  function isForActiveAgent(data: any): boolean {
    if (!activeAgent()) return true;
    const eventAgent = data?.agentId || data?.agent;
    if (!eventAgent) return true;
    return eventAgent === activeAgent();
  }

  // ── Actions ──

  function sendMessage(content: string, to?: string, options?: {
    deepThink?: boolean; files?: import('../types').FileAttachment[];
  }) {
    const target = to ?? activeAgent();
    if (!target || (!content.trim() && !options?.files?.length)) return;
    const userMsg: ChatMessage = { id: uid('user'), role: 'agent', content, timestamp: Date.now(), files: options?.files, agent_id: 'user' };
    getMsgs(target).push(userMsg);
    _pushTurn(target, 'user', userMsg);
    useAgentStore().bumpAgent('user', content);
    markActive();
    useWebSocketStore().send('chat.send', { to: target, content, deepThink: options?.deepThink ?? true, files: options?.files ?? [] });
  }

  /** 内部用：直接发送消息（不添加 user 气泡），用于重新推理 */
  function _sendRaw(target: string, content: string, deepThink: boolean, files: import('../types').FileAttachment[]) {
    markActive();
    useWebSocketStore().send('chat.send', { to: target, content, deepThink, files });
  }

  /** 重新推理：仅删除当前 assistant 回复，保留前面的 user 消息，重新发送 */
  function regenerateMessage(msgId: string) {
    if (turnInProgress.value) return;
    const target = activeAgent();
    if (!target) return;
    const msgs = getMsgs(target);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const oldMsg = msgs[idx];

    // 找到前方最近的 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].agent_id === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;

    const userMsg = msgs[userIdx];

    // 持久化删除旧的 assistant 和 user 消息
    for (const m of [oldMsg, userMsg]) {
      if (m.persistedMsgId && target) {
        useWebSocketStore().send('chat.delete_message', {
          agent: target,
          counterpart: 'user',
          messageId: m.persistedMsgId,
        });
      }
    }

    // 删除旧的 user 和 assistant（含中间 tool）消息
    setMsgs(target, [
      ...msgs.slice(0, userIdx),
      ...msgs.slice(idx + 1),
    ]);

    // 补充一条新的 user 消息气泡
    const newUserMsg: ChatMessage = {
      id: uid('user'),
      role: 'agent',
      content: userMsg.content,
      timestamp: Date.now(),
      files: userMsg.files,
      agent_id: 'user',
    };
    getMsgs(target).push(newUserMsg);
    useAgentStore().bumpAgent('user', userMsg.content);
    _pushTurn(target, 'user', newUserMsg);

    _sendRaw(target, userMsg.content, true, userMsg.files ?? []);
  }

  /** 删除消息：仅删除指定气泡（assistant/user），同时持久化 */
  function deleteMessage(msgId: string) {
    if (turnInProgress.value) return;
    const agentId = activeAgent();
    if (!agentId) return;
    const msgs = getMsgs(agentId);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    const msg = msgs[idx];

    // 持久化删除（如果有 persistedMsgId）
    if (msg.persistedMsgId && agentId) {
      useWebSocketStore().send('chat.delete_message', {
        agent: agentId,
        counterpart: 'user',
        messageId: msg.persistedMsgId,
      });
    }

    setMsgs(agentId, [
      ...msgs.slice(0, idx),
      ...msgs.slice(idx + 1),
    ]);
  }

  /** 修改用户消息：更新内容，删除该消息之后的所有后续消息，重新发送 */
  function editMessage(msgId: string, newContent: string) {
    if (turnInProgress.value) return;
    const target = activeAgent();
    if (!target) return;
    const msgs = getMsgs(target);

    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx === -1) return;

    // 收集需要持久化删除的消息（被编辑的消息本身 + 后续消息）
    const toDelete = msgs.slice(idx)
      .filter(m => m.persistedMsgId)
      .map(m => m.persistedMsgId!);

    // 发送 WS 删除请求
    for (const msgId of toDelete) {
      useWebSocketStore().send('chat.delete_message', {
        agent: target,
        counterpart: 'user',
        messageId: msgId,
      });
    }

    // 更新当前消息内容
    msgs[idx] = { ...msgs[idx], content: newContent };

    // 截断后续消息
    if (idx + 1 < msgs.length) {
      setMsgs(target, msgs.slice(0, idx + 1));
    }

    // 重新发送
    _sendRaw(target, newContent, true, []);
  }

  function loadHistory(from: string, to: string) {
    _historyOffset[to] = 0; hasMoreHistory.value = false; loadingHistory.value = true;
    useWebSocketStore().send('history.request', { from, to, limit: HISTORY_PAGE_SIZE, offset: 0 });
  }

  function loadMoreHistory() {
    if (!activeAgent() || loadingHistory.value || !hasMoreHistory.value) return;
    const target = activeAgent();
    loadingHistory.value = true;
    _historyOffset[target] = (_historyOffset[target] || 0) + HISTORY_PAGE_SIZE;
    useWebSocketStore().send('history.request', { from: 'user', to: target, limit: HISTORY_PAGE_SIZE, offset: _historyOffset[target] });
  }

  function archiveSession() {
    const target = activeAgent();
    if (!target) return;
    useWebSocketStore().send('session.archive', { agent: target, counterpart: 'user' });
  }

  /** 继续生成：触发 Agent 基于当前对话上下文自主推理，无需新用户消息 */
  function continueGeneration() {
    const target = activeAgent();
    if (!target || turnInProgress.value) return;
    markActive();
    useWebSocketStore().send('chat.continue', { to: target });
  }

  // ── 事件处理器（按 turn 生命周期）──
  // 每个处理器接收 agentId 参数，确保流式输出写入正确的 Agent 缓冲
  function onTurnStart(agentId: string) {
    const wasIdle = !turnInProgress.value;
    markActive();
    getMsgs(agentId).push(newAssistant(agentId));
    const entries = _agentTurns.value[agentId] ?? [];
    // agentId 变化 → 新 entry，确保 A→B→A 的顺序正确
    const lastEntry = entries[entries.length - 1];
    if (!lastEntry || lastEntry.agent_id !== agentId) {
      _agentTurns.value = { ..._agentTurns.value, [agentId]: [...entries, { agent_id: agentId, turns: [], final: null }] };
    }
    const curEntry = _agentTurns.value[agentId][_agentTurns.value[agentId].length - 1];
    curEntry.turns = [];  // 清空历史 step，避免流式拼合时重复
    curEntry.final = { thinking: '', tool_calls: [], content: '', ts: Date.now(), label: '' };
  }

  function onTurnEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    const asst = lastStreaming(msgs, 'agent'); if (asst) asst.isStreaming = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'tool' && msgs[i].isStreaming) msgs[i].isStreaming = false;
    }

    // 将完成的 entry 转为 Turn 并增量追加到 _turns
    const entries = _agentTurns.value[agentId];
    if (entries?.length && entries[entries.length - 1].final) {
      const e = entries[entries.length - 1];
      // 给每个 step 分配递增时间戳，避免全部相同导致链标签耗时恒为 0
      e.turns.push({ ...e.final!, ts: Date.now() - (e.turns.length * 1000) });
      e.final = null;
      const snapshot = [...e.turns];
      e.turns = [];
      const turn = _agentMsgsToSteps(snapshot, false, e.agent_id);  // 完整 Turn
      if (e.agent_id === agentId) {
        const existing = _turns.value[agentId] || [];
        const lastTurn = existing[existing.length - 1];
        if (lastTurn && lastTurn.agent_id === agentId) {
          // 同 agent 的增量 turn：合并 steps 并更新 final
          existing[existing.length - 1] = {
            agent_id: agentId,
            steps: [...lastTurn.steps, ...turn.steps],
            final: turn.final,
          };
          _turns.value = { ..._turns.value, [agentId]: existing };
        } else {
          _turns.value = { ..._turns.value, [agentId]: [...existing, turn] };
        }
      }
    }

    if (data.interrupted) onInterrupted(agentId);
    scheduleDone(msgs);
  }

function onThinkingStart(agentId: string, data: any) {
    markActive();
    const msgs = getMsgs(agentId);
    let asst = lastStreaming(msgs, 'agent');
    // 每次新 thinking 阶段 = 新 ReAct 步骤。若当前 assistant 已有思考内容，
    // 说明上一步已完成，创建新 assistant 保留上一步的 thinking。
    if (asst && ((asst.thinking || asst.reasoning_content || '').trim())) {
      asst = newAssistant(agentId);
      msgs.push(asst);
    }
    if (asst && data.label) asst.label = data.label;
  }

  function onThinkingUpdate(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'agent');
    if (asst) { const d = data.delta ?? ''; asst.thinking = (asst.thinking ?? '') + d; asst.reasoning_content = (asst.reasoning_content ?? '') + d; }
    const et = _agentTurns.value[agentId];
    if (et?.length && et[et.length - 1].final) et[et.length - 1].final!.thinking += (data.delta ?? '');
  }

  function onThinkingEnd(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'agent');
    if (asst) {
      if (data.label) asst.label = data.label;
      else asst.label = undefined;
      // 同步 label 到 _agentTurns（刷新后仍可显示思考耗时）
      const et = _agentTurns.value[agentId];
      if (et?.length && et[et.length - 1].final) {
        et[et.length - 1].final!.label = data.label || undefined;
      }
    }
  }

  function onMessageUpdate(agentId: string, data: any) {
    const asst = lastStreaming(getMsgs(agentId), 'agent'); if (asst) asst.content += data.delta ?? '';
    const et = _agentTurns.value[agentId];
    if (et?.length && et[et.length - 1].final) et[et.length - 1].final!.content += (data.delta ?? '');
  }

  function onMessageEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    const asst = lastStreaming(msgs, 'agent');
    if (!asst) return;
    asst.content = data.content ?? asst.content;
    asst.thinking = data.reasoning ?? asst.thinking;
    asst.reasoning_content = data.reasoning ?? asst.reasoning_content;
    if (data.tool_calls != null) asst.toolCalls = data.tool_calls;
    if (asst.content) useAgentStore().bumpAgent('assistant', asst.content);
    const et = _agentTurns.value[agentId];
    if (et?.length && et[et.length - 1].final) {
      const f = et[et.length - 1].final!;
      f.content = data.content ?? f.content;
      if (data.tool_calls != null) f.tool_calls = data.tool_calls;
    }
  }

function onMessageError(agentId: string, data: any) {
    turnInProgress.value = false;
    const errMsg = data?.content || data?.payload || 'LLM 调用失败';
    getMsgs(agentId).push({
      id: `error-${Date.now()}`, role: 'agent', content: `[ERROR] ${errMsg}`,
      isError: true, isStreaming: false, timestamp: Date.now(),
    });
  }

  function onToolStart(agentId: string, data: any) {
    markActive();
    const msgs = getMsgs(agentId);
    const existing = lastStreaming(msgs, 'tool');
    if (existing && existing.toolName === data.tool_name) {
      existing.id = `tool-${data.tool_call_id}`;
      existing.label = data.label || data.tool_name;
      existing.name = data.tool_name;
      existing.toolName = data.tool_name;
      existing.tool_call_id = data.tool_call_id;
            _addToolToAgentTurn(agentId, data.tool_call_id, data.tool_name, data.arguments);
      // 把 label 同步到 _agentTurns 中的 tool_call（ToolMessage 渲染用）
      const __et = _agentTurns.value[agentId];
      if (__et?.length && __et[__et.length - 1].final) {
        const __tc = __et[__et.length - 1].final!.tool_calls?.find((x: any) => x.id === data.tool_call_id);
        if (__tc) __tc.label = data.label || data.tool_name;
      }
    } else {
      msgs.push({
        id: `tool-${data.tool_call_id}`, role: 'tool', content: '',
        name: data.tool_name, toolName: data.tool_name,
        tool_call_id: data.tool_call_id,
        label: data.label || data.tool_name, isStreaming: true, timestamp: Date.now(),
      });
      _addToolToAgentTurn(agentId, data.tool_call_id, data.tool_name, data.arguments);
      const __et2 = _agentTurns.value[agentId];
      if (__et2?.length && __et2[__et2.length - 1].final) {
        const __tc2 = __et2[__et2.length - 1].final!.tool_calls?.find((x: any) => x.id === data.tool_call_id);
        if (__tc2) __tc2.label = data.label || data.tool_name;
      }
    }
  }

  function onToolcallStart(agentId: string, _data: any) {
    // toolcall 不再创建独立消息，由 onToolStart 统一管理（避免连续工具被拆成多段）
    markActive();
  }

  function onToolEnd(agentId: string, data: any) {
    const msgs = getMsgs(agentId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' && m.toolName && m.isStreaming) { m.content = data.result ?? ''; m.isStreaming = false; break; }
    }
    const et = _agentTurns.value[agentId];
    if (et?.length && et[et.length - 1].final) {
      const tc = et[et.length - 1].final!.tool_calls?.find((x: any) => x.id === data.tool_call_id);
      if (tc) tc.result = data.result ?? '';
    }
  }

  function onToolUpdate(agentId: string, data: any) {
    const existing = lastStreaming(getMsgs(agentId), 'tool');
    if (existing) existing.content += data.delta ?? '';
  }

  function onInterrupted(agentId: string) {
    const msgs = getMsgs(agentId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'agent' && m.isStreaming) {
        m.isStreaming = false;
        if (!m.content?.trim()) m.content = '\u23F8\uFE0F (已被中断)';
      }
    }
    closeAllStreaming(msgs);
    scheduleDone(msgs);
  }

  function onChatEnd(agentId: string) { closeAllStreaming(getMsgs(agentId)); scheduleDone(getMsgs(agentId)); }

  function onAgentListResponse(d: any) {
    useAgentStore().setAgents(d.agents ?? []);
    const restored = useAgentStore().tryRestoreLastAgent();
    if (restored) {
      setMsgs(restored, []);
      hasMoreHistory.value = false;
      loadHistory('user', restored);
      const agent = useAgentStore().agents.find(a => a.id === restored);
      if (agent?.hasActiveSession) {
        useWebSocketStore().send('chat.subscribe', { to: restored });
      }
    }
  }

  function onSessionResume(d: any) {
    if (!d.active) return;
    if (d.agentId !== activeAgent()) return;
    turnInProgress.value = true;
    loadingHistory.value = false;
    const msgs = getMsgs(d.agentId);
    const asst = newAssistant(d.agentId);
    asst.thinking = d.thinking || undefined;
    asst.reasoning_content = d.thinking || undefined;
    asst.content = d.content || '';
    asst.label = d.label || undefined;
    msgs.push(asst);
    const et = _agentTurns.value[d.agentId] ?? [];
    _agentTurns.value = { ..._agentTurns.value, [d.agentId]: [...et, { agent_id: d.agentId, turns: [], final: { thinking: d.thinking || '', tool_calls: [], content: d.content || '', label: d.label || '' } }] };
    if (d.phase === 'tool' && d.toolCallId) {
      msgs.push({
        id: `tool-${d.toolCallId}`,
        role: 'tool', content: '',
        name: d.toolName, toolName: d.toolName,
        label: d.label || d.toolName,
        isStreaming: true, timestamp: Date.now(),
      });
    }
    logger.info(`[ChatStore] 已恢复 ${d.agentId} 的活跃会话（phase=${d.phase}, content=${d.content.length}chars）`);
  }

function onHistory(data: any) {
    loadingHistory.value = false;
    // 使用响应中的 agentId（而非 activeAgent()），防止快速切换时写错缓冲区
    const target = data.agentId || activeAgent();
    const msgs = (data.messages ?? []).map((m: any): ChatMessage => ({
      id: m.message_id ?? uid('hist'),
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      agent_id: m.agent_id, toolCalls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name, toolName: m.name, label: m.label,
      thinking: m.reasoning_content, reasoning_content: m.reasoning_content,
      persistedMsgId: m.message_id,
      timestamp: new Date(m.timestamp ?? Date.now()).getTime(),
    }));
    hasMoreHistory.value = msgs.filter((m: any) => m.agent_id === 'user').length >= HISTORY_PAGE_SIZE;
    const offset = _historyOffset[target] || 0;
    setMsgs(target, offset === 0 ? msgs : [...msgs, ...getMsgs(target)]);
    _buildAgentTurnsForHistory(target, getMsgs(target));
  }

  function onSessionArchived(data: any) {
    if (!data.success) {
      logger.error('[ChatStore] 会话归档失败:', data.error);
      return;
    }
    logger.info('[ChatStore] 会话已归档，清空消息并重新加载');
    if (activeAgent()) {
      setMsgs(activeAgent(), []);
    }
    hasMoreHistory.value = false;
    if (activeAgent()) {
      loadHistory('user', activeAgent()!);
    }
  }

  // ── WS 事件分发表 ──
  // 流式事件（chat.message/tool/thinking）提取 eventAgentId，始终写入正确 Agent 的缓冲
  // UI 事件（turn.start/end 等）保留 isForActiveAgent 防止全局指示器异常
  function eventAgentId(d: any): string { return d?.agentId || d?.agent || ''; }

  const HANDLERS: Record<string, (d: any) => void> = {
    'agent.list.response': onAgentListResponse,
    'agent.profile.updated': () => { useAgentStore().requestAgents(); },
    'chat.start':           d => {
      if (d.hint && typeof d.hint === 'string' && d.hint.startsWith('<trigger>')) {
        if (isForActiveAgent(d)) {
          const trigMsg: ChatMessage = {
            id: uid('trigger'),
            role: 'trigger',
            content: d.hint,
            agent_id: d.sender || 'system',
            timestamp: Date.now(),
          };
          getMsgs(activeAgent()).push(trigMsg);
          _pushTurn(activeAgent(), d.sender || 'system', trigMsg);
        }
      }
    },
    // UI 信号：仅活跃 Agent 更新全局指示器
    'chat.turn.start':      d => { if (isForActiveAgent(d)) onTurnStart(eventAgentId(d)); },
    'chat.turn.end':        d => { if (isForActiveAgent(d)) onTurnEnd(eventAgentId(d), d); },
    'chat.interrupted':     d => { if (isForActiveAgent(d)) onInterrupted(eventAgentId(d)); },
    'chat.end':             d => { if (isForActiveAgent(d)) onChatEnd(eventAgentId(d)); },
    // 流式内容：始终写入目标 Agent 缓冲，不受 isForActiveAgent 限制
    'chat.message.start':   () => {},
    'chat.message.update':  d => onMessageUpdate(eventAgentId(d), d),
    'chat.message.end':     d => onMessageEnd(eventAgentId(d), d),
    'chat.message.error':   d => { if (isForActiveAgent(d)) onMessageError(eventAgentId(d), d); },
    'chat.thinking.start':  d => onThinkingStart(eventAgentId(d), d),
    'chat.thinking.update': d => onThinkingUpdate(eventAgentId(d), d),
    'chat.thinking.end':    d => onThinkingEnd(eventAgentId(d), d),
    'chat.toolcall.start':  d => { if (isForActiveAgent(d)) onToolcallStart(eventAgentId(d), d); },
    'chat.toolcall.update': d => { if (isForActiveAgent(d)) markActive(); },
    'chat.toolcall.end':    d => { if (isForActiveAgent(d)) markActive(); },
    'chat.tool_execution.start':  d => onToolStart(eventAgentId(d), d),
    'chat.tool_execution.update': d => onToolUpdate(eventAgentId(d), d),
    'chat.tool_execution.end':    d => onToolEnd(eventAgentId(d), d),
    'chat.session.resume':  onSessionResume,
    'history.response':     onHistory,
    'session.archived':     onSessionArchived,
    // 虚拟 Agent 收到消息 → 实时推送到对应 Agent 对话中
    'chat.virtual.receive': d => {
      const agentId = d?.agent;
      if (!agentId) return;
      getMsgs(agentId).push({
        id: uid('virt'),
        role: 'agent',
        content: d?.payload ?? '',
        agent_id: agentId,
        label: d?.label,
        timestamp: Date.now(),
      });
      // 非当前活跃 Agent → 标记小红点 + 置顶重排
      if (agentId !== activeAgent()) {
        _unreadAgents.value.add(agentId);
        persistUnread();
        useAgentStore().bumpAgentById(agentId, 'assistant', d?.payload ?? '');
      }
    },
    'agent.system_prompt.response': onSystemPromptResponse,
    'agent.tool_defs.response': onToolDefsResponse,
  };

  // ── System Prompt 预览 ──
  function requestSystemPrompt(agentId?: string) {
    const target = agentId ?? activeAgent();
    if (!target) return;
    systemPromptLoading.value = true;
    systemPromptContent.value = '';
    systemPromptError.value = '';
    useWebSocketStore().send('agent.system_prompt', { agentId: target });
  }

  function onSystemPromptResponse(data: any) {
    systemPromptLoading.value = false;
    if (data.success) {
      systemPromptContent.value = data.systemPrompt ?? '';
    } else {
      systemPromptError.value = data.error ?? '获取 System Prompt 失败';
    }
  }

  function clearSystemPrompt() {
    systemPromptContent.value = '';
    systemPromptError.value = '';
  }

  // ── 工具定义预览 ──
  function requestToolDefs(agentId?: string) {
    const target = agentId ?? activeAgent();
    if (!target) return;
    toolDefsLoading.value = true;
    toolDefs.value = [];
    toolDefsError.value = '';
    useWebSocketStore().send('agent.tool_defs', { agentId: target });
  }

  function onToolDefsResponse(data: any) {
    toolDefsLoading.value = false;
    if (data.success) {
      toolDefs.value = data.toolDefs ?? [];
    } else {
      toolDefsError.value = data.error ?? '获取工具定义失败';
    }
  }

  function clearToolDefs() {
    toolDefs.value = [];
    toolDefsError.value = '';
  }

  // ── Init ──
  const ws = useWebSocketStore();
  ws.init();
  ws.onMessage((type, data) => HANDLERS[type]?.(data));
  ws.onConnect(() => {
    useAgentStore().requestAgents();
  });

  // 切换 Agent 时自动清除未读标记
  watch(activeAgent, (newId) => {
    if (newId && _unreadAgents.value.delete(newId)) {
      persistUnread();
    }
  });

  return {
    messages, loadingHistory, hasMoreHistory, turnInProgress, currentMessages, turns,
    sendMessage, loadHistory, loadMoreHistory, archiveSession,
    regenerateMessage, deleteMessage, editMessage, continueGeneration,
    systemPromptLoading, systemPromptContent, systemPromptError,
    requestSystemPrompt, clearSystemPrompt,
    toolDefsLoading, toolDefs, toolDefsError,
    requestToolDefs, clearToolDefs,
    copyFeedback,
    /** 有未读消息的 Agent ID Set（供侧边栏小红点） */
    unreadAgents: computed(() => _unreadAgents.value),
    /** 清除指定 Agent 的未读标记 */
    clearUnread: (agentId: string) => { _unreadAgents.value.delete(agentId); },
  };
});

