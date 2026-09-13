// ============================================================
// tests/tool-label.test.ts —— 工具卡友好标签合成（utils/toolLabel）
//
// label 契约在轨道转正时从后端丢失（各数据面 label=name），
// 展示层按 工具名+参数 重建旧轨 toolLabel/extractLabel 词汇。
// 段间连接符统一为「·」（与思考行「已思考 · XmYs · 预览」同款构造）。
// ============================================================

import { describe, it, expect } from 'vitest';
import { toolDisplayLabel, toolDiffStat } from '../src/utils/toolLabel.ts';

describe('toolDisplayLabel', () => {
  it('label=name（退化合成）→ 友好名 + 参数摘要', () => {
    expect(toolDisplayLabel('read', 'read', { file_path: 'src/main.ts' })).toBe('读取文件 · src/main.ts');
    expect(toolDisplayLabel('write', 'write', { file_path: 'a.txt' })).toBe('写入文件 · a.txt');
    expect(toolDisplayLabel('edit', 'edit', { file_path: 'a.ts', old_string: 'x' })).toBe('编辑文件 · a.ts · 替换');
    expect(toolDisplayLabel('edit', 'edit', { file_path: 'a.ts' })).toBe('编辑文件 · a.ts');
    expect(toolDisplayLabel('bash', 'bash', { command: 'npm test' })).toBe('执行命令 · npm test');
    // bash 优先 description（旧轨语义）
    expect(toolDisplayLabel('bash', 'bash', { command: 'npm test', description: '跑测试' })).toBe('执行命令 · 跑测试');
    // job：意图优先（与 bash description 同语义）；回落 action · job_id
    expect(toolDisplayLabel('job', 'job', { action: 'logs', job_id: 'bash-1', description: '查看构建日志' })).toBe('后台任务 · 查看构建日志');
    expect(toolDisplayLabel('job', 'job', { action: 'kill', job_id: 'bash-2' })).toBe('后台任务 · kill · bash-2');
    expect(toolDisplayLabel('job', 'job', { action: 'list' })).toBe('后台任务 · list');
    expect(toolDisplayLabel('glob', 'glob', { pattern: '**/*.ts' })).toBe('文件匹配 · **/*.ts');
    // grep 摘要截 30 字符
    expect(toolDisplayLabel('grep', 'grep', { pattern: 'x'.repeat(50) })).toBe(`内容搜索 · ${'x'.repeat(30)}`);
    expect(toolDisplayLabel('web_search', 'web_search', { query: 'agentchat' })).toBe('网络搜索 · 搜索 agentchat');
    expect(toolDisplayLabel('subagent', 'subagent', { action: 'spawn', task: '调研一下', tools: ['a', 'b'] })).toBe('子 Agent 调度 · spawn · 调研一下 · 2 工具');
    // send：消息摘要 + 非缺省 mode 标注
    expect(toolDisplayLabel('subagent', 'subagent', { action: 'send', message: '继续调研', mode: 'sync' })).toBe('子 Agent 调度 · send · 继续调研 · sync');
    expect(toolDisplayLabel('subagent', 'subagent', { action: 'send', message: '追问细节' })).toBe('子 Agent 调度 · send · 追问细节');
    expect(toolDisplayLabel('subagent', 'subagent', { action: 'stop', subagent_id: 'sub_1' })).toBe('子 Agent 调度 · stop');
    expect(toolDisplayLabel('subagent', 'subagent', { action: 'delete', subagent_id: 'sub_1' })).toBe('子 Agent 调度 · delete');
  });

  it('参数为 JSON 字符串（OpenAI 风格 arguments）同样生效', () => {
    expect(toolDisplayLabel('read', 'read', '{"file_path":"b.md"}')).toBe('读取文件 · b.md');
    // 非法 JSON 不抛错，退回友好名
    expect(toolDisplayLabel('read', 'read', '{oops')).toBe('读取文件');
  });

  it('显式 label（≠ 工具名）优先——流式占位/未来后端契约直接生效', () => {
    expect(toolDisplayLabel('bash', '正在调用工具: bash', {})).toBe('正在调用工具: bash');
    expect(toolDisplayLabel('read', '读取文件 自定义.md', { file_path: 'x' })).toBe('读取文件 自定义.md');
  });

  it('无参数摘要 → 只显示友好名；未知工具 → 裸名兜底', () => {
    expect(toolDisplayLabel('timer', 'timer', { action: 'list' })).toBe('定时任务');
    expect(toolDisplayLabel('send_agent', 'send_agent', { to: 'helper' })).toBe('发送给 Agent · helper');
    expect(toolDisplayLabel('mcp_custom', 'mcp_custom', { x: 1 })).toBe('mcp_custom');
  });

  it('load_skill → 加载技能 · 技能名（旧名 skill 词条保留：历史记录回放）', () => {
    expect(toolDisplayLabel('load_skill', 'load_skill', { name: 'agentchat-plugin-dev' }))
      .toBe('加载技能 · agentchat-plugin-dev');
    expect(toolDisplayLabel('load_skill', 'load_skill', {})).toBe('加载技能');
    expect(toolDisplayLabel('skill', 'skill', { name: 'code-simplifier' })).toBe('技能 · code-simplifier');
  });

  it('无名无 label → 工具调用兜底；摘要超长截 80 字符并补省略号', () => {
    expect(toolDisplayLabel(undefined, undefined, {})).toBe('工具调用');
    expect(toolDisplayLabel('bash', 'bash', { command: 'c'.repeat(100) })).toBe(`执行命令 · ${'c'.repeat(80)}…`);
    // 恰好 80 字符不截（省略号只在超限时追加）
    expect(toolDisplayLabel('bash', 'bash', { command: 'c'.repeat(80) })).toBe(`执行命令 · ${'c'.repeat(80)}`);
  });
});

describe('toolDiffStat（fs 工具卡 Label +N -M 统计）', () => {
  it('新记录：结构化 diff_added/diff_removed（live 裸 output 形）', () => {
    expect(toolDiffStat('{"path":"a.ts","diff_added":3,"diff_removed":1,"diff":"..."}'))
      .toEqual({ added: 3, removed: 1 });
  });

  it('新记录：历史回放 {ok, output} 信封形', () => {
    expect(toolDiffStat('{"ok":true,"output":{"path":"a.ts","diff_added":12,"diff_removed":0}}'))
      .toEqual({ added: 12, removed: 0 });
  });

  it('旧记录回落：解析 diff 文本 - /+ 前缀行计数（上下文/省略行不计）', () => {
    const diff = '  1 a\n- 2 b\n- 3 c\n+ 2 B\n...\n+ 9 Z';
    expect(toolDiffStat(JSON.stringify({ ok: true, output: { diff } })))
      .toEqual({ added: 2, removed: 2 });
  });

  it('非 JSON / 流式不完整 / 无统计字段 / ok:false → null', () => {
    expect(toolDiffStat('原始文本输出')).toBeNull();
    expect(toolDiffStat('{"path":"a.ts","diff_ad')).toBeNull();
    expect(toolDiffStat('{"ok":true,"output":{"message":"已写入 a.txt","path":"a.txt"}}')).toBeNull();
    expect(toolDiffStat('{"ok":false,"error":"失败"}')).toBeNull();
    expect(toolDiffStat('')).toBeNull();
    expect(toolDiffStat(undefined)).toBeNull();
  });

  it('（无变更）与全 0 → 不展示（null）', () => {
    expect(toolDiffStat('{"ok":true,"output":{"diff":"（无变更）"}}')).toBeNull();
    expect(toolDiffStat('{"ok":true,"output":{"diff_added":0,"diff_removed":0}}')).toBeNull();
  });
});
