// ============================================================
// webui/src/clients/runview.ts —— runview 域插件（M27 S2：运行矩阵域）
//
// 归属表 §0.3：runs.ts → runview 域（无后端行；S3 迁移时开首个
// client-only 行 ac-client-runview，D19/D12）。域投影 + ctx.runs 服务面
//（服务名 'runs' 与服务端占名无碰撞，D22 查重通过）：
//   · 快照轮询（3s / 页面不可见跳过）+ 1s 本地时钟（运行时长递增）；
//     定时器随本域 fiber 卸载回收（可摘除性 D19）；
//   · 内容签名短路（快照未变保留对象引用——矩阵 400+ 格 computed
//     级联不重算，实测卡顿主因的历史防御原样继承）；
//   · 域投影不挂全局 pinia（§0.3 红线）——stores/runs.ts 随本迁移退役；
//   · 矩阵轴数据（agents/groups 名册）从 ctx.roster 等服务面取（S2
//     对象层生长后接入；现阶段消费面沿用 agents store 只读）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';
import { fetchRuns, type RunsSnapshot } from '../api/runs';

export interface RunsClientOptions {
  /** 快照轮询间隔（ms；缺省 3000） */
  pollMs?: number;
}

export class RunsClientService extends Service {
  readonly snapshot: Ref<RunsSnapshot | null> = ref(null);
  readonly loadError: Ref<string> = ref('');
  readonly loading: Ref<boolean> = ref(false);
  /** 本地时钟秒针（运行时长递增显示；轮询启动才走表） */
  readonly now: Ref<number> = ref(Date.now());

  /** 构造期 ctx = 本域插件 fiber（轮询定时器绑定于此——卸载即回收） */
  private readonly own: ClientContext;
  private readonly pollMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(ctx: Context, options: RunsClientOptions = {}) {
    super(ctx, 'runs');
    this.own = ctx as ClientContext;
    this.pollMs = options.pollMs ?? 3000;
  }

  /**
   * 拉取快照。**内容未变化时保留原对象引用**（只更新 generatedAt）——
   * 轮询若每次都替换对象，会触发矩阵 400+ 格子的 computed 级联重算与
   * 全量 patch；引用不变则派生全部短路，零渲染。
   */
  async refresh(): Promise<void> {
    // in-flight 防护：慢响应乱序完成会把已更新的 snapshot 回滚成旧快照
    if (this.inFlight) return;
    this.inFlight = true;
    this.loading.value = true;
    try {
      const next = await fetchRuns();
      this.loadError.value = '';
      const cur = this.snapshot.value;
      if (cur && RunsClientService.signature(cur) === RunsClientService.signature(next)) {
        cur.generatedAt = next.generatedAt; // 仅时间戳变化（快照时间显示的小更新）
        return;
      }
      this.snapshot.value = next;
    } catch (err: unknown) {
      this.loadError.value = (err as { message?: string })?.message ?? String(err);
    } finally {
      this.inFlight = false;
      this.loading.value = false;
    }
  }

  /** 首次使用时启动轮询（幂等）；定时器随本域 fiber 卸载回收 */
  ensurePolling(): void {
    if (this.pollTimer) return;
    void this.refresh();
    this.own.fiber.effect(() => {
      this.pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refresh();
      }, this.pollMs);
      this.tickTimer = setInterval(() => { this.now.value = Date.now(); }, 1000);
      return () => this.stopPolling();
    }, 'runs.polling');
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  /** 快照内容签名（剔除每次必变的 generatedAt） */
  private static signature(s: RunsSnapshot): string {
    const { generatedAt: _drop, ...rest } = s;
    return JSON.stringify(rest);
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** runview 域投影（webui 域插件提供）：snapshot/now + refresh/ensurePolling */
    runs: RunsClientService;
  }
}

/** runview 域插件（装配序列第④步：in-bundle；S3 迁移 ac-client-runview 行） */
export const runviewDomainPlugin = clientPlugin({
  name: 'webui-domain-runview',
  async apply(ctx: ClientContext) {
    await ctx.plugin(RunsClientService);
  },
});
