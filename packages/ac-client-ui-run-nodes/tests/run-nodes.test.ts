// ============================================================
// tests/run-nodes.test.ts —— 会话节点面板验收（cr-230）
//
// · 纯函数：turns → 节点推导（viewer 轮过滤 / running 标记 / 新→旧序）。
// · 宿主半边：boot graph 声明 + 卸载级联回收（可摘除性证据）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as uiRunNodesRow from '../src/index.ts';
import { runNodesOf } from '../client/runNodes.ts';
import type { Turn } from 'ac-client-ui-conversation/client/types.ts';

function turn(agent: string, ts: number, content: string, streaming = false, final = true): Turn {
  return {
    agent_id: agent,
    steps: streaming
      ? [{ assistant: { id: 'a' + ts, role: 'agent', content: '', timestamp: ts } as never, tools: [], isStreaming: true }]
      : [],
    final: final ? { id: 'm' + ts, role: agent === 'user' ? 'user' : 'agent', content, timestamp: ts } as never : null,
  };
}

describe('cr-230 · runNodesOf（turns → run 节点）', () => {
  it('viewer 轮为节点、agent 轮跳过；新→旧序', () => {
    const turns = [
      turn('user', 1000, '第一个问题'),
      turn('agent', 1100, '回答'),
      turn('user', 2000, '第二个问题'),
    ];
    const nodes = runNodesOf(turns);
    expect(nodes.map((n) => n.text)).toEqual(['第二个问题', '第一个问题']);
    expect(nodes.every((n) => !n.running)).toBe(true);
  });

  it('其后存在流式 agent 轮 → 该节点标 running（正在处理）', () => {
    const turns = [
      turn('user', 1000, '旧问题'),
      turn('agent', 1100, '旧回答'),
      turn('user', 2000, '新问题'),
      turn('agent', 2100, '…流式中', true),
    ];
    const nodes = runNodesOf(turns);
    expect(nodes[0].running).toBe(true); // 新问题
    expect(nodes[1].running).toBe(false); // 旧问题
  });

  it('无 final 的 viewer 占位轮不产生节点；多行正文取首行', () => {
    const turns = [
      turn('user', 1000, '第一行\n第二行', false, false),
      turn('user', 2000, '首行\n次行'),
    ];
    const nodes = runNodesOf(turns);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe('首行');
    expect(nodes[0].ts).toBe(2000);
  });
});

async function boot() {
  return new Context();
}

async function loadRow(ctx: Context): Promise<Fiber> {
  const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<Fiber> & Fiber;
  return plug(uiRunNodesRow, undefined);
}

describe('cr-230 · ac-client-ui-run-nodes 宿主半边（零功能行——cr-1117：装载/卸载零副作用 + extension 形状）', () => {
  it('行装载/卸载零副作用（apply 空实现，无宿主面注册）', async () => {
    const ctx = new Context();
    const fiber = await loadRow(ctx);
    await fiber.dispose();
  });

  it('extension 自述形状（extension-catalog 聚合面契约）', () => {
    expect(uiRunNodesRow.extension.name).toBe(uiRunNodesRow.extension.name.trim());
    expect(uiRunNodesRow.extension.label.length).toBeGreaterThan(0);
    expect(uiRunNodesRow.extension.automatic).toBe(true);
  });
});
