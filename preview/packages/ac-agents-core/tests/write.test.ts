// ============================================================
// ac-agents-core 身份写面词汇测试（cr-542）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  applyConfigPatch,
  changedConfigKeysOf,
  configFromPatch,
  sanitizeAgentInput,
  type AgentConfig,
} from '../src/index.ts';

describe('sanitizeAgentInput', () => {
  it('create：id 按 name 派生 slug，撞名追加序号', () => {
    const patch = sanitizeAgentInput({ name: 'Write Face' }, undefined, {
      idTaken: (id) => id === 'write-face',
    });
    expect(patch.id).toBe('write-face-2');
  });

  it('create：非 ASCII 名回退时基 id（slug 不可得）', () => {
    const patch = sanitizeAgentInput({ name: '风栗' });
    expect(String(patch.id)).toMatch(/^agent-/);
  });

  it('model 引用归一：name@model 拆两字段（provider 显式被引用左段覆盖）', () => {
    const patch = sanitizeAgentInput({ id: 'a', provider: 'openai', model: 'mock@deepseek-chat' });
    expect(patch).toMatchObject({ model: 'deepseek-chat', provider: 'mock' });
  });

  it('model 清除词形 = null 标记；缺 model 不物化默认连接（键缺席）', () => {
    expect(sanitizeAgentInput({ id: 'a', model: '' })).toMatchObject({ model: null });
    expect('model' in sanitizeAgentInput({ id: 'a', name: 'x' })).toBe(false);
  });

  it('白名单 fail-closed：未知键拒绝；tags 非字符串数组拒绝', () => {
    expect(() => sanitizeAgentInput({ id: 'a', apiKey: 'x' })).toThrow(/白名单/);
    expect(() => sanitizeAgentInput({ id: 'a', tags: [1] })).toThrow(/tags/);
  });

  it('update 语义：id 由现值固定，补丁不含未提及键', () => {
    const current: AgentConfig = { id: 'real', name: '原名' };
    const patch = sanitizeAgentInput({ id: 'ignored', description: '新简介' }, current);
    expect(patch).toEqual({ id: 'real', description: '新简介' });
  });
});

describe('applyConfigPatch / changedConfigKeysOf', () => {
  const current: AgentConfig = { id: 'a', model: 'm', settings: { timer: { x: 1, y: 2 } } };

  it('null 删键（键存在性有语义——deepMerge 删不掉的出口）', () => {
    const next = applyConfigPatch(current, { model: null });
    expect('model' in next).toBe(false);
  });

  it('嵌套对象深合并（未提及字段不动）', () => {
    const next = applyConfigPatch(current, { settings: { timer: { x: 9 } } });
    expect(next.settings).toEqual({ timer: { x: 9, y: 2 } });
  });

  it('变更键 = 并集比较（删除也报；id 恒不报）', () => {
    const next = applyConfigPatch(current, { model: null, name: 'new' });
    expect(changedConfigKeysOf(
      next as unknown as Record<string, unknown>,
      current as unknown as Record<string, unknown>,
    ).sort()).toEqual(['model', 'name']);
  });

  it('零变更 = 空表（写面不落盘的判据）', () => {
    expect(changedConfigKeysOf(
      current as unknown as Record<string, unknown>,
      current as unknown as Record<string, unknown>,
    )).toEqual([]);
  });

  it('configFromPatch：create 合成丢弃 null 标记', () => {
    const config = configFromPatch({ id: 'x', model: null, provider: 'p' });
    expect(config).toEqual({ id: 'x', provider: 'p' });
  });
});
