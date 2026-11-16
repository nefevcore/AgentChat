// ============================================================
// ac-client-ui-conversation/tests/conversation-row.test.ts —— 前端行
// 宿主半边验收（M27.2-2 出包之五：boot graph 声明〔base〕+ 卸载级联）
//
// node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。client 半面
//（ctx.sessions 服务 + 席位出厂）见 webui/tests/clients-conversation。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as row from '../src/index.ts';

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(row, undefined);
}

describe('M27.2 · ac-client-ui-conversation 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const ctx = new Context();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(row.extension.name).toBe(row.extension.name.trim());
    expect(row.extension.label.length).toBeGreaterThan(0);
    expect(row.extension.automatic).toBe(true);
  });
});

describe('M27.2 · ac-client-ui-conversation 数据面（历史回放纯函数）', () => {
  it('toHistoryMessages：user 行 → agent 归属；steps 按步展开 + 稳定时间排序', async () => {
    const { toHistoryMessages } = await import('../client/historyApi.ts');
    const rows = toHistoryMessages([
      { role: 'user', content: '你好', message_id: 'm1', timestamp: '2026-01-01T00:00:01Z' },
      {
        role: 'agent', content: '', message_id: 'm2', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a',
        steps: [{ content: '思考中', reasoning: 'r', toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }] }],
      },
    ], 'a~user');
    expect(rows[0]).toMatchObject({ role: 'agent', agent_id: 'user' });
    // 步展开：agent 气泡 + tool 气泡
    expect(rows.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true);
  });

  it('parseToolArgs：JSON 失败降级原串', async () => {
    const { parseToolArgs } = await import('../client/historyApi.ts');
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs('not-json')).toBe('not-json');
    expect(parseToolArgs(undefined)).toEqual({});
  });

  // 思考耗时（2026-09-13 反馈：刷新后思考卡片 label 无耗时）：steps[].reasoningMs
  // 落盘透传 → 历史展开恢复「已思考 · XmYs」；与直播 closeThinking 同款构造
  it('toHistoryMessages：步带 reasoningMs → agent 气泡 label=已思考 · XmYs', async () => {
    const { toHistoryMessages } = await import('../client/historyApi.ts');
    const rows = toHistoryMessages([
      {
        role: 'agent', content: '', message_id: 'm1', timestamp: '2026-01-01T00:00:02Z', agent_id: 'a',
        steps: [
          { content: '', reasoning: '想想', reasoningMs: 75400 },  // 1m15s
          { content: '答', reasoning: '又想', reasoningMs: 400 },  // <1s：不写 label
        ],
      },
    ], 'a~user');
    const agentRows = rows.filter((m) => m.role === 'agent');
    expect(agentRows[0].label).toBe('已思考 · 1m15s');
    expect(agentRows[1].label).toBeUndefined();
  });

  it('expandGroupRecord（fetchGroupHistory 内核）：步带 reasoningMs → 群步气泡 label=已思考', async () => {
    const { fetchGroupHistory } = await import('../client/historyApi.ts');
    const rpc = {
      call: async (_method: string, params: Record<string, unknown>) => ({
        messages: [{
          from: 'a', content: '群答', at: 1,
          steps: [{ content: '', reasoning: '想想', reasoningMs: 63_000 }],
        }],
        ...params,
      }),
    };
    const { messages } = await fetchGroupHistory('g1', 0, 50, rpc as any);
    const stepRow = messages.find((m) => m.role === 'agent');
    expect(stepRow?.label).toBe('已思考 · 1m3s');
  });
});
