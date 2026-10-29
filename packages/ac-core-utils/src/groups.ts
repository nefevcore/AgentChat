// ============================================================
// groups.ts —— 群配置纯读面（cr-712 从 ac-host-rows/groups-row 下沉）
//
// 收录判据（index 头同款）：groups/<gid>/group.json 的读侧词汇现由
// 宿主 groups 行与壳侧 group 垫片（ac-shell-rows shims）两处消费——
// 垫片若 import 宿主行包即壳→宿主反向依赖，随 owning 行导出必成环，
// 故下沉纯库（memberStreamKey/GROUP_HINT_META 先例）。写面（writeConfig/
// 扇出/RPC）仍归宿主 groups 行——本库只收「会成环的那一小块」。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 群聊行为契约（M26 主线验证有效——cr-712 自退役 src/ac-group 单源
 * 复活，文案冻结：修改需过真实群沉默率/回复质量验收）。经 loop/
 * before-run 注入群会话 run 的决策点：成员被群消息唤起后，回复走
 * send_group 主动发言（直接输出文本不送达群聊）；回声由本契约调控
 * （无话可说保持沉默、不刷屏）。per-Agent 覆盖：settings['group']
 * .contractText（消费方 collab-tools contractFor 同主线语义）。
 */
export const GROUP_CONTRACT_TEXT =
  '收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。若是工作任务，请先在群内讨论、定下分工再动手——未经协调各自为战会造成重复劳动。';

/** 群配置（group.json 形态——宿主 groups 行写面同形） */
export interface GroupConfig {
  id: string;
  name: string;
  members: string[];
  description?: string;
  createdAt: number;
}

export function assertGid(gid: string): void {
  // 主线同规：禁 ~（成员流键分隔）/ 路径分隔 / .. / 空白——与对键桶隔离
  if (gid === '' || gid.includes('~') || gid.includes('/') || gid.includes('\\') || gid.includes('..') || /\s/.test(gid)) {
    throw new Error('群 id "' + gid + '" 非法（非空，禁 ~ / 路径分隔 / .. / 空白）');
  }
}

export function readGroupConfig(dataRoot: string, gid: string): GroupConfig | null {
  assertGid(gid);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dataRoot, 'groups', gid, 'group.json'), 'utf-8'));
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

/** 全群配置扫描（groups/<gid>/group.json；坏文件跳过）——宿主 runs/snapshot
 * 与壳侧 list_groups 共用数据源 */
export function listGroupConfigs(dataRoot: string): GroupConfig[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(dataRoot, 'groups'), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readGroupConfig(dataRoot, e.name))
    .filter((g): g is GroupConfig => g !== null);
}
