// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-tool-subagent.test.ts —— subagent 工具卡渲染回归（cr-468）
//
// 锁定项：
//   · 六卡头图经 kit Icon 渲染（sa-head-icon——内联 SVG 双轨退役）；
//   · loading 态忙指示 = BusyRing（cr-129 R2 自建 spinner 退役）；
//   · send 卡折叠判定与 await 卡共用 result 字段（同步 send 长结果
//     折叠按钮可见——修复前 sendData.result 复制遗漏导致按钮恒隐）；
//   · ID 点击进入子会话视角的门卫（sub_ 前缀）。
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ToolResultSubagent from 'ac-client-ui-subagent/client/ToolResult/ToolResultSubagent.vue';

async function mountCard(data: Record<string, unknown>, loading = false): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({
    render: () => h(ToolResultSubagent as never, { data, loading }),
  });
  app.mount(root);
  for (let i = 0; i < 3; i++) await nextTick();
  return root;
}

describe('ToolResultSubagent 渲染（cr-468 Icon/BusyRing/折叠归一）', () => {
  it('spawn 卡：kit Icon 头图 + ID 可点击行在渲染（内联 SVG 双轨退役）', async () => {
    const root = await mountCard({ action: 'spawn', subagent_id: 'sub_1', name: '调研员', status: 'running', task: '查资料' });
    expect(root.querySelector('.sa-head-icon')).toBeTruthy();
    expect(root.querySelector('svg.sa-head-icon')).toBeTruthy(); // kit Icon 渲染的 svg 带 sa-head-icon 类
    expect(root.textContent).toContain('子 Agent 已创建');
    expect(root.textContent).toContain('sub_1');
    expect(root.querySelector('.sa-id-link')).toBeTruthy();
  });

  it('await 卡长结果：折叠态 + 展开按钮可见', async () => {
    const root = await mountCard({ action: 'await', subagent_id: 'sub_1', status: 'done', result: 'x'.repeat(500), elapsed_ms: 1500 });
    expect(root.querySelector('.sa-result.folded')).toBeTruthy();
    expect(root.querySelector('.sa-fold-btn')).toBeTruthy();
    expect(root.textContent).toContain('1.5s');
  });

  it('send 卡（sync 带结果）：折叠判定与 await 共用——长结果折叠按钮可见（修复回归锁）', async () => {
    const root = await mountCard({ action: 'send', subagent_id: 'sub_1', delivered: 'started', status: 'done', result: 'y'.repeat(500), elapsed_ms: 800 });
    expect(root.querySelector('.sa-result.folded')).toBeTruthy();
    expect(root.querySelector('.sa-fold-btn')).toBeTruthy(); // 修复前：sendData.result 复制遗漏 → 恒隐
    expect(root.textContent).toContain('已开跑');
  });

  it('send 卡（async 排队回执，无结果）：无折叠按钮', async () => {
    const root = await mountCard({ action: 'send', subagent_id: 'sub_1', delivered: 'queued', status: 'running', message: '已排队等待下一轮' });
    expect(root.querySelector('.sa-fold-btn')).toBeNull();
    expect(root.querySelector('.sa-result')).toBeNull();
  });

  it('list 卡：kit Icon 头图 + 条目渲染', async () => {
    const root = await mountCard({ action: 'list', active_count: 1, total: 2, subagents: [
      { id: 'sub_1', name: '调研员', status: 'running', task: '查资料', runs: 2, last_result: 'ok' },
      { id: 'sub_2', name: '', status: 'idle', task: '', runs: 0 } ] });
    expect(root.querySelector('.sa-head-icon')).toBeTruthy();
    expect(root.textContent).toContain('1 活跃 / 共 2');
    expect(root.textContent).toContain('调研员');
    expect(root.textContent).toContain('2 轮');
  });

  it('stop / delete 回执：轻量卡渲染（kit Icon）', async () => {
    const stop = await mountCard({ action: 'stop', subagent_id: 'sub_1', stopped: true, message: '已请求停止' });
    expect(stop.textContent).toContain('已停止推理');
    const del = await mountCard({ action: 'delete', subagent_id: 'sub_1', deleted: true });
    expect(del.textContent).toContain('子 Agent 已删除');
    expect(del.querySelector('.sa-head-icon')).toBeTruthy();
  });

  it('loading 态：BusyRing 忙指示 + 动作文案（自建 spinner 退役）', async () => {
    const root = await mountCard({ action: 'spawn', task: '调研一下' }, true);
    expect(root.querySelector('.sa-loading')).toBeTruthy();
    expect(root.querySelector('.busy-ring, .sa-loading svg')).toBeTruthy(); // BusyRing 渲染的 svg
    expect(root.textContent).toContain('派出子 Agent');
    expect(root.querySelector('.sa-spin')).toBeNull(); // 自建 spinner 类已删
  });

  it('ID 点击门卫：sub_ 前缀外不接线（防御面在，不炸）', async () => {
    const root = await mountCard({ action: 'spawn', subagent_id: 'other-id', status: 'idle' });
    const link = root.querySelector('.sa-id-link');
    expect(link).toBeTruthy();
    expect(link!.textContent).toContain('other-id');
  });
});
