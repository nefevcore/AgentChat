// ============================================================
// ac-net-monitor/src/service.ts —— 网络状态监控服务（cordis Service）
//
// ctx.netMonitor：探测循环（轮询网卡；断网/疑似期 DNS 兜底）+ 状态
// 快照 + net/* 事件。判定语义住 ac-net-core 纯库（同参恒值可单测）；
// 本服务只做编排：定时轮询、两段式探测调度（wantDns 滞后一轮——
// 在线期零探测流量，用户裁决 3）、翻转事件发射。
//
// 端点预检（cr-1264 加固）：online 态下对本次调用端点 host 做单次
// DNS 预检——「连接在、DNS 坏」形态（ENOTFOUND）在闸门处毫秒级拒绝，
// 不再进 fetch 重试链。
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
  hostOfBaseUrl,
  initialNetState,
  isIpLiteralHost,
  isLocalBaseUrl,
  nextNetState,
  preflightDns,
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
  /** 因虚拟宿主网卡被排除的接口名清单（诊断面，cr-1264） */
  virtualInterfaces?: string[];
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
  /** 闸门端点预检超时毫秒（缺省 1200——超时放行不拖累调用，cr-1264） */
  preflightTimeoutMs?: number;
}

export class NetMonitorService extends Service {
  private state: NetState;
  private readonly pollMs: number;
  private readonly probeHost: string;
  private readonly dnsTimeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private lastVirtualInterfaces: string[] = [];
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
    /** 端点预检注入口（cr-1264；undefined = 真实环境 dns lookup） */
    preflight?: (host: string, timeoutMs: number) => Promise<'pass' | 'fail' | 'timeout'>;
  };

  constructor(ctx: Context, options: NetMonitorOptions = {}) {
    super(ctx, 'netMonitor');
    this.pollMs = options.pollMs ?? 3000;
    this.probeHost = options.probeHost ?? 'registry.npmjs.org';
    this.dnsTimeoutMs = options.dnsTimeoutMs ?? 2500;
    this.preflightTimeoutMs = options.preflightTimeoutMs ?? 1200;
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
      ...(this.lastVirtualInterfaces.length ? { virtualInterfaces: this.lastVirtualInterfaces } : {}),
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
   *
   * 在线期端点预检（cr-1264）：状态 online 时对本次调用端点 host 做
   * 单次 DNS lookup——解析失败即毫秒级拒绝（ENOTFOUND 的 fetch 必败，
   * 拒绝不损失任何本会成功的调用）；成功解析顺带暖 undici 连接池的
   * DNS 缓存。超时/解析不出 host 放行（fail-open，慢 DNS 不拖累调用）。
   */
  private registerGate(): void {
    // 监听器必须同步返回 AsyncIterable（waterfall 同步透传、消费方
    // yield* 直接委派——async 函数返回 Promise 会炸链）；异步预检住
    // 生成器内：首块 chunk 产出前完成，失败抛错 = 拒绝（dispatch 零执行）。
    this.ctx.on('llm/before-chat', (call: LlmChatCall, next: () => AsyncIterable<LlmStreamChunk>): AsyncIterable<LlmStreamChunk> => {
      const snap = this.status();
      const llm = this.ctx.get('llm', false) as LlmService | undefined;
      const endpoint = llm === undefined ? undefined : endpointOf(llm, call.input);
      if (!snap.online) {
        if (endpoint === undefined || isLocalBaseUrl(endpoint)) return next();
        throw new Error(
          `[net-monitor] 本机无网络连接（网卡：${snap.interfaces.join(', ') || '无'}${this.virtualSuffix(snap)}）——已禁止发起网络模型调用（cr-1158）`,
        );
      }
      // 加固路径：连接在、DNS 坏（ENOTFOUND 形态）。本地端点与 IP 字面量
      //（无 DNS 环节）不预检，直接放行。
      if (endpoint === undefined || isLocalBaseUrl(endpoint)) return next();
      const host = hostOfBaseUrl(endpoint);
      if (host === undefined || isIpLiteralHost(host)) return next();
      const preflight = this.testProbe?.preflight ?? ((h: string, tms: number) => preflightDns(h, lookupAsync, tms));
      const delegate = next;
      const timeoutMs = this.preflightTimeoutMs;
      return (async function* (): AsyncGenerator<LlmStreamChunk> {
        const verdict = await preflight(host, timeoutMs);
        if (verdict === 'fail') {
          throw new Error(
            `[net-monitor] 端点域名无法解析（${host}）——本机 DNS 故障或网络半断，已禁止发起网络模型调用（cr-1264）`,
          );
        }
        yield* delegate();
      })();
    }, { description: '离线闸：无网络时禁止远程模型调用；在线期端点 DNS 预检（cr-1264）' });
  }

  /** 断网诊断后缀：虚拟网卡被排除在场时透出（帮用户理解为何被判离线） */
  private virtualSuffix(snap: NetMonitorSnapshot): string {
    const v = snap.virtualInterfaces ?? [];
    return v.length ? `；已排除虚拟网卡：${v.join(', ')}` : '';
  }

  private async tick(): Promise<void> {
    const probe = this.testProbe;
    const iface = probe ? probe.interfaces() : analyzeInterfaces(os.networkInterfaces());
    this.lastInterfaces = iface.names;
    this.lastVirtualInterfaces = iface.virtualNames;
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
        `[net-monitor] 网络${next.online ? '恢复' : '断开'}（网卡：${iface.names.join(', ') || '无'}${iface.virtualNames.length ? `；已排除虚拟网卡：${iface.virtualNames.join(', ')}` : ''}${next.dnsDisabled ? '；DNS 兜底已停用（探测太慢，退回网卡单源）' : ''})`,
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