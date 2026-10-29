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
// 快照隔离双侧对称：读侧 all/get 与写侧 set/merge 值均深拷贝——服务
// 内态与调用方对象互不渗漏（写侧存引用 = 调用方事后变异静默绕过写盘
// 与事件，读侧隔离承诺被写侧戳穿）。深等价提交静默返回（同值 set 不
// 写盘不唤醒订阅方——全量重查是纯空转）；变更键随 config/changed
// 第二参广播（gap-backlog #14 P1/P2，cr-377）。
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

  /** 写键（点路径支持 'a.b'）：内存 + 原子落盘 + config/changed。
   * 值深拷贝入内存（写侧快照隔离——与读侧 get/all 同口径）；深等价
   * 无实质变化则静默返回（不写盘不广播）。 */
  set(key: string, value: unknown): void {
    const parts = key.split('.');
    const safeValue = value !== null && typeof value === 'object' ? structuredClone(value) : value;
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
    if (safeValue === undefined) delete cursor[parts[parts.length - 1]];
    else cursor[parts[parts.length - 1]] = safeValue;
    this.commit(setData, [key]);
  }

  /** 合并局部（浅合并顶层键；对象值整体覆盖）。值深拷贝 + 深等价静默（同 set）。 */
  merge(partial: Record<string, unknown>): void {
    const snapshot = Object.fromEntries(
      Object.entries(partial).map(([k, v]) => [
        k,
        v !== null && typeof v === 'object' ? structuredClone(v) : v,
      ]),
    );
    this.commit({ ...this.data, ...snapshot }, Object.keys(partial));
  }

  /** 删键 */
  delete(key: string): void {
    this.set(key, undefined);
  }

  /**
   * 热重载：重读文件并广播 config/changed（外部改文件后的同步入口）。
   * 内容深等价时不广播不换内存引用（true 语义不变 = 文件存在且已对账；
   * 等价唤醒订阅方是纯空转）。
   * @returns true=已重载；false=文件缺失/损坏（内存态保持不变）
   */
  reload(): boolean {
    const next = readJson(this.file);
    if (next === null) return false;
    if (!jsonEqual(this.data, next)) {
      const changed = changedKeys(this.data, next);
      this.data = next;
      this.ctx.emit('config/changed', this.file, changed);
    }
    return true;
  }

  /** 提交新全量：内存 → 原子写盘 → 事件（第二参 = 变更键）。
   * 深等价（无实质变化）直接返回——不写盘不广播。 */
  private commit(next: Record<string, unknown>, changed: string[]): void {
    if (jsonEqual(this.data, next)) return;
    this.data = next;
    writeJsonAtomic(this.file, next);
    this.ctx.emit('config/changed', this.file, changed);
  }

  /** 读文件：缺失/损坏返回 null（reload 保守；构造时缺失去 {}） */
  private readFile(): Record<string, unknown> {
    return readJson(this.file) ?? {};
  }
}

/** 深等价：序列化形状比较（ac-agent-admin jsonEq 同款形态。键序敏感
 * ——本服务写路径键序稳定；手工编辑重排键序判不等价走保守重写，可接受） */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 变更顶层键集（reload 载荷：新旧全量的粗粒度 diff） */
function changedKeys(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => !jsonEqual(prev[k], next[k]));
}

/** 读 JSON 文件（缺失/损坏 → null）。模块私有——原子写口径系各 owning
 * service 自持写法（ac-group 注释载明的既定设计），不做跨包出口。 */
function readJson(file: string): Record<string, unknown> | null {
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

/** Windows 瞬时占用码（并发测试/防病毒扫描 rename 撞 EACCES/EBUSY/EPERM） */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
}

/** 原子写 JSON：临时文件 + rename（瞬时占用有界退避重试——cr-705；
 * 同款口径住 ac-plugin-core/fsx.ts，owning service 自持写法不跨包 import） */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err: unknown) {
        if (!isTransientRenameError(err) || attempt >= 10) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } catch (err: unknown) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw err;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 全局配置服务（ac-config 提供）：<root>/config.json 原子读写 + config/changed */
    config: ConfigService;
  }
}
