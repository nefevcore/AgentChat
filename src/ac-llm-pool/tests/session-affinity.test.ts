// ============================================================
// ac-llm-pool：会话亲和头（preset 匹配 / 显式口 / 注入行为）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as configRow from 'ac-config';
import * as poolRow from '../src/index.ts';
import { resolveSessionHeader, sessionHeaderValue } from '../src/index.ts';
import type { LlmChatCall } from 'ac-llm';

describe('resolveSessionHeader（纯函数）', () => {
  it('preset：opencode.ai 端点（含子域）匹配 x-opencode-session', () => {
    expect(resolveSessionHeader('https://opencode.ai/v1', undefined)).toBe('x-opencode-session');
    expect(resolveSessionHeader('https://api.opencode.ai/v1', undefined)).toBe('x-opencode-session');
  });
  it('未知端点默认不发（fail-closed）；伪装子域不命中', () => {
    expect(resolveSessionHeader('https://api.deepseek.com', undefined)).toBeUndefined();
    expect(resolveSessionHeader('https://open.bigmodel.cn/api/coding/paas/v4', undefined)).toBeUndefined();
    expect(resolveSessionHeader('https://opencode.ai.evil.example/v1', undefined)).toBeUndefined();
  });
  it('显式 sessionHeader：指定头名 / false 强制关', () => {
    expect(resolveSessionHeader('https://any.example', { name: 'x-my-session' })).toBe('x-my-session');
    expect(resolveSessionHeader('https://opencode.ai/v1', false)).toBeUndefined();
  });
});

describe('sessionHeaderValue（确定性派生）', () => {
  it('同会话稳定、跨会话不同、UUID 形态、无会话回退进程级', () => {
    const a = sessionHeaderValue('conv-1');
    expect(sessionHeaderValue('conv-1')).toBe(a);
    expect(sessionHeaderValue('conv-2')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sessionHeaderValue(undefined)).toMatch(/^[0-9a-f]{8}-/);
  });
});

// ---------- 注入订阅（boot 全链；观察点放 inner——监听器先跑、inner 最后） ----------

const tmps: string[] = [];
const booted: { ctx: Context; fibers: Fiber[] }[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pool-aff-'));
  tmps.push(dir);
  return dir;
}

async function boot(pool: Record<string, unknown>) {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ llmProviders: pool }), 'utf8');
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const specs: Array<[unknown, Record<string, unknown> | undefined]> = [
    [llmRow, undefined],
    [configRow, { root }],
    [poolRow, undefined],
  ];
  for (const [row, options] of specs) {
    const fiber = ctx.plugin(row as any, options);
    await fiber;
    fibers.push(fiber);
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

describe('会话亲和注入订阅', () => {
  const emptyStream = async function* (): AsyncGenerator<never> {};

  it('preset 端点：按 conversationId 注入稳定头；上游显式 headers 不覆盖', async () => {
    const { ctx } = await boot({
      oc: { base_url: 'https://opencode.ai/v1', models: ['gpt-5'] },
    });
    const probes: Array<Record<string, string> | undefined> = [];
    const run = (conversationId: string | undefined, headers?: Record<string, string>) => {
      const call: LlmChatCall = {
        input: {
          provider: 'oc',
          model: 'gpt-5',
          messages: [],
          ...(headers ? { headers } : {}),
          ...(conversationId ? { meta: { conversationId } } : {}),
        },
      };
      return ctx.waterfall('llm/before-chat', call, () => {
        probes.push(call.input.headers);
        return emptyStream();
      });
    };
    await run('conv-9');
    await run('conv-9');
    await run('conv-8');
    await run('conv-9', { 'x-custom': 'keep' });
    expect(probes[0]?.['x-opencode-session']).toBe(sessionHeaderValue('conv-9'));
    expect(probes[1]).toStrictEqual(probes[0]); // 同会话稳定
    expect(probes[2]?.['x-opencode-session']).not.toBe(probes[0]?.['x-opencode-session']);
    expect(probes[3]).toStrictEqual({ 'x-custom': 'keep' }); // 上游显式优先
  });

  it('非 preset 端点：不注入（fail-closed 端到端）', async () => {
    const { ctx } = await boot({
      ds: { base_url: 'https://api.deepseek.com', models: ['deepseek-chat'] },
    });
    const probes: Array<Record<string, string> | undefined> = [];
    const call: LlmChatCall = {
      input: { provider: 'ds', model: 'deepseek-chat', messages: [], meta: { conversationId: 'c1' } },
    };
    await ctx.waterfall('llm/before-chat', call, () => {
      probes.push(call.input.headers);
      return emptyStream();
    });
    expect(probes[0]).toBeUndefined();
  });

  it('池行卸载 → 注入订阅随行回收', async () => {
    const { ctx, fibers } = await boot({
      oc: { base_url: 'https://opencode.ai/v1', models: ['gpt-5'] },
    });
    await fibers[fibers.length - 1].dispose(); // pool 行 fiber
    const probes: Array<Record<string, string> | undefined> = [];
    const call: LlmChatCall = {
      input: { provider: 'oc', model: 'gpt-5', messages: [], meta: { conversationId: 'c' } },
    };
    await ctx.waterfall('llm/before-chat', call, () => {
      probes.push(call.input.headers);
      return emptyStream();
    });
    expect(probes[0]).toBeUndefined();
  });
});