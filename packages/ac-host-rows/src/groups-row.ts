// ============================================================
// groups-row.ts —— 宿主群存储行（cr-576）
//
// owns：meta/groups/<gid>/group.json（GroupConfig：成员表 + 名称/简介——数据
// 分层第二层；读面兼容窗回落旧位置 groups/<gid>/group.json）。
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
import { normalizeAttachments, readLedger, LedgerWriter, sessionDir, type LedgerAttachment, type LedgerRow } from 'ac-ledger';
import { readAgentConfig } from 'ac-agents-core';
import { SnapshotStore } from 'ac-file-snapshots/src/store.ts';
import type { PostOffice } from 'ac-post-office';
// 群配置纯读面（cr-712 下沉 ac-core-utils：壳侧 group 垫片共用读词汇——
// 垫片 import 本包即壳→宿主反向依赖；本行改为单源消费，写面仍在下方）
import {
  assertGid, bumpUnread, clearUnread, listGroupConfigs, memberStreamKey, readGroupConfig, writeGroupConfig,
  type GroupConfig,
} from 'ac-core-utils';

export type { GroupConfig } from 'ac-core-utils';

export interface GroupsHostRowOptions {
  dataRoot: string;
  /** 邮局（group/send 扇出面 + 成员流预登记）；缺席 = send/预登记 fail-loud */
  postOffice?: PostOffice;
}

/** 群消息记录（group/history 行——主线 GroupMessageRecord 展示面同形） */
export interface GroupMessageView {
  id: string;
  groupId: string;
  from: string;
  content: string;
  at: number;
  /** 多模态附件引用（cr-1278：群输入图片——刷新后 chips 恢复与回放旁路同源） */
  attachments?: LedgerAttachment[];
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

/** 群目录（数据分层第二层：meta/groups/<gid>/——删除面用；写口已下沉
 *  ac-core-utils.writeGroupConfig 单源，读面兼容窗回落旧位置 groups/<gid>/） */
function groupDir(dataRoot: string, gid: string): string {
  return path.join(dataRoot, 'meta', 'groups', gid);
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
    if (readGroupConfig(dataRoot, group.id) === null) return; // 删除窗：种子中止
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
      // 会话快照纯库实例（cr-1208 级联：群删除/退群 RPC 同数据根直清——与
      // ac-host-webui face-ops 读面同一 owning 实现，无服务依赖）
      const snapshots = new SnapshotStore({ root: path.join(dataRoot, 'file-snapshots') });
      const emit = (type: string, ...args: unknown[]): void => {
        web.broadcast(type, { args });
      };

      const mustGroup = (gid: string): GroupConfig => {
        const group = readGroupConfig(dataRoot, gid);
        if (group === null) throw new Error('群不存在：' + gid);
        return group;
      };

      /** 成员流 uuid 预登记（R-1 多发送方：全名册 ∪ user；群变更时全量重放）。
       *  cr-1213：改走 setRoster（authoritative 注入）——名册演化无条件覆盖，
       *  boot 窗口键形反演的临时误登（群流键与 1v1 键同形）由重放矫正。 */
      const syncRegistry = (group: GroupConfig): void => {
        if (options.postOffice === undefined) return;
        const roster = [...new Set(['user', ...group.members])];
        for (const m of group.members) {
          options.postOffice.registry.setRoster(memberStreamKey(group.id, m), roster);
        }
      };

      // boot 期预登记既有群（宿主重启后 registry 内存态重建）。cr-1226/
      // ISSUE-19：装载量显性化——静默空窗（注册表 0 条但磁盘有群）此前
      // 只能从 Agent 侧「list_groups count=0」倒推，宿主日志无痕。空装载
      // warn 级（磁盘目录在而配置读不出 = 迁移/损坏嫌疑），非空 info 级。
      const bootGroups = listGroupConfigs(dataRoot);
      for (const group of bootGroups) {
        syncRegistry(group);
      }
      if (bootGroups.length > 0) {
        ctx.logger.info(`[groups] 群注册表装载 ${bootGroups.length} 条：${bootGroups.map((g) => g.id).join('、')}`);
      } else {
        const metaDir = path.join(dataRoot, 'meta', 'groups');
        let dirCount = 0;
        try { dirCount = fs.readdirSync(metaDir).length; } catch { /* 目录不存在 = 真无群 */ }
        ctx.logger.warn(`[groups] 群注册表装载 0 条${dirCount > 0 ? `（meta/groups 下有 ${dirCount} 个目录但无有效 group.json——疑似损坏/迁移中断，请核查）` : '（无群配置——正常）'}`);
      }

      web.registerRpc('group/list', () => ({
        groups: listGroupConfigs(dataRoot),
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
        if (readGroupConfig(dataRoot, id) !== null) throw new Error('群 "' + id + '" 已存在');
        const group: GroupConfig = {
          id,
          name: reqStr(p, 'name'),
          members: [...new Set(members)],
          ...(optStr(p.description) !== undefined ? { description: optStr(p.description)! } : {}),
          createdAt: Date.now(),
        };
        writeGroupConfig(dataRoot, group);
        syncRegistry(group);
        emit('group/created', group);
        return { group };
      });

      web.registerRpc('group/delete', (params) => {
        const gid = reqStr(obj(params), 'groupId');
        const group = readGroupConfig(dataRoot, gid);
        if (group === null) return { deleted: false };
        // 成员流内容（agent 域账本目录）一并清
        for (const m of group.members) {
          fs.rmSync(path.join(dataRoot, 'agents', m, 'sessions', memberStreamKey(gid, m)), { recursive: true, force: true });
        }
        fs.rmSync(groupDir(dataRoot, gid), { recursive: true, force: true });
        // 兼容窗旧位置残留一并摘除（防旧 group.json 复活已删群）
        fs.rmSync(path.join(dataRoot, 'groups', gid), { recursive: true, force: true });
        // 未读计数连带清（cr-1184）：群已解散，gid 轴滞留计数 = 僵尸徽章
        clearUnread(dataRoot, gid);
        // 成员流快照连带清（cr-1208）：级联口归位删除 RPC——壳内事件订阅
        // 跨进程不可达（cr-376 死接线），同进程直清本体 + 各成员流键。
        snapshots.dropConversation(gid);
        for (const m of group.members) snapshots.dropConversation(memberStreamKey(gid, m));
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
        writeGroupConfig(dataRoot, group);
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
        writeGroupConfig(dataRoot, group);
        // 该成员的流内容一并清（registry 内存态由群行 boot/变更重放维护——
        // cr-1213 起名册权威归 setRoster 注入，无注销面）
        fs.rmSync(path.join(dataRoot, 'agents', agentId, 'sessions', memberStreamKey(gid, agentId)), { recursive: true, force: true });
        // 成员流快照连带清（cr-1208——与流内容同生命周期）
        snapshots.dropConversation(memberStreamKey(gid, agentId));
        emit('group/member-removed', gid, agentId, group);
        return { left: true };
      });

      web.registerRpc('group/rename', (params) => {
        const p = obj(params);
        const group = mustGroup(reqStr(p, 'groupId'));
        group.name = reqStr(p, 'name');
        writeGroupConfig(dataRoot, group);
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
        writeGroupConfig(dataRoot, group);
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
        // 多模态附件旁路（cr-1278）：群发图片随信封扇出到各成员流——
        // 壳侧入站行落账即模型可见（与直答 deliver 同口径窄化）
        const attachments = normalizeAttachments(p.attachments);
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
            // broadcast 标记（cr-1291 群刷屏根修——对齐壳侧 GroupShim.send）：
            // 收信方终稿只落自己成员流、不回投发送方（replyTargetOf 切断 R-2）。
            // 缺标记时群回复被当 1v1 回信回投发送方——Agent 成员互答链式唤起
            // 刷屏（41+ run/2min 雪崩靠 budget 衰减才止血）。
            payload: { text: content, broadcast: true, ...(attachments !== undefined ? { attachments } : {}) },
          }));
          triggered.push(member);
        }
        const message: GroupMessageView = { id: requestId, groupId: gid, from, content, at: Date.now(), ...(attachments !== undefined ? { attachments } : {}) };
        emit('group/message-posted', gid, message);
        // cr-1157 群未读计数：成员发言（user 自己发的不计——本地已上屏）。
        // 幂等键 = 扇出 requestId；计数器纯库，行不依赖 webui。
        if (from !== 'user') bumpUnread(dataRoot, gid, requestId);
        return { message, triggered };
      });

      // 群会话账本读面：全成员流合并（入站行跨流同 requestId 去重；成员
      // 终稿只落自己流），时间升序 + 尾部 limit/offset 分页（session/history 同义）。
      //（cr-1152：cr-1146 首屏未读旁带已下线——读位权威源消费面待重设计。）
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
              ...(r.attachments !== undefined ? { attachments: r.attachments } : {}),
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
