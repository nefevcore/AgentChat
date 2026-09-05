// ============================================================
// webui/tests/jobs.test.ts —— 后台任务/子Agent 清单前端面
//
// · splitJobs：running 启动序在前 + 终态最新优先在后（"最近 run"清单）
// · jobIsRunning/jobIsSubagent：stopping 归运行中；kind=subagent 归委派
// · jobsForConversation：会话头入口的发起会话过滤（无会话键 → 空）
// · jobStatusLabel/Icon：状态词汇共享函数（面板/会话头弹层同源）
// · jobOutputPreview：meta.output（settle 回写）优先、detail 兜底、截断
// · fetchJobs/killJob：Rpc 注入 stub——RPC 不可用 → null 静默，不抛出
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  splitJobs,
  jobIsRunning,
  jobIsSubagent,
  jobOutputPreview,
  jobStatusLabel,
  jobStatusIcon,
  jobsForConversation,
  subagentMeta,
  fetchJobs,
  killJob,
  type WireJob,
} from '../src/api/jobs.ts';

function job(partial: Partial<WireJob> & Pick<WireJob, 'id' | 'kind' | 'label' | 'status'>): WireJob {
  return { startedAt: 1_000, ...partial };
}

describe('splitJobs（清单拆分：运行中在前、终态最新优先）', () => {
  it('running/stopping 归运行中（启动序）；终态按 finishedAt 倒序', () => {
    const { running, settled } = splitJobs([
      job({ id: 'bash-3', kind: 'bash', label: 'c', status: 'completed', startedAt: 3_000, finishedAt: 9_000 }),
      job({ id: 'bash-2', kind: 'bash', label: 'b', status: 'running', startedAt: 2_000 }),
      job({ id: 'bash-1', kind: 'bash', label: 'a', status: 'stopping', startedAt: 1_000 }),
      job({ id: 'bash-4', kind: 'bash', label: 'd', status: 'failed', startedAt: 4_000, finishedAt: 5_000 }),
    ]);
    expect(running.map((j) => j.id)).toEqual(['bash-1', 'bash-2']); // 启动序
    expect(settled.map((j) => j.id)).toEqual(['bash-3', 'bash-4']); // 最新优先
  });

  it('终态无 finishedAt 回落 startedAt 排序；空清单安全', () => {
    const { running, settled } = splitJobs([
      job({ id: 'bash-1', kind: 'bash', label: 'x', status: 'killed', startedAt: 1_000 }),
      job({ id: 'bash-2', kind: 'bash', label: 'y', status: 'completed', startedAt: 2_000 }),
    ]);
    expect(running).toEqual([]);
    expect(settled.map((j) => j.id)).toEqual(['bash-2', 'bash-1']);
    expect(splitJobs([])).toEqual({ running: [], settled: [] });
  });
});

describe('判定与预览', () => {
  it('jobIsRunning：stopping 也算未收束；jobIsSubagent：kind 区分', () => {
    expect(jobIsRunning(job({ id: 'a', kind: 'bash', label: '', status: 'running' }))).toBe(true);
    expect(jobIsRunning(job({ id: 'a', kind: 'bash', label: '', status: 'stopping' }))).toBe(true);
    expect(jobIsRunning(job({ id: 'a', kind: 'bash', label: '', status: 'completed' }))).toBe(false);
    expect(jobIsSubagent(job({ id: 'a', kind: 'subagent', label: '', status: 'running' }))).toBe(true);
    expect(jobIsSubagent(job({ id: 'a', kind: 'bash', label: '', status: 'running' }))).toBe(false);
  });

  it('jobsForConversation：按发起会话键过滤（对桶/sid/gid 同词表）；无键 → 空', () => {
    const mine = job({ id: 'bash-1', kind: 'bash', label: 'x', status: 'running', conversationId: 'a~user' });
    const other = job({ id: 'bash-2', kind: 'bash', label: 'y', status: 'running', conversationId: 'b~user' });
    const host = job({ id: 'bash-3', kind: 'bash', label: 'z', status: 'running' }); // 宿主任务无会话键
    expect(jobsForConversation([mine, other, host], 'a~user').map((j) => j.id)).toEqual(['bash-1']);
    expect(jobsForConversation([mine, other, host], null)).toEqual([]);
    expect(jobsForConversation([mine, other, host], undefined)).toEqual([]);
  });

  it('jobStatusLabel/Icon：五态全覆盖（面板与会话头弹层共享词汇）', () => {
    const statuses: WireJob['status'][] = ['running', 'stopping', 'completed', 'failed', 'killed'];
    expect(statuses.map(jobStatusLabel)).toEqual(['运行中', '停止中', '完成', '失败', '已终止']);
    expect(statuses.map(jobStatusIcon)).toEqual(['zap', 'clock', 'check-circle', 'alert-circle', 'ban']);
  });

  it('jobOutputPreview：meta.output 优先 → detail 兜底 → 截断加省略号', () => {
    expect(
      jobOutputPreview(job({ id: 'a', kind: 'bash', label: '', status: 'completed', meta: { output: '结果文本' }, detail: 'exit code: 0' })),
    ).toBe('结果文本');
    expect(jobOutputPreview(job({ id: 'a', kind: 'bash', label: '', status: 'completed', detail: 'exit code: 1' }))).toBe('exit code: 1');
    expect(jobOutputPreview(job({ id: 'a', kind: 'bash', label: '', status: 'completed' }))).toBe('');
    expect(
      jobOutputPreview(job({ id: 'a', kind: 'bash', label: '', status: 'completed', meta: { output: 'x'.repeat(200) } }), 160),
    ).toBe(`${'x'.repeat(160)}…`);
  });

  it('subagentMeta：meta 三键解读；缺失键不透出', () => {
    expect(
      subagentMeta(job({ id: 'a', kind: 'subagent', label: 't', status: 'running', meta: { subagentId: 'sub_1', name: '调研', parentId: 'boss' } })),
    ).toEqual({ subagentId: 'sub_1', name: '调研', parentId: 'boss' });
    expect(subagentMeta(job({ id: 'a', kind: 'subagent', label: 't', status: 'running', meta: { pid: 1 } }))).toEqual({});
  });
});

describe('fetchJobs / killJob（Rpc 注入 stub）', () => {
  it('fetchJobs：jobs 数组透传；非数组 → 空清单；RPC 报错 → null（面静默隐藏）', async () => {
    const ok = { call: async () => ({ jobs: [job({ id: 'bash-1', kind: 'bash', label: 'x', status: 'running' })] }) };
    expect((await fetchJobs(ok as any)).map((j) => j.id)).toEqual(['bash-1']);
    const badShape = { call: async () => ({}) };
    expect(await fetchJobs(badShape as any)).toEqual([]);
    const fail = { call: async () => { throw new Error('rpc 失败'); } };
    expect(await fetchJobs(fail as any)).toBeNull();
  });

  it('killJob：透传 id；RPC 报错 → null（下轮事件帧对账）', async () => {
    const ok = { call: async (_m: string, p?: Record<string, unknown>) => ({ outcome: 'cancellation-requested', ...(p ?? {}) }) };
    expect(await killJob('bash-1', ok as any)).toMatchObject({ outcome: 'cancellation-requested' });
    const fail = { call: async () => { throw new Error('rpc 失败'); } };
    expect(await killJob('bash-1', fail as any)).toBeNull();
  });
});
