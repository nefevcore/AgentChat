// ============================================================
// ac-client-ui-llm-pool/tests/pool-default-model.test.ts —— 连接默认
// 模型解析与切 Provider 落点单测（cr-312：前端 Agent 面切 Provider
// 「当前生效」不更新——selectLlmProvider 此前对对象形态发现缓存做
// string-only 滤空，自动落模型逻辑永不触发）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { poolDefaultModel, modelOnProviderSwitch } from '../client/poolApi.ts';

/** 对象形态发现缓存（PoolManager 读取清单回写 config 的真实形态）。
 *  版本式命名——降序字典序首项 ≈ 命名最新（与后端 newestVisibleModel
 *  同假设；英文词序命名如 older/newest 不满足字典序，不作夹具） */
const OBJ_ENTRY = { base_url: 'https://x.example/v1', models: [
  { model: 'm-1' },
  { model: 'm-3', vision: true },
  { model: 'm-2', hidden: true },
] };

describe('poolDefaultModel（连接默认模型——与后端 defaultPoolConnection 同口径）', () => {
  it('defaultModel 优先 → 旧别名 model → 可见清单降序首项（hidden 跳过）', () => {
    expect(poolDefaultModel({ ...OBJ_ENTRY, defaultModel: 'd-1' })).toBe('d-1');
    expect(poolDefaultModel({ model: 'legacy-1' })).toBe('legacy-1');
    expect(poolDefaultModel(OBJ_ENTRY)).toBe('m-3');
  });

  it('字符串数组形态（宽容双形态归一）与空/坏形态', () => {
    expect(poolDefaultModel({ models: ['a-2', 'a-1'] })).toBe('a-2');
    expect(poolDefaultModel(undefined)).toBeUndefined();
    expect(poolDefaultModel({ models: 'nope' })).toBeUndefined();
    expect(poolDefaultModel({ models: [{ model: 'only-hidden', hidden: true }] })).toBeUndefined();
  });
});

describe('modelOnProviderSwitch（切 Provider 模型落点）', () => {
  it('当前模型在新连接清单 → 保持（含 hidden——保显语义）', () => {
    expect(modelOnProviderSwitch(OBJ_ENTRY, 'm-1')).toBe('m-1');
    expect(modelOnProviderSwitch(OBJ_ENTRY, 'm-2')).toBe('m-2');
  });

  it('当前模型不在清单（cr-312 根因场景：对象形态缓存不再被滤空）→ 落新连接默认模型', () => {
    expect(modelOnProviderSwitch(OBJ_ENTRY, 'glm-5.3')).toBe('m-3');
    expect(modelOnProviderSwitch({ ...OBJ_ENTRY, defaultModel: 'd-1' }, 'glm-5.3')).toBe('d-1');
  });

  it('model 未选（cur 空/undefined）→ 落新连接默认模型（provider 显式 + model 空 = 无意义态）', () => {
    expect(modelOnProviderSwitch(OBJ_ENTRY, '')).toBe('m-3');
    expect(modelOnProviderSwitch(OBJ_ENTRY, undefined)).toBe('m-3');
    expect(modelOnProviderSwitch({}, undefined)).toBeUndefined();
  });

  it('无清单无默认 → 保持现值（由清单自动读取或连接默认补齐）', () => {
    expect(modelOnProviderSwitch({}, 'glm-5.3')).toBe('glm-5.3');
  });
});
