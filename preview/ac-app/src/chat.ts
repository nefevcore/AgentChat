// ============================================================
// ac-app/src/chat.ts —— 最小对话 REPL（真实 provider 测试入口）
//
// 用法（仓库根）：
//   DEEPSEEK_API_KEY=sk-... pnpm preview:chat
// 可调 env：CHAT_MODEL（缺省 deepseek-v4-flash）/ CHAT_AGENT（缺省 helper）
//   openai 行：OPENAI_API_KEY（gpt-4o-mini/gpt-4o/gpt-4.1/gpt-5/o3）
//   glm 行：GLM_API_KEY（glm-5.3）
//
// 会话延续：经 ctx.conversation（串行化门 + 内存上下文视图——连续
// deliver 同一 Agent 即连续对话）；流式打印 llm/delta 正文增量。
// 常驻 Agent 放 <root>/agents/<id>/config.json（数据即 Agent，重启
// 经 agents-dir 扫描物化）；本脚本内存注册的 Agent 仅进程内有效。
// ============================================================
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { bootTree } from './index.ts';

// 数据根：缺省锚定启动 cwd（AGENTCHAT_DATA_ROOT，boot 同款约定）；
// chdir 到 preview/ 仅为模块解析便利（bootTree 无 yml 依赖）。
if (!process.env.AGENTCHAT_DATA_ROOT) {
  process.env.AGENTCHAT_DATA_ROOT = process.cwd();
}
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

const MODEL = process.env.CHAT_MODEL ?? 'deepseek-v4-flash';
const AGENT = process.env.CHAT_AGENT ?? 'helper';

const { ctx } = await bootTree();

if (!ctx.agents.has(AGENT)) {
  ctx.agents.register({ id: AGENT, model: MODEL, description: 'REPL 测试 Agent' });
}

// 流式打印（正文增量；思考/工具分片静默——工具轮的中间文本照常流出）
ctx.on('llm/delta', (_input, chunk) => {
  if (chunk.delta) process.stdout.write(chunk.delta);
}, { description: 'CLI 流式打印' });

const providers = ctx.llm.stats().map((s) => `${s.name}[${s.models.join(', ')}]`).join(' · ');
console.log(`就绪：agent=${AGENT} model=${MODEL}`);
console.log(`providers：${providers}`);
console.log('输入消息对话；Ctrl-C（或 EOF）退出。\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  while (true) {
    const line = (await rl.question('you> ')).trim();
    if (!line) continue;
    process.stdout.write(`${AGENT}> `);
    const out = await ctx.conversation.deliver(AGENT, line);
    if (out.kind === 'run') {
      if (out.result.finish === 'error') {
        console.log(`\n[error] ${out.result.error ?? '循环失败'}`);
      } else {
        process.stdout.write('\n\n');
      }
    } else {
      console.log(`[${out.kind}]（消息已受理但未产生回复 run）\n`);
    }
  }
} catch {
  console.log('\n再见');
  process.exit(0);
}
