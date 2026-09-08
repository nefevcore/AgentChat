// ============================================================
// ac-client-ui-agents/client/rosterAccess.ts —— 名册核心取用口
//（M28 §4.2：agentsStore pinia 门面退役，消费面切 ctx.roster）
//
// 消费面统一访问器（D13 bridge 的常驻形态——门面退役后不再经过 pinia）：
//   · app 内（client runtime 在场）：ctx.roster.core（单一事实源，
//     §0.3 层 2 身份面 + agents 域写面）。惰性解析——本行是 domain 相
//     装载，base 相核心（feed/chat）与组件在装配完成后才真正取值，
//     boot 期首取回落单例也不会永久错绑（每次取用重解析）。
//   · 无 runtime（单测 / 行摘除期）：模块级回落单例——同文件多次取用
//     同实例（「同测试内多次取用同实例」语义，替代旧 pinia 实例缓存）。
//     需要隔离状态的测试应显式 new RosterCore() 注入核心工厂。
// 卸载 agents 行 → ctx.roster 不可解析 → 回落单例（名册清空，宿主不残废）。
// ============================================================

import { clientRuntime } from 'ac-client-runtime';
import { RosterCore } from './index.ts';

/** 无 runtime 回落单例（惰性创建；测试隔离请显式注入 RosterCore） */
let fallbackCore: RosterCore | null = null;

/** 名册核心取用：runtime 在场 → ctx.roster.core；缺席 → 模块级回落单例 */
export function useRosterCore(): RosterCore {
  return clientRuntime()?.roster?.core ?? (fallbackCore ??= new RosterCore());
}
