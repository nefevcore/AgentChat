// ============================================================
// webui/src/runtime/clientRuntime.ts —— 客户端运行时单例锚（M27 S1）
//
// 装配序列（main.ts）建立的 ClientContext 落这里；模块级旧注册面
// （core/extensions/slots.ts、core/registry/* 的 bridge 双轨转发）与
// 组合式（useClientContext 之外的模块级消费方）经它取运行时。
//
// 装配完成前调用注册面 = 只走旧轨（不转发 slot 注册表——单测与
// pre-boot 场景兼容）；装配后 = 双轨（旧签名转发进 SlotRegistry）。
// ============================================================
import type { ClientContext } from 'ac-client-runtime';

let runtime: ClientContext | undefined;

/** 装配序列写入（main.ts；一次写入，不重复设置） */
export function setClientRuntime(ctx: ClientContext): void {
  runtime = ctx;
}

/** 运行时（未装配 → undefined） */
export function clientRuntime(): ClientContext | undefined {
  return runtime;
}

/** 测试专用：解除单例（隔离「未装配」分支的用例编排） */
export function resetClientRuntime(): void {
  runtime = undefined;
}

/** 运行时（未装配 → 抛错：装配顺序错误的可诊断面） */
export function requireClientRuntime(): ClientContext {
  if (!runtime) {
    throw new Error('client runtime 未装配——main.ts 装配序列先行（M27 §0.1）');
  }
  return runtime;
}
