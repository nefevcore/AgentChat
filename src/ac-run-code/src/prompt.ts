// ============================================================
// ac-run-code/src/prompt.ts —— SDK 投影注入（实测复盘 #A1/#A2 修复）
//
// P0 首版投影「发送即丢弃」：工具体算了 projection 发给 worker，
// worker 存下不用——模型可见面为空，等于盲调 API（实测第一轮即
// 因 read 目录返回类型猜错失败）；返回值压缩纪律也没送达（第二轮
// 12.7KB 原样包回）。
//
// 修复：loop/before-run 主档注入 system 块（系统提示词装配常规落点）：
//   · SDK 投影声明（buildSdkProjection——字典序稳定，工具集不变则
//     字节不变，KV cache 前缀友好）；
//   · 程序书写纪律（DEFAULT_GUIDANCE 基线）。
// 注入条件（2026-09-17 续修）：仅程序化调用——互斥形态（LLM 生效面
// 单 schema 仅 run_code：会话开关开 router 收窄，或 Agent include 收窄，
// 两者同构）。并存形态（run_code 与传统工具同列）不注入：传统工具
// schema 已在请求面可直读，SDK 块对多数 run 是纯 token 开销，模型偶用
// run_code 时按请求面 schema 写程序即可。每次注入前按 request 现算
// 生效面（与 run_code 工具体同源 resolveEffectiveTools——不缓存，防
// 装卸窗口漂移）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { LoopRunCall } from 'ac-agent-loop';
import { buildSdkProjection, DEFAULT_GUIDANCE } from 'ac-run-code-core';
import { resolveEffectiveTools } from './tool.ts';

/** 注入块首行标记（幂等判定 + UI 可识别） */
const MARKER = '# run_code 工具 SDK（程序化模式）';

/** 互斥形态引导语（程序化调用：tools.* 是唯一工具 API） */
const INTRO = [
  '本会话为程序化模式：一切工具操作经 run_code 编写 TypeScript 程序完成（限可擦除语法，',
  '不允许 import）——下方 tools.* 是本模式唯一的工具 API（循环/条件/并行进代码，最终结论经 ',
  'return 或 log 回上下文——无 return 值时 log 各行按序合成返回，按任务形态自选）。',
  '跨程序复用的函数经 lib.define 注册（同会话后续程序 lib.resolve 取用；lib 存小型工具函数，勿存大结果数据——大数据传递 = 把读取/加工逻辑包成 lib 函数，调用时现算）。工具 API 类型签名：',
].join('');

/**
 * 挂 loop/before-run 注入（ac-run-code/src/index.ts apply 调用）。
 * 观察/标注型监听器——恒调 next()。
 */
export function registerProjectionInjection(ctx: Context): void {
  ctx.on('loop/before-run', (call: LoopRunCall, next) => {
    const block = projectionBlock(ctx, call);
    if (block === undefined) return next();
    call.request = {
      ...call.request,
      system: call.request.system ? `${call.request.system}\n\n${block}` : block,
    };
    return next();
  }, { description: 'run_code SDK 投影 + 程序书写纪律注入（程序化互斥形态时）' });
}

/** 组装注入块；非程序化调用（LLM 面非单 run_code）→ undefined（不注入） */
function projectionBlock(ctx: Context, call: LoopRunCall): string | undefined {
  const request = call.request;
  // LLM 面判定（run 级请求面优先）：request.tools 是 router 合成后的
  // 终值——含程序化开关收窄（开关化后收窄不落在 Agent 配置里，Agent
  // tools 复算看不见开关，2026-09-17 research §十）；缺省（直调
  // agentLoop）= 复算面全量（loop 语义同口径）。复算面作交集护栏
  //（请求面带入不可见工具时丢弃——与 loop 工具执行门禁同向）。
  const llmFace = resolveEffectiveTools(ctx, request.agent, request.conversationId, 'llm');
  const requested = Array.isArray(request.tools) ? new Set(request.tools) : null;
  const llmNames = llmFace
    .map((d) => d.name)
    .filter((name) => requested === null || requested.has(name));
  // 程序化调用 = 互斥形态：LLM 面单 schema（仅 run_code）。并存形态
  //（run_code 与传统工具同列）不注入——传统工具 schema 已在请求面可
  // 直读，SDK 块省 token；run_code 不在面（Agent 无 tc-programmatic
  // 标签）同样不注入。
  const programmaticOnly = llmNames.length === 1 && llmNames[0] === 'run_code';
  if (!programmaticOnly) return undefined;
  // 投影源（scope='projection'——能力面直取，不受 include/exclude/开关
  // 收窄；互斥形态的投影要涵盖全部已授权工具，否则程序里除了 run_code
  // 什么都调不了）
  const projectionFace = resolveEffectiveTools(ctx, request.agent, request.conversationId, 'projection');
  const projection = buildSdkProjection(projectionFace);
  return [
    MARKER,
    '',
    INTRO,
    '',
    '```ts',
    projection,
    '```',
    '',
    DEFAULT_GUIDANCE,
  ].join('\n');
}
