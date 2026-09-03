// ============================================================
// sanitizeGlobalConfig(llm 分支) 单测
// 池 v2（llm-provider-model-plan）：applyLlmPoolDefault 已退役——连接池
// 默认 = 条目 default:true（服务端 defaultPoolConnection 直读），全局
// llm 引用键不再维护；sanitize 保留存量折叠容错（防展开对象回写冻结）。
// ============================================================
import { describe, expect, it } from 'vitest';
import { sanitizeGlobalConfig } from '../src/settings/schema';

describe('sanitizeGlobalConfig（llm 分支——存量容错）', () => {
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

  it('llmProviders 连接条目的掩码 api_key 剥离（保存不回写打码值）', () => {
    const out = sanitizeGlobalConfig({
      llmProviders: { myds: { base_url: 'https://x/v1', api_key: '••••••••' } },
    });
    expect(out.llmProviders).toEqual({ myds: { base_url: 'https://x/v1' } });
  });
});
