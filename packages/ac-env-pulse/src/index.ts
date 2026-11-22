// ============================================================
// ac-env-pulse —— 环境脉搏注入行（cr-1182 批3）
//
// 职责：run 启动时（loop/before-run）读系统事件日志 delta
// （ac-system-events 纯库：meta/system-events.jsonl），有增量 →
// [系统状态] 行注入（recordContext 落账 + 同字节 user 行追加——
// ac-memory cr-1102 双写模式，无双计）。水位 per-(agent×会话)
// （files/<agentId>/env-pulse/.anchors.json，cr-1154 同构）。
//
// 摘除语义：本行摘除 = 事件照记（宿主挂点）、无注入——良定义降级。
// 门控：无 conversationId / agent 不注入；session 行未装 → 跳过
//（注入无回放源 = 下轮重复注入——宁可零注入不重复）。
// 首注语义：无水位（新会话）不注全量历史（历史事件对本会话无「自上次
// 活跃后」语义）——水位初始化为当前尾 seq，此后只注增量。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {} from 'ac-agent-loop'; // loop/* 事件类型增强（type-only）
//（cr-1251：wrapSystemReminder import 随双写退役——包裹归 loop 消费点统一处理）
import {
  readSystemEventsSince, renderSystemEvents, maxSeqOfEvents,
} from 'ac-system-events';

/** 注入行 source 词汇（context 行 source；回放档 wrapper——默认即可） */
export const ENV_PULSE_SOURCE = 'system-event';

//（cr-1251：SessionLike 随 recordContext 双写退役删除）
/** 行配置（boot 装配参数——rowOptionsFor 注入 dataRoot） */
export interface EnvPulseRowOptions {
  /** 数据根（缺省 AGENTCHAT_DATA_ROOT 或 './data'） */
  root?: string;
}

export const name = 'ac-env-pulse';

// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'env-pulse',
  label: '环境脉搏',
  description:
    'run 启动时注入系统事件 delta（[系统状态] 行——宿主重启/壳拉起/行集变化等；水位 per-agent×会话，首注只初始化不注历史；recordContext 落账 + user 行双写）',
  listeners: [
    { event: 'loop/before-run', role: '系统事件 delta 注入', description: '读 meta/system-events.jsonl 增量，有变化时注入 [系统状态] 行' },
  ],
};

export function apply(ctx: Context, options: EnvPulseRowOptions = {}) {
  const dataRoot = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');

  // ---- 水位（per-agent×会话；cr-1154 同构：私有状态文件 + 单调不降） ----
  const anchorFile = (agentId: string): string =>
    path.join(dataRoot, 'files', agentId, 'env-pulse', '.anchors.json');
  const anchorOf = (agentId: string, conversationId: string): number | undefined => {
    try {
      const raw = JSON.parse(fs.readFileSync(anchorFile(agentId), 'utf-8')) as Record<string, unknown>;
      const v = raw[conversationId];
      // 0 是合法水位（首注时日志为空）——仅非法类型归 undefined
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const setAnchor = (agentId: string, conversationId: string, seq: number): void => {
    const file = anchorFile(agentId);
    let anchors: Record<string, number> = {};
    try {
      anchors = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
    } catch { /* 缺席/坏文件 → 覆盖重建 */ }
    if ((anchors[conversationId] ?? -1) >= seq) return; // 单调不降（首写 0 也落盘）
    anchors[conversationId] = seq;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(anchors), 'utf-8');
      fs.renameSync(tmp, file);
    } catch { /* fail-soft：写失败 → 下次重注同 delta 一次（幂等收敛） */ }
  };

  ctx.on('loop/before-run', (call, next) => {
    const req = call.request;
    // cr-1233 干跑（previewSystemPrompt）：只读预览不初始化水位/不注
    // delta——预览吃掉水位 = 真实 run 丢注入
    if (req.dryRun === true) return next();
    const convId = req.conversationId;
    const agentId = (req as { agent?: string }).agent;
    if (convId === undefined || agentId === undefined) return next();
    if (call.inject === undefined) return next(); // 注入面缺席（宿主直调）——不注入（防重复）

    const since = anchorOf(agentId, convId);
    if (since === undefined) {
      // 首注：水位初始化为当前尾（不注全量历史——历史事件无「自上次活跃后」语义）
      setAnchor(agentId, convId, maxSeqOfEvents(readSystemEventsSince(dataRoot, 0)));
      return next();
    }
    const delta = readSystemEventsSince(dataRoot, since);
    if (delta.length === 0) return next();
    // 作用域过滤（per-agent 事件只对本 Agent 可见——别的 Agent 的壳拉起不注入）
    const text = renderSystemEvents(delta, agentId);
    if (text === undefined) {
      // delta 非空但全是他方 per-agent 事件：水位照推进（否则每次 run 重扫同批）
      setAnchor(agentId, convId, maxSeqOfEvents(delta));
      return next();
    }
    // cr-1251 注入面单写：消息进数组 + 消费点落账由 loop 统一承担（包裹
    // 同源 wrapSystemReminder——字节与回放恒等）
    call.inject({ role: 'user', content: text }, { injectSource: ENV_PULSE_SOURCE, label: '系统状态变化' });
    // 水位推进到 delta 尾（含被过滤掉的他人事件——否则每次 run 重新扫同一批）
    setAnchor(agentId, convId, maxSeqOfEvents(delta));
    return next();
  }, { description: '系统事件 delta 注入（env-pulse）' });
}
