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
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'event-policy',
  label: '事件治理策略',
  description: '进程级 (插件×事件) 监听器停用集——internal/listener 吞注册 + boot 末清扫（停用键 config events.disabled，事件视图「停用」按钮写此处）',
  automatic: true,
};


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
