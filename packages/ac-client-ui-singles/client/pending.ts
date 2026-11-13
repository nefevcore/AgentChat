// single 视角哨兵（未发送草稿的会话位——feed 分区恒空，历史装载天然跳过）。
// cr-1058 独立小模块：conversation 与 singles 双向消费此常量。conversation 侧
// （ChatInput fresh 工作区门禁）因 bundle 模块环约束（conversation → singles →
// conversation，模块系统 CJS 环 fail-loud）只能字面量内联——对拍防线住
// draft-single.test.ts（静态读源断言内联副本与本本体一致）。
export const PENDING_SINGLE_ID = '__pending__';
