// ============================================================
// ac-llm-pool/tests/migrate-pool-v2.test.ts —— 池 v2 迁移恒等门
// （scripts/migrate-llm-pool-v2 纯函数：别名合并 / 种子归一 / 幂等 /
// 未解析保留 + agent/singles model 改写语义）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  migratePool,
  resolveAgentModel,
  resolveSingleModelRef,
  resolveOrphanPoolCredentialKeys,
  cleanLegacyLlmRef,
} from '../../scripts/migrate-llm-pool-v2.ts';

describe('migratePool：别名合并', () => {
  it('同 provider 多别名 → 单连接条目（base_url/defaultModel/default 归并）；别名进映射', () => {
    const m = migratePool({
      'ds-flash': { provider: 'deepseek', model: 'deepseek-v4-flash', base_url: 'https://api.deepseek.com/', default: true },
      'ds-pro': { provider: 'deepseek', model: 'deepseek-v4-pro' },
      $note: { v: 1 },
    });
    expect(m.pool).toEqual({
      deepseek: { base_url: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-flash', default: true },
      $note: { v: 1 },
    });
    expect(m.aliases.get('ds-flash')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(m.aliases.get('ds-pro')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(m.changed).toBe(true);
  });

  it('别名并入既有 v2 条目不覆盖显值（defaultModel 已在 → 保留）', () => {
    const m = migratePool({
      deepseek: { base_url: 'https://api.deepseek.com/', defaultModel: 'deepseek-v4-pro', default: true },
      'ds-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
    });
    expect(m.pool.deepseek).toEqual({
      base_url: 'https://api.deepseek.com/',
      defaultModel: 'deepseek-v4-pro',
      default: true,
    });
    expect(m.aliases.get('ds-flash')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' });
  });
});

describe('migratePool：种子归一与幂等', () => {
  it('种子名条目 model 键归一 defaultModel（条目保留 + 别名映射）', () => {
    const m = migratePool({ glm: { model: 'glm-5.3', default: true } });
    expect(m.pool).toEqual({ glm: { defaultModel: 'glm-5.3', default: true } });
    expect(m.aliases.get('glm')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    expect(m.changed).toBe(true);
  });

  it('v2 形态输入 → 幂等（changed=false、零别名）', () => {
    const v2 = {
      myds: { base_url: 'https://my.example/v1', defaultModel: 'my-1', models: ['my-1', 'my-2'], default: true },
      glm: { defaultModel: 'glm-5.3' },
    };
    const m = migratePool(v2);
    expect(m.pool).toEqual(v2);
    expect(m.changed).toBe(false);
    expect(m.aliases.size).toBe(0);
  });

  it('无 provider 且非种子名 → 原样保留 + unresolved 报告', () => {
    const m = migratePool({ weird: { model: 'x-1' } });
    expect(m.pool).toEqual({ weird: { model: 'x-1' } });
    expect(m.unresolved).toEqual(['weird']);
  });
});

describe('resolveAgentModel：档案改写语义', () => {
  const aliases = new Map([
    ['ds-flash', { provider: 'deepseek', model: 'deepseek-v4-flash' }],
  ]);

  it('model = 别名 → 拆写 provider+model（provider 缺省/一致时）', () => {
    expect(resolveAgentModel('ds-flash', undefined, aliases)).toEqual({
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      changed: true,
    });
    expect(resolveAgentModel('ds-flash', 'deepseek', aliases).changed).toBe(true);
  });

  it('显式 provider 与别名目标不同 → 不动（显式优先）', () => {
    const r = resolveAgentModel('ds-flash', 'glm', aliases);
    expect(r).toEqual({ model: 'ds-flash', provider: 'glm', changed: false });
  });

  it('name@model 引用 → 防御性拆分；裸模型名不动', () => {
    expect(resolveAgentModel('glm@glm-5.3', undefined, aliases)).toEqual({
      model: 'glm-5.3',
      provider: 'glm',
      changed: true,
    });
    expect(resolveAgentModel('deepseek-v4-pro', 'deepseek', aliases).changed).toBe(false);
  });
});

describe('resolveSingleModelRef：会话改写语义', () => {
  const aliases = new Map([
    ['ds-flash', { provider: 'deepseek', model: 'deepseek-v4-flash' }],
  ]);

  it('model = 别名 → provider@model 单值引用', () => {
    expect(resolveSingleModelRef('ds-flash', aliases)).toEqual({
      model: 'deepseek@deepseek-v4-flash',
      changed: true,
    });
  });

  it('已是引用形态 / 裸模型名 / 空 → 不动', () => {
    expect(resolveSingleModelRef('glm@glm-5.3', aliases).changed).toBe(false);
    expect(resolveSingleModelRef('glm-5.3', aliases).changed).toBe(false);
    expect(resolveSingleModelRef(undefined, aliases).changed).toBe(false);
  });
});

describe('resolveOrphanPoolCredentialKeys：孤立别名凭据归位（池清空场景）', () => {
  it('别名 = <provider>-<model> 前缀命中种子/池名 → pool:<provider>（大小写归一）', () => {
    const { moves, unresolved } = resolveOrphanPoolCredentialKeys(
      ['__GLOBAL___POOL:DEEPSEEK-V4-FLASH_API_KEY', '__GLOBAL___SEARCHPOOL:DEEPSEEK_API_KEY'],
      [],
    );
    expect(moves.get('__GLOBAL___POOL:DEEPSEEK-V4-FLASH_API_KEY')).toBe('__GLOBAL___POOL:DEEPSEEK_API_KEY');
    expect(unresolved).toEqual([]); // searchpool 键不在处理面
    // glm-5.3 → glm（短横线前缀）
    const glm = resolveOrphanPoolCredentialKeys(['__GLOBAL___POOL:GLM-5.3_API_KEY'], []);
    expect(glm.moves.get('__GLOBAL___POOL:GLM-5.3_API_KEY')).toBe('__GLOBAL___POOL:GLM_API_KEY');
  });

  it('别名本身就是已知 provider（池条目/种子）→ 不动；无前缀命中 → unresolved', () => {
    const { moves, unresolved } = resolveOrphanPoolCredentialKeys(
      ['__GLOBAL___POOL:DEEPSEEK_API_KEY', '__GLOBAL___POOL:MYDS_API_KEY', '__GLOBAL___POOL:MY-OWN-KEY_API_KEY'],
      [],
    );
    expect(moves.size).toBe(0);
    // DEEPSEEK = 种子名（大小写归一）跳过；MYDS 无池条目、无前缀命中 → 孤立
    expect(unresolved).toEqual(['__GLOBAL___POOL:MYDS_API_KEY', '__GLOBAL___POOL:MY-OWN-KEY_API_KEY']);
    // 池条目名也参与前缀匹配
    const withPool = resolveOrphanPoolCredentialKeys(['__GLOBAL___POOL:MYDS-PRO_API_KEY'], ['myds']);
    expect(withPool.moves.get('__GLOBAL___POOL:MYDS-PRO_API_KEY')).toBe('__GLOBAL___POOL:MYDS_API_KEY');
  });
});

describe('cleanLegacyLlmRef：全局 llm 死引用清理', () => {
  it('$ref 指向已消失条目 → 删除键；指向现存条目/显式内嵌对象 → 保留', () => {
    const dead = { llm: { $ref: 'deepseek-v4-flash' }, other: 1 };
    expect(cleanLegacyLlmRef(dead, { deepseek: {} })).toBe(true);
    expect(dead).toEqual({ other: 1 });
    expect(dead.llm).toBeUndefined();

    const alive = { llm: { $ref: 'deepseek' } };
    expect(cleanLegacyLlmRef(alive, { deepseek: {} })).toBe(false);
    expect(alive.llm).toEqual({ $ref: 'deepseek' });

    const explicit = { llm: { provider: 'openai' } };
    expect(cleanLegacyLlmRef(explicit, {})).toBe(false);
    expect(cleanLegacyLlmRef({ searchProviders: {} }, {})).toBe(false);
  });
});
