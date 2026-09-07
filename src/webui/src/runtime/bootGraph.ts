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
// 行卸载 → 不在 graph → 该域前端消费面一并消失（D19 语义；热通道
// 经 webui/boot-graph-changed 重拉收缩，S3 热通道后续接入）。
// ============================================================
import type { ClientContext, ClientPluginObject } from 'ac-client-runtime';
// ctx.runs 契约增强（行 client 半边声明合并——webui 消费面类型可见）
import type {} from 'ac-client-runview/client';
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

async function loadEntry(def: RowClientGraphEntry): Promise<void> {
  const ctx = clientRuntime();
  if (!ctx) throw new Error('boot graph: client runtime 未装配');
  const loader = (rowClientLoaders as Record<string, (() => Promise<unknown>) | undefined>)[def.name];
  if (!loader) {
    console.warn(`[boot-graph] 行 "${def.name}" 声明了 client 半边但静态映射缺失（构建图未含该行）——跳过`);
    return;
  }
  const mod = (await loader()) as { default?: unknown; runviewClientPlugin?: unknown };
  const plugin = (mod.default ?? mod.runviewClientPlugin) as
    | { name?: string; apply?: (ctx: ClientContext) => unknown }
    | undefined;
  if (!plugin || typeof plugin.apply !== 'function') {
    console.warn(`[boot-graph] 行 "${def.name}" client 模块缺省导出插件（default apply）——跳过`);
    return;
  }
  await ctx.plugin(plugin as unknown as ClientPluginObject);
}

/**
 * 装配序列第④步：按 boot graph 装载行 client 半边。
 * 逐行装载（一行失败隔离——不影响其余行与基础件）。
 */
export async function applyBootGraph(): Promise<void> {
  const graph = await fetchBootGraph();
  for (const def of graph) {
    if (def.platform !== 'web') continue;
    try {
      await loadEntry(def);
    } catch (err) {
      console.error(`[boot-graph] 行 "${def.name}" client 装载失败：`, err);
    }
  }
}
