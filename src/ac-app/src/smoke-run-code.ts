// ============================================================
// ac-app/src/smoke-run-code.ts —— 程序化模式（run_code）dev 形态冒烟
//
// 实施计划 §十 验收项「dev 形态 run_code 冒烟」的可复用脚本：
//   bootTree 全 TREE → 开关面装配（2026-09-17 开关化：__programmatic__
//   预设退役，程序化 = 会话级开关 conv-settings.programmatic）真实执行：
//   1) 开关装配：临时测试 Agent（tags 全授权族）+ conv-settings 写键
//   2) tag-registry catalog：code-exec 预注册 + run_code 消费计数
//   3) 纯计算：return 1 + 1 → 2（计划 §十 原始验收式）
//   4) 工具编排（真 fs 行子调用）：read 目录 + glob + 只读 Promise.all
//   5) 递归防护：程序内 tools.run_code 不可达（代理 get 抛错）
//   6) 子调用标记 runCodeSubcall（实测复盘 #B）
//   7) LLM 端到端：mock provider 首轮出 run_code 工具调用 →
//      loop 执行（投影注入 #A1 经 llm/before-chat 截获验证）→
//      二轮文本收束（开关开 = 互斥形态注入）
// 数据根：无条件锚定 <repo>/workspace/test（同 smoke.ts 语义：自清理 +
// 三连接 fixture + 路径护栏；不读外部 AGENTCHAT_DATA_ROOT，防机器级 env
// 劫持到真实数据根）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@agentchat/cordis';
import { bootTree } from './index.ts';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';

const smokeRoot = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'workspace',
  'test',
);
if (!smokeRoot.endsWith(path.join('workspace', 'test'))) {
  throw new Error(`冒烟数据根路径异常，拒绝清理: ${smokeRoot}`);
}
process.env.AGENTCHAT_DATA_ROOT = smokeRoot;
fs.rmSync(smokeRoot, { recursive: true, force: true });
fs.mkdirSync(smokeRoot, { recursive: true });
fs.writeFileSync(
  path.join(smokeRoot, 'config.json'),
  `${JSON.stringify({
    llmProviders: {
      openai: { base_url: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini'] },
      deepseek: { base_url: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash'] },
      glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3', models: ['glm-5.3'] },
    },
  }, null, 2)}\n`,
  'utf8',
);
console.log(`[smoke-run-code] 数据根（自清理临时目录 + 三连接 fixture）: ${smokeRoot}`);

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : ` —— ${detail}`}`);
  if (!ok) failed++;
}

/** 脚本化 provider（第 1 轮出 run_code 工具调用，第 2 轮出最终文本） */
function scriptedRow() {
  let counter = 0;
  return {
    name: 'mock-programmatic-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* (): AsyncIterable<LlmStreamChunk> {
            if (counter++ === 0) {
              yield { delta: '', toolCalls: [{ index: 0, id: 'rc1', name: 'run_code' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"code":"return 6 * 7;"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '程序化模式链路验证完成' };
              yield { delta: '', finish: 'stop', usage: { prompt: 2, completion: 3 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
}

async function main() {
  const { ctx, fibers } = await bootTree();
  const scripted = await ctx.plugin(scriptedRow() as any);
  fibers.set('mock-llm', scripted);
  const log = ctx.logger('smoke-run-code');
  const agentId = 'smoke-programmatic';
  const convId = 'smoke-run-code';

  // ---- 1) 开关面装配（开关化：conv-settings programmatic——预设已退役）----
  console.log('[1] 开关面装配（临时测试 Agent + conv-settings 写键）');
  ctx.agents.register({
    id: agentId,
    model: 'mock-1',
    preset: true,
    // 全授权族（投影面 = 能力面：tags 即工具面）——原 __programmatic__ 同款
    tags: ['fs', 'infra', 'shell', 'web', 'delegation', 'code-exec'],
  });
  ctx.convSettings.set(convId, { programmatic: 'true' });
  const stored = ctx.convSettings.get(convId);
  check('开关已落盘（programmatic=true）', stored.programmatic === true);
  // 开关收窄经 router 消费（LLM 面 = 仅 run_code）——见 [7] 端到端验证

  // ---- 2) 标签目录 ----
  console.log('[2] tag-registry catalog（code-exec 预注册）');
  const codeExec = ctx.tagRegistry.catalog().find((t) => t.tag === 'code-exec');
  check('catalog 含 code-exec（reserved）', codeExec?.reserved === true);
  check('run_code 消费计数 = 1', (codeExec?.tools ?? []).map((t) => t.name).join(',') === 'run_code');

  // run_code 执行的公共入口（预设身份）
  const runCode = (code: string, extra: Record<string, unknown> = {}) =>
    ctx.tools.execute({ name: 'run_code', args: { code, ...extra }, agentId, conversationId: convId, toolCallId: `sm-${Date.now()}` });

  // ---- 3) 纯计算（计划 §十 原始验收式） ----
  console.log('[3] 纯计算：return 1 + 1 → 2');
  const r1 = await runCode('return 1 + 1;');
  const out1 = r1.output as { value?: unknown; programHash?: string } | undefined;
  check('run_code ok', r1.ok === true, r1.error);
  check('返回值 = 2', out1?.value === 2, JSON.stringify(out1));
  check('步记录摘要形态（programHash）', typeof out1?.programHash === 'string');

  // ---- 4) 工具编排（真 fs 行） ----
  console.log('[4] 工具编排：read 目录 + glob + 只读并行（真 worker + 桥接 + ctx.tools.execute）');
  const probeDir = path.join(process.env.AGENTCHAT_DATA_ROOT!, 'files', 'probe');
  fs.mkdirSync(path.join(probeDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'a.txt'), 'hello-probe-A\n', 'utf8');
  fs.writeFileSync(path.join(probeDir, 'b.txt'), 'hello-probe-B\n', 'utf8');
  fs.writeFileSync(path.join(probeDir, 'sub', 'c.txt'), 'hello-probe-C\n', 'utf8');
  const dirLit = JSON.stringify(probeDir.replace(/\\/g, '/')).slice(1, -1); // 程序体内字面量（正斜杠）

  const subcalls: Array<{ name: string; subcall: boolean }> = [];
  ctx.on('tool/after-execute', ((call: { name: string; runCodeSubcall?: boolean }) => {
    subcalls.push({ name: call.name, subcall: call.runCodeSubcall === true });
  }) as never, { description: '冒烟探针：子调用标记收集' });

  const code2 = [
    `const dir = \`${dirLit}\`;`,
    'const listing = await tools.read({ file_path: dir });',
    `const g = await tools.glob({ pattern: '*.txt', path: \`${dirLit}\` });`,
    "const reads = await Promise.all(g.output.paths.map((p) => tools.read({ file_path: p })));",
    "return { dirCount: listing.output.count, globTotal: g.output.total, contents: reads.map((r) => r.output.content.trim()) };",
  ].join('\n');

  const r2 = await runCode(code2);
  const out2 = r2.output as { value?: { dirCount?: number; globTotal?: number; contents?: string[] }; summary?: { calls?: number; ok?: number } } | undefined;
  check('编排程序 ok', r2.ok === true, r2.error ?? JSON.stringify(out2).slice(0, 300));
  check('目录清单 count = 3（a.txt/b.txt/sub）', out2?.value?.dirCount === 3, JSON.stringify(out2?.value));
  check('glob 命中 3 个 .txt（含子目录）', out2?.value?.globTotal === 3, JSON.stringify(out2?.value));
  check('并行 read 3 份内容齐', out2?.value?.contents?.length === 3 && out2.value.contents.every((c) => c.includes('hello-probe')), JSON.stringify(out2?.value?.contents));
  check('摘要子调用计数 = 5（1 read + 1 glob + 3 read）', out2?.summary?.calls === 5 && out2?.summary?.ok === 5, JSON.stringify(out2?.summary));

  // ---- 5) 递归防护 ----
  console.log('[5] 递归防护：程序内 tools.run_code 不可达');
  const r3 = await runCode('return typeof tools.run_code;');
  check('程序失败且错误指向 run_code/递归', r3.ok === false && /run_code|递归/.test(r3.error ?? (r3.output as { error?: string } | undefined)?.error ?? ''), JSON.stringify({ ok: r3.ok, error: r3.error }));

  // ---- 6) 子调用标记（#B） ----
  console.log('[6] 子调用标记 runCodeSubcall（tool/after-execute 可编程区分）');
  const reads = subcalls.filter((s) => s.name === 'read');
  const globs = subcalls.filter((s) => s.name === 'glob');
  const outer = subcalls.filter((s) => s.name === 'run_code');
  check('read 子调用 × 4 均带标记', reads.length === 4 && reads.every((s) => s.subcall), JSON.stringify(reads));
  check('glob 子调用带标记', globs.length >= 1 && globs.every((s) => s.subcall));
  check('模型直调的 run_code 不带标记', outer.length >= 1 && outer.every((s) => !s.subcall), JSON.stringify(outer));

  // ---- 7) LLM 端到端（投影注入 #A1 + loop 集成 + 开关收窄） ----
  console.log('[7] LLM 端到端：scripted provider → 开关收窄 → run_code 工具调用 → 投影注入 → 文本收束');
  const chatInputs: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
  ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
    chatInputs.push(payload.input ?? {});
    return next();
  }) as never, { description: '冒烟探针：截获 LLM 请求面' });
  ctx.agents.register({ id: 'prog-helper', model: 'mock-1', tags: ['fs', 'code-exec'] });
  ctx.convSettings.set('prog-conv', { programmatic: 'true' }); // 开关开（互斥形态）
  const run = await ctx.router.send('prog-helper', '请用 run_code 计算 6*7', { conversationId: 'prog-conv' });
  const system = chatInputs[0]?.messages?.find((m) => m.role === 'system');
  check('run 正常收束（finish=stop）', run.finish === 'stop', `${run.finish}`);
  check('开关收窄：LLM 工具面 = 仅 run_code', (chatInputs[0]?.tools ?? []).map((t) => t.function.name).join(',') === 'run_code', JSON.stringify((chatInputs[0]?.tools ?? []).map((t) => t.function.name)));
  check('system 注入 SDK 投影块（#A1）', (system?.content ?? '').includes('# run_code 工具 SDK') && (system?.content ?? '').includes('declare const tools'), (system?.content ?? '').slice(0, 120));
  check('互斥形态注入（开关开——无执行形态选择策略 #A2）', !(system?.content ?? '').includes('执行形态选择'));
  check('SDK 声明排除 run_code 自身', !/run_code\s*\(/.test(system?.content ?? ''));
  const tr = run.steps[0]?.toolResults?.[0] as { output?: { value?: unknown } } | undefined;
  check('run_code 步结果 value = 42', tr?.output?.value === 42, JSON.stringify(tr?.output));
  check('二轮文本收束', (run.text ?? '').includes('程序化模式链路验证完成'), run.text);

  // ---- 收尾 ----
  for (const fiber of [...fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  if (failed > 0) {
    console.error(`程序化模式冒烟失败：${failed} 项断言未过`);
    process.exit(1);
  }
  console.log('程序化模式 dev 形态冒烟完成 ✓');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
