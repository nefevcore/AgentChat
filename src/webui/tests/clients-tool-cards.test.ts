// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-cards.test.ts —— 工具卡行 client 半边验收
//
// M28 P2 §2.2 镜像表：五卡行（shell/fs/web/browser/subagent）贡献
// tool-card:result-view；tool 基础件零卡（席位+解析面+选举语义）。
// 卸行 → 该域 def 消失 → resolve 回落文本渲染。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { resolveToolResultView } from '../src/core/registry/toolResultViews';
import { shellCardClientPlugin } from 'ac-client-ui-shell/client';
import { fsCardClientPlugin } from 'ac-client-ui-fs/client';
import { webCardClientPlugin } from 'ac-client-ui-web/client';
import { browserCardClientPlugin } from 'ac-client-ui-browser/client';
import { subagentClientPlugin } from 'ac-client-ui-subagent/client';
import { runCodeCardClientPlugin } from 'ac-client-ui-run-code/client';

describe('M28 P2 · 五工具卡行（§2.2 镜像表——tool 零卡，卡片 = 卡行贡献）', () => {
  it('shell：bash 终端卡；卸载 → 回落文本渲染', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(shellCardClientPlugin);
    expect(resolveToolResultView('bash')).toBeTruthy();
    await fiber.dispose();
    expect(resolveToolResultView('bash')).toBeNull();
  });

  it('fs：read/write/edit 三卡一行（同后端域）；卸载 → 三卡齐落', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(fsCardClientPlugin);
    expect(resolveToolResultView('read')).toBeTruthy();
    expect(resolveToolResultView('write')).toBeTruthy();
    expect(resolveToolResultView('edit')).toBeTruthy();
    await fiber.dispose();
    expect(resolveToolResultView('read')).toBeNull();
    expect(resolveToolResultView('write')).toBeNull();
    expect(resolveToolResultView('edit')).toBeNull();
  });

  it('web：web_search + 浏览器族正则（fetch_webpage 等 11 工具）双 def', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(webCardClientPlugin);
    expect(resolveToolResultView('web_search')).toBeTruthy();
    expect(resolveToolResultView('fetch_webpage')).toBeTruthy();
    expect(resolveToolResultView('run_playwright_code')).toBeTruthy();
    await fiber.dispose();
    expect(resolveToolResultView('web_search')).toBeNull();
    expect(resolveToolResultView('fetch_webpage')).toBeNull();
  });

  it('browser：browser 多动作卡；subagent：清单卡', async () => {
    const { ctx } = await bootWebuiRuntime();
    const bFiber = await ctx.plugin(browserCardClientPlugin);
    const sFiber = await ctx.plugin(subagentClientPlugin);
    expect(resolveToolResultView('browser')).toBeTruthy();
    expect(resolveToolResultView('subagent')).toBeTruthy();
    await bFiber.dispose();
    await sFiber.dispose();
    expect(resolveToolResultView('browser')).toBeNull();
    expect(resolveToolResultView('subagent')).toBeNull();
  });

  it('run_code：程序卡；卸载 → 回落文本渲染；词条/图标随行走', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(runCodeCardClientPlugin);
    expect(resolveToolResultView('run_code')).toBeTruthy();
    const { toolDisplayLabel } = await import('ac-client-ui-tool/client/toolLabel.ts');
    const { toolIconName } = await import('ac-client-ui-tool/client/toolIcon.ts');
    expect(toolIconName('run_code')).toBe('braces');
    expect(toolDisplayLabel('run_code', 'run_code', { code: '// 程序化模式测试\nreturn 1;' })).toBe('运行程序 · 程序化模式测试');
    await fiber.dispose();
    expect(resolveToolResultView('run_code')).toBeNull();
    // 卸载后回落静态表词条（同值）
    expect(toolIconName('run_code')).toBe('braces');
    expect(toolDisplayLabel('run_code', 'run_code', { code: 'return 1;' })).toBe('运行程序 · return 1;');
  });

  it('M28 P3/T9 · 词条随卡行走：行装载 → toolDisplayLabel/toolIconName 取 meta；卸载 → 回落静态表', async () => {
    const { ctx } = await bootWebuiRuntime();
    const { toolDisplayLabel } = await import('ac-client-ui-tool/client/toolLabel.ts');
    const { toolIconName } = await import('ac-client-ui-tool/client/toolIcon.ts');
    const { shellCardClientPlugin } = await import('ac-client-ui-shell/client');
    const fiber = await ctx.plugin(shellCardClientPlugin);
    // 行装载：meta 词条（注册表 election 优先）
    expect(toolIconName('bash')).toBe('terminal');
    await fiber.dispose();
    // 行卸载：回落静态表词条（同值——静态表为无 runtime/行缺席回落词汇）
    expect(toolIconName('bash')).toBe('terminal');
    expect(toolDisplayLabel('bash', 'bash', { command: 'ls' })).toBe('执行命令 · ls');
  });
});
