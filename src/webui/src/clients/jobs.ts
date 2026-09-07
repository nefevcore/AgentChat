// ============================================================
// webui/src/clients/jobs.ts —— jobs 域插件（M27 S2 首个域插件试点）
//
// 「域投影 + ctx 服务面」形态验证（m27 §0.3 层 3 / S2 单域小 store 先行）：
//   · 域插件在自己的 fiber 里订阅【自己域】的 ws 帧（job/started ·
//     job/settled → 重拉 jobs/list——谁的数据谁订帧）+ RPC 拉取，
//     维护投影（reactive），对外经客户端服务面暴露；
//   · 跨域消费一律 inject 服务面（ctx.jobBoard——服务名避让服务端
//     'jobs' 占名，D22 查重纪律；归属表 §0.3 的 ctx.jobs 草名据此让位）；
//   · 可摘除性（D19）：卸载本插件 = 后端 ac-jobs 行的前端消费面一并
//     消失（ctx.jobBoard 不可解析 → RunTrackingPanel 渲染空态，不报错）；
//   · 域投影不挂全局 pinia（§0.3 红线）——stores/jobs.ts 随本迁移退役。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';
import { wireRpc } from '../api/wire.ts';
import { fetchJobs, killJob, type WireJob } from '../api/jobs.ts';

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
      const next = await fetchJobs();
      if (next !== null) this.jobs.value = next;
    } finally {
      this.inFlight = false;
    }
  }

  /** 请求取消：本地即时标记 killing，终态经 job/settled 帧回投后刷新 */
  async kill(id: string): Promise<void> {
    this.killing.value = new Set(this.killing.value).add(id);
    try {
      await killJob(id);
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
    this.own.fiber.effect(() => {
      const off = wireRpc.onWireEvent((type) => {
        if (type === 'job/started' || type === 'job/settled') void this.refresh();
      });
      return off;
    }, 'jobBoard.wire');
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** jobs 域投影（webui 域插件提供）：jobs/killing + refresh/kill/ensureStarted */
    jobBoard: JobBoardService;
  }
}

/** jobs 域插件（装配序列第④步：按 boot graph 装配域插件——in-bundle） */
export const jobsDomainPlugin = clientPlugin({
  name: 'webui-domain-jobs',
  async apply(ctx: ClientContext) {
    await ctx.plugin(JobBoardService);
  },
});
