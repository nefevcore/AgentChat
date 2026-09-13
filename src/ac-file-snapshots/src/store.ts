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
// 存储：<root>/file-snapshots/<conversationId 编码>/<absPath 编码>
//   · conversationId 编码 = encodeURIComponent（键含 / ~ | 等安全字符）；
//   · absPath 编码 = encodeURIComponent（Windows 盘符冒号/反斜杠全转义）；
//   · 内容原样字节（utf-8 文本）；不存在首见 = 空文件 + 旁侧 .meta.json
//     标记 { existed: false }（区分「空文件快照」与「新建」）。
//
// 纯库纪律（ac-backup-core 同款）：零 cordis 依赖，可独立单测。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 快照查询结果 */
export interface FileSnapshot {
  conversationId: string;
  /** 绝对路径（解码后原样） */
  absPath: string;
  /**
   * 首见时磁盘内容；null = 首见时文件不存在（会话内新建）。
   * existed=true 时恒为 string（读失败 = 内容 ''——保守不阻断写路径）。
   */
  content: string | null;
  /** 首见时刻（epoch ms） */
  capturedAt: number;
  /** 快照文件绝对路径（诊断/清理用） */
  snapshotFile: string;
}

export interface SnapshotStoreOptions {
  /** 快照根目录（缺省 <dataRoot>/file-snapshots；本库不猜 dataRoot——由行传入） */
  root?: string;
}

/** 键编码（对话键与路径都过 encodeURIComponent——文件名安全） */
function encodeKey(s: string): string {
  return encodeURIComponent(s);
}

export class SnapshotStore {
  private readonly root: string;

  constructor(options: SnapshotStoreOptions = {}) {
    this.root = path.resolve(options.root ?? './data/file-snapshots');
  }

  /** 快照根（诊断面） */
  get location(): string {
    return this.root;
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
   * 读磁盘失败（权限等）按 existed + 空内容处理——快照面不阻断写路径。
   * @returns 本次是否新建了快照（false = 已存在）
   */
  ensure(conversationId: string, absPath: string): boolean {
    if (!conversationId || !absPath) return false;
    const { contentFile, metaFile } = this.fileOf(conversationId, absPath);
    if (fs.existsSync(metaFile)) return false; // 已有快照（含新建标记）——首见已发生
    let existed = false;
    let content = '';
    try {
      content = fs.readFileSync(path.resolve(absPath), 'utf-8');
      existed = true;
    } catch {
      /* 首见时不存在（或不可读按不存在）——新建场景 */
    }
    fs.mkdirSync(path.dirname(contentFile), { recursive: true });
    fs.writeFileSync(contentFile, content, 'utf-8');
    fs.writeFileSync(metaFile, JSON.stringify({ existed, capturedAt: Date.now() }), 'utf-8');
    return true;
  }

  /** 读取快照（无 = undefined——首见未发生或已清理） */
  get(conversationId: string, absPath: string): FileSnapshot | undefined {
    const { contentFile, metaFile } = this.fileOf(conversationId, absPath);
    let meta: { existed?: boolean; capturedAt?: number };
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { existed?: boolean; capturedAt?: number };
    } catch {
      return undefined;
    }
    const existed = meta.existed === true;
    let content: string | null = null;
    if (existed) {
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
