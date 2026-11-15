// ============================================================
// replay-wrap.ts —— 系统包裹模板单一实现（cr-1101 回放契约）
//
// 回放契约词汇表 owning = ac-ledger（replay.ts 的 wrapForReplay 是
// 契约面）；本文件是模板的物理实现——落在叶子包使注入生产方
//（ac-agent-loop steer 消费点 / ac-memory 工作数组 append 等）与
// 回放投影方（ac-ledger fold）共享同一字节源，防两处模板漂移。
//
// 语义：非 user/agent 发言的注入文本统一以 <system-reminder> 外壳
// 包裹（外壳封闭归系统——提示注入防护不开放自定义；内层类型化标签
// 如 <skill_content name="…"> 是数据结构，随 content 开放携带）。
// 存量烘焙行（写面已含外壳）原样放行——不双壳。
// ============================================================

const WRAP_OPEN = '<system-reminder>';
const WRAP_CLOSE = '</system-reminder>';

/** 统一包裹：已烘焙（content 以 <system-reminder> 开头）原样放行 */
export function wrapSystemReminder(content: string): string {
  if (content.startsWith(WRAP_OPEN)) return content;
  return WRAP_OPEN + content + WRAP_CLOSE;
}
