// ============================================================
// ac-app/tests/aggregate-boot.test.ts —— 官方 loader-boot 路径的
// fiber→行聚合（P5）：真实 cordis.yml 经 Loader + include 装配（与
// boot.ts 同构），断言行归属不漂移到 Loader 侧。
//
//   事故形态（修复前）：rowOfFiber 的 loader 路径读 loader.root.store
//   （EntryGroup 无此面 → 恒 undefined）静默回落程序化路径——官方 boot
//   下 root 直接子 fiber 是 Loader 服务 fiber，全部 yml 行被误聚合到
//   'Loader'（事件视图叶节点 owner/行名全显 Loader）。
//
//   放在 ac-app（组合根）而非 ac-event-policy：真实 yml 装配需要全行集
//   依赖 + bootFromConfig 脚手架，此处现成；聚合本体测试见
//   ac-event-policy/tests/aggregate.test.ts（程序化路径）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { bootFromConfig, PREVIEW_DIR, type BootedConfig } from '../src/ecosystem';
import { computeRowAggregates, rowOfFiber } from 'ac-event-policy';
import type { Fiber } from '@agentchat/cordis';
import type { EntryOptions } from '@agentchat/cordis-loader';

const booted: BootedConfig[] = [];
const TEST_YML = 'cordis.aggregate-test.yml';
const REAL_YML = join(PREVIEW_DIR, 'cordis.yml');

/** 真实 cordis.yml 行表 = 唯一事实源（与 config-boot.test 同款脚手架） */
async function bootTest(): Promise<BootedConfig> {
  const rows = yaml.load(await readFile(REAL_YML, 'utf8')) as EntryOptions[];
  const bootedConfig = await bootFromConfig({ file: `./${TEST_YML}`, rows });
  booted.push(bootedConfig);
  return bootedConfig;
}

afterEach(async () => {
  for (const { includeEntry, loaderFiber } of booted.splice(0)) {
    await includeEntry.fiber?.dispose(); // 停 include 子树（全部 yml 行）
    if (loaderFiber.uid !== null) await loaderFiber.dispose();
  }
  await unlink(join(PREVIEW_DIR, TEST_YML)).catch(() => {});
});

describe('官方 loader boot 的 fiber→行聚合（P5）', () => {
  it('yml 行不误聚合到 Loader：行模块名保持自身、行内服务 fiber 归属所属行', async () => {
    const { ctx } = await bootTest();
    const aggregate = computeRowAggregates(ctx);

    // 事故形态锁定：任何运行时都不再被改写到 'Loader'
    expect([...aggregate.values()]).not.toContain('Loader');
    // 行模块 fiber（如 ac-ws-bridge / ac-session）名即行名——不进映射
    expect(aggregate.has('ac-ws-bridge')).toBe(false);
    expect(aggregate.has('ac-session')).toBe(false);
    // 行内服务 fiber（runtime 名 = 类名）聚合到所属 yml 行名
    expect(aggregate.get('SessionService')).toBe('ac-session');
    expect(aggregate.get('RouterService')).toBe('ac-router');
    expect(aggregate.get('ToolsService')).toBe('ac-tools');
  });

  it('rowOfFiber：yml 行 fiber → 行名；行内服务 fiber → 同一行名', async () => {
    const { ctx } = await bootTest();
    const fiberOf = (runtimeName: string) => {
      const runtime = [...ctx.registry.values()].find((r) => r.name === runtimeName);
      return [...(runtime?.fibers ?? [])].find((f) => f.uid !== null);
    };
    // 行模块 fiber（include 子树内 entry）→ 自身行名
    const wsBridge = fiberOf('ac-ws-bridge');
    expect(wsBridge && rowOfFiber(ctx, wsBridge)).toBe('ac-ws-bridge');
    // 行内服务 fiber（无自有 entry，继承行 entry 语义）→ 所属行名
    const session = fiberOf('SessionService');
    expect(session && rowOfFiber(ctx, session)).toBe('ac-session');
    // loader 自身（root 直接子、无 entry）不归属任何行
    expect(rowOfFiber(ctx, ctx.fiber as unknown as Fiber)).toBeUndefined();
  });
});
