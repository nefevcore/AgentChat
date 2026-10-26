// ============================================================
// auth-registry-row.ts —— 宿主 auth-registry 行（cr-545；行集清单 R1
// 「授权注册表写者」preview 落地）
//
// 三个入口、一个写口（D3 修订「两层皆宿主单写」）：
//   ① grant 信受理（协议 E）：host 端点收信（HostInbox 扇出面）→
//      requestId 幂等 → 预检（资产面恒拒 row/inline；global scope 需
//      user 审批——现阶段拒收，审批卡归 webui 产品批）→ priorFingerprint
//      对拍（乐观锁）→ 写者面 → 回执信（grant-applied/grant-rejected）
//      投 agent 经验流；
//   ② 凭据写面：writeCredential（ac-credentials-core 单源——credentials/
//      目录条目文件制 + 机器绑定密钥）；
//   ③ 授权编辑面（F2 分立，2026-10-19 裁决）：auth/* RPC 域前缀——
//      per-agent denials 收紧/放宽 + 两层读视图（agent-admin 保持
//      身份编辑面纯度——config/entries/文档，不碰 auth.json）。
//
// 回执 uuid/requestId = 受理信原值（agent 侧按 requestId 对账）；
// 回执复用受理信 uuid 经邮局登记校验安全（participants 集合
// {sender, host} 两侧序无关一致——R-1 集合比较）。
// ============================================================
import type { Plugin, Context } from '@agentchat/cordis';
import type { Envelope } from 'ac-envelope-core';
import {
  makeGrantReceiptEnvelope,
  validateGrantPayload,
  type GrantPayload,
  type GrantReceiptPayload,
} from 'ac-envelope-core';
import type { HostInbox } from './host-inbox.ts';
import {
  readGlobalAuth,
  readAgentAuth,
  authFingerprint,
  addGrant,
  removeGrant,
  addDenial,
  removeDenial,
  addMcpServer,
  removeMcpServer,
  type AssetRef,
} from 'ac-auth-core';
import { writeCredential, listCredentialNames, credentialKey, deriveKey, machineMaterial } from 'ac-credentials-core';

/** auth-registry 行装配参数 */
export interface AuthRegistryRowOptions {
  /** 数据根（两层 auth.json + credentials/ + mcp.json 锚点） */
  dataRoot: string;
  /** host 端点收信扇出面（boot 建 HostInbox 后注入） */
  inbox: HostInbox;
  /** 邮局（回执投递——dispatch 结构子集，测试可替身） */
  postOffice: { dispatch(env: Envelope): Promise<unknown> };
}

/** web 编辑面契约面（本行用到 webServer 服务的子集） */
interface WebFace {
  registerRpc(name: string, h: (params: unknown) => unknown): void;
}

/**
 * 宿主 auth-registry 行。写者面经 boot 编排注入（非跨行 cordis 服务
 *——与 guardian 编排件同族），走 cordis 装配拿行集开关语义：摘行 =
 * 信封受理 + 编辑面下线（数据面两层 auth.json 照旧，壳只读健在）。
 * 编辑面挂 ctx.webServer（inject 声明——singles/groups/plugin-registry
 * 同款 cordis PENDING 装配序；cr-594：原 options.webServer 注入面 boot
 * 从不传，auth/* RPC 曾静默不绑）。
 */
export function makeAuthRegistryRow(options: AuthRegistryRowOptions): Plugin {
  return {
    name: 'ac-host-rows/auth-registry',
    inject: ['webServer'],
    apply(ctx: Context) {
      const dataRoot = options.dataRoot;

      // ---- ① grant 信受理（HostInbox 扇出面——grant/revoke 域自判） ----
      options.inbox.on(async (env: Envelope) => {
        if (env.kind !== 'grant' && env.kind !== 'revoke') return;
        if (env.to !== 'host') return;
        const receipt = applyGrant(dataRoot, env);
        // 回执投 agent 经验流（kind=receipt → ledger-only A4——不触发 run）
        await options.postOffice.dispatch(makeGrantReceiptEnvelope({
          uuid: env.uuid,
          requestId: env.requestId,
          to: env.sender,
          payload: receipt,
        }));
      });

      // ---- ③ 编辑面（auth/* RPC 域绑定——ctx.webServer 经 inject 就位） ----
      bindAuthEditRpc(ctx.webServer as unknown as WebFace, dataRoot);
    },
  };
}

/** 受理编排（纯编排——写者词汇单源 ac-auth-core） */
function applyGrant(dataRoot: string, env: Envelope): GrantReceiptPayload {
  const agent = env.sender;
  const issues = validateGrantPayload(env.payload);
  if (issues.length > 0) {
    return { subject: 'grant-rejected', agent, ok: false, reason: '结构非法：' + issues.join('；') };
  }
  const p = env.payload as GrantPayload;
  // 预检：global scope 需 user 审批（D4）——现阶段拒收（审批卡归 webui 产品批）
  if (p.scope === 'global') {
    return { subject: 'grant-rejected', agent, ok: false, reason: 'global scope 授予需 user 审批（审批信面未落地——webui 产品批）' };
  }
  // priorFingerprint 对拍（E 节乐观锁）
  const global = readGlobalAuth(dataRoot);
  const agentAuth = readAgentAuth(dataRoot, agent);
  const prior = authFingerprint(global, agentAuth ?? undefined);
  if (p.priorFingerprint !== prior) {
    return { subject: 'grant-rejected', agent, ok: false, reason: 'priorFingerprint 不匹配（注册表已变更——重读后再试）' };
  }
  // 写者面（per-agent grants 词形：credential → inline 快照〔deriveChildAuth 同形〕；mcp → mcp 引用）
  if (p.asset.kind === 'credential') {
    const ref: AssetRef = { inline: { kind: 'inline', spec: { credentialRef: p.asset.ref } } };
    if (p.action === 'grant') addGrant(dataRoot, agent, { ...ref, inline: { ...ref.inline!, note: 'grant-letter ' + new Date().toISOString() } });
    else removeGrant(dataRoot, agent, ref);
  } else {
    if (p.action === 'grant') {
      addGrant(dataRoot, agent, { mcp: p.asset.name });
      addMcpServer(dataRoot, { name: p.asset.name });
    } else {
      removeGrant(dataRoot, agent, { mcp: p.asset.name });
      removeMcpServer(dataRoot, p.asset.name);
    }
  }
  const newFp = authFingerprint(readGlobalAuth(dataRoot), readAgentAuth(dataRoot, agent) ?? undefined);
  return { subject: 'grant-applied', agent, ok: true, newFingerprint: newFp };
}

/** 编辑面 RPC 绑定（auth/* 域——webServer 注入后） */
function bindAuthEditRpc(web: { registerRpc(name: string, h: (params: unknown) => unknown): void }, dataRoot: string): void {
  web.registerRpc('auth/agent-view', (params) => {
    const agentId = reqStr(obj(params), 'agentId');
    const auth = readAgentAuth(dataRoot, agentId);
    return { auth };
  });
  web.registerRpc('auth/deny', (params) => {
    const p = obj(params);
    addDenial(dataRoot, reqStr(p, 'agentId'), parseAssetRef(p.ref));
  });
  web.registerRpc('auth/allow', (params) => {
    const p = obj(params);
    removeDenial(dataRoot, reqStr(p, 'agentId'), parseAssetRef(p.ref));
  });
  web.registerRpc('auth/global-view', () => ({ global: readGlobalAuth(dataRoot) }));
  web.registerRpc('auth/credentials', () => ({ names: listCredentialNames(dataRoot) }));
  web.registerRpc('auth/write-credential', (params) => {
    const p = obj(params);
    writeCredential(dataRoot, deriveKey(machineMaterial()), reqStr(p, 'name'), reqStr(p, 'value'));
  });
}

function obj(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

function reqStr(source: Record<string, unknown>, key: string): string {
  const v = source[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失或非非空字符串`);
  return v;
}

/** AssetRef 参数窄化（编辑面 ref 参数——四词形校验） */
function parseAssetRef(raw: unknown): AssetRef {
  const p = obj(raw);
  if (typeof p.globalId === 'string' && p.globalId !== '') return { globalId: p.globalId };
  if (typeof p.row === 'string' && p.row !== '') return { row: p.row };
  if (typeof p.mcp === 'string' && p.mcp !== '') return { mcp: p.mcp };
  if (p.inline !== undefined && p.inline !== null && typeof p.inline === 'object') {
    const spec = (p.inline as { spec?: unknown }).spec;
    return { inline: { kind: 'inline', spec: typeof spec === 'object' && spec !== null ? spec as Record<string, unknown> : {} } };
  }
  throw new Error('参数 ref 非法（globalId/row/mcp/inline 四选一）');
}
