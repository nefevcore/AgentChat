// ============================================================
// ac-run-code-core 测试：子调用前置校验（cr-276）
// · 未知名拦截 + 最近名建议（编辑距离）
// · required / enum / additionalProperties:false 未知键
// · 开放 schema 放行（JSON Schema 缺省 = 开放世界）
// ============================================================
import { describe, it, expect } from 'vitest';
import { validateInvoke, PROJECTION_EXCLUDE, buildSdkProjection } from '../src/index.ts';

const DEFS = [
  {
    name: 'read',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'job',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'kill', 'logs'] } },
      required: ['action'],
    },
  },
  {
    name: 'strict',
    parameters: {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    },
  },
  { name: 'open_wild', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
];

describe('validateInvoke', () => {
  it('合法调用放行（undefined）', () => {
    expect(validateInvoke(DEFS, 'read', { file_path: 'a.ts', offset: 3 })).toBeUndefined();
    expect(validateInvoke(DEFS, 'job', { action: 'kill' })).toBeUndefined();
  });

  it('未知工具名拦截 + 最近名建议（typo 自纠）', () => {
    const err = validateInvoke(DEFS, 'raed', { file_path: 'a' });
    expect(err).toContain('未知工具 "raed"');
    expect(err).toContain('read');
  });

  it('缺 required 拦截', () => {
    expect(validateInvoke(DEFS, 'read', { offset: 1 })).toContain('缺必填参数 file_path');
    // undefined 值视同缺参
    expect(validateInvoke(DEFS, 'read', { file_path: undefined })).toContain('缺必填参数 file_path');
  });

  it('enum 错值拦截 + 合法值集回显', () => {
    const err = validateInvoke(DEFS, 'job', { action: 'kil' });
    expect(err).toContain('action="kil"');
    expect(err).toContain('"list" | "kill" | "logs"');
  });

  it('additionalProperties:false 未知键拦截；开放 schema 放行', () => {
    expect(validateInvoke(DEFS, 'strict', { a: 'x', b: 1 })).toContain('无参数 b');
    expect(validateInvoke(DEFS, 'open_wild', { x: 'x', extra: 1 })).toBeUndefined();
  });

  it('无 schema 工具放行', () => {
    expect(validateInvoke([{ name: 'bare' }], 'bare', { whatever: 1 })).toBeUndefined();
  });

  it('enum 非字符串值不误伤（数字 enum 场景缺省跳过）', () => {
    const defs = [{ name: 'n', parameters: { type: 'object', properties: { t: { type: 'number', enum: [1, 2] } } } }];
    expect(validateInvoke(defs, 'n', { t: 1 })).toBeUndefined();
    expect(validateInvoke(defs, 'n', { t: 99 })).toBeUndefined();
  });
});

describe('PROJECTION_EXCLUDE（投影剔除名单）', () => {
  it('含 run_code（递归防护）与 list_tools（回显冗余）', () => {
    expect(PROJECTION_EXCLUDE).toContain('run_code');
    expect(PROJECTION_EXCLUDE).toContain('list_tools');
  });

  it('投影默认剔除名单内工具（端到端一致性）', () => {
    const out = buildSdkProjection([...DEFS, { name: 'run_code' }, { name: 'list_tools' }]);
    expect(out).toContain('read(');
    expect(out).not.toContain('run_code(');
    expect(out).not.toContain('list_tools(');
  });
});
