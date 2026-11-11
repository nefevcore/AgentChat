// ============================================================
// webui-row-v3.ts —— webui 本体行 v3（cr-928 切片①；docs/design/webui/webui-v3.md §4.1-4.3）
//
// 职责（v3 装载链宿主半边）：
//   · webui 基座 fiber 域：直构 Loader（in-memory 树——write 无持久面），
//     分层求值行名单（webui-doc.ts）→ loader entries（web 面行零功能
//     node 半）；行装卸瞬间 = fiber 构造/销毁事件 → WebuiWireGraph 打脏
//     flush → wire 增删行（裁决一：一致性由构造保证）。
//   · GET /api/ui/wire：全量幂等（唯一获取路径——裁决六；内联预载后继）。
//   · GET /ui-asset/:id/:rev/*：包内 client/dist 原位服务——realpath 囚笼
//     + MIME 白名单 + revision URL 永久缓存（裁决四）。
//   · WS 帧：wire/graph（载荷 rev，rev 变才发）与 wire/rebuilt（dev
//     stat-poll 探测产物重建）——走既有 webServer.broadcast（裁决七）。
// 出厂行 fail-loud 分类（§4.2）：基座点名行的装载/解析失败 = error 日志
// + warnings [出厂] 标记（切片②全量构建就位后升格 throw——发布链 bug 面）。
// 与旧 webui-row 并存至切片②全量切换（cutover 删旧链 §4.9）。
// ============================================================
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HOST_MODULE_SPECS } from '../scripts/host-module-table.ts';
import type { Plugin, Context } from '@agentchat/cordis';
import { Loader } from '@agentchat/cordis-loader';
import { WebuiWireGraph } from './webui-graph.ts';
import { deriveWebuiRows, type WebuiDocRow } from './webui-doc.ts';
// webServer 契约增强（declare module 全局合并靠 include src 面闭合）
import type {} from 'ac-web-server';

/** MIME 白名单（§4.5 资产服务） */
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};


/** 说明符根包名 */
const rootSpecOf = (s: string): string => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!;

/**
 * 缺省种子词表（cr-930）：宿主模块表词根 ∈ 非通道行包（无 ac.faces.web
 * ——骨架 3 件/基座库）→ 种子词（版本区间 = 壳在位 ^major.minor）；
 * 通道行包根 → wire 行（跨行经行深导出面解析，不作种子）。壳 = apps/ui。
 */
export function deriveShellSeeds(pkgRoot: string, shellDir: string): Record<string, string> {
  const seeds: Record<string, string> = {};
  const skip = new Set<string>();
  for (const spec of HOST_MODULE_SPECS) {
    const root = rootSpecOf(spec);
    if (skip.has(root)) continue;
    skip.add(root);
    try {
      const pkg = JSON.parse(readFileSync(join(pkgRoot, root, 'package.json'), 'utf8'));
      if (pkg.ac?.faces?.web !== undefined) continue; // 通道行 = wire 行，非种子
    } catch { /* 非工作区包（vue/pinia 等）——种子 */ }
    try {
      const req = createRequire(join(shellDir, 'package.json'));
      let pkgPath: string | undefined;
      try {
        pkgPath = req.resolve(root + '/package.json');
      } catch {
        let dir = req.resolve(root);
        for (;;) {
          const c = join(dir, 'package.json');
          if (existsSync(c)) { pkgPath = c; break; }
          const p = dirname(dir);
          if (p === dir) throw new Error('not found');
          dir = p;
        }
      }
      const v = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '');
      const m = /^(\d+)\.(\d+)/.exec(v);
      seeds[root] = m === null ? '^' + v : '^' + m[1] + '.' + m[2];
    } catch { /* 解析失败（缺依赖）——词缺席，行声明该词时对拍降级 */ }
  }
  return seeds;
}

export interface WebuiRowV3Options {
  /** 装载解析基址（link: 相对说明符锚——repo 根 / 数据根） */
  baseUrl: string;
  /** 分层文档目录（webui.patch.yml 等） */
  profileDir: string;
  /** 种子词表（壳构建期生成——wire 顶层 seeds；§4.4） */
  shellSeeds?: Record<string, string>;
  /** dev 产物重建探测（stat-poll wire/rebuilt 帧；缺省关） */
  watch?: boolean;
  /** 观测面出参（boot 终检/测试注入空对象，apply 填充——cordis ctx 属性须
   * provide，不走 ctx 挂载） */
  handle?: WebuiRowV3Handle;
}

/** 供宿主 boot 与测试观测的面 */
export interface WebuiRowV3Handle {
  loader?: Loader;
  graph?: WebuiWireGraph;
  /** 出厂行名单（fail-loud 分类输入） */
  factoryRows?: WebuiDocRow[];
}

/**
 * webui v3 行（Plugin 形态——宿主 boot ctx.plugin 装配；inject ['webServer']）。
 * 路由与推送注册即归属：本行摘除即端点与帧下线。
 */
export function makeWebuiRowV3(options: WebuiRowV3Options): Plugin {
  return {
    name: 'ac-ui-app/webui-v3',
    inject: ['webServer'],
    apply(ctx: Context) {
      const web = ctx.webServer;

      // ---- webui 基座 fiber 域（直构 Loader——注册即归属本行 fiber）----
      // 缺省种子表推导仅 file: 形态可用（jsdom 测试 http: 形 → 显式传参或空表）
      let shellSeeds = options.shellSeeds;
      if (shellSeeds === undefined) {
        // 锚点解析：file: 形态（宿主）直接用；http: 形态（jsdom 测试）从
        // cwd 上溯找 pnpm-workspace.yaml（数据根恒在仓库内）
        let uiDir: string | undefined;
        try {
          uiDir = fileURLToPath(new URL('..', import.meta.url));
        } catch { /* jsdom 形态 */ }
        if (uiDir === undefined) {
          let dir = process.cwd();
          for (;;) {
            if (existsSync(join(dir, 'pnpm-workspace.yaml'))) { uiDir = join(dir, 'apps', 'ui'); break; }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
        }
        shellSeeds = uiDir !== undefined ? deriveShellSeeds(join(uiDir, '..', '..', 'packages'), uiDir) : {};
      }
      const loader = new Loader(ctx, { baseUrl: options.baseUrl });
      const { rows, warnings: docWarnings } = deriveWebuiRows(options.profileDir);
      for (const w of docWarnings) ctx.logger.warn('[webui-v3] ' + w);
      const factoryIds = new Set(rows.filter((r) => r.factory).map((r) => r.id));
      const graph = new WebuiWireGraph(ctx, loader, { shellSeeds });

      // 分层行装载（异步面——点名缺席/解析失败 = 降级 + 上报）。
      // setImmediate：apply 进行中创建 entry 会把 entry ctx 原型链打成环
      //（loader/patch-context 的 setPrototypeOf 在父 fiber LOADING 期执行
      // = Cyclic __proto__）——装载趟必须等本行 apply 返回后启动。
      setImmediate(() => void (async () => {
        for (const row of rows) {
          try {
            await loader.create({ name: row.spec });
          } catch (error) {
            const msg = 'webui 行装载失败（跳过 + 上报）：' + row.id + '（' + row.spec + '）'
              + (error instanceof Error ? '：' + error.message : '');
            if (factoryIds.has(row.id)) ctx.logger.error('[webui-v3][出厂] ' + msg);
            else ctx.logger.warn('[webui-v3] ' + msg);
          }
        }
        // 装载趟收口对账（fiber 激活窗的兜底——wire 在 boot 终态前成形）
        graph.rescan();
        auditArmed = true;
        auditFactoryRows();
      })());

      // 出厂行 fail-loud 分类：激活对账后基座点名的行缺席 wire = error 上报。
      // 对账轴 = loader 行名（spec）——wire 行 id 是包全名（ac-client-*），
      // 与装配文档短 id（midnight/agents/…）不同轴，直接对拍恒假阳性。
      // 审计窗 = 装载趟收口后（装载中行缺席是时序假象，非缺陷）。
      let auditArmed = false;
      // 退场 disarm（cr-996）：收面期（restart_host close 链）loader 拆 wire
      // 触发 onGraphChanged → 审计——不 disarm 则每条出厂行误报 error 级
      // 「行缺席 wire」（2026-11-10 现场：退场刻 31 条，装载全程正常）。
      ctx.effect(() => () => { auditArmed = false; }, 'webui-v3 出厂审计退场 disarm');
      const auditFactoryRows = () => {
        if (!auditArmed) return;
        const present = graph.names();
        for (const row of rows) {
          if (!row.factory || present.has(row.spec)) continue;
          ctx.logger.error('[webui-v3][出厂] 行缺席 wire（产物未构建或装载失败）：' + row.id);
        }
      };

      // ---- wire 获取（GET 全量幂等——唯一拉取路径）----
      web.route('GET', '/api/ui/wire', (call) => {
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(JSON.stringify(graph.wire()));
      });

      // ---- 资产面：原位服务 + realpath 囚笼 + MIME 白名单 ----
      web.route('GET', '/ui-asset/:id/:rev/*', async (call) => {
        const file = graph.assetFile(call.params.id, call.params.rev, call.params['*']);
        if (file === null) {
          call.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('not found');
          return;
        }
        // realpath 囚笼：root 与 file 各 realpath 后前缀对拍，越出包根 = 403
        const cageRoot = realpathSync(dirname(file));
        const real = realpathSync(file);
        if (!(real + '\\').startsWith(cageRoot + '\\') && !(real + '/').startsWith(cageRoot + '/')) {
          call.res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('forbidden');
          return;
        }
        const ext = file.slice(file.lastIndexOf('.'));
        if (!Object.prototype.hasOwnProperty.call(ASSET_TYPES, ext)) {
          call.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('unsupported asset type');
          return;
        }
        await web.serveFileRoute(call.res, file, {
          acceptEncoding: call.req.headers['accept-encoding'] ?? '',
          // revision URL 承担缓存语义：内容修订段在 URL——永久缓存（§4.5）
          cacheControl: 'public, max-age=31536000, immutable',
        });
      });

      // ---- WS wire/graph 帧（rev 变才发；断连重拉全量——§4.3.3）----
      let lastRev = graph.wire().rev;
      graph.onGraphChanged(() => {
        const wire = graph.wire();
        if (wire.rev !== lastRev) {
          lastRev = wire.rev;
          web.broadcast('wire/graph', { args: [wire.rev] });
        }
        auditFactoryRows();
      });

      // ---- dev 产物重建探测（stat-poll——网络挂载无 inotify 同由；缺省关）----
      if (options.watch === true) {
        let timer: ReturnType<typeof setInterval> | undefined;
        const mtimes = new Map<string, number>();
        const poll = () => {
          let rebuilt = false;
          for (const [id, pkgDir] of graph.pkgDirs()) {
            const distDir = join(pkgDir, 'client', 'dist');
            try {
              const mtime = statSync(join(distDir, 'manifest.json')).mtimeMs;
              if (mtimes.has(id) && mtimes.get(id) !== mtime) rebuilt = true;
              mtimes.set(id, mtime);
            } catch { /* 产物缺席行跳过 */ }
          }
          if (rebuilt) {
            graph.rescan(); // manifest 重读 → 新 rev → onGraphChanged → wire/graph
            web.broadcast('wire/rebuilt', { args: [graph.wire().rev] });
          }
        };
        // 懒拉起：首帧到达（watch 显式开启）才常驻；行卸载即 dispose
        timer = setInterval(poll, 1000);
        timer.unref();
        ctx.effect(() => () => clearInterval(timer), 'webui-v3 stat-poll');
      }

      // 观测面（boot 终检/测试）——出参填充，不构成公共契约（cutover 前形态）
      if (options.handle !== undefined) {
        options.handle.loader = loader;
        options.handle.graph = graph;
        options.handle.factoryRows = rows.filter((r) => r.factory);
      }
    },
  };
}
