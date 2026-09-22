// ============================================================
// ac-client-ui-subagent/client/board.ts —— 子 Agent 域投影（board 半边）
//
// 子Agent 持久化清单主源（2026-12：对齐 singles 取值链——注册表面
// subagents/list RPC + subagents/updated 帧驱动刷新，跨重启完整；
// jobBoard（进程内 job 注册中心）不再是子Agent 清单源——运行徽章/停
// 止按钮同链可用：displayStatus running + subagents/stop RPC）。
//   · 域投影 + ctx 服务面（§0.3 层 3）：域件在自己的 fiber 里订阅
//     自己域的帧（subagents/updated → refresh——谁的数据谁订帧）+
//     RPC 拉取，维护投影（reactive），对外经客户端服务面暴露；
//   · 跨域消费一律 inject 服务面（ctx.subagentBoard——服务端已占
//     'subagents' 名，Board 后缀避让，D22 查重纪律）；
//   · 可摘除性（双向）：卸本行 = 前端消费面消失（空态，不报错）；
//     卸后端行 → RPC 失败 → null → 面板静默空态。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { clientPlugin, type ClientContext, type RpcClientFace } from 'ac-client-runtime';
import { ref, type Ref } from 'vue';

// ---- 域契约（契约随 UI 行走：owning = ac-client-ui-subagent） ----

/** 子 Agent 清单行（= ac-subagent SubagentInfo 投影面） */
export interface SubBoardEntry {
  subId: string;
  name?: string;
  parentId?: string;
  task: string;
  /** 徽章词汇：running | done | error | timeout | stopped | idle */
  displayStatus: string;
  runs: number;
  createdAt: number;
  updatedAt: number;
  /** 墓碑标记（展示面「已删除」徽章——会话文件保留，点击仍可看历史） */
  deleted: boolean;
}

/** 拉取子 Agent 清单（含墓碑——展示面保留已删除历史入口；RPC 不可用 →
 *  null：消费面静默空态） */
export async function fetchSubagents(
  rpc: Pick<RpcClientFace, 'call'>,
  limit = 100,
): Promise<SubBoardEntry[] | null> {
  try {
    const r = await rpc.call<{ subs?: Array<Record<string, unknown>> }>('subagents/list', { limit, include_deleted: true });
    return (r.subs ?? []).map((s) => ({
      subId: String(s.id ?? ''),
      ...(typeof s.name === 'string' && s.name ? { name: s.name } : {}),
      ...(typeof s.parentId === 'string' && s.parentId ? { parentId: s.parentId } : {}),
      task: typeof s.task === 'string' ? s.task : '',
      displayStatus: String(s.displayStatus ?? 'idle'),
      runs: typeof s.runs === 'number' ? s.runs : 0,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
      deleted: s.deleted === true,
    }));
  } catch {
    return null;
  }
}

/** 请求停止（true = 确有活跃 run 被停；清单经 subagents/updated 帧刷新） */
export async function stopSubagent(
  id: string,
  rpc: Pick<RpcClientFace, 'call'>,
): Promise<boolean> {
  try {
    const r = await rpc.call<{ stopped?: boolean }>('subagents/stop', { id });
    return r.stopped === true;
  } catch {
    return false; // 失败静默：下轮事件帧对账
  }
}

// ---- 域投影服务 ----

export interface SubagentBoardOptions {
  /** 拉取上限（服务面上限 100） */
  limit?: number;
}

export class SubagentBoardService extends Service {
  /** null = 面不可用（域件未装载/服务未装载/拉取失败）；空数组 = 无子 Agent */
  readonly subs: Ref<SubBoardEntry[] | null> = ref(null);
  /** stop 请求进行中的子 Agent id（按钮态） */
  readonly stopping: Ref<Set<string>> = ref(new Set());

  private readonly own: ClientContext;
  private started = false;
  private inFlight = false;
  private readonly limit: number;

  constructor(ctx: Context, options: SubagentBoardOptions = {}) {
    super(ctx, 'subagentBoard');
    this.own = ctx as ClientContext;
    this.limit = options.limit ?? 100;
  }

  /** 刷新投影（帧连发时合并为一次在途请求） */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const next = await fetchSubagents(this.ctx.get('rpc') as ClientContext['rpc'], this.limit);
      if (next !== null) this.subs.value = next;
    } finally {
      this.inFlight = false;
    }
  }

  /** 请求停止：本地即时标记，终态经 subagents/updated 帧回投后刷新 */
  async stop(id: string): Promise<void> {
    this.stopping.value = new Set(this.stopping.value).add(id);
    try {
      await stopSubagent(id, this.ctx.get('rpc') as ClientContext['rpc']);
      await this.refresh();
    } finally {
      const done = new Set(this.stopping.value);
      done.delete(id);
      this.stopping.value = done;
    }
  }

  /** 首次使用启动（幂等）：初始拉取 + 域帧订阅（随本域 fiber 卸载回收）。
   *  rpc 经 ctx.get 取（root-traced 解析——服务 fiber 内 this.ctx.rpc 直访
   *  在受限调用方下会断链，跨服务访问一律 get，框架铁律 2） */
  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    const rpc = this.ctx.get('rpc') as ClientContext['rpc'];
    this.own.fiber.effect(() => rpc.onEvent((type) => {
      if (type === 'subagents/updated') void this.refresh();
    }), 'subagentBoard.wire');
  }
}

declare module 'ac-client-runtime' {
  interface ClientContext {
    /** subagent 域投影（ac-client-ui-subagent client 半边提供）：subs/stopping + refresh/stop/ensureStarted */
    subagentBoard: SubagentBoardService;
  }
}

export const subagentBoardPlugin = clientPlugin({
  name: 'ac-client-ui-subagent.board',
  inject: ['rpc'],
  async apply(ctx: ClientContext) {
    await ctx.plugin(SubagentBoardService);
  },
});

export default subagentBoardPlugin;
