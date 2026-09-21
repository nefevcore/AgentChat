// ============================================================
// ac-run-code/src/index.ts —— run_code 工具行（程序化模式 PTC 内核）
//
// 单工具 run_code（injection:'mode'——模式合成入口，2026-12 injection
// 轴重构：不挂 requiredTags、不进常规工具面；tc-programmatic 档经
// narrowToolsByMode 从注册面直接合成，与 tags 无关、行在装即生效）。
// 档位随父 Agent，子调用逐个走全安全面，故本工具不挂 needPermission：
// 粗信任由子调用细信任实现，裁决 #2。
//
// 激活形态（tc-* 标签轴——工具调用模式与提权档位同构；均纯模式词）：
//   · 并存（tc-base）：Agent 无模式词 → run_code 与传统工具共存
//     （模型按请求面 schema 偶用；SDK 投影块不注入）；
//   · 程序化（tc-programmatic）：Agent tags 或会话覆盖（conv-settings
//     toolMode）→ router 收窄 LLM 面为 ['run_code']（投影源 = 能力面
//     直取，见 tool.ts scope 口径；SDK 投影块注入）。
// worker = containment 非 boundary：执行全在主线程 ctx.tools.execute。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { executeRunCode, type RunCodeRowOptions } from './tool.ts';
import { registerProjectionInjection } from './prompt.ts';

export type { RunCodeRowOptions } from './tool.ts';
export { resolveEffectiveTools, resolveWorkerEntry, __runCodeTestHooks } from './tool.ts';

export const name = 'ac-run-code';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'run-code',
  label: '程序化执行',
  description: 'run_code 工具（程序化模式 PTC 内核）：模型写一段可擦除 TS 程序编排成批工具调用，只有最终返回值回上下文——大幅降低 token 消耗。子调用逐个走 ctx.tools.execute（能力轴/档位/黑名单/扫描/脱敏全自动生效）；worker 只做资源约束（maxWallMs/maxOutputBytes——2026-09-23 compute 轴退役，墙钟唯一时间防线，宿主单源不进参数表）。需 infra 能力标签（标准能力面；程序化 = 会话工具调用模式选择，无需预配标签）',
  automatic: true,
  fields: [
    { name: 'defaultMaxWallMs', type: 'number', min: 0, step: 1000, default: 720_000, description: '墙钟预算毫秒（缺省 720000 = 实战自然完成 MAX×3；durable 用户应答等待冻结豁免；0 = 不限）——超限中止程序。宿主侧单源防线，程序参数不可见不可改' },
    { name: 'defaultMaxOutputBytes', type: 'number', min: 0, step: 1024, default: 32_768, description: '返回值序列化字节上限（缺省 32KB；0 = 不限）——超出中段截断并标注' },
  ],
};

// agentLoop 不进 inject（硬依赖会让本行在 loop 行缺席时 PENDING——工具
// 行与 loop 行独立装配是既有语义）：prompt.ts 的 loop/before-run 订阅
// 经 ctx.on 挂载，loop 行在场时事件自然可达，缺席时零效果。
export const inject = ['tools'];

export function apply(ctx: Context, options: RunCodeRowOptions = {}) {
  // SDK 投影 + 程序书写纪律注入（实测复盘 #A1/#A2：投影必须进模型
  // 可见面——发送即丢弃 = 盲调 API；KV cache 前缀稳定靠投影字典序）
  registerProjectionInjection(ctx);
  ctx.tools.register({
    name: 'run_code',
    injection: 'mode',
    description:
      '以代码编排成批工具调用，大幅降低 token 消耗：写一段 TypeScript 程序（限可擦除语法），经 tools.<name>(args) 组合多步操作，控制流（循环/条件/并行）进代码，最终结论经 return 或 log 回上下文'
      + '（return 末端一次合成 / log 沿途收集——无 return 值〔含 return null / undefined〕时 log 各行按序合成返回，按任务形态自选）。'
      + '跨程序复用的函数经 lib.define(名, 函数) 注册（须自包含；存小型函数而非大结果数据——大数据跨程序传递 = 把读取/加工逻辑包成 lib 函数调用时现算），后续程序 lib.resolve(名) 取用（同会话有效；resolve() 无参返回纯静态清单摘要，不执行任何库）。'
      + '确定性多步编排用本工具；探索性研究用 subagent。调用时带 description 参数写明本次程序意图（工具卡 Label）。只读工具可 Promise.all 并行；写路径（write/edit/str_replace_editor）与命令（pwsh/bash）自动按提交序串行。预算超限或中止时程序按 interrupted 收束。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本次程序的一句话意图（做什么/要什么结论）——工具卡 Label 用；程序内不必重复书写' },
        code: { type: 'string', description: '可擦除 TS 程序体（类型标注可用；enum/命名空间/参数属性不可用；不允许 import；模板串内嵌反引号须转义，多行文本优先引号串数组 join 拼接）——tools.<name>(args) 调用工具，最终结论经 return 或 log("…") 给出（无 return 值〔含 return null / undefined〕时 log 各行按序合成返回）' },
        max_output_bytes: { type: 'number', minimum: 0, description: '返回值序列化字节上限（缺省 32KB；0 = 不限）' },
      },
      required: ['code'],
    },
    async execute(args, call) {
      return executeRunCode(ctx, options, args, call);
    },
  });
}
