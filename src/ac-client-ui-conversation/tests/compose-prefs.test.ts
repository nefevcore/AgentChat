// ============================================================
// ac-client-ui-conversation/tests/compose-prefs.test.ts ——
// 输入栏组合偏好持久化（composePrefs）单测
//
// 场景：上次会话的四项选择（Agent/预设 · 模型 · 思考强度 · 提权）
// 记入 localStorage 单键 agentchat.composePrefs，新开会话回放。
// node 环境（无 localStorage）→ 测试内注入内存桩（模块在 import 时
// 捕获 globalThis.localStorage，故桩须先于被测模块注入——动态 import）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';

/** 内存 localStorage 桩（Map 语义） */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

let storage: MemoryStorage;
let prefs: typeof import('../client/composePrefs.ts');

beforeAll(async () => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  prefs = await import('../client/composePrefs.ts');
});

describe('composePrefs：上次会话选择持久化', () => {
  it('无记录 → load 返回 null（各控件走缺省值）', () => {
    storage.clear();
    expect(prefs.loadComposePrefs()).toBeNull();
  });

  it('save 键级合并写：逐项写回互不覆盖，load 全量带回', () => {
    storage.clear();
    prefs.saveComposePrefs({ agentId: 'helper', effort: 'low' });
    prefs.saveComposePrefs({ model: 'deepseek@deepseek-chat', elevation: 'full-access' });
    expect(prefs.loadComposePrefs()).toEqual({
      agentId: 'helper',
      model: 'deepseek@deepseek-chat',
      effort: 'low',
      elevation: 'full-access',
    });
  });

  it('合法关闭态：effort ""/elevation "" 是可记录值（回放保持，非缺省值才覆写）', () => {
    storage.clear();
    prefs.saveComposePrefs({ effort: 'max', elevation: 'sandbox-access' });
    prefs.saveComposePrefs({ effort: '', elevation: '' });
    expect(prefs.loadComposePrefs()).toEqual({ effort: '', elevation: '' });
  });

  it('agentId/model 的 "" 同为合法记录值：明确选回默认覆盖旧记录（2026-09 修复——选回默认后新会话跟随，不残留旧模式）', () => {
    storage.clear();
    prefs.saveComposePrefs({ agentId: '__abap_dev__', model: 'glm@glm-5.3' });
    // 会话里明确选回默认预设/默认模型（下拉第一项）
    prefs.saveComposePrefs({ agentId: '' });
    prefs.saveComposePrefs({ model: '' });
    // '' 记录在案（区别于未记录）；消费方（SessionList）据此走缺省路径
    expect(prefs.loadComposePrefs()).toEqual({ agentId: '', model: '' });
  });

  it('wire 宽容：非法档位值/未知键忽略，损坏 JSON → null', () => {
    storage.clear();
    prefs.saveComposePrefs({ effort: 'ultra' as never, elevation: 'root' as never });
    prefs.saveComposePrefs({ agentId: '', model: '' }); // '' = 明确选回默认（合法记录值）
    expect(prefs.loadComposePrefs()).toEqual({ agentId: '', model: '' });
    storage.setItem('agentchat.composePrefs', '{broken json');
    expect(prefs.loadComposePrefs()).toBeNull();
  });

  it('toolMode 回放（2026-09-17 恢复）：三值 + 跟随态都是合法记录值；旧 programmatic 布尔读侧忽略', () => {
    storage.clear();
    prefs.saveComposePrefs({ toolMode: 'tc-programmatic' });
    expect(prefs.loadComposePrefs()).toEqual({ toolMode: 'tc-programmatic' });
    // 明确选回跟随态 → 覆盖旧记录（新会话跟随 Agent tags 档）
    prefs.saveComposePrefs({ toolMode: '' });
    expect(prefs.loadComposePrefs()).toEqual({ toolMode: '' });
    // 非法值忽略（wire 宽容）
    prefs.saveComposePrefs({ toolMode: 'tc-foo' as never });
    expect(prefs.loadComposePrefs()?.toolMode).toBe('');
    // 存量旧键（programmatic 布尔）读侧忽略
    storage.setItem('agentchat.composePrefs', JSON.stringify({ programmatic: true, toolMode: 'tc-none' }));
    expect(prefs.loadComposePrefs()).toEqual({ toolMode: 'tc-none' });
  });

  it('半记录形态：仅 effort 存在（老版本升级场景）', () => {
    storage.clear();
    prefs.saveComposePrefs({ effort: 'high' });
    expect(prefs.loadComposePrefs()).toEqual({ effort: 'high' });
  });
});
