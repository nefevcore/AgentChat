// ============================================================
// ac-bench/src/events.ts —— 评测域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：bench/* 事件的分发方是本包的 BenchService。
// 纯通知（emit）：进度流（case-settled 逐例）与终态（run-completed）
// 的 WS 广播 / 审计订阅方【零注入 bench】。
// ============================================================
import type {} from '@agentchat/cordis';
import type { BenchCaseResult, BenchReport, BenchRunInfo } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 跑批开始（用例集已加载/过滤完毕）。
     * 载荷 = 跑批元信息（套件/模型/用例数）。
     * 订阅方：进度 UI、审计。
     * @mode emit
     * @scope host
     */
    'bench/run-started'(info: BenchRunInfo): void;
    /**
     * 单用例判定完成（逐例进度流）。
     * 载荷 = 该用例终态结果（含对拍明细 expected/actual）。
     * 订阅方：进度 UI、审计。
     * @mode emit
     * @scope host
     */
    'bench/case-settled'(result: BenchCaseResult): void;
    /**
     * 跑批完成（全部用例判定聚合后）。
     * 载荷 = 完整报告（accuracy/token/耗时/逐例明细）。
     * 订阅方：进度 UI、审计、CI 出口。
     * @mode emit
     * @scope host
     */
    'bench/run-completed'(report: BenchReport): void;
  }
}
