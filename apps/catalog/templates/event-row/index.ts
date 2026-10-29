// ============================================================
// 事件行模板（M23 §3.7）——复制到
// <数据根>/files/<agentId>/<name>/ 后：
//   1. 全局替换 PLACEHOLDER-AGENTID 为你的 Agent id；
//   2. 选事件（loop/before-run / tool/transform-result / router/* …，
//      目录见各 owning 包 src/events.ts 的 @mode/@scope 与姿势）；
//   3. install_plugin 安装。
//
// 模板规约：
//   · per-Agent 生效 = 行集装载（装载即授权——插件行进谁的行集谁生效，
//     cr-794 软门退役后无 settings 停用面）；
//   · 私有编排铁律：不 provide 新服务（撞名 fail-closed）、不 emit
//     loop/*（usage 双记账 / session 错账）、不注册 agentLoop——要做
//     私有编排 = inject llm/tools 的普通插件直接调服务方法；
//   · waterfall 观察型监听器必须 return next()（不调 = 静默吞掉下游
//     默认行为）；
//   · 事件词汇跨域 type-import 自 owning 包（import type {}）；
//   · 迭代语义：改动必 bump version 重装（同 hash 幂等不重试装载）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // loop/* 事件目录类型增强（type-only）
import type {} from 'ac-tools'; // tool/* 事件目录类型增强

const OWNER = 'PLACEHOLDER-AGENTID';

/** 显式 owner 过滤（身份自查——只处理本 owner 的事件） */
export function agentFilter(agent: string | undefined, owner: string): boolean {
  return agent === owner;
}

export function apply(ctx: Context) {
  // 例 1：emit 订阅（观察/记录——after-run 是纯通知，改了没人消费）。
  ctx.on('loop/after-run', (request, result) => {
    if (!agentFilter(request.agent, OWNER)) return;
    ctx.logger.info('[my-listener] 本 owner 的 run 收束：%C', result.finish);
  });

  // 例 2：waterfall 变换（观察/标注姿势）——观察型必须 return next()。
  // ctx.on('tool/transform-result', async (payload, next) => {
  //   // …变换 payload.result…
  //   return next();
  // });
}
