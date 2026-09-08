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

describe('M27.2 · ac-client-ui-conversation 宿主半边（boot graph 声明〔base〕）', () => {
  it('行装载 → boot graph 含 ui-conversation 条目（phase=base，entry 为绝对路径）', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const fiber = await loadRow(ctx);
    const graph = ctx.webui.listBootGraph();
    expect(graph.map((g) => g.name)).toContain('ui-conversation');
    const def = graph.find((g) => g.name === 'ui-conversation')!;
    expect(def.platform).toBe('web');
    expect(def.phase).toBe('base');
    expect(def.entry).toMatch(/ac-client-ui-conversation[\\/]client[\\/]index\.ts$/);
    await fiber.dispose();
  });

  it('可摘除性（D19）：行卸载 → 声明级联回收 → boot graph 收缩 + 变更帧', async () => {
    const ctx = new Context();
    const { WebUiService } = await import('ac-webui/src/service.ts');
    new WebUiService(ctx);
    const changed: string[] = [];
    const off = ctx.on('webui/boot-graph-changed', (name) => changed.push(name));
    const fiber = await loadRow(ctx);
    expect(ctx.webui.listBootGraph().map((g) => g.name)).toContain('ui-conversation');
    await fiber.dispose();
    expect(ctx.webui.listBootGraph().map((g) => g.name)).not.toContain('ui-conversation');
    expect(changed.filter((n) => n === 'ui-conversation').length).toBeGreaterThanOrEqual(2);
    off();
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
});
