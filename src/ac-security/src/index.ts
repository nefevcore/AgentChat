// ============================================================
// ac-security/src/index.ts —— 安全行（能力门禁 + 沙箱 + bash 扫描 + 脱敏）
//
// 全部经事件落点（独立成行不进工具体——地图 §3.4 安全域铁律）：
//   · tool/before-execute（waterfall 决策）——
//       1. 能力门禁：ToolDefinition.requiredTags（AND 语义）vs 调用方能力集
//          （settings['security'].capabilities，缺省 ['base']）。
//          include 不可绕过（AgentConfig.tools 只解决"暴露哪些"）
//       2. per-Agent 沙箱：路径类工具的目标路径必须落在
//          settings['security'] 的 workdir/allowedPaths 内且不中 denyPaths
//       3. bash 命令扫描：heredoc 剥离后按路径段判定的启发式检查
//          （纵深防御非完备沙箱——src 明示语义原样）
//   · tool/transform-result（waterfall 变换）——
//       输出脱敏：凭据明文值（ctx.credentials.listValues()）+ sk-xxx/
//       api_key= 通用模式，递归 details（变换必须落 transform——
//       after 是纯通知，改了没人消费）
// settings['security'].enabled = false → 本行对该 Agent 软停用（ADR-4 约定，
// 插件须自查）。
// ============================================================
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import {
  bashCommandViolation,
  createSandboxResolver,
  makeSecretRedactor,
  redactSecretValue,
  type SandboxResolver,
} from 'ac-sandbox-core';

/** 路径类工具（目标路径过 per-Agent 沙箱校验） */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep']);
/** 命令类工具（命令文本过 bash 扫描） */
const COMMAND_TOOLS = new Set(['bash']);

/**
 * 控制面文件黑名单（M23 E4/F1、G3：相对数据根的路径，运行时按
 * workspace.root 解析为绝对路径注入 denyPaths——裸文件名在 isDeniedPath
 * 三模式下永不匹配（防线静默失效），星号斜杠文件名模式则任意目录同名
 * 文件全拦（误伤））。
 * denyPaths 仅覆盖路径类工具：bash 扫描不消费 denyPatterns，控制面对
 * bash 持有者裸奔（F2 如实呈现——与 bash 等价性立场同级）。
 */
const CONTROL_PLANE_FILES = [
  'cordis.patch.yml',
  'plugins/registry.json',
  'plugins/audit.jsonl',
  'plugins/.load-health.json',
  '.safe-mode',
  // A3（2026-08-31 审计）：凭据库与宿主配置不在黑名单——预设 Agent 沙箱
  // = 数据根（workspace index.ts:218），read 可直读凭据库；config.json
  // 同为控制面（读改写 = 改装配/密钥池）。
  'credentials.json',
  'config.json',
] as const;

/** settings['security'] 的 per-Agent 配置形状 */
interface SecuritySettings {
  /** 软停用（缺省 false = 启用） */
  enabled?: boolean;
  /** 能力标签集（缺省 ['base']；已知词汇 base/dev/shell/admin/delegation/web/observe/manipulate/inject/fs_minimal） */
  capabilities?: string[];
  /** 相对路径解析基准（缺省 = 行配置 workdir） */
  workdir?: string;
  /** 额外允许根 */
  allowedPaths?: string[];
  /** 追加敏感黑名单（内置不可覆盖） */
  denyPaths?: string[];
}

export interface SecurityRowOptions {
  /** 缺省沙箱工作目录（缺省 process.cwd()；与工具行缺省一致） */
  workdir?: string;
  /** 缺省额外允许根 */
  allowedPaths?: string[];
  /** 缺省追加黑名单 */
  denyPaths?: string[];
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

export const name = 'ac-security';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'security',
  label: '安全检查·脱敏',
  description: '工具执行前能力门禁 + per-Agent 沙箱 + bash 命令扫描；工具结果变换脱敏（凭据明文/密钥模式）',
  fields: [
    { name: 'capabilities', type: 'list', description: '能力标签追加覆盖层（只加不减）——新授权建议写 Agent tags（M24 X4 单源）' },
    { name: 'workdir', type: 'string', description: 'per-Agent 工作目录（相对路径的锚点）' },
    { name: 'allowedPaths', type: 'list', description: '沙箱路径白名单（绝对路径；经 workspace.sandboxAllowedPaths 进文件/命令工具行基线允许根——端到端生效，不依赖本行 enabled）' },
    { name: 'denyPaths', type: 'list', description: '沙箱路径黑名单（优先于白名单；控制面文件自动注入）' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [
    { event: 'tool/before-execute', role: '门禁+沙箱+bash 扫描', description: '工具执行前拦截（安全策略/审计/参数改写）——承重：关停失去全部 Agent 的门禁与沙箱', facet: 'gate', respectsEnabled: true },
    { event: 'tool/transform-result', role: '输出脱敏', description: '工具结果变换（脱敏/安全审查 seam——after 通知变换后终值）', facet: 'redact', respectsEnabled: true },
  ],
};


export const inject = ['tools', 'agents'];

export function apply(ctx: Context, options: SecurityRowOptions = {}) {
  const defaults: SecuritySettings = {
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    ...(options.allowedPaths !== undefined ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.denyPaths !== undefined ? { denyPaths: options.denyPaths } : {}),
  };

  /** 解析调用方 Agent 的 settings['security']（M24 A1 合成口：全局默认层 ∪
   *  Agent 差异层；无身份/无配置 = 行级缺省） */
  function settingsOf(agentId: string | undefined): SecuritySettings {
    if (agentId === undefined) return defaults;
    const s = ctx.agents.settingsOf(agentId, 'security');
    if (s && typeof s === 'object') return { ...defaults, ...(s as SecuritySettings) };
    return defaults;
  }

  /** per-Agent（或行级缺省）沙箱解析器（bash 扫描用：roots/cwd；路径类工具走 pathResolverOf——含控制面黑名单） */
  function resolverOf(agentId: string | undefined): SandboxResolver {
    const h = settingsOf(agentId);
    // 基准优先级（与工具行解析、提示词展示同源——ac-workspace.sandboxWorkdir
    // 是唯一事实源）：显式 settings.security.workdir > Agent 专用空间
    // files/<id> > 行缺省。
    const ws = workspaceOf();
    const workdir = ws?.sandboxWorkdir(agentId) ?? h.workdir;
    return createSandboxResolver({
      ...(workdir !== undefined ? { workdir } : {}),
      ...(h.allowedPaths !== undefined ? { allowedPaths: h.allowedPaths } : {}),
      ...(h.denyPaths !== undefined ? { denyPatterns: h.denyPaths } : {}),
    });
  }

  /** workspace 软依赖（窄类型加宽读 root——G3 控制面黑名单锚点） */
  function workspaceOf(): { root: string; sandboxWorkdir(id?: string): string | undefined } | undefined {
    return ctx.get('workspace') as
      | { root: string; sandboxWorkdir(id?: string): string | undefined }
      | undefined;
  }

  /** workspace 不可用的 fail-closed 告警只发一次（显式告警——G3） */
  let warnedNoWorkspace = false;

  /**
   * 路径类工具的解析器（M23 G3）：在 per-Agent 沙箱之上注入控制面文件
   * 黑名单（按 workspace.root 解析绝对路径）。
   * 锚点必须是 workspace.root——不能按 agent 沙箱基准拼（显式
   * settings.security.workdir 优先级会锚错）；workspace 不可用时
   * **fail-closed：拒装配该 resolver + 显式告警**（静默跳过 = 数据根项
   * 无声消失、回落 workdir = 锚错基准，均为防线静默失效）。
   */
  function pathResolverOf(agentId: string | undefined): { resolver: SandboxResolver } | { error: string } {
    const ws = workspaceOf();
    if (!ws) {
      if (!warnedNoWorkspace) {
        warnedNoWorkspace = true;
        ctx.logger.warn(
          '[security] workspace 服务不可用：控制面文件黑名单（registry.json/audit.jsonl/cordis.patch.yml/.load-health.json/.safe-mode）无法锚定数据根——路径类工具按防线缺失 fail-closed 拒绝。请启用 ac-workspace 行（或检查其激活状态）。',
        );
      }
      return {
        error:
          '路径类工具当前被拒绝：安全防线（控制面文件黑名单）依赖 workspace 服务锚定数据根，而 workspace 不可用（fail-closed）。请启用 ac-workspace 行后重试。',
      };
    }
    const h = settingsOf(agentId);
    const workdir = ws.sandboxWorkdir(agentId) ?? h.workdir;
    const controlDeny = CONTROL_PLANE_FILES.map((rel) => path.join(ws.root, rel));
    return {
      resolver: createSandboxResolver({
        ...(workdir !== undefined ? { workdir } : {}),
        ...(h.allowedPaths !== undefined ? { allowedPaths: h.allowedPaths } : {}),
        ...(h.denyPaths !== undefined ? { denyPatterns: [...h.denyPaths, ...controlDeny] } : { denyPatterns: controlDeny }),
      }),
    };
  }

  // ---- 执行前拦截：能力门禁 + per-Agent 沙箱 + bash 命令扫描 ----
  /** 覆盖层一次性提示（M24 X4：双轨对账告警退役）：只发一次的 Agent 集 */
  const overlayNoticed = new Set<string>();

  ctx.on('tool/before-execute', async (execution, next) => {
    const call = execution.call;
    const security = settingsOf(call.agentId);

    // 软停用：本行对该 Agent 不生效（其余监听器照常）
    if (security.enabled === false) return next();

    // M24 X4：tags 单源；settings.security.capabilities 退位为**追加覆盖层**
    // （只加不减；收窄出口仍是 AgentConfig.tools include/exclude）。存量
    // 覆盖层值继续生效，双轨对账告警退役——覆盖层有值时降级一次性提示
    // （提示用户该 Agent 走的是旧覆盖层语义，新授权建议写 tags）。
    if (call.agentId !== undefined && !overlayNoticed.has(call.agentId)) {
      const overlay = (security.capabilities ?? []).filter((c) => c !== 'base');
      if (overlay.length > 0) {
        overlayNoticed.add(call.agentId);
        ctx.logger.info(
          '[security] Agent "%C" 的 settings.security.capabilities 覆盖层生效中（追加语义，只加不减：%C）。M24 X4 起新授权写 tags（单源）；覆盖层保留至人工迁移。',
          call.agentId,
          overlay.join(', '),
        );
      }
    }

    // 1. 能力门禁（requiredTags AND；include 不可绕过）
    //    有效能力集 = {'base', 'agent:<调用方id>'} ∪ tags ∪ 覆盖层
    //    （M23 E1/B4 owner 合成语义保持；M24 X4 并入 tags）。
    //    base 恒在（收窄出口 = AgentConfig.tools include/exclude 三态语义）；
    //    owner 段只在有身份时合成（L2：防合成 agent:undefined）。
    const def = ctx.tools.get(call.name);
    if (def?.requiredTags && def.requiredTags.length > 0) {
      const agent = call.agentId !== undefined ? ctx.agents.get(call.agentId) : undefined;
      const caps = new Set<string>(['base', ...(agent?.tags ?? []), ...(security.capabilities ?? [])]);
      if (call.agentId !== undefined) caps.add(`agent:${call.agentId}`);
      const missing = def.requiredTags.filter((r) => !caps.has(r));
      if (missing.length > 0) {
        return {
          ok: false as const,
          error:
            `工具 ${call.name} 需要能力标签 [${missing.join(', ')}]，` +
            `当前 Agent（${call.agentId ?? '无身份'}）能力集为 [${[...caps].join(', ')}]。` +
            `如需授权请在 Agent 配置 tags 中添加（M24 X4 单源；settings.security.capabilities 为追加覆盖层）。`,
        };
      }
    }

    // 2. per-Agent 沙箱：路径类工具的目标路径校验（veto 越界/黑名单）
    //    含控制面文件黑名单注入（G3：workspace.root 锚定 + fail-closed）
    if (PATH_TOOLS.has(call.name)) {
      const targets = extractTargetPaths(call.args ?? {});
      if (targets.length > 0) {
        const assembled = pathResolverOf(call.agentId);
        if ('error' in assembled) {
          return { ok: false as const, error: assembled.error };
        }
        for (const target of targets) {
          if (target === '.') continue; // 搜索根缺省（glob/grep）总是当前基准
          try {
            assembled.resolver.resolve(target);
          } catch (err: unknown) {
            return {
              ok: false as const,
              error: `${err instanceof Error ? err.message : String(err)}（per-Agent 沙箱：settings['security'].workdir/allowedPaths）`,
            };
          }
        }
      }
    }

    // 3. bash 命令扫描：heredoc 剥离 + 段级启发式（纵深防御）
    if (COMMAND_TOOLS.has(call.name)) {
      const command = String(call.args?.command ?? call.args?.cmd ?? '');
      const resolver = resolverOf(call.agentId);
      const violation = bashCommandViolation(command, {
        roots: resolver.allowedRoots,
        cwd: resolver.workdir,
      });
      if (violation) {
        return { ok: false as const, error: violation };
      }
    }

    return next();
  }, { description: '能力门禁（requiredTags AND）+ per-Agent 沙箱 + bash 扫描' });

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
    'ac-security 就绪：能力门禁 + 沙箱（workdir=%s）+ bash 扫描 + 输出脱敏',
    path.resolve(defaults.workdir ?? process.cwd()),
  );
}
