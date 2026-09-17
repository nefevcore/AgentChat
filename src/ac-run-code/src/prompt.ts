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
//   · 程序书写纪律（互斥形态基线 + 并存形态选择策略，report §六.8
//     「指引双版本」的落地）。
// 每次注入前按 request 现算生效面（与 run_code 工具体同源 resolveEffectiveTools
// ——不缓存，防装卸窗口漂移）；Agent 无 code-exec（run_code 不可见）
// 时不注入（并存形态才需要，互斥形态 run_code 恒在生效面）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { LoopRunCall } from 'ac-agent-loop';
import { buildSdkProjection, DEFAULT_GUIDANCE } from 'ac-run-code-core';
import { resolveEffectiveTools } from './tool.ts';

/** 注入块首行标记（幂等判定 + UI 可识别） */
const MARKER = '# run_code 工具 SDK（程序化模式）';

/** 并存形态附加的选择策略（report §三：预期 >3 步确定性序列优先 run_code） */
const COEXISTENCE_GUIDANCE = [
  '执行形态选择：预期超过 3 步的确定性操作序列优先写进一个 run_code 程序',
  '（中间结果不占上下文、一次可见全部计划）；单步操作或探索性试探直接调工具；',
  '探索性多任务研究用 subagent。',
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
  }, { description: 'run_code SDK 投影 + 程序书写纪律注入（run_code 生效时）' });
}

/** 组装注入块；run_code 不在生效面 → undefined（不注入） */
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
  const hasRunCode = llmNames.includes('run_code');
  if (!hasRunCode) return undefined;
  // 投影源（scope='projection'——能力面直取，不受 include/exclude/开关
  // 收窄；互斥形态下 LLM 面只有 run_code，投影仍涵盖全部已授权工具）
  const projectionFace = resolveEffectiveTools(ctx, request.agent, request.conversationId, 'projection');
  const projection = buildSdkProjection(projectionFace);
  // 纪律双版本：LLM 面同时含传统工具（并存形态——开关关/Agent 未收窄）
  // 时附选择策略；互斥形态（LLM 面只有 run_code 一个 schema——开关开或
  // include 收窄）只留基线——多步操作唯一路径是写程序
  const coexistence = llmNames.length > 1;
  const guidance = coexistence
    ? `${DEFAULT_GUIDANCE}\n${COEXISTENCE_GUIDANCE}`
    : DEFAULT_GUIDANCE;
  const intro = coexistence
    ? '本会话可用 run_code 工具：写一段 TypeScript 程序（限可擦除语法，不允许 import），'
      + '经下方 tools.* API 编排成批工具调用——循环/条件/并行进代码，只有 return 的最终值'
      + '回上下文。跨程序复用的函数经 lib.define 注册（同会话后续程序 lib.resolve 取用）。'
      + '工具 API 类型签名：'
    : '本会话为程序化模式：一切工具操作经 run_code 编写 TypeScript 程序完成（限可擦除语法，'
      + '不允许 import）——下方 tools.* 是本模式唯一的工具 API（循环/条件/并行进代码，只有 '
      + 'return 的最终值回上下文）。跨程序复用的函数经 lib.define 注册（同会话后续程序 '
      + 'lib.resolve 取用）。工具 API 类型签名：';
  return [
    MARKER,
    '',
    intro,
    '',
    '```ts',
    projection,
    '```',
    '',
    guidance,
  ].join('\n');
}
