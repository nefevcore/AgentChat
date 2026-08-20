// ============================================================
// @agentchat/str-replace-editor —— str_replace_editor 语义测试
//
// DSH dsh-tool-str-replace-editor 行为移植验证：
//   view：cat -n 行号 / view_range（含 -1 尾区间）/ 目录两层列表
//   create：新建成功、已存在拒绝
//   str_replace：唯一替换、零匹配失败、多匹配失败（带行号）、
//                new_str 缺省删除、CRLF 与制表符保留
//   insert：边界 0 / 中间 / == 行数、多行 new_str、越界拒绝
//   沙箱：越界路径被 resolveSafePath 拒绝
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agentchat/agent-config';
import { makeStrReplaceEditorTool } from '@agentchat/str-replace-editor';

const config = { agent_id: 'sre-test', name: 'SRE Test' } as AgentConfig;
let wsRoot = '';

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-sre-'));
  process.env.AGENTCHAT_WORKSPACE = wsRoot;
});

afterAll(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

function parse(out: string | { content: string }): any {
  return JSON.parse(typeof out === 'string' ? out : out.content);
}

describe('str_replace_editor 工具', () => {
  const tool = makeStrReplaceEditorTool(config);

  it('view 文件：6 宽行号 + 两空格；total_lines 正确', async () => {
    fs.writeFileSync(path.join(wsRoot, 'v.txt'), 'l1\nl2\nl3', 'utf-8');
    const out = parse(await tool.execute!({ command: 'view', path: 'v.txt' } as any));
    expect(out.status).toBe('ok');
    expect(out.data.total_lines).toBe(3);
    expect(out.data.content).toContain('     1  l1');
    expect(out.data.content).toContain('     3  l3');
  });

  it('view_range：[2,3] 区间与 [2,-1] 到文件尾', async () => {
    const out = parse(await tool.execute!({ command: 'view', path: 'v.txt', view_range: [2, 3] } as any));
    expect(out.status).toBe('ok');
    expect(out.data.content).toContain('     2  l2');
    expect(out.data.content).not.toContain('l1\n');
    const tail = parse(await tool.execute!({ command: 'view', path: 'v.txt', view_range: [2, -1] } as any));
    expect(tail.data.content).toContain('     3  l3');
  });

  it('view_range 越界/倒序报错', async () => {
    expect(parse(await tool.execute!({ command: 'view', path: 'v.txt', view_range: [0, 2] } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'view', path: 'v.txt', view_range: [3, 1] } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'view', path: 'v.txt', view_range: [1, 99] } as any)).status).toBe('error');
  });

  it('view 目录：下探两层、跳过隐藏与 node_modules、d/f 前缀', async () => {
    fs.mkdirSync(path.join(wsRoot, 'proj', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'proj', '.hidden'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'proj', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'proj', 'a.ts'), 'a');
    fs.writeFileSync(path.join(wsRoot, 'proj', 'sub', 'b.ts'), 'b');
    fs.writeFileSync(path.join(wsRoot, 'proj', '.hidden', 'h.ts'), 'h');
    fs.writeFileSync(path.join(wsRoot, 'proj', 'node_modules', 'x.js'), 'x');
    const out = parse(await tool.execute!({ command: 'view', path: 'proj' } as any));
    expect(out.status).toBe('ok');
    expect(out.data.content).toContain('proj/sub');
    expect(out.data.content).toContain('proj/a.ts');
    expect(out.data.content).not.toContain('node_modules/');
    expect(out.data.content).not.toContain('.hidden/');
    expect(out.data.content).not.toContain('x.js');
  });

  it('create：新建成功（含父目录）；已存在拒绝且内容不变', async () => {
    const out = parse(await tool.execute!({ command: 'create', path: 'dir/new.txt', file_text: 'hello' } as any));
    expect(out.status).toBe('ok');
    expect(fs.readFileSync(path.join(wsRoot, 'dir', 'new.txt'), 'utf-8')).toBe('hello');
    const dup = parse(await tool.execute!({ command: 'create', path: 'dir/new.txt', file_text: 'other' } as any));
    expect(dup.status).toBe('error');
    expect(fs.readFileSync(path.join(wsRoot, 'dir', 'new.txt'), 'utf-8')).toBe('hello');
    expect(parse(await tool.execute!({ command: 'create', path: 'dir/noop.txt' } as any)).status).toBe('error');
  });

  it('str_replace：唯一匹配替换成功；new_str 缺省为删除', async () => {
    fs.writeFileSync(path.join(wsRoot, 'r.txt'), 'keep A\nswap me\nkeep B\n', 'utf-8');
    const out = parse(await tool.execute!({ command: 'str_replace', path: 'r.txt', old_str: 'swap me', new_str: 'replaced' } as any));
    expect(out.status).toBe('ok');
    expect(fs.readFileSync(path.join(wsRoot, 'r.txt'), 'utf-8')).toBe('keep A\nreplaced\nkeep B\n');
    const del = parse(await tool.execute!({ command: 'str_replace', path: 'r.txt', old_str: 'replaced' } as any));
    expect(del.status).toBe('ok');
    expect(fs.readFileSync(path.join(wsRoot, 'r.txt'), 'utf-8')).toBe('keep A\n\nkeep B\n');
  });

  it('str_replace：零匹配失败；多匹配失败并给出全部行号；空 old_str 拒绝', async () => {
    fs.writeFileSync(path.join(wsRoot, 'm.txt'), 'dup\ndup\nother\n', 'utf-8');
    const none = parse(await tool.execute!({ command: 'str_replace', path: 'm.txt', old_str: 'nope', new_str: 'x' } as any));
    expect(none.status).toBe('error');
    expect(none.data.message).toContain('未执行替换');
    const multi = parse(await tool.execute!({ command: 'str_replace', path: 'm.txt', old_str: 'dup', new_str: 'x' } as any));
    expect(multi.status).toBe('error');
    expect(multi.data.message).toContain('[1, 2]');
    expect(fs.readFileSync(path.join(wsRoot, 'm.txt'), 'utf-8')).toBe('dup\ndup\nother\n'); // 未落盘
    expect(parse(await tool.execute!({ command: 'str_replace', path: 'm.txt', old_str: '', new_str: 'x' } as any)).status).toBe('error');
  });

  it('str_replace：CRLF 与编辑范围外的制表符原样保留', async () => {
    fs.writeFileSync(path.join(wsRoot, 'crlf.txt'), 'a\r\n\tindented\r\nz\r\n', 'utf-8');
    const out = parse(await tool.execute!({ command: 'str_replace', path: 'crlf.txt', old_str: '\tindented', new_str: '\tchanged' } as any));
    expect(out.status).toBe('ok');
    expect(fs.readFileSync(path.join(wsRoot, 'crlf.txt'), 'utf-8')).toBe('a\r\n\tchanged\r\nz\r\n');
  });

  it('insert：边界 0 / 中间 / == 行数；多行 new_str；越界拒绝；成功消息含双表述位置与现总行数', async () => {
    fs.writeFileSync(path.join(wsRoot, 'i.txt'), 'one\nthree', 'utf-8');
    const mid = parse(await tool.execute!({ command: 'insert', path: 'i.txt', insert_line: 1, new_str: 'two\ntwo-b' } as any));
    expect(mid.status).toBe('ok');
    // 双表述自校验：insert_line=1 → 第 1 行之后 / 第 2 行之前（提示回归——主描述曾只讲端点，
    // 模型对中间值语义不确定；对照 DSH 上游后统一为「第 N 行之后」框架）
    expect(mid.data.message).toContain('insert_line=1');
    expect(mid.data.message).toContain('第 1 行之后 / 第 2 行之前');
    expect(mid.data.message).toContain('4 行'); // 2 + 2（多行 new_str）
    expect(fs.readFileSync(path.join(wsRoot, 'i.txt'), 'utf-8')).toBe('one\ntwo\ntwo-b\nthree');
    const head = parse(await tool.execute!({ command: 'insert', path: 'i.txt', insert_line: 0, new_str: 'zero' } as any));
    expect(head.status).toBe('ok');
    expect(head.data.message).toContain('文件开头'); // 0 分支不产「第 0 行之后」式歧义
    expect(fs.readFileSync(path.join(wsRoot, 'i.txt'), 'utf-8')).toBe('zero\none\ntwo\ntwo-b\nthree');
    const lines = fs.readFileSync(path.join(wsRoot, 'i.txt'), 'utf-8').split('\n');
    const tail = parse(await tool.execute!({ command: 'insert', path: 'i.txt', insert_line: lines.length, new_str: 'tail' } as any));
    expect(tail.status).toBe('ok');
    expect(tail.data.message).toContain('文件尾');
    expect(parse(await tool.execute!({ command: 'insert', path: 'i.txt', insert_line: 999, new_str: 'x' } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'insert', path: 'i.txt', new_str: 'x' } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'insert', path: 'i.txt', insert_line: 0 } as any)).status).toBe('error');
  });

  it('insert 描述文本（提示回归钉子）：行后框架 + 直接传 view 行号（对齐 DSH 上游 "inserted AFTER the line insert_line"）', async () => {
    // 2026-08-20 提示回归：旧主描述只讲端点（0=开头/=行数=尾），中间值靠猜，
    // 模型自我怀疑「insert_line=310 是插到第 310 行之后？」；修复版一度改用
    // 「零基边界 + L-1 换算」表述，对照 DSH 上游（lib/index.js insert_line 参数
    // 描述）后收敛为「第 N 行之后（1 基、与 view 一致，直接传 L）」——零换算。
    const fn = (tool as any).definition.function;
    expect(fn.description).toContain('插到第 insert_line 行之后');
    expect(fn.description).toContain('直接传 L 即可，无需换算');
    expect(fn.description).toContain('0=插到文件开头');
    expect(fn.description).toContain('=总行数=插到文件尾');
    expect(fn.parameters.properties.insert_line.description).toContain('插到第 insert_line 行之后');
    expect(fn.parameters.properties.insert_line.description).toContain('与 view 显示一致');
  });

  it('insert：文件以换行结尾时行数含空尾行（与 view total_lines 一致）——边界=行数 插在末尾换行之后', async () => {
    // 'a\nb\n' split → ['a','b','']：total_lines=3（view 同口径显示空行 3）。
    // 边界 3 = 空尾行之后（文件尾）→ 新文本前多一空行且文件不再以换行结尾；
    // 边界 2 = 末内容行之后 → 新文本落在结尾换行之前。行为钉子（DSH/SWE-agent 语义）。
    fs.writeFileSync(path.join(wsRoot, 'nl.txt'), 'a\nb\n', 'utf-8');
    const t3 = parse(await tool.execute!({ command: 'insert', path: 'nl.txt', insert_line: 3, new_str: 'tail' } as any));
    expect(t3.status).toBe('ok');
    expect(t3.data.message).toContain('文件尾');
    expect(fs.readFileSync(path.join(wsRoot, 'nl.txt'), 'utf-8')).toBe('a\nb\n\ntail');
    const t2 = parse(await tool.execute!({ command: 'insert', path: 'nl.txt', insert_line: 2, new_str: 'mid' } as any));
    expect(t2.status).toBe('ok');
    expect(fs.readFileSync(path.join(wsRoot, 'nl.txt'), 'utf-8')).toBe('a\nb\nmid\n\ntail');
  });

  it('目录目标只允许 view；不存在的路径报错；未知命令报错', async () => {
    expect(parse(await tool.execute!({ command: 'str_replace', path: 'proj', old_str: 'a', new_str: 'b' } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'view', path: 'missing.txt' } as any)).status).toBe('error');
    expect(parse(await tool.execute!({ command: 'append', path: 'v.txt' } as any)).status).toBe('error');
  });

  it('沙箱：越界路径被拒绝', async () => {
    const out = parse(await tool.execute!({ command: 'view', path: '../../../etc' } as any));
    expect(out.status).toBe('error');
    expect(out.data.message).toContain('沙箱');
  });

  it('view 后 hashline 快照已记录（edit 工具的行哈希校验可用新快照）', async () => {
    // write 后 str_replace_editor 修改 → 快照应更新（write 工具同口径的 P0-2 回归）
    fs.writeFileSync(path.join(wsRoot, 'snap.txt'), 'v1\nv2\n', 'utf-8');
    await tool.execute!({ command: 'view', path: 'snap.txt' } as any);
    expect(parse(await tool.execute!({ command: 'str_replace', path: 'snap.txt', old_str: 'v2', new_str: 'v2b' } as any)).status).toBe('ok');
    const { getSnapshot } = await import('@agentchat/edit');
    const snap = getSnapshot(path.join(wsRoot, 'snap.txt'));
    expect(snap?.content ?? snap).toContain('v2b');
  });

  it('挂载工作目录（security.workdir）：相对路径落到挂载目录而非工作区根（回归：黑洞会话误写 workspace/default）', async () => {
    const mounted = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-sre-mount-'));
    try {
      // withExtraAllowedPaths 的装配产物形态：allowedPaths[0] = workdir = 挂载文件夹
      const mountedConfig = {
        agent_id: '__minimal__',
        name: '极简模式',
        preset: true,
        security: { allowedPaths: [mounted], workdir: mounted },
      } as AgentConfig;
      const mountedTool = makeStrReplaceEditorTool(mountedConfig);

      const out = parse(await mountedTool.execute!({ command: 'create', path: 'gargantua/index.html', file_text: '<h1>ok</h1>' } as any));
      expect(out.status).toBe('ok');
      // 落在挂载目录
      expect(fs.existsSync(path.join(mounted, 'gargantua', 'index.html'))).toBe(true);
      // 未污染工作区根
      expect(fs.existsSync(path.join(wsRoot, 'gargantua'))).toBe(false);

      // view / str_replace 同基准往返
      const v = parse(await mountedTool.execute!({ command: 'view', path: 'gargantua/index.html' } as any));
      expect(v.status).toBe('ok');
      const r = parse(await mountedTool.execute!({ command: 'str_replace', path: 'gargantua/index.html', old_str: 'ok', new_str: 'done' } as any));
      expect(r.status).toBe('ok');
      expect(fs.readFileSync(path.join(mounted, 'gargantua', 'index.html'), 'utf-8')).toContain('done');
    } finally {
      fs.rmSync(mounted, { recursive: true, force: true });
    }
  });
});
