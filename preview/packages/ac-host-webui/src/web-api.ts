// ============================================================
// web-api.ts —— preview web-api 薄 RPC 面（8.5a；M8.4 遗留「webui HTTP/RPC 面接线」）
//
// 主线 ac-web-api 行硬 inject 18 服务（conversation/session/agents/...——
// 主线宿主树形态），preview 宿主树无此服务面，不可零改动导入。本行为
// preview 侧新建：方法名 / 参数 / 返回形状与主线对齐（前端零改动），
// 服务面换 preview 等价物——
//   conversation/deliver → UserStub.send（R-2 user 壳桩代签发投递）
//   session/history      → webui-core readLedgerFrom（历史读纯库直读）
//   agents/list          → agents-core listAgentIds + readAgentConfig 直读
//   config/*             → ctx.config（宿主 config 行 = 配置落盘单源）+
//                          ac-credentials-core（池 api_key 侧信道，cr-564）
// 边界铁律（主线同款）：纯编排——参数窄化 + 转发调用 + outcome→ack 映射，
// 零业务逻辑（配置面词汇住 ./config-face.ts）。
// ============================================================
import type { Plugin, Context } from '@agentchat/cordis';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import type { MultipartBody, RouteCall } from 'ac-web-server';
import * as path from 'node:path';
import { UserLedger, conversationDirs, deleteConversationRow, readLedger, readJournal, sessionDir, stepsOfRun, stepsOfLedger, deriveViewerLedger, truncateConversation, type JournalLine, type LedgerRow } from 'ac-ledger';
import { listAgentIds, readAgentConfig, isAgentIdentity, materializedChildIds } from 'ac-agents-core';
import { pairKey } from 'ac-core-utils';
import { registerOpsFace, collectRunning, type FaceOpsDeps } from './face-ops.ts';
import {
  avatarPathOf,
  guessContentType,
  listWorkspaces,
  readWorkspaceFile,
  registerWorkspace,
  removeWorkspace,
  resolveWorkspaceFile,
  saveWorkspaceUpload,
  updateWorkspace,
  workspaceTree,
  type WorkspaceContext,
} from 'ac-host-rows';
import { registerShellFace, type ShellAdminPort } from './face-shell.ts';
import {
  backfillPoolMasks,
  createPoolCredentials,
  lockedCredentialWarning,
  maskSecrets,
  poolProviderKey,
  removeConfigKey,
  saveConfigDomains,
  writeConfigKey,
  type ConfigFace,
  type PoolCredentialFace,
} from './config-face.ts';

/** 会话级覆盖服务窄接口（ctx.convSettings 结构子集——host conv-settings 行提供） */
interface ConvSettingsFace {
  get(conversationId: string): Record<string, string>;
  set(conversationId: string, patch: Record<string, string | null | undefined>): Record<string, string>;
  listKeys(): Array<{ key: string; enum?: string[]; description?: string; group?: string }>;
}

/** web-api 行依赖注入（宿主 boot 组装——非 cordis inject：UserStub/数据根为宿主编排件非行服务） */
export interface WebApiDeps {
  /** user 壳桩（R-2——deliver 的投递执行体） */
  user: {
    send(agentId: string, text: string, options?: { uuid?: string; requestId?: string }): Promise<{ uuid: string; dispatched: unknown[] }>;
  };
  /** 数据根（历史读 / agents 直读锚点） */
  dataRoot: string;
  /** 行集目录（plugin/catalog builtin 组；缺省 preview/apps/catalog） */
  catalogFile?: string;
  /** 编排面惰性端口（壳内服务面；boot 创建 orchestrator 后回填） */
  shellPort?: () => ShellAdminPort | null;
}

// ---- 参数窄化（主线同款纪律：缺参 → rpc error） ----

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失或非非空字符串`);
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 名册身份集合（单源——agents/list 载荷与 healthz agents 计数同轴）：
 *  config 在场 ∩ 身份词形（禁 `~`——对键桶会话流域非名册，ensureAgent 兜底
 *  config 在场也不算）∩ 非 preset ∩ 非派生子身份（cr-674：subagent 子身份
 *  物化在 children/ 树，顶层兜底 config 会被上一条误放行）。裸目录计数会把
 *  pair/群/子域误算进名册。 */
function rosterConfigs(dataRoot: string) {
  const derived = materializedChildIds(dataRoot);
  return listAgentIds(dataRoot)
    .filter((id) => isAgentIdentity(id) && !derived.has(id))
    .map((id) => readAgentConfig(dataRoot, id))
    .filter((c): c is NonNullable<typeof c> => c !== null && c.preset !== true);
}

/** 数据根画像（healthz 的真实性来源：数得出来的东西，不是常量 200） */
async function dataRootFacts(dataRoot: string): Promise<{ agents: number; conversations: number; configReadable: boolean }> {
  const countDirs = async (dir: string): Promise<number> => {
    try { return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).length; } catch { return 0; }
  };
  let configReadable = false;
  try { JSON.parse(await readFile(path.join(dataRoot, 'config.json'), 'utf-8')); configReadable = true; } catch { /* 缺席/坏文件 */ }
  return {
    agents: rosterConfigs(dataRoot).length,
    conversations: await countDirs(path.join(dataRoot, 'viewer', 'sessions')),
    configReadable,
  };
}

/**
 * web-api 薄行（Plugin 形态——宿主 boot ctx.plugin 装配；inject ['webServer']）。
 * 主线 web-api 行同款的显式注册面——每方法一个 registerRpc。
 */
export function makeWebApiRow(deps: WebApiDeps): Plugin {
  return {
    name: 'ac-host-webui/web-api',
    inject: ['webServer'],
    apply(ctx: Context) {
      const web = ctx.webServer;

      web.registerRpc('conversation/deliver', async (params, caller) => {
        const p = obj(params);
        const agentId = reqStr(p, 'agentId');
        // 主线 message 形态：string | {role, content, attachments}——preview 首版
        // 收 string 与对象 content 字段（前端 composeContent 产物），attachments
        // 面未接（恒缺省）。lane/placement 白名单窄化后随信透传（cr-575——
        // 忙态决策归壳侧 ConversationMachine，busy 时 next-turn 排队/steer 注入）。
        const raw = p.message;
        const text = typeof raw === 'string' ? raw
          : typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).content === 'string'
            ? (raw as Record<string, unknown>).content as string
            : '';
        if (text === '') throw new Error('参数 message 缺失或无 content');
        const requestId = optStr(p.requestId);
        const conversationId = optStr(p.conversationId);
        // 忙态投递方式（cr-575 队列产品化）：白名单窄化后随信透传——
        // 前端运行中 Enter = lane next-turn（QueueDock 排队面），显式 steer = 注入
        const laneRaw = optStr(p.lane);
        const lane = laneRaw === 'next-step' || laneRaw === 'next-turn' ? laneRaw : undefined;
        const placementRaw = optStr(p.placement);
        const placement = placementRaw === 'steer' || placementRaw === 'next-run' ? placementRaw : undefined;
        // 会话级模型覆盖合并点（cr-565；主线 web-api deliver 同构 P6/D4）：
        // 显式入参优先（single 会话前端随消息带 ctx.model——临时换模不回写），
        // 缺省查 conv-settings（1v1 直答键 = pairKey(viewer, agent)——前端
        // 不传 conversationId 时边界显式计算）。覆盖随信投递：壳无从查表也生效。
        const model = optStr(p.model)
          ?? storedModelOf(conversationId ?? pairKey('user', agentId));
        // 单次投递提权档位（cr-626，主线 web-api deliver 同款白名单窄化）：
        // 输入框档位选择随信投递——主线 loop request.elevation 同词汇。
        const elevRaw = optStr(p.elevation);
        const elevation = elevRaw === 'sandbox-access' || elevRaw === 'full-access' ? elevRaw : undefined;
        const result = await deps.user.send(agentId, text, {
          ...(conversationId !== undefined ? { uuid: conversationId } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(elevation !== undefined ? { elevation } : {}),
          ...(lane !== undefined ? { lane } : {}),
          ...(placement !== undefined ? { placement } : {}),
        });
        // 前端对返回值无消费（fire-and-forget + 超时容错）；返回主线程一形状
        return { kind: 'run', uuid: result.uuid };
      });

      web.registerRpc('session/history', async (params) => {
        const p = obj(params);
        const conversationId = reqStr(p, 'conversationId');
        // 读前派生（cr-698 viewer 派生化）：agent 域账本自著行（终稿/通知）
        // → viewer 行（requestId 幂等 / run 键单行 / 原 ts）。读时派生兼做
        // 崩溃窗口兜底（终稿通知丢失 → 下次读面补齐）；附带存量双锚行迁移。
        const domains = conversationDirs(deps.dataRoot, conversationId, { includeJournalOnly: true })
          .map((d) => path.basename(path.dirname(path.dirname(d))))
          .filter((d) => d !== 'viewer');
        await deriveViewerLedger(deps.dataRoot, conversationId, domains);
        // user 账本（终稿层投影——裁决簿〈webui 读投影〉形态二）：UserLedger
        // .replay() 即 user 视角投影（UserReplayRow：role 'user'|'peer' +
        // agentId）。输出名对齐主线 records 形状（role + agent_id）——前端零改动。
        // 分页（limit/offset 尾部语义）与主线对齐。
        const ledger = new UserLedger(deps.dataRoot, conversationId, ['user']);
        // agent 域 journal/账本按端点读一次缓存（D4.2 带出：peer 行按 run 键
        // 关联 agent 域——思考/工具卡投影进 steps，刷新不丢）。steps 源 =
        // 物化段行优先（cr-697 收束即清后 settled run 的 steps 事实源）、
        // journal 兜底存量会话与 in-flight。
        // 对桶键（a~b）双端并读（cr-611）：迁移直答 pair 的 journal 住尾段
        // 域（agents/user），运行时 pair 的 journal 住对端自己的域——按
        // participants 双端取并集，run 键不相交无重。
        const journalOf = new Map<string, JournalLine[]>();
        const rowsOf = new Map<string, LedgerRow[]>();
        const faceFor = (agentId: string): { lines: JournalLine[]; rows: LedgerRow[] } => {
          let lines = journalOf.get(agentId);
          let rows = rowsOf.get(agentId);
          if (lines === undefined || rows === undefined) {
            lines = readJournal(sessionDir(deps.dataRoot, agentId, conversationId));
            rows = readLedger(sessionDir(deps.dataRoot, agentId, conversationId)).rows;
            if (conversationId.includes('~')) {
              for (const part of conversationId.split('~')) {
                if (part === agentId) continue;
                lines = [...lines, ...readJournal(sessionDir(deps.dataRoot, part, conversationId))];
                rows = [...rows, ...readLedger(sessionDir(deps.dataRoot, part, conversationId)).rows];
              }
            }
            journalOf.set(agentId, lines);
            rowsOf.set(agentId, rows);
          }
          return { lines, rows: rows! };
        };
        const stepsFor = (agentId: string, run: string): { steps: Array<{ content: string; reasoning?: string; ts?: number; toolCalls?: Array<{ id: string; name: string; arguments: string; result: unknown; subcall?: boolean }> }>; partial: boolean } | null => {
          const { lines, rows } = faceFor(agentId);
          return stepsOfLedger(rows, run) ?? stepsOfRun(lines, run);
        };
        const all = ledger.replay().map((r) => {
          const projected = r.role === 'peer' && r.run !== undefined
            ? stepsFor(r.agentId, r.run)
            : null;
          return {
            role: r.role === 'peer' ? 'assistant' : 'user',
            agent_id: r.role === 'peer' ? r.agentId : undefined,
            content: r.content,
            ...(r.run !== undefined ? { run: r.run } : {}),
            ...(projected !== null ? { steps: projected.steps, ...(projected.partial ? { partial: true } : {}) } : {}),
          };
        });
        // journal 活投影（cr-598）：run 中刷新恢复——running 集命中的**当前
        // run**（runId 精确门控）journal 步行按步追加 partial 行（前端 resume
        // 管线〔stats 命中 → loadHistory〕据此回放已完成步并接续流式）。
        // runId 门控：同会话崩溃孤儿 journal（未收束但非当前 run）不投——
        // 不制造永恒在途行。
        const runningHere = (await collectRunning(deps))
          .flatMap((r) => r.conversationId === conversationId && r.runId !== null ? [{ agentId: r.agentId, runId: r.runId }] : []);
        for (const run0 of runningHere) {
          const p = stepsOfRun(faceFor(run0.agentId).lines, run0.runId);
          if (p === null || !p.partial) continue;
          for (const s of p.steps) {
            all.push({
              role: 'assistant',
              agent_id: run0.agentId,
              content: '',
              run: run0.runId,
              steps: [s],
              partial: true,
            });
          }
        }
        // steps 盲区投影（cr-628/698）：viewer 无对应行但有 steps 事实的 run
        // 一律投出——空终稿 run（中断/崩溃——「有思考链无正文」是常态，
        // 显示形态归前端渲染）+ 壳死于终稿回信前的 settled run（锚信通道
        // 已退役，不再以空行占位）。事实源 = 物化段行（settled run）∪
        // journal 步行（in-flight / 收束即清前的存量）；partial 如实。
        const linkedRuns = new Set(all.flatMap((r) => (r.run !== undefined ? [r.run] : [])));
        const runningIds = new Set(runningHere.map((r) => r.runId));
        for (const dir of conversationDirs(deps.dataRoot, conversationId, { includeJournalOnly: true })) {
          // dir = agents/<agentId>/sessions/<cid>（影子 = agents/<parent>/children/<child>/…）
          // ——域主 = sessions 段的上一级目录名；viewer 域非 agent 域跳过
          const agentId = path.basename(path.dirname(path.dirname(dir)));
          if (agentId === 'viewer') continue;
          const lines = readJournal(dir);
          const rows = readLedger(dir).rows;
          const candidates = new Set<string>();
          for (const l of lines) {
            if (l.run !== '' && (l.type === 'journal-step' || l.type === 'journal-inject')) candidates.add(l.run);
          }
          for (const r of rows) {
            if (r.source === 'segment' && r.run !== undefined) candidates.add(r.run);
          }
          for (const run of candidates) {
            if (linkedRuns.has(run) || runningIds.has(run)) continue;
            const p = stepsOfLedger(rows, run) ?? stepsOfRun(lines, run);
            if (p === null) continue;
            all.push({
              role: 'assistant',
              agent_id: agentId,
              content: '',
              run,
              steps: p.steps,
              ...(p.partial ? { partial: true } : {}),
            });
          }
        }
        const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0 ? Math.floor(p.limit) : undefined;
        const offset = typeof p.offset === 'number' && Number.isFinite(p.offset) && p.offset >= 0 ? Math.floor(p.offset) : 0;
        const page = limit === undefined
          ? all
          : all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset));
        return {
          conversationId,
          records: page,
          total: all.length,
          ...(limit !== undefined ? { hasMore: offset + limit < all.length } : {}),
        };
      });

      // ---- 真实健康检查（cr-562：拒绝「恒 200」的假探活）----
      // 返回宿主身份 + 数据根实测画像：端口活着但行集没装起来/数据根不可读
      // 都会体现为 ok=false 或字段缺失。切换脚本/外部探活以本端点为准。
      web.route('GET', '/api/healthz', async (call) => {
        let ok = true;
        let facts = { agents: 0, conversations: 0, configReadable: false };
        try { facts = await dataRootFacts(deps.dataRoot); } catch { ok = false; }
        const body = {
          ok: ok && facts.configReadable,
          host: 'preview-host',
          dataRoot: deps.dataRoot,
          uptimeMs: Math.round(process.uptime() * 1000),
          ...facts,
        };
        call.res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(JSON.stringify(body));
      });

      // ---- 工作区登记面（cr-583：前端 workspaceBoard 数据源——主线 /api/workspaces 四路由同形）----
      // 数据 = <dataRoot>/workspaces.json（主线 ac-workspace 行同布局；切换时
      // 未迁导致会话列表失去工作区分组——本批连同数据补迁一并修复）。
      web.route('GET', '/api/workspaces', (call) => {
        const body = JSON.stringify({ workspaces: listWorkspaces(deps.dataRoot) });
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(body);
      });

      web.route('POST', '/api/workspaces', (call) => {
        const p = ((call as { body?: unknown }).body ?? null) as Record<string, unknown> | null;
        const wsPath = typeof p?.path === 'string' ? p.path.trim() : '';
        if (wsPath === '') {
          call.res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          call.res.end(JSON.stringify({ error: 'path 缺失' }));
          return;
        }
        const body = JSON.stringify({ workspace: registerWorkspace(deps.dataRoot, wsPath, typeof p?.name === 'string' ? p.name : undefined) });
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(body);
      });

      web.route('PATCH', '/api/workspaces/:id', (call) => {
        const p = ((call as { body?: unknown }).body ?? null) as Record<string, unknown> | null;
        const patch: { name?: string; path?: string } = {};
        if (typeof p?.name === 'string') patch.name = p.name;
        if (typeof p?.path === 'string') patch.path = p.path;
        const id = (call as { params?: Record<string, string> }).params?.id ?? '';
        const workspace = updateWorkspace(deps.dataRoot, id, patch);
        const status = workspace === undefined ? 404 : 200;
        const body = workspace === undefined ? { error: 'workspace 不存在' } : { workspace };
        call.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(JSON.stringify(body));
      });

      web.route('DELETE', '/api/workspaces/:id', (call) => {
        const id = (call as { params?: Record<string, string> }).params?.id ?? '';
        const body = JSON.stringify({ deleted: removeWorkspace(deps.dataRoot, id) });
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(body);
      });

      // ---- 工作区文件面（cr-676：树/预览/直链/上传——主线 ac-workspace 四端点同形）----
      // 消费方 = 主线 ac-client-ui-workspace 行（树面板/预览弹窗）与 ChatInput
      // 附件上传（preview 通道直接复用现成前端）。此前只有 cr-583 的登记面，
      // 文件面整面缺席 → 前端打 /api/workspace/* 落 SPA 的 API 404
      //（「no api route: /api/workspace/tree」）。语义纯函数面住 ac-host-rows。
      const replyJson = (res: RouteCall['res'], status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };
      /** 读面上下文（主线 readContext 同形：query 的 agentId/conversationId 可选透传） */
      const readContextOf = (query: URLSearchParams): WorkspaceContext | undefined => {
        const agentId = optStr(query.get('agentId'));
        const conversationId = optStr(query.get('conversationId'));
        if (agentId === undefined && conversationId === undefined) return undefined;
        return {
          ...(agentId !== undefined ? { agentId } : {}),
          ...(conversationId !== undefined ? { conversationId } : {}),
        };
      };

      // 工作区目录树（懒加载；path 相对树基准，空 = 基准根。树基准随会话上下文
      // 定位：会话挂载工作区 > Agent 专用空间/显式 workdir > 数据根）
      web.route('GET', '/api/workspace/tree', (call) => {
        const rel = call.query.get('path') ?? '';
        try {
          replyJson(call.res, 200, workspaceTree(deps.dataRoot, rel, readContextOf(call.query)));
        } catch (err) {
          replyJson(call.res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      // 文件内容预览（文本直读 / 二进制 base64；files/<bucket>/... 上传引用形
      // 直通；带 context 时按 Agent/会话工作区基准推导相对引用）
      web.route('GET', '/api/workspace/file', (call) => {
        const rel = call.query.get('path');
        if (rel === null || rel === '') return replyJson(call.res, 400, { error: 'path 缺失' });
        try {
          replyJson(call.res, 200, readWorkspaceFile(deps.dataRoot, rel, readContextOf(call.query)));
        } catch {
          replyJson(call.res, 404, { error: '文件不存在或不可读' });
        }
      });

      // 原始字节直链（HTML 新窗口打开/图片缩略图；语义同 file 面）。缓存 =
      // no-cache + ETag(size:mtimeMs) 验证（主线 cr-82 同款：重复渲染资源命中
      // 304 零字节重协商）
      web.route('GET', '/api/workspace/raw', (call) => {
        const rel = call.query.get('path');
        if (rel === null || rel === '') return replyJson(call.res, 400, { error: 'path 缺失' });
        try {
          const file = resolveWorkspaceFile(deps.dataRoot, rel, readContextOf(call.query));
          const st = statSync(file);
          const etag = "\"wf-" + st.size + '-' + Math.floor(st.mtimeMs) + '\"';
          if (call.req.headers['if-none-match'] === etag) {
            call.res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            call.res.end();
            return;
          }
          call.res.writeHead(200, { 'content-type': guessContentType(file), 'cache-control': 'no-cache', etag });
          call.res.end(readFileSync(file));
        } catch {
          replyJson(call.res, 404, { error: '文件不存在或不可读' });
        }
      });

      // 附件上传（multipart：file + 可选 agentId/conversationId → files/<bucket>/_tmp/；
      // conversationId = 独立会话上传的桶推导键——agentId 缺席时经 session.json
      // 推导承载 Agent）
      web.route('POST', '/api/upload', (call) => {
        const body = (call as { body?: MultipartBody }).body;
        const file = body?.files.file;
        if (file === undefined) return replyJson(call.res, 400, { error: 'multipart 字段 file 缺失' });
        try {
          replyJson(call.res, 200, saveWorkspaceUpload(
            deps.dataRoot,
            optStr(body?.fields.agentId),
            file.filename,
            file.data,
            optStr(body?.fields.conversationId),
          ));
        } catch (err) {
          replyJson(call.res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      // ---- 全局配置面（cr-562 读面 / cr-564 写面：设置页 / 模型菜单数据源）----
      // 落盘单源：配置本体 → ctx.config（宿主 config 行——原子写 + config/changed
      // 热更事件，mcp / remote-link / file-snapshots 等消费方据此生效）；池条目
      // api_key → credentials/ 侧信道（config.json 永不落 key）。
      // 缺 config 行（行集被裁）= 配置面 fail-loud（良定义降级，其余 RPC 照常）。
      const config = (): ConfigFace => {
        const service = ctx.get('config') as ConfigFace | undefined;
        if (service === undefined) throw new Error('config 服务未装配（config 行不在宿主行集）——全局配置面不可用');
        return service;
      };
      const creds: PoolCredentialFace = createPoolCredentials(deps.dataRoot);

      web.registerRpc('config/get', () => {
        const all = config().all();
        backfillPoolMasks(creds, all); // 池条目 api_key 掩码（'' = 未设置）
        return { config: maskSecrets(all) };
      });

      web.registerRpc('config/set', (params) => {
        const p = obj(params);
        const key = reqStr(p, 'key');
        const warnings = writeConfigKey(config(), creds, key, p.value);
        return { set: true, key, ...(warnings.length > 0 ? { warnings } : {}) };
      });

      web.registerRpc('config/delete', (params) => {
        const key = reqStr(obj(params), 'key');
        removeConfigKey(config(), key);
        return { deleted: true, key };
      });

      // 全量保存（settings 底部「保存配置」）：白名单域内 replace 语义
      web.registerRpc('config/save', (params) => {
        const warnings = saveConfigDomains(config(), creds, obj(params).config);
        return { saved: true, ...(warnings.length > 0 ? { warnings } : {}) };
      });

      // 池凭据写口（前端删连接时同步清凭据——残留会让内置种子名的发现回写
      // 把已删条目复活）。value '' = 删除；目标 locked（在盘解密失败，可恢复）
      // 时保留不删（cr-310 守卫）。domain：'llm'（POOL:，缺省）/ 'search'。
      web.registerRpc('llm/pool-credential', (params) => {
        const p = obj(params);
        const name = reqStr(p, 'name');
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('参数 name 须为安全字符（字母/数字/_/-）');
        const domain = p.domain ?? 'llm';
        if (domain !== 'llm' && domain !== 'search') throw new Error('参数 domain 非法（' + String(p.domain) + '）');
        const provider = poolProviderKey(domain, name);
        const value = typeof p.value === 'string' ? p.value : '';
        if (value === '' && creds.state(provider) === 'locked') {
          return { set: true, name, warnings: [lockedCredentialWarning(name)] };
        }
        creds.set(provider, value);
        return { set: true, name };
      });

      web.registerRpc('agents/list', () => ({
        // 名册 = rosterConfigs 单源（cr-607：`~` 会话流域与 preset 不进名册）。
        // 载荷 = 全量 config 展开（主线 ...a 同形——前端消费 description 回退
        // 显示名 / tags 徽章 / provider 警示态）+ hasAvatar/avatarVersion
        //（主线 cr-82：真有头像才置位 + 版本号 size:mtimeMs——版本化 URL）。
        agents: rosterConfigs(deps.dataRoot).map((c) => {
            const file = avatarPathOf(deps.dataRoot, c.id);
            if (file === undefined) return { ...c, hasAvatar: false };
            try {
              const st = statSync(file);
              return { ...c, hasAvatar: true, avatarVersion: `${st.size}:${Math.floor(st.mtimeMs)}` };
            } catch {
              return { ...c, hasAvatar: true };
            }
          }),
      }));

      // conversation/stats：前端 chat-core / feed-core 两链消费（cr-598 接真
      // 数据源——此前硬编码空壳曾令 resume 恢复不拉 history、流式静默探针
      //〔feed-core 分区静默超阈查权威〕误判流死拆直播分区 =「流式不稳定」根因）。
      // 活跃集 = 活壳 run-state 帧（face-ops collectRunning——runs/snapshot 同源）。
      web.registerRpc('conversation/stats', async () => ({
        running: (await collectRunning(deps)).map((r) => ({ agentId: r.agentId, conversationId: r.conversationId })),
      }));

      // ---- 会话级覆盖面（cr-565）----
      // 宿主 conv-settings 行 = 写面单源（壳经垫片只读直取同一数据目录）。
      // 键域校验/枚举值/键删除→删文件等语义全在 owning service，此处零业务逻辑。
      const convSettings = (): ConvSettingsFace => {
        const service = ctx.get('convSettings') as ConvSettingsFace | undefined;
        if (service === undefined) throw new Error('convSettings 服务未装配（conv-settings 行不在宿主行集）——会话覆盖面不可用');
        return service;
      };
      /** 存盘覆盖读（行缺席 = 无覆盖语义——良定义降级，deliver 照常） */
      const storedModelOf = (conversationId: string): string | undefined => {
        const service = ctx.get('convSettings') as ConvSettingsFace | undefined;
        if (service === undefined) return undefined;
        return service.get(conversationId).model;
      };

      web.registerRpc('conv-settings/get', (params) => ({
        settings: convSettings().get(reqStr(obj(params), 'conversationId')),
      }));

      web.registerRpc('conv-settings/set', (params) => {
        const p = obj(params);
        const conversationId = reqStr(p, 'conversationId');
        const patch = p.patch;
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('参数 patch 须为对象（值 = 字符串或 null——null 删键）');
        }
        return { settings: convSettings().set(conversationId, patch as Record<string, string | null>) };
      });

      // 实验性键目录（输入框「实验性」菜单数据源——注册制：壳内扩展行经垫片
      // 注册的键不回传，宿主侧键集单源 = conv-settings 行）。group 过滤 =
      // 主线同款（cr-613：移植时丢失致 model/elevation/toolMode 纯消费键
      // 混入实验性菜单——只回 UI 组键）
      web.registerRpc('conv-settings/keys', () => ({
        keys: convSettings().listKeys().filter((k) => k.group === 'experimental'),
      }));

      // ---- 会话消息面（cr-566）：删一条 / 截断其后 —— 账本原子改写 ----
      // 账本 owning = ac-ledger（manage.ts：读→过滤→tmp+rename）。一次用户动作
      // 对该会话的全部账本生效（user 投影 + 各 agent 域——否则对端仍记得被删的行）。
      web.registerRpc('session/delete-message', (params) => {
        const p = obj(params);
        const conversationId = reqStr(p, 'conversationId');
        const messageId = reqStr(p, 'messageId');
        let deleted = 0;
        for (const dir of conversationDirs(deps.dataRoot, conversationId)) deleted += deleteConversationRow(dir, messageId);
        return { deleted: deleted > 0 };
      });

      // 截断（行内编辑 / 重新推理语义）：删掉锚点消息及其后的全部记录
      web.registerRpc('session/truncate', (params) => {
        const p = obj(params);
        const conversationId = reqStr(p, 'conversationId');
        const messageId = reqStr(p, 'messageId');
        let removed = 0;
        for (const dir of conversationDirs(deps.dataRoot, conversationId)) removed += truncateConversation(dir, messageId);
        return { removed };
      });

      // 宿主可直读的一批能力域（cr-567）：timer / 预设 / 技能 / 文件快照 /
      // 用量 / 版本 / 事件治理——全部直通 owning 实现，见 ./face-ops.ts
      registerOpsFace(
        web as unknown as { registerRpc(method: string, handler: (params: unknown) => unknown): void },
        ctx,
        {
          dataRoot: deps.dataRoot,
          ...(deps.catalogFile !== undefined ? { catalogFile: deps.catalogFile } : {}),
          ...(deps.shellPort !== undefined ? { shellPort: deps.shellPort } : {}),
        },
      );

      // 壳内服务面（cr-569）：goal / todo / 运行中断——控制帧往返编排面
      registerShellFace(
        web as unknown as { registerRpc(method: string, handler: (params: unknown) => unknown): void },
        ctx,
        { dataRoot: deps.dataRoot, port: () => deps.shellPort?.() ?? null },
      );

    },
  };
}

