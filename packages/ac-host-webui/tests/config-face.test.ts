// ============================================================
// config-face.test.ts —— 全局配置写面词汇（cr-564；cr-1199 域集合
// 参数化：九域 fixture 与生产 row-catalog 聚合同形）
//
// 契约对照主线 ac-web-api config 段：掩码=不动 / ''=删（locked 守卫）/
// 新值=存 / 改名迁移 / 白名单 fail-closed / save 的 replace 语义 / merge
// 的 patch 语义（cr-1173）。落盘端口以内存替身注入（真实凭据加密落盘
// 归 e2e-host-web 的真链路用例）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  API_KEY_MASK,
  assertConfigKey,
  backfillPoolMasks,
  extractPoolCredentials,
  poolProviderKey,
  removeConfigKey,
  mergeConfigDomains,
  saveConfigDomains,
  sanitizeConfigValue,
  writeConfigKey,
  type ConfigDomains,
  type ConfigFace,
  type PoolCredentialFace,
} from '../src/config-face.ts';

/** 可写域集合（cr-1199：与 row-catalog.json configDomains 聚合同形） */
const DOMAINS: ConfigDomains = new Set([
  'llm', 'llmProviders', 'searchProviders', 'source', 'timer', 'tool', 'ui', 'session', 'settings',
]);

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
  return writeConfigKey(face, creds, DOMAINS, key, value);
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

  it('域集合外键 fail-closed（set / delete / merge 同口径）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => write(face, creds, 'sessions', {})).toThrow(/可写域集合/);
    expect(() => removeConfigKey(face, DOMAINS, 'sessions')).toThrow(/可写域集合/);
    expect(() => mergeConfigDomains(face, creds, DOMAINS, { sessions: {} })).toThrow(/可写域集合/);
    expect(() => assertConfigKey(DOMAINS, 'llmProviders')).not.toThrow();
    expect(() => assertConfigKey(DOMAINS, 'settings.plugin')).not.toThrow();
    // cr-1168：source 域（fs-source roots——读面在 ac-source-core）
    expect(() => assertConfigKey(DOMAINS, 'source')).not.toThrow();
    expect(() => assertConfigKey(DOMAINS, 'source.fs')).not.toThrow();
    write(face, creds, 'source', { fs: { roots: [{ id: 'docs', root: 'D:/x' }], cadence: '60s' } });
    expect((face.data.source as { fs: { roots: unknown[] } }).fs.roots).toHaveLength(1);
  });

  it('空域集合 fail-closed（未注册即不可写——cr-1199 注册化语义）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => writeConfigKey(face, creds, new Set(), 'llmProviders', {})).toThrow(/可写域集合/);
    expect(() => assertConfigKey(new Set(), 'settings')).toThrow(/可写域集合/);
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
    face.data.llmProviders = { old: { base_url: 'https://x', model: 'm' } };
    const creds = new MemoryCredentials();
    creds.set('POOL:old', 'sk-1');
    write(face, creds, 'llmProviders', { newname: { base_url: 'https://x', model: 'm', api_key: API_KEY_MASK } });
    expect(creds.get('POOL:newname')).toBe('sk-1');
    expect(creds.get('POOL:old')).toBe('');
  });
});

describe('config-face：save 的 replace 语义 / merge 的 patch 语义', () => {
  it('save：payload 缺的注册域删除、非注册域不动', () => {
    const face = new MemoryConfig();
    face.data.llmProviders = { a: { base_url: 'https://a' } };
    face.data.settings = { devMode: true };
    face.data.internalKey = { x: 1 };
    const creds = new MemoryCredentials();
    const warnings = saveConfigDomains(face, creds, DOMAINS, { llmProviders: { b: { base_url: 'https://b' } } });
    expect(warnings).toEqual([]);
    expect(face.data.llmProviders).toEqual({ b: { base_url: 'https://b' } });
    expect(face.data.settings).toBeUndefined(); // 注册域缺 = 删（replace）
    expect(face.data.internalKey).toEqual({ x: 1 }); // 非注册域 = 不动
  });

  it('save：非对象 payload fail', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => saveConfigDomains(face, creds, DOMAINS, 'not-an-object')).toThrow(/config/);
    expect(() => saveConfigDomains(face, creds, DOMAINS, [])).toThrow(/config/);
  });

  it('merge（cr-1173）：未涉及域幸存（事故面断言）', () => {
    const face = new MemoryConfig();
    face.data.llmProviders = { glm: { base_url: 'https://x' } };
    face.data.searchProviders = { tav: { provider: 'tavily' } };
    face.data.settings = { devMode: false };
    const creds = new MemoryCredentials();
    const warnings = mergeConfigDomains(face, creds, DOMAINS, { source: { fs: { roots: [{ id: 'news', root: 'C:/y' }] } } });
    expect(warnings).toEqual([]);
    expect(face.data.source).toEqual({ fs: { roots: [{ id: 'news', root: 'C:/y' }] } });
    expect(face.data.llmProviders).toEqual({ glm: { base_url: 'https://x' } }); // 幸存
    expect(face.data.searchProviders).toEqual({ tav: { provider: 'tavily' } }); // 幸存
    expect(face.data.settings).toEqual({ devMode: false }); // 幸存
  });

  it('merge：白名单外域拒 / 非对象拒', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    expect(() => mergeConfigDomains(face, creds, DOMAINS, { appInternal: { x: 1 } })).toThrow(/可写域集合/);
    expect(() => mergeConfigDomains(face, creds, DOMAINS, 'nope')).toThrow(/config/);
  });

  it('merge：侧信道同源（api_key 提取 + 掩码保持）', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    creds.set('POOL:glm', 'sk-keep');
    mergeConfigDomains(face, creds, DOMAINS, { llmProviders: { glm: { api_key: API_KEY_MASK, model: 'm' }, ds: { api_key: 'sk-new' } } });
    expect(creds.get('POOL:glm')).toBe('sk-keep'); // 掩码 = 不动
    expect(creds.get('POOL:ds')).toBe('sk-new'); // 新值 = 存
    expect(face.data.llmProviders).toEqual({ glm: { model: 'm' }, ds: {} }); // key 剥离
  });
});

describe('config-face：读面掩码回填 / sanitize 纯函数', () => {
  it('backfillPoolMasks：凭据在场 = 掩码、缺席 = 空串', () => {
    const creds = new MemoryCredentials();
    creds.set('POOL:a', 'sk-1');
    const config = { llmProviders: { a: { base_url: 'x' }, b: { base_url: 'y' } } };
    backfillPoolMasks(creds, config);
    expect(config.llmProviders.a).toEqual({ base_url: 'x', api_key: API_KEY_MASK });
    expect(config.llmProviders.b).toEqual({ base_url: 'y', api_key: '' });
  });

  it('sanitizeConfigValue：递归剥离对象字段位掩码（数组元素位保留——现状语义）', () => {
    expect(sanitizeConfigValue({ a: { api_key: API_KEY_MASK, x: 1 }, nested: { api_key: API_KEY_MASK } })).toEqual({ a: { x: 1 }, nested: {} });
  });

  it('poolProviderKey：域 → provider 名', () => {
    expect(poolProviderKey('llm', 'deepseek')).toBe('POOL:deepseek');
    expect(poolProviderKey('search', 'tavily')).toBe('SEARCHPOOL:tavily');
  });
});

describe('config-face：extractPoolCredentials 边界', () => {
  it('非池域键原样透传', () => {
    const face = new MemoryConfig();
    const creds = new MemoryCredentials();
    const out = extractPoolCredentials(face.all(), creds, 'settings', { devMode: true });
    expect(out).toEqual({ devMode: true });
  });
});
