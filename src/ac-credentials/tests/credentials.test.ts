// ============================================================
// ac-credentials：加密存取 / Agent→全局解析链 / 明文兼容升级 / 损坏丢弃
// （LLM 凭据注入已迁 ac-llm-pool——2026-09-05 边界评估建议 #4）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as credentialsRow from '../src/index.ts';

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

  it('B2 回归：解密失败条目不被静默丢弃——密文原样保留，后续写入不销毁', async () => {
    const file = tmpFile();
    const ctx1 = await boot(file);
    ctx1.credentials.setGlobal('openai', 'sk-real');
    ctx1.credentials.setGlobal('glm', 'sk-keep');
    // 篡改 openai 条目（模拟换机：一条解不开、另一条可解）
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    const openaiKey = Object.keys(raw).find((k) => k.includes('OPENAI'))!;
    raw[openaiKey] = raw[openaiKey].slice(0, -4) + 'AAAA';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const ctx2 = await boot(file);
    ctx2.credentials.setGlobal('deepseek', 'sk-new'); // 触发全量重写
    const raw2 = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    // 篡改条目密文仍在盘上（换回原机可恢复），可解条目与新条目都在
    expect(raw2[openaiKey]).toBeTruthy();
    expect(raw2[openaiKey]).not.toContain('sk-real');
    expect(ctx2.credentials.getGlobal('glm')).toBe('sk-keep');
    expect(ctx2.credentials.getGlobal('deepseek')).toBe('sk-new');
  });

  it('B2 回归：存储文件撕裂（JSON 解析失败）→ 转存 .corrupt 后从空档开始，不再静默归零覆盖', async () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"__GLOBAL___OPENAI_API_KEY": "v1:AAAA', 'utf-8'); // 半写撕裂件

    const ctx = await boot(file);
    expect(ctx.credentials.getGlobal('openai')).toBe(''); // 按未设置处理
    ctx.credentials.setGlobal('glm', 'sk-glm'); // 触发重写
    // 坏文件被转存而非静默覆盖——唯一凭据副本可手工抢救
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
    expect(fs.readFileSync(`${file}.corrupt`, 'utf-8')).toContain('v1:AAAA');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    expect(Object.keys(raw)).toEqual(['__GLOBAL___GLM_API_KEY']);
  });

  it('B2 回归：写盘原子性——盘上不留 .tmp 残留，内容完整可解析', async () => {
    const file = tmpFile();
    const ctx = await boot(file);
    for (let i = 0; i < 5; i++) {
      ctx.credentials.setGlobal(`p${i}`, `sk-${i}`);
      JSON.parse(fs.readFileSync(file, 'utf-8')); // 每轮都完整可解析（无半写窗口暴露）
    }
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
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
