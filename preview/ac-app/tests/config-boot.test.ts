import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { bootFromConfig, PREVIEW_DIR, type BootedConfig } from '../src/ecosystem';
import type { EntryOptions } from '@agentchat/cordis-loader';

const booted: BootedConfig[] = [];
const TEST_YML = 'cordis.test.yml';
const USER_WIDGET = 'user-widget.test.ts';
const REAL_YML = join(PREVIEW_DIR, 'cordis.yml');

/** 真实 cordis.yml 解析结果 = 测试 initial 的唯一事实源（不另维护行表） */
async function realRows(): Promise<EntryOptions[]> {
  return yaml.load(await readFile(REAL_YML, 'utf8')) as EntryOptions[];
}

/**
 * 测试 boot：baseUrl = preview/（与生产同锚点 → 裸包名行同样解析），
 * 配置文件用独立测试名（不触真实 cordis.yml），initial 取自真实 yml。
 */
async function bootTest(overrides: Partial<Parameters<typeof bootFromConfig>[0]> = {}, rows?: EntryOptions[]) {
  const bootedConfig = await bootFromConfig({
    file: `./${TEST_YML}`,
    rows: rows ?? (await realRows()),
    ...overrides,
  });
  booted.push(bootedConfig);
  return { ...bootedConfig, file: join(PREVIEW_DIR, TEST_YML) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { includeEntry, loaderFiber } of booted.splice(0)) {
    await includeEntry.fiber?.dispose(); // 停 include 子树（全部 yml 行）
    if (loaderFiber.uid !== null) await loaderFiber.dispose();
  }
  await unlink(join(PREVIEW_DIR, TEST_YML)).catch(() => {});
  await unlink(join(PREVIEW_DIR, USER_WIDGET)).catch(() => {});
});

describe('ac-app 配置驱动 boot（官方 loader 形态：裸包名行）', () => {
  it('initial 物化落盘，全部行激活（裸包名从 preview/ 解析）', async () => {
    const { ctx, file } = await bootTest();
    const rows = yaml.load(await readFile(file, 'utf8')) as Array<{ id: string; name: string }>;
    const expected = await realRows();
    // 物化内容与真实 cordis.yml 一致（单一事实源：不可能漂移）
    expect(rows).toEqual(expected);
    expect(ctx.tools).toBeDefined();
    expect(ctx.agents).toBeDefined();
    expect(ctx.agentLoop).toBeDefined();
    expect(ctx.router).toBeDefined();
    expect(ctx.llm.providers().sort()).toEqual(['deepseek', 'glm', 'openai']);
    expect(ctx.tools.has('hello')).toBe(true);
  });

  it('hmr 行保持 disabled（无 --expose-internals 的进程）', async () => {
    const { ctx } = await bootTest();
    expect(ctx.get('hmr')).toBeUndefined();
    expect(ctx.get('timer')).toBeDefined();
  });

  it('二次 boot：从既有文件装配，yml 改动（disable glm）生效', async () => {
    const first = await bootTest();
    const rows = yaml.load(await readFile(first.file, 'utf8')) as Array<Record<string, unknown>>;
    (rows.find((r) => r.id === 'llm-glm') as Record<string, unknown>).disabled = true;
    await writeFile(first.file, yaml.dump(rows), 'utf8');
    await first.includeEntry.fiber?.dispose();
    await first.loaderFiber.dispose();

    const second = await bootTest(); // 文件已存在：直接装配（非 initial 路径）
    booted.push(second);
    expect(second.ctx.llm.providers().sort()).toEqual(['deepseek', 'openai']);
  });

  it('配置热刷新：include.refresh 事务性增删行（不重启进程）', async () => {
    const { ctx, file, include } = await bootTest();
    expect(ctx.llm.providers()).toContain('glm');
    const rows = yaml.load(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    (rows.find((r) => r.id === 'llm-glm') as Record<string, unknown>).disabled = true;
    await writeFile(file, yaml.dump(rows), 'utf8');
    await include.refresh();
    expect(ctx.llm.providers()).not.toContain('glm');
    expect(ctx.tools.has('hello')).toBe(true);
  });

  it('运行时 patches：include patches 覆盖行（不写回文件）', async () => {
    const { ctx, file } = await bootTest({ patches: [{ id: 'llm-glm', disabled: true }] });
    expect(ctx.llm.providers()).not.toContain('glm');
    const rows = yaml.load(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    expect((rows.find((r) => r.id === 'llm-glm') as Record<string, unknown>).disabled).toBeUndefined();
  });

  it('Config schema（教程第 5 章）：非法配置 → 行 FAILED，boot 拒绝', async () => {
    const rows = (await realRows()).map((r) =>
      r.id === 'llm-glm' ? { ...r, config: { apiKey: 123 } } : r,
    );
    await expect(bootTest({}, rows)).rejects.toThrow(/llm-glm/);
  });

  it('端到端：yml 树上跑通 router → loop → tools → llm', async () => {
    const { ctx } = await bootTest();
    let counter = 0;
    const scripted = ctx.plugin({
      name: 'ac-mock-scripted-llm',
      inject: ['llm'],
      apply(c: import('@agentchat/cordis').Context) {
        c.llm.register(
          'scripted',
          () => ({
            stream: async function* () {
              if (counter++ === 0) {
                yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'hello', argumentsDelta: '{"message":"yml"}' }] };
                yield { delta: '', finish: 'tool_calls' };
              } else {
                yield { delta: 'yml 链路 ok' };
                yield { delta: '', finish: 'stop' };
              }
            },
          }),
          { models: ['mock-1'] },
        );
      },
    } as any);
    await scripted;
    ctx.agents.register({ id: 'helper', model: 'mock-1', tools: ['hello'] });
    let replyCount = 0;
    ctx.on('router/reply-completed', () => (replyCount += 1));
    const run = await ctx.router.send('helper', 'q');
    expect(run.finish).toBe('stop');
    expect(run.steps[0].toolResults[0]).toEqual({ ok: true, output: 'hello: yml' });
    expect(replyCount).toBe(1);
  });

  it('开放调色板：新插件 = 新文件 + yml 加行 → refresh 热生效（教程第 1 章工作流）', async () => {
    // 用户工作流：① 写插件文件（相对路径行，教程同款 './hello.ts'）
    //            ② yml 加一行 ③ 保存（= include.refresh）
    const fixture = [
      '// 用户自建插件（本地文件行）',
      "export const name = 'ac-user-widget';",
      "export const inject = ['tools'];",
      'export function apply(ctx) {',
      "  ctx.tools.register({ name: 'user-tool', execute: () => ({ ok: true, output: 'from-user-file' }) });",
      '}',
      '',
    ].join('\n');
    const { ctx, file, include } = await bootTest();
    await writeFile(join(PREVIEW_DIR, USER_WIDGET), fixture, 'utf8');
    const rows = yaml.load(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    rows.push({ id: 'user-widget', name: `./${USER_WIDGET}` });
    await writeFile(file, yaml.dump(rows), 'utf8');
    await include.refresh(); // "保存 yml" 之后发生的事，进程不重启
    expect(ctx.tools.has('user-tool')).toBe(true);
    const r = await ctx.tools.execute({ name: 'user-tool' });
    expect(r).toEqual({ ok: true, output: 'from-user-file' });
  });
});

describe('plugin-timer / plugin-logger-console（生态裸名行）', () => {
  it('ctx.timeout：fiber 卸载 → 定时器自动回收（回调不触发）', async () => {
    const { ctx } = await bootTest();
    let fired = 0;
    const rowFiber = ctx.plugin({
      name: 'ac-mock-timer-user',
      inject: ['timer'],
      apply(c: import('@agentchat/cordis').Context) {
        c.timeout(() => {
          fired += 1;
        }, 40);
      },
    } as any);
    await rowFiber;
    expect(fired).toBe(0);
    await rowFiber.dispose();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(0);
  });

  it('logger-console：ctx.logger 输出经 ConsoleExporter 到 console', async () => {
    const { ctx } = await bootTest();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    ctx.logger('ac-cfg-test').info('hello %C', 'console');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('ac-cfg-test');
  });
});
