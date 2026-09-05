// ============================================================
// ac-llm-pool：池凭据注入（llm/before-chat → pool:<provider> apiKey）
// ——2026-09-05 自 ac-credentials 迁入（边界评估建议 #4：凭据行不再
// 感知 LLM 域，注入随连接域走）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as configRow from 'ac-config';
import * as credentialsRow from 'ac-credentials';
import * as poolRow from '../src/index.ts';
import { resolveLlmApiKey } from '../src/index.ts';
import type { LlmChatCall } from 'ac-llm';

const tmps: string[] = [];
const booted: { ctx: Context; fibers: Fiber[] }[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pool-cred-'));
  tmps.push(dir);
  return dir;
}

/** boot：llm + config（带一条连接）+ credentials + pool */
async function boot() {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ llmProviders: { glm: { base_url: 'https://a/v1', models: ['glm-5.3'] } } }),
    'utf8',
  );
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const specs: Array<[unknown, Record<string, unknown> | undefined]> = [
    [llmRow, undefined],
    [configRow, { root }],
    [credentialsRow, { file: path.join(root, 'credentials.json') }],
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

describe('resolveLlmApiKey 解析链（P4 收窄：全局 pool:<provider> 单级）', () => {
  it('显式 > 全局 pool:<provider>（provider 字段优先，其次 name@model 左段）> undefined', () => {
    const store = new Map<string, string>();
    const fake = {
      getGlobal: (p: string) => store.get(`__global__|${p}`) ?? '',
    };
    // 全空 → undefined（种子 env 兜底在 provider 构造层）
    expect(resolveLlmApiKey(fake, { model: 'glm-5.3', provider: 'glm' })).toBeUndefined();
    // 全局池引用（pool:<provider>）——provider 显式给定
    store.set('__global__|pool:glm', 'sk-pool');
    expect(resolveLlmApiKey(fake, { model: 'glm-5.3', provider: 'glm' })).toBe('sk-pool');
    // name@model 引用左段（provider 缺省时拆分）
    expect(resolveLlmApiKey(fake, { model: 'deepseek@deepseek-v4-pro' })).toBeUndefined();
    store.set('__global__|pool:deepseek', 'sk-ds');
    expect(resolveLlmApiKey(fake, { model: 'deepseek@deepseek-v4-pro' })).toBe('sk-ds');
    // 裸模型名且无 provider → 无凭据可解析
    expect(resolveLlmApiKey(fake, { model: 'glm-5.3' })).toBeUndefined();
    // 上游已显式指定：不覆盖
    expect(resolveLlmApiKey(fake, { model: 'glm-5.3', provider: 'glm', api_key: 'sk-explicit' })).toBeUndefined();
    // Agent 级 rung 已退役（D3）：agent-level key 不再参与解析
    expect(
      resolveLlmApiKey(fake, { model: 'glm-5.3', provider: 'glm', meta: { agent: 'helper' } } as never),
    ).toBe('sk-pool');
  });
});

describe('before-chat 注入（pool 行订阅；credentials 可选能力）', () => {
  it('有凭据 → 变异载体补 api_key；无凭据/裸模型 → 原样放行', async () => {
    const { ctx } = await boot();
    ctx.credentials.setGlobal('pool:glm', 'sk-live');

    const seen: Array<{ model: string; api_key?: string }> = [];
    // waterfall 语义：监听器先跑（变异载体），inner（默认行为）最后。
    // inner 须返回 AsyncIterable；断言点放 inner 同步段（generator 体不迭代不执行）。
    const emptyStream = async function* (): AsyncGenerator<never> {};
    const call1: LlmChatCall = { input: { model: 'glm-5.3', provider: 'glm', messages: [] } };
    await ctx.waterfall('llm/before-chat', call1, () => {
      seen.push({ model: call1.input.model, api_key: call1.input.api_key });
      return emptyStream();
    });
    expect(seen[0]).toEqual({ model: 'glm-5.3', api_key: 'sk-live' });

    const call2: LlmChatCall = { input: { model: 'unknown-model', messages: [] } };
    await ctx.waterfall('llm/before-chat', call2, () => {
      seen.push({ model: call2.input.model, api_key: call2.input.api_key });
      return emptyStream();
    });
    expect(seen[1]).toEqual({ model: 'unknown-model', api_key: undefined }); // 无凭据不注入
  });

  it('池行卸载 → 注入订阅随行回收（waterfall 空转，载体不再被改写）', async () => {
    const { ctx, fibers } = await boot();
    ctx.credentials.setGlobal('pool:glm', 'sk-live');
    await fibers[fibers.length - 1].dispose(); // pool 行 fiber

    const seen: Array<{ api_key?: string }> = [];
    const emptyStream = async function* (): AsyncGenerator<never> {};
    const call: LlmChatCall = { input: { model: 'glm-5.3', provider: 'glm', messages: [] } };
    await ctx.waterfall('llm/before-chat', call, () => {
      seen.push({ api_key: call.input.api_key });
      return emptyStream();
    });
    expect(seen[0]).toEqual({ api_key: undefined });
  });
});
