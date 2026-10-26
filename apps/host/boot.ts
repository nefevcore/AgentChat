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
// 23 行口径（cr-701 B4：ui 组终态清空，46→21→23 增量后撤 25 ui 域行）：全 cordis
// 装配行。ui 域行已撤——通道产物装载面恒在 webui 行 boot graph（pluginsDir
// 扫描），与行集声明面解耦。
// ============================================================
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Context, FiberStates, type Fiber } from '@agentchat/cordis';
import { IMPORTED_ROWS, HOST_ROW_FACTORIES, rowOptionsFor, makeAgentAdminRow, makeAgentsHostRow, HostInbox, type EntriesEditFace } from 'ac-host-rows';
import { readCatalog, deriveHostRowset, type HostRowPreference, type RowsetCatalog } from 'ac-rowset-core';
import { PostOffice } from 'ac-post-office';
import { readActivationLock } from 'ac-envelope-core';
import { assembleWebServer, attachWebSurface, type WebRing } from 'ac-host-webui';
import { createOrchestrator, type OrchestratorHandle } from './orchestrator.ts';
import { createAdminPreview } from './admin-preview.ts';
import { resolveAnchors, seedFactoryPlugins } from './anchors.ts';

/** 本文件目录（编排面 bootFile 寻址基点） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 运行时资产锚（cr-702：bundle〔AGENTCHAT_HOME〕/ 仓库双形态单源） */
const ANCHORS = resolveAnchors(HERE);

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
  /**
   * 宿主重启请求钩子（cr-629 restart_host）：壳经邮局发 payload.restartHost
   * 信时回调（CLI 形态接 graceful exit 42；缺省 = 无消费者——信封落账即弃）。
   */
  onRestartRequest?: (sender: string) => void;
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

  // ---- 出厂通道播种（bundle 形态：dist/plugins → <dataRoot>/plugins 幂等拷贝）----
  seedFactoryPlugins(dataRoot, ANCHORS);

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
  // cr-701 撤 25 ui 域行后派生集即 cordis 全集；通道产物装载面在 webui 行
  //（pluginsDir 扫描 boot graph），与行集派生解耦。
  const missing = derived.rowIds.filter((id) => !(id in IMPORTED_ROWS) && !(id in HOST_ROW_FACTORIES) && !HOST_OWN_ROWS.has(id) && !WEB_RING_ROWS.has(id));
  if (missing.length > 0) {
    throw new Error('host rows not yet available: ' + missing.join(', '));
  }

  // ---- 邮局先行（usage 等宿主自有形态行的事件信收信面依赖它；web 表面共用）----
  const po = new PostOffice({ dataRoot });
  await po.listen();
  // host 端点收信扇出面（cr-545：usage / auth-registry 行共用——邮局 local 通道单 receiver 组合器）
  const inbox = new HostInbox(po);
  // 编排面迟绑定引用（inbox 钩子先于编排面创建——cr-648 restart_shell 重拉用）
  const orchestratorRef: { handle: OrchestratorHandle | null } = { handle: null };
  /**
   * restart_shell 退出后的重拉请求（cr-648）：宿主换代后活壳只在可达表、不在
   * 句柄池（撞活锁救援只回登记不接管）→ 壳 exit 42 无人 respawn，在途消息滞留
   * inbox。壳在退出前发本请求：宿主轮询 activation.lock（最多 ~10s）等 holder
   * 退净后按需拉起；句柄池已有该 agent（warden 快路已接手）= 不动（幂等）。
   */
  const requestShellRespawn = (agentId: string): void => {
    let tries = 0;
    const tick = (): void => {
      const orch = orchestratorRef.handle;
      if (orch === null || orch.handles().has(agentId)) return; // 无编排面 / warden 已接管
      const lock = readActivationLock(path.join(dataRoot, 'agents', agentId));
      if (lock !== null) {
        let alive = false;
        try { process.kill(lock.pid, 0); alive = true; } catch { /* holder 已死 */ }
        if (alive) {
          if (++tries < 20) setTimeout(tick, 500).unref();
          return; // 超时放弃——交给下次来件按需拉起
        }
      }
      void orch.ensureAgent(agentId).catch((err: unknown) => {
        process.stderr.write('[host] restart_shell 重拉失败（' + agentId + '）：' + String(err) + '\n');
      });
    };
    setTimeout(tick, 1_500).unref();
  };
  // 安全重启收信面：restart_host（cr-629）/ restart_shell 退出重拉（cr-648）
  inbox.on(async (env) => {
    const payload = env.payload as { restartHost?: unknown; restartShell?: unknown; agentId?: unknown } | null;
    if (payload?.restartHost === true) {
      options.onRestartRequest?.(env.sender);
      return;
    }
    if (payload?.restartShell === true && typeof payload.agentId === 'string') {
      requestShellRespawn(payload.agentId);
    }
  });
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
          ...(mounted.has('preset-builtin') ? { templatesDir: ANCHORS.templatesDir } : {}),
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
      ...(mounted.has('preset-builtin') ? { templatesDir: ANCHORS.templatesDir } : {}),
    });
    for (const id of derived.rowIds) {
      // web 面行（web-server/webui/web-api/agent-admin）由 boot 分区装配；
      // HOST_OWN_ROWS（guardian = per 壳 ShellWarden 编排件 / preset-builtin =
      // 静态数据面）非 cordis 行装配；agents 已先行装配（cr-551 capture 面）
      if (WEB_RING_ROWS.has(id) || HOST_OWN_ROWS.has(id) || id === 'agents') continue;
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
        bootFile: ANCHORS.shellBoot,
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
    orchestratorRef.handle = supervisors; // cr-648：restart_shell 重拉钩子迟绑定
    // cr-651：restart_host 换代窗口内发出的 restart_shell 重拉请求会随旧宿主
    // 丢失（壳侧已落复活标记）——boot 扫标记兜底重拉（cr-663 单一仲裁/TTL，
    // 语义见 sweepRestartShellMarkers）。
    sweepRestartShellMarkers({
      dataRoot,
      ensureAgent: (agentId) => supervisors.ensureAgent(agentId).then(() => undefined),
    });
    // cr-659 换代活壳收复：restart_host 后活壳不在新宿主可达表/旁带流
    // 订阅——boot 扫 activation.lock 探活，可达登记 + re-tap（webui 断连
    // 重连后直播帧恢复，不依赖下一封信触发 ensureHook）。
    const rescued = supervisors.rescueLiveShells();
    if (rescued > 0) {
      process.stderr.write('[host] 换代活壳收复 ' + rescued + ' 个（可达登记 + 旁带流 re-tap）\n');
    }
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
  const dataRoot = argOf('data-root') ?? (process.env.AGENTCHAT_DATA_ROOT !== undefined && process.env.AGENTCHAT_DATA_ROOT !== '' ? process.env.AGENTCHAT_DATA_ROOT : undefined);
  if (dataRoot === undefined) {
    console.error('用法：node --experimental-strip-types boot.ts --data-root <dir> [--catalog <file>] [--port <n>]（或 AGENTCHAT_DATA_ROOT env）');
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
  const hostRef: Array<Awaited<ReturnType<typeof bootHost>> | undefined> = [];
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.rmSync(stampPath, { force: true });
  const writeStopStamp = () => {
    try { fs.writeFileSync(stampPath, new Date().toISOString(), 'utf-8'); } catch { /* 尽力面 */ }
    process.exit(0);
  };
  process.on('SIGINT', writeStopStamp);
  process.on('SIGTERM', writeStopStamp);

  // 静态面（cr-558）：缺省托管本仓 UI 构建产物——旧宿主在 3830 是带 SPA 的，
  // 新宿主不接静态面就等于「切换后浏览器打不开」。--static-dir 可覆盖
  //（覆盖序：--static-dir > AGENTCHAT_STATIC〔bundle 形态〕> 仓库相对缺省）。
  const staticDir = path.resolve(argOf('static-dir') ?? ANCHORS.staticDir);
  const hasStatic = fs.existsSync(path.join(staticDir, 'index.html'));
  if (!hasStatic) {
    console.warn('[host] 静态面缺席（' + staticDir + '\index.html 不存在）——只有 WS/RPC，浏览器打开是 404');
    console.warn('[host] 先 pnpm --filter ac-ui-app build 生成 dist');
  }
  // 安全重启宿主（cr-629 restart_host；cr-630 修正）：graceful 收面 →
  // exit 42，拉起恒归活壳（D5 边 2 裁决：任意宿主死亡 → 活壳是常态复活
  // 执行者；supervisor 仅兜「宿主+壳同死」）。恒不写停机戳——戳语义 = 用户
  // 有意停机/supervisor 换代（cr-612），借戳压壳 stand down 是单点故障
  //（supervisor 未拉起则宿主永死）。supervisor 在场时它是快路（42 = 固定
  // 小延迟重拉），活壳探测是兜底；两者竞态由既有防线收敛（O_EXCL 壳间
  // 仲裁 + cr-619 strict EADDRINUSE 后到者可读退出 78）。
  const restartHost = (host: Awaited<ReturnType<typeof bootHost>>, sender: string): void => {
    console.log('[host] 收到 restart_host 请求（sender=' + sender + '）——graceful 重启（exit 42，活壳/监护拉回）');
    setTimeout(() => process.exit(42), 8_000).unref(); // 收面兜底：close 链异常不吊死重启
    void host.close().finally(() => process.exit(42));
  };
  void bootHost({
    dataRoot,
    catalogFile: argOf('catalog') ?? ANCHORS.catalogFile,
    port: argOf('port') !== undefined ? Number(argOf('port')) : undefined,
    onRestartRequest: (sender) => {
      if (hostRef[0] !== undefined) restartHost(hostRef[0], sender);
    },
    // 诊断档（config-write-smoke 同族）：--mock-provider 在场即壳 argv 注入 mock
    ...(args.includes('--mock-provider') ? { mockProvider: true } : {}),
    ...(hasStatic ? { staticDir } : {}),
  }).then((host) => {
    hostRef[0] = host;
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

/**
 * restart-shell 复活标记扫描（cr-651 换代窗口兜底 + cr-663 单一仲裁）。
 * 纯域可测：ensureAgent / 时钟 / 告警面注入；盘上事实（标记、activation.lock）
 * 用真实 fs（sandbox 数据根）。
 *
 * 语义：
 *   · activation.lock 持有者活 = 已有壳，跳过（锁 = 重拉唯一事实）；
 *   · 领取原子性：标记 rename 成 <agentId>.<pid>.claimed 再拉起——撞名即
 *     他宿主已领，跳过；拉起失败回滚原名（回滚失败留 TTL 清扫）；
 *   · TTL 10min：过期标记丢弃 + 领取者死亡的陈旧 .claimed 清扫（新壳
 *     永不起来时不再每次 boot 白拉）；
 *   · 兑现与自清归新壳 boot（认 .json 与 .claimed 两种名形态——cr-658
 *     conversationId 注入不因领取丢）。
 */
export function sweepRestartShellMarkers(input: {
  dataRoot: string;
  ensureAgent: (agentId: string) => Promise<unknown>;
  now?(): number;
  onError?(msg: string): void;
}): void {
  const markerDir = path.join(input.dataRoot, '.runtime', 'restart-shell');
  const ttlMs = 10 * 60_000;
  const now = input.now ?? Date.now;
  const err = input.onError ?? ((msg: string) => { process.stderr.write(msg + '\n'); });
  let names: string[] = [];
  try { names = fs.readdirSync(markerDir); } catch { return; /* 无标记目录 */ }
  for (const name of names) {
    if (name.endsWith('.claimed')) {
      // 陈旧领取（领取者宿主死亡）：超 TTL 即删；未超 = 他宿主在拉，不动
      try {
        const st = fs.statSync(path.join(markerDir, name));
        if (now() - st.mtimeMs > ttlMs) fs.rmSync(path.join(markerDir, name), { force: true });
      } catch { /* 已收 */ }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const agentId = name.slice(0, -'.json'.length);
    const markerPath = path.join(markerDir, name);
    let markerAgeMs = 0;
    let markerRaw = '';
    try {
      markerRaw = fs.readFileSync(markerPath, 'utf-8');
      const raw = JSON.parse(markerRaw) as { at?: unknown };
      const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
      if (Number.isFinite(at)) markerAgeMs = now() - at;
    } catch { /* 坏标记按无时戳处理（不 TTL 丢弃——保守拉一次） */ }
    if (markerAgeMs > ttlMs) {
      fs.rmSync(markerPath, { force: true });
      err('[host] restart_shell 标记超时丢弃（' + agentId + '，age=' + Math.round(markerAgeMs / 1000) + 's）');
      continue;
    }
    const lock = readActivationLock(path.join(input.dataRoot, 'agents', agentId));
    if (lock !== null) {
      let alive = false;
      try { process.kill(lock.pid, 0); alive = true; } catch { /* holder 已死 */ }
      if (alive) continue;
    }
    // O_EXCL 原子领取（cr-663 实测修正）：rename 在 Windows 上并发对同一
    // 源可双双「成功」（MoveFileExW 竞态——复现脚本 c1-double-pull-repro
    // 实锤）；wx 独占创建须用**共享领文件名**（<agentId>.claimed，不带 pid
    // ——各开各名不相斥）才与 activation.lock / host-revive.lock 同款原子。
    // 领文件承载标记原文（壳 boot 自清读它注入 cr-658 conversationId）。
    const claimedPath = path.join(markerDir, agentId + '.claimed');
    try {
      if (markerRaw === '') markerRaw = fs.readFileSync(markerPath, 'utf-8'); // 已被他者收走则此读抛 ENOENT
      const fd = fs.openSync(claimedPath, 'wx');
      fs.writeFileSync(fd, markerRaw, 'utf-8');
      fs.closeSync(fd);
    } catch { continue; /* 他宿主已领（EEXIST）/ 标记已收走（ENOENT） */ }
    fs.rmSync(markerPath, { force: true });
    void input.ensureAgent(agentId).catch((e: unknown) => {
      err('[host] restart_shell 标记重拉失败（' + agentId + '）：' + String(e));
      try {
        fs.rmSync(claimedPath, { force: true });
        fs.writeFileSync(markerPath, markerRaw, 'utf-8');
      } catch { /* 回滚失败留 TTL 清扫 */ }
    });
  }
}
