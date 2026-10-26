// ============================================================
// ac-host-rows —— 宿主行导入装配（8.8 第一批 cr-537；usage 行 cr-538；
// 身份编辑面 cr-540）
//
// 主线「沿用」宿主行从 src/ 导入 preview 宿主树（行集清单 R1）：
//   id → cordis Plugin 映射（import 行包 namespace）+ 数据根行 options。
// 与壳侧 ac-shell-rows 同款接缝纪律：宿主无主线服务面（agents/
// agentStore/session 等注册表），改造行后续批按依赖落地情况导入。
//
// 第一批形态（零改动导入——七行全无主线宿主服务硬依赖）：
//   · logger-console / timer = vendor 基座行（cordis-logger/timer）
//   · config / event-policy = 零 inject 基座与治理行
//   · remote-link / ws-bridge = 仅 inject ['webServer'] 传输行
//   · backup = 纯库 owning 行（root options 锚数据根）
// ============================================================
import type { Plugin, Context } from '@agentchat/cordis';
import ConsoleExporter from '@agentchat/cordis-logger';
import { TimerService } from '@agentchat/cordis-timer';
import * as configRow from 'ac-config';
import * as convSettingsRow from 'ac-conv-settings';
import * as eventPolicyRow from 'ac-event-policy';
import * as remoteLinkRow from 'ac-remote-link';
import * as backupRow from 'ac-backup';
import * as wsBridgeRow from 'ac-ws-bridge';
import * as pluginMarketRow from 'ac-plugin-market';
import type { ConfigRowOptions } from 'ac-config';
import type { BackupRowOptions } from 'ac-backup';
import type { WsBridgeRowOptions } from 'ac-ws-bridge';

/** 可导入行 id → cordis Plugin（宿主树零改动行） */
export const IMPORTED_ROWS: Record<string, Plugin> = {
  'logger-console': ConsoleExporter as unknown as Plugin,
  'timer': { name: 'cordis-timer', apply(ctx: Context) { ctx.plugin(TimerService); } },
  'config': configRow as unknown as Plugin,
  // 会话级覆盖（cr-565 改树入宿主）：写面单源 = 宿主 web RPC（设置面板/
  // 输入框模型菜单），壳经 convSettings 垫片只读直取（harness-tools 注册面）
  'conv-settings': convSettingsRow as unknown as Plugin,
  'event-policy': eventPolicyRow as unknown as Plugin,
  'remote-link': remoteLinkRow as unknown as Plugin,
  'backup': backupRow as unknown as Plugin,
  'ws-bridge': wsBridgeRow as unknown as Plugin,
  // plugin-market 沿用（cr-543）：inject ['webServer','pluginRegistry'] ——
  // 两服务同树（宿主单树装配）才激活；市场安装流 = staging 人审入口，
  // 装载裁决归 plugin-registry 行（本行零改动导入）
  'plugin-market': pluginMarketRow as unknown as Plugin,
};

/** 数据根锚定的行 options（宿主 boot 组装——数据根隔离红线：显式注入不走环境缺省） */
export interface HostRowOptions {
  dataRoot: string;
  /** 邮局（usage 等宿主自有形态行的事件信收信面——cr-538） */
  postOffice?: unknown;
  /** 内置模板目录（preset-builtin 行在集时注入——agents 编辑面模板面；cr-540） */
  templatesDir?: string;
  /** 行集目录（plugin-registry 行偏好视图 + 插件行撞名对账；cr-543） */
  catalogFile?: string;
  /** host 端点收信扇出面（usage/auth-registry 行共用——boot 建 HostInbox 注入；cr-545） */
  inbox?: HostInbox;
  /** agents 编辑面（timers 行 entries 单写者收口注入——cr-551） */
  agentsEdit?: EntriesEditFace;
}

/**
 * 行 id → options 工厂（数据根锚定行）。基座行（logger/timer/event-policy/
 * remote-link/ws-bridge）无数据根语义，缺省条目缺席。
 */
// —— 宿主自有形态行（options 工厂装配——cr-538 usage 首行；cr-539 timers）——

import { makeUsageHostRow } from './usage-row.ts';
export { makeUsageHostRow };
export type { UsageHostRowOptions } from './usage-row.ts';

import { makeTimersHostRow, HostTimersService, GLOBAL_TIMER_OWNER, validateTimerEntries } from './timers-row.ts';
import type { EntriesEditFace } from './timers-row.ts';
export { makeTimersHostRow, HostTimersService, GLOBAL_TIMER_OWNER, validateTimerEntries };
export type { TimersHostRowOptions, EntriesEditFace } from './timers-row.ts';

// —— 身份编辑面（cr-540）：agents 编辑面行（写口）+ preset-builtin 模板读面 ——
import { makeAgentsHostRow, AgentsEditService } from './agents-row.ts';
export { makeAgentsHostRow, AgentsEditService };
export { avatarPathOf, avatarContentType } from './agents-row.ts';
export type { AgentsHostRowOptions } from './agents-row.ts';
export { TEMPLATE_DIR, listTemplates, readTemplate } from './preset-builtin.ts';
export type { AgentTemplate } from './preset-builtin.ts';

// —— 写侧 RPC 编排（cr-542）：agent-admin 行（inject ['webServer','agents']——
// web 表面装配时随宿主单树 ctx 装；行集含 agent-admin 才挂，摘行 = 管理面下线）——
import { makeAgentAdminRow } from './agent-admin-row.ts';
export { makeAgentAdminRow };
export type { AgentsEditFace, AdminPreviewFace, AgentAdminRowOptions } from './agent-admin-row.ts';

// —— 授权注册表写者（cr-545）：auth-registry 行（grant 信受理 + 两层
// additive 写者 + 凭据写面 + F2 分立编辑面）+ HostInbox 收信扇出组合器 ——
import { makeAuthRegistryRow } from './auth-registry-row.ts';
import { HostInbox } from './host-inbox.ts';
export { makeAuthRegistryRow, HostInbox };
export type { AuthRegistryRowOptions } from './auth-registry-row.ts';

// —— 独立会话面（cr-566）：singles 行（session.json 元数据单写者 +
// singles/* RPC 六方法 + singles/updated 帧广播；模型覆盖仍走 conv-settings）——
import { makeSinglesHostRow } from './singles-row.ts';
export { makeSinglesHostRow };
export type { SinglesHostRowOptions, SingleMeta, SingleView } from './singles-row.ts';

// —— 群存储行（cr-576）：groups 行（groups/<gid>/group.json 成员表单写者 +
// group/* RPC 九方法 + 信封扇出 + 成员流合并读面）——
import { makeGroupsHostRow, listGroupConfigs, memberStreamKey } from './groups-row.ts';
export { makeGroupsHostRow, listGroupConfigs, memberStreamKey };
// 工作区登记表（cr-583）：纯函数直读直写（REST 编排住 web-api 行）
export { listWorkspaces, registerWorkspace, updateWorkspace, removeWorkspace, workspacePathOf } from './workspaces.ts';
export type { WorkspaceRegistration } from './workspaces.ts';
// 工作区文件面（cr-676）：树/预览/直链/上传纯函数（主线 ac-workspace 同语义；
// HTTP 四端点编排住 web-api 行）
export {
  MAX_PREVIEW_BYTES,
  agentWorkdirOf,
  conversationAgentId,
  conversationWorkspaceRoot,
  guessContentType,
  readWorkspaceFile,
  resolveWorkspaceFile,
  saveWorkspaceUpload,
  workspaceTree,
  workspaceTreeBase,
} from './workspace-files.ts';
export type {
  WorkspaceContext,
  WorkspaceFileResult,
  WorkspaceNode,
  WorkspaceTreeResult,
  WorkspaceUploadResult,
} from './workspace-files.ts';
export type { GroupsHostRowOptions, GroupConfig, GroupMessageView } from './groups-row.ts';

// —— 插件治理面（cr-543）：plugin-registry 行（装载裁决 + 熔断闸门 +
// 行集偏好急救 RPC + client manifest 注入——第三方代码零宿主驻留）——
import { makePluginRegistryRow, PluginRegistryHostService } from './plugin-registry-row.ts';
export { makePluginRegistryRow, PluginRegistryHostService };
export type { PluginRegistryHostRowOptions, PluginRowsView, HostRowsView, InstalledView } from './plugin-registry-row.ts';

/** 行 id → options 形工厂（宿主 boot 按 rowOptionsFor 产物分流装配） */
export const HOST_ROW_FACTORIES: Record<string, ((options: never) => Plugin) | undefined> = {
  usage: makeUsageHostRow as unknown as (options: never) => Plugin,
  timers: makeTimersHostRow as unknown as (options: never) => Plugin,
  agents: makeAgentsHostRow as unknown as (options: never) => Plugin,
  'plugin-registry': makePluginRegistryRow as unknown as (options: never) => Plugin,
  'auth-registry': makeAuthRegistryRow as unknown as (options: never) => Plugin,
  'agent-admin': makeAgentAdminRow as unknown as (options: never) => Plugin,
  'singles': makeSinglesHostRow as unknown as (options: never) => Plugin,
  'group': makeGroupsHostRow as unknown as (options: never) => Plugin,
} satisfies Record<string, ((options: never) => Plugin) | undefined>;

export function rowOptionsFor(opts: HostRowOptions): Record<string, unknown> {
  const configOptions: ConfigRowOptions = { root: opts.dataRoot };
  const backupOptions: BackupRowOptions = { root: opts.dataRoot };
  const wsBridgeOptions: WsBridgeRowOptions = {};
  // remote-link（cr-542 单树装配起 Active）：缺省 root = './data'——数据根隔离红线
  // 要求显式锚定（relay 静默待机，不连接）
  const out: Record<string, unknown> = {
    config: configOptions,
    // 会话级覆盖目录（conv-settings/<conversationId>.json——宿主单写）
    'conv-settings': { root: opts.dataRoot },
    // 独立会话元数据（viewer/sessions/<sid>/session.json——宿主单写）
    // + 标题请求收信面（cr-672：壳侧 auto-title 行生成 → 信封 → 本行落盘）
    singles: { dataRoot: opts.dataRoot, ...(opts.inbox !== undefined ? { inbox: opts.inbox } : {}) },
    backup: backupOptions,
    'ws-bridge': wsBridgeOptions,
    'remote-link': { root: opts.dataRoot },
  };
  // usage 行（cr-538 宿主自有形态）：UsageHostRowOptions = 数据根 + 收信扇出面
  if (opts.inbox !== undefined) {
    out.usage = { root: opts.dataRoot, inbox: opts.inbox };
  }
  if (opts.postOffice !== undefined) {
    // timers 行（cr-539）：数据根 + 邮局（唤醒信投递面）+ agents 编辑面
    //（cr-551 单写者收口——entries 写口单源；行集无 agents 行时缺省自带直读写）
    out.timers = opts.agentsEdit !== undefined
      ? { dataRoot: opts.dataRoot, postOffice: opts.postOffice, agentsEdit: opts.agentsEdit }
      : { dataRoot: opts.dataRoot, postOffice: opts.postOffice };
    // group 行（cr-576）：数据根 + 邮局（group/send 扇出 + 成员流预登记）
    out.group = { dataRoot: opts.dataRoot, postOffice: opts.postOffice };
  }
  // auth-registry 行（cr-545）：数据根 + HostInbox（收信扇出）+ 邮局（回执投递）
  if (opts.postOffice !== undefined && opts.inbox !== undefined) {
    out['auth-registry'] = { dataRoot: opts.dataRoot, inbox: opts.inbox, postOffice: opts.postOffice };
  }
  // agents 编辑面行（cr-540）：数据根 + 模板目录（preset-builtin 行在集才注入——
  // 缺席 = 模板面不可用，编辑面按良定义降级）
  // plugin-registry 行（cr-543）：数据根 + 行集目录（偏好视图/撞名对账）
  // + 装卸请求信受理面（cr-553：inbox 收信 + 邮局回执/续跑投递）
  out['plugin-registry'] = {
    dataRoot: opts.dataRoot,
    ...(opts.catalogFile !== undefined ? { catalogFile: opts.catalogFile } : {}),
    ...(opts.inbox !== undefined ? { inbox: opts.inbox } : {}),
    ...(opts.postOffice !== undefined ? { postOffice: opts.postOffice } : {}),
  };
  out.agents = opts.templatesDir !== undefined
    ? { dataRoot: opts.dataRoot, templatesDir: opts.templatesDir }
    : { dataRoot: opts.dataRoot };
  return out;
}
