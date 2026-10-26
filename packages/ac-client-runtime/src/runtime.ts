// ============================================================
// ac-client-runtime/src/runtime.ts —— client runtime 单例持有
//（M27.2-2：自 webui/src/runtime/clientRuntime.ts 下沉运行时包）
//
// 装配序列（main.ts/webuiBoot ①）写入；包内模块（门面/解析面等
// 非组件上下文）经 clientRuntime() 读取——包不 import webui 胶水
// 的结构性前提。webui 侧同名模块 re-export 维持旧路径。
// ============================================================
import type { ClientContext } from './context.ts';

let current: ClientContext | undefined;

/** 装配序列写入（createClient 后立即调用——先于一切插件装载） */
export function setClientRuntime(ctx: ClientContext | undefined): void {
  current = ctx;
}

/** 当前 client runtime（未装配 = undefined——门面回落独立实例的判据） */
export function clientRuntime(): ClientContext | undefined {
  return current;
}

/** 测试复位（afterEach 防 runtime 泄漏跨用例） */
export function resetClientRuntime(): void {
  current = undefined;
}
