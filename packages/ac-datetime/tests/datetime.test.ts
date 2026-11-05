// ============================================================
// ac-datetime/tests/datetime.test.ts —— 日期注入
//
// · 日期行格式（仅日期 + 星期，一天内稳定——KV cache 友好）
// · conversationId 缺省（子 Agent / loop 直连）不注入
// · 段注册制（cr-881）：DATETIME 段（SECTION_ORDER 表尾）绝对收尾，
//   与行加载/注册顺序无关；多步 run 恰一条（run 级一次组装）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as personaRow from 'ac-persona';
import * as datetimeRow from '../src/index';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

/** 脚本 provider：单步文本收束，捕获到达 LLM 的完整请求 */
function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

/** 双步脚本 provider：首步工具调用（触发第二步），末步文本收束 */
function twoStepProvider() {
  let step = 0;
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      if (step++ === 0) {
        yield { delta: '', toolCalls: [{ index: 0, id: 't1', name: 'noop', argumentsDelta: '{}' }] };
        yield { delta: '', finish: 'tool_calls' };
      } else {
        yield { delta: 'done' };
        yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
      }
    },
  });
}

async function boot(ctx: Context, rows: unknown[]) {
  const fibers: Fiber[] = [];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return fibers;
}

function standardRows() {
  return [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    },
    agentsRow,
    loopRow,
  ];
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('datetimeLine 纯函数', () => {
  it('仅日期 + 星期（YYYY-MM-DD 周X）', () => {
    expect(datetimeRow.datetimeLine(new Date('2026-08-23T10:00:00'))).toBe(
      '[当前时间] 2026-08-23 周日',
    );
    expect(datetimeRow.datetimeLine(new Date('2026-01-05T23:59:59'))).toBe(
      '[当前时间] 2026-01-05 周一',
    );
  });

  it('一天内稳定（同日任意时刻同输出——前缀缓存跨轮命中）', () => {
    const a = datetimeRow.datetimeLine(new Date('2026-08-23T00:00:00'));
    const b = datetimeRow.datetimeLine(new Date('2026-08-23T23:59:59'));
    expect(a).toBe(b);
  });
});

describe('ac-datetime 日期注入', () => {
  it('有会话键 → 日期行追加到 system 尾部', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), datetimeRow]);
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      conversationId: 'c1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system).toMatch(/^BASE\n\n\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]$/);
  });

  it('conversationId 缺省（子 Agent / loop 直连）→ 不注入', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), datetimeRow]);
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'BASE' });
  });

  it('与 ac-persona 组合：persona 前置、日期行在尾部', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), personaRow, datetimeRow]);
    ctx.agents.register({ id: 'd2', model: 'mock-1', settings: { persona: '海盗' } });
    await ctx.agentLoop.run({
      agent: 'd2',
      model: 'mock-1',
      conversationId: 'c3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system.startsWith('<persona>')).toBe(true);
    expect(system).toContain('[当前时间] ');
  });

  it('DATETIME 段绝对收尾：晚于任意低 order 段（与注册顺序无关）', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), datetimeRow]);
    // 竞争者：GUIDELINES 段（低 order）——晚于 datetime 注册也要排在它前面
    ctx.agentLoop.registerPromptSection({
      name: 'GUIDELINES_FS',
      text: '[指引] REF-LATE',
    }, 'test');
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      conversationId: 'c4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    const posRef = system.indexOf('[指引] REF-LATE');
    const posDate = system.lastIndexOf('[当前时间]');
    expect(posRef).toBeGreaterThan(0);
    expect(posDate).toBeGreaterThan(posRef);
    expect(system).toMatch(/\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]$/);
  });

  it('对话信息段（CONVERSATION）先于日期段（DATETIME）——具名位定序', async () => {
    captured.length = 0;
    const ctx = new Context();
    await boot(ctx, [...standardRows(), datetimeRow]);
    // 晚注册的 CONVERSATION 段（order 900 < 910）仍居日期行之前
    ctx.agentLoop.registerPromptSection({
      name: 'CONVERSATION',
      text: '[当前对话对象] 你正在与 风栗（user）对话',
    }, 'test');
    await ctx.agentLoop.run({
      model: 'mock-1', system: 'BASE', conversationId: 'c6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const system = String(captured[0].messages[0].content);
    expect(system.indexOf('[当前对话对象]')).toBeGreaterThan(0);
    expect(system.indexOf('[当前对话对象]')).toBeLessThan(system.indexOf('[当前时间]'));
  });

  it('多步 run 恰一条日期行：run 级一次组装，不随步重注入', async () => {
    captured.length = 0;
    const ctx = new Context();
    const rows = standardRows();
    rows[2] = {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', twoStepProvider(), { models: ['mock-1'] });
      },
    };
    await boot(ctx, [...rows, datetimeRow]);
    ctx.tools.register({
      name: 'noop',
      description: 'no-op',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, output: { content: 'ok' } };
      },
    });
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: 'BASE',
      conversationId: 'c5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured.length).toBe(2); // 两步
    for (const input of captured) {
      const system = String(input.messages[0].content);
      const occurrences = system.split('[当前时间]').length - 1;
      expect(occurrences).toBe(1);
      expect(system).toMatch(/^BASE\n\n\[当前时间\] \d{4}-\d{2}-\d{2} 周[日一二三四五六]$/);
    }
  });
});