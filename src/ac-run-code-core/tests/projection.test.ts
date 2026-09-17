// ============================================================
// ac-run-code-core 测试：SDK 投影纯函数
// · 字典序稳定输出（KV cache 前缀不变量）
// · 递归防护（排除 run_code）
// · JSON Schema → 类型标注（required/可选/枚举/数组/嵌套对象）
// · description → JSDoc（多行/含 */ 转义）
// ============================================================
import { describe, it, expect } from 'vitest';
import { buildSdkProjection, DEFAULT_GUIDANCE } from '../src/index.ts';

const READ = {
  name: 'read',
  description: '读取文本文件\n带行号返回',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径' },
      offset: { type: 'number', minimum: 1 },
    },
    required: ['file_path'],
  },
};

describe('buildSdkProjection', () => {
  it('生成 declare const tools 声明；required 参数必选、其余可选', () => {
    const out = buildSdkProjection([READ]);
    expect(out).toContain('declare const tools: {');
    expect(out).toContain('read(args: { file_path: string; offset?: number | undefined; }): Promise<{ ok: boolean; output?: unknown; error?: string }>;');
  });

  it('字典序稳定：同集不同输入序 → 字节相同（KV cache 前缀不变量）', () => {
    const b = { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } };
    const a1 = buildSdkProjection([READ, b]);
    const a2 = buildSdkProjection([b, READ]);
    expect(a1).toBe(a2);
  });

  it('递归防护：默认排除 run_code 自身', () => {
    const out = buildSdkProjection([READ, { name: 'run_code', description: '自身' }]);
    expect(out).not.toContain('run_code');
  });

  it('enum/数组/嵌套对象/布尔/anyOf 投影', () => {
    const tool = {
      name: 'job',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'kill', 'logs'] },
          tags: { type: 'array', items: { type: 'string' } },
          flags: { type: 'object', properties: { force: { type: 'boolean' } }, required: ['force'] },
          tier: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['action'],
      },
    };
    const out = buildSdkProjection([tool]);
    expect(out).toContain('action: string;');
    expect(out).toContain('tags?: Array<string> | undefined;');
    expect(out).toContain('flags?: { force: boolean; } | undefined;');
    expect(out).toContain('tier?: string | number | undefined;');
  });

  it('description 多行进 JSDoc；含 */ 转义不破注释', () => {
    const out = buildSdkProjection([{ name: 'x', description: '第一行\n中间 */ 危险\n如 **/*.ts' }]);
    expect(out).toContain('/**');
    expect(out).toContain('* 第一行');
    expect(out).toContain('*\\/'); // 转义后（*\/——防注释提前终结）
    expect(out).toContain('**\\/*.ts'); // glob 模式里的 */ 同样被转义保形
  });

  it('guidance 头部注释注入（默认程序书写纪律）', () => {
    const out = buildSdkProjection([READ]);
    expect(out).toContain(DEFAULT_GUIDANCE.split('\n')[0]);
  });

  it('空集与空名防御', () => {
    expect(buildSdkProjection([])).toContain('declare const tools: {');
    expect(buildSdkProjection([{ name: '' } as never, READ])).not.toContain('(: ');
  });
});
