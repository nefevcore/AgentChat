// ============================================================
// ac-credentials：加密存取 / Agent→全局解析链 / 明文兼容升级 / 损坏丢弃
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as credentialsRow from '../src/index.ts';
import { resolveLlmApiKey } from '../src/index.ts';
import type {} from 'ac-llm'; // llm/* 事件目录类型增强（waterfall 调用签名）
import type { LlmChatCall } from 'ac-llm';

const tmps: string[] = [];

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-credentials-'));
  tmps.push(dir);
  return path.join(dir, 'credentials.json');
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(file: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(credentialsRow as any, { file });
  await fiber;
  booted.push({ ctx, fibers: [fiber] });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) if (fiber.uid !== null) await fiber.dispose();
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-credentials', () => {
  it('set/get 往返；盘上密文（v1: 前缀、不含明文）', async () => {
    const file = tmpFile();
    const ctx = await boot(file);
    ctx.credentials.set('helper', 'openai', 'sk-secret-123');
    expect(ctx.credentials.get('helper', 'openai')).toBe('sk-secret-123');

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('"HELPER_OPENAI_API_KEY"');
    expect(raw).not.toContain('sk-secret-123'); // 明文绝不落盘
    expect(raw).toMatch(/"v1:[A-Za-z0-9+/=]+"/);
  });

  it('空串删除；get 未设置 → 空串', async () => {
    const ctx = await boot(tmpFile());
    ctx.credentials.set('a', 'openai', 'k1');
    ctx.credentials.set('a', 'openai', ''); // 删除
    expect(ctx.credentials.get('a', 'openai')).toBe('');
    expect(ctx.credentials.keys()).toEqual([]);
    expect(ctx.credentials.get('ghost', 'openai')).toBe('');
  });

  it('Agent 级 → 全局级解析链（Agent 覆盖全局）', async () => {
    const ctx = await boot(tmpFile());
    ctx.credentials.setGlobal('openai', 'sk-global');
    expect(ctx.credentials.resolve('a1', 'openai')).toBe('sk-global'); // 无 Agent 级 → 全局
    ctx.credentials.set('a1', 'openai', 'sk-agent');
    expect(ctx.credentials.resolve('a1', 'openai')).toBe('sk-agent'); // Agent 级覆盖
    expect(ctx.credentials.resolve('a2', 'openai')).toBe('sk-global');
    expect(ctx.credentials.resolve('a1', 'deepseek')).toBe(''); // 两级均无
  });

  it('重启回读（加密文件跨服务实例可解）', async () => {
    const file = tmpFile();
    const ctx1 = await boot(file);
    ctx1.credentials.setGlobal('glm', 'sk-glm-xyz');
    const ctx2 = await boot(file);
    expect(ctx2.credentials.getGlobal('glm')).toBe('sk-glm-xyz');
  });

  it('旧明文数据读取兼容；写盘自动升级加密', async () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ A1_OPENAI_API_KEY: 'legacy-plain' }), 'utf-8');

    const ctx = await boot(file);
    expect(ctx.credentials.get('a1', 'openai')).toBe('legacy-plain'); // 明文可读
    ctx.credentials.set('b', 'openai', 'new-key'); // 触发重写
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('legacy-plain'); // 旧明文已升级加密
    expect(ctx.credentials.get('a1', 'openai')).toBe('legacy-plain'); // 升级后仍可读
  });

  it('密文损坏（篡改）→ 解密失败丢弃，按未设置处理', async () => {
    const file = tmpFile();
    const ctx1 = await boot(file);
    ctx1.credentials.setGlobal('openai', 'sk-real');
    // 篡改密文（模拟换机/损坏）
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    const key = Object.keys(raw)[0];
    raw[key] = raw[key].slice(0, -4) + 'AAAA';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const ctx2 = await boot(file);
    expect(ctx2.credentials.getGlobal('openai')).toBe('');
  });

  it('listValues：全部明文值（脱敏清单用）；keys：仅 key 名', async () => {
    const ctx = await boot(tmpFile());
    ctx.credentials.setGlobal('openai', 'sk-a');
    ctx.credentials.set('helper', 'glm', 'sk-b');
    expect(ctx.credentials.listValues().sort()).toEqual(['sk-a', 'sk-b']);
    // '_' (0x5F) > 大写字母 → HELPER_… 排在 __GLOBAL___… 前
    expect(ctx.credentials.keys().sort()).toEqual(['HELPER_GLM_API_KEY', '__GLOBAL___OPENAI_API_KEY']);
  });
});

describe('LLM 凭据注入（llm/before-chat 订阅）', () => {
  it('resolveLlmApiKey 解析链：显式 > Agent池 > Agent provider > 全局池 > 全局 provider > undefined', () => {
    const store = new Map<string, string>();
    const fake = {
      get: (a: string, p: string) => store.get(`${a}|${p}`) ?? '',
      getGlobal: (p: string) => store.get(`__global__|${p}`) ?? '',
    };
    const input = { model: 'glm-5.3', provider: 'glm', meta: { agent: 'helper' } };
    // 全空 → undefined（适配器行构造 key / env 兜底）
    expect(resolveLlmApiKey(fake, input)).toBeUndefined();
    // 全局 provider
    store.set('__global__|glm', 'sk-gp');
    expect(resolveLlmApiKey(fake, input)).toBe('sk-gp');
    // 全局池引用（pool:<model>）覆盖 provider 级
    store.set('__global__|pool:glm-5.3', 'sk-gpool');
    expect(resolveLlmApiKey(fake, input)).toBe('sk-gpool');
    // Agent 级 provider 覆盖全局池
    store.set('helper|glm', 'sk-ap');
    expect(resolveLlmApiKey(fake, input)).toBe('sk-ap');
    // Agent 级池引用最高（UI 模型管理的池条目 key）
    store.set('helper|pool:glm-5.3', 'sk-apool');
    expect(resolveLlmApiKey(fake, input)).toBe('sk-apool');
    // 上游已显式指定：不覆盖
    expect(resolveLlmApiKey(fake, { ...input, api_key: 'sk-explicit' })).toBeUndefined();
    // 无 agent（meta 缺失）：只走全局链
    expect(resolveLlmApiKey(fake, { model: 'glm-5.3', provider: 'glm' })).toBe('sk-gpool');
  });

  it('before-chat 注入：有凭据 → 变异载体补 api_key；无凭据 → 原样放行', async () => {
    const ctx = await boot(tmpFile());
    ctx.credentials.setGlobal('pool:glm-5.3', 'sk-live');

    const seen: Array<{ model: string; api_key?: string }> = [];
    // waterfall 语义：监听器先跑（变异载体），inner（默认行为）最后。
    // inner 须返回 AsyncIterable；断言点放 inner 同步段（generator 体不迭代不执行）。
    const emptyStream = async function* (): AsyncGenerator<never> {};
    const call1: LlmChatCall = { input: { model: 'glm-5.3', messages: [] } };
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
});
