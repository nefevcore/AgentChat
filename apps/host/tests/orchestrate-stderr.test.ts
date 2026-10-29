// ============================================================
// orchestrate-stderr.test.ts —— cr-662 诊断面：壳 stderr 管道消费
//（按行回流钩子 + 滚动日志 + 尾行环 + 退出现场收口）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptShell, defaultSpawn, appendRollingLine, type SpawnFn } from '../orchestrate.ts';
import { ReachabilityTable } from 'ac-post-office';

describe('cr-662 壳 stderr 诊断面', () => {
  it('defaultSpawn：stderr 按行回流（含 \r 剥离）+ exit 回调带 code', async () => {
    const lines: string[] = [];
    const proc = defaultSpawn(process.execPath, [
      '-e', "process.stderr.write('err-a\\r\\nerr-b\\n'); process.exit(3);",
    ], { onStderrLine: (l) => lines.push(l) });
    const code = await new Promise<number | null>((res) => proc.on('exit', (c) => res(c)));
    expect(code).toBe(3);
    expect(lines).toEqual(['err-a', 'err-b']);
  }, 20_000);

  it('appendRollingLine：超 cap 滚成 .1（旧 .1 覆弃）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-roll-'));
    const f = path.join(dir, 'x.log');
    appendRollingLine(f, 'a'.repeat(30), 10);
    appendRollingLine(f, 'b', 10); // 超 cap → 滚动
    expect(fs.readFileSync(f, 'utf-8').trim()).toBe('b');
    expect(fs.readFileSync(f + '.1', 'utf-8').includes('aaa')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adoptShell：stderr 行落 dataRoot 滚动日志 + 尾行环 + 退出收口行', async () => {
    let stderrLine: ((l: string) => void) | undefined;
    let exitSink: ((code: number | null, signal: string | null) => void) | null = null;
    const lines: string[] = ['boot.lock.acquired\tb-1', 'boot.rows.ready\tb-1\t31', 'boot.ready\tb-1\tpipe-x'];
    const waiters: Array<(l: string) => void> = [];
    const push = (l: string) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); };
    const spawnFn: SpawnFn = (_cmd, _args, hooks) => {
      stderrLine = hooks?.onStderrLine;
      return {
        pid: 4321,
        stdout: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const queued = lines.shift();
              if (queued !== undefined) { yield queued; continue; }
              yield await new Promise<string>((resolve) => { waiters.push(resolve); });
            }
          },
        },
        write: () => {},
        on: (event, cb) => { void event; exitSink = cb; },
        kill: () => {},
      };
    };
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-stderr-'));
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const consoleLines: string[] = [];
    process.stderr.write = ((chunk: string) => { consoleLines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 5_000,
      });
      stderrLine!('boom-line-1');
      stderrLine!('boom-line-2');
      expect(adopted.stderrTail()).toEqual(['boom-line-1', 'boom-line-2']);
      // cr-741：生命周期常态行不刷宿主控制台；未知形态行保守转发
      stderrLine!('[shell] boot 完成：agent=a1 rows=32');
      stderrLine!('[shell] boot 失败：Error: x');
      const echoed = consoleLines.filter((l) => l.includes('boot'));
      expect(echoed).toEqual([]);
      expect(consoleLines.some((l) => l.includes('boom-line-1'))).toBe(true);
      exitSink!(1, null); // 崩溃退出
      const log = fs.readFileSync(path.join(dataRoot, '.runtime', 'logs', 'shell-a1.log'), 'utf-8');
      // cr-741：落盘行宿主侧盖 ISO 时标（时间线对齐）；exit 收口行保持无时标原格式
      expect(log).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z boom-line-1\n/);
      expect(log).toContain('=== exit code=1');
    } finally {
      process.stderr.write = stderrWrite;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
