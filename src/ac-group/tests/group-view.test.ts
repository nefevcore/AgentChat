// ============================================================
// ac-group 成员流视图（cr-4）：isGroupConversation 判定键 + 契约注入
// （gid~member 成员流 run 也注入契约——handle 解析 gid）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as groupRow from '../src/index';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-group-view-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: '收到' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(root: string) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
    sessionRow,
    groupRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, row === sessionRow ? { root } : row === groupRow ? { root } : undefined);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isGroupConversation（契约注入判定键，cr-4）', () => {
  it('群本体键与成员流键都命中；1v1 对键/无关键不命中', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'gx', name: '群', members: ['a', 'b'] });
    expect(ctx.group.isGroupConversation('gx')).toBe(true);
    expect(ctx.group.isGroupConversation('gx~a')).toBe(true); // 成员流 run
    expect(ctx.group.isGroupConversation('a~b')).toBe(false); // 1v1 对键
    expect(ctx.group.isGroupConversation('a')).toBe(false);
    expect(ctx.group.isGroupConversation('gx~a~b')).toBe(true); // 右起 gid= 首段（成员流键嵌套 ~ 场景理论不达，防御恒 true）
  });

  it('成员流 run 注入群契约（send 首跑：上下文含契约行）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'gx', name: '群', members: ['a', 'b'] });
    const p = ctx.group.send('gx', 'user', '大家好', { settle: true });
    await p;
    expect(captured.length).toBeGreaterThan(0);
    const contents = captured[0].messages.map((x) => String(x.content));
    expect(contents).toContain(groupRow.GROUP_CONTRACT_TEXT);
  });

  it('成员流键的会话桶与 1v1 分离（run 落 g~a 桶而非 g 桶）', async () => {
    const { ctx } = await boot(tmpRoot());
    ctx.group.create({ id: 'gz', name: '群', members: ['a', 'b'] });
    await ctx.group.send('gz', 'user', '大家好', { settle: true });
    // 触发行（hint）不入成员流（GROUP_HINT_META 跳过）；投影行 + run 转录在成员流
    const memberRows = await ctx.session.records('gz~a');
    expect(memberRows.some((r) => r.role === 'agent' && r.content.includes('大家好'))).toBe(true); // 投影行
    expect(memberRows.some((r) => r.content.includes('收到'))).toBe(true); // run 终稿转录
    // hint 触发行不在（防双录）
    expect(memberRows.filter((r) => r.role === 'agent' && r.content.includes('大家好'))).toHaveLength(1);
  });
});