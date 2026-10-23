// ============================================================
// boot.ts —— 宿主 boot 入口（8.8 前置第一批 cr-537；cr-542 单树装配）
//
// 宿主行集派生全域单一（A9）：偏好文件 <dataRoot>/host-rows.json
//（{id, disabled} 只记差异）× 目录全集 → 装配清单。已就位行经
// ac-host-rows IMPORTED_ROWS / HOST_ROW_FACTORIES 装配；未就位行（后续批）
// warnings fail-loud——8.8 收口前宿主 app 恒全批装配面。
//
// **单树装配**（cr-542 根因修复）：web 环不再是独立 ctx。宿主行集里
// ws-bridge / remote-link / webui / web-api / agent-admin 的 cordis inject
// 恒含 webServer——双 ctx 形态下它们在宿主 ctx 内永 PENDING（cordis 语义：
// PENDING fiber 的 await 立即返回不报错 = 静默半激活面，探针实证于 cr-542），
// 即「行已装配」是假的。单树形态 + 装配终检（壳 boot 同款 ACTIVE 断言）
// 让行集完整性可验证；装配失败逆序收割（不留半态端口/监听）。
//
// 装配序：
//   邮局先行（PostOffice——usage 行等宿主自有形态行的事件信收信面）
//   → web-server（传输基座；其余行的 inject 面靠它满足）
//   → 导入行 + 宿主自有形态行（usage / timers / agents 编辑面 / plugin-registry）
//   → web 表面（user 桩 + webui + web-api）→ agent-admin（写侧 RPC 编排）
//   → 装配终检（fiber 排空 + FiberStates.ACTIVE）
//
// 46 行口径（cr-544：session-query 改树入壳，47→46）：21 cordis 行 + 25 ui 域行（manifest 通道产物——boot graph
// 声明面，非 cordis 装配；8.5c 收口）。ui 域行经 webui 行的 pluginsDir
// 扫描装载。
// ============================================================
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Context, FiberStates, type Fiber } from '@agentchat/cordis';
import { IMPORTED_ROWS, HOST_ROW_FACTORIES, rowOptionsFor, TEMPLATE_DIR, makeAgentAdminRow, makeAgentsHostRow, HostInbox, type EntriesEditFace } from 'ac-host-rows';
import { readCatalog, deriveHostRowset, type HostRowPreference, type RowsetCatalog } from 'ac-rowset-core';
import { PostOffice } from 'ac-post-office';
import { assembleWebServer, attachWebSurface, type WebRing } from 'ac-host-webui';
import { createOrchestrator, type OrchestratorHandle } from './orchestrator.ts';
import { createAdminPreview } from './admin-preview.ts';

/** 本文件目录（编排面 bootFile 寻址基点） */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface HostBootOptions {
  dataRoot: string;
  catalogFile: string;
  /** 覆盖偏好文件（测试注入） */
  preferences?: HostRowPreference[];
  /** web 面端口（缺省 0 随机） */
  port?: number;
  /** UI 插件目录（缺省 <dataRoot>/plugins） */
  pluginsDir?: string;
  /** 静态目录（SPA fallback——dist 未建时省略） */
  staticDir?: string;
  /**
   * 编排面（cr-551）：壳句柄池 + 按需拉起 + re-tap。缺省开（boot 完成
   * 即监护就绪，来件自动拉壳）；false = 纯宿主服务面（测试/诊断形态）。
   */
  orchestrate?: boolean;
  /** 编排面 mock provider 档（dev/无凭据环境——壳 argv 注入；缺省 false 生产档） */
  mockProvider?: boolean;
}

export interface HostBootResult {
  ctx: Context;
  /** 装配行 id 清单（cordis 面） */
  rowIds: string[];
  /** web 表面（user 桩 + webui + web-api 的对外观测面） */
  web: Pick<WebRing, 'user' | 'port' | 'tapAgent' | 'untapAgent'>;
  /** 邮局（投递执行体） */
  po: PostOffice;
  /** 编排面（壳句柄池——按需拉起/监护/re-tap；orchestrate:false 时缺席） */
  supervisors: OrchestratorHandle | null;
  /** 装配终检通过后的 fiber 清单（诊断/测试用） */
  fibers: Fiber[];
  close(): Promise<void>;
}

/**
 * 宿主 boot：偏好派生 → 单树 cordis 装配 → web 表面 → 装配终检。
 * 未就位行 fail-loud（warnings 断言）——装配面完整性是 8.8 恒等门前置。
 */
export async function bootHost(options: HostBootOptions): Promise<HostBootResult> {
  const dataRoot = path.resolve(options.dataRoot);
  fs.mkdirSync(dataRoot, { recursive: true });

  // ---- 行集派生（A9：偏好文件 × 目录全集）----
  const catalog: RowsetCatalog = readCatalog(options.catalogFile);
  const prefPath = path.join(dataRoot, 'host-rows.json');
  let preferences: HostRowPreference[] = options.preferences ?? [];
  if (options.preferences === undefined && fs.existsSync(prefPath)) {
    preferences = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as HostRowPreference[];
  }
  const derived = deriveHostRowset(preferences, catalog);
  if (derived.warnings.length > 0) {
    throw new Error('host rowset warnings: ' + derived.warnings.join('; '));
  }

  // ---- 装配面就位性（已实现行覆盖派生集）----
  // ui 域行（25）= manifest 声明面（webui 行 boot graph 通道产物装载，8.5c）——
  // 非 cordis 插件装配，不参与就位性检查；其装载面在 webui 行（pluginsDir 扫描）。
  const missing = derived.rowIds.filter((id) => !id.startsWith('ui-') && !(id in IMPORTED_ROWS) && !(id in HOST_ROW_FACTORIES) && !HOST_OWN_ROWS.has(id) && !WEB_RING_ROWS.has(id));
  if (missing.length > 0) {
    throw new Error('host rows not yet available: ' + missing.join(', '));
  }

  // ---- 邮局先行（usage 等宿主自有形态行的事件信收信面依赖它；web 表面共用）----
  const po = new PostOffice({ dataRoot });
  await po.listen();
  // host 端点收信扇出面（cr-545：usage / auth-registry 行共用——邮局 local 通道单 receiver 组合器）
  const inbox = new HostInbox(po);
  inbox.start();

  // ---- 单树 cordis 装配 ----
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const mounted = new Set<string>(derived.rowIds);
  // 壳内服务面端口持有器（web 面先装配、orchestrator 后创建——惰性回填，cr-569）
  const shellPort: { port: OrchestratorHandle | null } = { port: null };
  const ringOptions = {
    dataRoot,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.pluginsDir !== undefined ? { pluginsDir: options.pluginsDir } : {}),
    ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
    catalogFile: options.catalogFile,
    shellPort: () => shellPort.port,
    postOffice: po,
  };
  let web: WebRing;
  try {
    // ① 传输基座先行（无 webServer 时 inject 它的行永 PENDING——cr-542）
    if (mounted.has('web-server')) fibers.push(await assembleWebServer(ctx, ringOptions));

    // ② 导入行 + 宿主自有形态行
    // agents 编辑面先行装配并等激活（timers 行 entries 单写者注入需其实例
    // ——cr-551；实例引用经 capture 面传递，await 保证构造已跑）
    let agentsEdit: EntriesEditFace | undefined;
    if (mounted.has('agents')) {
      const f = ctx.plugin(makeAgentsHostRow(
        {
          dataRoot,
          ...(mounted.has('preset-builtin') ? { templatesDir: TEMPLATE_DIR } : {}),
        },
        (svc) => { agentsEdit = svc; },
      ));
      await f; // 激活即 capture 已跑（构造器内回调）
      fibers.push(f);
    }
    // 模板目录只在 preset-builtin 行在集时注入（行缺席 = 模板面不可用，
    // agents 编辑面良定义降级——cr-540）
    const optionsMap = rowOptionsFor({
      dataRoot,
      postOffice: po,
      inbox,
      catalogFile: options.catalogFile,
      agentsEdit,
      ...(mounted.has('preset-builtin') ? { templatesDir: TEMPLATE_DIR } : {}),
    });
    for (const id of derived.rowIds) {
      // web 面行（web-server/webui/web-api/agent-admin）由 boot 分区装配；
      // ui 域行经 webui 行 boot graph；HOST_OWN_ROWS（guardian = per 壳
      // ShellWarden 编排件 / preset-builtin = 静态数据面）非 cordis 行装配；
      // agents 已先行装配（cr-551 capture 面）
      if (WEB_RING_ROWS.has(id) || id.startsWith('ui-') || HOST_OWN_ROWS.has(id) || id === 'agents') continue;
      const factory = HOST_ROW_FACTORIES[id];
      if (factory !== undefined) {
        fibers.push(ctx.plugin(factory(optionsMap[id] as never)));
        continue;
      }
      fibers.push(ctx.plugin(IMPORTED_ROWS[id], optionsMap[id]));
    }
    for (const fiber of fibers) await fiber;

    // ③ web 表面（user 桩 + webui + web-api）——同一 ctx：与宿主服务行同树
    web = await attachWebSurface(ctx, ringOptions);
    fibers.push(...web.fibers);

    // ---- 装配终检（cr-542；壳 boot 同款语义）：PENDING fiber 的 await 立即
    // 返回不报错——统一排空后断言 ACTIVE，行集矛盾（依赖行被显式排除/目录
    // 漂移/装配序缺口）fail-loud，不留静默半激活面。
    for (const fiber of fibers) await fiber;
    for (const fiber of fibers) {
      if (fiber.state !== FiberStates.ACTIVE) {
        throw new Error(
          '宿主行 <' + fiber.name + '> 装配后未激活（PENDING——依赖行不在行集：行集闭包缺口或被显式排除）',
        );
      }
    }
  } catch (err) {
    // fail-loud 不留半态：已装 fiber 逆序收割 + 邮局关闭（端口/监听不泄漏——
    // 装配失败后重试不应撞占用）
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
    await po.close();
    throw err;
  }

  // ---- 编排面（cr-551）：supervise 句柄池 + 按需拉起 + re-tap ----
  // boot 即接线邮局 ensure 钩子：不可达来信 → 落箱 → 拉壳 → adopted 转投。
  const orchestrate = options.orchestrate ?? true;
  const supervisors = orchestrate
    ? createOrchestrator({
        dataRoot,
        catalogFile: options.catalogFile,
        bootFile: path.resolve(HERE, '../shell/boot.ts'),
        postOffice: po,
        // D5 边 2 常态化（cr-612）：壳 argv 注入宿主入口/端口——邮局失联时壳侧复活
        hostBoot: path.resolve(HERE, 'boot.ts'),
        hostPort: web.port,
        tap: (agentId, hint) => web.tapAgent(agentId, hint),
        ...(options.mockProvider === true ? { mockProvider: true } : {}),
      })
    : null;
  if (supervisors !== null) {
    po.setEnsureHook(supervisors.ensureHook);
    shellPort.port = supervisors; // 壳内服务面端口就绪（惰性 getter 已注入 web 面）
  }

  // ④ agent-admin（写侧 RPC 编排——inject ['webServer','agents']：两服务同树才激活）。
  // 预览面注入（cr-552）：编排面在场时经控制帧往返壳内干跑（ensureAgent 按需
  // 拉起壳——预览请求即触发链）；orchestrate:false 时缺席 = system-prompt/
  // assembly 读面 fail-loud（六 CRUD 方法照常——良定义降级）。装配在编排面
  // 创建后（supervisors 引用就位），终检仍覆盖本行。
  if (mounted.has('agent-admin')) {
    const adminFiber = ctx.plugin(makeAgentAdminRow({
      adminPreview: supervisors !== null ? createAdminPreview({ orch: supervisors }) : undefined,
    }));
    fibers.push(adminFiber);
    await adminFiber;
    if (adminFiber.state !== FiberStates.ACTIVE) {
      throw new Error('宿主行 <agent-admin> 装配后未激活（PENDING——webServer/agents 依赖不在树）');
    }
  }

  return {
    ctx,
    rowIds: derived.rowIds,
    web: { user: web.user, port: web.port, tapAgent: web.tapAgent, untapAgent: web.untapAgent },
    po,
    supervisors,
    fibers,
    async close() {
      supervisors?.close();
      web.closeTaps();
      for (const fiber of [...fibers].reverse()) {
        if (fiber.uid !== null) await fiber.dispose();
      }
      await po.close(); // 邮局归 boot 统一收（注入不双收）
    },
  };
}

/** web 面行（boot 承担装配——web-server 先行 + webui/web-api 随 web 表面 + 邮局编排件
 * + agent-admin 写侧 RPC 编排（依赖 webServer 与 agents 两服务）） */
const WEB_RING_ROWS = new Set(['web-server', 'webui', 'web-api', 'post-office', 'agent-admin']);
/** 宿主自有形态行（非 cordis 装配）：guardian = per 壳 ShellWarden 编排件；
 * preset-builtin = 静态数据行（模板配置集由 agents 编辑面直读——裁决簿〈注册表解体〉）。 */
const HOST_OWN_ROWS = new Set(['guardian', 'preset-builtin']);

// ---- CLI 直跑 ----
if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const argOf = (name: string): string | undefined => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataRoot = argOf('data-root');
  if (dataRoot === undefined) {
    console.error('用法：node --experimental-strip-types boot.ts --data-root <dir> [--catalog <file>] [--port <n>]');
    process.exit(2);
  }
  // cr-557：换轨后本入口即新宿主——旧布局数据根必须 fail-loud 拒启。
  // cr-556 事故现场：用户停旧宿主后顺手 `pnpm dev`，新宿主静默绑上未迁移的
  // workspace/home（旧 credentials.json 单文件布局），一边往旧根写状态、一边
  // 让封存 rename 撞 EBUSY。判据：旧布局标志 credentials.json 在、新布局
  // credentials/ 缺（新架构恒不写 credentials.json，迁移后自然两者不共存）。
  if (fs.existsSync(path.join(dataRoot, 'credentials.json')) && !fs.existsSync(path.join(dataRoot, 'credentials'))) {
    console.error('[host] 数据根仍是旧架构布局（有 credentials.json、无 credentials/）：' + path.resolve(dataRoot));
    console.error('[host] 8.9 切换未完成——旧宿主请用 pnpm dev:legacy；迁移完成后再走新入口。');
    process.exit(78); // 启动期失败：supervisor 协议里 78 = 不重拉
  }

  // D5 边 2（cr-612）：boot 清停机戳（重新武装壳侧复活职责——上一代优雅
  // 退出写的戳只辖那一次停机）；优雅退出（SIGINT/SIGTERM——用户有意停机 /
  // supervisor 换代）写戳让壳侧 stand down，硬崩溃无戳 → 活壳复活本宿主。
  const stampPath = path.join(path.resolve(dataRoot), '.runtime', 'host-stopped');
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.rmSync(stampPath, { force: true });
  const writeStopStamp = () => {
    try { fs.writeFileSync(stampPath, new Date().toISOString(), 'utf-8'); } catch { /* 尽力面 */ }
    process.exit(0);
  };
  process.on('SIGINT', writeStopStamp);
  process.on('SIGTERM', writeStopStamp);

  // 静态面（cr-558）：缺省托管本仓 UI 构建产物——旧宿主在 3830 是带 SPA 的，
  // 新宿主不接静态面就等于「切换后浏览器打不开」。--static-dir 可覆盖。
  const staticDir = path.resolve(argOf('static-dir') ?? path.join(HERE, '../ui/dist'));
  const hasStatic = fs.existsSync(path.join(staticDir, 'index.html'));
  if (!hasStatic) {
    console.warn('[host] 静态面缺席（' + staticDir + '\index.html 不存在）——只有 WS/RPC，浏览器打开是 404');
    console.warn('[host] 先 pnpm --filter ac-ui-app build 生成 dist');
  }
  void bootHost({
    dataRoot,
    catalogFile: argOf('catalog') ?? path.resolve(HERE, '../catalog/row-catalog.json'),
    port: argOf('port') !== undefined ? Number(argOf('port')) : undefined,
    // 诊断档（config-write-smoke 同族）：--mock-provider 在场即壳 argv 注入 mock
    ...(args.includes('--mock-provider') ? { mockProvider: true } : {}),
    ...(hasStatic ? { staticDir } : {}),
  }).then((host) => {
    console.log('[host] boot 完成：' + host.rowIds.length + ' 行装配（cordis 面），web 端口 ' + host.web.port);
  }).catch((err: unknown) => {
    // 数据根单写者（IPC 命名管道）或端口被占 = 这个根上已经有宿主在跑。
    // 裸栈会让人以为「切换坏了」——给可读结论 + 该往哪走（cr-560 现场）。
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'EADDRINUSE') {
      console.error('[host] 这个数据根已经有宿主在跑（IPC 管道或端口被占）：' + path.resolve(dataRoot));
      console.error('[host] 一个数据根只允许一个宿主——先停掉旧实例（3830 端口 / supervisor 那个控制台），或换 --data-root 指向别处。');
      console.error('[host] 监护入口是 pnpm dev:supervised；pnpm dev 是前台直跑（无崩溃重拉），两者只能开一个。');
      process.exit(78); // 启动期失败：supervisor 协议里 78 = 不重拉
    }
    console.error('[host] boot 失败：', err);
    process.exit(1);
  });
}
