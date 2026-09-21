// ============================================================
// ac-tag-registry/tests/tag-registry.test.ts —— 标签注册中心
//
// · 采集：tool/registered 事件（ac-tools 发出）→ tag → 消费工具清单
// · 预注册：base / 档位词（full-access/sandbox-access）启动即在场
// · 分类：owner（agent:<id>）不进目录；reserved 词带描述
// · 断言：档位词进 requiredTags → assertNoTierInToolRequirements 抛错
// · 装载序无关：工具行先注册、tag-registry 后装载也能补齐目录
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as tagRegistryRow from '../src/index';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

interface BootOpts {
  /** 预注册的工具（在 tag-registry 行装载前注册——测装载序无关） */
  preTools?: Array<{ name: string; requiredTags?: string[]; description?: string }>;
  /** 挂一个带 tagDeclarations 自述的内联行（测手工声明扫描） */
  declRow?: { name: string; tagDeclarations: unknown[] };
}

async function boot(opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [toolsRow];
  // 预注册工具挂在一个独立 fiber 上（owner = 行名 → 目录 owner 字段）；
  // 内联插件须声明 inject——cordis 门禁：未声明服务的插件触 ctx.tools 抛错
  if (opts.preTools?.length) {
    fibers.push(await ctx.plugin({
      name: 'fake-tool-row',
      inject: ['tools'],
      apply(c: Context) {
        for (const t of opts.preTools!) {
          c.tools.register({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.requiredTags ? { requiredTags: t.requiredTags } : {}),
            execute: () => ({ ok: true }),
          });
        }
      },
    }));
  }
  // 手工声明行（tagDeclarations 自述——registry 扫描面）。内联插件须带
  // apply（cordis 形状要求）；tagDeclarations 挂在插件对象上，registry 的
  // Runtime.plugin 即本对象（与行包入口 export const tagDeclarations 同构）
  if (opts.declRow) {
    fibers.push(await ctx.plugin({
      name: opts.declRow.name,
      tagDeclarations: opts.declRow.tagDeclarations,
      apply() {},
    } as any));
  }
  rows.push(tagRegistryRow);
  for (const row of rows) fibers.push(await ctx.plugin(row as any));
  const entry = { ctx, fibers };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-tag-registry 目录', () => {
  it('预注册：能力族与档位词启动即在场（base 已退役——全量标签化 2026-09-16）', async () => {
    const { ctx } = await boot();
    const tags = ctx.tagRegistry.catalog();
    const byTag = new Map(tags.map((t) => [t.tag, t]));
    expect(byTag.get('fs')).toMatchObject({ category: 'capability', reserved: true });
    expect(byTag.get('collab')).toMatchObject({ category: 'capability', reserved: true });
    expect(byTag.get('infra')).toMatchObject({ category: 'capability', reserved: true });
    expect(byTag.get('history')).toMatchObject({ category: 'capability', reserved: true });
    expect(byTag.get('full-access')).toMatchObject({ category: 'access-tier', reserved: true });
    expect(byTag.get('sandbox-access')).toMatchObject({ category: 'access-tier', reserved: true });
    // 工具调用模式词（tc-* 标签轴——toolModeOf 消费；tc-programmatic 是
    // 唯一被 requiredTags 合法引用的非能力词）
    expect(byTag.get('tc-programmatic')).toMatchObject({ category: 'tool-mode', reserved: true });
    expect(byTag.get('tc-none')).toMatchObject({ category: 'tool-mode', reserved: true });
    expect(byTag.get('tc-base')).toMatchObject({ category: 'tool-mode', reserved: true });
    // base 从目录退役（无门禁语义——一切工具已挂具体标签）
    expect(byTag.get('base')).toBeUndefined();
    // 抉择组（2026-12 标签配置语义升级）：档位/模式两组显式缺省词
    // （base-access 进目录——下拉需要；tc-base 既有）+ exclusive 元数据
    expect(byTag.get('base-access')).toMatchObject({
      category: 'access-tier',
      reserved: true,
      exclusive: 'access-tier',
      exclusiveNone: true,
    });
    expect(byTag.get('sandbox-access')?.exclusive).toBe('access-tier');
    expect(byTag.get('full-access')?.exclusive).toBe('access-tier');
    expect(byTag.get('tc-none')).toMatchObject({ exclusive: 'tool-mode' });
    expect(byTag.get('tc-base')).toMatchObject({ exclusive: 'tool-mode', exclusiveNone: true });
    expect(byTag.get('tc-programmatic')?.exclusive).toBe('tool-mode');
  });

  it('采集：工具注册 → tag 目录出现消费工具（AND 组合也如实呈现）', async () => {
    const { ctx } = await boot();
    const dispose = ctx.tools.register({
      name: 't-probe',
      description: '探针工具',
      requiredTags: ['web', 'observe'],
      execute: () => ({ ok: true }),
    });
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(byTag.get('web')?.tools.some((t) => t.name === 't-probe')).toBe(true);
    expect(byTag.get('observe')?.tools.some((t) => t.name === 't-probe')).toBe(true);
    // 无 requiredTags 的工具不产生任何目录条目
    dispose();
  });

  it('预注册词也如实采集消费工具（2026-09-16：能力族解锁计数/工具清单）', async () => {
    const { ctx } = await boot();
    const dispose = ctx.tools.register({
      name: 't-fs-probe',
      description: '文件族探针',
      requiredTags: ['fs'],
      execute: () => ({ ok: true }),
    });
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    const fs = byTag.get('fs');
    expect(fs?.reserved).toBe(true); // 目录语义保留（声明不被覆盖）
    expect(fs?.tools.some((t) => t.name === 't-fs-probe')).toBe(true); // 采集面照常并入
    dispose();
  });

  it('装载序无关：工具行先注册、tag-registry 后装载也能补齐（defs 兜底）', async () => {
    const { ctx } = await boot({
      preTools: [{ name: 't-early', requiredTags: ['shell'], description: '先行工具' }],
    });
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(byTag.get('shell')?.category).toBe('capability');
    // 兜底合成也补 owner
    expect(byTag.get('shell')?.tools.some((t) => t.name === 't-early')).toBe(true);
  });

  it('owner 标签（agent:<id>）不进目录——等 owner 自行声明', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 't-private',
      requiredTags: ['agent:bob'],
      execute: () => ({ ok: true }),
    });
    const tags = ctx.tagRegistry.catalog();
    expect(tags.some((t) => t.tag === 'agent:bob')).toBe(false);
  });

  it('回收：工具 dispose → 目录对应条目消失', async () => {
    const { ctx } = await boot();
    const dispose = ctx.tools.register({
      name: 't-transient',
      requiredTags: ['solo-tag'],
      execute: () => ({ ok: true }),
    });
    expect(ctx.tagRegistry.catalog().some((t) => t.tag === 'solo-tag')).toBe(true);
    dispose();
    expect(ctx.tagRegistry.catalog().some((t) => t.tag === 'solo-tag')).toBe(false);
  });
});

describe('ac-tag-registry 手工声明（A1 注册制）', () => {
  it('行包入口 tagDeclarations 自述 → 目录收词（含层级序与 tier 标记）', async () => {
    const { ctx, fibers } = await boot({
      declRow: {
        name: 'fake-browser-row',
        tagDeclarations: [
          { tag: 'observe', description: '只读族', tools: ['browser'], group: 'Web 与浏览器', order: 1, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
          { tag: 'manipulate', description: '交互族', tools: ['browser'], group: 'Web 与浏览器', order: 2, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
        ],
      },
    });
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(byTag.get('observe')).toMatchObject({ declaredBy: 'fake-browser-row', order: 1, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' });
    expect(byTag.get('manipulate')).toMatchObject({ order: 2, exclusive: 'browser-tier' });
    // 独立分组：group 字段透出（UI 据此聚合成组）
    expect(byTag.get('observe')).toMatchObject({ group: 'Web 与浏览器' });
    // 双源合并：注册面采集的工具并入声明条目（观察浏览器三词的 browser 工具）
    ctx.tools.register({ name: 'browser', requiredTags: ['web', 'observe'], execute: () => ({ ok: true }) });
    const after = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(after.get('observe')?.tools.some((t) => t.name === 'browser')).toBe(true);
    expect(after.get('web')?.tools.some((t) => t.name === 'browser')).toBe(true);
    // 卸载声明行 → 声明词从目录消失（采集词保留）
    await fibers[0].dispose();
    const gone = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(gone.has('manipulate')).toBe(false);
    expect(gone.has('web')).toBe(true);
  });

  it('独立分组：多声明组共存，无 group 声明词仍归通用能力面', async () => {
    const { ctx } = await boot({
      declRow: {
        name: 'multi-group-row',
        tagDeclarations: [
          { tag: 'web', description: 'Web 入口', group: 'Web 与浏览器', order: 0 },
          { tag: 'observe', description: '观察层', group: 'Web 与浏览器', order: 1, tier: true },
          { tag: 'sap-adt', description: 'SAP ADT 工具面' },
        ],
      },
    });
    const byTag = new Map(ctx.tagRegistry.catalog().map((t) => [t.tag, t]));
    expect(byTag.get('web')?.group).toBe('Web 与浏览器');
    expect(byTag.get('observe')?.group).toBe('Web 与浏览器');
    expect(byTag.get('sap-adt')?.group).toBeUndefined(); // 无 group = 通用组
  });

  it('形状不符 / agent: 前缀 / 覆盖预注册词 —— 如实跳过（fail-soft）', async () => {
    const { ctx } = await boot({
      declRow: {
        name: 'bad-decl-row',
        tagDeclarations: [
          { description: '缺 tag' } as never,
          { tag: '', description: '空 tag' },
          { tag: 'agent:bob', description: 'owner 词不收' },
          { tag: 'fs', description: '预注册词不被覆盖' },
        ],
      },
    });
    const tags = ctx.tagRegistry.catalog();
    const byTag = new Map(tags.map((t) => [t.tag, t]));
    expect(byTag.get('fs')?.description).not.toBe('预注册词不被覆盖');
    expect(tags.some((t) => t.declaredBy === 'bad-decl-row')).toBe(false);
  });
});

describe('ac-tag-registry 断言', () => {
  it('非能力词（档位 + 全部 tc-* 模式词）进 requiredTags → assertNoTierInToolRequirements 抛错', async () => {
    const { ctx } = await boot();
    const dispose = ctx.tools.register({
      name: 't-violation',
      requiredTags: ['full-access'],
      execute: () => ({ ok: true }),
    });
    expect(() => ctx.tagRegistry.assertNoTierInToolRequirements()).toThrow(/full-access/);
    dispose();
    expect(() => ctx.tagRegistry.assertNoTierInToolRequirements()).not.toThrow();
  });
});
