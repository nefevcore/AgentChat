// ============================================================
// ac-client-ui-renderer/client/codeFence.ts —— 动态围栏构造
//
// 喂 useMarkdown().render() 的代码围栏前置构造（fs Code 卡与
// run_code 程序卡双消费单源，cr-465 并源归 renderer——渲染域词汇）。
// ============================================================

/** 动态围栏：内容含 ``` 时升级更长的围栏（读 .md 文件内嵌 fence 必现截断错乱） */
export function fenceOf(code: string): string {
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return fence;
}
