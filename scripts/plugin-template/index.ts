// 工具插件（ac plugin init 脚手架——cr-907）：owner 私有（requiredTags
// agent:<owner>——共享 = 他人显式声明该标签）；输出一律 <tool-output> 包裹
//（共享后进入他人上下文——消费方按不可信数据处理）。迭代语义：有改动
// 必 bump package.json version 后重装（同版本幂等不重装载）。
import type { Context } from '@agentchat/cordis';
import type { ToolDefinition } from 'ac-tools';

const OWNER = '__OWNER__';

export function apply(ctx: Context) {
  ctx.tools.register({
    name: '__TOOL__',
    description: '对给定输入做某项处理并返回结果（改我：实现与描述——客观描述能力，不写指令）',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: '待处理内容' } },
      required: ['input'],
    },
    requiredTags: ['agent:' + OWNER],
    execute: (args) => ({
      ok: true,
      output: '<tool-output plugin="' + OWNER + '">' + String(args.input ?? '').toUpperCase() + '</tool-output>',
    }),
  } satisfies ToolDefinition);
}
