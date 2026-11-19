// ============================================================
// ac-net-monitor/src/service.ts —— 网络状态监控服务（cordis Service）
//
// ctx.netMonitor：探测循环（轮询网卡；断网/疑似期 DNS 兜底）+ 状态
// 快照 + net/* 事件。判定语义住 ac-net-core 纯库（同参恒值可单测）；
// 本服务只做编排：定时轮询、两段式探测调度（wantDns 滞后一轮——
// 在线期零探测流量，用户裁决 3）、翻转事件发射。
//
// 离线闸（cr-1158）：离线时禁止发起网络模型 API 调用——llm/before-chat
// 契约三姿势之一「抛错 = 拒绝本次调用」：dispatch 不执行（零网络请求、
// 零重试退避），chat() 首块前失败照常上抛，loop 构造保真失败步。
// 本地/私网端点豁免（Ollama 等离线可用）；端点解析不出 fail-open
//（放行后由协议层兜底——离线时该路径不劣于现状）。
// ============================================================
import * as os from 'node:os';
import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';
import { Service, type Context } from '@agentchat/cordis';
import {
  analyzeInterfaces,
  initialNetState,
  isLocalBaseUrl,
  nextNetState,
  probeDns,
  type InterfaceSignal,
  type NetState,
} from 'ac-net-core';
import type { LlmChatCall, LlmService, LlmStreamChunk } from 'ac-llm'; // 事件载荷与服务形状（type-only）

const lookupAsync = promisify(dnsLookup) as (h: string) => Promise<{ address: string; family: number }>;

/** 对外快照（事件载荷 + status() 返回） */
export interface NetMonitorSnapshot {
  online: boolean;
  /** 状态翻转时刻（epoch 毫秒） */
  since: number;
  /** 当前有效网卡名清单（诊断面） */
  interfaces: string[];
  /** DNS 兜底已停用（探测延迟 EWMA 超阈——判定退回网卡单源） */
  dnsDisabled?: boolean;
}

export interface NetMonitorOptions {
  /** 轮询间隔毫秒（缺省 3000） */
  pollMs?: number;
  /** DNS 探测主机（缺省 registry.npmjs.org） */
  probeHost?: string;
  /** 单次探测墙钟上限毫秒（缺省 2500——超过按失败计） */
  dnsTimeoutMs?: number;
}

export class NetMonitorService extends Service {
  private state: NetState;
  private readonly pollMs: number;
  private readonly probeHost: string;
  private readonly dnsTimeoutMs: number;
  private lastInterfaces: string[] = [];
  private loopTimer?: NodeJS.Timeout;
  private stopped = false;
  /** 上轮 verdict 的探测请求（两段式：本轮决定是否发 DNS） */
  private dnsWanted = false;
  /** 测试注入口（替换网卡/DNS 探测与时钟；undefined = 真实环境） */
  testProbe?: {
    interfaces: () => InterfaceSignal;
    dns: (host: string) => Promise<number | undefined>;
    now: () => number;
  };

  constructor(ctx: Context, options: NetMonitorOptions = {}) {
    super(ctx, 'netMonitor');
    this.pollMs = options.pollMs ?? 3000;
    this.probeHost = options.probeHost ?? 'registry.npmjs.org';
    this.dnsTimeoutMs = options.dnsTimeoutMs ?? 2500;
    this.state = initialNetState(Date.now());
    ctx.fiber.effect(() => () => this.stop(), 'net-monitor.stop');
    this.registerGate();
    this.scheduleLoop(0); // 首轮 macrotask：测试可在 boot await 后同步注入 testProbe
  }

  /** 当前快照（闸门与诊断面共用） */
  status(): NetMonitorSnapshot {
    return {
      online: this.state.online,
      since: this.state.since,
      interfaces: this.lastInterfaces,
      ...(this.state.dnsDisabled ? { dnsDisabled: true } : {}),
    };
  }

  /** 手动推进一轮（测试用；运行期由 interval 驱动） */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  private stop(): void {
    this.stopped = true;
    if (this.loopTimer !== undefined) clearTimeout(this.loopTimer);
    this.loopTimer = undefined;
  }

  /** 自循环调度（壳基座无 timer 行——原生 setTimeout + unref，随 fiber 卸载清理） */
  private scheduleLoop(delayMs: number): void {
    this.loopTimer = setTimeout(() => void this.runTick(), delayMs);
    (this.loopTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async runTick(): Promise<void> {
    await this.tick();
    if (!this.stopped) this.scheduleLoop(this.pollMs);
  }

  /**
   * 离线闸（构造器注册——this.ctx 经 tracker 指向调用方插件 context，
   * 监听随该 fiber 卸载自动回收）。llm 服务 use-time 软取：事件由 llm
   * 发射，回调时刻它恒在场（credentials 注入同款先例）。
   */
  private registerGate(): void {
    this.ctx.on('llm/before-chat', (call: LlmChatCall, next: () => AsyncIterable<LlmStreamChunk>) => {
      const snap = this.status();
      if (snap.online) return next();
      const llm = this.ctx.get('llm', false) as LlmService | undefined;
      const endpoint = llm === undefined ? undefined : endpointOf(llm, call.input);
      if (endpoint === undefined || isLocalBaseUrl(endpoint)) return next();
      throw new Error(
        `[net-monitor] 本机无网络连接（网卡：${snap.interfaces.join(', ') || '无'}）——已禁止发起网络模型调用（cr-1158）`,
      );
    }, { description: '离线闸：无网络时禁止远程模型调用（本地/私网端点豁免）' });
  }

  private async tick(): Promise<void> {
    const probe = this.testProbe;
    const iface = probe ? probe.interfaces() : analyzeInterfaces(os.networkInterfaces());
    this.lastInterfaces = iface.names;
    // 两段式探测调度：在线期（上轮 wantDns=false）零 DNS 流量；疑似/
    // 离线期按上轮请求探测——阈值判定轮恰好拿到新鲜样本。
    let dnsMs: number | undefined;
    if (this.dnsWanted) {
      const raw = probe ? await probe.dns(this.probeHost) : await probeDns(this.probeHost, lookupAsync);
      dnsMs = raw === undefined || raw > this.dnsTimeoutMs ? undefined : raw;
    }
    const now = probe ? probe.now() : Date.now();
    const next = nextNetState(this.state, iface, dnsMs, now);
    this.state = next;
    this.dnsWanted = next.wantDns;
    if (next.flipped) {
      const snap = this.status();
      this.ctx.emit('net/status', snap);
      this.ctx.emit(next.online ? 'net/online' : 'net/offline', snap);
      this.ctx.logger.info(
        `[net-monitor] 网络${next.online ? '恢复' : '断开'}（网卡：${iface.names.join(', ') || '无'}${next.dnsDisabled ? '；DNS 兜底已停用（探测太慢，退回网卡单源）' : ''})`,
      );
    }
  }
}

/**
 * 解析本次调用的目标端点：显式 provider > 按 model 路由；解析不出
 * （无 provider 注册等）返回 undefined（闸门 fail-open）。
 */
function endpointOf(llm: LlmService, input: { provider?: string; model: string }): string | undefined {
  let name = input.provider;
  if (name === undefined) {
    try {
      name = llm.resolveProvider({ model: input.model });
    } catch {
      return undefined;
    }
  }
  return llm.stats().find((p) => p.name === name)?.baseUrl;
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 网络状态监控服务（ac-net-monitor 提供；cr-1158） */
    netMonitor: NetMonitorService;
  }
}