// ============================================================
// 前台执行：输出/退出码/ANSI 清理/沙箱/tierOf（拆分自单文件版 ①/4）
// 全为快命令（echo/exit/cat 拦截），无真实等待——本文件墙钟 ~5s。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as agentsRow from 'ac-agents';
import * as toolsRow from 'ac-tools';
import * as jobsRow from 'ac-jobs';
import { CMD_TOOL, exec, tmpRoot, registerTmp, boot, bootRows } from './helpers.ts';
import * as shellRow from '../src/index.ts';

describe('ac-shell-tools 平台注入（2026-09-16 工具拆分）', () => {
  it('按宿主平台注册单命令工具：Windows → pwsh（无别名）；Unix → bash', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const names = ctx.tools.list().map((t) => t.name).sort();
    // 单平台单工具（无别名——双名会让 tag:shell 展开出重复工具）
    expect(names).toEqual(process.platform === 'win32' ? ['job', 'pwsh'] : ['bash', 'job']);
    // 门禁元数据随平台工具
    const def = ctx.tools.get(CMD_TOOL);
    expect(def?.requiredTags).toEqual(['shell']);
    expect(def?.needPermission).toBe(true);
  });

  it('pwsh（Windows）Unix 命令经翻译层：translated_command 痕迹', async () => {
    if (process.platform !== 'win32') return;
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'pwsh', args: { command: 'pwd' } });
    expect(r.ok).toBe(true);
    expect(r.output.translated_command).toContain('Get-Location');
    expect(String(r.output.output).trim().length).toBeGreaterThan(0);
  });

  it('Unix 直写命令（pwsh 工具）不过翻译层：translated_command 缺省', async () => {
    if (process.platform !== 'win32') return;
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'pwsh', args: { command: 'Write-Output native-ok' } });
    expect(r.ok).toBe(true);
    expect(r.output.translated_command).toBeUndefined();
    expect(String(r.output.output)).toContain('native-ok');
  });
});

describe(`ac-shell-tools ${CMD_TOOL} 前台执行`, () => {
  it('前台执行：echo 输出 + exit_code 0；流式 onProgress 收到分片', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const chunks: string[] = [];
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'echo hello-shell' },
      onProgress: (c: string) => chunks.push(c),
    });
    expect(r.ok).toBe(true);
    expect(r.output.exit_code).toBe(0);
    expect(String(r.output.output)).toContain('hello-shell');
    expect(chunks.join('')).toContain('hello-shell');
  });

  it('前台执行分轨输出（2026-12 对齐 Agent 直觉）：stdout/stderr 字段 + 合流 output 保留', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const cmd =
      process.platform === 'win32'
        ? 'Write-Output to-out; [Console]::Error.WriteLine("to-err")'
        : 'echo to-out; echo to-err >&2';
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: cmd } });
    expect(r.ok).toBe(true);
    // 分轨字段：各归各流
    expect(String(r.output.stdout)).toContain('to-out');
    expect(String(r.output.stdout)).not.toContain('to-err');
    expect(String(r.output.stderr)).toContain('to-err');
    expect(String(r.output.stderr)).not.toContain('to-out');
    // 合流 output 兼容锚保留（两段都在）
    expect(String(r.output.output)).toContain('to-out');
    expect(String(r.output.output)).toContain('to-err');
  });

  it('静默流分轨为空串（字段恒提供，Agent 无需猜测缺席语义）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: 'echo quiet-ok' } });
    expect(r.ok).toBe(true);
    expect(String(r.output.stdout)).toContain('quiet-ok');
    expect(r.output.stderr).toBe('');
    expect(r.output.stdout).toBeTypeOf('string');
  });

  it('非零退出（无错误形态输出）= command-feedback：ok=true + failure_class + 退出码保留', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: 'exit 3' } });
    expect(r.ok).toBe(true); // 反馈型：命令忠实执行，非零退出是语义输出不是链路错误
    expect(r.output.exit_code).toBe(3);
    expect(r.output.failure_class).toBe('command-feedback');
  });

  it('测试红灯形态（exit 1 + 断言输出）= command-feedback（vitest 反馈环不再计入工具失败）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const cmd =
      process.platform === 'win32'
        ? 'Write-Output "FAIL src/x.test.ts > case"; exit 1'
        : 'echo "FAIL src/x.test.ts > case"; exit 1';
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: cmd } });
    expect(r.ok).toBe(true);
    expect(r.output.exit_code).toBe(1);
    expect(r.output.failure_class).toBe('command-feedback');
    expect(String(r.output.output)).toContain('FAIL');
  });

  it('命令不存在形态 = invocation-error：ok=false + error', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const cmd = process.platform === 'win32' ? 'no-such-cmd-xyz --version' : 'no-such-cmd-xyz --version';
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: cmd } });
    expect(r.ok).toBe(false);
    expect(r.output.failure_class).toBe('invocation-error');
  });

  it('ANSI 颜色码清理：彩色输出（vitest/pwsh 场景）返回纯文本', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 用户反馈实例形态：红色 × + 反显 + 耗时着色（跨 chunk 撕裂由汇总处清理兜底）
    const cmd =
      process.platform === 'win32'
        ? 'Write-Host "begin" -NoNewline; [Console]::Write([char]27 + "[31m× fail" + [char]27 + "[0m " + [char]27 + "[32m43ms" + [char]27 + "[39m"); Write-Host "end"'
        : 'printf "begin\\033[31m× fail\\033[0m \\033[32m43ms\\033[39mend\\n"';
    const r = await exec(ctx, { name: CMD_TOOL, args: { command: cmd } });
    expect(r.ok).toBe(true);
    const out = String(r.output.output);
    expect(out).not.toMatch(/[\u001b\u009b]/); // 无转义序列残留
    expect(out).toContain('× fail'); // 可读文本保留
    expect(out).toContain('43ms');
  });

  it('命令级沙箱：越界绝对路径被拦（heredoc 载荷不误判）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const bad = await exec(ctx, { name: CMD_TOOL, args: { command: 'cat /etc/passwd' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
    // heredoc 载荷（数据非命令）不触发误拦：失败原因不得是沙箱
    const okCmd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: "cat > out.txt <<'EOF'\nsample /const/g regex\nEOF\ntype out.txt" },
    });
    expect(okCmd.error ?? '').not.toMatch(/沙箱/);
  });

  it('基线 tierOf 感知（§9.3）：full 档跳过命令扫描与 workdir 白名单；base/sandbox 照拦', async () => {
    const root = tmpRoot();
    // 带 agents 行的 boot（档位判定 tierOf 单源需要注册表）
    const { ctx } = await bootRows([
      [toolsRow, undefined],
      [await import('ac-jobs'), undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ]);
    ctx.agents.register({ id: 'basea', model: 'm', tags: ['shell'] });
    ctx.agents.register({ id: 'sandboxa', model: 'm', tags: ['shell', 'sandbox-access'] });
    ctx.agents.register({ id: 'fulla', model: 'm', tags: ['shell', 'full-access'] });
    const outside = registerTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shell-out-')));

    // base：越界 workdir 被白名单拦
    const baseWd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'echo ok', workdir: outside },
      agentId: 'basea',
    });
    expect(baseWd.ok).toBe(false);
    expect(baseWd.error).toMatch(/沙箱/);
    // base：越界绝对路径命令被扫描拦
    const baseCmd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'cat /etc/passwd' },
      agentId: 'basea',
    });
    expect(baseCmd.ok).toBe(false);
    expect(baseCmd.error).toMatch(/沙箱/);

    // sandbox：软边界仍生效（同 base——扫描不随 sandbox 跳过）
    const sandboxCmd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'cat /etc/passwd' },
      agentId: 'sandboxa',
    });
    expect(sandboxCmd.ok).toBe(false);
    expect(sandboxCmd.error).toMatch(/沙箱/);

    // full："不做任何限制"的字面义——workdir 白名单与命令扫描都跳过
    const fullWd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'echo full-ok', workdir: outside },
      agentId: 'fulla',
    });
    expect(fullWd.ok).toBe(true);
    expect(String(fullWd.output?.output ?? '')).toContain('full-ok');
    const fullCmd = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'cat /etc/passwd' },
      agentId: 'fulla',
    });
    expect(fullCmd.error ?? '').not.toMatch(/沙箱/);

    // 审批 elevation（base + call.elevation=full）同款跳过
    const elevated = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'cat /etc/passwd', workdir: outside },
      agentId: 'basea',
      elevation: 'full-access',
    });
    expect(elevated.error ?? '').not.toMatch(/沙箱/);
  });
});
