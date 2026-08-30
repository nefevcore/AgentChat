// ============================================================
// ac-app/src/boot-yml-main.ts —— 配置驱动 boot 入口
//
// 运行方式：pnpm preview:boot
//   = node --expose-internals --import tsx preview/ac-app/src/boot-yml-main.ts
//
// --expose-internals 是 hmr 行的构造前提（无 flag 时 hmr 保持 disabled，
// 其余行不受影响）。演示：cordis.yml 驱动装配 + logger 控制台输出 +
// ctx.timeout（plugin-timer）+ 配置热刷新（include.refresh）+ 端到端链路 +
// HMR 模块热重载（真实模块行 + reloadFiles）。
// ============================================================
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Context } from '@agentchat/cordis';
import type {} from './index.ts'; // TREE 全行 → 各域服务/事件类型增强（type-only）
import { bootFromConfig, ModuleLoader } from './ecosystem';

/** 脚本化 provider 薄行（第 1 次出工具调用，第 2 次出最终文本） */
function scriptedRow() {
  let counter = 0;
  return {
    name: 'ac-mock-scripted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* () {
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"配置驱动"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '配置驱动链路验证完成' };
              yield { delta: '', finish: 'stop', usage: { prompt: 2, completion: 3 } };
            }
          },
        }),
        { models: ['mock-1'] },
      );
    },
  };
}

/** HMR 验证 fixture：真实模块文件（版本常量随重载翻转） */
function fixtureSource(version: string): string {
  return [
    `// hmr fixture（boot-yml-main 生成；当前版本 ${version}）`,
    `const VERSION = '${version}';`,
    `export const name = 'ac-hmr-fixture';`,
    `export const inject = ['tools'];`,
    `export function apply(ctx) {`,
    `  ctx.tools.register({ name: 'hmr-probe', execute: () => ({ ok: true, output: VERSION }) });`,
    `}`,
    '',
  ].join('\n');
}

async function main() {
  const hasInternals = !!ModuleLoader.fromInternal();
  const { ctx, include, includeEntry } = await bootFromConfig({
    // 带 --expose-internals 的进程运行时启用 hmr 行（include patches，不写回 yml）
    patches: hasInternals ? [{ id: 'hmr', disabled: false }] : [],
  });
  const log = ctx.logger('ac-app');
  log.info('配置驱动 boot 完成（internals=%C）', String(hasInternals));

  // 1) 服务树：全部行来自 preview/cordis.yml
  log.info('providers = %C', ctx.llm.providers().join(', '));
  log.info('hmr = %C', ctx.get('hmr') ? 'active' : 'disabled（需 --expose-internals）');
  log.info('timer = %C', ctx.get('timer') ? 'active' : 'missing');

  // 2) plugin-timer：ctx.timeout（fiber 归属的定时器）
  await ctx.timeout(10);
  log.info('ctx.timeout(10) ok');

  // 3) 配置热刷新（include.refresh：内容未变 → no-op；变更 → 事务性增删行）
  await include.refresh();
  log.info('include.refresh() ok');

  // 4) 端到端：脚本 provider + hello 工具 + router 纯转发链路
  const scripted = ctx.plugin(scriptedRow() as any);
  await scripted;
  ctx.agents.register({ id: 'helper', model: 'mock-1', system: '你是配置驱动助手', tools: ['hello'] });
  const roles: string[] = [];
  ctx.on('router/message-received', (_id, m) => roles.push(m.role));
  ctx.on('router/reply-completed', () => roles.push('assistant'));
  const run = await ctx.router.send('helper', '请用工具打个招呼');
  log.info('e2e finish=%C steps=%C text=%C', run.finish, String(run.steps.length), run.text);
  log.info('通知通道（事件订阅）→ %C', roles.join(' → '));
  await scripted.dispose();

  // 5) HMR 模块热重载：真实模块行（非 builtins）+ reloadFiles 事务
  if (hasInternals) {
    const fixturePath = join(tmpdir(), `ac-hmr-fixture-${Date.now()}.ts`);
    const fixtureUrl = pathToFileURL(fixturePath).href;
    await writeFile(fixturePath, fixtureSource('v1'), 'utf8');
    await ctx.loader.create({ name: fixtureUrl });
    const probe1 = await ctx.tools.execute({ name: 'hmr-probe' });
    await writeFile(fixturePath, fixtureSource('v2'), 'utf8');
    const hmr = ctx.get('hmr') as { reloadFiles(urls: string[]): Promise<{ ok: boolean; reloaded: string[]; error?: string }> };
    const outcome = await hmr.reloadFiles([fixtureUrl]);
    const probe2 = await ctx.tools.execute({ name: 'hmr-probe' });
    log.info(
      'hmr reload: ok=%C reloaded=%C probe %C → %C',
      String(outcome.ok),
      String(outcome.reloaded?.length ?? 0),
      String(probe1.output),
      String(probe2.output),
    );
  } else {
    log.info('hmr reload: 跳过（需 --expose-internals）');
  }

  // 收尾：停 include 子树（全部 yml 行）再退程
  await includeEntry.fiber?.dispose();
  log.info('配置驱动 boot 冒烟完成 ✓');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
