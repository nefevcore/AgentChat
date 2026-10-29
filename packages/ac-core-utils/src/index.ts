// ============================================================
// ac-core-utils —— 跨行共享的基础纯函数 / 协议常量（零 cordis 依赖）
//
// 收录判据（唯一准入条件，防 grab-bag 化）：跨 ≥2 行共享的小纯函数 /
// 常量，且随 owning 行导出会形成行间【运行时环】或【反向依赖】——
// 域词汇本身（契约/事件/服务面）仍归 owning 包，本库只收"会成环的
// 那一小块"。域逻辑、状态、cordis 注册面禁止入内。
//
// 现状八组词汇：
//   · GROUP_HINT_META / isGroupHint —— 群 hint 投递标记协议
//     （原住 ac-group；group 生产、session/conversation/ws-bridge
//     消费。session→group 与 D11 存储归属方向相逆，环的一边）
//   · maxSeqOf —— 记录集 seq 极值（原住 ac-session；group/archive
//     轮转窗口基线消费。group→session 的运行时 import 使群行无法
//     独立于会话行装载，环的另一边）
//   · runAddress / pairKey —— run 寻址与对桶键（原住 ac-agent-loop，
//     2026-10-10 cr-318 下沉：conversation 串行化门 / router 对桶投递 /
//     workspace 会话桶等 8+ 包值导入——词法协议全仓单源）
//   · memberStreamKey —— 群成员私有转录流键（原住 ac-group，2026-10-13
//     cr-376 下沉：file-snapshots 会话删除级联跨行消费走单源）
//   · ARCHIVE_REVIEW_META / isArchiveReviewRun —— 机制 run 标记
//     （原住 ac-agent-loop，cr-318 同批：conversation/session/usage/
//     goal/group/singles/ws-bridge/remote-link 消费，与 GROUP_HINT_META
//     同款 meta 标记协议）
//   · normalizeToolSpecs —— 工具清单 → 规范化 LlmToolSpec[]（原住
//     ac-agent-loop，cr-318 同批：singles 前缀快照同口径计算 specs
//     哈希——唯一规范化点，防两处漂移）
//   · resolvePersonaText / PersonaSettings —— persona 解析词法（原住
//     ac-persona，cr-321 下沉：singles 前缀快照修订键须与装配行逐字节
//     同口径复算 persona 终态，normalizeToolSpecs 同构；agentStore 以
//     最小结构形状 PersonaDocStore 入参，零 cordis 依赖）
//   · TITLE_MAX_LEN / DATE_SNAPSHOT_PREFIX / titlePrompt / cleanTitle /
//     fallbackTitle —— 会话标题词法（cr-672 下沉：主线 ac-singles 直写与
//     preview 壳侧 auto-title 行（生成 → 信封 → 宿主 singles 行落盘）两处
//     生成面共用长度上限 / 提示词 / 清洗 / 截断回落——两处各写一份必走散）
//   · GroupConfig / assertGid / readGroupConfig / listGroupConfigs —— 群
//     配置纯读面（cr-712 下沉：宿主 groups 行写面与壳侧 group 垫片〔send_group
//     扇出〕两处共用读词汇——垫片 import 宿主行包即壳→宿主反向依赖）
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

/**
 * run 寻址（steer 注入 / 串行化门共用的地址词汇；原住 ac-agent-loop，
 * cr-318 下沉——conversation/skill/ask-questions/security 等共用）：
 *   · agent 缺省 → 无地址（subagent 直连形态，steer 不适用）
 *   · conversationId 缺省或 = agent → agent（1v1：一个 Agent 一条会话门）
 *   · conversationId ≠ agent → `${conversationId}~${agent}`（群聊：组键共享
 *     会话桶，但每个参与者是独立 run——对齐 src group~gid~aid 语义）
 * 无歧义前提：Agent id 禁 `~`（agents.register 校验），对键从右起最后
 * 一段即 agent——M19 承重墙。
 */
export function runAddress(
  agent: string | undefined,
  conversationId: string | undefined,
): string | undefined {
  if (agent === undefined) return undefined;
  if (!conversationId || conversationId === agent) return agent;
  return `${conversationId}~${agent}`;
}

/**
 * 对键构造（M19 全对键桶模型的会话归属键；原住 ac-agent-loop，cr-318
 * 下沉——conversationId 词汇与信封契约归此）：两端排序后 `~` 连接；
 * a===b 即自会话对角线 a~a。一切双端会话（user⇄agent 直答 /
 * agent⇄agent 委托 / 机制自会话）共用。
 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

/**
 * 群成员私有转录流键（cr-4，原住 ac-group）：sessions/<gid>~<member>/——
 * runAddress 同形（member 恒最右，右起解析无歧义；gid 禁 ~ 使拆分唯一）。
 * 撞形防线：群 id 禁 ~（规约）+ 双向名册校验（create/register 双卡）+
 * 一致性测试。跨行消费（ac-file-snapshots 级联清理）走本单源。
 */
export function memberStreamKey(groupId: string, member: string): string {
  return `${groupId}~${member}`;
}

/**
 * 归档整理 run 的信封标记键（M20，对齐 src META_ARCHIVE_REVIEW）：值恒为
 * true。透传链 conversation.deliver → router.send → LoopRunRequest.meta；
 * 三个消费方各查本键跳过副作用——ac-session（入账）、ac-usage（记账）、
 * ac-conversation（上下文视图）。ws-bridge 的流式过滤仍按 source='event'。
 */
export const ARCHIVE_REVIEW_META = 'archive-review';

/**
 * 机制标记 run（归档整理等）判定（M20 三消费方共用单源——ac-session
 * 不入账 / ac-usage 不记账 / ac-conversation 不进上下文视图 / ac-group
 * 不入账）：见标记即跳过，回复照常（回复是会话事实）。
 */
export function isArchiveReviewRun(meta: Record<string, unknown> | undefined): boolean {
  return meta?.[ARCHIVE_REVIEW_META] === true;
}

/**
 * 工具名清单 → 规范化 LlmToolSpec[]（缺省 = 全部已注册工具；空清单 = 空集）。
 * M21/D4 顺序规范化（DSH M2b）：按工具名**字典序**——与注册顺序/插件
 * 装卸时序解耦（注册顺序是插件加载时序的产物，HMR/装卸即变 → 前缀
 * 抖动）。落地即一次性全量缓存失效，接受（一次性迁移成本）。
 * 导出供 ac-singles 前缀快照（M21 步骤 4）同口径计算 specs 哈希——
 * 唯一规范化点，防两处漂移。
 */
export function normalizeToolSpecs(
  defs: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>,
  names: string[] | undefined,
): Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> {
  const selected = (names ? defs.filter((d) => names.includes(d.name)) : defs)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return selected.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      ...(d.parameters ? { parameters: d.parameters } : {}),
    },
  }));
}

export * from './persona.ts';
export * from './session-title.ts';
export * from './groups.ts'; // 群配置纯读面（cr-712 下沉——宿主 groups 行与壳侧 group 垫片共用）
