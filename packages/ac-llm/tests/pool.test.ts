// ============================================================
// ac-llm/tests/pool.test.ts —— 池词汇（config llmProviders 读侧
// 解析）单测：cr-319 自 ac-llm-pool/tests/pool.test.ts 随词汇迁入
// ============================================================
import { describe, it, expect } from 'vitest';
import { normalizePoolModels, defaultPoolConnection, poolFallbackRef } from '../src/pool.ts';

describe('normalizePoolModels（models 数组宽容归一——读侧唯一解析点）', () => {
  it('normalizePoolModels：裸名/对象双形态归一，非法项丢弃、按名去重', () => {
    expect(normalizePoolModels([
      'a',
      { model: 'b', vision: true },
      { model: 'c', hidden: true },
      { model: 'd', vision: 'yes' },   // 非布尔 true → 忽略该标志
      { model: 'e-manual', manual: true }, // 手工条目标志（发现刷新保留语义）
      { model: '' },                    // 空名丢弃
      42, null, 'x',                    // 非法项丢弃
      'a',                              // 重复（首个胜）
    ])).toEqual([
      { model: 'a' },
      { model: 'b', vision: true },
      { model: 'c', hidden: true },
      { model: 'd' },
      { model: 'e-manual', manual: true },
      { model: 'x' },
    ]);
    expect(normalizePoolModels(undefined)).toEqual([]);
  });
});

describe('poolFallbackRef（模型缺省回落单源——cr-313 第四态）', () => {
  it('provider 显式 → 该连接默认模型（defaultModel → 清单降序首项，引用不物化）', () => {
    const pool = {
      alpha: { base_url: 'https://alpha.example/v1', defaultModel: 'a-1' },
      beta: { base_url: 'https://beta.example/v1', defaultModel: 'b-1', default: true },
    };
    expect(poolFallbackRef(pool, 'alpha')).toEqual({ provider: 'alpha', model: 'a-1' });
    expect(poolFallbackRef(pool, 'beta')).toEqual({ provider: 'beta', model: 'b-1' });
  });

  it('provider 未声明 / 条目不存在 / 条目无默认模型 → 全局默认连接回落（fail-open）', () => {
    const pool = {
      alpha: { base_url: 'https://alpha.example/v1', defaultModel: 'a-1', default: true },
      ghost: { base_url: 'https://ghost.example/v1' },
    };
    expect(poolFallbackRef(pool, undefined)).toEqual({ provider: 'alpha', model: 'a-1' });
    expect(poolFallbackRef(pool, 'ghost')).toEqual({ provider: 'alpha', model: 'a-1' });
    expect(poolFallbackRef(pool, 'nonexistent')).toEqual({ provider: 'alpha', model: 'a-1' });
  });

  it('空池/undefined 池 → undefined（fail-closed 兜底留给投递侧）', () => {
    expect(poolFallbackRef(undefined, 'alpha')).toBeUndefined();
    expect(poolFallbackRef({}, 'alpha')).toBeUndefined();
    expect(poolFallbackRef({}, undefined)).toBeUndefined();
  });
});

describe('defaultPoolConnection（「默认/继承全局」物化单源）', () => {
  it('defaultModel 优先；缺省回落 models 可见清单降序首项（≈ 命名最新）', () => {
    // 2026-09-10 反馈场景：自定义提供方做默认连接——只填了连接与清单缓存，
    // 未选默认模型。「默认/继承全局」物化失败 → 建 Agent 报错
    const pool = {
      'my-gw': {
        base_url: 'https://gw.example/v1',
        default: true,
        models: ['glm-4.6', 'glm-5.3', 'glm-4.5'],
      },
    };
    expect(defaultPoolConnection(pool)).toEqual({ provider: 'my-gw', model: 'glm-5.3' });
    // defaultModel 一旦存在即最高优先（不被回落覆盖）
    expect(
      defaultPoolConnection({ 'my-gw': { ...pool['my-gw'], defaultModel: 'glm-4.6' } }),
    ).toEqual({ provider: 'my-gw', model: 'glm-4.6' });
  });

  it('回落跳过 hidden 条目（旧模型归档标记）；全 hidden / 无 models → undefined', () => {
    const hidden = {
      'my-gw': {
        base_url: 'https://gw.example/v1',
        default: true,
        models: [
          { model: 'glm-4.5', hidden: true },
          { model: 'glm-4.6', hidden: true },
          'glm-5.3',
        ],
      },
    };
    expect(defaultPoolConnection(hidden)?.model).toBe('glm-5.3');
    expect(
      defaultPoolConnection({
        'my-gw': { base_url: 'https://gw.example/v1', default: true, models: [{ model: 'a', hidden: true }] },
      }),
    ).toBeUndefined();
    expect(defaultPoolConnection({ 'my-gw': { base_url: 'https://gw.example/v1', default: true } })).toBeUndefined();
  });
});
