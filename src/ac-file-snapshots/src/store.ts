// ============================================================
// ac-file-snapshots/src/store.ts —— 会话文件首见快照纯库
//
// 方案 C 数据面：每会话每文件**首次写入前**的磁盘内容快照。
// 消费面 = 前端「文件编辑」面板（方案 A 重放的存量断链补全——
// 首编辑前磁盘内容不在消息流，快照补上这段底）。
//
// 语义（唯一不变量）：
//   ensure(conversationId, absPath) —— 会话×文件键首次调用时读磁盘
//   存快照；此后同键调用恒 no-op（含文件被删除/不可读——首见时
//   不存在 = 「新建」标记，null 内容照样落账，绝不二写）。
//   快照是**首见时刻**的磁盘事实，不追踪后续变更（变更在消息流）。
//
// 快照准入（2026-12 收敛——快照面只服务文本 diff 重建）：
//   · 仅文本文件（前 8 KiB 无 NUL/控制符/utf-8 替换符——与
//     ac-workspace readFile 的 binary 判定同式 + 替换符加固）；
//   · 单文件 ≤ maxBytes（缺省 SNAPSHOT_MAX_BYTES = 2 MiB；<=0 关闭）。
//   超限/二进制 → 只落 skipped 标记（meta），不复制内容——前端据
//   skipped 保持 partial（不误判「会话内新建」），回落磁盘兜底/
//   方案 A。statSync 预检保证超限大文件零全文读。
//
// 存储：<root>/file-snapshots/<conversationId 编码>/<absPath 编码>
//   · conversationId 编码 = encodeURIComponent（键含 / ~ | 等安全字符）；
//   · absPath 编码 = encodeURIComponent（Windows 盘符冒号/反斜杠全转义）；
//   · 内容原样字节（utf-8 文本）；跳过/新建快照不落内容文件
//     （meta 是唯一事实源——旧版「空内容文件」仍兼容读取）。
//
// 纯库纪律（ac-backup-core 同款）：零 cordis 依赖，可独立单测。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 单文件快照字节上限（缺省 2 MiB）。基准：源代码/配置/文档几乎
 * 全部 < 512 KiB（99.9%+），package-lock 级最大常规文本 ~2 MiB；
 * 更大的几乎全是构建产物/数据文件/转储——本就不适合进文本 diff。
 * 同时把写路径上的同步复制钉在毫秒级。对齐仓内先例：workspace
 * readFile 预览 4 MiB / session tail 缓存 8 MiB / grep 预过滤 1 MiB。
 */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** 文本嗅探窗口（字节）——与 ac-workspace readFile 的 binary 判定同窗 */
const TEXT_SNIFF_BYTES = 8192;

/** 快照跳过原因：超上限 / 非文本（二进制） */
export type SnapshotSkipReason = 'too-large' | 'not-text';

/**
 * 文本判定：内容前段无 NUL/控制符（\t\n\r 除外）且无 utf-8 替换符
 * → 文本。与 ac-workspace readFile 的 binary 判定同式，另加 U+FFFD
 * 加固（utf-8 解码失败残留——纯二进制高频出现）。
 */
export function looksLikeText(content: string): boolean {
  if (content.length === 0) return true; // 空文件 = 合法文本
  const head = content.slice(0, TEXT_SNIFF_BYTES);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(head)) return false;
  return !head.includes('\uFFFD');
}

/** 快照查询结果 */
export interface FileSnapshot {
  conversationId: string;
  /** 绝对路径（解码后原样） */
  absPath: string;
  /**
   * 首见时磁盘内容；null = 无内容快照——三种情形：首见时不存在
   * （会话内新建，skipped 不在场）/ 超上限跳过（skipped=too-large）/
   * 二进制跳过（skipped=not-text）。existed 且未跳过时恒为 string
   * （读失败 = 内容 ''——保守不阻断写路径）。
   */
  content: string | null;
  /** 跳过原因（仅「存在但未快照内容」时在场；新建场景无此字段） */
  skipped?: SnapshotSkipReason;
  /** 首见时刻（epoch ms） */
  capturedAt: number;
  /** 快照文件绝对路径（诊断/清理用；跳过快照不落内容文件） */
  snapshotFile: string;
}

export interface SnapshotStoreOptions {
  /** 快照根目录（缺省 <dataRoot>/file-snapshots；本库不猜 dataRoot——由行传入） */
  root?: string;
  /**
   * 单文件快照字节上限（statSync 预检；首见超限 → 只落跳过标记，
   * 不复制内容）。<=0 = 关闭上限；缺省 SNAPSHOT_MAX_BYTES（2 MiB）。
   */
  maxBytes?: number;
}

/** 键编码（对话键与路径都过 encodeURIComponent——文件名安全） */
function encodeKey(s: string): string {
  return encodeURIComponent(s);
}

export class SnapshotStore {
  private readonly root: string;
  private max: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.root = path.resolve(options.root ?? './data/file-snapshots');
    this.max = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  }

  /** 快照根（诊断面） */
  get location(): string {
    return this.root;
  }

  /** 单文件快照字节上限（诊断面；<=0 = 无上限） */
  get maxBytes(): number {
    return this.max;
  }

  /** 上限热更口（行配置/全局设置层对账写入——只影响后续 ensure/readCurrent） */
  set maxBytes(v: number) {
    this.max = v;
  }

  /** 会话×文件 → 快照文件路径（不保证存在） */
  private fileOf(conversationId: string, absPath: string): { contentFile: string; metaFile: string } {
    const dir = path.join(this.root, encodeKey(conversationId));
    const encoded = encodeKey(path.resolve(absPath));
    return {
      contentFile: path.join(dir, encoded),
      metaFile: path.join(dir, `${encoded}.meta.json`),
    };
  }

  /**
   * 确保快照存在（首次写入前调用）：同键已存 = no-op（幂等，绝不覆盖）。
   * 准入：仅文本（前 8 KiB 嗅探）且 ≤ maxBytes——超限/二进制只落
   * skipped 标记不复制内容（statSync 预检，超限大文件零全文读）。
   * 读磁盘失败（权限等）按新建处理——快照面不阻断写路径。
   * @returns 本次是否新建了快照（false = 已存在）
   */
  ensure(conversationId: string, absPath: string): boolean {
    if (!conversationId || !absPath) return false;
    const { contentFile, metaFile } = this.fileOf(conversationId, absPath);
    if (fs.existsSync(metaFile)) return false; // 已有快照（含跳过/新建标记）——首见已发生
    let existed = false;
    let skipped: SnapshotSkipReason | undefined;
    let content: string | undefined;
    try {
      const resolved = path.resolve(absPath);
      const st = fs.statSync(resolved);
      if (st.isFile()) {
        existed = true;
        if (this.maxBytes > 0 && st.size > this.maxBytes) {
          skipped = 'too-large';
        } else {
          const text = fs.readFileSync(resolved, 'utf-8');
          if (looksLikeText(text)) content = text;
          else skipped = 'not-text';
        }
      } // 目录/特殊文件 → 按不存在（新建语义）
    } catch {
      /* 首见时不存在（或不可读按不存在）——新建场景 */
    }
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    if (content !== undefined) fs.writeFileSync(contentFile, content, 'utf-8');
    fs.writeFileSync(metaFile, JSON.stringify({ existed, skipped, capturedAt: Date.now() }), 'utf-8');
    return true;
  }

  /** 读取快照（无 = undefined——首见未发生或已清理） */
  get(conversationId: string, absPath: string): FileSnapshot | undefined {
    const { contentFile, metaFile } = this.fileOf(conversationId, absPath);
    let meta: { existed?: boolean; skipped?: string; capturedAt?: number };
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { existed?: boolean; skipped?: string; capturedAt?: number };
    } catch {
      return undefined;
    }
    const existed = meta.existed === true;
    const skipped: SnapshotSkipReason | undefined =
      meta.skipped === 'too-large' || meta.skipped === 'not-text' ? meta.skipped : undefined;
    let content: string | null = null;
    if (existed && skipped === undefined) {
      try {
        content = fs.readFileSync(contentFile, 'utf-8');
      } catch {
        content = ''; // 快照内容丢失（外部清理半途）——保守空串
      }
    }
    return {
      conversationId,
      absPath: path.resolve(absPath),
      content,
      skipped,
      capturedAt: typeof meta.capturedAt === 'number' ? meta.capturedAt : 0,
      snapshotFile: contentFile,
    };
  }

  /** 会话的全部快照清单（目录缺失 = 空数组；meta 损坏条目跳过） */
  list(conversationId: string): FileSnapshot[] {
    const dir = path.join(this.root, encodeKey(conversationId));
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: FileSnapshot[] = [];
    for (const name of entries) {
      if (!name.endsWith('.meta.json')) continue;
      const encoded = name.slice(0, -'.meta.json'.length);
      let absPath: string;
      try {
        absPath = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      const snap = this.get(conversationId, absPath);
      if (snap) out.push(snap);
    }
    return out.sort((a, b) => a.absPath.localeCompare(b.absPath));
  }

  /** 删除会话全部快照（会话删除级联用；返回清理数） */
  dropConversation(conversationId: string): number {
    const dir = path.join(this.root, encodeKey(conversationId));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return 1;
    } catch {
      return 0;
    }
  }
}