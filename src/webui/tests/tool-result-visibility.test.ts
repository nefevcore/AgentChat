// ============================================================
// tool-result-visibility.test.ts —— 工具结果可见性回归
//
// 背景 bug（2026-09-03 反馈：流式过程中看不到 read/write/edit/
// grep/glob 的结果，进入下一 step 后仍看不到）：
//   · useToolResult.parseToolResult 只认旧 preview 形 {status,...}——
//     src 工具两形（live = 裸 output JSON / 历史 = {ok,output} 信封 JSON）
//     解析恒 null → 专用卡片只拿参数预览：read 正文空、write 链接空、
//     edit diff 空、错误不可见；
//   · 失败路径 stringifyToolResult 产出 "Error: …" 纯文本 → 同样解析
//     不可见；
//   · ToolMessage 自动展开 watch 无 immediate——流式卡挂载即 running，
//     watch 永不触发 → 卡片全程折叠（组件层行为，此处锁定数据层契约）。
//
// 本文件锁定数据层契约：两形 + 失败形 + 原始值 output 的归一化。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

vi.mock('../src/api/wire', () => ({
  wireRpc: { call: vi.fn().mockRejectedValue(new Error('no rpc in test')), onWireEvent: vi.fn(() => () => {}), onWireOpen: vi.fn(() => () => {}), onWireClose: vi.fn(() => () => {}), onWireAck: vi.fn(() => {}) },
}));

vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 视图注册表引入 .vue 组件（vitest node 环境无 vue 插件）——本测试只锁
// 数据归一化，组件解析置空
vi.mock('../src/core/registry/toolResultViews', () => ({
  resolveToolResultView: () => null,
}));

import { setActivePinia, createPinia } from 'pinia';
import { useToolResult } from '../src/composables/useToolResult';
import { stringifyToolResult } from '../src/api/chat-ops';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';
import { directDialog } from '../src/utils/feed';

/** 与 ToolMessage.vue 同款消费：parsed 优先，退化参数预览 */
function viewOf(content: string, toolName?: string) {
  const { parsed } = useToolResult(ref(content), ref(toolName));
  const p = parsed.value;
  if (p) return { via: 'parsed' as const, status: p.status, message: p.message, data: (p.data ?? {}) as Record<string, unknown> };
  return { via: 'preview' as const, status: 'unparsed' as const, message: undefined, data: {} as Record<string, unknown> };
}

const readOutput = { path: 'a.ts', content: '1:hello\n2:world', size: 12, total_lines: 2 };
const grepOutput = { total: 2, shown: 2, groups: [{ path: 'a.ts', matches: [{ line: 1, preview: 'hello' }] }] };

describe('parseToolResult 三形归一（src 工具结果 → 卡片数据）', () => {
  it('live 形（裸 output JSON）：success + data = output', () => {
    const v = viewOf(JSON.stringify(readOutput), 'read');
    expect(v.via).toBe('parsed');
    expect(v.status).toBe('success');
    expect(v.data.content).toBe('1:hello\n2:world'); // ToolResultCode 正文
    expect(v.data.path).toBe('a.ts');
  });

  it('历史回放形（{ok, output} 信封）：success + data = output', () => {
    const v = viewOf(JSON.stringify({ ok: true, output: readOutput }), 'read');
    expect(v.via).toBe('parsed');
    expect(v.status).toBe('success');
    expect(v.data.content).toBe('1:hello\n2:world');
  });

  it('失败形（{ok:false, error}）：error + message 可见', () => {
    const v = viewOf(JSON.stringify({ ok: false, error: '路径越界（沙箱限制）' }), 'read');
    expect(v.via).toBe('parsed');
    expect(v.status).toBe('error');
    expect(v.message).toBe('路径越界（沙箱限制）');
  });

  it('旧 preview 形（{status,...}）兼容不变', () => {
    const v = viewOf(JSON.stringify({ status: 'warning', message: '注意' }), 'bash');
    expect(v.status).toBe('warning');
    expect(v.message).toBe('注意');
  });

  it('原始值 output（字符串/数字）包 output 键；数组/流式半截 JSON 不解析', () => {
    expect(viewOf(JSON.stringify({ ok: true, output: '纯文本结果' })).data.output).toBe('纯文本结果');
    expect(viewOf(JSON.stringify({ ok: true, output: 42 })).data.output).toBe(42);
    expect(viewOf('{"path":"a.ts","content":"半截').via).toBe('preview'); // 流式短路
    expect(viewOf('').via).toBe('preview');
    expect(viewOf('普通非 JSON 文本').via).toBe('preview');
  });

  it('grep 裸 output 同样进 parsed（未知工具 <pre> 兜底可见）', () => {
    const v = viewOf(JSON.stringify(grepOutput), 'grep');
    expect(v.via).toBe('parsed');
    expect(v.status).toBe('success');
    expect(Array.isArray(v.data.groups)).toBe(true);
  });
});

describe('stringifyToolResult 失败形产出可解析信封', () => {
  it('ok:false / 抛错 → {ok:false,error} JSON（不再 Error: 纯文本）', () => {
    const r1 = stringifyToolResult({ ok: false, error: '路径越界' });
    expect(viewOf(r1).status).toBe('error');
    expect(viewOf(r1).message).toBe('路径越界');

    const r2 = stringifyToolResult({ ok: false, error: 'boom' }, new Error('抛错了'));
    expect(viewOf(r2).status).toBe('error');
    expect(viewOf(r2).message).toBe('抛错了');
  });

  it('成功形保持裸 output（live 直播与历史两形都认）', () => {
    const r = stringifyToolResult({ ok: true, output: readOutput });
    expect(viewOf(r).data.content).toBe('1:hello\n2:world');
  });
});

describe('流式全链路（帧序列 → 派生 turns → 卡片数据）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = 'alpha';
  });

  it('下一 step 流式中，上一 step 的 read 结果在派生层可用', () => {
    const A = 'alpha';
    const conv = `${A}~user`;
    const TC = 'call_read_001';
    const delta = (chunk: Record<string, unknown>) => [{ model: 'm' }, chunk, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];
    const META = [undefined, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];

    const feed = useFeedStore();
    const id = directDialog(A);

    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: conv, source: 'user' }]);
    feed.ingestFrame('loop/step-started', [A, 0, [], { conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('llm/delta', delta({ reasoning: '先读文件' }));
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, id: TC, name: 'read' }] }));
    feed.ingestFrame('llm/delta', delta({ toolCalls: [{ index: 0, argumentsDelta: '{"file_path":"a.ts"}' }] }));
    feed.ingestFrame('llm/delta-end', META);
    feed.ingestFrame('tool/after-execute', [
      { toolCallId: TC, name: 'read', agentId: A, conversationId: conv },
      { ok: true, output: readOutput },
      undefined,
    ]);
    feed.ingestFrame('loop/after-step', [A, { text: '', reasoning: '先读文件' }, { conversationId: conv, sender: 'user' }]);

    // 下一 step 已开始（用户反馈场景 #2：此时上一 step 的结果必须可见）
    feed.ingestFrame('loop/step-started', [A, 1, [], { conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('llm/delta', delta({ delta: '文件内容是 hello' }));

    const turns = feed.getTurns(id).value;
    const toolMsg = turns.at(-1)!.steps[0]!.tools.find(t => t.tool_call_id === TC)!;
    expect(toolMsg.content).toBeTruthy();

    const v = viewOf(toolMsg.content, 'read');
    expect(v.via).toBe('parsed');
    expect(v.data.content).toBe('1:hello\n2:world'); // ToolResultCode 正文可得
    expect(toolMsg.isStreaming).toBeFalsy(); // 不再转圈

    feed.ingestFrame('loop/after-step', [A, { text: '文件内容是 hello', reasoning: '' }, { conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '文件内容是 hello' }]);
  });

  it('幻影（id/name 双空聚合残片）：不渲染卡片；空 toolCallId 回执不误伤运行中占位', async () => {
    const A = 'alpha';
    const conv = `${A}~user`;
    const feed = useFeedStore();
    const id = directDialog(A);
    const env = { conversationId: conv, sender: 'user' };

    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', [{ model: 'm' }, { toolCalls: [{ index: 0, id: 'tc_real', name: 'bash', argumentsDelta: '{"command":"ls"}' }] }, { agent: A, conversationId: conv, sender: 'user' }]);
    feed.ingestFrame('llm/delta-end', [undefined, { agent: A, conversationId: conv, sender: 'user' }]);

    // 幻影回执先到（unknown tool 瞬时完成，toolCallId 为空串）
    feed.ingestFrame('tool/after-execute', [{ toolCallId: '', name: '', agentId: A, conversationId: conv }, { ok: false, error: 'unknown tool: ' }, undefined]);
    // 真实工具仍在运行——不被幻影回执关闭/污染
    const row = feed.getRaw(id).find((m) => m.tool_call_id === 'tc_real')!;
    expect(row.isStreaming).toBe(true);
    expect(row.content).toBe('');

    // 历史展开：幻影 toolCalls（旧数据里存在）不产出无名工具卡
    const { toHistoryMessages } = await import('../src/api/runs.ts');
    const rows = toHistoryMessages([
      {
        role: 'agent', agent_id: A, content: '终稿', message_id: 'm1', timestamp: '2026-01-01T00:00:00Z',
        steps: [{
          content: '终稿',
          toolCalls: [
            { id: 'tc_ok', name: 'write', arguments: '{}', result: { ok: true, output: { path: 'a.md' } } },
            { id: '', name: '', arguments: '', result: null },
          ],
        }],
      } as never,
    ], A);
    const toolRows = rows.filter((r) => r.role === 'tool');
    expect(toolRows).toHaveLength(1);
    expect((toolRows[0] as Record<string, unknown>).tool_call_id).toBe('tc_ok');

    // buildTurns：assistant.toolCalls 携带幻影条目时不产生工具卡
    const { buildTurns } = await import('../src/utils/feed.ts');
    const turns = buildTurns([
      {
        id: 'a1', role: 'agent', content: '', timestamp: 1,
        toolCalls: [
          { id: 'tc_ok', name: 'write', arguments: {}, result: 'ok' },
          { id: '', name: '', arguments: {}, result: '' },
        ] as never,
      },
    ]);
    const tools = turns[0]?.steps[0]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_call_id).toBe('tc_ok');
  });

  it('同名并行调用（同一步多个相同工具）：各自成卡、各自收结果——无永久转圈', () => {
    const A = 'alpha';
    const conv = `${A}~user`;
    const feed = useFeedStore();
    const id = directDialog(A);
    const env = { conversationId: conv, sender: 'user' };
    const dlt = (chunk: Record<string, unknown>) => [{ model: 'm' }, chunk, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];
    const META = [undefined, { agent: A, conversationId: conv, sender: 'user' }] as unknown[];

    // 同一步并行发两个同名调用（如 adt_create_destination × 2——2026-09-04
    // 反馈：只有最后一个显示 OK）
    feed.ingestFrame('loop/step-started', [A, 0, [], env]);
    feed.ingestFrame('llm/delta', dlt({ toolCalls: [{ index: 0, id: 'tc_same_1', name: 'create_dest', argumentsDelta: '{"name":"dev"}' }] }));
    feed.ingestFrame('llm/delta', dlt({ toolCalls: [{ index: 1, id: 'tc_same_2', name: 'create_dest', argumentsDelta: '{"name":"test"}' }] }));
    feed.ingestFrame('llm/delta-end', META);

    // 两条独立占位（此前：第二个调用按名字"接管"第一条的占位行 →
    // 第一个调用的结果再无落点 → 永久转圈）
    const rows = feed.getRaw(id).filter((m) => m.role === 'tool');
    expect(rows.map((r) => r.tool_call_id).sort()).toEqual(['tc_same_1', 'tc_same_2']);

    feed.ingestFrame('loop/after-step', [A, { text: '', reasoning: '' }, env]);
    // 结果乱序到达（并行执行）——各自按 id 归属
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_same_2', agentId: A, conversationId: conv }, { ok: true, output: { destination: 'test', ok: true } }, undefined]);
    feed.ingestFrame('tool/after-execute', [{ toolCallId: 'tc_same_1', agentId: A, conversationId: conv }, { ok: true, output: { destination: 'dev', ok: true } }, undefined]);
    feed.ingestFrame('loop/after-run', [{ agent: A, conversationId: conv, sender: 'user' }, { finish: 'stop', text: '两个都建好了' }]);

    const cards = (feed.getTurns(id).value.at(-1)!.steps[0]!.tools)
      .filter((t: any) => ['tc_same_1', 'tc_same_2'].includes(t.tool_call_id));
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c.content, `卡 ${c.tool_call_id} 应有结果`).toBeTruthy();
      expect(c.isStreaming, `卡 ${c.tool_call_id} 不应转圈`).toBeFalsy();
    }
    const contents = cards.map((c: any) => c.content).sort();
    expect(contents[0]).toContain('dev');
    expect(contents[1]).toContain('test');
  });
});
