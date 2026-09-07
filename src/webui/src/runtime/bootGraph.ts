// ============================================================
// webui/src/runtime/bootGraph.ts —— boot graph 装载器（M27 S3/D7/D19）
//
// 装配序列第④步：拉取宿主 boot graph（/api/ui/boot-graph——行声明
// 的 client 半边清单）→ 按图装载 client 模块。
//
// 模块解析双轨：
//   · dev 期：vite 直服行包 client/ 源码（/@fs/<abs>——server.fs.allow
//     覆盖仓库根）；
//   · prod 期：vite 插件（vite.config.ts rowClientsPlugin）把全部行
//     client 构建为模块块并生成【静态 loader 映射】virtual 模块——
//     本装载器优先用静态映射（graph 条目给名字，映射给代码位置）。
// 行卸载 → 不在 graph → 该域前端消费面一并消失（D19 语义）。
//
// 热通道（S3）：宿主行装载/卸载 → webui/boot-graph-changed 帧（ws-bridge
// 转发）→ debounce 重拉全图 diff——不在图者【先回收 fiber 后清缓存】
// （slot 贡献/客户端服务级联回收），新增者装载；已装载者不动。
// ============================================================
import type { ClientContext, ClientPluginObject } from 'ac-client-runtime';
import type { Fiber } from '@agentchat/cordis';
// 行 client 半边契约增强（声明合并——webui 消费面类型可见；逐域随行走生长）
import type {} from 'ac-client-runview/client';
import type {} from 'ac-client-ui-todo/client';
import type {} from 'ac-client-ui-jobs/client';
import type {} from 'ac-group/client';
import type {} from 'ac-singles/client';
import type {} from 'ac-client-ui-workspace/client';
import type {} from 'ac-agents/client';
import { clientRuntime } from './clientRuntime';
// 静态 loader 映射（virtual 模块——vite 插件生成：行名 → () => import）
import { rowClientLoaders } from 'virtual:row-clients';

/** boot graph 条目（宿主 /api/ui/boot-graph 载荷；与 ac-webui 契约同形） */
interface RowClientGraphEntry {
  name: string;
  entry: string;
  platform: 'web';
  phase?: 'base' | 'domain';
}

/** 热通道 debounce（ms）——帧风暴（行集批量变更）收敛为一次重拉 */
const HOT_SYNC_DEBOUNCE_MS = 300;

async function fetchBootGraph(): Promise<RowClientGraphEntry[]> {
  try {
    const res = await fetch('/api/ui/boot-graph');
    if (!res.ok) return [];
    const data = (await res.json()) as { clients?: RowClientGraphEntry[] };
    return data.clients ?? [];
  } catch {
    return []; // 宿主不可达（旧后端）→ 空图（in-bundle 基础件不受影响）
  }
}

/** 已装载行 client fiber（热通道 diff 的回收面） */
const loadedRows = new Map<string, Fiber>();

async function loadEntry(def: RowClientGraphEntry): Promise<void> {
  const ctx = clientRuntime();
  if (!ctx) throw new Error('boot graph: client runtime 未装配');
  const loader = (rowClientLoaders as Record<string, (() => Promise<unknown>) | undefined>)[def.name];
  if (!loader) {
    console.warn(`[boot-graph] 行 "${def.name}" 声明了 client 半边但静态映射缺失（构建图未含该行）——跳过`);
    return;
  }
  const mod = (await loader()) as { default?: unknown };
  const plugin = mod.default as
    | { name?: string; apply?: (ctx: ClientContext) => unknown }
    | undefined;
  if (!plugin || typeof plugin.apply !== 'function') {
    console.warn(`[boot-graph] 行 "${def.name}" client 模块缺省导出插件（default apply）——跳过`);
    return;
  }
  const fiber = await ctx.plugin(plugin as unknown as ClientPluginObject);
  loadedRows.set(def.name, fiber);
}

/** 拉图 + diff：卸载先回收 fiber 后清缓存；新增装载；既有不动 */
async function syncGraph(): Promise<void> {
  const graph = (await fetchBootGraph()).filter((d) => d.platform === 'web');
  const names = new Set(graph.map((d) => d.name));
  for (const [name, fiber] of [...loadedRows]) {
    if (names.has(name)) continue;
    loadedRows.delete(name); // 先清缓存（防重入）再回收 fiber（级联贡献）
    await fiber.dispose();
  }
  for (const def of graph) {
    if (loadedRows.has(def.name)) continue;
    try {
      await loadEntry(def);
    } catch (err) {
      console.error(`[boot-graph] 行 "${def.name}" client 装载失败：`, err);
    }
  }
}

/** 热通道：boot graph 变更帧 → debounce 重拉 diff（装载器生命周期常驻） */
function bindHotSync(ctx: ClientContext): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = ctx.rpc.onEvent((type) => {
    if (type !== 'webui/boot-graph-changed') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncGraph();
    }, HOT_SYNC_DEBOUNCE_MS);
  });
  ctx.effect(() => {
    if (timer) clearTimeout(timer);
    return () => off();
  });
}

/**
 * 装配序列第④步：按 boot graph 装载行 client 半边 + 接入热通道。
 * 逐行装载（一行失败隔离——不影响其余行与基础件）。
 */
export async function applyBootGraph(): Promise<void> {
  await syncGraph();
  const ctx = clientRuntime();
  if (ctx) bindHotSync(ctx);
}
