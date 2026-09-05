// ============================================================
// ac-sap-adt/src/engine.ts —— 引擎宿主适配层（纯适配，零业务）
//
// 引擎 = @nefevcore/abap-adt-core 纯内核（46 个 adt_* 工具 + 目的地注册表
// + 策略/锁/调试器，零宿主依赖——与 DeepSeek Harness 适配层同源）。
// 内核通过三个结构化缝与宿主对话（见内核 src/tooldef.ts）：
//
//   · ToolHost.get('fs')          → AdtFileSystem（快照/导出/本地检查）
//   · ToolHost.get('credentials') → CredentialsService（密码引用解析）
//   · ToolHost.get('host')        → HostProfile（宿主档案：凭证词汇与
//                                    工作区 destinations 目录，0.7.1 起）
//
// 本文件把 AgentChat 的对应能力适配成这两个形状：
//
//   · SapAdtFs —— node:fs 直连适配器，锚定 <数据根>/sap-adt/ 子树
//     （路径越界即拒绝：快照/导出/本地检查全部圈在专用工作区内，
//      不触碰 ac-security 的通用文件面，也不需要它放行）
//   · credentialsServiceOf —— ac-credentials（AES-GCM 加密存储）映射到
//     引擎的密码引用词汇（ADT_<NAME>_PASSWORD 等，存在全局级凭据下）
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';
import type {
  AdtFileSystem,
  AdtFsDirEntry,
  AdtFsTarget,
  AdtFsWriteOutcome,
  CredentialsService,
} from '@nefevcore/abap-adt-core';

/** ac-credentials 服务面（结构化——缺行组合时本适配层整体缺位）。 */
interface AgentChatCredentialsFace {
  /** 全局级凭据（空串 = 未设置） */
  getGlobal(provider: string): string;
  /** 存全局级凭据（空串 = 删除） */
  setGlobal(provider: string, value: string): void;
}

/**
 * 把 ac-credentials 适配成引擎的凭据缝：密码引用（如 ADT_DEV_PASSWORD）
 * 存取于全局级凭据。加密落盘 / 换机绑定 / 原子写都由 ac-credentials
 * 自己承担；解析失败（如换机解密失败）按"未设置"处理，引擎会落到
 * 进程环境变量层。
 */
export function credentialsServiceOf(ctx: Context): CredentialsService | undefined {
  const creds = ctx.get('credentials') as AgentChatCredentialsFace | undefined;
  if (!creds) return undefined;
  return {
    async resolve(ref) {
      const value = creds.getGlobal(ref);
      return value ? { value, source: 'agentchat-credentials' } : undefined;
    },
    async describe(ref) {
      return { configured: creds.getGlobal(ref) !== '', writable: true };
    },
    async set(ref, value) {
      creds.setGlobal(ref, value);
    },
  };
}

/**
 * node:fs 直连的 AdtFileSystem 适配器，全部路径圈定在 baseDir 内
 * （引擎侧的相对路径——快照 `.adt-snapshots/…`、导出目录、
 * `.abaplint.json`——都按它解析；模型给的绝对路径也必须落在子树内）。
 */
export class SapAdtFs implements AdtFileSystem {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    // 显式字段赋值（Node strip-only 加载器不支持参数属性——兼容红线）
    this.baseDir = baseDir;
  }

  /** 解析并守卫一条路径（相对路径按 anchor 解析；越界即抛错）。 */
  private guard(rawPath: string, anchor: string): string {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(anchor, rawPath);
    const base = path.resolve(this.baseDir);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new Error(
        `adt: path "${rawPath}" escapes the sap-adt workspace (${base}); ` +
          'keep sources/snapshots/exports inside it',
      );
    }
    return abs;
  }

  async resolve(rawPath: string, options?: { cwd?: string }): Promise<AdtFsTarget> {
    const anchor = options?.cwd
      ? this.guard(options.cwd, path.resolve(this.baseDir))
      : path.resolve(this.baseDir);
    const abs = this.guard(rawPath, anchor);
    return { targetKey: abs, displayPath: abs };
  }

  async readText(target: AdtFsTarget): Promise<string> {
    return await fs.promises.readFile(target.targetKey, 'utf8');
  }

  async writeText(target: AdtFsTarget, content: string): Promise<AdtFsWriteOutcome> {
    const file = target.targetKey;
    const existed = fs.existsSync(file);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content, 'utf8');
    return { operation: existed ? 'update' : 'create' };
  }

  async listDir(target: AdtFsTarget): Promise<AdtFsDirEntry[]> {
    const entries = await fs.promises.readdir(target.targetKey, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? ('directory' as const) : e.isFile() ? ('file' as const) : ('other' as const),
    }));
  }

  async readDir(absPath: string): Promise<AdtFsDirEntry[]> {
    const entries = await fs.promises.readdir(absPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? ('directory' as const) : e.isFile() ? ('file' as const) : ('other' as const),
    }));
  }

  async readFile(absPath: string): Promise<string> {
    return await fs.promises.readFile(absPath, 'utf8');
  }
}
