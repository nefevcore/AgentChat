// ============================================================
// ac-event-policy —— 事件治理策略行（M25 §3.4 / P2）
//
// inject ['config']（停用集持久层 events.disabled）。行 reload 自追
// 清扫（N6）：apply 收尾自追一次 sweep（幂等——boot 末清扫的补充，
// 收口行重挂窗口期的注册逃逸）。
// RPC（events/policy-list · policy-set）由 ac-web-api 经可选
// ctx.get('eventPolicy') 注册（薄编排行模式——摘本行不拖垮 RPC 面）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { EventPolicyService } from './service.ts';

export const name = 'ac-event-policy';

export const inject = ['config'];

export function apply(ctx: Context) {
  // 直接构造（Service 构造器即 reflect.provide 注册，随本行 fiber 卸载回收）
  const service = new EventPolicyService(ctx);
  // 行 reload 自追清扫（N6）：apply 收尾幂等 sweep——行重挂期间
  // internal/listener 无消费者、注册逃逸且 boot 已过
  const removed = service.sweep();
  if (removed > 0) {
    ctx.logger.info('[eventPolicy] 行装载自追清扫：%C 条已停用监听器', String(removed));
  }
}

export { EventPolicyService, registerRowAlias } from './service.ts';
// fiber→顶层行聚合（M25 §3.5：events/listeners / plugin/rows / 熔断归属共用；
// 聚合只改呈现不改键）
export { computeRowAggregates, rowOfFiber } from './aggregate.ts';
