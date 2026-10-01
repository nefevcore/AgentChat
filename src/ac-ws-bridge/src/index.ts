// ============================================================
// ac-ws-bridge —— WS 事件桥接订阅行（地图 §3.3：WSHandler 的桥接半边）
//
// src WSHandler 的 preview 形态：**零业务状态**——不 inject 任何业务服务，
// 只做 ctx.on(emit 面) → ctx.webServer.broadcast(type=事件名, {args})。
//
//   · 桥接词汇：帧 type = 事件名直转（机器可读事件目录即协议目录）；
//     帧载荷 { args: [...] }（事件参数序同名目录，前端按目录解构）
//   · 桥接策略（订阅清单/过滤/整形）住 ac-wire-format 的 createBridgeCatalog
//     （cr-108 并源：remote-link 下行链路消费同一目录——两链不再各自持清单走散）；
//     本行注入域判定（isGroupHint/isBackgroundSender/isArchiveReviewRun——
//     域词汇住各域包，纯库零域依赖）
//   · waterfall 事件（before-*/transform-*）绝不桥——拦截链不是广播面
//   · llm/delta 微批是本行性能机制（30ms 窗口，LlmDeltaBatcher）；remote 链路
//     批器实例独立
//   · 摘行即静默：桥接面消失，webServer 与事件源互不影响
// ============================================================
import type { Context } from '@agentchat/cordis';
import { isArchiveReviewRun } from 'ac-agent-loop';
import { isGroupHint } from 'ac-core-utils';
import { isBackgroundSender } from 'ac-ws-protocol';
import { LlmDeltaBatcher, LLM_DELTA_BATCH, createBridgeCatalog } from 'ac-wire-format';

// 桥接面类型增强（type-only；运行时零依赖——只经 ctx.on 订阅）
import type {} from 'ac-llm';
import type {} from 'ac-tools';
import type {} from 'ac-router';
import type {} from 'ac-conversation';
import type {} from 'ac-group';
import type {} from 'ac-config';
import type {} from 'ac-jobs';
import type {} from 'ac-durable-interaction';
import type {} from 'ac-plugin-registry';
import type {} from 'ac-webui';
import type {} from 'ac-archive';
import type {} from 'ac-agents';
import type {} from 'ac-subagent';
import type {} from 'ac-restart';

export const name = 'ac-ws-bridge';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ws-bridge',
  label: 'WS 事件桥',
  description: 'emit 面 → WS 帧桥接（router/*、loop/*、llm/delta-* 等事件流转发前端）',
  automatic: true,
};

export const inject = ['webServer'];

export interface WsBridgeRowOptions {
  /**
   * 后台会话过滤开关（缺省开）。关闭时全部事件广播（诊断用）。
   */
  backgroundFilter?: boolean;
}

export function apply(ctx: Context, options: WsBridgeRowOptions = {}) {
  const catalog = createBridgeCatalog({
    isBackgroundSender,
    isArchiveReviewRun,
    isGroupHint,
    backgroundFilter: options.backgroundFilter,
  });

  // ---- 通用转发：帧载荷 { args: [...] } ----
  const forward = (name: string, args: unknown[]) => {
    ctx.webServer.broadcast(name, { args });
  };

  // llm/delta 微批（cr-85）：30ms 窗口攒帧——帧量降一个数量级，慢消费端不再逐帧
  // 摊发送开销（2026-09-05 OOM 事故的载荷放大类别从根上消除）。行卸载清空在途
  // 批（不丢帧）：disposer 经 ctx.effect 挂本行 fiber——注册即归属。
  const deltaBatcher = new LlmDeltaBatcher((args) => forward(LLM_DELTA_BATCH, [args]));
  ctx.effect(() => () => deltaBatcher.flushNow());

  // ---- 目录订阅（清单/过滤/整形住共享目录；delta 家族由批器接管） ----
  for (const ev of catalog.events) {
    if (ev.kind === 'delta') continue;
    ctx.on(ev.name as never, ((...args: unknown[]) => {
      const wired = ev.wire ? ev.wire(args) : args;
      if (wired === undefined) return;
      forward(ev.name, wired);
    }) as never, { description: `WS 桥接：转发 ${ev.name} 为前端帧（后台会话过滤）` });
  }

  // delta 家族：start/end 边界直转（含批器清界），delta 本体进批器（wire 投影在批器内）
  const deltaEv = catalog.events.find((e) => e.name === 'llm/delta');
  ctx.on('llm/delta-start' as never, ((input: unknown, meta: unknown) => {
    const wired = deltaEv?.wire?.([input, undefined, meta]);
    if (wired === undefined) return;
    forward('llm/delta-start', wired);
  }) as never, { description: 'WS 桥接：转发 llm/delta-start 为前端帧' });
  ctx.on('llm/delta' as never, ((input: unknown, chunk: unknown, meta: unknown) => {
    const wired = deltaEv?.wire?.([input, chunk, meta]);
    if (wired === undefined) return;
    // 批器吃原始 (input, chunk, meta)——投影在其内部（首帧立即发的语义留在批器）
    deltaBatcher.push(input, chunk, meta);
  }) as never, { description: 'WS 桥接：llm/delta 微批转发' });
  ctx.on('llm/delta-end' as never, ((input: unknown, meta: unknown) => {
    const wired = deltaEv?.wire?.([input, undefined, meta]);
    if (wired === undefined) return;
    deltaBatcher.flushNow(); // 批与边界保序：end 前清空在途 delta
    forward('llm/delta-end', wired);
  }) as never, { description: 'WS 桥接：转发 llm/delta-end 为前端帧' });
}
