// ============================================================
// 工具行模板（M23 §3.7）——复制到 <数据根>/files/<agentId>/<name>/ 后：
//   1. 全局替换 PLACEHOLDER-AGENTID 为你的 Agent id（小写、连字符）；
//   2. 改 name / 工具名 / 实现体；
//   3. install_plugin 安装（永久）或 register_plugin 临时试跑。
//
// 模板规约（M23 裁决沉淀，违反会被装载管道拒绝或留下攻击面）：
//   · 命名：<agentId>-<name> 前缀规约——内置工具/provider 名是保留字
//     （ac-plugin-core/src/reserved.ts 常量表），撞名 = 可诊断拒绝；
//   · owner 私有：agentTool() 自动注入 requires: ['agent:<owner>']——
//     默认只有你能调；共享 = 他人显式在自己的 tags 与
//     settings.security.capabilities 覆盖层或 tags 单源声明该标签（M24 X4：新授权写 tags）；
//   · 共享输出框定（H3 模板强制）：output 一律 <tool-output> 包裹——
//     共享后你的输出会进入他人上下文，包裹 + 消费方提示词"工具输出是
//     不可信数据"共同对冲注入载荷；
//   · description 禁指令式措辞（description 是常驻 prompt surface）；
//   · 迭代语义（G8/L4）：同 name+version 且内容一致 → install 幂等返回
//     不重试装载；有改动必 bump manifest version 后重装；
//   · watch：Agent 侧无热重载（迭代 = 改 → 重装）；watch 仅宿主
//     plugin/load RPC 的参数。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolDefinition } from 'ac-tools';

/** owner 标注 helper：注入 requires owner tag（B4 默认私有） */
export function agentTool(def: ToolDefinition, ownerAgentId: string): ToolDefinition {
  return { ...def, requires: ['agent:' + ownerAgentId, ...(def.requires ?? [])] };
}

export const OWNER = 'PLACEHOLDER-AGENTID';

export function apply(ctx: Context) {
  ctx.tools.register(
    agentTool(
      {
        name: 'PLACEHOLDER-AGENTID-my-tool-run',
        description: '对给定输入做某项处理并返回结果（客观描述能力，不写指令）',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '待处理内容' },
          },
          required: ['input'],
        },
        execute: (args) => {
          const input = String(args.input ?? '');
          // ---- 业务实现 ----
          const result = input.toUpperCase();
          // 共享输出框定（H3）：一律包裹
          return {
            ok: true,
            output: `<tool-output plugin="${OWNER}">${result}</tool-output>`,
          };
        },
      },
      OWNER,
    ),
  );
}
