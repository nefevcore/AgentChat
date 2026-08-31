// ============================================================
// 事件行模板（M23 §3.7；M25 P1 升级 agentGate 用法）——复制到
// <数据根>/files/<agentId>/<name>/ 后：
//   1. 全局替换 PLACEHOLDER-AGENTID 为你的 Agent id；
//   2. 选事件（loop/before-run / tool/transform-result / router/* …，
//      目录见各 owning 包 src/events.ts 的 @mode/@scope 与姿势）；
//   3. install_plugin 安装。
//
// 模板规约：
//   · per-Agent 门控 = agentGate（M25 §3.3，ac-gate-core 纯库）——
//     waterfall 停用即机械 return next()（人手写自查"忘调 next()"的
//     反模式从根上消灭）；emit 停用即跳过；facet 切面子键
//     settings[名][facet].enabled ?? settings[名].enabled（一插件多
//     run 域事件的细分关停）；软依赖 agents——无该服务的组合恒放行。
//     装载即全局供给，per-Agent 生效永远不经装载层（ADR-4 推论）；
//   · 身份读取器用 owning 包导出的 agentOf*（M25 §3.2：载荷变形在
//     定义处 typecheck 红，而非散落消费者静默漂移）；
//   · 私有编排铁律：不 provide 新服务（撞名 fail-closed）、不 emit
//     loop/*（usage 双记账 / session 错账）、不注册 agentLoop——要做
//     私有编排 = inject llm/tools 的普通插件直接调服务方法；
//   · waterfall 观察型监听器必须 return next()（不调 = 静默吞掉下游；
//     经 agentGate 包裹的监听器停用路径已机械保证）；
//   · 事件词汇跨域 type-import 自 owning 包（import type {}）；
//   · 迭代语义：改动必 bump version 重装（同 hash 幂等不重试装载）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { agentGate } from 'ac-gate-core';
import { agentOfRunRequest } from 'ac-agent-loop';
import { agentOfToolTransform } from 'ac-tools';
import type {} from 'ac-agent-loop'; // loop/* 事件目录类型增强（type-only）
import type {} from 'ac-tools'; // tool/* 事件目录类型增强

const OWNER = 'PLACEHOLDER-AGENTID';

/** 兼容保留：显式 owner 过滤（自查身份用；门控请用 agentGate） */
export function agentFilter(agent: string | undefined, owner: string): boolean {
  return agent === owner;
}

export function apply(ctx: Context) {
  // 例 1：emit 订阅（观察/记录——after-run 是纯通知，改了没人消费）。
  // agentGate：settings[本插件名].enabled=false 的 Agent 上自动跳过。
  ctx.on(
    'loop/after-run',
    agentGate(
      ctx,
      'my-listener',
      agentOfRunRequest,
      (request, result) => {
        if (!agentFilter(request.agent, OWNER)) return; // 细到 owner 的自查仍可叠加
        ctx.logger.info('[my-listener] 本 owner 的 run 收束：%C', result.finish);
      },
    ),
  );

  // 例 2：waterfall 变换（观察/标注姿势）——agentGate 停用路径机械
  // return next()（链继续——吞的是本监听器，不是下游默认行为）。
  // facet 切面：一插件多 run 域事件的细分关停（子键覆盖回落行为级）。
  // ctx.on(
  //   'tool/transform-result',
  //   agentGate(
  //     ctx,
  //     'my-listener',
  //     agentOfToolTransform,
  //     async (payload, next) => {
  //       // …变换 payload.result…
  //       return next();
  //     },
  //     { facet: 'redact' },
  //   ),
  // );
}
