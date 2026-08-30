// ============================================================
// @agentchat/shell/src/job.ts —— 后台任务管理工具（job）
//
// 第二阶段（docs/tool-design-roadmap.md §2）：登记表已提升为通用
// ctx.jobs 服务（@agentchat/jobs），本文件只剩两件事：
//   · makeJobTool(config, jobs)：按 owner 隔离的 list/kill/logs 工具面；
//   · killProcessTree / isProcessAlive：bash 与 job 共用的进程原语。
//
// 语义（对齐 DSH job_*，见 docs/dsh-jobs-comparison.md）：
//   · 模型拿不透明 id（bash-N / subagent-N），kill 只接受已登记 id
//     （任意 PID 的进程操作走 bash 内 Stop-Process，工具层不提供通道）；
//   · list/kill/logs 只作用于本 Agent 的任务（owner 分桶）；
//   · 完成通知由 boot 接线 ctx.jobs.onJobDone → job.done 事件广播。
// ============================================================
import * as fs from 'fs';
import { spawn } from 'child_process';
import { defineTool } from '@agentchat/toolkit';
import { CAPABILITY_BASE } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { JobService } from '@agentchat/jobs';

/** 进程是否存活（kill(pid, 0)：无异常 = 存活；EPERM = 存在但无权限；ESRCH = 不存在） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** 杀整个进程树（Windows: taskkill /F /T；Unix: 负 PID kill） */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* taskkill 本身失败忽略 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程可能已退出 */ }
  }
}

/** 读取日志文件尾部 N 行（bash 后台任务的 log_file；不存在返回空） */
export function tailLogFile(file: string, lines: number): string {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/**
 * 后台任务管理工具（list/kill/logs；配套 bash background 与 subagent，
 * 经 ctx.jobs 统一管理，按 owner 隔离）。
 */
export function makeJobTool(config: AgentConfig, jobs?: JobService): Tool {
  const selfId = config.agent_id;
  return defineTool({
    name: 'job', label: '任务管理', requires: [CAPABILITY_BASE],
    description: '管理后台任务：list 列出、kill 终止、logs 查看输出。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'kill', 'logs'], description: '操作' },
        job_id: { type: 'string', description: '[kill/logs] 任务 id（bash background / subagent 返回）' },
        limit: { type: 'number', description: '[logs] 返回尾部行数（默认 50，最大 500）', minimum: 1, maximum: 500 },
      },
      required: ['action'],
    },
    execute: async (args) => {
      const action = args.action;
      try {
        if (!jobs) {
          return JSON.stringify({ status: 'error', data: { message: 'ctx.jobs 服务不可用（未装载 @agentchat/jobs 行）' } });
        }
        if (action === 'list') {
          const jobsList = jobs.list(selfId).map((j) => {
            const pid = typeof j.meta?.pid === 'number' ? j.meta.pid : undefined;
            const logFile = typeof j.meta?.logFile === 'string' ? j.meta.logFile : undefined;
            return {
              id: j.id,
              kind: j.kind,
              command: typeof j.meta?.command === 'string' ? j.meta.command : j.label,
              ...(logFile ? { log_file: logFile } : {}),
              started_at: new Date(j.startedAt).toISOString(),
              status: j.status,
              ...(j.detail !== undefined ? { detail: j.detail } : {}),
              ...(j.finishedAt !== undefined ? { finished_at: new Date(j.finishedAt).toISOString() } : {}),
              ...(pid !== undefined ? { alive: isProcessAlive(pid), log_size: logFile && fs.existsSync(logFile) ? fs.statSync(logFile).size : 0 } : {}),
            };
          });
          return JSON.stringify({ status: 'ok', data: { count: jobsList.length, jobs: jobsList } });
        }

        if (action === 'kill') {
          const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
          if (!id) {
            return JSON.stringify({ status: 'error', data: { message: '缺少 job_id 参数（bash background / subagent 返回的任务 id）' } });
          }
          const { outcome, job } = jobs.kill(id, selfId);
          return JSON.stringify({
            status: 'ok',
            data: {
              outcome,
              job_id: id,
              message: outcome === 'already-finished'
                ? `后台任务 ${id} 已结束（${job.status}${job.detail ? `, ${job.detail}` : ''}）`
                : `已请求终止后台任务 ${id}（settle 为 killed）`,
            },
          });
        }

        if (action === 'logs') {
          const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
          if (!id) {
            return JSON.stringify({ status: 'error', data: { message: '缺少 job_id 参数（要读取输出的任务 id）' } });
          }
          const { text, job } = jobs.read(id, selfId);
          const logFile = typeof job.meta?.logFile === 'string' ? job.meta.logFile : undefined;
          const lines = Math.min(500, Math.max(1, Number(args.limit ?? args.lines) || 50));
          const content = logFile ? (tailLogFile(logFile, lines) || text || '(日志为空)') : (text || '(暂无输出)');
          return JSON.stringify({ status: 'ok', data: { job_id: id, lines: content ? content.split('\n').length : 0, content } });
        }

        return JSON.stringify({ status: 'error', data: { message: `未知 action "${action}"，应为 list/kill/logs 之一。` } });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
    extractLabel: (args) => {
      const action = args.action || '?';
      return action === 'kill' ? `kill ${args.job_id ?? '?'}` : action;
    },
  });
}
