// ============================================================
// ac-workspace —— 工作区初始化行（ctx.workspace）
//
// src svc/workspace 平移（地图 §3.2 落点）。preview 形态差异：
//   · 默认 user/admin = 数据 register（ctx.agents + agent-store
//     持久化；virtual user 见 ac-agents AgentConfig.virtual——
//     router 遇之只记事件不跑 loop）
//   · 首启消息经 ac-session append API（ADR-5：不直写会话文件——
//     src workspace 直写 messages.jsonl 的越权写消灭）
//   · browser 守护进程脚本随本包分发（files/browser_daemon.py →
//     <root>/files/shared/scripts/；M11 缺口补齐）——ac-web-tools
//     的 scriptPath 行配置指向该路径
//   · <root> 即"workspace 根统一"锚点（M11 遗留：会话级与工具行级
//     沙箱基准一致性依赖行配置约定——各持久化行 root 缺省 './data'
//     与本行对齐）
// ============================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Service, type Context } from '@agentchat/cordis';
import { pairKey } from 'ac-agent-loop';
import { createRootsContainment } from 'ac-sandbox-core';
import type { AgentConfig } from 'ac-agents';
import { runNativePickFolder, type NativePickOutcome } from './native-dialog.ts';
import { runNativeOpen, type NativeOpenOutcome } from './native-open.ts';

/** admin Agent 的行配置形态（model 必填；缺省不创建 admin） */
export interface WorkspaceAdminOptions extends Partial<Omit<AgentConfig, 'id' | 'virtual'>> {
  model: string;
}

/** 行配置 */
export interface WorkspaceRowOptions {
  /** 数据根（缺省 './data'；全部持久化行的统一锚点） */
  root?: string;
  /** admin Agent 配置（提供 model 才会创建/注册默认 admin） */
  admin?: WorkspaceAdminOptions;
  /** 首启自我介绍（缺省内置文案；空串 = 关闭） */
  intro?: string;
  /** browser 守护脚本分发（缺省开启；false = 关闭） */
  browserDaemon?: boolean;
}

/** 默认首启消息（src 艾吉文案适配 preview 形态） */
const DEFAULT_INTRO =
  '你好，我是这个工作区的管理员 Agent。\n' +
  '这是你第一次启动 AgentChat，我们聊聊怎么开始：\n' +
  '1. 配置 LLM：在组合根（cordis.yml / TREE）挂载模型适配行并配置密钥，这是所有 Agent 的思考引擎；\n' +
  '2. 创建第一个 Agent：向 agents 目录添加配置（数据即 Agent），给它一个身份和职责；\n' +
  '3. 配置完成后回来找我，我会带新 Agent 跟你打招呼。\n' +
  '期待与你一起把工作区经营得热闹起来！';

/** 包内 browser 守护脚本（分发源） */
const BROWSER_DAEMON_SRC = fileURLToPath(new URL('../files/browser_daemon.py', import.meta.url));

export class WorkspaceService extends Service {
  /**
   * 服务级依赖声明：本 fiber 的 store 在构造器执行前完成填充——
   * 构造期即可安全访问 ctx.agents/agentStore/session（本 cordis 的
   * 属性解析按 fiber 链 walk，raw this 的 ctx 只认自己 inject 的服务）。
   */
  static inject = ['agents', 'agentStore', 'session'];

  readonly root: string;
  readonly isFirstRun: boolean;
  /** 已懒建的 Agent 专用空间（ensureAgentWorkdir 幂等缓存） */
  private ensuredDirs = new Set<string>();
  // 【2026-12 裁决：HTTP 面敏感遮蔽已停用（注释保留，可一键恢复）】
  // AgentChat 是本地单用户应用，前端面（树/预览/raw 直链）读到的就是本机
  // 用户本人已可读的文件——工作区树不再对 .env/*.pem/id_rsa/凭据库等
  // 特殊项目隐藏，泄露后果由用户自担。停用面仅限本 HTTP 面；Agent 工具
  // 沙箱的 BUILTIN_DENY_PATTERNS（ac-security/fs 工具行）不受影响。
  // 恢复：还原下方四处 isDeniedPath 检查与构造器词表填充及本 import。
  // private readonly httpDeny: string[] = [];

  constructor(ctx: Context, options: WorkspaceRowOptions = {}) {
    super(ctx, 'workspace');
    this.root = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    // this.httpDeny.push(
    //   ...BUILTIN_DENY_PATTERNS,
    //   ...CONTROL_PLANE_FILES.map((rel) => path.join(this.root, rel)),
    // );

    // 1) 目录布局（其余子目录由各 owning 服务按需自建）
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(path.join(this.root, 'files', 'shared', 'scripts'), { recursive: true });

    // 2) browser 守护脚本分发（M11 缺口：ac-web-tools scriptPath 指向此处）
    if (options.browserDaemon !== false) this.distributeBrowserDaemon();

    // 3) 默认 user（virtual）+ admin（可选）= 数据 register
    this.ensureUser();
    const existingAdmin = this.ctx.agentStore.getAgent('admin');
    if (options.admin) {
      const config: AgentConfig = existingAdmin ?? {
        id: 'admin',
        model: options.admin.model,
        ...(options.admin.name ? { name: options.admin.name } : {}),
        ...(options.admin.provider ? { provider: options.admin.provider } : {}),
        ...(options.admin.system ? { system: options.admin.system } : {}),
        ...(options.admin.tools ? { tools: options.admin.tools } : {}),
        ...(options.admin.maxSteps != null ? { maxSteps: options.admin.maxSteps } : {}),
        ...(options.admin.description ? { description: options.admin.description } : {}),
        ...(options.admin.settings ? { settings: options.admin.settings } : {}),
      };
      if (!existingAdmin) {
        this.ctx.agentStore.saveAgent(config);
        this.ctx.logger.info('[workspace] 已创建默认 admin Agent');
      }
      this.registerIfAbsent(config); // 二次启动：store 有则直接物化
    }

    // 4) 首启检测（.initialized 标记 + admin 存在性）→ 首启消息
    this.isFirstRun = this.detectFirstRun();
    if (this.isFirstRun) {
      if (options.admin) this.injectIntro(options.intro ?? DEFAULT_INTRO);
      this.writeInitialized();
    }

    ctx.logger.info(
      '[workspace] 就绪（%C）',
      this.isFirstRun
        ? options.admin
          ? '首次运行，已注入引导'
          : '首次运行（未配置 admin，无引导消息）'
        : '已有环境',
    );
  }

  /** browser 守护脚本分发（存在即跳过；源缺失告警不阻塞） */
  private distributeBrowserDaemon(): void {
    const dest = path.join(this.root, 'files', 'shared', 'scripts', 'browser_daemon.py');
    if (fs.existsSync(dest)) return;
    try {
      fs.copyFileSync(BROWSER_DAEMON_SRC, dest);
      this.ctx.logger.info('[workspace] 已分发 browser 守护脚本: %C', dest);
    } catch {
      this.ctx.logger.warn('[workspace] browser 守护脚本分发失败（源缺失或不可读）');
    }
  }

  /** 默认 user（virtual）：store 持久化 + 注册表物化 */
  private ensureUser(): void {
    const existing = this.ctx.agentStore.getAgent('user');
    const config: AgentConfig = existing ?? {
      id: 'user',
      virtual: true,
      name: '用户',
      description: '用户（虚拟 Agent：会话参与方，不驱动 LLM 循环）',
    };
    if (!existing) this.ctx.agentStore.saveAgent(config);
    this.registerIfAbsent(config);
  }

  /** 注册表物化（已在册则跳过——ac-agents-dir 可能已扫过） */
  private registerIfAbsent(config: AgentConfig): void {
    if (this.ctx.agents.has(config.id)) return;
    this.ctx.agents.register(config); // fiber 归属本行：摘行即回收
  }

  /** 首启检测：无 .initialized 标记（admin 存在性已在构造路径保证） */
  private detectFirstRun(): boolean {
    return !fs.existsSync(path.join(this.root, '.initialized'));
  }

  /** 首启标记（防重启重复引导） */
  private writeInitialized(): void {
    try {
      fs.writeFileSync(path.join(this.root, '.initialized'), new Date().toISOString(), 'utf-8');
    } catch {
      /* 标记失败不影响运行（下次启动重复检测由 admin 存在性兜底） */
    }
  }

  /** 首启消息：经 ac-session append API（owning 落盘口，不直写文件）。
   *  M19：落 admin⇄user 对桶（用户与 admin 的直答对话首条问候）。 */
  private injectIntro(intro: string): void {
    if (!intro) return;
    void this.ctx.session
      .append(pairKey('admin', 'user'), 'admin', { role: 'assistant', content: intro })
      .catch((err: unknown) => {
        this.ctx.logger.warn('[workspace] 首启消息注入失败: %C', String(err));
      });
  }

  // ============================================================
  // Agent 专用空间（M18 前端反馈 #3：Agent 工作目录 = <root>/files/<id>）
  //
  // 布局约定（src 同款）：常规 Agent 的缺省沙箱工作目录与提示词
  // [工作目录] 都是 <root>/files/<agentId>/；预设 Agent（独立会话路由
  // 目标）无个人空间 → 工作区根；显式 settings['security'].workdir 最优先。
  // 本方法是该约定的唯一事实源——安全行（校验）、system-prompt（展示）、
  // 文件/命令工具行（解析）都经它取基准，三处永不漂移。
  // ============================================================

  /** Agent 专用空间目录（纯路径，不建目录）：常规 = files/<id>；预设/未知 = 工作区根 */
  agentWorkdir(agentId: string): string {
    const agent = this.ctx.agents.get(agentId);
    if (!agent || agent.preset || agent.virtual) return this.root;
    return path.join(this.root, 'files', agentId);
  }

  /** 同上，但懒建目录（工具行解析基准用——bash/write 等要求目录存在） */
  ensureAgentWorkdir(agentId: string): string {
    const dir = this.agentWorkdir(agentId);
    if (dir !== this.root && !this.ensuredDirs.has(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* 建目录失败由工具侧自然报错 */
      }
      this.ensuredDirs.add(dir);
    }
    return dir;
  }

  /**
   * Agent 专用空间内相对路径的「提示词形态」（归档/群整理提示词与记忆
   * 注入块共用的唯一事实源——原 ac-archive.anchorReviewPath /
   * ac-group.anchorOutput 同源逻辑上收，防三处漂移）：沙箱基准
   * （sandboxWorkdir）与专用空间一致（常规/预设 Agent）→ 相对路径
   * （提示词简洁、与专用空间布局同形）；显式 settings['security'].workdir
   * 分叉 → 专用空间绝对路径（沙箱已并根 agentSpaceRoots，绝对路径可达，
   * 相对路径会写错位置）。
   */
  agentRelPath(agentId: string, rel: string): string {
    const agentDir = path.resolve(this.agentWorkdir(agentId));
    const sandboxDir = this.sandboxWorkdir(agentId);
    if (sandboxDir !== undefined && path.resolve(sandboxDir) !== agentDir) {
      return path.join(agentDir, rel);
    }
    return rel;
  }

  /**
   * 沙箱工作目录推导（安全行/工具行共用；M24 A1 经 settingsOf 合成）：
   *   会话挂载工作区（singles workspaceId → 根）> 显式 settings['security'].workdir
   *   > Agent 专用空间 > undefined（调用方回落行缺省）。
   * 会话工作区是会话级意图（用户把该会话锚进项目目录——bash cwd / 相对
   * 路径基准 / 提示词 [工作目录] 随之指向工作区根，而非并白名单展示让
   * Agent 误判主战场；会话资产语义，无执行身份也生效）。预设 Agent →
   * 工作区根（src 语义：挂载文件夹 ?? 根）。
   */
  sandboxWorkdir(agentId: string | undefined, conversationId?: string): string | undefined {
    const wsRoot = this.conversationWorkspaceRoot(conversationId);
    if (wsRoot) return wsRoot;
    if (agentId === undefined) return undefined;
    const agent = this.ctx.agents.get(agentId);
    const security = this.ctx.agents.settingsOf(agentId, 'security');
    const explicit =
      security !== undefined && security !== null && typeof security === 'object'
        ? (security as { workdir?: unknown }).workdir
        : undefined;
    if (typeof explicit === 'string' && explicit) return path.resolve(explicit);
    if (!agent) return undefined;
    if (agent.preset) return this.root;
    if (agent.virtual) return undefined;
    return this.ensureAgentWorkdir(agentId);
  }

  /**
   * settings 级允许根并出面（allowedPaths 端到端，工具行基线消费）：
   * settings['security'].allowedPaths（settingsOf 合成——全局默认层 ∪
   * Agent 差异层，数组整体替换语义；相对条目由解析器按 workdir 解析）
   * ∪ **会话挂载工作区根**（2026-11：singles 会话挂了工作区 = 会话级
   * 授予——Agent 对工作区目录可读写，与 settings 授予同面并入；会话
   * 资产语义，无执行身份也生效；deny 黑名单仍优先于允许根。2026-12
   * 起会话工作区同时升为沙箱基准（sandboxWorkdir 最优先），本并面在
   * 标准链路里冗余保留——workspace 部分实现（mock/旧形态）基准不含
   * 会话语义时授予仍成立，不依赖调用方接线）。
   * 与 sandboxWorkdir 同为多方（工具行基线/安全行复检/提示词展示）共用
   * 的唯一事实源——显式授予不依赖 ac-security 行的 enabled 开关即生效。
   * 非字符串/空条目静默剔除；settings 与会话工作区同路径去重。
   */
  sandboxAllowedPaths(agentId: string | undefined, conversationId?: string): string[] {
    const out: string[] = [];
    if (agentId !== undefined) {
      const security = this.ctx.agents.settingsOf(agentId, 'security');
      const v =
        security !== undefined && security !== null && typeof security === 'object'
          ? (security as { allowedPaths?: unknown }).allowedPaths
          : undefined;
      if (Array.isArray(v)) {
        out.push(...v.filter((p): p is string => typeof p === 'string' && p.trim().length > 0));
      }
    }
    const wsRoot = this.conversationWorkspaceRoot(conversationId);
    if (wsRoot) out.push(wsRoot);
    return [...new Set(out)];
  }

  /**
   * 会话挂载工作区根（singles 记录 → workspaceId → 本机路径；其余会话
   * 形态/未挂工作区/行未装 = null）。会话工作区"挂载即基准/授予"的唯一
   * 事实源——四个消费面同源不漂移：
   *   · 沙箱基准（sandboxWorkdir 最优先——bash cwd / 相对路径锚 / 提示词
   *     [工作目录] 随之指向工作区根，2026-12 裁决）；
   *   · 沙箱允许根（sandboxAllowedPaths 并入 → 文件/命令工具行基线
   *     + ac-security 复检，ToolCall.conversationId 透传解析）；
   *   · 技能目录发现（ac-skill 工作区技能组）；
   *   · 提示词展示（ac-system-prompt [工作目录] 行）。
   * singles 为可选能力行（ctx.get 非 strict——未装 = 无会话工作区语义）。
   */
  conversationWorkspaceRoot(conversationId: string | undefined): string | null {
    if (!conversationId) return null;
    const singles = this.ctx.get('singles') as
      | { get(sid: string): { workspaceId?: string } | null }
      | undefined;
    const wsId = singles?.get(conversationId)?.workspaceId;
    if (!wsId) return null;
    return this.listWorkspaces().find((w) => w.id === wsId)?.path ?? null;
  }

  // ============================================================
  // M17-E：文件与工作区面（owning service——树读取 / 文件内容 /
  // 上传落盘 / 工作区登记）
  // ============================================================

  /**
   * 目录树（懒加载；path 相对树基准，空 = 基准根。会话区重构二轮：锚点自
   * <root>/files 上移到数据根——树可见 files/（Agent 专用空间）/ agents/
   *（Agent 数据）/ usage/ 等全域。dotfile 过滤仅作用于数据根基准（控制
   * 面噪音）；外挂工作区/Agent 专用空间如实列出（含 .dsh/.git 等项目
   * 目录）。敏感遮蔽已停用：2026-12 裁决——本地单用户应用，特殊项目
   * 不再对树隐藏）。
   * 树基准（M33 前端反馈 #1：工作区面板随会话上下文定位）：context 在场
   * 时与 sandboxWorkdir 同源优先序——会话挂载工作区 > Agent 级基准
   * （显式 settings.workdir > 专用空间 files/<id>）> 数据根；root.label
   * 回显基准名（前端标题展示；数据根 = 空串）。
   * 路径守卫：resolve 后必须仍在树基准内（防 ../ 越界）。
   */
  tree(
    relPath = '',
    context?: { agentId?: string; conversationId?: string },
  ): { path: string; children: WorkspaceNode[]; root: { label: string } } {
    const base = this.treeBase(context);
    const dir = this.resolveIn(base.dir, relPath);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { path: relPath, children: [], root: base };
    }
    const children: WorkspaceNode[] = [];
    // dotfile 过滤仅作用于数据根基准（.initialized 等控制面噪音 + 控制
    // 面 dotfile 双保险）；外挂工作区/Agent 专用空间（M33 树基准）是用户
    // 真实内容——.dsh/.git 等项目目录如实入树（前端反馈 #3：AgentChat
    // 项目工作区看不到 .dsh）
    const filterDots = base.dir === this.root;
    for (const e of entries) {
      if (filterDots && e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        children.push({ name: e.name, type: 'dir' });
      } else if (e.isFile()) {
        // if (isDeniedPath(this.httpDeny, path.join(dir, e.name))) continue; // 敏感遮蔽（2026-12 裁决停用）
        // 文件大小不入树（前端反馈：意义不大）——同除 statSync 每文件
        // 一次的开销；预览头部需要尺寸时由读面（readFile）自带
        children.push({ name: e.name, type: 'file' });
      }
    }
    children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: relPath, children, root: base };
  }

  /**
   * 树基准解析（tree() 单源）：context 缺席 = 数据根（原行为）；在场时与
   * sandboxWorkdir 同源优先序——会话挂载工作区 > Agent 级基准 > 数据根。
   * root.label = 前端标题用基准名：会话工作区用登记名、Agent 专用空间用
   * `Agent/<id>`、数据根空串（前端回落「工作区」）。
   */
  private treeBase(context?: { agentId?: string; conversationId?: string }): { dir: string; label: string } {
    if (context && (context.agentId || context.conversationId)) {
      // 会话挂载工作区（最优先——同 sandboxWorkdir）
      const convRoot = this.conversationWorkspaceRoot(context.conversationId);
      if (convRoot) {
        const wsName = this.listWorkspaces().find((w) => w.path === convRoot)?.name
          ?? path.basename(convRoot) ?? '';
        return { dir: convRoot, label: wsName };
      }
      // Agent 级基准（显式 settings.workdir > 专用空间 files/<id>；预设/
      // 未知 Agent = undefined → 数据根兜底）
      if (context.agentId) {
        const agent = this.ctx.agents.get(context.agentId);
        if (agent && !agent.preset && !agent.virtual) {
          const workdir = this.sandboxWorkdir(context.agentId);
          if (workdir && workdir !== this.root) {
            return { dir: workdir, label: `Agent/${context.agentId}` };
          }
        }
      }
    }
    return { dir: this.root, label: '' };
  }

  /**
   * 读文件内容（相对数据根；文本直读，二进制 base64）。大小上限（缺省
   * 4 MiB）超限抛错。`files/<bucket>/...`（saveUpload 返回形）天然直通
   * ——files 是数据根子目录，全链路引用无需前缀改写。敏感遮蔽已停用
   * （2026-12 裁决，见类头注释）。
   *
   * context（M32 文件预览工作区推导）：数据根快路径未命中时，按
   * Agent/会话工作区基准推导相对引用（Agent 在工作区内作业时回复常写
   * `src/app.ts` 之类相对路径——与沙箱基准 sandboxWorkdir 同源词表）：
   * 会话挂载工作区（singles）> Agent 级基准（显式 settings.workdir >
   * 专用空间 files/<id>）。命中基准内文件时直接读取（displayPath 回
   * 绝对路径——raw 直链/前端展示可追溯）；基准外/不存在照抛。
   */
  readFile(
    relPath: string,
    maxBytes = 4 * 1024 * 1024,
    context?: { agentId?: string; conversationId?: string },
  ): {
    path: string;
    content: string;
    base64: boolean;
    contentType: string;
    size: number;
  } {
    const { file, displayPath } = this.locateReadable(relPath, context);
    // if (isDeniedPath(this.httpDeny, file)) throw new Error('敏感文件，不可预览'); // 2026-12 裁决停用
    const stat = fs.statSync(file); // 不存在/目录 → 抛错（调用方转 404）
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 预览上限`);
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf-8');
    const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text.slice(0, 8192));
    return {
      path: displayPath,
      content: binary ? buf.toString('base64') : text,
      base64: binary,
      contentType: guessContentType(file),
      size: stat.size,
    };
  }

  /**
   * 解析文件绝对路径（raw 直链面；路径守卫同 readFile，敏感遮蔽已停用）。
   * 不存在/目录 → 抛错（调用方转 404）。
   * 【relPath 形态】`files/<bucket>/...`（saveUpload 返回形——files 是
   * 数据根子目录，上传引用/raw 直链/预览/多模态物化全链路直通）、
   * 数据根相对路径（树形）、或附 context 的工作区相对/绝对引用
   *（locateReadable 同源推导）。
   */
  resolveFile(
    relPath: string,
    context?: { agentId?: string; conversationId?: string },
  ): string {
    const { file } = this.locateReadable(relPath, context);
    // if (isDeniedPath(this.httpDeny, file)) throw new Error('敏感文件，不可访问'); // 2026-12 裁决停用
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('目标不是文件');
    return file;
  }

  /**
   * 读面定位（readFile/resolveFile 单源）：数据根快路径 → Agent/会话
   * 工作区基准推导。返回 { file: 绝对路径, displayPath: 回显路径 }。
   *   ① 数据根快路径（无 context 时即原行为）：根内词法解析；文件存在
   *     即中——不存在不抛，继续工作区基准（相对引用常根内不存在）。无
   *     context 时保持原语义：不存在/越界照抛原错误（路径越界 / stat
   *     失败）。根外绝对路径在有 context 时不在此抛越界（交由基准包含
   *     判定）。
   *   ② 工作区基准（仅 context 在场）：候选 = path.resolve(base, p)，
   *     词法+身份包含判定须落在 base 内（../ 逃逸照拒）；存在且为
   *     文件 → 命中（displayPath = 绝对路径）。
   * 全部未命中 → 抛「文件不存在或不可读」（调用方转 404）。
   */
  private locateReadable(
    p: string,
    context?: { agentId?: string; conversationId?: string },
  ): { file: string; displayPath: string } {
    const hasCtx = !!context && (!!(context.agentId || context.conversationId));
    // ① 数据根快路径
    let dataCandidate: string | undefined;
    try {
      dataCandidate = this.resolveIn(this.root, p);
    } catch (err) {
      if (!hasCtx) throw err; // 无 context：越界照抛（原行为）
      dataCandidate = undefined; // 根外绝对路径：交由基准包含判定
    }
    if (dataCandidate !== undefined) {
      // if (isDeniedPath(this.httpDeny, dataCandidate)) throw new Error('敏感文件，不可预览'); // 2026-12 裁决停用
      let st: fs.Stats;
      try {
        st = fs.statSync(dataCandidate);
      } catch (err) {
        if (!hasCtx) throw err; // 无 context：不存在照抛（原行为）
        st = undefined as unknown as fs.Stats; // 不存在 → 继续基准推导
      }
      if (st?.isFile()) return { file: dataCandidate, displayPath: p };
    }
    // ② 工作区基准推导（会话挂载工作区 > Agent 级基准——与 sandboxWorkdir
    //    同源优先序；基准去重，数据根（预设 Agent 基准）已被①覆盖不入列）
    for (const base of this.readBases(context)) {
      const cand = path.resolve(base, p);
      if (!createRootsContainment([base])(cand)) continue; // ../ 逃逸 / 基准外绝对路径
      // if (isDeniedPath(this.httpDeny, cand)) throw new Error('敏感文件，不可预览'); // 2026-12 裁决停用
      let st: fs.Stats;
      try {
        st = fs.statSync(cand);
      } catch {
        continue;
      }
      if (st.isFile()) return { file: cand, displayPath: cand };
    }
    throw new Error('文件不存在或不可读');
  }

  /** 读面工作区基准清单（locateReadable ②；无 context / 无可推导基准 = 空数组） */
  private readBases(context?: { agentId?: string; conversationId?: string }): string[] {
    if (!context || (!context.agentId && !context.conversationId)) return [];
    const bases: string[] = [];
    const conv = this.conversationWorkspaceRoot(context.conversationId);
    if (conv) bases.push(conv);
    // 无会话键取 Agent 级基准（sandboxWorkdir(agentId) 单参形态：显式
    // settings.workdir > 专用空间 files/<id>；预设 = 数据根已被①覆盖）
    const agent = this.sandboxWorkdir(context.agentId);
    if (agent && agent !== this.root) bases.push(agent);
    return [...new Set(bases.map((b) => path.resolve(b)))];
  }

  /**
   * 上传落盘：<root>/files/<agentId>/_tmp/<hash><ext>（缺省 shared/_tmp）。
   * 【内容寻址】storedName = 内容哈希（不再含时间戳）——同内容同名，
   * 已存在即跳过写入：重复粘贴/跨刷新/多标签页上传天然幂等，磁盘零
   * 重复（前端 contentHash12 去重之外的服务端兜底，owning 域单点）。
   * 【会话感知】conversationId 在场且 agentId 缺席时，从 singles 会话
   * 推导承载 Agent（sid → agentId）：常规 Agent 桶目录经
   * ensureAgentWorkdir（专用空间唯一事实源——显式 settings['security'].
   * workdir 分叉时仍落 files/<id> 保引用形态）；预设/虚拟无专用空间，
   * 直建 files/<id>/_tmp（read 基准 = 数据根，files/ 前缀引用天然可达）；
   * 未推导出 owner（非独立会话/行未装）→ shared（原行为）。
   */
  saveUpload(agentId: string | undefined, originalName: string, data: Buffer, conversationId?: string): {
    hash: string;
    storedName: string;
    originalName: string;
    size: number;
    path: string;
  } {
    const owner = agentId ?? this.uploadBucketAgent(conversationId);
    const bucket = owner ?? 'shared';
    const dir = owner !== undefined && !this.isPresetLike(owner)
      ? path.join(this.ensureAgentWorkdir(owner), '_tmp')
      : path.resolve(this.root, 'files', bucket, '_tmp');
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 12);
    const ext = path.extname(originalName).slice(0, 16).replace(/[^.\w-]/g, '');
    const storedName = `${hash}${ext}`;
    const file = path.join(dir, storedName);
    if (!fs.existsSync(file)) fs.writeFileSync(file, data); // 同内容幂等：不重复落盘
    return {
      hash,
      storedName,
      originalName,
      size: data.length,
      path: `files/${bucket}/_tmp/${storedName}`,
    };
  }

  /** 上传桶 Agent 的预设形态判定（预设/虚拟 → 不走专用空间事实源） */
  private isPresetLike(agentId: string): boolean {
    const agent = this.ctx.agents.get(agentId);
    return !agent || agent.preset === true || agent.virtual === true;
  }

  /**
   * 会话承载 Agent 推导（saveUpload 单源）：singles sid → agentId；
   * 非独立会话/行未装/未登记 → undefined。与会话身份口径
   * （single.agentId || defaultPresetId）不同：预设 Agent 无专用空间，
   * 推导层不回退默认预设——落 shared 桶（预设的 read 基准 = 数据根，
   * files/shared 引用天然可达，专用空间反而不可达）。
   */
  private uploadBucketAgent(conversationId: string | undefined): string | undefined {
    if (!conversationId) return undefined;
    const singles = this.ctx.get('singles') as
      | { get(sid: string): { agentId?: string } | null }
      | undefined;
    const sid = singles?.get(conversationId)?.agentId;
    return typeof sid === 'string' && sid ? sid : undefined;
  }

  // ---- 工作区登记（<root>/workspaces.json；owning 持久化） ----

  /** 登记工作区（本机文件夹；沙箱白名单根与文件树根分组锚点） */
  registerWorkspace(wsPath: string, name?: string): WorkspaceRegistration {
    const docs = this.readWorkspaces();
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: WorkspaceRegistration = {
      id,
      name: name?.trim() || path.basename(wsPath) || wsPath,
      path: wsPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    docs.push(item);
    this.writeWorkspaces(docs);
    return item;
  }

  listWorkspaces(): WorkspaceRegistration[] {
    return this.readWorkspaces();
  }

  updateWorkspace(id: string, patch: { name?: string; path?: string }): WorkspaceRegistration | undefined {
    const docs = this.readWorkspaces();
    const item = docs.find((w) => w.id === id);
    if (!item) return undefined;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.path !== undefined) item.path = patch.path;
    item.updatedAt = new Date().toISOString();
    this.writeWorkspaces(docs);
    return item;
  }

  removeWorkspace(id: string): boolean {
    const docs = this.readWorkspaces();
    const next = docs.filter((w) => w.id !== id);
    if (next.length === docs.length) return false;
    this.writeWorkspaces(next);
    return true;
  }

  private resolveIn(root: string, relPath: string): string {
    const full = path.resolve(root, relPath || '.');
    // 同源包含判定（ac-sandbox-core）：词法 + 身份回退——同一文件的大小写
    // 变体/junction 别名词形（手输或拼贴的绝对路径）不误判越界；真越界照拦
    if (!createRootsContainment([root])(full)) {
      throw new Error('路径越界（仅限工作区目录内）');
    }
    return full;
  }

  // ============================================================
  // M18：本机目录浏览（路径穿透白名单的文件夹选择弹窗数据源）。
  // 与 tree() 的区别：tree 锁死 <root>/files 内；白名单语义恰是工作区
  // 【之外】的本机路径——浏览范围放开到全盘（只列目录名，不读文件内容）。
  // ============================================================

  /** 目录浏览快捷根（弹窗起始锚点：家目录 / 数据根 / 已登记工作区） */
  browseRoots(): Array<{ name: string; path: string }> {
    const roots: Array<{ name: string; path: string }> = [];
    const home = os.homedir();
    if (home) roots.push({ name: `家目录（${path.basename(home) || home}）`, path: home });
    roots.push({ name: '数据根（AgentChat）', path: this.root });
    for (const w of this.listWorkspaces()) roots.push({ name: `工作区：${w.name}`, path: w.path });
    if (process.platform === 'win32') {
      // Windows 盘符（存在性探测；网络盘/光驱静默跳过）
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:\\`;
        try {
          fs.statSync(drive);
          roots.push({ name: drive, path: drive });
        } catch {
          /* 不存在的盘符跳过 */
        }
      }
    }
    // 去重（同路径只留首个）
    const seen = new Set<string>();
    return roots.filter((r) => {
      const key = r.path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 浏览一个绝对路径的子目录清单（只列目录，不列文件）。
   * path 为空 → 快捷根；否则须为绝对路径。无权限/不存在 → error 字段
   * （不抛错，弹窗降级显示）。
   * opts.files = true 时附带常规文件清单（只列名不读内容——配置弹窗的
   * 文件路径选择，如 persona file；与目录名同级曝光面，同一信任边界）。
   */
  browseDirs(dirPath: string, opts?: { files?: boolean }): {
    path: string;
    parent?: string;
    roots?: Array<{ name: string; path: string }>;
    dirs: Array<{ name: string; path: string }>;
    files?: Array<{ name: string; path: string }>;
    error?: string;
  } {
    if (!dirPath) {
      return { path: '', roots: this.browseRoots(), dirs: [] };
    }
    const target = path.resolve(dirPath);
    if (!path.isAbsolute(dirPath)) {
      return { path: dirPath, dirs: [], error: '须为绝对路径' };
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err: unknown) {
      return {
        path: target,
        parent: path.dirname(target),
        dirs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const dirs: Array<{ name: string; path: string }> = [];
    const files: Array<{ name: string; path: string }> = [];
    for (const e of entries) {
      // lstat 语义：符号链接目录也算（跨树跳转对白名单有用）
      if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(target, e.name) });
      else if (opts?.files && e.isFile()) files.push({ name: e.name, path: path.join(target, e.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return {
      path: target,
      ...(parent !== target ? { parent } : {}),
      dirs,
      ...(opts?.files ? { files } : {}),
    };
  }

  /**
   * 用系统默认程序本地打开文件（前端「本地打开」动作）。路径定位与
   * 守卫同 resolveFile 单源（locateReadable 工作区推导 + 敏感遮蔽 +
   * statSync 存在性），编排住纯模块 native-open。select = 文件管理器
   * 定位形态（win 资源管理器选中 / Finder reveal / linux 退化开父目录）。
   */
  async openLocal(relPath: string, context?: { agentId?: string; conversationId?: string }): Promise<NativeOpenOutcome> {
    let file: string;
    try {
      file = this.resolveFile(relPath, context);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    return runNativeOpen(file, { select: false });
  }

  /**
   * 用系统文件管理器打开目录（前端「本地资源管理器」动作——会话侧边栏
   * 工作区节点 / 辅助侧边栏工作区面板头部）。目录解析与守卫住
   * resolveOpenDir 单源；编排复用 runNativeOpen（目录目标 = 打开文件夹：
   * win explorer / darwin open / linux xdg-open）。
   */
  async openDir(opts: { workspaceId?: string; agentId?: string; conversationId?: string }): Promise<NativeOpenOutcome> {
    const resolved = this.resolveOpenDir(opts);
    return 'error' in resolved ? resolved : runNativeOpen(resolved.dir, { select: false });
  }

  /**
   * 「本地资源管理器」目录解析（openDir 单源）：workspaceId 在场 =
   * 登记工作区文件夹；缺席按 treeBase 树基准推导（会话挂载工作区 >
   * Agent 级基准 > 数据根——与工作区树面板同基准）。守卫：工作区未登记 /
   * 目录不存在 / 非目录 → error（不抛错，前端按钮态就地显示）。
   */
  resolveOpenDir(opts: { workspaceId?: string; agentId?: string; conversationId?: string }): { dir: string } | { error: string } {
    let dir: string;
    if (opts.workspaceId) {
      const ws = this.listWorkspaces().find((w) => w.id === opts.workspaceId);
      if (!ws) return { error: `工作区不存在：${opts.workspaceId}` };
      dir = ws.path;
    } else {
      dir = this.treeBase(
        opts.agentId || opts.conversationId
          ? { agentId: opts.agentId, conversationId: opts.conversationId }
          : undefined,
      ).dir;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      return { error: `文件夹不存在或不可访问：${dir}` };
    }
    if (!st.isDirectory()) return { error: `目标不是文件夹：${dir}` };
    return { dir };
  }

  /**
   * 本机系统原生文件夹选择对话框（工作区登记「选择文件夹」的主路径；
   * 编排/协议住纯模块 native-dialog）。结果三态：path（选定——服务端
   * 不再二次校验，登记口 registerWorkspace 既有存在性校验兜底）/
   * cancelled（用户取消，前端静默收场）/ error（平台无选择器或启动失败
   * ——前端降级回 browseDirs 应用内浏览弹窗）。阻塞至用户完成操作，
   * 纯模块 10 分钟超时兜底。
   */
  pickFolder(title?: string): Promise<NativePickOutcome> {
    return runNativePickFolder({ title });
  }

  private workspacesFile(): string {
    return path.join(this.root, 'workspaces.json');
  }

  private readWorkspaces(): WorkspaceRegistration[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.workspacesFile(), 'utf-8');
    } catch {
      return []; // 缺文件 = 首启合法空态
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as WorkspaceRegistration[];
      throw new Error('非 array 形态');
    } catch (err: unknown) {
      // 损坏不静默（防后续写口以空表覆写唯一副本——凭据域 B2 同款防线）：
      // 留档 .corrupt 后从空档开始
      try {
        fs.renameSync(this.workspacesFile(), `${this.workspacesFile()}.corrupt`);
      } catch {
        /* 留档失败不阻塞启动 */
      }
      this.ctx.logger.warn(
        `[workspace] workspaces.json 损坏（${err instanceof Error ? err.message : String(err)}）——已留档 .corrupt，从空档重新开始`,
      );
      return [];
    }
  }

  private writeWorkspaces(docs: WorkspaceRegistration[]): void {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.workspacesFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(docs, null, 2), 'utf-8');
    fs.renameSync(tmp, this.workspacesFile());
  }
}

/** 工作区登记记录（<root>/workspaces.json 行形状） */
export interface WorkspaceRegistration {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

/** 工作区节点（树读取投影） */
export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
}

/** 原生文件夹选择结果三态（pickFolder；编排放 src/native-dialog.ts 纯模块） */
export type { NativePickOutcome } from './native-dialog.ts';

/**
 * 【已退役】剥离 `files/` 前缀的归一化：会话区重构二轮锚点上移数据根后
 * 不再需要——`files/<bucket>/...` 是数据根的真实相对路径（子目录直通），
 * 剥前缀反而错位。裸 `<bucket>/...` 语义随之变化：数据根相对（原为
 * files 根相对）；树/上传引用全链路均产 `files/` 前缀形，无遗留消费方。
 */

/** 内容类型猜测表（预览/直链用） */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/** 简易内容类型猜测（预览/直链用） */
export function guessContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 工作区初始化结果（ac-workspace 提供）：root + isFirstRun + 默认 Agent 物化 */
    workspace: WorkspaceService;
  }
}

export const name = 'ac-workspace';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'workspace',
  label: '工作区服务',
  description: 'Agent 工作目录/文件浏览锚点（数据根统一 AGENTCHAT_DATA_ROOT；目录白名单浏览 RPC）',
  automatic: true,
};


export function apply(ctx: Context, options: WorkspaceRowOptions = {}) {
  // 纯后端行（M27.1，D19 改裁）：前端半边 = ac-client-ui-workspace 独立 UI 行
  ctx.plugin(WorkspaceService, options);
}
