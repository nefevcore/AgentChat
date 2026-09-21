// ============================================================
// ac-client-ui-agents/tests/tag-exclusive.test.ts —— 抉择组语义
// 纯模块（collectExclusiveGroups / currentExclusiveTag /
// applyExclusiveChoice）单测：聚合、反解、落词（互斥剔除、
// exclusiveNone 缺省、tier 地板连带）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  collectExclusiveGroups,
  currentExclusiveTag,
  applyExclusiveChoice,
  noneTagOf,
  pickRestoreTag,
  type ExclusiveCatalogItem,
} from '../client/tagExclusive.ts';

/** 三组抉择词的目录形状复刻（与 tag-registry RESERVED / web-tools 声明同元数据） */
const CATALOG: ExclusiveCatalogItem[] = [
  { tag: 'fs', description: '文件族' }, // 普通能力词（不进抉择组）
  { tag: 'base-access', description: '基础档', order: 1, exclusive: 'access-tier', exclusiveNone: true },
  { tag: 'sandbox-access', description: '沙箱档', order: 2, exclusive: 'access-tier' },
  { tag: 'full-access', description: '完全访问档', order: 3, exclusive: 'access-tier' },
  { tag: 'tc-none', description: '无工具档', order: 1, exclusive: 'tool-mode' },
  { tag: 'tc-base', description: '标准档', order: 3, exclusive: 'tool-mode', exclusiveNone: true },
  { tag: 'tc-programmatic', description: '程序化档', order: 2, exclusive: 'tool-mode' },
  { tag: 'web', description: 'Web 入口', order: 0 },
  { tag: 'observe', description: '观察层', order: 1, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
  { tag: 'manipulate', description: '交互层', order: 2, tier: true, exclusive: 'browser-tier', exclusiveOffDesc: '停用后 browser 工具不可见' },
  { tag: 'inject', description: '注入层', order: 3, tier: true, exclusive: 'browser-tier' },
];

describe('collectExclusiveGroups', () => {
  it('按 exclusive 聚组，组内 order 升序；普通词不进组', () => {
    const groups = collectExclusiveGroups(CATALOG);
    expect(groups.map((g) => g.key)).toEqual(['access-tier', 'browser-tier', 'tool-mode']);
    const at = groups.find((g) => g.key === 'access-tier')!;
    expect(at.items.map((i) => i.tag)).toEqual(['base-access', 'sandbox-access', 'full-access']);
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    expect(bt.items.map((i) => i.tag)).toEqual(['observe', 'manipulate', 'inject']);
  });

  it('空目录 / 无抉择词 → 空数组（UI 回落徽章形态）', () => {
    expect(collectExclusiveGroups([])).toEqual([]);
    expect(collectExclusiveGroups([{ tag: 'fs' }, { tag: 'web' }])).toEqual([]);
  });

  it('offDesc 聚合：无缺省词组取组内首个 exclusiveOffDesc；有缺省词组不取（描述 = 缺省词自身）', () => {
    const groups = collectExclusiveGroups(CATALOG);
    expect(groups.find((g) => g.key === 'browser-tier')?.offDesc).toBe('停用后 browser 工具不可见');
    expect(groups.find((g) => g.key === 'access-tier')?.offDesc).toBeUndefined();
    expect(groups.find((g) => g.key === 'tool-mode')?.offDesc).toBeUndefined();
  });
});

describe('currentExclusiveTag', () => {
  it('组内词在册 → 该词；无 → exclusiveNone 缺省词', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const at = groups.find((g) => g.key === 'access-tier')!;
    expect(currentExclusiveTag(at, ['fs', 'sandbox-access'])?.tag).toBe('sandbox-access');
    expect(currentExclusiveTag(at, ['fs'])?.tag).toBe('base-access'); // 缺省反解
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    expect(currentExclusiveTag(bt, ['inject'])?.tag).toBe('inject');
    expect(currentExclusiveTag(bt, ['web'])).toBeNull(); // 无缺省词 → 真「都不选」
  });

  it('多词并存（手工编辑旧态）→ 取 items 序最后一个命中（与判定优先序解耦）', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    // items 序 = observe(1) manipulate(2) inject(3)：同持 observe+inject → 反解 inject
    expect(currentExclusiveTag(bt, ['observe', 'inject'])?.tag).toBe('inject');
  });
});

describe('applyExclusiveChoice', () => {
  it('选普通词：剔除组内全部词后写入所选；组外词原样保留', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const at = groups.find((g) => g.key === 'access-tier')!;
    const next = applyExclusiveChoice(at, ['fs', 'full-access'], 'sandbox-access');
    expect([...next].sort()).toEqual(['fs', 'sandbox-access']);
  });

  it('选 exclusiveNone 缺省词（base-access / tc-base）：仅剔除，不写入——wire 语义不变', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const at = groups.find((g) => g.key === 'access-tier')!;
    expect(applyExclusiveChoice(at, ['fs', 'full-access'], 'base-access')).toEqual(['fs']);
    const tm = groups.find((g) => g.key === 'tool-mode')!;
    expect(applyExclusiveChoice(tm, ['fs', 'tc-none'], 'tc-base')).toEqual(['fs']);
  });

  it('选 null（关闭）：仅剔除（browser-tier 无缺省词的真关闭态）', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    expect(applyExclusiveChoice(bt, ['fs', 'observe', 'manipulate'], null)).toEqual(['fs']);
  });

  it('tier 地板连带：选高层词连带写齐全部低层词（requiredTags AND 地板 + tier=max 门禁语义）', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    // 选 manipulate → 连带 observe（browser 工具可见性地板）
    expect([...applyExclusiveChoice(bt, ['web'], 'manipulate')].sort()).toEqual(['manipulate', 'observe', 'web']);
    // 选 inject → 连带 observe+manipulate（tier=max 门禁语义：低层全含）
    expect([...applyExclusiveChoice(bt, ['observe'], 'inject')].sort()).toEqual(['inject', 'manipulate', 'observe']);
    // 选最低层 observe：无地板需连带
    expect([...applyExclusiveChoice(bt, ['web'], 'observe')].sort()).toEqual(['observe', 'web']);
  });

  it('组外词传入：不落（防误写）', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const at = groups.find((g) => g.key === 'access-tier')!;
    expect(applyExclusiveChoice(at, ['fs'], 'tc-none')).toEqual(['fs']);
  });
});

describe('胶囊启停辅助（noneTagOf / pickRestoreTag）', () => {
  it('noneTagOf：组缺省词（exclusiveNone）；无 → null', () => {
    const groups = collectExclusiveGroups(CATALOG);
    expect(noneTagOf(groups.find((g) => g.key === 'access-tier')!)).toBe('base-access');
    expect(noneTagOf(groups.find((g) => g.key === 'tool-mode')!)).toBe('tc-base');
    expect(noneTagOf(groups.find((g) => g.key === 'browser-tier')!)).toBeNull();
  });

  it('pickRestoreTag：restore 命中且非缺省 → 用之；否则组内 order 最小非缺省词', () => {
    const groups = collectExclusiveGroups(CATALOG);
    const at = groups.find((g) => g.key === 'access-tier')!;
    expect(pickRestoreTag(at, 'full-access')).toBe('full-access');
    expect(pickRestoreTag(at, 'base-access')).toBe('sandbox-access'); // 缺省词不作恢复目标 → 首档
    expect(pickRestoreTag(at)).toBe('sandbox-access');
    const tm = groups.find((g) => g.key === 'tool-mode')!;
    expect(pickRestoreTag(tm)).toBe('tc-none'); // order 1 非缺省
    const bt = groups.find((g) => g.key === 'browser-tier')!;
    expect(pickRestoreTag(bt)).toBe('observe');
    expect(pickRestoreTag(bt, 'inject')).toBe('inject');
  });
});
