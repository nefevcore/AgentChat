// ============================================================
// ac-config/src/service.ts —— 全局配置服务（cordis Service）
//
// 本包是配置域的 owning package：ctx.config 服务 + config/changed 事件
// （./events.ts）。owns <root>/config.json 的读写（ADR-5 持久化归
// owning service——禁止其他域直写本文件）。
//
// src ConfigService 的教训与对策：
//   · 原地 mutate 保对象引用（保 AgentLoader/Assembly 捕获的引用不失效）
//     → preview 用 config/changed(E) 订阅刷新：变更即事件，订阅方重查
//     服务拿新值，零引用技巧；
//   · 重载丢默认值（chat~admin~undefined 事故）→ 本服务不注入默认值
//     （默认值是消费方词汇）；文件即全量，reload 只重读。
//
// 写入原子性：临时文件 + rename（继承 timer 状态文件模式，资产 #8）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context } from '@agentchat/cordis';

/** 行配置（cordis.yml config / bootTree configs / 构造直传） */
export interface ConfigRowOptions {
  /** 数据根目录（缺省 './data'，相对 cwd；config 文件 = <root>/config.json） */
  root?: string;
}

export class ConfigService extends Service {
  private file: string;
  private data: Record<string, unknown>;

  constructor(ctx: Context, options: ConfigRowOptions = {}) {
    super(ctx, 'config');
    this.file = path.resolve(options.root ?? process.env.AGENTCHAT_DATA_ROOT ?? './data', 'config.json');
    this.data = this.readFile();
  }

  /** 全量快照（深拷贝——外部变异不回写内存态；订阅刷新模式下旧引用可安全持有） */
  all(): Record<string, unknown> {
    return structuredClone(this.data);
  }

  /** 读键（点路径支持 'a.b'）；缺省 fallback；对象值返回深拷贝（快照隔离） */
  get<T>(key: string, fallback?: T): T | undefined {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      return acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined;
    }, this.data);
    if (value === undefined) return fallback as T | undefined;
    return (value !== null && typeof value === 'object' ? structuredClone(value) : value) as T;
  }

  /** 写键（点路径支持 'a.b'）：内存 + 原子落盘 + config/changed */
  set(key: string, value: unknown): void {
    const parts = key.split('.');
    const setData = { ...this.data };
    let cursor: Record<string, unknown> = setData;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const next = cursor[part];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        cursor[part] = {}; // 中途非对象 → 建新对象（覆盖标量/数组）
      }
      cursor[part] = { ...(cursor[part] as Record<string, unknown>) }; // 复制层级，不变异共享引用
      cursor = cursor[part] as Record<string, unknown>;
    }
    if (value === undefined) delete cursor[parts[parts.length - 1]];
    else cursor[parts[parts.length - 1]] = value;
    this.commit(setData);
  }

  /** 合并局部（浅合并顶层键；对象值整体覆盖） */
  merge(partial: Record<string, unknown>): void {
    this.commit({ ...this.data, ...partial });
  }

  /** 删键 */
  delete(key: string): void {
    this.set(key, undefined);
  }

  /**
   * 热重载：重读文件并广播 config/changed（外部改文件后的同步入口）。
   * @returns true=已重载；false=文件缺失/损坏（内存态保持不变）
   */
  reload(): boolean {
    const next = readJson(this.file);
    if (next === null) return false;
    this.data = next;
    this.ctx.emit('config/changed', this.file);
    return true;
  }

  /** 提交新全量：内存 → 原子写盘 → 事件 */
  private commit(next: Record<string, unknown>): void {
    this.data = next;
    writeJsonAtomic(this.file, next);
    this.ctx.emit('config/changed', this.file);
  }

  /** 读文件：缺失/损坏返回 null（reload 保守；构造时缺失去 {}） */
  private readFile(): Record<string, unknown> {
    return readJson(this.file) ?? {};
  }
}

/** 读 JSON 文件（缺失/损坏 → null） */
export function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 原子写 JSON：临时文件 + rename（继承 timer 状态文件模式） */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 全局配置服务（ac-config 提供）：<root>/config.json 原子读写 + config/changed */
    config: ConfigService;
  }
}
