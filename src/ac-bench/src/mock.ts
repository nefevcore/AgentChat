// ============================================================
// ac-bench/src/mock.ts —— 脚本化 mock provider（冒烟/测试用）
//
// 形态：ac-llm 注册薄行（inject ['llm']）。配合 BenchRunOptions.scripted：
//   · 跑批侧把期望调用编码为 [[BENCH_SCRIPT]] 指令块追加进 prompt；
//   · mock 解析指令块 → 首轮吐 tool_calls（走真实 loop 聚合与工具
//     执行链）→ 工具结果回填后吐终文本收束；
//   · 无指令块（反例用例 / 无脚本轮）→ 直接终文本。
// 验证面：注册中心 → agentLoop → llm 路由 → toolCalls 聚合 →
// 工具执行 → 对拍 → 报告——零真实 LLM。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-llm'; // ctx.llm 服务类型 + llm/* 事件目录增强
import type { BenchCallSpec } from './contract.ts';

export const MOCK_PROVIDER = 'bench-mock';
export const MOCK_MODEL = 'bench-mock-model';

const SCRIPT_BEGIN = '[[BENCH_SCRIPT]]';
const SCRIPT_END = '[[/BENCH_SCRIPT]]';

/** 期望规格 → 具体调用（每参数取首个可接受值） */
function specToCall(spec: BenchCallSpec): { name: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(spec.argsSpec ?? {})) {
    if (values.length > 0) args[key] = values[0];
  }
  return { name: spec.name, args };
}

/** 期望调用集 → 指令块（空集 = 空串——反例用例不注入指令） */
export function encodeScript(expected: BenchCallSpec[]): string {
  const calls = expected.map(specToCall).filter((c) => c.name);
  if (calls.length === 0) return '';
  const lines = calls.map((c) => `call ${c.name} ${JSON.stringify(c.args)}`);
  return `${SCRIPT_BEGIN}\n${lines.join('\n')}\n${SCRIPT_END}`;
}

/** 指令块 → 调用清单（无块/坏行 → 空数组） */
export function decodeScript(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const start = text.indexOf(SCRIPT_BEGIN);
  const end = text.indexOf(SCRIPT_END);
  if (start < 0 || end <= start) return [];
  const body = text.slice(start + SCRIPT_BEGIN.length, end);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('call ')) continue;
    const rest = line.slice(5).trim();
    const sp = rest.indexOf(' ');
    if (sp < 0) {
      calls.push({ name: rest, args: {} });
      continue;
    }
    const name = rest.slice(0, sp);
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rest.slice(sp + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      // 坏行跳过
    }
    calls.push({ name, args });
  }
  return calls;
}

/** 脚本化 provider 薄行（测试与 CLI --mock 共用） */
export function scriptedBenchRow() {
  return {
    name: 'ac-bench-mock',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(MOCK_PROVIDER, () => ({
        stream: async function* (input: { messages: Array<{ role: string; content: string }> }) {
          const last = input.messages.at(-1);
          const script = last?.role === 'user' ? decodeScript(last.content) : [];
          if (script.length > 0) {
            yield {
              delta: '',
              toolCalls: script.map((c, i) => ({
                index: i,
                id: `bench_call_${i}`,
                name: c.name,
                argumentsDelta: JSON.stringify(c.args),
              })),
            };
            yield { delta: '', finish: 'tool_calls', usage: { prompt: 10, completion: 5 } };
            return;
          }
          yield { delta: 'BENCH_DONE' };
          yield { delta: '', finish: 'stop', usage: { prompt: 10, completion: 5 } };
        },
      }), { models: [MOCK_MODEL] });
    },
  };
}
