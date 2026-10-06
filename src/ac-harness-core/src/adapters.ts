// ============================================================
// ac-harness-core/src/adapters.ts —— claude-code / codex 适配器
//
// 只依赖官方文档化的一次性委托 exec 面（D7：交互式协议零依赖）：
//   · claude: `claude -p --output-format stream-json --verbose`
//     stream-json 事件序：system(init: session_id/model) → assistant
//     (text/tool_use 块, usage) → result(终稿, cost_usd_usd7, duration_ms,
//     num_turns)。thinking 块首期不拆（暴露不稳定，进 notice）。
//   · codex: `codex exec --json -C <cwd>`
//     --json 事件序：thread.started(thread_id) → item.completed
//     (agent_message/command_execution/file_change…) → turn.completed(usage)
//     / turn.failed。
// 未知事件行丢弃 + 计数（前向兼容）。字段缺失 fail-loud。
// ============================================================
import type { HarnessAdapter } from './gateway.ts';
import { clip, num, str, type LineOutcome, type TerminalFacts } from './events.ts';

type UnknownRecord = Record<string, unknown>;

/** 任意块数组中提取首个指定类型块的 text（claude assistant content 块） */
function blockText(content: unknown, type: string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b && typeof b === 'object' && (b as UnknownRecord).type === type) {
      return str((b as UnknownRecord).text);
    }
  }
  return undefined;
}

function toolNameOf(message: unknown): string | undefined {
  const content = message && typeof message === 'object'
    ? (message as UnknownRecord).content
    : undefined;
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b && typeof b === 'object' && (b as UnknownRecord).type === 'tool_use') {
      return str((b as UnknownRecord).name) ?? 'tool';
    }
  }
  return undefined;
}

function listToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    // codex 块型 output_text（文档形态），宽容 text（claude 同词）
    const bt = b && typeof b === 'object' ? (b as UnknownRecord).type : undefined;
    if (bt === 'text' || bt === 'output_text') {
      const t = str((b as UnknownRecord).text);
      if (t) parts.push(t);
    }
  }
  return parts.length ? parts.join('') : undefined;
}

// ------------------------------------------------------------
// claude-code
// ------------------------------------------------------------

export const claudeCodeAdapter: HarnessAdapter = {
  name: 'claude-code',
  buildArgs(req) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // 会话续接（P2）：--resume <session_id>——过期由 CLI 报错走 error 终态
    if (req.resumeKey !== undefined) args.push('--resume', req.resumeKey);
    // plan 只读 / acceptEdits 写工作区（无 bypass 档——§5.5 两档收死）
    args.push('--permission-mode', req.sandbox === 'plan' ? 'plan' : 'acceptEdits');
    if (req.model !== undefined) args.push('--model', req.model);
    return args;
  },
  lineOutcome(o): LineOutcome {
    const type = str(o.type);
    if (type === 'system' && str(o.subtype) === 'init') {
      return { ok: true, event: { kind: 'started', runKey: str(o.session_id), model: str(o.model) } };
    }
    if (type === 'assistant') {
      const msg = o.message as UnknownRecord | undefined;
      const tool = toolNameOf(o.message);
      const text = msg ? blockText(msg.content, 'text') : undefined;
      if (tool !== undefined) {
        // 一条 assistant 消息的块序内 tool_use 是主要事实——text 伴随时不重复
        // 出 delta（notice 优先，正文的最终形态由 result 终稿承载）
        return { ok: true, event: { kind: 'notice', label: `工具 ${tool}` } };
      }
      if (text !== undefined) {
        return { ok: true, event: { kind: 'delta', text: clip(text, 400) } };
      }
      return { ok: false };
    }
    if (type === 'result') {
      const usage = {
        costUsd: num(o.cost_usd),
        turns: num(o.num_turns),
        elapsedMs: num(o.duration_ms),
      };
      return {
        ok: true,
        terminal: {
          finish: o.is_error === true ? 'error' : 'stop',
          text: str(o.result) ?? '',
          usage,
        },
      };
    }
    return { ok: false };
  },
  finalize(factsIn, exitCode, stderrTail) {
    const facts = factsIn ?? { finish: exitCode === 0 ? 'stop' : 'error', text: '' };
    if (facts.text === '' && exitCode !== 0) {
      return {
        ok: false,
        text: `claude CLI 非零退出（code=${exitCode}）${stderrTail ? '：' + clip(stderrTail, 400) : ''}`,
        finish: 'error',
        ...(facts.runKey !== undefined ? { runKey: facts.runKey } : {}),
        ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
        ...(facts.stats !== undefined ? { stats: facts.stats } : {}),
      };
    }
    return {
      ok: facts.finish === 'stop',
      text: facts.text !== '' ? facts.text : '（harness 无终稿输出）',
      finish: facts.finish,
      ...(facts.runKey !== undefined ? { runKey: facts.runKey } : {}),
      ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
      ...(facts.stats !== undefined ? { stats: facts.stats } : {}),
    };
  },
};

// ------------------------------------------------------------
// codex
// ------------------------------------------------------------

/** codex item.completed 的 payload 按类型归一 */
function codexItemOutcome(item: UnknownRecord): LineOutcome {
  const t = str(item.type);
  if (t === 'agent_message' || t === 'reasoning') {
    const text = listToText(item.content) ?? str(item.text);
    if (text === undefined) return { ok: false };
    return { ok: true, event: { kind: t === 'reasoning' ? 'reasoning' : 'delta', text: clip(text, 400) } };
  }
  if (t === 'command_execution' || t === 'file_change' || t === 'mcp_tool_call' || t === 'web_search' || t === 'todo_list') {
    const label = t === 'command_execution' ? `命令 ${str(item.command) ?? str(item.aggregated_output) ?? ''}`
      : t === 'file_change' ? `文件变更 ${[str(item.changes) ?? '', str(item.diff) ?? ''].join(' ').trim()}`
      : `事件 ${t}`;
    return { ok: true, event: { kind: 'notice', label: clip(label, 120) } };
  }
  return { ok: false };
}

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  buildArgs(req) {
    // codex 续接是子命令形态：exec resume <thread_id>（其余 flag 同位追加）
    const args = req.resumeKey !== undefined
      ? ['exec', 'resume', req.resumeKey, '--json', '-C', req.cwd]
      : ['exec', '--json', '-C', req.cwd];
    // read-only / workspace-write（codex 默认禁网保持——不加网络开关）
    args.push('--sandbox', req.sandbox === 'plan' ? 'read-only' : 'workspace-write');
    if (req.model !== undefined) args.push('-m', req.model);
    return args;
  },
  lineOutcome(o): LineOutcome {
    const msg = o.msg as UnknownRecord | undefined;
    const type = str(o.type) ?? str(msg?.type);
    if (type === 'thread.started') {
      const inner = o.thread_id !== undefined ? o : msg ?? {};
      return { ok: true, event: { kind: 'started', runKey: str(inner.thread_id) } };
    }
    if (type === 'item.completed') {
      const item = (o.item ?? msg?.item) as UnknownRecord | undefined;
      if (!item) return { ok: false };
      return codexItemOutcome(item);
    }
    if (type === 'turn.completed') {
      const inner = (o.usage ?? (o.msg as UnknownRecord | undefined)?.usage) as UnknownRecord | undefined;
      return {
        ok: true,
        terminal: {
          finish: 'stop',
          text: '', // 终稿在 item.completed agent_message 里累积——见 finalize
          usage: {
            prompt: num(inner?.input_tokens),
            completion: num(inner?.output_tokens),
            total: num(inner?.tokens_used),
          },
        },
      };
    }
    if (type === 'turn.failed' || type === 'error') {
      const inner = (o.error ?? (o.msg as UnknownRecord | undefined)?.error) as UnknownRecord | undefined;
      const msg = str(inner?.message) ?? str(o.message) ?? 'turn failed';
      return { ok: true, terminal: { finish: 'error', text: `codex turn failed：${msg}` } };
    }
    return { ok: false };
  },
  finalize(factsIn, exitCode, stderrTail) {
    const facts = factsIn ?? { finish: exitCode === 0 ? 'stop' : 'error', text: '' };
    if (facts.text === '' && exitCode !== 0) {
      return {
        ok: false,
        text: `codex CLI 非零退出（code=${exitCode}）${stderrTail ? '：' + clip(stderrTail, 400) : ''}`,
        finish: 'error',
        ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
        ...(facts.stats !== undefined ? { stats: facts.stats } : {}),
      };
    }
    return {
      ok: facts.finish === 'stop',
      text: facts.text !== '' ? facts.text : '（harness 无终稿输出）',
      finish: facts.finish,
      ...(facts.runKey !== undefined ? { runKey: facts.runKey } : {}),
      ...(facts.usage !== undefined ? { usage: facts.usage } : {}),
      ...(facts.stats !== undefined ? { stats: facts.stats } : {}),
    };
  },
};