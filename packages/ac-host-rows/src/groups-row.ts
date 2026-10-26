// ============================================================
// groups-row.ts —— 宿主群存储行（cr-576）
//
// owns：groups/<gid>/group.json（GroupConfig：成员表 + 名称/简介）。
// 会话内容不在本行——群消息经**信封扇出**直达各成员的 agent 域账本
//（agents/<m>/sessions/<gid>~<m>/messages.jsonl——成员流键 gid~<m>，
// 与主线 memberStreamKey 同形）；group/history = 全成员流合并去重。
//
// RPC 面与主线 ac-web-api 同形（前端零改动）：
//   group/list | create | delete | join | leave | rename | set-description
//   | send（信封扇出）| history（成员流合并）
// 帧广播：group/created|deleted|renamed|description-set|member-added|
//   member-removed（列表刷新）+ group/message-posted（活跃时间 bump）。
//
// 邮局 uuid 登记（R-1）：成员流是多发送方会话（任一成员/user 都可能是
// sender）——本行在群变更时按全名册（members ∪ user）预登记每条成员流，
// registry 子集一致校验（cr-576）放行参与方发言/回信、仍拦集外冒用。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, Context } from '@agentchat/cordis';
import { issueRequestId, makeEnvelope } from 'ac-envelope-core';
import { readLedger, LedgerWriter, sessionDir, type LedgerRow } from 'ac-ledger';
import { readAgentConfig } from 'ac-agents-core';
import type { PostOffice } from 'ac-post-office';

export interface GroupsHostRowOptions {
  dataRoot: string;
  /** 邮局（group/send 扇出面 + 成员流预登记）；缺席 = send/预登记 fail-loud */
  postOffice?: PostOffice;
}

/** 群配置（group.json 形态——主线 GroupConfig 同形） */
export interface GroupConfig {
  id: string;
  name: string;
  members: string[];
  description?: string;
  createdAt: number;
}

/** 群消息记录（group/history 行——主线 GroupMessageRecord 展示面同形） */
export interface GroupMessageView {
  id: string;
  groupId: string;
  from: string;
  content: string;
  at: number;
}

interface WebFace {
  registerRpc(method: string, handler: (params: unknown) => unknown): void;
  broadcast(type: string, data?: unknown): void;
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

function groupDir(dataRoot: string, gid: string): string {
  return path.join(dataRoot, 'groups', gid);
}

function assertGid(gid: string): void {
  // 主线同规：禁 ~（成员流键分隔）/ 路径分隔 / .. / 空白——与对键桶隔离
  if (gid === '' || gid.includes('~') || gid.includes('/') || gid.includes('\\') || gid.includes('..') || /\s/.test(gid)) {
    throw new Error('群 id "' + gid + '" 非法（非空，禁 ~ / 路径分隔 / .. / 空白）');
  }
}

function readConfig(dataRoot: string, gid: string): GroupConfig | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(groupDir(dataRoot, gid), 'group.json'), 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const g = raw as Partial<GroupConfig>;
    if (typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.members)) return null;
    return {
      id: g.id,
      name: g.name,
      members: g.members.filter((m): m is string => typeof m === 'string'),
      ...(typeof g.description === 'string' ? { description: g.description } : {}),
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0,
    };
  } catch {
    return null;
  }
}

function writeConfig(dataRoot: string, group: GroupConfig): void {
  const dir = groupDir(dataRoot, group.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'group.json');
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(group, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function listGroupIds(dataRoot: string): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(dataRoot, 'groups'), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** 全群配置扫描（groups/<gid>/group.json；坏文件跳过）——runs/snapshot 群面数据源 */
export function listGroupConfigs(dataRoot: string): GroupConfig[] {
  return listGroupIds(dataRoot)
    .map((gid) => readConfig(dataRoot, gid))
    .filter((g): g is GroupConfig => g !== null);
}

/** 成员流键（主线 memberStreamKey 同形：gid~member） */
export function memberStreamKey(gid: string, member: string): string {
  return gid + '~' + member;
}

/**
 * 入群种子（主线 seedMemberStream 语义）：既有群内容投影进新成员私有流——
 * 读面 = 全成员流合并（group/history 同源 requestId 去重、时间升序），写面 =
 * LedgerWriter.deliver（宿主侧直写，首建目录 + 头行）。行保留原 requestId：
 * 幂等键随行迁移，后续同 requestId 真实扇出在同一文件被准入短路（不重写）。
 * 删除窗防御（主线同款）：每行落盘前复查群仍在——群删即中止种子。
 */
async function seedMemberStream(dataRoot: string, group: GroupConfig, member: string): Promise<void> {
  const key = memberStreamKey(group.id, member);
  const byKey = new Map<string, LedgerRow>();
  for (const m of group.members) {
    if (m === member) continue;
    const { rows } = readLedger(path.join(dataRoot, 'agents', m, 'sessions', memberStreamKey(group.id, m)));
    for (const r of rows) {
      const k = r.requestId ?? m + ':' + r.message_id;
      if (!byKey.has(k)) byKey.set(k, r);
    }
  }
  const merged = [...byKey.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const writer = new LedgerWriter(sessionDir(dataRoot, member, key), { participants: [member, 'user'], kind: 'group' });
  for (const r of merged) {
    if (readConfig(dataRoot, group.id) === null) return; // 删除窗：种子中止
    await writer.deliver({
      role: r.role,
      content: r.content,
      agent_id: r.agent_id,
      ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
      uuid: key,
    });
  }
}

/**
 * 宿主群存储行。成员流内容 = 各成员 agent 域账本（信封扇出写入），
 * 本行只拥有成员表与扇出面。
 */
export function makeGroupsHostRow(options: GroupsHostRowOptions): Plugin {
  return {
    name: 'ac-host-rows/groups',
    inject: ['webServer'],
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;
      const web = ctx.webServer as unknown as WebFace;
      const emit = (type: string, ...args: unknown[]): void => {
        web.broadcast(type, { args });
      };

      const mustGroup = (gid: string): GroupConfig => {
        const group = readConfig(dataRoot, gid);
        if (group === null) throw new Error('群不存在：' + gid);
        return group;
      };

      /** 成员流 uuid 预登记（R-1 多发送方：全名册 ∪ user；群变更时全量重放） */
      const syncRegistry = (group: GroupConfig): void => {
        if (options.postOffice === undefined) return;
        const roster = [...new Set(['user', ...group.members])];
        for (const m of group.members) {
          options.postOffice.registry.register(memberStreamKey(group.id, m), roster);
        }
      };

      // boot 期预登记既有群（宿主重启后 registry 内存态重建）
      for (const gid of listGroupIds(dataRoot)) {
        const group = readConfig(dataRoot, gid);
        if (group !== null) syncRegistry(group);
      }

      web.registerRpc('group/list', () => ({
        groups: listGroupIds(dataRoot)
          .map((gid) => readConfig(dataRoot, gid))
          .filter((g): g is GroupConfig => g !== null),
      }));

      web.registerRpc('group/create', (params) => {
        const p = obj(params);
        const id = optStr(p.id) ?? 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        assertGid(id);
        const members = Array.isArray(p.members) ? p.members.map(String) : [];
        // 双向名册校验（主线同规）：成员须已注册；群 id 不得撞已注册 Agent
        //（成员流键 gid~member 会与 1v1 对键桶撞形）
        if (readAgentConfig(dataRoot, id) !== null) {
          throw new Error('群 id "' + id + '" 与已注册 Agent 同名（成员流键会与 1v1 对桶撞形）');
        }
        for (const m of members) {
          if (readAgentConfig(dataRoot, m) === null) throw new Error('成员 "' + m + '" 未注册为 Agent');
        }
        if (readConfig(dataRoot, id) !== null) throw new Error('群 "' + id + '" 已存在');
        const group: GroupConfig = {
          id,
          name: reqStr(p, 'name'),
          members: [...new Set(members)],
          ...(optStr(p.description) !== undefined ? { description: optStr(p.description)! } : {}),
          createdAt: Date.now(),
        };
        writeConfig(dataRoot, group);
        syncRegistry(group);
        emit('group/created', group);
        return { group };
      });

      web.registerRpc('group/delete', (params) => {
        const gid = reqStr(obj(params), 'groupId');
        const group = readConfig(dataRoot, gid);
        if (group === null) return { deleted: false };
        // 成员流内容（agent 域账本目录）一并清
        for (const m of group.members) {
          fs.rmSync(path.join(dataRoot, 'agents', m, 'sessions', memberStreamKey(gid, m)), { recursive: true, force: true });
        }
        fs.rmSync(groupDir(dataRoot, gid), { recursive: true, force: true });
        emit('group/deleted', gid, group);
        return { deleted: true };
      });

      web.registerRpc('group/join', (params) => {
        const p = obj(params);
        const gid = reqStr(p, 'groupId');
        const agentId = reqStr(p, 'agentId');
        const group = mustGroup(gid);
        if (readAgentConfig(dataRoot, agentId) === null) throw new Error('成员 "' + agentId + '" 未注册为 Agent');
        if (group.members.includes(agentId)) return { joined: true };
        group.members.push(agentId);
        writeConfig(dataRoot, group);
        syncRegistry(group);
        // 入群种子（fire-and-forget——主线同款异步面）：既有群内容投影进新成员流
        void seedMemberStream(dataRoot, group, agentId).catch((err: unknown) => {
          process.stderr.write('[groups] 入群种子失败（' + gid + '/' + agentId + '）：' + String(err) + '\n');
        });
        emit('group/member-added', gid, agentId, group);
        return { joined: true };
      });

      web.registerRpc('group/leave', (params) => {
        const p = obj(params);
        const gid = reqStr(p, 'groupId');
        const agentId = reqStr(p, 'agentId');
        const group = mustGroup(gid);
        const at = group.members.indexOf(agentId);
        if (at < 0) return { left: false };
        group.members.splice(at, 1);
        writeConfig(dataRoot, group);
        // 该成员的流内容一并清（registry 预登记为内存态超集——无注销面，
        // 子集校验天然放行残留名册内的合法来信）
        fs.rmSync(path.join(dataRoot, 'agents', agentId, 'sessions', memberStreamKey(gid, agentId)), { recursive: true, force: true });
        emit('group/member-removed', gid, agentId, group);
        return { left: true };
      });

      web.registerRpc('group/rename', (params) => {
        const p = obj(params);
        const group = mustGroup(reqStr(p, 'groupId'));
        group.name = reqStr(p, 'name');
        writeConfig(dataRoot, group);
        emit('group/renamed', group.id, group.name, group);
        return { renamed: true };
      });

      // 群简介：description 省略/空 = 清空（主线同口径）
      web.registerRpc('group/set-description', (params) => {
        const p = obj(params);
        const group = mustGroup(reqStr(p, 'groupId'));
        const description = optStr(p.description);
        if (description === undefined) delete group.description;
        else group.description = description;
        writeConfig(dataRoot, group);
        emit('group/description-set', group.id, group.description, group);
        return { descriptionSet: true };
      });

      // 群消息投递（trigger 语义——受理即返回，参与者 run 后台进行）：
      // 信封扇出到除发送者外的全部成员（各自成员流 = 自己的串行化门）；
      // 不可达成员走发件箱滞留 + ensureHook 拉壳转投（协议 D2）。
      web.registerRpc('group/send', async (params) => {
        const p = obj(params);
        const gid = reqStr(p, 'groupId');
        const from = reqStr(p, 'from');
        const content = reqStr(p, 'content');
        const group = mustGroup(gid);
        if (from !== 'user' && !group.members.includes(from)) {
          throw new Error('发送者 "' + from + '" 不在群内（user 保留端点或成员 Agent）');
        }
        const po = options.postOffice;
        if (po === undefined) throw new Error('邮局未装配——group/send 扇出面不可用');
        const requestId = 'g-' + issueRequestId();
        const triggered: string[] = [];
        for (const member of group.members) {
          if (member === from) continue;
          await po.dispatch(makeEnvelope({
            uuid: memberStreamKey(gid, member),
            requestId,
            sender: from,
            to: member,
            payload: { text: content },
          }));
          triggered.push(member);
        }
        const message: GroupMessageView = { id: requestId, groupId: gid, from, content, at: Date.now() };
        emit('group/message-posted', gid);
        return { message, triggered };
      });

      // 群会话账本读面：全成员流合并（入站行跨流同 requestId 去重；成员
      // 终稿只落自己流），时间升序 + 尾部 limit/offset 分页（session/history 同义）
      web.registerRpc('group/history', (params) => {
        const p = obj(params);
        const gid = reqStr(p, 'groupId');
        const group = mustGroup(gid);
        const byKey = new Map<string, GroupMessageView>();
        for (const m of group.members) {
          const { rows } = readLedger(path.join(dataRoot, 'agents', m, 'sessions', memberStreamKey(gid, m)));
          for (const r of rows) {
            const key = r.requestId ?? m + ':' + r.message_id;
            if (byKey.has(key)) continue;
            byKey.set(key, {
              id: key,
              groupId: gid,
              from: r.agent_id,
              content: r.content,
              at: Date.parse(r.timestamp) || 0,
            });
          }
        }
        const all = [...byKey.values()].sort((a, b) => a.at - b.at);
        const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : 50;
        const offset = typeof p.offset === 'number' && p.offset >= 0 ? Math.floor(p.offset) : 0;
        return {
          groupId: gid,
          messages: all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset)),
        };
      });
    },
  };
}
