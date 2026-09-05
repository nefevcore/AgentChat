// ============================================================
// ac-core-utils —— 跨行共享的基础纯函数 / 协议常量（零 cordis 依赖）
//
// 收录判据（唯一准入条件，防 grab-bag 化）：跨 ≥2 行共享的小纯函数 /
// 常量，且随 owning 行导出会形成行间【运行时环】或【反向依赖】——
// 域词汇本身（契约/事件/服务面）仍归 owning 包，本库只收"会成环的
// 那一小块"。域逻辑、状态、cordis 注册面禁止入内。
//
// 现状两件（2026-09-05 插件边界评估：解 ac-session⇄ac-group 唯一
// 运行时环）：
//   · GROUP_HINT_META / isGroupHint —— 群 hint 投递标记协议
//     （原住 ac-group；group 生产、session/conversation/ws-bridge
//     消费。session→group 与 D11 存储归属方向相逆，环的一边）
//   · maxSeqOf —— 记录集 seq 极值（原住 ac-session；group/archive
//     轮转窗口基线消费。group→session 的运行时 import 使群行无法
//     独立于会话行装载，环的另一边）
// 下沉后 session 与 group 互相零 import：协作只经 ctx.get 服务面
// （D11 跨域读写口），两行可独立停用。
// ============================================================

/**
 * 群投递触发信封标记键（M21 步骤 5 / F6①）：值恒 true。群 send 的逐成员
 * hint 投递携带——hint 是「投递触发器」（事实行已由 post 落入群本体），
 * ac-session 的 message-received 入账据此跳过（修影子桶 hint 按成员重复
 * N 次）；群 run 终稿不入本体（M26——群内容 = post 唯一口，send_group
 * 才是发言）。生产方 ac-group；消费方 ac-session / ac-conversation /
 * ac-ws-bridge（跳过逐成员 hint 的入账与视图）。
 */
export const GROUP_HINT_META = 'group-hint';

/**
 * 群 hint 投递触发判定（M21/F6①，与 GROUP_HINT_META 同源单导出）：
 * 事实行已入群本体，session 入账/上下文视图据此跳过逐成员 hint。
 */
export function isGroupHint(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[GROUP_HINT_META] === true;
}

/** 记录集最大 seq（无 seq 行忽略；空集 → undefined）——重写窗口基线用。
 *  session.compact / group 轮转 / archive 快照共用的窗口协议（B1：
 *  调用方传 baselineSeq = 其 records 快照的 max seq，快照之后新落的
 *  记录并入保留窗）。
 */
export function maxSeqOf(records: Array<{ seq?: number }>): number | undefined {
  let max: number | undefined;
  for (const r of records) {
    if (typeof r.seq === 'number' && r.seq > (max ?? 0)) max = r.seq;
  }
  return max;
}
