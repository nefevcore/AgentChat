// ============================================================
// ac-run-code/tests/switch.test.ts —— 工具调用模式面集成测试
//（2026-09-17 tc-* 标签轴统一重构：工具调用模式与提权档位同构——
// Agent tags 定默认档 + conv-settings.toolMode 会话覆盖 + router 收窄；
// code-exec 标签已移除，tc-programmatic 即唯一授权词）
//
// 运行期验证（端到端链路——最小行集真行装载）：
// · 生效档 tc-programmatic（tags/会话覆盖〔临时程序化档〕/无标签覆盖）→ LLM 工具面
//   = 仅 run_code；system 注入投影块（基线纪律）
// · 覆盖 tc-base 压回标准档 → 并存形态（传统工具 + run_code；不注入投影块）
// · 投影面 = 能力面全量（scope='projection' 直取——授权真理）+ 递归防护
// · tag-registry catalog 含 tc-programmatic（预注册 + run_code 消费计数）
// · 子 Agent 派生身份继承 tc-programmatic（STRIPPED_TAGS 不剥模式词）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as runCodeRow from 'ac-run-code';
import * as convSettingsRow from 'ac-conv-settings';
import * as fsToolsRow from 'ac-fs-tools';
import * as fsSearchRow from 'ac-fs-search';
import * as shellToolsRow from 'ac-shell-tools';
import * as mathRow from 'ac-math';
import * as webToolsRow from 'ac-web-tools';
import * as tagRegistryRow from 'ac-tag-registry';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import { capabilitySetOf, toolAllowedFor } from 'ac-agents';
import type { LlmStreamChunk } from 'ac-llm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-run-code-switch-'));
  tmps.push(dir);
  return dir;
}

/** mock LLM provider（纯文本收束——探针只看 LLM 请求面） */
function mockProviderRow() {
  return {
    name: 'mock-provider',
    inject: ['llm'],
    apply(c: Context) {
      c.llm.register(
        'mock',
        () => ({
          stream: async function* (): AsyncIterable<LlmStreamChunk> {
            yield { delta: 'ok' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
}

/** boot 最小行集；conv-settings 用真行 + 临时根（自清理） */
async function boot() {
  const root = tmpRoot();
  const ctx = new Context();
  const fibers: Fiber[] = [];
  // 最小行集：真 run_code 行 + conv-settings（真行，临时根）+ router/loop/llm
  //（端到端）+ 投影面（能力面）核心族工具行。delegation 由假探针替代注册面。
  const jobsRow = await import('ac-jobs');
  for (const row of [
    toolsRow, jobsRow, llmRow, mockProviderRow(), loopRow, agentsRow, routerRow,
    fsToolsRow, fsSearchRow, shellToolsRow, mathRow, webToolsRow, tagRegistryRow,
  ] as unknown[]) {
    fibers.push(await ctx.plugin(row as any));
  }
  fibers.push(await ctx.plugin(convSettingsRow as any, { root }));
  fibers.push(await ctx.plugin(runCodeRow as any));
  // delegation 探针（subagent 工具的注册面替身——只测 tag:delegation 展开）
  fibers.push(await ctx.plugin({
    name: 'fake-delegation-row',
    inject: ['tools'],
    apply(c: Context) {
      c.tools.register({
        name: 'subagent',
        requiredTags: ['delegation'],
        description: '任务委派探针（真行住 ac-subagent）',
        execute: () => ({ ok: true }),
      });
    },
  } as any));
  const entry = { ctx, fibers, root };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('工具调用模式面集成（2026-09-17 tc-* 标签轴统一重构）', () => {
  it('tc-programmatic（tags）→ LLM 面 = 仅 run_code；system 注入投影块（程序化调用）；投影源 = 能力面全量', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'coder', model: 'mock-1', tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'tc-programmatic'] });
    // 无会话覆盖键：跟随 tags（tc-programmatic）

    const calls: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });

    const run = await ctx.router.send('coder', 'q', { conversationId: 'user~coder' });
    expect(run.finish).toBe('stop');

    // ① LLM 工具面收窄为仅 run_code（router 消费生效档——tags 驱动）
    expect((calls[0]?.tools ?? []).map((t) => t.function.name)).toEqual(['run_code']);

    // ② system 注入投影块（程序化调用）：基线纪律在场
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    expect(system?.content ?? '').toContain('# run_code 工具 SDK');
    expect(system?.content ?? '').toContain('declare const tools');
    expect(system?.content ?? '').toContain('程序化模式');
    expect(system?.content ?? '').not.toMatch(/run_code\s*\(/); // 递归防护

    // ③ 投影源 = 能力面直取（scope='projection'——含 read 等全部已授权族；
    //    include/开关收窄不影响投影源）
    const { resolveEffectiveTools } = await import('ac-run-code/src/tool.ts');
    const projectionFace = resolveEffectiveTools(ctx, 'coder', 'user~coder', 'projection');
    const names = projectionFace.map((d: { name: string }) => d.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('glob');
    expect(names).toContain(process.platform === 'win32' ? 'pwsh' : 'bash');
    expect(names).toContain('web_search');
    expect(names).toContain('math');
    expect(names).not.toContain('run_code'); // 递归防护（投影层排除）
    // 未授权族不在（collab/history 未授予——能力面即边界）
    expect(names).not.toContain('send_agent');
    expect(names).not.toContain('read_history');
  });

  it('无标签 Agent + 会话覆盖 tc-programmatic → 临时程序化档（优化裁决：程序化是形态选择非授权门槛）', async () => {
    const { ctx } = await boot();
    // Agent 无任何 tc-* 标签（跟随态 = tc-base）；infra 在（boot 行集含 fs-tools/math 等 infra 族）
    ctx.agents.register({ id: 'plain', model: 'mock-1', tags: ['fs', 'infra', 'shell', 'web', 'delegation'] });
    ctx.convSettings.set('user~plain', { toolMode: 'tc-programmatic' }); // 前端选「程序化」= 临时分配

    const calls: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: typeof calls[0] }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });

    const run = await ctx.router.send('plain', 'q', { conversationId: 'user~plain' });
    expect(run.finish).toBe('stop');
    // LLM 面收窄为 run_code（覆盖即临时程序化档——无需预配标签）
    expect((calls[0]?.tools ?? []).map((t) => t.function.name)).toEqual(['run_code']);
    // SDK 投影块注入（程序化调用）
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    expect(system?.content ?? '').toContain('# run_code 工具 SDK');
  });

  it('覆盖 tc-base 压回标准档 → 并存形态：传统工具照常 + run_code 共存；不注入投影块', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'coder', model: 'mock-1', tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'tc-programmatic'] });
    ctx.convSettings.set('user~coder', { toolMode: 'tc-base' }); // 覆盖压回标准档

    const calls: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });

    await ctx.router.send('coder', 'q', { conversationId: 'user~coder' });
    const tools = (calls[0]?.tools ?? []).map((t) => t.function.name);
    expect(tools).toContain('run_code');
    expect(tools).toContain('read'); // 传统工具照常（覆盖压回 = 并存形态）
    // 并存形态不注入投影块（2026-09-17 续修：SDK 投影只在程序化调用注入）
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    expect(system?.content ?? '').not.toContain('# run_code 工具 SDK');
  });

  it('tag-registry catalog：tc-* 预注册（纯模式词——零消费工具）；run_code 授权随 infra；模式词不进 requiredTags 断言', async () => {
    const { ctx } = await boot();
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(byTag.get('tc-programmatic')).toMatchObject({ category: 'tool-mode', reserved: true });
    expect(byTag.get('tc-programmatic')?.tools).toEqual([]); // 纯模式词——零消费（授权词 = infra）
    expect(byTag.get('tc-none')?.category).toBe('tool-mode');
    expect(byTag.get('tc-base')?.category).toBe('tool-mode');
    expect(byTag.get('infra')?.tools.some((t) => t.name === 'run_code')).toBe(true); // 授权随 infra
    // 非能力词不进 requiredTags（含 tc-programmatic——白名单已收）——启动期断言
    expect(() => ctx.tagRegistry.assertNoTierInToolRequirements()).not.toThrow();
  });

  it('子 Agent 派生身份继承 tc-programmatic（STRIPPED_TAGS 只剥 delegation/admin——模式词随父）', async () => {
    const { ctx } = await boot();
    // 模拟派生身份注册（subagent spawn 的派生条目形态：父 tags 剥
    // delegation/admin——模式词不在剥减表，随父继承）
    const STRIPPED = ['delegation', 'admin'];
    const derivedTags = (['fs', 'infra', 'tc-programmatic', 'delegation'] as string[]).filter((t) => !STRIPPED.includes(t));
    expect(derivedTags).toEqual(['fs', 'infra', 'tc-programmatic']); // 自检：剥减表不含模式词（infra 授权随行）
    ctx.agents.register({ id: 'sub_test', model: 'm', tags: derivedTags, preset: true });
    const caps = capabilitySetOf(ctx, 'sub_test');
    const runCodeDef = ctx.tools.get('run_code');
    expect(toolAllowedFor(runCodeDef, caps)).toBe(true); // 子 Agent 可用 run_code
    // 而派生身份剥掉了 delegation → subagent 工具不可见（防递归编排）
    const subagentDef = ctx.tools.get('subagent');
    expect(toolAllowedFor(subagentDef, caps)).toBe(false);
  });
});
