// ============================================================
// ac-web-tools/src/browser.ts —— 浏览器守护进程 Service（ctx.browser）
//
// src browser daemon 的 preview 形态（地图 §3.4）：
//   · 独立 Service（src 是模块级单例）——dispose 杀进程（fiber 归属）
//   · src 的"单飞 pendingCmd"改为【请求队列】：并发命令按 FIFO 逐条
//     等待应答（守护进程协议本身单命令应答制）
//   · 协议原样：stdin 写一行 JSON 命令；stdout 行 JSON 应答；
//     ready 握手（{"status":"ready"}）后才发命令
// 守护进程命令可配置（缺省 python + scriptPath；测试注入假守护进程）。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { Service, type Context } from '@agentchat/cordis';

export interface BrowserRowOptions {
  /** 守护进程命令（argv；缺省 ['python', <scriptPath>]） */
  command?: string[];
  /** 守护进程脚本路径（缺省 ./files/shared/scripts/browser_daemon.py） */
  scriptPath?: string;
  /** 单命令超时毫秒（缺省 35000） */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserService extends Service {
  private command: string[];
  private timeoutMs: number;
  private daemon: ChildProcess | null = null;
  private booted = false;
  private bootPromise: Promise<void> | null = null;
  /** 请求队列：守护进程协议单命令应答制，逐条等待 */
  private queue: PendingRequest[] = [];
  private buffer = '';
  /** 世代计数：旧 daemon 的 exit 事件不得抹掉新 daemon 的状态（src daemonGen 同款） */
  private generation = 0;

  constructor(ctx: Context, options: BrowserRowOptions = {}) {
    super(ctx, 'browser');
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.command = options.command ?? ['python', options.scriptPath ?? 'files/shared/scripts/browser_daemon.py'];
    // 注册即归属：服务卸载（行摘除/进程收尾）→ 杀守护进程
    this.ctx.fiber.effect(
      () => () => this.kill(),
      'browser.daemon',
    );
  }

  /** 守护进程是否在运行 */
  get running(): boolean {
    return this.booted && this.daemon !== null && !this.daemon.killed;
  }

  /** 惰性启动守护进程（ready 握手；并发调用共享一次 boot） */
  private boot(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.bootPromise) return this.bootPromise;
    this.buffer = '';
    const gen = ++this.generation;
    const daemon = spawn(this.command[0], this.command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.daemon = daemon;
    this.bootPromise = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.bootPromise = null;
        resolve();
      };
      daemon.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk, done));
      daemon.stderr?.on('data', (chunk: Buffer) => {
        this.ctx.logger.warn(`[browser:stderr] ${chunk.toString('utf-8').trim()}`);
      });
      daemon.on('exit', () => {
        if (gen !== this.generation) return; // 旧世代的退出：不影响新 daemon
        this.daemon = null;
        this.booted = false;
        this.rejectAll(new Error('browser daemon 已退出'));
        done();
      });
      daemon.on('error', (err: Error) => {
        if (gen !== this.generation) return;
        this.ctx.logger.error(`browser daemon 错误: ${err.message}`);
        done();
      });
    });
    return this.bootPromise;
  }

  /** stdout 行协议：ready 握手 → 应答队首请求 */
  private onStdout(chunk: Buffer, onReady: () => void): void {
    this.buffer += chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { status?: string } | null = null;
      try {
        msg = JSON.parse(line.trim()) as { status?: string };
      } catch {
        /* 非 JSON */
      }
      if (msg?.status === 'ready') {
        this.booted = true;
        onReady();
        continue;
      }
      if (msg?.status === 'starting') continue;
      const head = this.queue.shift();
      if (head) {
        clearTimeout(head.timer);
        head.resolve(line.trim());
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const req of this.queue.splice(0)) {
      clearTimeout(req.timer);
      req.reject(err);
    }
  }

  /** 发送单条命令给守护进程（队列串行；超时拒绝） */
  async send(cmd: Record<string, unknown>): Promise<string> {
    await this.boot();
    if (!this.daemon?.stdin) throw new Error('browser daemon 不可用（启动失败或已退出）');
    return new Promise<string>((resolve, reject) => {
      const req: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(req);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error(`browser timeout: ${String(cmd.action)}`));
        }, this.timeoutMs),
      };
      this.queue.push(req);
      this.daemon!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }

  /** 关闭守护进程（close 动作后调用；幂等） */
  kill(): void {
    this.generation++; // 旧世代的 exit 事件静默（不 reject 新队列）
    this.booted = false;
    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill();
    }
    this.daemon = null;
    this.rejectAll(new Error('browser daemon 已关闭'));
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 浏览器守护进程（ac-web-tools 提供）：send 命令队列 + dispose 杀进程 */
    browser: BrowserService;
  }
}
