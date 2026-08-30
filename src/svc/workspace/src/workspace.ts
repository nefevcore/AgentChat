// ============================================================
// @agentchat/workspace/src/workspace.ts —— 工作区初始化服务
//
// 从 boot/bootstrap.ts 迁出（块 A 第 1 步）：
//   · files/shared/tool-dev-guide.md 指引复制（多候选模板路径）
//   · 默认 user 虚拟 Agent
//   · 首次运行检测（无 admin 且无 .initialized）→ 默认 admin（艾吉）
//   · 首次运行自我介绍消息（user↔admin 会话，幂等）
//
// 插件行 inject ['bootstrap']：读 boot 核心契约的 workspaceDir/agentsDir，
// 初始化完成后调用 core.loadAgents()（保证 user/admin 已注册）。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { Service, type Context } from '@agentchat/cordis';
import { createLogger } from '@agentchat/util';
import { chatDialogKey } from '@agentchat/contracts';
import { genMessageId } from '@agentchat/agent-session';

const logger = createLogger('[workspace]');

/** boot 核心契约最小结构（避免 workspace → boot 静态环） */
export interface WorkspaceCoreLike {
  workspaceDir: string;
  agentsDir: string;
  srcRoot: string;
  loadAgents(): void;
}

export interface WorkspaceServiceOptions {
  /** boot 核心契约（workspaceDir/agentsDir/srcRoot） */
  core: WorkspaceCoreLike;
  /** 可选：模板根目录覆盖（默认按 core.srcRoot 探测候选目录） */
  templateRoots?: string[];
}

export interface WorkspaceInitResult {
  isFirstRun: boolean;
  workspaceDir: string;
}

/** 候选模板目录（docs 为当前唯一真源，优先；再保留 preview/旧 dist 兼容候选） */
function resolveTemplateRoots(srcRoot: string, extra: string[] = []): string[] {
  return [
    ...extra,
    path.join(srcRoot, 'docs'),
    path.join(srcRoot, 'plugins', 'builtin'),
    path.join(srcRoot, 'src', 'plugins', 'builtin'),
    path.join(srcRoot, 'dist', 'src', 'plugins', 'builtin'),
    path.resolve(srcRoot, '..', 'src', 'plugins', 'builtin'),
    path.resolve(srcRoot, '..', 'dist', 'src', 'plugins', 'builtin'),
    path.resolve(srcRoot, '..', 'docs'),
  ];
}

/** 复制 files 指引（多候选目录，任一存在即可；全部不存在时告警） */
function copyWorkspaceGuides(workspaceDir: string, roots: string[]): void {
  const filesDir = path.join(workspaceDir, 'files');
  fs.mkdirSync(path.join(filesDir, 'shared'), { recursive: true });

  const entries: Array<{ name: string; desc: string }> = [
    { name: 'tool-dev-guide.md', desc: '工具开发指引' },
  ];
  for (const { name, desc } of entries) {
    const dest = path.join(filesDir, 'shared', name);
    if (fs.existsSync(dest)) continue;
    const src = roots.map((root) => path.join(root, name)).find((p) => fs.existsSync(p));
    if (src) {
      fs.copyFileSync(src, dest);
      logger.info(`已复制${desc}到工作区: ${dest}`);
    } else {
      logger.warn(`${desc}模板不存在（候选目录：${roots.join(', ')}）`);
    }
  }
}

/** 确保默认 user（虚拟 Agent）配置存在 */
function ensureDefaultUser(agentsDir: string): void {
  const userAgentDir = path.join(agentsDir, 'user');
  const userConfigPath = path.join(userAgentDir, 'config.json');
  if (fs.existsSync(userConfigPath)) return;
  fs.mkdirSync(userAgentDir, { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify({
    agent_id: 'user',
    name: '用户',
    virtual: true,
  }, null, 2), 'utf-8');
  logger.info(`已创建默认 user agent 配置: ${userConfigPath}`);
}

/** 首次运行检测：无 admin（tags 含 admin）且无 .initialized 标记 → 首次 */
function isFirstRun(workspaceDir: string, agentsDir: string): boolean {
  const initializedMark = path.join(workspaceDir, '.initialized');
  if (fs.existsSync(initializedMark)) return false;

  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (Array.isArray(cfg.tags) && cfg.tags.includes('admin')) return false;
      } catch { /* skip */ }
    }
  }
  return true;
}

/** 首次运行：创建默认 admin Agent（艾吉模板，新契约 presets/tools/hooks） */
function ensureDefaultAdmin(workspaceDir: string, agentsDir: string): void {
  const adminDir = path.join(agentsDir, 'admin');
  const adminConfigPath = path.join(adminDir, 'config.json');
  if (fs.existsSync(adminConfigPath)) return;

  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(adminConfigPath, JSON.stringify({
    agent_id: 'admin',
    name: '艾吉',
    description: 'AgentChat 平台管理员，负责社区治理与引导新用户',
    // 覆盖所有自带工具的 requires 标签：base 隐式，无需写入；显式声明 dev/admin/conductor
    tags: ['admin', 'dev', 'conductor'],
    // 新契约：presets = 启用哪些插件（owner 过滤）；tools = {include,exclude} 意图覆盖；hooks = 启用清单
    // （hooks 清单 = RECOMMENDED_HOOK_ORDER 的出厂子集，顺序即执行顺序；
    //  automatic 钩子由 collect 追加在显式清单之后，与 /api/agents 新建同基线）
    presets: [
      'agentchat-fs-tools', 'agentchat-fs-search-tools', 'agentchat-shell-tools', 'agentchat-web-tools',
      'agentchat-dev-tools', 'agentchat-plugin-tools', 'agentchat-session-tools',
      'agentchat-restart-tools', 'agentchat-interaction-tools',
      'agentchat-agent-tools', 'agentchat-timer-tools', 'agentchat-subagent-tools',
      'agentchat-math',
      'agentchat-hooks', 'agentchat-agent-prompt', 'agentchat-agent-persona',
      'agentchat-agent-datetime', 'agentchat-agent-session',
      'agentchat-agent-memory', 'agentchat-agent-mcp', 'agentchat-agent-skill',
      'agentchat-security',
    ],
    tools: { include: [], exclude: [] },
    hooks: {
      runStart: ['agent-mcp.open-mcp', 'agent-skill.discovered_skills', 'agent-persona.persona', 'agent-prompt.build-system-prompt', 'agent-datetime.datetime', 'agent-memory.load-memory', 'agent-session.load-history'],
      toolExecutionStart: ['security.security-check'],
      toolExecutionEnd: ['security.redact-output', 'hooks.log-tool'],
      runEnd: ['agent-session.save-session', 'agent-memory.update-memory', 'agent-session.idle-reset', 'agent-session.archive-session', 'agent-session.log-usage'],
    },
  }, null, 2), 'utf-8');
  logger.info(`首次运行：已创建默认 admin Agent（艾吉）: ${adminConfigPath}`);

  // 写首次运行标记（防止重启重复引导）
  try {
    fs.writeFileSync(path.join(workspaceDir, '.initialized'), new Date().toISOString(), 'utf-8');
  } catch { /* ignore */ }
}

/** 首次运行：向 user↔admin 会话注入自我介绍（幂等，仅空/不存在时写） */
export function injectFirstRunIntro(workspaceDir: string): void {
  try {
    const introMessage =
      '你好，我是艾吉 🤝 AgentChat 平台的守护者。\n' +
      '这是你第一次启动 AgentChat，我们聊聊怎么开始：\n' +
      '1. 配置全局 LLM：WebUI 左侧「设置」→「模型管理」添加 Provider 并填 API Key，这是所有 Agent 的思考引擎；\n' +
      '2. 创建第一个 Agent：WebUI「新建 Agent」，给它一个身份和职责，体验 Agent 社区；\n' +
      '3. 配置完成后回来找我，我会带新 Agent 跟你打招呼，展示社区的活力。\n' +
      '期待与你一起把社区经营得热闹起来！';
    const dialogKey = chatDialogKey('admin', 'user');
    const sessionDir = path.join(workspaceDir, 'sessions', dialogKey);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, 'messages.jsonl');
    const entry = {
      role: 'agent',
      content: introMessage,
      agent_id: 'admin',
      message_id: genMessageId(),
      timestamp: new Date().toISOString(),
    };
    if (!fs.existsSync(sessionFile) || fs.readFileSync(sessionFile, 'utf-8').trim() === '') {
      fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n', 'utf-8');
      logger.info(`首次运行：已注入艾吉自我介绍到 ${sessionFile}`);
    }
  } catch (err: any) {
    logger.warn(`首次引导消息注入失败: ${err?.message ?? String(err)}`);
  }
}

/** ctx.workspace —— 工作区初始化结果（boot-finalize 判读 firstRun） */
export class WorkspaceService extends Service {
  readonly isFirstRun: boolean;
  readonly workspaceDir: string;

  constructor(ctx: Context, result: WorkspaceInitResult) {
    super(ctx, 'workspace');
    this.isFirstRun = result.isFirstRun;
    this.workspaceDir = result.workspaceDir;
  }
}

/** 执行工作区初始化（不含 loadAgents；插件 apply 内调用） */
export function initializeWorkspace(core: WorkspaceCoreLike, templateRoots: string[] = []): WorkspaceInitResult {
  const workspaceDir = core.workspaceDir;
  const agentsDir = core.agentsDir;
  const roots = resolveTemplateRoots(core.srcRoot, templateRoots);

  copyWorkspaceGuides(workspaceDir, roots);
  ensureDefaultUser(agentsDir);

  const firstRun = isFirstRun(workspaceDir, agentsDir);
  if (firstRun) {
    ensureDefaultAdmin(workspaceDir, agentsDir);
    injectFirstRunIntro(workspaceDir);
  }

  logger.info(`工作区就绪（${firstRun ? '首次运行，需引导' : '已有环境'}）`);
  return { isFirstRun: firstRun, workspaceDir };
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 工作区初始化结果（@agentchat/workspace 插件行提供） */
    workspace: WorkspaceService;
  }
}
