// ============================================================
// ac-run-code/tests/switch.test.ts —— 程序化开关面集成测试
//（2026-09-17 开关化：由 preset.test.ts 改写——__programmatic__ 预设退役，
// 程序化 = 会话级开关 conv-settings.programmatic + router 收窄）
//
// 运行期验证（端到端链路——最小行集真行装载）：
// · 开关开（conv-settings 写键）→ router send → LLM 工具面 = 仅 run_code；
//   system 注入互斥版投影块（基线纪律，无执行形态选择策略）
// · 开关关 → 并存形态（传统工具 + run_code；投影块含选择策略）
// · 投影面 = 能力面全量（scope='projection' 直取——授权真理）+ 递归防护
// · tag-registry catalog 含 code-exec（预注册 + run_code 消费计数）
// · 子 Agent 派生身份继承 code-exec（STRIPPED_TAGS 无 code-exec）
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

describe('程序化开关面集成（2026-09-17 开关化终裁——research §十）', () => {
  it('开关开 → LLM 面 = 仅 run_code；system 注入互斥版投影块（无选择策略）；投影源 = 能力面全量', async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'coder', model: 'mock-1', tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'code-exec'] });
    ctx.convSettings.set('user~coder', { programmatic: 'true' });

    const calls: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });

    const run = await ctx.router.send('coder', 'q', { conversationId: 'user~coder' });
    expect(run.finish).toBe('stop');

    // ① LLM 工具面收窄为仅 run_code（router 消费开关——真互斥形态）
    expect((calls[0]?.tools ?? []).map((t) => t.function.name)).toEqual(['run_code']);

    // ② system 注入互斥版投影块：基线纪律在场、选择策略缺席
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    expect(system?.content ?? '').toContain('# run_code 工具 SDK');
    expect(system?.content ?? '').toContain('declare const tools');
    expect(system?.content ?? '').toContain('程序化模式');
    expect(system?.content ?? '').not.toContain('执行形态选择');
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

  it('开关关（无键）→ 并存形态：传统工具照常 + run_code 共存；投影块含执行形态选择策略', async () => {
    const { ctx } = await boot(); // 无键 = 开关关
    ctx.agents.register({ id: 'coder', model: 'mock-1', tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'code-exec'] });

    const calls: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });

    await ctx.router.send('coder', 'q', { conversationId: 'user~coder' });
    const tools = (calls[0]?.tools ?? []).map((t) => t.function.name);
    expect(tools).toContain('run_code');
    expect(tools).toContain('read'); // 传统工具照常（开关关 = 并存形态）
  });

  it('tag-registry catalog：code-exec 预注册 + run_code 消费计数 = 1', async () => {
    const { ctx } = await boot();
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    const codeExec = byTag.get('code-exec');
    expect(codeExec).toMatchObject({ category: 'capability', reserved: true });
    expect(codeExec?.tools.map((t) => t.name)).toEqual(['run_code']);
  });

  it('子 Agent 派生身份继承 code-exec（STRIPPED_TAGS 只剥 delegation/admin）', async () => {
    const { ctx } = await boot();
    // 模拟派生身份注册（subagent spawn 的派生条目形态：父 tags 剥
    // delegation/admin——code-exec 不在剥减表，随父继承）
    const STRIPPED = ['delegation', 'admin'];
    const derivedTags = (['fs', 'code-exec', 'delegation'] as string[]).filter((t) => !STRIPPED.includes(t));
    expect(derivedTags).toEqual(['fs', 'code-exec']); // 自检：剥减表不含 code-exec
    ctx.agents.register({ id: 'sub_test', model: 'm', tags: derivedTags, preset: true });
    const caps = capabilitySetOf(ctx, 'sub_test');
    const runCodeDef = ctx.tools.get('run_code');
    expect(toolAllowedFor(runCodeDef, caps)).toBe(true); // 子 Agent 可用 run_code
    // 而派生身份剥掉了 delegation → subagent 工具不可见（防递归编排）
    const subagentDef = ctx.tools.get('subagent');
    expect(toolAllowedFor(subagentDef, caps)).toBe(false);
  });
});
