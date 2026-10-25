// ============================================================
// boot.ts —— ui 树 boot 装配序列（8.5b；可测半边，不碰 mount/DOM）
//
// ui 树 = 第三棵装配树（ui-tree.md §1）：boot 编排 = 本文件。与宿主树
//（ac-app）/壳树（shell boot）同构——固定本体 + N 个模块投影。
//
// 装配序列（骨架归并终态——phase:'base' 退役，ui-tree.md §2/§4）：
//   ① createClient（client runtime——浏览器侧 cordis + slots/objects）
//   ② 骨架 3 件 in-bundle 装载（协议持有者直接 import 主线行包：
//      theme 词汇契约 / renderer 席位渲染协议 / layout 拓扑契约+形态壳——
//      依赖序 theme → renderer → layout；形态壳 = 变体层可替换的实现策略）
//   ③ sealFactory（D3 出厂封印——root 席位出厂层定界，此后动态恒低优）
//   ④ 通道装载：拉 boot graph（manifest 单源）→ 逐条动态装载
//      （第一方模块资产与第三方同通道，零特权路径——cr-474）。
//      外部化条目（isolated:false + channelImports 声明）：裸包名经
//      全局注册表（__ac_channel_modules__）解析到宿主模块实例——
//      bundle 边界不破单例契约（pinia/Context/席位注册表）
//   ⑤ mount（main.ts 专责——renderSlot('root')）
//
// 通道条目执行形态：isolated 条目 = iframe 隔离档（sandbox 容器 + 父窗口
// 白名单代理——src/isolated.ts）；非隔离条目 = default export 插件对象 →
// ctx.plugin（主线 boot graph domain 行同款形态）。装载失败逐条隔离
//（console.error 继续——单模块缺席不毁表面，插槽-插头验收）。
// ============================================================
import type { ClientContext, ClientPluginObject } from 'ac-client-runtime';
import { createClient } from 'ac-client-runtime';
import { themeClientPlugin } from 'ac-client-ui-theme/client';
import { rendererClientPlugin } from 'ac-client-ui-renderer/client';
import { layoutClientPlugin } from 'ac-client-ui-layout/client';
import type { BootGraphEntry } from 'ac-webui-core';
import { auditThemeTokens } from 'ac-webui-core';
import { registerThemeId } from 'ac-client-ui-theme/client';
import { makeRpcHostPlugin, type RpcWire } from './rpc-host.ts';
import { loadIsolatedExtension, type IsolatedExtensionHandle } from '../src/isolated.ts';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as cordis from '@agentchat/cordis';
import * as clientRuntime from 'ac-client-runtime';
import * as clientSlots from 'ac-client-slots';
// 骨架包本体 + webui-kit（toast 全局栈等模块级单例——多 bundle 各持副本即各弹各的）
import * as clientUiTheme from 'ac-client-ui-theme/client';
import * as clientUiRenderer from 'ac-client-ui-renderer/client';
import * as clientUiLayout from 'ac-client-ui-layout/client';
import * as webuiKit from '@agentchat/webui-kit';
import { sharedModules } from './shared-modules.ts';

/** 通道装载器（URL → 模块；浏览器 = 动态 import，测试注入） */
export type ChannelLoader = (entry: BootGraphEntry) => Promise<{ default?: unknown }>;

/** boot graph 拉取（缺省 fetch 同源端点；测试注入） */
export type GraphFetcher = () => Promise<BootGraphEntry[]>;

/**
 * 共享基座模块注册表（外部化通道条目的裸包名解析面）。
 * key = 裸包名或子路径说明符（'vue' / 'ac-client-ui-theme/client' /
 * 'ac-client-ui-conversation/client/chatStore.ts'——importmap 原生支持
 * 子路径映射，8.5c 深路径扩展），value = 宿主已装载的同一模块实例。
 * 外部化 bundle 构建时 rollup external 把这些说明符留空，运行时经全局
 * 注册表取宿主实例——单例契约（pinia store / Context / 席位注册表 /
 * toast 全局栈）不因 bundle 边界破。骨架件 in-bundle 已持有这些模块的
 * 引用，moduleHost 由 main.ts / 测试从骨架面收集注入。
 */
export type ModuleHost = Record<string, unknown>;

/** 全局注册表键（外部化 bundle 的加载器生成代码经此寻址） */
export const CHANNEL_MODULE_HOST_KEY = '__ac_channel_modules__';

/**
 * 骨架面共享基座收集（in-bundle import 的模块本体直供——moduleHost
 * 缺省源：骨架件与基座单例天然同源，零额外装载）。骨架包本体与
 * webui-kit 同入（8.5c：域行深引骨架 store / webui-kit toast 栈）。
 */
export function skeletonModuleHost(): ModuleHost {
  return {
    vue,
    pinia,
    '@agentchat/cordis': cordis,
    'ac-client-runtime': clientRuntime,
    'ac-client-slots': clientSlots,
    '@agentchat/webui-kit': webuiKit,
    'ac-client-ui-theme/client': clientUiTheme,
    'ac-client-ui-renderer/client': clientUiRenderer,
    'ac-client-ui-layout/client': clientUiLayout,
    ...sharedModules(),
  };
}

/**
 * 安装通道 importmap：moduleHost 每键合成 re-export 模块（blob URL——
 * 命名导出面按 Object.keys 动态生成），后注入 importmap（Chrome 89+ 支持
 * 多 importmap；通道条目 import 时序在本函数之后——bootUiClient ④ 步）。
 * 已含同名说明符的既有映射不动（首装幂等）。非浏览器环境（测试）无
 * document 时静默跳过——测试走 loadChannel 注入，不经 importmap。
 */
export function installChannelImportmap(host: ModuleHost): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector('script[type="importmap"]');
  const current = existing?.textContent ? JSON.parse(existing.textContent) : { imports: {} };
  const imports: Record<string, string> = { ...(current.imports ?? {}) };
  let changed = false;
  for (const [name, mod] of Object.entries(host)) {
    if (imports[name]) continue;
    const keys = Object.keys(mod as object);
    // 保留字/非法标识符键（default/import/class 等）不可作 const 名——命名
    // 导出面按合法标识符生成，default 恒走 export default m（模块本身即
    // 默认导出）。.vue 模块 namespace 常仅含 default 键（vite 虚拟模块
    // 语义）——此修复的实测触发场景（8.5e 浏览器真跑抓到）。
    const RESERVED = new Set(['default', 'import', 'export', 'class', 'function', 'const', 'let', 'var', 'await', 'yield', 'delete', 'typeof', 'new', 'return', 'switch', 'case', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'in', 'of', 'instanceof', 'void', 'this', 'super', 'extends', 'static', 'get', 'set', 'null', 'true', 'false', 'with', 'debugger']);
    const isLegal = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && !RESERVED.has(k);
    const code = 'const m = globalThis["' + CHANNEL_MODULE_HOST_KEY + '"][' + JSON.stringify(name) + '];\n'
      + keys.filter(isLegal).map((k) => 'export const ' + k + ' = m[' + JSON.stringify(k) + '];').join('\n')
      + (keys.includes('default') ? '\nconst d = m["default"];\nexport { d as default };' : '\nexport default m;');
    imports[name] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    changed = true;
  }
  if (!changed) return;
  const script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify({ imports });
  if (existing) existing.remove(); // 单 importmap 约定：替换为合并版（多 importmap 后注入语义同 Chrome 89+）
  document.head.appendChild(script);
}

export interface BootUiOptions {
  /** 通道装载器（缺省 = 动态 import graph 条目 entry URL） */
  loadChannel?: ChannelLoader;
  /** graph 拉取（缺省 = fetch /api/ui/boot-graph） */
  fetchGraph?: GraphFetcher;
  /**
   * 共享基座模块注册表（缺省 = skeletonModuleHost()）。外部化通道条目
   * 经全局注册表解析裸包名——同构单例（vue/pinia/cordis/runtime/slots）。
   */
  moduleHost?: ModuleHost;
  /**
   * rpc wire（域件公共依赖 ctx.rpc 的传输实现）。缺省 = 拒绝桩（调用
   * 即报错——fail-loud 不静默）；测试/产品（main.ts→/ws，8.5e）注入真面。
   */
  rpcWire?: RpcWire;
}

export interface BootUiResult {
  ctx: ClientContext;
  /** 通道装载结果（name → ok/err——逐条隔离语义） */
  channel: Map<string, 'ok' | 'err'>;
  /** isolated 条目句柄（iframe 容器——cleanup 逐个收割；宿主进程级可不收） */
  isolated: IsolatedExtensionHandle[];
  /**
   * seats 对账报告（cr-690 B1）：manifest.seats 声明 ↔ SlotCore 注册面
   * 双向 diff（声明未注册 / 注册未声明——均 warning 不拒载，§1 裁决）。
   * 存量第一方通道零 seats 声明 → 生成器补产（本批）。
   */
  seatAudit: Map<string, SeatAuditReport>;
  /**
   * 主题包词汇审计（B2 cr-693）：theme 条目 → { 审计结果 }。
   * 缺项回落缺省（warning 不拒载——ui-tree §2 完备性规则）。
   */
  themeAudit: Map<string, { id: string; audit: ReturnType<typeof auditThemeTokens> }>;
}

/**
 * seats 对账（cr-690 B1，design-plugin-client-channel.md §1 裁决）：
 * 声明 → 实际注册双向 diff，warning 不拒载（「注册未声明」保护第一方
 * 零 seats 声明的存量语义；「声明未注册」= 写了不注册的漂移诊断面）。
 */
export interface SeatAuditReport {
  /** 声明了该 key 但装载后 SlotCore 无本模块贡献 */
  declaredNotRegistered: string[];
  /** 装载后 SlotCore 有贡献但 manifest 未声明的 key */
  registeredNotDeclared: string[];
}

/**
 * 单条目对账：装载前（key → 贡献 id 集）与装载后贡献面 diff——新增
 * 贡献 key 归因本条目；声明集与归因集双向比对。'new:' 声明是席位声明
 * 而非贡献，不参与 declaredNotRegistered（其贡献 = B3 批 registerView）。
 */
function auditSeats(
  ctx: ClientContext,
  entry: BootGraphEntry,
  before: Map<string, Set<string>>,
): SeatAuditReport {
  const report: SeatAuditReport = { declaredNotRegistered: [], registeredNotDeclared: [] };
  const after = seatContributions(ctx);
  const contributed: string[] = [];
  for (const [key, ids] of after) {
    const prev = before.get(key) ?? new Set<string>();
    if ([...ids].some((id) => !prev.has(id))) contributed.push(key);
  }
  for (const s of entry.seats) {
    if (!s.seat.startsWith('new:') && !contributed.includes(s.seat)) {
      report.declaredNotRegistered.push(s.seat);
    }
  }
  for (const key of contributed) {
    if (!entry.seats.some((s) => s.seat === key || s.seat === 'new:' + key)) {
      report.registeredNotDeclared.push(key);
    }
  }
  return report;
}

/** 席位贡献面快照（SlotCore 注册表 key → 贡献 id 集） */
function seatContributions(ctx: ClientContext): Map<string, Set<string>> {
  const snap = ctx.slots.snapshot();
  const out = new Map<string, Set<string>>();
  for (const [key, entries] of Object.entries(snap.slots)) {
    out.set(key, new Set(entries.map((e) => e.id)));
  }
  return out;
}

/** 已注入的通道样式表（href 去重——graph 重载不重复挂） */
const channelCssLoaded = new Set<string>();

/**
 * 通道产物样式注入（cr-584）：vite lib 构建把 SFC scoped 样式emit 到
 * entry 同目录 style.css——此前装载器只 import index.js，全部通道组件
 * 样式从未进浏览器（cr-577/581 补的是全局层，scoped 层一直缺席）。
 * link 加载失败不炸通道（缺席/404 = 无样式通道合法降级，console 报警）。
 */
export function loadChannelCss(href: string): void {
  if (channelCssLoaded.has(href) || typeof document === 'undefined') return;
  channelCssLoaded.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onerror = () => console.warn('[ui-boot] 通道样式缺席：' + href);
  document.head.appendChild(link);
}

/** 已注入的主题包样式元素（data-ui-theme 去重——graph 重载不重复挂） */
const themeStylesLoaded = new Set<string>();

/**
 * 主题包装载（B2 cr-693，design-plugin-client-channel.md §2.2 第一行）：
 * 纯数据模块——无 entry JS，styles[0] = token CSS。fetch 文本 → 词汇
 * 完备性审计（缺项回落缺省，warning 不拒载）→ <style data-ui-theme='<id>'>
 * 注入 → 登记 id（theme 骨架选择轴可选）。
 *
 * 级联正确性：主题包选择器恒写 html[data-theme='<id>']（暗极，特异性
 * 0,2,0 > html.dark 0,1,1）+ html.light[data-theme='<id>']（亮极 0,2,1）
 * ——缺词天然级联回落 tokens.css 内置缺省；明暗档切换不改 id 轴。
 */
async function loadThemeEntry(entry: BootGraphEntry): Promise<{ id: string; audit: ReturnType<typeof auditThemeTokens> }> {
  if (entry.styles.length === 0) throw new Error('theme 条目缺 styles（tokensOnly 主题包 = token CSS 纯数据，无 entry JS）');
  const rel = entry.base + entry.styles[0]!.replace(/^\/+/, '');
  // 相对 URL 规范化（jsdom fetch 无隐式 base——产品面同源等价）
  const cssHref = new URL(rel, typeof location !== 'undefined' ? location.href : 'http://localhost/').href;
  const res = await fetch(cssHref);
  if (!res.ok) throw new Error('主题包 CSS 拉取失败：' + cssHref + ' ' + res.status);
  const css = await res.text();
  // data-theme id = 插件名（词汇锚点 = manifest.name——选择器词形契约）
  const id = entry.name;
  const audit = auditThemeTokens(css, id);
  if (audit.missing.dark.length > 0 || audit.missing.light.length > 0) {
    console.warn(`[ui-boot] 主题包 "${entry.name}" 词汇不完备（缺项回落缺省）：dark 缺 ${audit.missing.dark.length}/${audit.coverage.total}，light 缺 ${audit.missing.light.length}/${audit.coverage.total}`);
  }
  if (audit.unknown.dark.length > 0 || audit.unknown.light.length > 0) {
    console.warn(`[ui-boot] 主题包 "${entry.name}" 含词汇表外令牌（第三方自用）：`, [...audit.unknown.dark, ...audit.unknown.light]);
  }
  if (!themeStylesLoaded.has(id)) {
    themeStylesLoaded.add(id);
    const style = document.createElement('style');
    style.setAttribute('data-ui-theme', id);
    style.textContent = css;
    document.head.appendChild(style);
  }
  registerThemeId(id);
  return { id, audit };
}

async function defaultLoader(entry: BootGraphEntry): Promise<{ default?: unknown }> {
  const url = entry.base + entry.entry.replace(/^\/+/, '');
  // 通道样式（manifest styles 声明——构建器在有产物 style.css 时注入）
  for (const st of entry.styles) loadChannelCss(entry.base + st.replace(/^\/+/, ''));
  return import(/* @vite-ignore */ url) as Promise<{ default?: unknown }>;
}

async function defaultGraph(): Promise<BootGraphEntry[]> {
  const res = await fetch('/api/ui/boot-graph');
  if (!res.ok) return [];
  const data = await res.json() as { clients?: BootGraphEntry[] };
  return data.clients ?? [];
}

/** 骨架 3 件（in-bundle——协议持有者；依赖序：theme → renderer → layout） */
export const skeletonPlugins: ClientPluginObject[] = [
  themeClientPlugin as unknown as ClientPluginObject,
  rendererClientPlugin as unknown as ClientPluginObject,
  layoutClientPlugin as unknown as ClientPluginObject,
];

/**
 * 装配序列主体（①-④；mount 归 main.ts）。可测：options 注入 loader 与
 * fetcher 后在 jsdom 内全链跑（见 tests/boot.test.ts）。
 */
export async function bootUiClient(options: BootUiOptions = {}): Promise<BootUiResult> {
  const loadChannel = options.loadChannel ?? defaultLoader;
  const fetchGraph = options.fetchGraph ?? defaultGraph;
  const moduleHost = options.moduleHost ?? skeletonModuleHost();

  // 外部化通道条目的裸包名解析面：挂全局注册表（首条外部化条目装载前
  // 就位即可——这里统一在骨架装配后挂，时序恒先于通道装载）
  const globals = globalThis as Record<string, unknown>;
  globals[CHANNEL_MODULE_HOST_KEY] = moduleHost;
  installChannelImportmap(moduleHost);

  // ① client runtime
  const ctx = await createClient();

  // ①.5 rpc host（传输基座——域件公共依赖 inject rpc 的提供面；先于一切域件）
  const rejectWire: RpcWire = {
    call: () => Promise.reject(new Error('rpc wire 未接线（BootUiOptions.rpcWire——main.ts 真面归 8.5e）')),
    onEvent: () => () => { /* 无事件源 */ },
    onOpen: () => () => { /* 无连接 */ },
    onAck: () => () => { /* 无 ack */ },
    onClose: () => () => { /* 无连接 */ },
    connected: () => false,
  };
  await ctx.plugin(makeRpcHostPlugin(options.rpcWire ?? rejectWire));

  // ② 骨架 3 件 in-bundle（await 序装载——形态壳占 root 出厂层）
  for (const plugin of skeletonPlugins) await ctx.plugin(plugin);

  // ③ 出厂封印（D3）：此后 root 席位动态注册恒入低优层
  ctx.slots.sealFactory();

  // ④ 通道装载（manifest 单源 graph；逐条隔离）
  const graph = await fetchGraph();
  const channel = new Map<string, 'ok' | 'err'>();
  const isolatedHandles: IsolatedExtensionHandle[] = [];
  const seatAudit = new Map<string, SeatAuditReport>();
  const themeAudit = new Map<string, { id: string; audit: ReturnType<typeof auditThemeTokens> }>();
  for (const entry of graph) {
    // 主题包分支（B2）：纯数据条目——不走 JS 装载链（无 default export 可期）
    if (entry.theme) {
      try {
        themeAudit.set(entry.name, await loadThemeEntry(entry));
        channel.set(entry.name, 'ok');
      } catch (err) {
        console.error(`[ui-boot] 主题包 "${entry.name}" 装载失败：`, err);
        channel.set(entry.name, 'err');
      }
      continue;
    }
    // platform 过滤在 manifest 校验面（checkUiManifest 拦非 web）——装载面零重复闸
    if (entry.isolated) {
      // 隔离档：iframe sandbox 容器（不信任插件——不进宿主 ctx，request/onEvent
      // 经父窗口白名单代理；运行时 = ac-client-runtime isolated-runtime，宿主半边
      // src/isolated.ts）。装载结果同记 channel 表（ready/error 由 iframe 侧上报，
      // 此处记 ok = iframe 已创建——语义与主线 extensions 宿主一致）。
      try {
        isolatedHandles.push(loadIsolatedExtension(ctx, { name: entry.name, version: entry.version, entry: entry.base + entry.entry.replace(/^\/+/, '') }));
        channel.set(entry.name, 'ok');
      } catch (err) {
        console.error(`[ui-boot] isolated 条目 "${entry.name}" 装载失败：`, err);
        channel.set(entry.name, 'err');
      }
      continue;
    }
    try {
      // 外部化条目：channelImports 声明的裸包名必须在 moduleHost 有键——
      // 缺键即本条失败（逐条隔离），不殃及后续条目
      for (const dep of entry.channelImports) {
        if (!(dep in moduleHost)) throw new Error('moduleHost 缺共享基座键：' + dep);
      }
      const before = seatContributions(ctx);
      const mod = await loadChannel(entry);
      const plugin = mod.default as { apply?: unknown } | undefined;
      if (!plugin || typeof plugin.apply !== 'function') throw new Error('通道条目缺 default export 插件');
      await ctx.plugin(plugin as unknown as ClientPluginObject);
      // seats 对账（装载成功后；warning 不拒载——§1 裁决）
      const report = auditSeats(ctx, entry, before);
      if (report.declaredNotRegistered.length > 0 || report.registeredNotDeclared.length > 0) {
        console.warn(`[ui-boot] seats 对账漂移（${entry.name}）：`, report);
      }
      seatAudit.set(entry.name, report);
      channel.set(entry.name, 'ok');
    } catch (err) {
      console.error(`[ui-boot] 通道条目 "${entry.name}" 装载失败：`, err);
      channel.set(entry.name, 'err');
    }
  }

  return { ctx, channel, isolated: isolatedHandles, seatAudit, themeAudit };
}
