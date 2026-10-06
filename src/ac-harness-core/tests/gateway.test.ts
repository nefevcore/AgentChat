// ============================================================
// ac-harness-core —— exec 编排测试（假适配器 + node 真子进程）
// argv 由假适配器全控：看门狗/中止/JSONL 行流/stdin 传递全部可测。
// ============================================================
import { describe, it, expect } from 'vitest';
import { runGateway, type HarnessAdapter } from '../src/gateway.ts';

/** 假适配器：跑 node -e <script>（script 经 req 附加字段传入） */
const NODE_ADAPTER: HarnessAdapter = {
  name: 'claude-code',
  buildArgs: (req) => ['-e', (req as unknown as { script?: string }).script ?? ''],
  lineOutcome: (o) => {
    if (o.type === 'hello') return { ok: true, event: { kind: 'notice', label: String(o.msg) } };
    if (o.type === 'end') return { ok: true, terminal: { finish: 'stop', text: String(o.text) } };
    return { ok: false };
  },
  finalize: (facts, code) => {
    const finish = facts?.finish ?? (code === 0 ? 'stop' : 'error');
    return { ok: finish === 'stop', text: facts?.text ?? '', finish };
  },
};

describe('runGateway 编排', () => {
  it('JSONL 行流归一 + stdin 传递 + 终态收敛', async () => {
    const script = [
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{",
      "  console.log(JSON.stringify({type:'hello',msg:'started'}));",
      "  console.log(JSON.stringify({type:'hello',msg:'工具 X'}));",
      "  console.log(JSON.stringify({type:'end',text:'终稿:'+d.trim()}));",
      '});',
    ].join('\n');
    const events: string[] = [];
    const r = await runGateway(NODE_ADAPTER, process.execPath, {
      prompt: 'TASK-PAYLOAD',
      cwd: process.cwd(),
      script,
    } as never, { onEvent: (e) => { if (e.kind === 'notice') events.push(e.label); } });
    expect(r.finish).toBe('stop');
    expect(r.text).toBe('终稿:TASK-PAYLOAD'); // stdin prompt 原样到达
    expect(events).toEqual(['started', '工具 X']);
  });

  it('看门狗：maxMs 到点 kill，finish=timeout', async () => {
    const r = await runGateway(NODE_ADAPTER, process.execPath, {
      prompt: '',
      cwd: process.cwd(),
      script: 'setTimeout(()=>{},10000)',
      maxMs: 150,
    } as never);
    expect(r.finish).toBe('timeout');
    expect(r.text).toContain('150ms');
  });

  it('中止：AbortSignal → finish=aborted', async () => {
    const ac = new AbortController();
    const p = runGateway(NODE_ADAPTER, process.execPath, {
      prompt: '',
      cwd: process.cwd(),
      script: 'setTimeout(()=>{},10000)',
      signal: ac.signal,
    } as never);
    setTimeout(() => ac.abort(), 80);
    const r = await p;
    expect(r.finish).toBe('aborted');
  });

  it('spawn 失败（命令不存在）→ error + 安装提示', async () => {
    const r = await runGateway(NODE_ADAPTER, 'definitely-missing-cmd-xyz', {
      prompt: '',
      cwd: process.cwd(),
    } as never);
    expect(r.finish).toBe('error');
    expect(r.text).toContain('definitely-missing-cmd-xyz');
    expect(r.text).toContain('安装');
  });

  it('未知事件行丢弃计数 + 损坏行不中断流', async () => {
    const script = [
      "console.log(JSON.stringify({type:'hello',msg:'a'}));",
      "  console.log('<<<损坏行>>>');",
      "  console.log(JSON.stringify({type:'mystery'}));",
      "  console.log(JSON.stringify({type:'end',text:'ok'}));",
    ].join('\n');
    const r = await runGateway(NODE_ADAPTER, process.execPath, {
      prompt: '',
      cwd: process.cwd(),
      script,
    } as never);
    expect(r.finish).toBe('stop');
    expect(r.text).toBe('ok');
  });
});