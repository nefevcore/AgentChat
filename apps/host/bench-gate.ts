// ============================================================
// bench-gate.ts —— evolve 验收门 bench 适配器（M8.3；五步闭环步 5）
//
// R-8：bench 门过 = 免观察期快速通道（与快照点共尺）。evolve 验收门
// 注入面 = AcceptanceGate——本适配器把「影子壳跑 bench」接到 evolve：
// spawnShell 拉起的新壳上跑 scripted bench（mock provider 全链：注册中心
// → loop → 工具执行 → 对拍），报告全过 = 门过。
// 壳形态 = boot --mock-provider（mock 壳自带 scriptedBenchRow 薄行），
// bench 控制帧 stdin 下发、TSV 报告回读——控制面语义零真 LLM。
// ============================================================
import type { BenchReport } from 'ac-bench';
import { MOCK_PROVIDER, MOCK_MODEL } from 'ac-bench';

/**
 * bench 门参数（套件与用例数——scripted 全链 mock provider，R-8 快速通道）。
 */
export interface BenchGateOptions {
  suite?: string;
  limit?: number;
  /** 真跑档模型（真 LLM 对拍——传入即脱离 scripted mock；如 'glm-5.3-flash'）。 */
  model?: string;
  /** 真跑档显式 provider（缺省按 model 路由）。 */
  provider?: string;
}

/**
 * bench 门真身：对已 adopt 的壳句柄跑 bench 控制帧，报告全过 = 通过。
 * ShellHandle 须扩展 control 面（拉起方持有子进程 stdin/stdout）。
 */
export async function benchGateCheck(
  control: (frame: Record<string, unknown>) => Promise<unknown>,
  options: BenchGateOptions = {},
): Promise<{ ok: boolean; reason?: string; report?: BenchReport }> {
  let report: unknown;
  // model 显式传入 = 真跑档（真 LLM 全量对拍）；缺省 = scripted mock 冒烟档（M8.3 架构轴原语义）。
  // cr-680 实锤：此前签名无 model 入口，真跑只能绕过本适配器手拼帧——判据跑批面缺产品入口。
  const real = options.model !== undefined;
  try {
    report = await control({
      ctrl: 'bench',
      suite: options.suite ?? 'bfcl',
      options: real
        ? {
            model: options.model!,
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          }
        : {
            model: MOCK_MODEL,
            provider: MOCK_PROVIDER,
            scripted: true,
            ...(options.limit !== undefined ? { limit: options.limit } : { limit: 2 }),
          },
    });
  } catch (err) {
    return { ok: false, reason: 'bench 控制帧失败：' + String(err) };
  }
  const r = report as BenchReport | undefined;
  if (r === undefined || typeof r.total !== 'number') {
    return { ok: false, reason: 'bench 报告形状异常：' + JSON.stringify(report).slice(0, 200) };
  }
  if (r.total === 0) return { ok: false, reason: 'bench 报告为空（total=0）' };
  if (r.passed < r.total) {
    return { ok: false, reason: 'bench 门未过：' + r.passed + '/' + r.total, report: r };
  }
  return { ok: true, report: r };
}
