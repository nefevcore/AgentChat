// ============================================================
// @agentchat/toolkit defineTool 单元测试 —— 工具工厂
// （迁移自 src/plugins/define-tool.test.ts）
// ============================================================
import { describe, it, expect } from 'vitest';
import { defineTool } from '../src/define-tool';

describe('defineTool', () => {
  it('自动补全 definition（工具作者只写参数+execute）', () => {
    const t = defineTool({
      name: 'add', label: '加法',
      description: '两数相加',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      execute: async ({ a, b }) => String(a + b),
    });
    expect(t.name).toBe('add');
    expect(t.label).toBe('加法');
    expect(t.ns).toBeUndefined();
    expect(t.definition).toEqual({
      type: 'function',
      function: {
        name: 'add',
        description: '两数相加',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      },
    });
    expect(t.execute).toBeDefined();
    expect(t.extractLabel).toBeUndefined();
  });

  it('ns 可选：设置时透传（仅真实配置点）', () => {
    const t = defineTool({
      name: 'bash', label: '执行命令', ns: 'tool.bash',
      description: '执行命令',
      parameters: {},
      execute: async () => '',
    });
    expect(t.ns).toBe('tool.bash');
  });

  it('execute 可调用', async () => {
    const t = defineTool({
      name: 'add', label: '加法', description: '两数相加',
      parameters: {},
      execute: async ({ a, b }) => String(a + b),
    });
    expect(await t.execute({ a: 1, b: 2 })).toBe('3');
  });

  it('支持 extractLabel', () => {
    const t = defineTool({
      name: 'read', label: '读取', description: '读文件',
      parameters: {},
      execute: async () => '',
      extractLabel: (args) => args.path,
    });
    expect(t.extractLabel?.({ path: '/a/b.txt' })).toBe('/a/b.txt');
  });
});
