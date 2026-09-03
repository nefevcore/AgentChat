// ============================================================
// ac-llm/src/refs.ts —— name@model 模型引用语法（纯函数，零依赖）
//
// 引用语法定义（llm-provider-model-plan §二）：
//   name@model —— 左 = provider 名（池条目名/内置种子名），右 = 模型 id；
//   裸模型名（不含 @ 或拆分不完整）= 旧路由语义（meta.models 精确 > 前缀）。
//
// 拆分策略：按【首个 @】拆；左段或右段为空 → 整串视作裸模型（不拆）。
// "左段是否为已注册 provider"的校验属调用方（router 边界持有 ctx.llm
// 注册面），纯函数不做环境依赖判定——拆出的 provider 无效时调用方回退
// 整串按裸模型路由，最终由 resolveProvider 的 roster 报错兜底。
// ============================================================

/** 拆分结果：provider 缺省 = 裸模型名（旧路由语义） */
export interface ModelRef {
  provider?: string;
  model: string;
}

/** `name@model` → { provider, model }；不完整/不含 @ → { model: 原串 } */
export function splitModelRef(ref: string): ModelRef {
  const at = ref.indexOf('@');
  if (at <= 0 || at === ref.length - 1) return { model: ref };
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

/** 显示/wire 拼装单点：{ provider, model } → `name@model`（无 provider → 裸名） */
export function joinModelRef(provider: string | undefined, model: string): string {
  return provider ? `${provider}@${model}` : model;
}
