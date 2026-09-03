// ============================================================
// ac-memory —— 长期记忆服务（事件化扩展四件套之一，M14 扩展）
//
// src 轨道映射：agent-memory 的 load-memory runStartHook（memory
// 拼接到 system 末尾）→ preview 的 loop/before-run waterfall：
// 记忆文本以 <memory> 块追加到 request.system 末尾。
//
// 存储与维护口径（2026-09 裁决：记忆面收敛为 fs 工具兼容）：
//   · 记忆文件 = <agentWorkdir(agentId)>/memory/<会话键>.md——落在
//     Agent 专用空间（files/<agentId>/）内，read/write/edit 等 fs
//     工具直接可达；预设 Agent 的 agentWorkdir = 数据根（路径同
//     旧全局布局 <root>/memory/<会话键>.md，存量 singles 不动）。
//   · 会话键 = conversationId（1v1 对键 / 群 id / singles sid），
//     文件名即键（键词法已由 assertAgentId / assertGroupId 保证
//     无路径分隔）。记忆归 Agent 本人：对桶两侧各自一份
//     （files/<a>/memory/a~b.md 与 files/<b>/memory/a~b.md），
//     互不覆盖。
//   · LLM 侧维护 = Agent 用 fs 工具直接重写记忆文件（memory_append /
//     memory_rewrite 专用工具已移除——与 fs 工具能力重叠）；本服务
//     注入时**每次直读文件**（不做读缓存），Agent 的 fs 外写即时可见。
//   · 程序化写口（宿主/测试/未来插件）：set/append/remove 服务 API
//     照常（原子写）。
//
// 注入预算：settings['memory'].maxTokens ?? 行配置 ?? 缺省 2000——
// 超预算保留尾部近期记忆（ac-memory-core 截断剪除）；
// settings['memory'] = { enabled?, maxTokens? } per-Agent 管控
// （M24 A1 经 settingsOf 合成全局默认层；可选能力：agents 未装时
// 按行缺省——记忆核心不依赖 agents）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { clipMemoryForInjection } from 'ac-memory-core';
import type {} from 'ac-agents'; // ctx.agents 可选能力类型（type-only）

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface MemoryRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；未装 workspace 行时记忆 = <root>/files/<agentId>/memory） */
  root?: string;
  /** 注入 token 预算缺省（per-Agent settings['memory'].maxTokens 覆盖；<=0 不截断） */
  maxTokens?: number;
  /** 文件持久化开关（缺省 true；false = 纯内存——测试/演示） */
  persist?: boolean;
}

/** settings['memory'] 配置形状（per-Agent；形状由本插件自定义） */
export interface MemorySettings {
  /** 缺省 true；false = 本 Agent 软停用（ADR-4） */
  enabled?: boolean;
  /** 注入 token 预算（覆盖行配置缺省；<=0 不截断） */
  maxTokens?: number;
}

/** 注入预算缺省（token） */
const DEFAULT_MAX_TOKENS = 2000;

/** 会话键校验：禁路径分隔/遍历（文件名即会话键——规约 2） */
function assertMemoryKey(key: string): void {
  if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) {
    throw new Error(`memory key "${key}" 非法（禁路径分隔/遍历字符）`);
  }
}

/** 纯内存后端存储键（persist=false；Agent 维度 × 会话键） */
function storeKey(agentId: string, key: string): string {
  return `${agentId}\u0000${key}`;
}

/** 原子写：临时文件 + rename（各 owning service 自持写法） */
function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/** workspace 服务的最小结构面（结构化读取，不引运行时依赖） */
interface WorkdirSource {
  agentWorkdir(agentId: string): string;
}

export class MemoryService extends Service {
  private dataRoot: string;
  private persist: boolean;
  private defaultMaxTokens: number;
  /** 纯内存后端（persist=false；键 = storeKey） */
  private store = new Map<string, string>();

  constructor(ctx: Context, options: MemoryRowOptions = {}) {
    super(ctx, 'memory');
    this.dataRoot = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data');
    this.persist = options.persist !== false;
    this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.ctx.on('loop/before-run', (call, next) => {
      // 记忆归 Agent 本人：键 = 会话桶（conversationId ?? agent），文件
      // 落该 Agent 的专用空间——无 agent 身份（子 Agent/loop 直连）无锚点，
      // 不注入
      const agentId = call.request.agent;
      const key = call.request.conversationId ?? agentId;
      if (agentId === undefined || key === undefined) return next();

      // settings['memory'] per-Agent 管控（M24 A1：settingsOf 合成全局默认层；
      // 可选能力：agents 未装时按行缺省）
      const agents = this.ctx.get('agents');
      const settingsCfg = agents ? agents.settingsOf(agentId, 'memory') : undefined;
      let maxTokens = this.defaultMaxTokens;
      if (settingsCfg !== undefined && settingsCfg !== null && typeof settingsCfg === 'object') {
        const memorySettings = settingsCfg as MemorySettings;
        if (memorySettings.enabled === false) return next();
        if (typeof memorySettings.maxTokens === 'number') maxTokens = memorySettings.maxTokens;
      }

      const memory = this.get(agentId, key);
      if (memory) {
        const block = `<memory>\n${clipMemoryForInjection(memory, maxTokens)}\n</memory>`;
        call.request = {
          ...call.request,
          system: call.request.system ? `${call.request.system}\n\n${block}` : block,
        };
      }
      return next();
    }, { description: '长期记忆注入 <memory> 块（预算截断）' });
  }

  /** 记忆目录：Agent 专用空间（workspace.agentWorkdir 唯一事实源；未装
   *  workspace 行回落 <dataRoot>/files/<agentId>/ 同一约定——与 ac-archive
   *  概要文件落点口径一致） */
  private memoryDirOf(agentId: string): string {
    const ws = this.ctx.get('workspace') as WorkdirSource | undefined;
    return path.join(ws ? ws.agentWorkdir(agentId) : path.join(this.dataRoot, 'files', agentId), 'memory');
  }

  /** 记忆文件路径（files/<agentId>/memory/<会话键>.md） */
  fileOf(agentId: string, key: string): string {
    assertMemoryKey(key);
    return path.join(this.memoryDirOf(agentId), `${key}.md`);
  }

  /** 写入/覆盖记忆（宿主/测试/未来插件的程序化写口）；原子落盘 */
  set(agentId: string, key: string, memory: string): void {
    assertMemoryKey(key);
    if (!this.persist) {
      this.store.set(storeKey(agentId, key), memory);
      return;
    }
    writeAtomic(this.fileOf(agentId, key), memory);
  }

  /** 追加记忆行（程序化累积写入口） */
  append(agentId: string, key: string, line: string): void {
    const current = this.get(agentId, key) ?? '';
    this.set(agentId, key, current ? `${current}\n${line}` : line);
  }

  /**
   * 读取记忆。persist 模式**每次直读文件**（无读缓存）：Agent 经 fs
   * 工具的外写（不经本服务）即时可见——记忆文件的维护主路径就是
   * Agent 亲自 read/write/edit，缓存会让注入读到陈旧值。
   */
  get(agentId: string, key: string): string | undefined {
    assertMemoryKey(key);
    if (!this.persist) return this.store.get(storeKey(agentId, key));
    try {
      const file = this.fileOf(agentId, key);
      if (!fs.existsSync(file)) return undefined;
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** 删除记忆（内存 + 文件） */
  remove(agentId: string, key: string): boolean {
    assertMemoryKey(key);
    const existedStore = this.store.delete(storeKey(agentId, key));
    if (!this.persist) return existedStore;
    const file = this.fileOf(agentId, key);
    const onDisk = fs.existsSync(file);
    if (onDisk) fs.rmSync(file);
    return existedStore || onDisk;
  }

  /** 该 Agent 的全部记忆键（诊断） */
  ids(agentId: string): string[] {
    const keys = new Set(
      [...this.store.keys()]
        .filter((k) => k.startsWith(`${agentId}\u0000`))
        .map((k) => k.slice(agentId.length + 1)),
    );
    if (this.persist) {
      try {
        for (const f of fs.readdirSync(this.memoryDirOf(agentId))) {
          if (f.endsWith('.md')) keys.add(f.slice(0, -'.md'.length));
        }
      } catch {
        /* 目录不存在 */
      }
    }
    return [...keys];
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 长期记忆服务（ac-memory 提供）：files/<agentId>/memory/<会话键>.md；before-run 注入 <memory> 块 */
    memory: MemoryService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: invalidate-from-X —— <memory> 块
// 在 system 位（指令强度优先，M21 D4 裁决）：记忆文件变化（Agent fs 重写
// 或程序化 set）使该桶 system 变化 → 一次全量前缀 reset（失效面单桶；
// §4.4 本期显式接受，尾部注入优化后议）。内容不变则字节不变（预算截断
// 确定性）。

export const name = 'ac-memory';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'memory',
  label: '记忆加载',
  description: '长期记忆注入 <memory> 块（文件 = Agent 专用空间 memory/<会话键>.md，Agent 经 fs 工具自行维护；maxTokens 预算截断）',
  fields: [
    { name: 'maxTokens', type: 'number', min: 0, step: 1000, default: DEFAULT_MAX_TOKENS, description: '记忆注入 token 预算——尾部近期记忆保留 + 截断标记' },
    { name: 'enabled', type: 'boolean', default: true, description: '行为门控（软停用，行仍装载；Agent 可覆盖）——与装配开关不同层' },
  ],
  listeners: [{ event: 'loop/before-run', role: '<memory> 块注入', description: 'Agent 循环启动前拦截（人格注入/预算控制/直接否决）', respectsEnabled: true }],
};


export function apply(ctx: Context, options: MemoryRowOptions = {}) {
  ctx.plugin(MemoryService, options);
}
