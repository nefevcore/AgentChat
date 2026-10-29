// ============================================================
// handoff 日志流 error 吸收面（cr-718）：WriteStream 无监听的异步
// 'error' 是 unhandled event，直接带崩壳进程（2026-10-24~27
// shell-__creator__ 33 次 %TEMP% EPERM 崩溃现场的根修）。锁定：
// 打不开同步抛（不产生无监听流）+ 打开后流级 error 有吸收面。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openHandoffLog } from '../src/executor.ts';

describe('openHandoffLog（cr-718 回归锚）', () => {
  it('打开失败同步抛：不产生无监听流（父目录为文件 → mkdir/open 失败）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-handoff-'));
    try {
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'x');
      expect(() => openHandoffLog(path.join(blocker, 'x.log'))).toThrow(); // 父是文件：mkdir ENOTDIR/EEXIST → 同步抛
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('流级异步 error 被吸收（旧形态此处 unhandled → 崩 worker）：目录当日标——Windows 开目录成功、写入时才异步报错，即崩溃现场的时序形态', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-handoff-'));
    let s: fs.WriteStream | undefined;
    try {
      try {
        s = openHandoffLog(dir); // Unix: EISDIR 同步抛（同样是安全失败面）；Windows: 开成功，错误推迟到写
      } catch {
        return; // Unix 同步抛路径已被上一用例锁定
      }
      expect(s.listenerCount('error')).toBeGreaterThan(0); // 吸收面在位 = 回归锚
      s.write('dir-target'); // Windows: 写目录 → 异步 error——旧代码此处崩进程
      await new Promise((res) => setTimeout(res, 200)); // 等异步 error 到达；能走到这里即未崩
    } finally {
      s?.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('成功路径：写入内容落盘，流正常收口', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-handoff-'));
    try {
      const file = path.join(dir, 'ok.log');
      const s = openHandoffLog(file);
      s.write('probe-line');
      await new Promise<void>((res) => s.end(res));
      expect(fs.readFileSync(file, 'utf-8')).toBe('probe-line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
