// ============================================================
// boot-v3.ts —— 壳 v3 装配序列（cr-929 切片①；webui-v3 §4.1 壳 v3）
//
// 与旧 boot.ts 并存至 cutover（切片②全量切换、③删旧链）。差异：
//   ④ 通道装载 → wire 装载：GET /api/ui/wire（全量幂等）→
//      ClientModuleSystem（lazy CJS 模块表 + 种子词表）逐行物化 →
//      default export 插件对象 ctx.plugin → 席位渲染。
//      importmap / __ac_channel_modules__ / shared-modules 收集 / 
//      installChannelImportmap 全部退役（裁决二）——种子词即解析面。
//   更新 = WS wire/graph·wire/rebuilt 帧（rpc-wire 同通道）→ 重拉全量
//      wire + 失效 memo 重物化（断连重拉语义，切片①后续接线）。
// 骨架 3 件仍 in-bundle 直载（协议持有者）；isolated 行对接归切片②
//（裁决八：独立模块表 + 自含产物——不进主文档物化面）。
// ============================================================
import type { ClientContext, ClientPluginObject } from 'ac-client-runtime';
import { createClient } from 'ac-client-runtime';
import type { Wire, WireRow } from 'ac-webui-core';
import { makeRpcHostPlugin, type RpcWire } from './rpc-host.ts';
import { skeletonPlugins, loadChannelCss } from './boot.ts';
import { skeletonSeedsV3 } from './seeds-v3.ts';
import { createClientModuleSystem, type ScriptLoader } from './module-system.ts';
import { hostUrl } from './host-endpoint.ts';

export interface BootV3Options {
  /** rpc wire（域件公共依赖 ctx.rpc 的传输实现；缺省拒绝桩） */
  rpcWire?: RpcWire;
  /** wire 拉取（缺省 fetch /api/ui/wire；测试注入） */
  fetchWire?: () => Promise<Wire>;
  /** bundle 到达注入点（缺省 <script>；测试 fetch+eval） */
  loadScript?: ScriptLoader;
  /** 种子词表（缺省 skeletonSeedsV3()——壳活实例单源，v3 形态） */
  seeds?: Record<string, unknown>;
}

export interface BootV3Result {
  ctx: ClientContext;
  /** 装载结果（行 id → ok/err——逐条隔离语义与旧链一致） */
  channel: Map<string, 'ok' | 'err'>;
  /** 模块系统（wire/rebuilt 帧消费面——invalidate + importWire） */
  modules: ReturnType<typeof createClientModuleSystem>;
  wire: Wire;
  /**
   * wire/graph 帧消费（§4.3.3 断连/更新语义：重拉全量 wire → 差分行
   * 重物化）：新行与 rev 变化行 invalidate → ensure → 物化 → ctx.plugin；
   * 行移除的卸载面归席位回收（本批不拆件——CR 注记）。重载后 wire 更新。
   */
  reload: () => Promise<void>;
}

async function defaultFetchWire(): Promise<Wire> {
  const res = await fetch(hostUrl('/api/ui/wire'), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('wire ' + res.status);
  return await res.json() as Wire;
}

/**
 * 壳 v3 装配序列：① createClient → ①.5 rpc host → ② 骨架 3 件 in-bundle
 * → ③ sealFactory → ④ wire 装载（模块表逐行物化 → ctx.plugin）。
 * 可测：options 注入 fetchWire/loadScript 后在 jsdom 内全链跑。
 */
export async function bootUiClientV3(options: BootV3Options = {}): Promise<BootV3Result> {
  const fetchWire = options.fetchWire ?? defaultFetchWire;
  const wire = await fetchWire();
  const rowsById = new Map<string, WireRow>(wire.rows.map((r) => [r.id, r]));
  // 深路径归一（<pkg>/client... → <pkg> 行）：仅命中 wire 行 id 的前缀词
  const rowsOf = (spec: string): string | undefined => {
    for (const id of rowsById.keys()) {
      if (spec === id || spec.startsWith(id + '/client')) return id;
    }
    return undefined;
  };
  const modules = createClientModuleSystem({
    seeds: options.seeds ?? skeletonSeedsV3(),
    rowOf: (id) => rowsById.get(id),
    rowsOf,
    ...(options.loadScript !== undefined ? { loadScript: options.loadScript } : {}),
  });

  // ① client runtime + ①.5 rpc host（先于一切域件——传输基座）
  const ctx = await createClient();
  const rejectWire: RpcWire = {
    call: () => Promise.reject(new Error('rpc wire 未接线（BootV3Options.rpcWire）')),
    onEvent: () => () => { /* 无事件源 */ },
    onOpen: () => () => { /* 无连接 */ },
    onAck: () => () => { /* 无 ack */ },
    onClose: () => () => { /* 无连接 */ },
    connected: () => false,
  };
  await ctx.plugin(makeRpcHostPlugin(options.rpcWire ?? rejectWire));

  // ② 骨架 3 件 in-bundle（await 序装载——形态壳占 root 出厂层）
  for (const plugin of skeletonPlugins) await ctx.plugin(plugin as ClientPluginObject);

  // ③ 出厂封印（D3）：此后 root 席位动态注册恒入低优层
  ctx.slots.sealFactory();

  // ④ wire 装载：模块表逐行物化（拓扑序 = wire 行序）→ ctx.plugin → 席位渲染。
  // 附加样式（styles 声明）走 link 注入（revision URL——重载不重复挂）。
  const channel = new Map<string, 'ok' | 'err'>();
  const loadable = wire.rows.filter((row) => !row.isolated && row.entry !== undefined);
  // 两段装载（cr-930）：先全到达（仅注册 factory——跨行 require 在物化期
  // 同步解析，届时全部 factory 已注册）；再按 wire 行序逐行物化
  for (const row of loadable) {
    for (const st of row.styles ?? []) loadChannelCss(hostUrl(st)); // 附加样式（revision URL——重载不重复挂）
    try {
      await modules.ensure(row.id);
    } catch (error) {
      console.error(`[boot-v3] 行 bundle 到达失败（跳过）"${row.id}"：`, error);
      channel.set(row.id, 'err');
    }
  }
  for (const row of loadable) {
    if (channel.get(row.id) === 'err') continue;
    try {
      const mod = await modules.import(row.id) as { default?: unknown };
      const plugin = (mod as Record<string, unknown>)['default'] ?? mod;
      await ctx.plugin(plugin as ClientPluginObject);
      channel.set(row.id, 'ok');
    } catch (error) {
      console.error(`[boot-v3] 行装载失败（跳过）"${row.id}"：`, error);
      channel.set(row.id, 'err');
    }
  }
  const reload = async (): Promise<void> => {
    const next = await fetchWire();
    const prevById = new Map(wire.rows.map((r) => [r.id, r]));
    const changed = next.rows.filter((row) => {
      if (row.isolated || row.entry === undefined) return false;
      const prev = prevById.get(row.id);
      return prev === undefined || prev.entry !== row.entry;
    });
    if (changed.length === 0) { Object.assign(wire, next); return; }
    for (const row of changed) modules.invalidate(row.id);
    rowsById.clear();
    for (const row of next.rows) rowsById.set(row.id, row);
    for (const row of changed) {
      try {
        await modules.ensure(row.id);
        const mod = await modules.import(row.id) as { default?: unknown };
        const plugin = (mod as Record<string, unknown>)['default'] ?? mod;
        await ctx.plugin(plugin as ClientPluginObject);
        channel.set(row.id, 'ok');
      } catch (error) {
        console.error(`[boot-v3] 行重载失败（跳过）"${row.id}"：`, error);
        channel.set(row.id, 'err');
      }
    }
    Object.assign(wire, next);
  };

  return { ctx, channel, modules, wire, reload };
}
