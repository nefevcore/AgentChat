// ============================================================
// ac-run-code/src/index.ts —— run_code 工具行（程序化模式 PTC 内核）
//
// 单工具 run_code（requiredTags ['infra']——基础设施族授权：与提问/
// 待办/计算同族的标准能力面，标准预设与多数 Agent 天然可见（2026-09-17
// 优化裁决：tc-* 回归纯模式词——「程序化」是会话/Agent 的形态选择而非
// 授权门槛；前端选程序化 = 临时程序化档，无需预配标签）。档位随父
// Agent，子调用逐个走全安全面，故本工具不挂 needPermission：粗信任由
// 子调用细信任实现，裁决 #2）。
//
// 激活形态（2026-09-17 统一重构：tc-* 标签轴——工具调用模式与提权
// 档位同构；code-exec 已移除，tc-programmatic 即唯一授权词）：
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
export { resolveEffectiveTools, resolveWorkerEntry } from './tool.ts';

export const name = 'ac-run-code';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'run-code',
  label: '程序化执行',
  description: 'run_code 工具（程序化模式 PTC 内核）：模型写一段可擦除 TS 程序编排成批工具调用，只有最终返回值回上下文——大幅降低 token 消耗。子调用逐个走 ctx.tools.execute（能力轴/档位/黑名单/扫描/脱敏全自动生效）；worker 只做资源约束（computeMs/maxWallMs/maxOutputBytes）。需 infra 能力标签（标准能力面；程序化 = 会话工具调用模式选择，无需预配标签）',
  automatic: true,
  fields: [
    { name: 'defaultComputeMs', type: 'number', min: 0, step: 1000, default: 120_000, description: '子调用累计执行耗时预算毫秒（缺省 120000；0 = 不限）——程序可传 compute_ms 覆盖' },
    { name: 'defaultMaxWallMs', type: 'number', min: 0, step: 1000, default: 600_000, description: '墙钟预算毫秒（含审批等待；缺省 600000；0 = 不限）——超限中止程序' },
    { name: 'defaultMaxOutputBytes', type: 'number', min: 0, step: 1024, default: 65_536, description: '返回值序列化字节上限（缺省 64KB；0 = 不限）——超出中段截断并标注' },
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
    requiredTags: ['infra'],
    description:
      '以代码编排成批工具调用，大幅降低 token 消耗：写一段 TypeScript 程序（限可擦除语法），经 tools.<name>(args) 组合多步操作，控制流（循环/条件/并行）进代码，最终结论经 return 或 log 回上下文'
      + '（return 末端一次合成 / log 沿途收集——无 return 值时 log 各行按序合成返回，按任务形态自选）。'
      + '跨程序复用的函数经 lib.define(名, 函数) 注册（须自包含；存小型函数而非大结果数据——大数据跨程序传递 = 把读取/加工逻辑包成 lib 函数调用时现算），后续程序 lib.resolve(名) 取用（同会话有效）。'
      + '确定性多步编排用本工具；探索性研究用 subagent。调用时带 description 参数写明本次程序意图（工具卡 Label）。只读工具可 Promise.all 并行；写路径（write/edit/str_replace_editor）与命令（pwsh/bash）自动按提交序串行。预算超限或中止时程序按 interrupted 收束。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本次程序的一句话意图（做什么/要什么结论）——工具卡 Label 用；程序内不必重复书写' },
        code: { type: 'string', description: '可擦除 TS 程序体（类型标注可用；enum/命名空间/参数属性不可用；不允许 import）——tools.<name>(args) 调用工具，最终结论经 return 或 log("…") 给出（无 return 值时 log 各行按序合成返回）' },
        compute_ms: { type: 'number', minimum: 0, description: '子调用累计执行耗时预算毫秒（缺省随行配置 120000；0 = 不限）' },
        max_wall_ms: { type: 'number', minimum: 0, description: '墙钟预算毫秒（含审批等待；缺省 600000；0 = 不限）' },
        max_output_bytes: { type: 'number', minimum: 0, description: '返回值序列化字节上限（缺省 64KB；0 = 不限）' },
      },
      required: ['code'],
    },
    async execute(args, call) {
      return executeRunCode(ctx, options, args, call);
    },
  });
}
