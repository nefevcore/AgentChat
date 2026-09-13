// ============================================================
// ac-security/src/index.ts —— 安全行（双轴门禁 + 双黑名单 + bash 扫描 +
// 脱敏 + 唆使防御注入）
//
// access-tier 重设计（src/docs/security-access-tier-plan.md）：
//   · 能力轴（不动）：requiredTags AND vs tags 单源能力集——工具可见性
//     与执行第一道门（capabilitySetOf/toolAllowedFor 零改动）。
//   · 权限轴（新增）：ToolDefinition.needPermission × Agent tags 档位
//     （full-access/sandbox-access/缺省 base）× 会话桶有无 user 端点
//     × ToolCall.elevation 机制提权——决策矩阵见 tierGate。
//   · 双黑名单：accessDenyPaths（读+写双禁——控制面/持久化域，域规则
//     与档位正交，full 也不跳过）+ readDenyPaths（仅读禁——用户域机密；
//     full 跳过）。读路径放宽（读不设防，§9.1）。
//   · 询问提权（§六）：base + 有人桶经 durableInteraction.open({kind:
//     'approval'}) 等待人审——批准 = 本次调用按 full 执行（call.elevation
//     注入，单次不持久化）；无人桶/无身份拒绝并说明。
//   · 唆使防御（§八，软缓解非边界）：loop/before-run 主档监听——
//     source='agent' 且 tierOf(sender) 严格低于接收方时注入
//     <security-notice> system 块（steer 落点在 ac-conversation）。
// settings['security'].enabled = false → 本行对该 Agent 软停用（ADR-4，
// 全部监听面：门禁/沙箱复检/bash 扫描/脱敏/防御注入）。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import { TIER_RANK, effectiveTierOf, tierOf } from 'ac-agents';
import {
  agentSpaceRoots,
  bashCommandViolation,
  createSandboxResolver,
  isDeniedPath,
  isPathUnder,
  makeSecretRedactor,
  redactSecretValue,
  securityNoticeText,
  accessDenyPatterns,
  readDenyPatterns,
  denyExtrasOf,
  type SandboxResolver,
} from 'ac-sandbox-core';

/** 读类路径工具（读不设防 §9.1：脱离工作区沙箱，只过双黑名单） */
const READ_PATH_TOOLS = new Set(['read', 'glob', 'grep']);
/** 写类路径工具（写侧防线不动：沙箱 + 档位询问/拒绝 + accessDeny） */
const WRITE_PATH_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
/** 全部路径类工具（目标路径过复检） */
const PATH_TOOLS = new Set([...READ_PATH_TOOLS, ...WRITE_PATH_TOOLS]);
/** 命令类工具（命令文本过 bash 扫描） */
const COMMAND_TOOLS = new Set(['bash']);

/** settings['security'] 的 per-Agent 配置形状（access-tier §9.4 终态五键） */
interface SecuritySettings {
  /** 软停用（缺省 false = 启用）：门禁/复检/扫描/脱敏/防御注入全停 */
  enabled?: boolean;
  /** 相对路径解析基准（缺省 = Agent 专用空间 files/<id>） */
  workdir?: string;
  /** 追加允许根（带外授权；经 workspace.sandboxAllowedPaths 进工具行基线） */
  allowedPaths?: string[];
  /** 系统域访问黑名单（读+写双禁；内置默认表不可覆盖，追加式） */
  accessDenyPaths?: string[];
  /** 用户域机密读黑名单（仅读禁；内置默认表不可覆盖，追加式） */
  readDenyPaths?: string[];
}

export interface SecurityRowOptions {
  /** 缺省沙箱工作目录（缺省 process.cwd()；与工具行缺省一致） */
  workdir?: string;
  /** 缺省额外允许根 */
  allowedPaths?: string[];
  /** 缺省追加访问黑名单（读+写双禁） */
  accessDenyPaths?: string[];
  /** 缺省追加读黑名单（仅读禁） */
  readDenyPaths?: string[];
  /** 额外脱敏值（行级注入；缺省只用凭据库 + 通用模式） */
  extraSecrets?: string[];
}

/** 提取工具入参中的目标路径（file_path/filePath/path 三键正典兼容） */
function extractTargetPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'filePath', 'path']) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

/** 等待轮询间隔（replied 事件驱动之外的双保险——store 可能被外部进程回复） */
const APPROVAL_POLL_MS = 150;

/** ToolCall.elevation 的窄词表（机制提权/审批注入） */
type ToolCallElevation = 'sandbox-access' | 'full-access' | undefined;

/** durableInteraction 的最小结构面（软依赖；窄类型避免行耦合） */
interface DurableInteractionLike {
  open(input: {
    key: string;
    kind: string;
    payload: unknown;
    correlationId?: string;
    owner?: string;
    deadline?: number;
  }): { id: string };
  get(id: string): { id: string; state: string; answer?: unknown; closedReason?: string } | undefined;
  close(id: string, reason?: string): boolean;
}

/** group/singles 软依赖识别面（无人桶判定用——形态识别，不读成员表） */
interface ShapeLookup {
  get(id: string): unknown;
}

/**
 * 会话桶人工审批面判定（access-tier §五）：该会话是否存在可触达的
 * user 端点。群 gid 恒无人（群无清晰审批归属 + MAX_AUTO_WAKES 同语义）；
 * singles sid 恒有人（独立会话由用户发起，构造性保证）；对桶 a~b 任一段
 * = user → 有人（a~a 自会话无人）；未知形态恒无人（fail-closed——只有
 * positively 识别为"含 user 对桶/singles"才有人）。
 */
function conversationHasUserEndpoint(ctx: Context, conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const group = ctx.get('group', false) as ShapeLookup | undefined;
  if (group !== undefined && group.get(conversationId) !== undefined) return false; // 群恒无人
  const singles = ctx.get('singles', false) as ShapeLookup | undefined;
  const single = singles?.get(conversationId);
  if (single !== undefined && single !== null) return true; // singles 恒有人
  if (conversationId.includes('~')) {
    const parts = conversationId.split('~');
    if (parts.length === 2 && parts[0] && parts[1]) return parts.includes('user');
  }
  return false; // 未知形态 fail-closed
}

/** 权限拒绝的配置指引（无人桶/无身份共用——§3.2 明确说明） */
const TIER_GUIDANCE =
  '需要更高权限时：由人事先在 Agent 配置 tags 中添加档位标签（agentAdmin 管理面）——' +
  "'sandbox-access'（工作区白名单内自由）或 'full-access'（不受限）；" +
  '或回到与用户的 1v1 会话发起（有人审可询问提权）。';

export const name = 'ac-security';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'security',
  label: '安全检查·脱敏',
  description: '双轴门禁（requiredTags 能力轴 + needPermission×档位权限轴，含询问提权）+ 双黑名单 + bash 命令扫描；工具结果变换脱敏；唆使防御 notice 注入',
  fields: [
    { name: 'workdir', type: 'string', description: 'per-Agent 工作目录（相对路径的锚点；显式配置后 Agent 专用空间 files/<id> 仍自动并入允许根——记忆/概要等读侧服务锚定专用空间，绝对路径维护可达）' },
    { name: 'allowedPaths', type: 'list', description: '沙箱路径白名单（绝对路径；经 workspace.sandboxAllowedPaths 进文件/命令工具行基线允许根——端到端生效，不依赖本行 enabled）' },
    { name: 'accessDenyPaths', type: 'list', description: '访问黑名单（读+写双禁，优先于白名单且不随档位跳过；控制面文件与持久化域树 agents/sessions/subagents/usage/backups 自动内置）' },
    { name: 'readDenyPaths', type: 'list', description: '读黑名单（仅读禁，base/sandbox 档生效——full 跳过；.env 系/密钥文件模式自动内置）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——门禁/复检/扫描/脱敏/防御注入全停。工具行基线不随（bash 为残余裸奔面）' },
  ],
  listeners: [
    { event: 'tool/before-execute', role: '双轴门禁+沙箱复检+bash 扫描+询问提权', description: '工具执行前拦截（能力/权限两轴 + 黑名单 + 审批阻塞）——承重：关停失去全部 Agent 的门禁与沙箱', facet: 'gate', respectsEnabled: true },
    { event: 'tool/transform-result', role: '输出脱敏', description: '工具结果变换（脱敏/安全审查 seam——after 通知变换后终值）', facet: 'redact', respectsEnabled: true },
    { event: 'loop/before-run', role: '唆使防御 notice 注入', description: 'source=agent 且来件方档位低于接收方时注入 <security-notice> system 块（软缓解，非硬边界）', facet: 'prompt', respectsEnabled: true },
  ],
};


export const inject = ['tools', 'agents'];

/** 路径复检环境（权限轴覆盖判定 + 加严层复检共用一次装配） */
interface PathEnv {
  /** 相对路径锚点（与工具行基线同源：会话工作区 > sandboxWorkdir > settings.workdir > 行缺省） */
  anchor: string;
  /** 写类沙箱复检解析器（含 accessDeny 注入；读类不用） */
  resolver: SandboxResolver;
  /** 访问黑名单（读+写双禁，全档生效） */
  accessDeny: string[];
  /** 读黑名单（仅读禁，full 跳过） */
  readDeny: string[];
  /** Agent 有界专属空间（files/<id>；预设/未知 = undefined——根无界不豁免） */
  ownSpace: string | undefined;
}

export function apply(ctx: Context, options: SecurityRowOptions = {}) {
  const defaults: SecuritySettings = {
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    ...(options.allowedPaths !== undefined ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.accessDenyPaths !== undefined ? { accessDenyPaths: options.accessDenyPaths } : {}),
    ...(options.readDenyPaths !== undefined ? { readDenyPaths: options.readDenyPaths } : {}),
  };

  /** 解析调用方 Agent 的 settings['security']（M24 A1 合成口：全局默认层 ∪
   *  Agent 差异层；无身份/无配置 = 行级缺省） */
  function settingsOf(agentId: string | undefined): SecuritySettings {
    if (agentId === undefined) return defaults;
    const s = ctx.agents.settingsOf(agentId, 'security');
    if (s && typeof s === 'object') return { ...defaults, ...(s as SecuritySettings) };
    return defaults;
  }

  /** workspace 软依赖（窄类型加宽读 root——双黑名单锚点；
   *  agentWorkdir 可选面供 D1 专属空间豁免；conversationWorkspaceRoot
   *  可选面供会话工作区并根——真实 ac-workspace 有这些方法） */
  function workspaceOf(): {
    root: string;
    sandboxWorkdir(id?: string, conversationId?: string): string | undefined;
    agentWorkdir?(id?: string): string | undefined;
    conversationWorkspaceRoot?(cid?: string): string | null;
  } | undefined {
    return ctx.get('workspace') as
      | {
          root: string;
          sandboxWorkdir(id?: string, conversationId?: string): string | undefined;
          agentWorkdir?(id?: string): string | undefined;
          conversationWorkspaceRoot?(cid?: string): string | null;
        }
      | undefined;
  }

  /** 会话挂载工作区根（singles → 工作区路径；与 sandboxAllowedPaths
   *  并出面同一事实源 conversationWorkspaceRoot——复检与基线不漂移。
   *  标准链路里基准已指工作区根（sandboxWorkdir 会话感知），本并面
   *  冗余保留：workspace 部分实现（mock/旧形态）基准不含会话语义时
   *  授予仍成立） */
  function sessionRoots(ws: ReturnType<typeof workspaceOf>, conversationId: string | undefined): string[] {
    const root = ws?.conversationWorkspaceRoot?.(conversationId);
    return root ? [root] : [];
  }

  /** workspace 不可用的 fail-closed 告警只发一次（显式告警——G3） */
  let warnedNoWorkspace = false;

  /** 双黑名单 + 锚点 + 沙箱复检解析器的一次性装配（权限轴与加严层共用；
   *  workspace 不可用 → fail-closed 拒绝（G3：黑名单无法锚定数据根） */
  function pathEnvOf(agentId: string | undefined, conversationId?: string): PathEnv | { error: string } {
    const ws = workspaceOf();
    // root 防御性校验：mock/部分实现无 root = 无法锚定（与未装同判 fail-closed）
    if (!ws || typeof ws.root !== 'string') {
      if (!warnedNoWorkspace) {
        warnedNoWorkspace = true;
        ctx.logger.warn(
          '[security] workspace 服务不可用：双黑名单（控制面/持久化域 + 机密读表）无法锚定数据根——路径类工具按防线缺失 fail-closed 拒绝。请启用 ac-workspace 行（或检查其激活状态）。',
        );
      }
      return {
        error:
          '路径类工具当前被拒绝：安全防线（访问/读黑名单）依赖 workspace 服务锚定数据根，而 workspace 不可用（fail-closed）。请启用 ac-workspace 行后重试。',
      };
    }
    const h = settingsOf(agentId);
    const extras = denyExtrasOf(h); // defaults 已并入 settingsOf（行级追加项在内）
    const accessDeny = accessDenyPatterns(ws.root, extras.accessDenyPaths);
    const readDeny = readDenyPatterns(extras.readDenyPaths);
    const workdir = ws.sandboxWorkdir(agentId, conversationId) ?? h.workdir;
    // 写侧对齐读侧：专用空间 + 会话工作区并根（与工具行基线同源——复检
    // 与基线永不漂移）；黑名单仍优先
    const allowed = [...(h.allowedPaths ?? []), ...sessionRoots(ws, conversationId), ...agentSpaceRoots(ws, agentId, workdir)];
    // D1 专属空间豁免（base 也免询问）：files/<id> 有界子树。预设/未知
    // Agent 的"专用空间" = 数据根（无界）→ 不豁免。
    const agentDir = ws.agentWorkdir?.(agentId);
    const ownSpace =
      agentDir && path.resolve(agentDir) !== path.resolve(ws.root) ? path.resolve(agentDir) : undefined;
    return {
      anchor: workdir !== undefined ? path.resolve(workdir) : process.cwd(),
      resolver: createSandboxResolver({
        ...(workdir !== undefined ? { workdir } : {}),
        ...(allowed.length > 0 ? { allowedPaths: allowed } : {}),
        denyPatterns: accessDeny,
      }),
      accessDeny,
      readDeny,
      ownSpace,
    };
  }

  /** per-Agent（或行级缺省；× 会话工作区）沙箱解析器（bash 扫描用：
   *  roots/cwd；路径类工具走 pathEnvOf——含双黑名单） */
  function resolverOf(agentId: string | undefined, conversationId?: string): SandboxResolver {
    const h = settingsOf(agentId);
    const ws = workspaceOf();
    const workdir = ws?.sandboxWorkdir(agentId, conversationId) ?? h.workdir;
    const allowed = [...(h.allowedPaths ?? []), ...sessionRoots(ws, conversationId), ...agentSpaceRoots(ws, agentId, workdir)];
    return createSandboxResolver({
      ...(workdir !== undefined ? { workdir } : {}),
      ...(allowed.length > 0 ? { allowedPaths: allowed } : {}),
    });
  }

  /** effectiveTier（§3.2）：call.elevation（机制提权/审批注入）?? tierOf(agent)
   *  ——ac-agents 导出的单源实现（工具行基线共用，防复检与基线漂移） */
  function tierOfCall(agentId: string | undefined, elevation: ToolCallElevation): 'full-access' | 'sandbox-access' | 'base-access' {
    return effectiveTierOf(agentId !== undefined ? ctx.agents.get(agentId) : undefined, elevation);
  }

  // ---- 询问提权（§六）：durableInteraction.open({kind:'approval'}) 等待人审 ----
  /** 审批等待：replied 事件驱动 + 轮询双保险 + signal（无缺省 deadline——
   *  交互层缺省永久等待，late-reply 信封唤醒模式天然支持） */
  function awaitApproval(
    record: { id: string },
    signal: AbortSignal | undefined,
  ): Promise<'approved' | 'rejected' | 'closed' | 'aborted'> {
    const di = ctx.get('durableInteraction', false) as DurableInteractionLike | undefined;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: 'approved' | 'rejected' | 'closed' | 'aborted') => {
        if (done) return;
        done = true;
        clearInterval(poller);
        disposeListener();
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const disposeListener = ctx.on('durable-interaction/replied', (payload: { id: string }) => {
        if (payload.id === record.id) {
          const cur = di?.get(record.id);
          finish(approvedAnswer(cur?.answer) ? 'approved' : 'rejected');
        }
      }, { description: '提权审批等待（事件驱动半边）' });
      const poller = setInterval(() => {
        const cur = di?.get(record.id);
        if (cur && cur.state !== 'pending') {
          finish(cur.state === 'answered' ? (approvedAnswer(cur.answer) ? 'approved' : 'rejected') : 'closed');
        }
      }, APPROVAL_POLL_MS);
      const onAbort = () => finish('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 审批应答判定：true/'approve'/'approved' = 批准，其余（false/'reject'/null）= 拒绝 */
  function approvedAnswer(answer: unknown): boolean {
    return answer === true || answer === 'approve' || answer === 'approved';
  }

  /** 审批载荷的参数摘要（§六：bash 全文 / 写路径全文 / 其余 JSON 截断） */
  function approvalArgsSummary(name: string, args: Record<string, unknown>): unknown {
    if (name === 'bash') return args.command ?? args.cmd ?? args;
    const targets = extractTargetPaths(args);
    if (WRITE_PATH_TOOLS.has(name) && targets.length > 0) return { paths: targets };
    const json = JSON.stringify(args);
    return json.length > 2000 ? `${json.slice(0, 2000)}…(截断)` : args;
  }

  // ---- 执行前拦截：双轴门禁 + 双黑名单复检 + bash 命令扫描 ----
  ctx.on('tool/before-execute', async (execution, next) => {
    const call = execution.call;
    const security = settingsOf(call.agentId);

    // 软停用：本行对该 Agent 不生效（其余监听器照常）
    if (security.enabled === false) return next();

    // 1. 能力轴门禁（requiredTags AND；include 不可绕过）——语义不动。
    //    有效能力集 = {'base', 'agent:<调用方id>'} ∪ tags（tags 单源——
    //    capabilities 覆盖层已随 §9.4 删除）。base 恒在（收窄出口 =
    //    AgentConfig.tools include/exclude 三态语义）；owner 段只在有身份
    //    时合成（L2：防合成 agent:undefined）。
    const def = ctx.tools.get(call.name);
    if (def?.requiredTags && def.requiredTags.length > 0) {
      const agent = call.agentId !== undefined ? ctx.agents.get(call.agentId) : undefined;
      const caps = new Set<string>(['base', ...(agent?.tags ?? [])]);
      if (call.agentId !== undefined) caps.add(`agent:${call.agentId}`);
      const missing = def.requiredTags.filter((r) => !caps.has(r));
      if (missing.length > 0) {
        return {
          ok: false as const,
          error:
            `工具 ${call.name} 需要能力标签 [${missing.join(', ')}]，` +
            `当前 Agent（${call.agentId ?? '无身份'}）能力集为 [${[...caps].join(', ')}]。` +
            `如需授权请在 Agent 配置 tags 中添加（tags 单源）。`,
        };
      }
    }

    // effectiveTier（含机制提权/审批注入）
    let tier = tierOfCall(call.agentId, call.elevation as ToolCallElevation);

    // 2. 权限轴（§3.2 矩阵；能力轴先判——requiredTags 不满足连询问资格都没有）
    if (def?.needPermission === true && tier !== 'full-access') {
      let covered = false; // 档位覆盖 = 边界内（§7.3/D3）
      if (WRITE_PATH_TOOLS.has(call.name)) {
        const targets = extractTargetPaths(call.args ?? {});
        if (targets.length > 0) {
          const env = pathEnvOf(call.agentId, call.conversationId);
          if ('error' in env) return { ok: false as const, error: env.error };
          covered = targets.every((t) => {
            const resolved = path.resolve(env.anchor, t);
            // D1 专属空间写豁免：files/<agentId>/** 内的写不敏感（base 也
            // 免询问——普通 run 里 Agent 随手更新记忆不触发审批疲劳）
            if (env.ownSpace !== undefined && isPathUnder(resolved, env.ownSpace)) return true;
            // sandbox 档：工作区白名单内自由，越界视同 base 行（D3）
            return tier === 'sandbox-access' && env.resolver.isAllowed(resolved);
          });
        }
      } else {
        // 非路径类（web 等）：sandbox 自由；bash 的软边界由第 4 步扫描兜底
        covered = tier === 'sandbox-access';
      }
      if (!covered) {
        // 询问提权（有人桶）/ 拒绝（无人桶、无身份——fail-closed）
        if (call.agentId === undefined) {
          return {
            ok: false as const,
            error: `工具 ${call.name} 需要权限档位（needPermission），但本次调用无执行身份（宿主直调 fail-closed）。宿主机制需要特权请走服务方法，不走工具。`,
          };
        }
        if (call.conversationId === undefined || !conversationHasUserEndpoint(ctx, call.conversationId)) {
          return {
            ok: false as const,
            error: `工具 ${call.name} 需要更高权限档位（当前 ${tier}），且本会话无可触达的人工审批面（无人会话/无会话键——fail-closed）。${TIER_GUIDANCE}`,
          };
        }
        const di = ctx.get('durableInteraction', false) as DurableInteractionLike | undefined;
        if (di === undefined) {
          return {
            ok: false as const,
            error: `工具 ${call.name} 需要提权审批，但 durableInteraction 服务不可用（无法询问——fail-closed）。${TIER_GUIDANCE}`,
          };
        }
        // write-ahead：open 先落盘再通知（opened 事件随 open 发出——审批卡消费面）
        const record = di.open({
          key: String(call.conversationId),
          kind: 'approval',
          payload: {
            tool: call.name,
            args: approvalArgsSummary(call.name, call.args ?? {}),
            need: `本次调用需要 full-access 档位（当前 ${tier}）。批准 = 本次调用按 full-access 执行（单次有效，不持久化）。`,
          },
          ...(call.toolCallId !== undefined ? { correlationId: call.toolCallId } : {}),
          owner: call.agentId,
        });
        const settled = await awaitApproval(record, call.signal);
        if (settled === 'approved') {
          // 人审即最高档、一次性：审批展示的是该次调用的完整参数（§六）
          execution.call = { ...call, elevation: 'full-access' };
          tier = 'full-access';
        } else {
          const reason =
            settled === 'rejected'
              ? '用户拒绝了本次提权请求'
              : settled === 'aborted'
                ? '提权等待被中止（signal abort）'
                : `提权交互已关闭（${di.get(record.id)?.closedReason ?? 'unknown'}）`;
          try {
            di.close(record.id, settled === 'rejected' ? 'rejected' : settled);
          } catch {
            /* 已关闭（别处竞态） */
          }
          return { ok: false as const, error: `工具 ${call.name} 未获提权：${reason}。${TIER_GUIDANCE}` };
        }
      }
    }

    // 3. 路径类加严层复检（§9.3）：
    //    读类 = 双黑名单（full 仅 accessDeny）；写类 = 沙箱复检（full 仅
    //    accessDeny——域规则与档位正交，不随档位跳过）
    if (PATH_TOOLS.has(call.name)) {
      const targets = extractTargetPaths(call.args ?? {});
      if (targets.length > 0) {
        const env = pathEnvOf(call.agentId, call.conversationId);
        if ('error' in env) return { ok: false as const, error: env.error };
        for (const target of targets) {
          if (target === '.') continue; // 搜索根缺省（glob/grep）总是当前基准
          try {
            if (READ_PATH_TOOLS.has(call.name)) {
              // 读不设防（§9.1）——只过双黑名单（full 跳过 readDeny）
              const resolved = path.resolve(env.anchor, target);
              if (isDeniedPath(env.accessDeny, resolved)) {
                throw new Error(`路径被访问黑名单拒绝（系统域读+写双禁）：${target}`);
              }
              if (tier !== 'full-access' && isDeniedPath(env.readDeny, resolved)) {
                throw new Error(`路径被读黑名单拒绝（用户域机密；full-access 档跳过）：${target}`);
              }
            } else if (tier === 'full-access') {
              // full：跳过沙箱复检，accessDeny 复检不随档位跳过（§9.2）
              const resolved = path.resolve(env.anchor, target);
              if (isDeniedPath(env.accessDeny, resolved)) {
                throw new Error(`路径被访问黑名单拒绝（系统域读+写双禁，不随档位跳过）：${target}`);
              }
            } else {
              env.resolver.resolve(target); // base/sandbox：完整沙箱复检（含 accessDeny 注入）
            }
          } catch (err: unknown) {
            return {
              ok: false as const,
              error: `${err instanceof Error ? err.message : String(err)}（安全行复检：settings['security'].workdir/allowedPaths/accessDenyPaths）`,
            };
          }
        }
      }
    }

    // 4. bash 命令扫描：heredoc 剥离 + 段级启发式（纵深防御；full 跳过——
    //    "不做任何限制"的字面义；bash 软边界语义见 §2.2）
    if (COMMAND_TOOLS.has(call.name) && tier !== 'full-access') {
      const command = String(call.args?.command ?? call.args?.cmd ?? '');
      const resolver = resolverOf(call.agentId, call.conversationId);
      const violation = bashCommandViolation(command, {
        roots: resolver.allowedRoots,
        cwd: resolver.workdir,
      });
      if (violation) {
        return { ok: false as const, error: violation };
      }
    }

    return next();
  }, { description: '双轴门禁（requiredTags + needPermission×档位）+ 双黑名单复检 + bash 扫描 + 询问提权' });

  // ---- 唆使防御注入（§八 落点 A：新 run 的 system 块）----
  // source='agent' 且 tierOf(sender) 严格低于 tierOf(接收方) → 注入
  // <security-notice>（主档 push 收尾——尾档日期行绝对收尾不动）。未注册
  // sender 视作 base（宁多注不漏注）；同档或降向不注入。软防御不构成
  // 边界——硬边界仍是档位矩阵。
  ctx.on('loop/before-run', (call, next) => {
    const request = call.request;
    const security = settingsOf(request.agent);
    if (security.enabled === false) return next(); // 软停用（respectsEnabled）
    if (request.source !== 'agent' || request.sender === undefined) return next();
    if (request.sender === request.agent) return next(); // 自会话（机制触发 = 目标自身）
    const senderTier = tierOf(ctx.agents.get(request.sender));
    const selfTier = tierOf(request.agent !== undefined ? ctx.agents.get(request.agent) : undefined);
    if (TIER_RANK[senderTier] >= TIER_RANK[selfTier]) return next(); // 无梯度可洗
    const block = securityNoticeText(request.sender, senderTier);
    call.request = {
      ...request,
      system: request.system ? `${request.system}\n${block}` : block,
    };
    return next();
  }, { description: '唆使防御 notice 注入（来件方档位低于接收方时）' });

  // ---- 结果变换：输出脱敏（凭据明文 + 通用密钥模式；递归 output） ----
  ctx.on('tool/transform-result', async (payload, next) => {
    const security = settingsOf(payload.call.agentId);
    if (security.enabled === false) return next(); // 软停用（与拦截面一致）

    const redact = makeSecretRedactor(secretsOf(ctx, options));
    if (payload.result && typeof payload.result === 'object' && 'output' in payload.result) {
      const output = (payload.result as { output?: unknown }).output;
      if (output !== undefined) {
        (payload.result as { output?: unknown }).output = redactSecretValue(output, redact);
      }
    }
    if (typeof payload.result.error === 'string') {
      payload.result.error = redact(payload.result.error);
    }
    const final: ToolResult = await next();
    return final;
  }, { description: '工具输出脱敏（凭据明文/密钥模式）' });

  /** 脱敏值集合：凭据库明文 + 行级注入（每轮拉取——凭据可热更） */
  function secretsOf(c: Context, opts: SecurityRowOptions): string[] {
    const values: string[] = [];
    const credentials = c.get('credentials');
    if (credentials) {
      try {
        values.push(...credentials.listValues());
      } catch {
        /* 凭据库不可读时只用通用模式 */
      }
    }
    for (const v of opts.extraSecrets ?? []) {
      if (v) values.push(v);
    }
    return values;
  }

  // 自检：缺省沙箱与工具行基准一致性说明（诊断用）
  ctx.logger.debug(
    'ac-security 就绪：双轴门禁（能力轴 + 权限轴×档位）+ 双黑名单 + bash 扫描 + 输出脱敏 + 唆使防御注入（workdir=%s）',
    path.resolve(defaults.workdir ?? process.cwd()),
  );
}
