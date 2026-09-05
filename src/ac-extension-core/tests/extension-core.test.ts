// ============================================================
// ac-extension-core：纯类型契约包冒烟（零运行时导出 + ExtensionMeta 编译期形状）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as core from '../src/index.ts';
import type { ExtensionMeta } from '../src/index.ts';

describe('ac-extension-core', () => {
  it('模块可加载且零运行时导出（纯类型包不得出现运行时导出）', () => {
    // 锁定契约：本包只允许 export interface——一旦有人加运行时导出，此处即红
    expect(core).toBeDefined();
    expect(Object.keys(core)).toEqual([]);
  });

  it('ExtensionMeta：满足接口的对象可构造（字段级形状锁定）', () => {
    const meta: ExtensionMeta = {
      name: 'smoke-extension',
      label: '冒烟扩展',
      description: '满足 ExtensionMeta 的全字段样例（形状校验发生在编译期）',
      automatic: true,
      fields: [
        '裸字符串字段',
        {
          name: 'greeting',
          description: '问候语',
          type: 'string',
          enum: ['你好', '嗨'],
          default: '你好',
        },
        { name: 'limit', description: '上限', type: 'number', min: 1, max: 10, step: 1, default: 5 },
      ],
      listeners: [
        {
          event: 'tool/after-execute',
          role: 'observer',
          description: '观察工具执行结果',
          facet: 'log',
          respectsEnabled: true,
        },
      ],
    };
    // 运行时断言字段即可（编译期形状由上面的类型标注保证）
    expect(meta.name).toBe('smoke-extension');
    expect(meta.label).toBe('冒烟扩展');
    expect(meta.automatic).toBe(true);
    expect(meta.fields?.[1]).toMatchObject({ name: 'greeting', type: 'string' });
    expect(meta.fields?.[2]).toMatchObject({ name: 'limit', type: 'number', min: 1, max: 10, step: 1 });
    expect(meta.listeners?.[0]).toMatchObject({ event: 'tool/after-execute', facet: 'log', respectsEnabled: true });
  });
});
