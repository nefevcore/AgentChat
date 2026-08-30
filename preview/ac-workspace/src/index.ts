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
import type { AgentConfig } from 'ac-agents';

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

  constructor(ctx: Context, options: WorkspaceRowOptions = {}) {
    super(ctx, 'workspace');
    this.root = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');

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
   * 沙箱工作目录推导（安全行/工具行共用；M24 A1 经 settingsOf 合成）：
   *   显式 settings['security'].workdir > Agent 专用空间 > undefined（调用方回落行缺省）。
   * 预设 Agent → 工作区根（src 语义：挂载文件夹 ?? 根）。
   */
  sandboxWorkdir(agentId: string | undefined): string | undefined {
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

  // ============================================================
  // M17-E：文件与工作区面（owning service——树读取 / 文件内容 /
  // 上传落盘 / 工作区登记）
  // ============================================================

  /**
   * 目录树（懒加载；path 相对 <root>/files，空 = 根）。
   * 路径守卫：resolve 后必须仍在 files 根内（防 ../ 越界）。
   */
  tree(relPath = ''): { path: string; children: WorkspaceNode[] } {
    const root = path.resolve(this.root, 'files');
    const dir = this.resolveIn(root, relPath);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { path: relPath, children: [] };
    }
    const children: WorkspaceNode[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        children.push({ name: e.name, type: 'dir' });
      } else if (e.isFile()) {
        try {
          children.push({ name: e.name, type: 'file', size: fs.statSync(path.join(dir, e.name)).size });
        } catch {
          children.push({ name: e.name, type: 'file' });
        }
      }
    }
    children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: relPath, children };
  }

  /**
   * 读文件内容（相对 <root>/files；文本直读，二进制 base64）。
   * 大小上限（缺省 4 MiB）超限抛错。
   */
  readFile(relPath: string, maxBytes = 4 * 1024 * 1024): {
    path: string;
    content: string;
    base64: boolean;
    contentType: string;
    size: number;
  } {
    const file = this.resolveIn(path.resolve(this.root, 'files'), relPath);
    const stat = fs.statSync(file); // 不存在/目录 → 抛错（调用方转 404）
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > maxBytes) throw new Error(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 预览上限`);
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf-8');
    const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text.slice(0, 8192));
    return {
      path: relPath,
      content: binary ? buf.toString('base64') : text,
      base64: binary,
      contentType: guessContentType(file),
      size: stat.size,
    };
  }

  /**
   * 解析文件绝对路径（raw 直链面；路径守卫同上）。
   * 不存在/目录 → 抛错（调用方转 404）。
   */
  resolveFile(relPath: string): string {
    const file = this.resolveIn(path.resolve(this.root, 'files'), relPath);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('目标不是文件');
    return file;
  }

  /** 上传落盘：<root>/files/<agentId>/_tmp/<storedName>（缺省 shared/_tmp） */  saveUpload(agentId: string | undefined, originalName: string, data: Buffer): {
    hash: string;
    storedName: string;
    originalName: string;
    size: number;
    path: string;
  } {
    const bucket = agentId ? agentId : 'shared';
    const dir = path.resolve(this.root, 'files', bucket, '_tmp');
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 12);
    const ext = path.extname(originalName).slice(0, 16).replace(/[^.\w-]/g, '');
    const storedName = `${Date.now().toString(36)}-${hash}${ext}`;
    fs.writeFileSync(path.join(dir, storedName), data);
    return {
      hash,
      storedName,
      originalName,
      size: data.length,
      path: `files/${bucket}/_tmp/${storedName}`,
    };
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
    if (full !== root && !full.startsWith(root + path.sep)) {
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
   */
  browseDirs(dirPath: string): {
    path: string;
    parent?: string;
    roots?: Array<{ name: string; path: string }>;
    dirs: Array<{ name: string; path: string }>;
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
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // lstat 语义：符号链接目录也算（跨树跳转对白名单有用）
      dirs.push({ name: e.name, path: path.join(target, e.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return {
      path: target,
      ...(parent !== target ? { parent } : {}),
      dirs,
    };
  }

  private workspacesFile(): string {
    return path.join(this.root, 'workspaces.json');
  }

  private readWorkspaces(): WorkspaceRegistration[] {
    try {
      const raw = fs.readFileSync(this.workspacesFile(), 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as WorkspaceRegistration[]) : [];
    } catch {
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
  size?: number;
}

/** 简易内容类型猜测（预览/直链用） */
export function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
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
  return map[ext] ?? 'application/octet-stream';
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 工作区初始化结果（ac-workspace 提供）：root + isFirstRun + 默认 Agent 物化 */
    workspace: WorkspaceService;
  }
}

export const name = 'ac-workspace';

export function apply(ctx: Context, options: WorkspaceRowOptions = {}) {
  ctx.plugin(WorkspaceService, options);
}
