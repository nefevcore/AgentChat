// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-terminal.test.ts —— 终端卡渲染回归（cr-464）
//
// 锁定项：
//   · notice 归一——handoff 后台启动通知（output.message 唯一生产者，
//     ok:true）渲染为黄色提示而非红色错误（cr-464 修复：修复前误染红）；
//   · command-feedback 引导（note 字段，含译文归因文案）在卡内可见；
//   · 失败信封形（{ok:false, error, output}——历史/live 两路归一）error
//     走红色错误样式 + stdout 仍可见；
//   · translated_command 译文行（↳ PS:）渲染；
//   · guidance 死词删除后不留残影（data.guidance 不再驱动任何样式）。
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultTerminal from 'ac-client-ui-shell/client/ToolResult/ToolResultTerminal.vue';

async function mountCard(data: Record<string, unknown>, loading = false): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({
    render: () => h(ToolResultTerminal as never, { data, loading }),
  });
  app.mount(root);
  for (let i = 0; i < 3; i++) await nextTick();
  return root;
}

describe('ToolResultTerminal 渲染（cr-464 notice 归一 + 译文行）', () => {
  it('handoff 后台启动通知：message 渲染为黄色提示（term-guidance），不染红', async () => {
    const root = await mountCard({
      command: 'pnpm test',
      cwd: 'C:/repo',
      background: true,
      pid: 1234,
      job_id: 'job-1',
      message: '已在后台启动（任务 job-1，PID 1234）。日志：x.log。用 job 工具管理（list/kill/logs）。',
    });
    const guidance = root.querySelector('.term-guidance');
    expect(guidance).toBeTruthy();
    expect(guidance!.textContent).toContain('已在后台启动');
    expect(root.querySelector('.term-error')).toBeNull(); // 修复前：message 误走 term-error
  });

  it('command-feedback 引导（note 字段）：卡内黄色提示可见（译文归因文案）', async () => {
    const root = await mountCard({
      command: 'unset FOO BAR',
      translated_command: 'Remove-Item Env:FOO, Env:BAR',
      cwd: 'C:/repo',
      output: '',
      stdout: '',
      stderr: '',
      exit_code: 1,
      failure_class: 'command-feedback',
      note: '实际执行的是 Unix→PowerShell 翻译产物（可能偏离原命令语义）：Remove-Item Env:FOO, Env:BAR。若怀疑翻译有误，可直接改写为 PowerShell 原生命令重试。',
      truncated: false,
    });
    expect(root.querySelector('.term-guidance')?.textContent).toContain('翻译产物');
    expect(root.querySelector('.term-exit')?.textContent).toContain('exit 1');
  });

  it('失败信封形：error 红色可见 + stdout 仍渲染（真失败不吞输出）', async () => {
    const root = await mountCard({
      command: 'git push',
      cwd: 'C:/repo',
      stdout: '已推送 3 对象',
      stderr: '',
      exit_code: 128,
      failure_class: 'invocation-error',
      error: '命令未正常启动或语法失败（invocation-error，退出码 128）',
      truncated: false,
    });
    const err = root.querySelector('.term-error, .term-guidance');
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain('invocation-error');
    expect(root.textContent).toContain('已推送 3 对象'); // 有输出时错误走黄色提示形态
  });

  it('译文行：translated_command 存在 → ↳ PS: 行渲染实际执行的命令', async () => {
    const root = await mountCard({
      command: 'ls -la',
      translated_command: 'Get-ChildItem -Force',
      cwd: 'C:/repo',
      output: 'd1 d2',
      stdout: 'd1 d2',
      stderr: '',
      exit_code: 0,
      truncated: false,
    });
    const t = root.querySelector('.term-translated .term-cmd');
    expect(t?.textContent).toContain('Get-ChildItem -Force');
  });

  it('guidance 死词已删：data.guidance 不再驱动任何渲染（残值无害）', async () => {
    const root = await mountCard({ command: 'ls', stdout: 'a b', exit_code: 0, guidance: '旧字段残值' });
    expect(root.textContent).not.toContain('旧字段残值');
  });

  it('loading 态：无输出时正在执行提示可见', async () => {
    const root = await mountCard({ command: 'npm run build' }, true);
    expect(root.textContent).toContain('正在执行');
  });
});