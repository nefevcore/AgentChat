// ============================================================
// ac-app/src/smoke.ts —— 冒烟脚本（根目录 pnpm smoke）
//
// 逐项验证 cordis 第一性原理四件套 + 端到端链路：
//   apply（行激活）/ effect（fiber 归属注册 + 诊断标签）/
//   on（事件目录就绪）/ dispose（热插拔自动回收）/
//   端到端（router → loop → tools → llm，脚本化 provider 零网络）。
// 注：冒烟输出走 console（root Context 未挂 logger console exporter）。
// 数据根：缺省锚定 <repo>/workspace/test（与 pnpm test 同一集中管理的
// 临时目录，启动前自清理——不再写仓库 ./data）；显式设
// AGENTCHAT_DATA_ROOT 则尊重之（且不清理用户指定目录）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@agentchat/cordis';
import { bootTree } from './index.ts';

if (!process.env.AGENTCHAT_DATA_ROOT) {
  const smokeRoot = path.resolve(
    fileURLToPath(new URL('../../../', import.meta.url)),
    'workspace',
    'test',
  );
  process.env.AGENTCHAT_DATA_ROOT = smokeRoot;
  fs.rmSync(smokeRoot, { recursive: true, force: true }); // 自有临时目录才清理
  // 标准三连接 fixture（与 vitest global-setup 同款——种子已移除，
  // 冒烟的路由/诊断断言经配置驱动注册面）。注意：AGENTCHAT_DATA_ROOT
  // 锚定的是数据根本身 → config.json 在根级（非 data/ 子目录）
  fs.mkdirSync(smokeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(smokeRoot, 'config.json'),
    `${JSON.stringify({
      llmProviders: {
        openai: { base_url: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o3'] },
        deepseek: { base_url: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'] },
        glm: { base_url: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3', models: ['glm-5.3'] },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[smoke] 数据根（自清理临时目录 + 三连接 fixture）: ${smokeRoot}`);
}

/** 脚本化 provider 薄行（第 1 次出工具调用，第 2 次出最终文本） */
function scriptedRow() {
  let counter = 0;
  return {
    name: 'mock-scripted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(
        'scripted',
        () => ({
          stream: async function* () {
            const idx = counter++;
            if (idx === 0) {
              yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello' }] };
              yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"preview"}' }] };
              yield { delta: '', finish: 'tool_calls' };
            } else {
              yield { delta: '链路验证完成' };
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
  const scripted = ctx.plugin(scriptedRow() as any);
  await scripted;
  fibers.set('mock-llm', scripted);
  // TREE 首行是 logger-console（plugin-logger-console）：ctx.logger 现已输出到控制台
  const log = ctx.logger('ac-app');

  // 1) apply + effect：工具链路（hello 行注册的工具）
  const hello = await ctx.tools.execute({ name: 'hello', args: { message: 'preview 轨道' } });
  log.info('hello 工具 → %C', JSON.stringify(hello.output));
  for (const [id, fiber] of fibers) {
    log.info('fiber "%C" → %C', id, fiber.getEffects().map((e) => e.label).join(', ') || '(无标签)');
  }

  // 2) on + 纯路由诊断（不发起网络请求）
  for (const stat of ctx.llm.stats()) log.info('llm %C', JSON.stringify(stat));
  for (const model of ['gpt-4o-mini', 'deepseek-v4-flash', 'glm-5.3']) {
    log.info('%C → %C', model, ctx.llm.resolveProvider({ model }));
  }

  // 3) plugin-timer：ctx.timeout（fiber 归属定时器，随 fiber 自动回收）
  await ctx.timeout(10);
  log.info('ctx.timeout(10) ok');

  // 4) 端到端：router 纯转发（agents 信封 → loop 工具轮 → llm）+ 事件通知通道
  ctx.agents.register({ id: 'helper', model: 'mock-1', system: '你是链路验证助手', tools: ['hello'] });
  const roles: string[] = [];
  ctx.on('router/message-received', (_id, m) => roles.push(m.role));
  ctx.on('router/reply-completed', () => roles.push('assistant'));
  const run = await ctx.router.send('helper', '请用工具打个招呼');
  log.info('e2e finish=%C steps=%C text=%C', run.finish, String(run.steps.length), run.text);
  log.info('步1 工具调用 → %C', JSON.stringify(run.steps[0].toolCalls[0]));
  log.info('步1 工具结果 → %C', JSON.stringify(run.steps[0].toolResults[0]));
  log.info('通知通道（事件订阅，ac-session 前身）→ %C', roles.join(' → '));

  // 5) dispose：摘 deepseek 薄行 → 路由立即失效，其余行不动
  await fibers.get('llm-deepseek')?.dispose();
  log.info('providers = [%C]', ctx.llm.providers().join(', '));
  try {
    ctx.llm.resolveProvider({ model: 'deepseek-v4-flash' });
    throw new Error('deepseek 路由应已失效');
  } catch (err) {
    log.info('deepseek-v4-flash → %C', (err as Error).message);
  }

  // 6) dispose 级联：摘 agent-loop → router 回滚消失，agents 存活
  await fibers.get('agent-loop')?.dispose();
  log.info('router=%C agents=%C', (ctx as any).router ? '存活' : '已回滚', (ctx as any).agents ? '存活' : '已回滚');

  // 7) 收尾：逆序回收全部行
  for (const fiber of [...fibers.values()].reverse()) {
    if (fiber.uid !== null) await fiber.dispose();
  }
  console.log('preview 冒烟完成 ✓');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
