// ============================================================
// rolling-log.ts —— 滚动追加日志（host/shell 双端运维日志共用，cr-1127）
//
// 自 ac-envelope-core 迁入（原 apps/host/orchestrate.ts 内定义）：runbeat
// 改壳侧直写（shell-protocol-off-stdio-plan 批 3）后宿主/壳两侧同语义
// 落盘——单实现单源，语义：超 capBytes 滚成 .1（旧 .1 覆弃）；日志面
// 自身失败（磁盘满/权限）静默——诊断写不得反噬监护链。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 滚动追加一行：超 capBytes 即滚成 .1（旧 .1 覆弃） */
export function appendRollingLine(file: string, line: string, capBytes: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > capBytes) fs.renameSync(file, file + '.1');
    } catch { /* 文件尚不存在——直接追加 */ }
    fs.appendFileSync(file, line + '\n', 'utf-8');
  } catch { /* 诊断面失败不反噬 */ }
}
