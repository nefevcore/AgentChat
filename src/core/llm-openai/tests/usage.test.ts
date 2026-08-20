import { describe, it, expect } from 'vitest';
import { extractUsage } from '../src/openai';

/**
 * extractUsage 缓存 token 归一化测试：
 *   · GLM 嵌套格式（usage.prompt_tokens_details.cached_tokens，官方对话补全文档）
 *     → hit=cached_tokens、miss=prompt_tokens−cached_tokens（下限 0）
 *   · DeepSeek 顶层格式（prompt_cache_hit/miss_tokens）原样透传
 *   · 两者并存 → DeepSeek 顶层优先（显式语义优先于推导值）
 *   · 无缓存信息（OpenAI 老格式）→ 不产出缓存字段
 *
 * 背景：GLM 上下文缓存（隐式缓存）命中数只在嵌套字段返回，此前适配器
 * 只识别 DeepSeek 顶层字段 → GLM 缓存 token 统计恒为空。
 * 参见: https://docs.bigmodel.cn/api-reference/模型-api/对话补全
 *       https://docs.bigmodel.cn/cn/guide/capabilities/cache
 */

describe('extractUsage —— GLM 嵌套缓存字段', () => {
  it('GLM 格式：cached_tokens → hit，miss = prompt_tokens − cached_tokens', () => {
    // 官方文档响应示例结构
    const u = extractUsage({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(u).toMatchObject({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 400,
    });
  });

  it('GLM cached_tokens=0（首次请求建缓存）：全量未命中', () => {
    const u = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(u?.prompt_cache_hit_tokens).toBe(0);
    expect(u?.prompt_cache_miss_tokens).toBe(1000);
  });

  it('GLM 全量命中：miss=0', () => {
    const u = extractUsage({
      prompt_tokens: 500,
      completion_tokens: 20,
      total_tokens: 520,
      prompt_tokens_details: { cached_tokens: 500 },
    });
    expect(u?.prompt_cache_hit_tokens).toBe(500);
    expect(u?.prompt_cache_miss_tokens).toBe(0);
  });

  it('GLM cached_tokens 超过 prompt_tokens：miss 收敛到 0（防御）', () => {
    const u = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 150 },
    });
    expect(u?.prompt_cache_hit_tokens).toBe(150);
    expect(u?.prompt_cache_miss_tokens).toBe(0);
  });

  it('GLM prompt_tokens_details.cached_tokens 为 null：不产出缓存字段', () => {
    const u = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: null },
    });
    expect(u?.prompt_cache_hit_tokens).toBeUndefined();
    expect(u?.prompt_cache_miss_tokens).toBeUndefined();
  });

  it('GLM 流式末 chunk 携带 usage（含缓存嵌套）同路径归一化', () => {
    // SSE 最后一个 chunk 的 usage 形态（截取 chunk.usage 部分）
    const chunkUsage = {
      prompt_tokens: 2000,
      completion_tokens: 350,
      total_tokens: 2350,
      prompt_tokens_details: { cached_tokens: 1996 },
    };
    const u = extractUsage(chunkUsage);
    expect(u?.prompt_cache_hit_tokens).toBe(1996);
    expect(u?.prompt_cache_miss_tokens).toBe(4);
  });
});

describe('extractUsage —— DeepSeek 顶层缓存字段（回归）', () => {
  it('顶层 hit/miss 原样透传，不做推导', () => {
    const u = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 90,
    });
    expect(u?.prompt_cache_hit_tokens).toBe(10);
    expect(u?.prompt_cache_miss_tokens).toBe(90);
  });

  it('两者并存：DeepSeek 顶层优先（显式语义 > 推导值）', () => {
    const u = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 90,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(u?.prompt_cache_hit_tokens).toBe(10);
    expect(u?.prompt_cache_miss_tokens).toBe(90);
  });
});

describe('extractUsage —— 无缓存信息 / 异常输入', () => {
  it('OpenAI 老格式（无缓存字段）：不产出缓存字段', () => {
    const u = extractUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(u).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(u?.prompt_cache_hit_tokens).toBeUndefined();
    expect(u?.prompt_cache_miss_tokens).toBeUndefined();
  });

  it('null / undefined / 非对象 → undefined', () => {
    expect(extractUsage(null)).toBeUndefined();
    expect(extractUsage(undefined)).toBeUndefined();
    expect(extractUsage('usage')).toBeUndefined();
  });

  it('基本字段缺失兜底为 0', () => {
    const u = extractUsage({ prompt_tokens_details: { cached_tokens: 10 } });
    expect(u).toMatchObject({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 0,
    });
  });
});
