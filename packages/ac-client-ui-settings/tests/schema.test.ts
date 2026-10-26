// ============================================================
// ac-client-ui-settings/tests/schema.test.ts —— schema 归一化与
// 池默认同步纯函数锁定（此前仅 webui 侧 llm/search-pool-default
// 覆盖 sanitize/applySearchPoolDefault 一角，归一化面零包内锚定）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  toFields, filterFields, parseNum, formatRatio,
  sanitizeGlobalConfig, applySearchPoolDefault,
} from '../client/schema.ts';

describe('toFields：双格式归一化 → FieldMeta[]', () => {
  it('数组格式（后端 llm/search——带 name）归一化；已是 FieldMeta 原样', () => {
    const arr = toFields([
      { name: 'temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'stop', label: '停止词', type: 'text' }, // 已归一化形态直通
    ]);
    expect(arr.map((f) => f.key)).toEqual(['temperature', 'stop']);
    expect(arr[0]).toMatchObject({ label: '温度', min: 0, max: 2, step: 0.1 });
  });

  it('对象格式（旧插件）归一化：键→key；_label/$comment 剔除；options 双形态统一', () => {
    const obj = toFields({
      _label: { label: '分节头' },
      '$comment': '注释键不进字段表',
      model: { label: '模型', type: 'text' },
      depth: { label: '深度', type: 'select', options: ['basic', { label: '高级', value: 'advanced' }] },
    });
    expect(obj.map((f) => f.key)).toEqual(['model', 'depth']);
    expect(obj[1].options).toEqual([
      { label: 'basic', value: 'basic' },
      { label: '高级', value: 'advanced' },
    ]);
  });

  it('非对象输入返回空表（null/undefined/字符串）', () => {
    expect(toFields(null)).toEqual([]);
    expect(toFields('x')).toEqual([]);
  });
});

describe('filterFields：showWhen 条件 + 搜索', () => {
  const fields = toFields({
    a: { label: '深度', type: 'text', showWhen: { provider: 'tavily' } },
    b: { label: 'Key', type: 'password' },
  });
  it('showWhen 不满足 → 隐藏；满足 → 显示', () => {
    expect(filterFields(fields, { provider: 'deepseek' }, '').map((f) => f.key)).toEqual(['b']);
    expect(filterFields(fields, { provider: 'tavily' }, '').map((f) => f.key)).toEqual(['a', 'b']);
  });
  it('搜索命中 label 或 key（大小写不敏感）', () => {
    expect(filterFields(fields, { provider: 'tavily' }, '深度').map((f) => f.key)).toEqual(['a']);
    expect(filterFields(fields, { provider: 'tavily' }, 'KEY').map((f) => f.key)).toEqual(['b']);
  });
});

describe('parseNum / formatRatio', () => {
  it('parseNum：数字串转数值、非数字回退原值', () => {
    expect(parseNum('0.7')).toBe(0.7);
    expect(parseNum('abc')).toBe('abc');
  });
  it('formatRatio：percent 档百分比取整、缺省原样输出', () => {
    expect(formatRatio(0.456, 'percent')).toBe('46%');
    expect(formatRatio(0.456)).toBe('0.456');
    expect(formatRatio(undefined)).toBe('');
  });
});

describe('sanitizeGlobalConfig：保存前归一化', () => {
  it('llm 展开 $ref 对象折叠回紧凑引用；字符串引用保留；内嵌对象保留', () => {
    const out = sanitizeGlobalConfig({
      llm: { $ref: 'main', provider: 'deepseek', api_key: 'sk-x' },
    } as Record<string, any>);
    expect(out.llm).toEqual({ $ref: 'main' });
    expect(sanitizeGlobalConfig({ llm: 'main' }).llm).toBe('main');
    expect(sanitizeGlobalConfig({ llm: { provider: 'x' } }).llm).toEqual({ provider: 'x' });
  });

  it('掩码 api_key（••••••••）清理：顶层 llm / llmProviders 条目 / searchProviders 遗留键', () => {
    const out = sanitizeGlobalConfig({
      llm: { $ref: 'a', api_key: '••••••••' },
      llmProviders: { ds: { api_key: '••••••••' } },
      searchProviders: { tav: { tavilyApiKey: '••••••••' } },
    } as Record<string, any>);
    expect(out.llm).toEqual({ $ref: 'a' });
    expect(out.llmProviders.ds).toEqual({});
    expect(out.searchProviders.tav).toEqual({});
  });
});

describe('applySearchPoolDefault：搜索池「设为默认」同步', () => {
  it('有默认条目 → 全局引用重写为 {$ref}，遮蔽字段剥离、用户调优保留', () => {
    const cfg: Record<string, any> = { 'tool.web_search': { provider: 'tavily', temperature: 3, $ref: 'old' } };
    applySearchPoolDefault({ tav: { provider: 'tavily', default: true } }, cfg);
    expect(cfg['tool.web_search']).toEqual({ temperature: 3, $ref: 'tav' });
  });

  it('无默认条目且引用悬空 → 删除；引用完好 → 不动', () => {
    const cfg: Record<string, any> = { 'tool.web_search': { $ref: 'gone' } };
    applySearchPoolDefault({ a: {} }, cfg);
    expect(cfg['tool.web_search']).toBeUndefined();
    const ok: Record<string, any> = { 'tool.web_search': { $ref: 'live' } };
    applySearchPoolDefault({ live: {} }, ok);
    expect(ok['tool.web_search']).toEqual({ $ref: 'live' });
  });
});