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
// 注入条件（2026-12 注入轴重构）：请求面恰等于注册面 mode 工具集
// （injection:'mode'——router 程序化档合成；与 narrowToolsByMode 同源）
// 即注入。并存形态已随注入轴退役（mode 工具不进常规面，请求面不含
// 它们）。每次注入前按 request 现算生效面（与 run_code 工具体同源
// resolveEffectiveTools——不缓存，防装卸窗口漂移）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { LoopRunCall } from 'ac-agent-loop';
import { buildSdkProjection, DEFAULT_GUIDANCE } from 'ac-run-code-core';
import { isModeToolFace } from 'ac-agents';
import { resolveEffectiveTools } from './tool.ts';

/** 注入块首行标记（幂等判定 + UI 可识别） */
const MARKER = '# run_code 工具 SDK（程序化模式）';

/** 互斥形态引导语（程序化调用：tools.* 是唯一工具 API） */
const INTRO = [
  '本会话为程序化模式：一切工具操作经 run_code 编写 TypeScript 程序完成（限可擦除语法，',
  '不允许 import）——下方 tools.* 是本模式唯一的工具 API（循环/条件/并行进代码，最终结论经 ',
  'return 或 log 回上下文——无 return 值〔含 return null / undefined〕时 log 各行按序合成返回，按任务形态自选）。',
  '跨程序复用的函数经 lib.define 注册（同会话后续程序 lib.resolve 取用）。工具 API 类型签名：',
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
  // tools 复算看不见开关，2026-09 research §十）。判定单源化（2026-12
  // PTC 基线段修复）：isModeToolFace 与 fs-tools/session-query 等门控
  // 行同源——「请求面恰等于注册面 mode 工具集」一处定义。
  const modeToolNames = ctx.tools.list().filter((d) => d.injection === 'mode').map((d) => d.name);
  const requested = Array.isArray(request.tools) ? request.tools : null;
  const isModeFace = requested !== null && isModeToolFace(requested, modeToolNames);
  // 程序化调用 = 互斥形态：LLM 面单 schema（仅 run_code）。并存形态
  //（run_code 与传统工具同列）不注入——传统工具 schema 已在请求面可
  // 直读，SDK 块省 token；run_code 不在面（Agent 无 tc-programmatic
  // 标签）同样不注入。
  if (!isModeFace) return undefined;
  // 投影源（scope='projection'——能力面直取，不受 include/exclude/开关
  // 收窄；互斥形态的投影要涵盖全部已授权工具，否则程序里除了 run_code
  // 什么都调不了）
  const projectionFace = resolveEffectiveTools(ctx, request.agent, request.conversationId, 'projection');
  // guidance='' —— 代码块内不嵌纪律注释：块后已有一份纯文本（下方
  // DEFAULT_GUIDANCE），块内再嵌一份是纯重复（~5K 字符/请求，2026-12
  // 裁决）。代码块保持纯粹的 API 类型签名参考。
  const projection = buildSdkProjection(projectionFace, { guidance: '' });
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
