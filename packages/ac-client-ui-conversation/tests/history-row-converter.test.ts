// ============================================================
// history-row-converter.test.ts —— P3-3 转换器并轨（cr-1283）
//
// 验证目标（§四 P3-3）：转换器单源；pair / group / single 三视角刷新
// 渲染与并轨前快照一致。三面：
//   1. 单源等价：同一投影行三视角（除视角参数外）恒同一 ChatMessage；
//   2. 键族全量透传：并轨前 pair 丢 stepId/runId/seq/anchor/persistedMsgId、
//      group 丢 aborted/apiMs/toolName——单源后零丢失（键控收敛打通只读视角）；
//   3. 快照一致：群视角字段面与并轨前 groupMessageToChatMessage 输出一致；
//      直播行按键控吸收（stepId 配对）在 pair 路径可用。
// ============================================================
import { describe, it, expect } from 'vitest';
import { historyRowToChatMessage, buildTurns, mergeHistoryPage } from 'ac-client-ui-conversation/client/feed.ts';
import { toHistoryMessages, fetchPairHistory, fetchGroupHistory } from 'ac-client-ui-conversation/client/historyApi.ts';

describe('P3-3 单源等价：同一投影行三视角恒同一 ChatMessage', () => {
  it('single/direct 与 pair 视角输出逐项相等（idPrefix/fallback 仅在键缺席时生效）', () => {
    const row = {
      role: 'agent', content: '答', agent_id: 'a', message_id: 'm1',
      timestamp: '2026-01-01T00:00:00Z', reasoning_content: '想',
      tool_calls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
    };
    const single = historyRowToChatMessage(row);
    const pair = historyRowToChatMessage(row, { idPrefix: 'pair', fallbackAgentId: 'a' });
    expect(pair).toEqual(single);
  });

  it('群视角锚恒为行 id（群读位键）；渲染 id 不复用行锚（同 record 展开行共锚——须各行唯一）', () => {
    const cm = historyRowToChatMessage(
      { role: 'agent', content: '群答', agent_id: 'a', name: 'a', id: 'g-key', timestamp: '2026-01-01T00:00:00Z' },
      { idPrefix: 'grp' },
    );
    expect(cm.persistedMsgId).toBe('g-key');
    expect(cm.id).toMatch(/^grp-/); // 无 sid/message_id → 前缀随机（不共锚，防 Vue key 碰撞）
  });
});

describe('P3-3 键族全量透传（并轨前 pair 视角丢失面）', () => {
  it('stepId/runId/seq/anchor/persistedMsgId/sid/api 对全量到场', () => {
    const cm = historyRowToChatMessage({
      role: 'agent', content: '', agent_id: 'a', message_id: 'm2', sid: 'm2-s0',
      stepId: 'run1:0', runId: 'run1', seq: 5, anchor: 'm1',
      apiMs: 100, apiCompletion: 20, runMs: 5000, textBeforeTools: true, aborted: true,
      tool_calls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
      timestamp: '2026-01-01T00:00:01Z',
    }, { idPrefix: 'pair', fallbackAgentId: 'a' });
    expect(cm.stepId).toBe('run1:0');
    expect(cm.runId).toBe('run1');
    expect(cm.seq).toBe(5);
    expect(cm.anchor).toBe('m1');
    expect(cm.persistedMsgId).toBe('m2');
    expect(cm.id).toBe('m2-s0'); // sid 优先（多步轮步行 Vue key 唯一）
    expect(cm.apiMs).toBe(100);
    expect(cm.apiCompletion).toBe(20);
    expect(cm.runMs).toBe(5000);
    expect(cm.textBeforeTools).toBe(true);
    expect(cm.aborted).toBe(true);
  });

  it('注入面透传：source/contextContent/payload/injectBytes（问答卡 outcome 判据链——pair 路径不丢）', () => {
    const cm = historyRowToChatMessage({
      role: 'event', content: '已收到用户回答', agent_id: 'a', message_id: 'ctx-1',
      timestamp: '2026-01-01T00:00:02Z',
      source: { kind: 'skill' }, contextContent: '<system-reminder>体</system-reminder>',
      payload: { outcome: 'answered', answers: ['A'] }, injectBytes: 42,
    }, { idPrefix: 'pair', fallbackAgentId: 'a' });
    expect(cm.source?.kind).toBe('skill');
    expect(cm.contextContent).toBe('<system-reminder>体</system-reminder>');
    expect(cm.payload).toMatchObject({ outcome: 'answered', answers: ['A'] });
    expect(cm.injectBytes).toBe(42);
  });
});

describe('P3-3 三视角刷新渲染同构', () => {
  // 同一份账本记录（带步、键族、注入行）——三视角各自的完整装载链
  const records = [
    { role: 'user', content: '问', agent_id: 'user', message_id: 'u1', timestamp: '2026-01-01T00:00:01Z', seq: 1 },
    {
      role: 'agent', content: '', message_id: 'm1', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a', run: 'run1', seq: 2,
      steps: [{
        content: '答', stepId: 'run1:0', reasoning: '想', textBeforeTools: true,
        toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
      }],
    },
    { role: 'context', content: '<system-reminder>技能正文</system-reminder>', source: 'skill', label: '已加载技能 demo', agent_id: 'a', message_id: 'ctx-1', timestamp: '2026-01-01T00:00:03Z', seq: 3, anchor: 'm1', payload: { questions: [{ question: '选?' }] } },
  ];

  it('single/direct 与 pair 只读视角：ChatMessage 逐项相等 + buildTurns 轮结构同构', async () => {
    // direct/single 路径：toHistoryMessages → historyRowToChatMessage
    const directRows = toHistoryMessages(records as never, 'a~user')
      .map(r => historyRowToChatMessage(r));
    // pair 只读路径：fetchPairHistory（同一投影）→ 同一转换器
    const rpc = {
      call: async () => ({ records }),
    };
    const { messages } = await fetchPairHistory('a', 'b', 50, 0, rpc as never);
    const pairRows = messages.map(m => historyRowToChatMessage(m as never, { idPrefix: 'pair', fallbackAgentId: 'a' }));
    expect(pairRows).toEqual(directRows); // 同行同消息（并轨前 pair 恒丢键族 → 不等）
    // 轮结构（含注入卡锚挂靠）同构——三路径刷新渲染恒同
    expect(buildTurns(pairRows)).toEqual(buildTurns(directRows));
    const owner = buildTurns(pairRows).find(t => t.agent_id === 'a');
    expect(owner?.injects?.[0].label).toBe('已加载技能 demo'); // 注入卡锚挂靠（anchor=m1 在场）
  });

  it('群视角：字段面与并轨前 groupMessageToChatMessage 快照一致（D11 形态）+ 键控收敛透传', async () => {
    const rpc = {
      call: async () => ({
        messages: [{
          id: 'g-key', from: 'a', content: '群答', at: 1767225600000, reasoning: '想想',
          steps: [{
            content: '', reasoning: '想想', reasoningMs: 63000, aborted: true,
            elapsedMs: 100, usage: { prompt: 10, completion: 20 },
            toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }],
          }],
        }],
      }),
    };
    const { messages } = await fetchGroupHistory('g1', 0, 50, rpc as never);
    const cms = messages.map(m => historyRowToChatMessage(m as never, { idPrefix: 'grp' }));
    const step = cms[0];
    // 并轨前 groupMessageToChatMessage 快照面（D11：reasoning/label/timestamp/锚）
    expect(step).toMatchObject({
      role: 'agent', content: '', agent_id: 'a', name: 'a', toolName: 'a',
      reasoning_content: '想想', label: '已思考 · 1m3s · 已中断',
      persistedMsgId: 'g-key', timestamp: 1767225600000,
    });
    // 键控收敛透传（并轨新增面——投影扩字段后这些键自然到场）
    expect(step.aborted).toBe(true); // 中断态渲染依据
    expect(step.apiMs).toBe(100); // 链头速率数据源
    expect(step.apiCompletion).toBe(20);
    // tool 行：tool_call_id 配对 + label 归工具
    const tool = cms[1];
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 't1', name: 'bash', toolName: 'bash', persistedMsgId: 'g-key' });
  });
});

describe('P3-3 键族到场即去重生效（pair 路径回归——并轨前行无锚不去重）', () => {
  it('历史行重投递按 persistedMsgId+id 双键去重（mergeHistoryPage）', () => {
    const histRows = toHistoryMessages([{
      role: 'agent', content: '', message_id: 'm1', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a', run: 'run1',
      steps: [{ content: '终', stepId: 'run1:0', reasoning: 'r', toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }] }],
    }], 'a~user').map(r => historyRowToChatMessage(r, { idPrefix: 'pair', fallbackAgentId: 'a' }));
    // 同页重投（双投/竞态）：并轨前 pair 行 persistedMsgId 恒缺 → 双键判失
    // 效、逐行重复上屏；并轨后锚到场 → 去重生效
    const { merged } = mergeHistoryPage(histRows, histRows, false);
    expect(merged.length).toBe(histRows.length);
    expect(histRows.every(m => m.persistedMsgId !== undefined)).toBe(true);
  });
});
