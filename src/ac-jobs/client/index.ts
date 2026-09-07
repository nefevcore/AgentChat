// ============================================================
// ac-jobs/client/index.ts —— jobs client 半边（M27 S3-1b 行包双半边）
//
// 自 webui/src/clients/jobs.ts 迁入（S2 域插件试点升行包形态，D19）：
// 「域投影 + ctx 服务面」（§0.3 层 3）——
//   · 域插件在自己的 fiber 里订阅【自己域】的事件帧（job/started ·
//     job/settled → 重拉 jobs/list——谁的数据谁订帧）+ RPC 拉取，
//     维护投影（reactive），对外经客户端服务面暴露；
//   · 跨域消费一律 inject 服务面（ctx.jobBoard——服务名避让服务端
//     'jobs' 占名，D22 查重纪律）；
//   · 可摘除性（D19）：卸载 ac-jobs 行 = 后端能力 + 前端消费面一并
//     消失（ctx.jobBoard 不可解析 → RunTrackingPanel 空态，不报错）。
// 数据经 ctx.rpc 契约面（call + onEvent 事件帧订阅）——不 import webui
// 内部模块。依赖一律 inject 声明（D6）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';

// ---- 域契约（契约随行走：owning = ac-jobs 行包双半边） ----

/** 任务快照线形（= ac-jobs JobSnapshot；meta.output 为 500 字预览；webui api/jobs.ts re-export 维持旧路径） */
export interface WireJob {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  ownerAgentId?: string;
  conversationId?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  meta?: Record<string, unknown>;
}

/** 拉取任务清单（RPC 不可用 → null：面板静默隐藏，不报错） */
export async function fetchJobs(rpc: Pick<RpcClientFace, 'call'>): Promise<WireJob[] | null> {
  try {
    const r = await rpc.call<{ jobs?: WireJob[] }>('jobs/list');
    return Array.isArray(r.jobs) ? r.jobs : [];
  } catch {
    return null;
  }
}

/** 请求取消（宿主全权；真正终态经 job/settled 帧回投后清单刷新） */
export async function killJob(
  id: string,
  rpc: Pick<RpcClientFace, 'call'>,
): Promise<{ outcome?: string } | null> {
  try {
    return await rpc.call<{ outcome?: string }>('jobs/kill', { id });
  } catch {
    return null; // 失败静默：下轮事件帧对账
  }
}

// ---- 域投影服务 ----

export interface JobBoardOptions {
  /** 预留（暂无可配置项；对齐 cordis Service 构造签名形态） */
}

export class JobBoardService extends Service {
  /** null = 面不可用（域件未装载/服务未装载/拉取失败）；空数组 = 无任务 */
  readonly jobs: Ref<WireJob[] | null> = ref(null);
  /** kill 请求进行中的任务 id（按钮态） */
  readonly killing: Ref<Set<string>> = ref(new Set());

  /** 构造期 ctx = 本域插件 fiber（订阅绑定于此——卸载即回收，D5） */
  private readonly own: ClientContext;
  private started = false;
  private inFlight = false;

  constructor(ctx: Context, options: JobBoardOptions = {}) {
    super(ctx, 'jobBoard');
    this.own = ctx as ClientContext;
    void options; // 预留（对齐 SlotsService 构造签名形态——无必选配置）
  }

  /** 刷新投影（started/settled 连发时合并为一次在途请求） */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const next = await fetchJobs(this.own.rpc);
      if (next !== null) this.jobs.value = next;
    } finally {
      this.inFlight = false;
    }
  }

  /** 请求取消：本地即时标记 killing，终态经 job/settled 帧回投后刷新 */
  async kill(id: string): Promise<void> {
    this.killing.value = new Set(this.killing.value).add(id);
    try {
      await killJob(id, this.own.rpc);
      await this.refresh();
    } finally {
      const done = new Set(this.killing.value);
      done.delete(id);
      this.killing.value = done;
    }
  }

  /** 首次使用启动（幂等）：初始拉取 + 域帧订阅（随本域 fiber 卸载回收） */
  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    this.own.fiber.effect(() => this.own.rpc.onEvent((type) => {
      if (type === 'job/started' || type === 'job/settled') void this.refresh();
    }), 'jobBoard.wire');
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** jobs 域投影（ac-jobs client 半边提供）：jobs/killing + refresh/kill/ensureStarted */
    jobBoard: JobBoardService;
  }
}

/** jobs 域 client 半边插件（boot graph 装载；宿主半边见 src/index.ts） */
export const jobsClientPlugin = clientPlugin({
  name: 'ac-jobs.client',
  inject: ['rpc'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(JobBoardService);
  },
});

export default jobsClientPlugin;
