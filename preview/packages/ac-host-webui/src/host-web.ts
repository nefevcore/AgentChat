// ============================================================
// host-web.ts —— 宿主 web 面接线（8.5a；cr-542 单树装配拆分）
//
// 两段装配原语（宿主 boot 单树形态与独立 web 面形态共用同一份实现）：
//   assembleWebServer(ctx, options)  —— 传输基座行（web-server 主线行零改动
//     导入）。宿主单树里它必须先行：宿主行 inject 面里 ws-bridge / remote-link /
//     webui / web-api / agent-admin 恒依赖 webServer 服务，双 ctx 形态下这些行
//     永 PENDING（await 不报错的静默半激活面——cr-542 探针实证）。
//   attachWebSurface(ctx, options)   —— web 表面：user 桩（R-2）+ webui 行
//     （/api/ui/* + /ui-plugin/ 静态面 + boot graph）+ web-api 薄行。
//
// bootHostWeb = 独立 web 面形态（dev 联调 / webui 产品环测试）：自建 ctx +
// 邮局 + 两段原语 + close 收割。宿主全树 boot 走 apps/host/boot.ts 单树形态
//（同一 ctx 装全部 cordis 行——8.8 装配面收敛的物理形态）。
// ============================================================
import { join } from 'node:path';
import { Context, type Fiber, type Plugin } from '@agentchat/cordis';
import * as configRow from 'ac-config';
import * as convSettingsRow from 'ac-conv-settings';
import { makeSinglesHostRow, makeGroupsHostRow } from 'ac-host-rows';
import type { ShellAdminPort } from './face-shell.ts';
import { WebServerService, type WebServerRowOptions } from 'ac-web-server';
import { PostOffice } from 'ac-post-office';
import { UserStub } from 'ac-host-app/user-stub';
import { makeWebApiRow } from './web-api.ts';
import { makeWebuiRow } from 'ac-ui-app';
import { tapShellStream, ShellStreamBridge, type StreamTapHandle } from 'ac-post-office';

/** 旁带流出口（8.5d：tap 收到旁带帧后的下行——webServer.broadcast 面） */
export type StreamSink = (frame: { type: string; data: { args: unknown[] } }) => void;

/** 宿主 web 面装配结果（独立形态） */
export interface HostWebResult {
  ctx: Context;
  po: PostOffice;
  user: UserStub;
  /** 实际监听端口（port 0 随机口——e2e 用） */
  port: number;
  /**
   * 接壳旁带流（8.5d）：adopt 后接 tap（B3 语义——连接断裂即丢不重连，
   * 新壳 boot.ready 后重新 tap）。桥接件做 StreamFrame → 前端流式帧映射
   *（llm/delta-batch 微批 + llm/delta-end），经 webServer.broadcast 下发。
   */
  tapAgent(agentId: string, transportHint: string): Promise<void>;
  /** 断开某壳的旁带订阅（壳退场时收束——清在途批不丢帧） */
  untapAgent(agentId: string): void;
  close(): Promise<void>;
}

export interface HostWebOptions {
  dataRoot: string;
  /** 缺省 0 = 随机口（测试）；产品面经 config */
  port?: number;
  host?: string;
  /** 静态目录（SPA fallback——dist 未建时省略） */
  staticDir?: string;
  /** 邮局地址（缺省 = <dataRoot>/ipc/post-office） */
  postOfficeAddress?: string;
  /** UI 插件目录（boot graph manifest 扫描 + /ui-plugin/ 静态面同源根；缺省 <dataRoot>/plugins） */
  pluginsDir?: string;
  /** 外部邮局（宿主 boot 先建单例注入——usage 行等收信面共享；缺省自建） */
  postOffice?: PostOffice;
  /** 行集目录（plugin/catalog 的 builtin 组数据源——宿主 boot 传入实际目录） */
  catalogFile?: string;
  /** 编排面惰性端口（conversation/stats 真源 / history 活投影数据面——cr-598；
   * 缺省 = 无活壳面〔stats 恒闲、无活投影〕） */
  shellPort?: () => ShellAdminPort | null;
}

/** web 环装配入参（两段原语共用；邮局恒由调用方持有——收信面单例） */
export interface WebRingOptions {
  dataRoot: string;
  /** 缺省 0 = 随机口 */
  port?: number;
  host?: string;
  staticDir?: string;
  pluginsDir?: string;
  /** 行集目录（plugin/catalog builtin 组；缺省 = preview/apps/catalog） */
  catalogFile?: string;
  /** 编排面惰性端口（壳内服务面——boot 创建 orchestrator 后回填） */
  shellPort?: () => ShellAdminPort | null;
  postOffice: PostOffice;
}

/** web 表面（user 桩 + webui + web-api）装配产物 */
export interface WebRing {
  user: UserStub;
  port: number;
  /** 本表面装配的 fiber（单树形态随宿主 boot 统一收割；独立形态由 close 收割） */
  fibers: Fiber[];
  tapAgent(agentId: string, transportHint: string): Promise<void>;
  untapAgent(agentId: string): void;
  /** 收束全部旁带订阅（连接 + 在途批）——fiber 收割归调用方 */
  closeTaps(): void;
}

/**
 * 传输基座（web-server 行）：装配进给定 ctx 并等就绪。
 * 单树宿主 boot 先行调用——其余行的 inject ['webServer'] 由此满足。
 */
export async function assembleWebServer(ctx: Context, options: WebRingOptions): Promise<Fiber> {
  const serverOptions: WebServerRowOptions = {
    port: options.port ?? 0,
    host: options.host ?? '127.0.0.1',
    ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
  };
  const fiber = ctx.plugin(WebServerService, serverOptions);
  await fiber;
  return fiber;
}

/**
 * web 表面：user 桩起桩（user 端点注册进邮局 local 通道——R-2）+ webui 行
 * （boot graph manifest 单源）+ web-api 薄行（RPC 方法面对齐主线）。
 * 前置：ctx 内 webServer 服务已在位（assembleWebServer）。
 */
export async function attachWebSurface(ctx: Context, options: WebRingOptions): Promise<WebRing> {
  const user = new UserStub(options.postOffice, options.dataRoot);
  user.start();

  const fibers: Fiber[] = [];
  fibers.push(ctx.plugin(makeWebuiRow({ pluginsDir: options.pluginsDir ?? join(options.dataRoot, 'plugins') })));
  fibers.push(ctx.plugin(makeWebApiRow({
    user,
    dataRoot: options.dataRoot,
    ...(options.catalogFile !== undefined ? { catalogFile: options.catalogFile } : {}),
    ...(options.shellPort !== undefined ? { shellPort: options.shellPort } : {}),
  })));
  for (const fiber of fibers) await fiber;
  const port = await ctx.webServer.ready();

  // ---- 旁带流转发（8.5d）：per-agent tap + 桥接件 ----
  const taps = new Map<string, { tap: StreamTapHandle; bridge: ShellStreamBridge }>();
  const closeTaps = (): void => {
    for (const entry of taps.values()) {
      entry.tap.close();
      entry.bridge.close();
    }
    taps.clear();
  };

  return {
    user,
    port,
    fibers,
    async tapAgent(agentId, transportHint) {
      // 重复 tap 幂等（先收旧连接与在途批）
      const existing = taps.get(agentId);
      if (existing !== undefined) {
        existing.tap.close();
        existing.bridge.close();
        taps.delete(agentId);
      }
      const bridge = new ShellStreamBridge({
        send: (frame) => ctx.webServer.broadcast(frame.type, frame.data),
      });
      const tap = await tapShellStream(transportHint, (frame) => bridge.ingest(frame));
      taps.set(agentId, { tap, bridge });
    },
    untapAgent(agentId) {
      const entry = taps.get(agentId);
      if (entry === undefined) return;
      entry.tap.close();
      entry.bridge.close();
      taps.delete(agentId);
    },
    closeTaps,
  };
}

/**
 * 独立 web 面装配（可测半边）：自建 ctx + 邮局（未注入时）+ 两段原语 +
 * 逆序收割。宿主全树形态见 apps/host/boot.ts。
 */
export async function bootHostWeb(options: HostWebOptions): Promise<HostWebResult> {
  // 邮局单例（cr-538）：宿主 boot 先建注入复用；独立调用缺省自建。
  // close 责任随所有权——注入的邮局不在此收（boot 统一收）。
  const external = options.postOffice;
  const po = external ?? new PostOffice({
    dataRoot: options.dataRoot,
    ...(options.postOfficeAddress !== undefined ? { address: options.postOfficeAddress } : {}),
  });
  if (external === undefined) await po.listen();

  const ctx = new Context();
  const fiber = await assembleWebServer(ctx, { ...options, postOffice: po });
  // 配置域 / 会话覆盖域服务：config 写面与 conv-settings 写面的落盘 owning
  // service——独立 web 环同样是「设置页真能用」的形态，缺它对应 RPC 只能
  // fail-loud（cr-564 / cr-565）
  const configFiber = ctx.plugin(configRow as unknown as Plugin, { root: options.dataRoot });
  const convSettingsFiber = ctx.plugin(convSettingsRow as unknown as Plugin, { root: options.dataRoot });
  // 独立会话元数据行（cr-566）：singles/* RPC 的 owning 行（inject webServer）
  const singlesFiber = ctx.plugin(makeSinglesHostRow({ dataRoot: options.dataRoot }) as unknown as Plugin);
  // 群存储行（cr-576）：group/* RPC 的 owning 行（成员表 + 信封扇出 + 成员流读面）
  const groupsFiber = ctx.plugin(makeGroupsHostRow({ dataRoot: options.dataRoot, postOffice: po }) as unknown as Plugin);
  await configFiber;
  await convSettingsFiber;
  await singlesFiber;
  await groupsFiber;
  const ring = await attachWebSurface(ctx, { ...options, postOffice: po });

  return {
    ctx,
    po,
    user: ring.user,
    port: ring.port,
    tapAgent: ring.tapAgent,
    untapAgent: ring.untapAgent,
    async close() {
      ring.closeTaps();
      // 逆序 dispose（后装先收——web-api 先于 webui 先于 group 先于 singles 先于 config 先于 webServer 断开）
      for (const f of [...ring.fibers, groupsFiber, singlesFiber, convSettingsFiber, configFiber, fiber].reverse()) {
        if (f.uid !== null) await f.dispose();
      }
      if (external === undefined) await po.close(); // 注入邮局归 boot 收
    },
  };
}
