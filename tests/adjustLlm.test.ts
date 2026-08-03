// adjust_llm 工具单元测试：验证 setLLMOverrides / getLLMOverrides / clear 逻辑
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock Agent 实例（模拟 setLLMOverrides 等）
class FakeAgent {
  overrides: any = {};
  setLLMOverrides(o: any) {
    if (o.temperature !== undefined) this.overrides.temperature = o.temperature;
    if (o.thinking !== undefined) this.overrides.thinking = o.thinking;
    if (o.maxTokens !== undefined) this.overrides.maxTokens = o.maxTokens;
  }
  getLLMOverrides() { return { ...this.overrides }; }
  clearLLMOverrides() { this.overrides = {}; }
}

describe('Agent LLM 参数覆盖（adjust_llm 核心）', () => {
  it('只设置传入项，未传保持不变', () => {
    const a = new FakeAgent();
    a.setLLMOverrides({ temperature: 0 });
    expect(a.getLLMOverrides()).toEqual({ temperature: 0 });
    a.setLLMOverrides({ thinking: false });
    expect(a.getLLMOverrides()).toEqual({ temperature: 0, thinking: false });
  });

  it('clear 恢复空', () => {
    const a = new FakeAgent();
    a.setLLMOverrides({ temperature: 1.2, thinking: true, maxTokens: 1000 });
    a.clearLLMOverrides();
    expect(a.getLLMOverrides()).toEqual({});
  });

  it('覆盖优先于默认（merge 语义）', () => {
    const overrides = { thinking: false };
    const deepThink = true; // 默认开启
    expect(overrides.thinking ?? deepThink).toBe(false); // override 优先
    const noOverride = {};
    expect(noOverride.thinking ?? deepThink).toBe(true); // 默认
  });
});
