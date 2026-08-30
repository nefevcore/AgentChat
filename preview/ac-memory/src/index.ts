// ============================================================
// ac-memory —— 长期记忆服务（事件化扩展四件套之一，M14 扩展）
//
// src 轨道映射：agent-memory 的 load-memory runStartHook（memory
// 拼接到 system 末尾）→ preview 的 loop/before-run waterfall：
// 记忆文本以 <memory> 块追加到 request.system 末尾。
//
// M14 扩展（地图 §3.2）：
//   · 键 = conversationId（与会话桶统一——规约 2 寻址不变量）：
//     1v1 缺省 agentId、群 = 组 id；request.conversationId ?? agent
//   · 文件后端（ADR-5 本服务拥有记忆存储）：<root>/memory/<key>.md
//     原子写；persist=false 时纯内存（测试/演示）
//   · 注入预算：settings['memory'].maxTokens ?? 行配置 ?? 缺省 2000——
//     超预算保留尾部近期记忆（ac-memory-core 截断剪除）
//   · settings['memory'] = { enabled?, maxTokens? } per-Agent 管控
//     （M24 A1 经 settingsOf 合成全局默认层；可选能力：agents 未装时
//     按行缺省——记忆核心不依赖 agents）
//
// 记忆维护（归档整理 run 写记忆等）经 set/append/remove API——
// 维护策略由订阅 loop/after-run 的编排行实现（ac-archive 联动归
// 后续里程碑）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';
import { clipMemoryForInjection } from 'ac-memory-core';
import type {} from 'ac-agents'; // ctx.agents 可选能力类型（type-only）
import type { ToolResult } from 'ac-tools';

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface MemoryRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；记忆目录 = <root>/memory） */
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

/** 原子写：临时文件 + rename（各 owning service 自持写法） */
function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

export class MemoryService extends Service {
  private memoryDir: string;
  private persist: boolean;
  private defaultMaxTokens: number;
  private store = new Map<string, string>();

  constructor(ctx: Context, options: MemoryRowOptions = {}) {
    super(ctx, 'memory');
    this.memoryDir = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'memory');
    this.persist = options.persist !== false;
    this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.ctx.on('loop/before-run', (call, next) => {
      // 键 = 会话桶（conversationId ?? agent；均无 = 子 Agent/直连，无长期记忆语义）
      const key = call.request.conversationId ?? call.request.agent;
      if (key === undefined) return next();

      // settings['memory'] per-Agent 管控（M24 A1：settingsOf 合成全局默认层；
      // 可选能力：agents 未装时按行缺省）
      const agentId = call.request.agent;
      const agents = this.ctx.get('agents');
      const settingsCfg = agentId && agents ? agents.settingsOf(agentId, 'memory') : undefined;
      let maxTokens = this.defaultMaxTokens;
      if (settingsCfg !== undefined && settingsCfg !== null && typeof settingsCfg === 'object') {
        const memorySettings = settingsCfg as MemorySettings;
        if (memorySettings.enabled === false) return next();
        if (typeof memorySettings.maxTokens === 'number') maxTokens = memorySettings.maxTokens;
      }

      const memory = this.get(key);
      if (memory) {
        const block = `<memory>\n${clipMemoryForInjection(memory, maxTokens)}\n</memory>`;
        call.request = {
          ...call.request,
          system: call.request.system ? `${call.request.system}\n\n${block}` : block,
        };
      }
      return next();
    });
  }

  /** 记忆目录根（诊断用） */
  get root(): string {
    return this.memoryDir;
  }

  /** 写入/覆盖记忆（维护方调用：归档整理、显式 API 等）；原子落盘 */
  set(key: string, memory: string): void {
    assertMemoryKey(key);
    this.store.set(key, memory);
    if (this.persist) writeAtomic(path.join(this.memoryDir, `${key}.md`), memory);
  }

  /** 追加记忆行（归档整理的累积写入口） */
  append(key: string, line: string): void {
    const current = this.get(key) ?? '';
    this.set(key, current ? `${current}\n${line}` : line);
  }

  /** 读取记忆（内存优先；未命中回读文件——跨重启恢复） */
  get(key: string): string | undefined {
    assertMemoryKey(key);
    const cached = this.store.get(key);
    if (cached !== undefined) return cached;
    if (!this.persist) return undefined;
    try {
      const file = path.join(this.memoryDir, `${key}.md`);
      if (!fs.existsSync(file)) return undefined;
      const content = fs.readFileSync(file, 'utf-8');
      this.store.set(key, content);
      return content;
    } catch {
      return undefined;
    }
  }

  /** 删除记忆（内存 + 文件） */
  remove(key: string): boolean {
    assertMemoryKey(key);
    const file = this.persist ? path.join(this.memoryDir, `${key}.md`) : undefined;
    const existed = this.store.delete(key) || (file !== undefined && fs.existsSync(file));
    if (file !== undefined && fs.existsSync(file)) fs.rmSync(file);
    return existed;
  }

  /** 全部记忆键（内存 + 磁盘并集，诊断） */
  ids(): string[] {
    const keys = new Set(this.store.keys());
    if (this.persist) {
      try {
        for (const f of fs.readdirSync(this.memoryDir)) {
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
    /** 长期记忆服务（ac-memory 提供；键=conversationId，before-run 注入 <memory> 块） */
    memory: MemoryService;
  }
}

// KV Cache effect（M21/D9 声明纪律）: invalidate-from-X —— <memory> 块
// 在 system 位（指令强度优先，M21 D4 裁决）：记忆追加/重写使该桶 system
// 变化 → 一次全量前缀 reset（失效面单桶；§4.4 本期显式接受，尾部注入
// 优化后议）。内容不变则字节不变（预算截断确定性）。

export const name = 'ac-memory';

export function apply(ctx: Context, options: MemoryRowOptions = {}) {
  ctx.plugin(MemoryService, options);

  // ---- memory_append / memory_rewrite 工具（LLM 侧写口收敛；M20 补 rewrite） ----
  // src 的记忆维护 = Agent 用 fs 工具重写 memory.md；preview 记忆住
  // ctx.memory 服务（ADR-5 owning），LLM 侧写口收敛为本二工具：
  //   · append 累积写（日常记录；误改写不至清空，预算截断保注入上限）
  //   · rewrite 全量重写（归档整理 run："合并重复、删除过时，不要只
  //     追加"——对齐 src triggerReview 提示词；服务面 set 早已存在）
  // 键 = 执行身份（conversationId ?? agentId，与服务注入键同口径）。
  // 服务解析用 ctx.get（root-traced）：工具体在调用方 fiber 内执行
  // （loop→tools 链），注入子域闭包的 ctx 解析不到本行 provide 的
  // memory（M15 起的潜在断链，M20 实测修复）。
  // ctx.inject：tools 是可选能力——到位时注册（零行序假设），未装则无工具面。
  ctx.inject(['tools'], (c) => {
    c.tools.register({
      name: 'memory_append',
      description:
        '向当前会话的长期记忆追加一条内容（跨会话保留；下次对话自动注入）。用于记录用户偏好、重要决策、长期有效的约定。日常对话内容不要写入。',
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: '要记住的内容（一行；简洁、自包含、未来仍可理解）' },
        },
        required: ['line'],
      },
      execute(args, call): ToolResult {
        const key = call.conversationId ?? call.agentId;
        if (key === undefined) {
          return { ok: false, error: '缺少会话上下文（memory_append 需在 Agent run 内调用）' };
        }
        const line = String(args.line ?? '').trim();
        if (!line) return { ok: false, error: '缺少 line 参数（不能为空）' };
        const memory = ctx.get('memory');
        if (!memory) return { ok: false, error: 'memory 服务不可用' };
        memory.append(key, line);
        return { ok: true, output: { key, appended: line.slice(0, 80) } };
      },
    });

    c.tools.register({
      name: 'memory_rewrite',
      description:
        '整体重写当前会话的长期记忆（全量替换，非追加）。用于归档整理等维护场景：合并重复信息、压缩冗长表述、删除已过时/已被替代的记忆，只保留仍有效且重要的内容。日常记录请用 memory_append。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              '整理后的完整记忆内容（整文件替换；先整理去重再提交，宁可精炼不要贪多——记忆注入有 token 预算，超出会被截断）',
          },
        },
        required: ['content'],
      },
      execute(args, call): ToolResult {
        const key = call.conversationId ?? call.agentId;
        if (key === undefined) {
          return { ok: false, error: '缺少会话上下文（memory_rewrite 需在 Agent run 内调用）' };
        }
        const content = String(args.content ?? '').trim();
        if (!content) return { ok: false, error: '缺少 content 参数（不能为空；要清空记忆请明示提交占位说明）' };
        const memory = ctx.get('memory');
        if (!memory) return { ok: false, error: 'memory 服务不可用' };
        memory.set(key, content);
        return { ok: true, output: { key, rewritten: content.length } };
      },
    });
  });
}
