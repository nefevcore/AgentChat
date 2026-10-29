// ============================================================
// usage-row.ts —— 宿主 usage 行（cr-538：R1 usage 行「计费聚合（对账
// ledger 自报事件信）」preview 落地）
//
// 形态：UsageService 聚合并（主线零改动导入）+ host 端点收信面
//（UserStub 同构——邮局 local 通道）。壳 usage 事件信（kind=receipt /
// subject=usage-run）到达 → requestId 幂等去重 → reportMeter 入账
//（审计流水 + 内存聚合——查询面/webui 数据源与主线恒等）。
// 主线 UsageService 的 loop/after-run 订阅在宿主进程内空转零成本
//（无 loop 事件源——计量经事件信到达）。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import { UsageService, type UsageRowOptions } from 'ac-usage';
import type { Envelope, UsageReportPayload, UsageStepPayload } from 'ac-envelope-core';
import { isUsageReport, validateUsagePayload } from 'ac-envelope-core';
import type { HostInbox } from './host-inbox.ts';

/** usage 行装配参数 */
export interface UsageHostRowOptions extends UsageRowOptions {
  /** host 端点收信扇出面（cr-545 起与 auth-registry 行共用——boot 建 HostInbox 注入） */
  inbox: HostInbox;
}

/**
 * 宿主 usage 行：UsageService 聚合并 + host 端点收信面。
 * 服务实例直引（不经 ctx.usage getter——插件 inject 声明在同 fiber
 * 自注册场景会 PENDING 死锁；服务键注册照常，主线消费面不受影响）。
 */
export function makeUsageHostRow(options: UsageHostRowOptions): Plugin {
  return {
    name: 'host-usage-row',
    inject: [],
    apply(ctx: Context) {
      let svc: UsageService | null = null;
      ctx.plugin(class extends UsageService {
        constructor(c: Context) { super(c, options); svc = this; }
      });
      // host 端点收信面（HostInbox 扇出面——cr-545 起与 auth-registry 共存；
      // 非 usage 信静默直过〔回执/授权各归消费面〕，非法 payload 抛错 = 投递
      // 失败滞留重试〔fail-loud——原 warn+ack 吞错形态退役〕）
      options.inbox.on(async (env: Envelope) => {
        if (!isUsageReport(env)) return;
        const issues = validateUsagePayload(env.payload);
        if (issues.length > 0) throw new Error('[usage] 事件信 payload 非法：' + issues.join('；'));
        const p = env.payload as UsageReportPayload | UsageStepPayload;
        if (svc === null) return; // 服务未就绪（理论上不可达——构造先于注册）
        // 步级缓存信（cr-760）：pending 入账——运行中 run 的 KV 走势实时段
        if (p.subject === 'usage-step') {
          svc.reportStepPending(p.conversationId, { ts: p.ts, hit: p.hit, miss: p.miss });
          return;
        }
        svc.reportMeter({
          agent: p.agent,
          model: p.model,
          finish: p.finish,
          usage: p.usage,
          conversationId: p.conversationId,
          ...(p.stepCache !== undefined ? { stepCache: p.stepCache } : {}),
        });
      });
    },
  } satisfies Plugin;
}