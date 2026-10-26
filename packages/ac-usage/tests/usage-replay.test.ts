// ============================================================
// ac-usage（M15 回读）：boot 回读 usage-*.jsonl 重建聚合 + byDay +
// conversationId 入账
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as usageRow from '../src/index.ts';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-usage-replay-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register(
          'mock',
          () => ({
            stream: async function* (_input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
              yield { delta: '好' };
              yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 3, total: 13 } };
            },
          }),
          { models: ['mock-1'] },
        );
      },
    },
    loopRow,
    usageRow,
  ];
  for (const row of rows) {
    const fiber = row === usageRow ? ctx.plugin(row as any, { root }) : ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).usage) break;
    await new Promise((r) => setTimeout(r, 1));
  }
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

describe('ac-usage 持久聚合回读（M15）', () => {
  it('同 root 二次 boot：jsonl 回读，byAgent/byModel/byDay 聚合恢复；流水含 conversationId', async () => {
    const root = tmpRoot();
    {
      const { ctx } = await boot(root);
      await ctx.agentLoop.run({
        agent: 'a',
        model: 'mock-1',
        conversationId: 'a',
        messages: [{ role: 'user', content: 'q' }],
      });
      expect(ctx.usage.byAgent()['a'].runs).toBe(1);
    }
    // “重启”：全部 dispose 后同 root 再 boot
    for (const { fibers } of booted.splice(0)) {
      for (const fiber of [...fibers].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
    }
    {
      const { ctx } = await boot(root);
      const a = ctx.usage.byAgent()['a'];
      expect(a.runs).toBe(1); // 回读恢复
      expect(a.prompt).toBe(10);
      expect(a.lastContextPrompt).toBe(10);
      const m = ctx.usage.byModel()['mock-1'];
      expect(m.runs).toBe(1);
      const days = ctx.usage.byDay();
      expect(days).toHaveLength(1);
      expect(days[0].runs).toBe(1);
      // 交叉维（日期 × 模型）同样回读恢复
      const dm = ctx.usage.byDayModel();
      expect(dm).toHaveLength(1);
      expect(dm[0]).toMatchObject({ model: 'mock-1', runs: 1, prompt: 10 });
      expect(ctx.usage.totals().runs).toBe(1);

      // 流水行含 conversationId（byPair 维度数据基础）
      const file = path.join(root, 'usage', ctx.usage.auditFiles()[0]);
      const line = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
      expect(line.conversationId).toBe('a');

      // 回读后继续记账：聚合累加不重置
      await ctx.agentLoop.run({
        agent: 'a',
        model: 'mock-1',
        conversationId: 'a',
        messages: [{ role: 'user', content: 'q2' }],
      });
      expect(ctx.usage.byAgent()['a'].runs).toBe(2);
      expect(ctx.usage.byDay()[0].runs).toBe(2);
      expect(ctx.usage.byDayModel()[0].runs).toBe(2);
    }
  });

  it('损坏行宽容跳过（回读不炸、好行照常计入）', async () => {
    const root = tmpRoot();
    const usageDir = path.join(root, 'usage');
    fs.mkdirSync(usageDir, { recursive: true });
    fs.writeFileSync(
      path.join(usageDir, 'usage-2020-01-01.jsonl'),
      '{不是json}\n{"agent":"b","model":"m","usage":{"prompt":1,"completion":1,"promptAccumulated":1,"steps":1}}\n{"broken":true}\n',
      'utf-8',
    );
    const { ctx } = await boot(root);
    expect(ctx.usage.byAgent()['b'].runs).toBe(1); // 好行计入
    expect(ctx.usage.byAgent()['(anonymous)']).toBeUndefined(); // 损坏行未计入
  });
});
