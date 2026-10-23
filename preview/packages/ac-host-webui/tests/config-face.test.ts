// ============================================================
// config-face.test.ts —— 全局配置写面词汇（cr-564）
//
// 契约对照主线 ac-web-api config 段（web-api.integration.test 的侧信道用例
// 平移）：掩码=不动 / ''=删（locked 守卫）/ 新值=存 / 改名迁移 / 白名单
// fail-closed / save 的 replace 语义。落盘端口以内存替身注入（真实凭据
// 加密落盘归 e2e-host-web 的真链路用例）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  API_KEY_MASK,
  assertConfigKey,
  backfillPoolMasks,
  extractPoolCredentials,
  poolProviderKey,
  removeConfigKey,
  saveConfigDomains,
  sanitizeConfigValue,
  writeConfigKey,
  type ConfigFace,
  type PoolCredentialFace,
} from '../src/config-face.ts';

/** 内存配置面（ctx.config 结构子集——点路径首段即顶层键） */
class MemoryConfig implements ConfigFace {
  data: Record<string, unknown> = {};
  all(): Record<string, unknown> { return JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>; }
  set(key: string, value: unknown): void { this.data[key] = JSON.parse(JSON.stringify(value ?? null)); }
  delete(key: string): void { delete this.data[key]; }
}

/** 内存池凭据面（locked 集模拟换机后不可解密条目） */
class MemoryCredentials implements PoolCredentialFace {
  values = new Map<string, string>();
  locked = new Set<string>();
  get(provider: string): string { return this.locked.has(provider) ? '' : (this.values.get(provider) ?? ''); }
  state(provider: string): 'set' | 'locked' | 'none' {
    if (this.locked.has(provider)) return 'locked';
    return this.values.has(provider) ? 'set' : 'none';
  }
  set(provider: string, value: string): void {
    if (value === '') { this.values.delete(provider); } else { this.values.set(provider, value); }
    this.locked.delete(provider);
  }
}

function write(face: MemoryConfig, creds: MemoryCredentials, key: string, value: unknown): string[] {
  return writeConfigKey(face, creds, key, value);
}

describe('config-face：池 api_key 侧信道（config/set）', () => {
  it('新值 = 存进凭据面、config 里 api_key 被剥离', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    const warnings = write(face, creds, 'llmProviders', { deepseek: { api_key: 'sk-real', base_url: 'https://x' } });
    expect(warnings).toEqual([]);
    expect(creds.get('POOL:deepseek')).toBe('sk-real');
    expect(face.data.llmProviders).toEqual({ deepseek: { base_url: 'https://x' } });
  });

  it('掩码 = 不动（不写、不删）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    creds.set('POOL:deepseek', 'sk-keep');
    write(face, creds, 'llmProviders', { deepseek: { api_key: API_KEY_MASK, base_url: 'https://x' } });
    expect(creds.get('POOL:deepseek')).toBe('sk-keep');
    expect(face.data.llmProviders).toEqual({ deepseek: { base_url: 'https://x' } });
  });

  it('空串 = 删凭据；locked 密文保留并回 warnings', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    creds.set('POOL:openai', 'sk-x');
    creds.set('POOL:glm', 'sk-y');
    creds.locked.add('POOL:glm');
    const warnings = write(face, creds, 'llmProviders', {
      openai: { api_key: '' },
      glm: { api_key: '' },
    });
    expect(creds.get('POOL:openai')).toBe('');
    expect(creds.state('POOL:openai')).toBe('none');
    expect(creds.state('POOL:glm')).toBe('locked');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('glm');
  });

  it('searchProviders 走 searchpool 凭据前缀（与壳侧读取面同形）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    write(face, creds, 'searchProviders', { tavily: { api_key: 'sk-t' } });
    expect(creds.get('SEARCHPOOL:tavily')).toBe('sk-t');
    expect(face.data.searchProviders).toEqual({ tavily: {} });
  });

  it('白名单外键 fail-closed（set / delete 同口径）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => write(face, creds, 'sessions', {})).toThrow(/白名单/);
    expect(() => removeConfigKey(face, 'sessions')).toThrow(/白名单/);
    expect(() => assertConfigKey('llmProviders')).not.toThrow();
    expect(() => assertConfigKey('settings.plugin')).not.toThrow();
  });

  it('value 缺失 fail（不静默删键）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => write(face, creds, 'llmProviders', undefined)).toThrow(/value/);
    expect(face.data.llmProviders).toBeUndefined();
  });
});

describe('config-face：池条目改名迁移（cr-21 语义平移）', () => {
  it('同指纹改名：凭据随名迁移、旧名清空', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    write(face, creds, 'llmProviders', { myds: { api_key: 'sk-x', base_url: 'https://x', models: ['m1'] } });
    write(face, creds, 'llmProviders', { dswork: { api_key: API_KEY_MASK, base_url: 'https://x', models: ['m1'] } });
    expect(creds.get('POOL:dswork')).toBe('sk-x');
    expect(creds.get('POOL:myds')).toBe('');
  });

  it('指纹失配但消失旧名唯一 → 仍迁移（改名同时改字段）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    write(face, creds, 'llmProviders', { a: { api_key: 'sk-a', base_url: 'https://x' } });
    write(face, creds, 'llmProviders', { b: { api_key: API_KEY_MASK, base_url: 'https://y' } });
    expect(creds.get('POOL:b')).toBe('sk-a');
    expect(creds.get('POOL:a')).toBe('');
  });

  it('多个消失旧名且指纹失配 → 不迁移（fail-safe）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    write(face, creds, 'llmProviders', { a: { api_key: 'sk-a', base_url: 'https://x' }, b: { api_key: 'sk-b' } });
    write(face, creds, 'llmProviders', { c: { api_key: API_KEY_MASK, base_url: 'https://z' } });
    expect(creds.get('POOL:c')).toBe('');
    expect(creds.get('POOL:a')).toBe('sk-a');
  });
});

describe('config-face：读面掩码回填', () => {
  it('已设置 → 掩码；未设置 → 空串（前端「已设置」指示）', () => {
    const creds = new MemoryCredentials();
    creds.set('POOL:deepseek', 'sk-real');
    const config: Record<string, unknown> = {
      llmProviders: { deepseek: { base_url: 'https://x' }, zai: { base_url: 'https://y' } },
      searchProviders: { 'ds-search': { provider: 'deepseek' } },
    };
    backfillPoolMasks(creds, config);
    expect(config.llmProviders).toEqual({
      deepseek: { base_url: 'https://x', api_key: API_KEY_MASK },
      zai: { base_url: 'https://y', api_key: '' },
    });
    expect(config.searchProviders).toEqual({ 'ds-search': { provider: 'deepseek', api_key: '' } });
  });
});

describe('config-face：config/save 白名单域 replace 语义', () => {
  it('payload 有的键覆盖、缺的键删除、白名单外键不动', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    face.set('llmProviders', { openai: { base_url: 'https://x' } });
    face.set('timer', { tasks: [{ id: 't1' }] });
    face.set('legacyKey', { keep: true });
    const warnings = saveConfigDomains(face, creds, { llmProviders: { glm: { base_url: 'https://y' } } });
    expect(warnings).toEqual([]);
    expect(face.data.llmProviders).toEqual({ glm: { base_url: 'https://y' } });
    expect(face.data.timer).toBeUndefined(); // 白名单内缺键 = 删除
    expect(face.data.legacyKey).toEqual({ keep: true }); // 白名单外不动
  });

  it('掩码字段先被 sanitize 剥掉 → 该条目不表态（凭据不动）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    creds.set('POOL:glm', 'sk-g');
    saveConfigDomains(face, creds, { llmProviders: { glm: { api_key: API_KEY_MASK, model: 'glm-5.3' } } });
    expect(creds.get('POOL:glm')).toBe('sk-g');
    expect(face.data.llmProviders).toEqual({ glm: { model: 'glm-5.3' } });
  });

  it('真实 key 经 side channel 落凭据、config 剥离', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    saveConfigDomains(face, creds, {
      llmProviders: { glm: { api_key: 'sk-g', model: 'glm-5.3' } },
      searchProviders: { tavily: { api_key: 'sk-t' } },
    });
    expect(creds.get('POOL:glm')).toBe('sk-g');
    expect(creds.get('SEARCHPOOL:tavily')).toBe('sk-t');
    expect(face.data.llmProviders).toEqual({ glm: { model: 'glm-5.3' } });
    expect(face.data.searchProviders).toEqual({ tavily: {} });
  });

  it('参数 config 非对象 fail', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => saveConfigDomains(face, creds, 'not-an-object')).toThrow(/config/);
    expect(() => saveConfigDomains(face, creds, [])).toThrow(/config/);
  });
});

describe('config-face：sanitize 与 provider 名', () => {
  it('sanitize 递归剥离掩码字段（值与掩码相同的字段消失；数组元素原样）', () => {
    expect(sanitizeConfigValue({ a: API_KEY_MASK, b: { c: API_KEY_MASK, d: 1 }, e: [API_KEY_MASK, 2] }))
      .toEqual({ b: { d: 1 }, e: [API_KEY_MASK, 2] });
  });

  it('poolProviderKey：llm → POOL: / search → SEARCHPOOL:', () => {
    expect(poolProviderKey('llm', 'deepseek')).toBe('POOL:deepseek');
    expect(poolProviderKey('search', 'tavily')).toBe('SEARCHPOOL:tavily');
  });
});
