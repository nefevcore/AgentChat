// ============================================================
// webui/src/runtime/clientRuntime.ts —— 客户端运行时单例锚（M27 S1）
//
// M27.2-2：单例持有下沉 ac-client-runtime（包内模块的非组件上下文
// 读取面——包不 import webui 胶水的结构性前提）；本模块 re-export
// 维持旧路径（requireClientRuntime 为 webui 专有的可诊断面，留此）。
// ============================================================
import { clientRuntime } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

export { setClientRuntime, clientRuntime, resetClientRuntime } from 'ac-client-runtime';

/** 运行时（未装配 → 抛错：装配顺序错误的可诊断面） */
export function requireClientRuntime(): ClientContext {
  const rt = clientRuntime();
  if (!rt) {
    throw new Error('client runtime 未装配——main.ts 装配序列先行（M27 §0.1）');
  }
  return rt;
}
