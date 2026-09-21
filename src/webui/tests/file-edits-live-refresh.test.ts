// @vitest-environment jsdom
// ============================================================
// webui/tests/file-edits-live-refresh.test.ts —— 文件编辑面板
// 直播刷新链验收（2026-12 前端反馈：运行中编辑存量文件，面板提示
// 「此文件在会话开始前已存在…无法重建内容」直到刷新页面才恢复——
// 根因 = 旧版只在 loop/after-run 刷新快照，run 进行中编辑首见落盘
// 后无人拉取；修复 = 增听 tool/after-execute（write/edit/str_replace_
// editor 执行完毕即刷新，会话键匹配）。本测试锁定该刷新链：帧 →
// 面板 rpc.onEvent → fileSnapshots/list → applySnapshots 消除 partial。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { makeRpcStub } from './lib/rpcStub';
import { useFeedStore } from 'ac-client-ui-conversation/client/feedStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import type { ClientContext } from 'ac-client-runtime';

/** 挂载 FileEditsPanelHost（面板事件订阅在 setup 期建立） */
async function mountPanel(ctx: ClientContext) {
  const { createApp, h, nextTick } = await import('vue');
  const { CLIENT_CONTEXT_KEY } = await import('ac-client-runtime');
  const Host = (await import('ac-client-ui-conversation/client/FileEditsPanelHost.vue')).default;
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = createApp({ render: () => h(Host) });
  app.use(pinia);
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  const mountRoot = document.createElement('div');
  document.body.appendChild(mountRoot);
  app.mount(mountRoot);
  await nextTick();
  return app;
}

/** 直播帧序列：run 启动 → 模型输出 run_code 调用 → 子调用 edit 存量文件 */
function emitEditRun(rpc: ReturnType<typeof makeRpcStub>, conv: string, agent: string, filePath: string, tcId: string, opts?: { beforeAfterExecute?: () => void }) {
  const meta = { agent, conversationId: conv, sender: 'user', source: 'user' };
  rpc.emit('loop/run-started', { agent, conversationId: conv, sender: 'user', source: 'user' });
  rpc.emit('loop/step-started', agent, 0, [], meta);
  rpc.emit('llm/delta-start', { model: 'm' }, meta);
  rpc.emit('llm/delta', { model: 'm' }, { toolCalls: [{ index: 0, id: 'call-' + tcId, name: 'run_code', argumentsDelta: '{}' }] }, meta);
  rpc.emit('llm/delta-end', { model: 'm' }, meta);
  rpc.emit('loop/after-step', agent, { toolCalls: [{ id: 'call-' + tcId, name: 'run_code' }] }, meta);
  const call = { toolCallId: tcId, name: 'edit', agentId: agent, conversationId: conv, runCodeSubcall: true, args: { file_path: filePath, old_string: 'line1', new_string: 'LINE1' } };
  rpc.emit('tool/started', call);
  // 生产时序：服务端 snapshotBefore 在工具体内落盘（先于 after-execute emit）
  opts?.beforeAfterExecute?.();
  rpc.emit('tool/after-execute', call, { ok: true, output: { path: filePath, diff_added: 1, diff_removed: 1 } }, undefined);
}

/** 从面板 DOM 元素反查 FileEditsPanel 组件实例（setupState 探针） */
function panelInstance(): any {
  const panelEl: any = document.querySelector('.fe-panel');
  let found: any = panelEl?.__vueParentComponent ?? null;
  while (found && (found.type?.__name ?? found.type?.name) !== 'FileEditsPanel') found = found.parent;
  return found;
}

describe('文件编辑面板直播刷新链', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = ''; // 隔离前测试的挂载残留
  });

  it('pair 会话：run_code 子调用 edit 存量文件 → after-execute 帧刷新快照 → partial 消除', async () => {
    const snaps = [{ absPath: 'C:/proj/src/a.ts', content: 'line1\nline2\n', capturedAt: 1 }];
    const rpc = makeRpcStub();
    rpc.impl.call = async <T,>(method: string): Promise<T> => {
      if (method === 'fileSnapshots/list') return { snapshots: snaps } as unknown as T;
      if (method === 'fileSnapshots/read-current') return { contents: {} } as unknown as T;
      return {} as T;
    };
    const { ctx } = await bootWebuiRuntime(rpc.impl);
    ctx.sessions.init(); // wire 帧订阅启动（main.ts 同款）
    useRosterCore().activeAgentId.value = 'news'; // 激活 news 对话（pair:news|user）
    const feed = useFeedStore();
    const app = await mountPanel(ctx);
    emitEditRun(rpc, 'news~user', 'news', 'src/a.ts', 'run-1#1');
    await new Promise((r) => setTimeout(r, 600)); // 面板 250ms 防抖 + rpc 往返
    // 分区收到子调用（feed 侧落卡）
    const d = feed.dialogs['pair:news|user'];
    expect(d).toBeTruthy();
    expect(d.rawMessages.filter((m) => m.role === 'tool' && m.subcall).length).toBeGreaterThan(0);
    // 面板金标：该文件 partial 消除（快照接管断链——旧版此时仍提示「无法重建」）
    const found = panelInstance();
    expect(found).toBeTruthy();
    const s = (found.setupState.analysis.files as Map<string, { partial: boolean; baseContent: string | null }>).get('src/a.ts');
    expect(s).toBeTruthy();
    expect(s.partial).toBe(false);
    expect(s.baseContent).toBe('line1\nline2\n');
    app.unmount();
  });

  it('single 会话（报障现场形态）：生产时序（首拉快照缺席，编辑后落盘）→ partial 消除', async () => {
    const sid = 'd0587524-bceb-468a-92d3-ee107702e69c';
    const snaps = [{ absPath: 'C:/proj/src/webui-kit/src/icons.ts', content: 'icon-a\n', capturedAt: 1 }];
    let snapshotReady = false; // 生产时序：首拉（面板挂载时）快照未落盘 → 空
    const rpc = makeRpcStub();
    rpc.impl.call = async <T,>(method: string): Promise<T> => {
      if (method === 'fileSnapshots/list') return { snapshots: snapshotReady ? snaps : [] } as unknown as T;
      if (method === 'fileSnapshots/read-current') return { contents: {} } as unknown as T;
      return {} as T;
    };
    const { ctx } = await bootWebuiRuntime(rpc.impl);
    ctx.sessions.init();
    const feed = useFeedStore();
    const { chatPresence } = await import('ac-client-ui-conversation/client/chatOps.ts');
    chatPresence.knownSingles.add(sid); // singles 帧路由前提（真实链 = singles 行 list 后登记）
    feed.setActiveSingle(sid, 'dev');
    const app = await mountPanel(ctx);
    emitEditRun(rpc, sid, 'dev', 'src/webui-kit/src/icons.ts', 'run-2#1', {
      beforeAfterExecute: () => { snapshotReady = true; }, // 服务端 snapshotBefore 落盘（先于 after-execute 帧）
    });
    await new Promise((r) => setTimeout(r, 600));
    const d = feed.dialogs['single:' + sid];
    expect(d).toBeTruthy();
    expect(d.rawMessages.filter((m) => m.role === 'tool' && m.subcall).length).toBeGreaterThan(0);
    const found = panelInstance();
    expect(found).toBeTruthy();
    const s = (found.setupState.analysis.files as Map<string, { partial: boolean; baseContent: string | null }>).get('src/webui-kit/src/icons.ts');
    expect(s).toBeTruthy();
    expect(s.partial).toBe(false);
    expect(s.baseContent).toBe('icon-a\n');
    app.unmount();
  });
});