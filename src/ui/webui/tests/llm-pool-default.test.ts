// ============================================================
// applyLlmPoolDefault + sanitizeGlobalConfig(llm 分支) 单测
// 背景 bug（与搜索池同构）：全局 llm 的显式对象（含 GET 展开回写形态）
// 遮蔽模型池 default:true——"设为默认"不生效；saveGlobal 未走 sanitize
// 导致展开对象被原样写回。修复后：池更新同步 $ref、保存折叠 $ref。
// ============================================================
import { describe, expect, it } from 'vitest';
import { applyLlmPoolDefault, sanitizeGlobalConfig } from '../src/settings/schema';

const POOLS = {
  'deepseek-v4-flash': {
    provider: 'deepseek', base_url: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash', reasoning_effort: 'high', thinking: true,
    logprobs: false, tool_choice: 'auto', default: false,
  },
  'glm-5.3': {
    provider: 'glm', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.3', reasoning_effort: 'max', thinking: true, default: true,
  },
};

describe('applyLlmPoolDefault', () => {
  it('核心场景：GET 展开回写的完整对象遮蔽池默认 → 还原为纯 {$ref}', () => {
    // GET /api/config 会把 llm 展开成 {$ref, ...pool}（含掩码 api_key）
    const gc: Record<string, any> = {
      llm: {
        $ref: 'deepseek-v4-flash', provider: 'deepseek', base_url: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash', reasoning_effort: 'high', thinking: true,
        api_key: '••••••••',
      },
    };
    applyLlmPoolDefault(POOLS, gc);
    // 展开对象的全部字段都在目标条目（glm-5.3）之外或是遮蔽字段 → 还原纯 $ref
    expect(gc.llm).toEqual({ $ref: 'glm-5.3' });
  });

  it('旧条目自带的调优字段（值相同）视为展开残留丢弃；真正的用户覆盖保留', () => {
    // deepseek 条目自带 logprobs:false / tool_choice:'auto'（展开混入）；
    // temperature:0.4 与旧条目不同 → 用户覆盖，保留
    const gc: Record<string, any> = {
      llm: {
        $ref: 'deepseek-v4-flash', logprobs: false, tool_choice: 'auto', temperature: 0.4,
      },
    };
    applyLlmPoolDefault(POOLS, gc);
    expect(gc.llm).toEqual({ temperature: 0.4, $ref: 'glm-5.3' });
  });

  it('旧格式字符串引用指向非默认条目 → 跟随默认切换', () => {
    const gc: Record<string, any> = { llm: 'deepseek-v4-flash' };
    applyLlmPoolDefault(POOLS, gc);
    expect(gc.llm).toEqual({ $ref: 'glm-5.3' });
  });

  it('已指向默认（$ref 或字符串）→ 原样不动（含用户覆盖）', () => {
    const gc: Record<string, any> = { llm: { $ref: 'glm-5.3', temperature: 0.3 } };
    const before = gc.llm;
    applyLlmPoolDefault(POOLS, gc);
    expect(gc.llm).toBe(before);
    const gc2: Record<string, any> = { llm: 'glm-5.3' };
    applyLlmPoolDefault(POOLS, gc2);
    expect(gc2.llm).toBe('glm-5.3');
  });

  it('显式对象带条目没有的调优字段 → 切默认时保留该覆盖', () => {
    const gc: Record<string, any> = {
      llm: { provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0.2, max_tokens: 8192 },
    };
    applyLlmPoolDefault(POOLS, gc);
    // provider/model 是遮蔽字段剥离；temperature/max_tokens 条目自带？glm 条目没有 → 保留
    expect(gc.llm).toEqual({ temperature: 0.2, max_tokens: 8192, $ref: 'glm-5.3' });
  });

  it('目标条目自带的调优字段不保留（防旧条目值遮蔽新条目）', () => {
    const gc: Record<string, any> = {
      // 旧默认 deepseek 的 reasoning_effort=high；新默认 glm 自带 max，应丢弃 high
      llm: { $ref: 'deepseek-v4-flash', reasoning_effort: 'high', thinking: true },
    };
    applyLlmPoolDefault(POOLS, gc);
    expect(gc.llm).toEqual({ $ref: 'glm-5.3' });
  });

  it('默认条目被删且引用悬空 → 删除全局 llm（解析层回落池首项）', () => {
    const gc: Record<string, any> = { llm: { $ref: 'glm-5.3' } };
    applyLlmPoolDefault({ 'deepseek-v4-flash': POOLS['deepseek-v4-flash'] }, gc);
    expect(gc.llm).toBeUndefined();
  });

  it('无默认条目但引用完好 → 不动', () => {
    const gc: Record<string, any> = { llm: { $ref: 'deepseek-v4-flash' } };
    const pools = { ...POOLS, 'glm-5.3': { ...POOLS['glm-5.3'], default: false } };
    applyLlmPoolDefault(pools, gc);
    expect(gc.llm).toEqual({ $ref: 'deepseek-v4-flash' });
  });

  it('空池 + 悬空字符串引用 → 删除', () => {
    const gc: Record<string, any> = { llm: 'gone-entry' };
    applyLlmPoolDefault({}, gc);
    expect(gc.llm).toBeUndefined();
  });
});

describe('sanitizeGlobalConfig（llm 分支）', () => {
  it('GET 展开对象（带 $ref）折叠回纯 {$ref}，防回写冻结', () => {
    const out = sanitizeGlobalConfig({
      llm: {
        $ref: 'glm-5.3', provider: 'glm', model: 'glm-5.3',
        reasoning_effort: 'max', api_key: '••••••••',
      },
    });
    expect(out.llm).toEqual({ $ref: 'glm-5.3' });
  });

  it('显式内嵌对象（无 $ref）保留原样——可能是非池的独立 LLM 配置', () => {
    const explicit = { provider: 'openai', base_url: 'https://x/v1', model: 'gpt-4o' };
    const out = sanitizeGlobalConfig({ llm: { ...explicit } });
    expect(out.llm).toEqual(explicit);
  });

  it('旧格式字符串引用保留', () => {
    const out = sanitizeGlobalConfig({ llm: 'glm-5.3' });
    expect(out.llm).toBe('glm-5.3');
  });
});
