// ============================================================
// singles-row.ts —— 宿主独立会话行（cr-566）
//
// owns：viewer/sessions/<sid>/session.json（元数据：agentId / title /
// workspaceId / status / 时间戳）。消息流归 user 终稿账本（UserStub 写，
// messages.jsonl——同一端点目录，文件分家）；模型覆盖归 conv-settings
//（D12 单源，本行只经服务方法读写真值，不落 session.json）。
//
// RPC 面与主线 ac-web-api 同形（前端零改动）：
//   singles/list | create | update | fork | archive | delete
// 事件：singles/updated —— 帧 args = [session, 'created'|'updated'|'archived'|'removed']
//（前端 singleBoard 增量合并的单源；断连重连走 list 兜底）。
//
// 导入存量兼容：旧根导入的 827 个会话只有 messages.jsonl 无 session.json——
// 视图按账本派生（agentId = 首条对端行、title = 首条自己行截断、时间 = 目录
// mtime），首次 update 时才落 session.json（纯增量，不迁移）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, Context } from '@agentchat/cordis';
import { issueConversationId } from 'ac-envelope-core';
import { conversationDirs, forkConversation } from 'ac-ledger';
import { readAgentConfig } from 'ac-agents-core';

export interface SinglesHostRowOptions {
  dataRoot: string;
}

/** 会话元数据（session.json 形态——模型覆盖不在此，见 conv-settings） */
export interface SingleMeta {
  id: string;
  agentId?: string;
  title?: string;
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

/** 对外视图（前端 SingleSession 形状） */
export interface SingleView {
  id: string;
  agentId: string;
  model?: string;
  title?: string;
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

/** 会话设置窄接口（ctx.convSettings——D12 宿主行提供；行缺席 = 无覆盖语义） */
interface ConvSettingsFace {
  get(conversationId: string): Record<string, string>;
  set(conversationId: string, patch: Record<string, string | null | undefined>): Record<string, string>;
}

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
  broadcast(type: string, data?: unknown): void;
}

const TITLE_MAX_LEN = 24;

function sessionsDir(dataRoot: string): string {
  return path.join(dataRoot, 'viewer', 'sessions');
}

function dirOf(dataRoot: string, id: string): string {
  return path.join(sessionsDir(dataRoot), id);
}

function metaFileOf(dataRoot: string, id: string): string {
  return path.join(dirOf(dataRoot, id), 'session.json');
}

function assertId(id: string): void {
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('会话 id "' + id + '" 非法（非空，禁路径分隔 / ..）');
  }
}

function readMeta(dataRoot: string, id: string): SingleMeta | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(metaFileOf(dataRoot, id), 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = raw as Partial<SingleMeta>;
    return {
      id,
      ...(typeof m.agentId === 'string' ? { agentId: m.agentId } : {}),
      ...(typeof m.title === 'string' ? { title: m.title } : {}),
      ...(typeof m.workspaceId === 'string' ? { workspaceId: m.workspaceId } : {}),
      status: m.status === 'archived' ? 'archived' : 'active',
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function writeMeta(dataRoot: string, meta: SingleMeta): void {
  const dir = dirOf(dataRoot, meta.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = metaFileOf(dataRoot, meta.id);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** 账本摘要（无 session.json 的存量会话按行派生——agentId / title / 末行时刻 / 行数） */
function ledgerSummary(dataRoot: string, id: string): {
  agentId?: string; title?: string; lastActivity?: string; count: number;
} {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dirOf(dataRoot, id), 'messages.jsonl'), 'utf-8');
  } catch {
    return { count: 0 };
  }
  let agentId: string | undefined;
  let title: string | undefined;
  let lastActivity: string | undefined;
  let count = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (row.type === 'session-header') continue;
    count += 1;
    if (typeof row.timestamp === 'string') lastActivity = row.timestamp;
    // agentId = 对端（user 投影账本里自己的行 agent_id 恒 'user'——跳过）
    if (typeof row.agent_id === 'string' && row.agent_id !== '' && row.agent_id !== 'user' && agentId === undefined) {
      agentId = row.agent_id;
    }
    if (title === undefined && typeof row.content === 'string' && row.content.trim() !== '') {
      const firstLine = row.content.trim().split('\n')[0] ?? '';
      title = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
    }
  }
  return { ...(agentId !== undefined ? { agentId } : {}), ...(title !== undefined ? { title } : {}), ...(lastActivity !== undefined ? { lastActivity } : {}), count };
}

/** 视图组装（list / 变更回执共源） */
function viewOf(dataRoot: string, id: string, conv: ConvSettingsFace | undefined): SingleView | null {
  const meta = readMeta(dataRoot, id);
  const summary = ledgerSummary(dataRoot, id);
  if (meta === null && summary.count === 0) return null;
  let iso = meta?.updatedAt ?? new Date(0).toISOString();
  try { iso = fs.statSync(dirOf(dataRoot, id)).mtime.toISOString(); } catch { /* 目录缺席：用元数据时刻 */ }
  const model = conv?.get(id).model;
  const title = meta?.title ?? summary.title;
  const agentId = meta?.agentId ?? summary.agentId;
  return {
    id,
    agentId: agentId ?? '',
    ...(model !== undefined ? { model } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(meta?.workspaceId !== undefined ? { workspaceId: meta.workspaceId } : {}),
    status: meta?.status ?? 'active',
    createdAt: meta?.createdAt ?? iso,
    updatedAt: meta?.updatedAt ?? iso,
    // lastActivity 仅在有消息时携带（主线 ac-singles 同义：无消息空会话
    // 不带该键——前端 isSingleFresh 据此呈现新会话开场居中态，创建时刻
    // 兜底会把空会话钉成「非开场」形态，cr-601）
    ...(summary.lastActivity !== undefined ? { lastActivity: summary.lastActivity } : {}),
  };
}

/** 全部会话 id（端点目录 + 元数据并存——目录即身份） */
function listIds(dataRoot: string): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(sessionsDir(dataRoot), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function obj(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' ? params as Record<string, unknown> : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error('参数 ' + key + ' 缺失或非非空字符串');
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * 宿主独立会话行。写者单源 = 宿主（UserStub 写同类目录的 messages.jsonl；
 * 本行写 session.json——同目录不同文件，各自 owning）。
 */
export function makeSinglesHostRow(options: SinglesHostRowOptions): Plugin {
  return {
    name: 'ac-host-rows/singles',
    inject: ['webServer'],
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;
      const web = ctx.webServer as unknown as WebFace;
      const conv = (): ConvSettingsFace | undefined => ctx.get('convSettings') as ConvSettingsFace | undefined;
      const emit = (view: SingleView, kind: 'created' | 'updated' | 'archived' | 'removed'): void => {
        web.broadcast('singles/updated', { args: [view, kind] });
      };

      web.registerRpc('singles/list', () => {
        const out: SingleView[] = [];
        for (const id of listIds(dataRoot)) {
          const view = viewOf(dataRoot, id, conv());
          if (view !== null && view.status === 'active') out.push(view);
        }
        return { singles: out };
      });

      web.registerRpc('singles/create', (params) => {
        const p = obj(params);
        const agentId = optStr(p.agentId);
        if (agentId !== undefined && readAgentConfig(dataRoot, agentId) === null) {
          throw new Error('Agent 不存在：' + agentId);
        }
        // reuse：复用同 Agent 的空会话（列表「新增」不刷屏——主线同义）
        if (p.reuse === true) {
          for (const id of listIds(dataRoot)) {
            const view = viewOf(dataRoot, id, conv());
            if (view === null || view.status !== 'active') continue;
            if (agentId !== undefined && view.agentId !== agentId) continue;
            if (ledgerSummary(dataRoot, id).count === 0) return { single: view, reused: true };
          }
        }
        const id = issueConversationId();
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(optStr(p.title) !== undefined ? { title: optStr(p.title)!.slice(0, TITLE_MAX_LEN) } : {}),
          ...(optStr(p.workspaceId) !== undefined ? { workspaceId: optStr(p.workspaceId)! } : {}),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        writeMeta(dataRoot, meta);
        const model = optStr(p.model);
        if (model !== undefined) conv()?.set(id, { model });
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话创建失败：' + id);
        emit(view, 'created');
        return { single: view };
      });

      web.registerRpc('singles/update', (params) => {
        const p = obj(params);
        const id = reqStr(p, 'id');
        assertId(id);
        const before = viewOf(dataRoot, id, conv());
        if (before === null) throw new Error('会话不存在：' + id);
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id,
          ...(before.agentId !== '' ? { agentId: before.agentId } : {}),
          ...(before.title !== undefined ? { title: before.title } : {}),
          ...(before.workspaceId !== undefined ? { workspaceId: before.workspaceId } : {}),
          status: before.status,
          createdAt: before.createdAt,
          updatedAt: now,
        };
        // agentId：'' = 清空待选；已有消息时拒绝（换 Agent = 换上下文——主线 409 语义）
        if (p.agentId !== undefined) {
          const next = String(p.agentId);
          if (next === '') {
            if (ledgerSummary(dataRoot, id).count > 0) throw new Error('会话已有消息，不能清空 Agent');
            delete meta.agentId;
          } else {
            if (readAgentConfig(dataRoot, next) === null) throw new Error('Agent 不存在：' + next);
            meta.agentId = next;
          }
        }
        if (p.title !== undefined) {
          const title = String(p.title).trim();
          if (title === '') delete meta.title;
          else meta.title = title.slice(0, TITLE_MAX_LEN);
        }
        if (p.workspaceId !== undefined) {
          const ws = String(p.workspaceId).trim();
          if (ws === '') delete meta.workspaceId;
          else meta.workspaceId = ws;
        }
        writeMeta(dataRoot, meta);
        // 模型覆盖：undefined = 不变 / null = 清除 / 字符串 = 设（D12 单源）
        if (p.model !== undefined) {
          const service = conv();
          if (service === undefined) throw new Error('convSettings 服务未装配——模型覆盖不可用');
          service.set(id, { model: p.model === null ? null : String(p.model) });
        }
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话读取失败：' + id);
        emit(view, 'updated');
        return { single: view };
      });

      web.registerRpc('singles/fork', (params) => {
        const p = obj(params);
        const id = reqStr(p, 'id');
        assertId(id);
        const from = viewOf(dataRoot, id, conv());
        if (from === null) throw new Error('会话不存在：' + id);
        const nextId = issueConversationId();
        const anchor = optStr(p.anchorMessageId);
        const nextDir = dirOf(dataRoot, nextId);
        forkConversation(dirOf(dataRoot, id), nextDir, anchor);
        const now = new Date().toISOString();
        const meta: SingleMeta = {
          id: nextId,
          ...(from.agentId !== '' ? { agentId: from.agentId } : {}),
          ...(from.title !== undefined ? { title: from.title } : {}),
          ...(from.workspaceId !== undefined ? { workspaceId: from.workspaceId } : {}),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        writeMeta(dataRoot, meta);
        if (from.model !== undefined) conv()?.set(nextId, { model: from.model });
        const view = viewOf(dataRoot, nextId, conv());
        if (view === null) throw new Error('会话分支创建失败：' + nextId);
        emit({ ...view, lastActivity: now }, 'created');
        return { single: view };
      });

      web.registerRpc('singles/archive', (params) => {
        const id = reqStr(obj(params), 'id');
        assertId(id);
        const before = viewOf(dataRoot, id, conv());
        if (before === null) throw new Error('会话不存在：' + id);
        const meta: SingleMeta = {
          id,
          ...(before.agentId !== '' ? { agentId: before.agentId } : {}),
          ...(before.title !== undefined ? { title: before.title } : {}),
          ...(before.workspaceId !== undefined ? { workspaceId: before.workspaceId } : {}),
          status: 'archived',
          createdAt: before.createdAt,
          updatedAt: new Date().toISOString(),
        };
        writeMeta(dataRoot, meta);
        const view = viewOf(dataRoot, id, conv());
        if (view === null) throw new Error('会话读取失败：' + id);
        emit(view, 'archived');
        return { single: view };
      });

      // 硬删：会话账本（user 投影 + 各 agent 域）+ 元数据 + 模型覆盖，一并清
      web.registerRpc('singles/delete', (params) => {
        const id = reqStr(obj(params), 'id');
        assertId(id);
        const before = viewOf(dataRoot, id, conv());
        for (const dir of conversationDirs(dataRoot, id)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        fs.rmSync(dirOf(dataRoot, id), { recursive: true, force: true });
        conv()?.set(id, { model: null });
        emit(before ?? { id, agentId: '', status: 'archived', createdAt: '', updatedAt: '' }, 'removed');
        return { deleted: true };
      });

    },
  };
}
