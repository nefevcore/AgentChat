import { describe, it, expect } from 'vitest';
import { OpenAIChatLLM } from '../src/core/llm/openai';
import { DeepSeekChatLLM } from '../src/core/llm/deepseek';

/**
 * postProcessBodyJson 回归测试（2026-08-02 neko 实测触发）：
 * DeepSeek 网关 parser 解码 "\\" 后贪婪消费后续转义，把 "\\xampp"（JSON.stringify
 * 对字面反斜杠+x 的输出）误判为 hex escape → 400 "unexpected end of hex escape"。
 * DeepSeek 覆写 postProcessBodyJson 将 \\ 替换为 \u005c（语义等价）以规避。
 */

const cases: Array<{ name: string; content: string }> = [
  { name: 'Windows 路径 C:\\xampp', content: 'C:\\xampp' },
  { name: '正则 \\x1b 转义', content: '正则 \\x1b 转义' },
  { name: '普通反斜杠+反斜杠x 混合', content: 'C:\\temp\\xfile' },
  { name: '双反斜杠+x', content: 'a\\\\xb' },
  { name: '真实控制字符（不应被替换）', content: '换行\n和\t制表符' },
  { name: '字面 \\u 序列', content: '\\u0041 字面' },
  { name: '纯中文无反斜杠', content: '纯中文内容' },
];

function buildBodyJson(content: string): string {
  return JSON.stringify({ model: 'test', messages: [{ role: 'user', content }] });
}

describe('DeepSeekChatLLM.postProcessBodyJson', () => {
  const llm = new DeepSeekChatLLM({ apiKey: 'sk-test', model: 'deepseek-v4-flash' });

  for (const c of cases) {
    it(`${c.name} —— 语义等价且消除 \\x 误判源`, () => {
      const raw = buildBodyJson(c.content);
      const safe = (llm as any).postProcessBodyJson(raw);
      // 1. 语义等价：替换后解析结果与原解析一致
      expect(JSON.parse(safe).messages[0].content).toBe(JSON.parse(raw).messages[0].content);
      // 2. 请求体本身仍是合法 JSON
      expect(() => JSON.parse(safe)).not.toThrow();
      // 3. 不再出现 "\\x"（含反斜杠+x 文本）——DeepSeek 网关误判源已消除
      expect(safe).not.toMatch(/\\\\x/);
    });
  }

  it('JSON 文本层面仅替换字面反斜杠（不破坏控制字符转义）', () => {
    const raw = buildBodyJson('换行\n制表\t');
    const safe = (llm as any).postProcessBodyJson(raw);
    // 控制字符仍是 \n \t 短转义（未被替换为 \u005c）
    expect(safe).toContain('\\n');
    expect(safe).toContain('\\t');
  });
});

describe('OpenAIChatLLM.postProcessBodyJson', () => {
  it('默认原样返回（不影响其他 provider）', () => {
    const llm = new OpenAIChatLLM({ apiKey: 'sk-test', model: 'gpt-4o' });
    const raw = buildBodyJson('C:\\xampp');
    expect((llm as any).postProcessBodyJson(raw)).toBe(raw);
  });
});
