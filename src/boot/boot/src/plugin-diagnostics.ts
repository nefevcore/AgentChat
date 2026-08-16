// ============================================================
// @agentchat/boot/src/plugin-diagnostics.ts —— 装配缺口诊断行
//
// 块 A 第 4 步判据：删除任一能力/服务行，Loader 不崩，
// 且 boot 能诊断出哪个服务缺失（而不是静默 PENDING）。
// 本行不 inject 任何服务，启动 5s 后扫描必需服务并告警。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'agentchat-boot-diagnostics';
export const inject: string[] = [];

const REQUIRED_SERVICES = [
  'bootstrap',
  'workspace',
  'archive',
  'timerManager',
  'subagent',
  'durableInteraction',
  'l4',
  'webServerHost',
] as const;

export function apply(ctx: Context) {
  const timer = setTimeout(() => {
    const missing = REQUIRED_SERVICES.filter((name) => {
      try {
        return !ctx.get(name);
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      ctx.logger('boot').warn(`装配缺口诊断：缺失服务 [${missing.join(', ')}] —— 对应插件行可能未挂载/被删除，依赖这些服务的插件将保持 PENDING（进程不崩）`);
    }
  }, 5000);
  return () => clearTimeout(timer);
}
