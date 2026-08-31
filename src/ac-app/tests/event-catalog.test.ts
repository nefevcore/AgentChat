// ============================================================
// ac-app/tests/event-catalog.test.ts —— M25 P1 目录锁定测试
//   · emit 事件末参永不为函数（agentGate 末参函数判定的前提锁定：
//     末参函数 = waterfall 启发式，emit 载荷带函数会误判）
//   · 全部 owning 包事件目录均已标注 @mode + @scope（run | host——
//     新事件漏标即红；@scope 判定式 = "这次分发发生在谁的执行里"）
// 静态源码检查：owning 包的事件声明只有类型（声明合并不进运行时），
// 读源文本是唯一途径（与 events/listeners 的 _hooks 直读同款立场）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** 全部 owning 包的事件声明文件（events.ts + 三个声明在 service.ts 的域） */
const EVENT_FILES = [
  'ac-agent-loop/src/events.ts',
  'ac-tools/src/events.ts',
  'ac-router/src/events.ts',
  'ac-llm/src/events.ts',
  'ac-conversation/src/events.ts',
  'ac-agents/src/events.ts',
  'ac-group/src/events.ts',
  'ac-config/src/events.ts',
  'ac-jobs/src/events.ts',
  'ac-archive/src/events.ts',
  'ac-singles/src/events.ts',
  'ac-web-server/src/events.ts',
  'ac-plugin-registry/src/service.ts',
  'ac-webui/src/service.ts',
  'ac-durable-interaction/src/service.ts',
];

interface EventDecl {
  file: string;
  name: string;
  mode?: string;
  scope?: string;
  /** 括号深度平衡提取的参数列表原文（顶层逗号未拆分） */
  params: string;
}

/** 解析一个文件中的事件声明（JSDoc 块 + `'name'(` 签名） */
function parseEvents(file: string): EventDecl[] {
  const text = fs.readFileSync(path.join(PREVIEW_DIR, file), 'utf-8');
  const out: EventDecl[] = [];
  // JSDoc 块后跟事件签名（跨行；签名以 ): 收尾）
  const re = /\/\*\*([\s\S]*?)\*\/\s*\n?\s*'([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)'\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const doc = m[1];
    const name = m[2];
    const modeMatch = /@mode\s+(waterfall|emit|parallel|serial|bail)/.exec(doc);
    const scopeMatch = /@scope\s+(run|host)/.exec(doc);
    // 参数列表：从签名 '(' 起做括号配平，取到匹配的 ')' 为止
    let depth = 0;
    let params = '';
    let started = false;
    for (let i = re.lastIndex - 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') {
        depth++;
        started = true;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (started && depth === 0) break;
        continue;
      }
      if (started) params += ch;
    }
    out.push({
      file,
      name,
      mode: modeMatch?.[1],
      scope: scopeMatch?.[1],
      params,
    });
  }
  return out;
}

/** 顶层参数切分（忽略括号/尖括号内逗号） */
function splitParams(params: string): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthAngle = 0;
  let current = '';
  for (const ch of params) {
    if (ch === '(' || ch === '[' || ch === '{') depthParen++;
    if (ch === ')' || ch === ']' || ch === '}') depthParen--;
    if (ch === '<') depthAngle++;
    if (ch === '>') depthAngle--;
    if (ch === ',' && depthParen === 0 && depthAngle === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim());
}

const allEvents = EVENT_FILES.flatMap((f) => parseEvents(f));

describe('事件目录锁定（M25 P1）', () => {
  it('owning 包事件目录非空（15 文件全部可解析）', () => {
    expect(allEvents.length).toBeGreaterThanOrEqual(27);
    const files = new Set(allEvents.map((e) => e.file));
    expect(files.size).toBe(EVENT_FILES.length);
  });

  it('全部事件已标注 @mode + @scope（新事件漏标即红）', () => {
    const missing = allEvents.filter((e) => !e.mode || !e.scope);
    expect(
      missing.map((e) => `${e.file}: ${e.name}（mode=${e.mode ?? '?'} scope=${e.scope ?? '?'}）`),
    ).toEqual([]);
  });

  it('@scope 值仅 run | host；已知 run 域事件清单对齐（判定式口径）', () => {
    const runEvents = allEvents.filter((e) => e.scope === 'run').map((e) => e.name).sort();
    expect(runEvents).toEqual([
      'conversation/steered',
      'llm/before-chat',
      'llm/chat-error',
      'llm/delta',
      'llm/delta-end',
      'llm/delta-start',
      'loop/after-run',
      'loop/after-step',
      'loop/before-run',
      'loop/before-step',
      'loop/run-started',
      'loop/step-started',
      'loop/steer-dropped',
      'loop/transform-run',
      'loop/transform-step',
      'router/message-received',
      'router/reply-completed',
      'tool/after-execute',
      'tool/before-execute',
      'tool/progress',
      'tool/transform-result',
    ].sort());
  });

  it('emit 事件末参永不为函数（agentGate 末参函数判定前提锁定）', () => {
    const offenders: string[] = [];
    for (const e of allEvents) {
      if (e.mode !== 'emit') continue;
      const params = splitParams(e.params.replace(/\s+/g, ' '));
      const last = params[params.length - 1] ?? '';
      const fnLike = /=>/.test(last) || /\bFunction\b/.test(last) || /\bnext\b\s*[:(]/.test(last);
      if (fnLike) offenders.push(`${e.file}: ${e.name}（末参 ${last}）`);
    }
    expect(offenders).toEqual([]);
  });

  it('waterfall 事件末参为 next 函数（对照锚——形态正确性）', () => {
    const waterfalls = allEvents.filter((e) => e.mode === 'waterfall');
    expect(waterfalls.length).toBeGreaterThanOrEqual(5);
    for (const e of waterfalls) {
      const params = splitParams(e.params.replace(/\s+/g, ' '));
      const last = params[params.length - 1] ?? '';
      expect(last, `${e.file}: ${e.name}`).toMatch(/=>|\bFunction\b/);
    }
  });
});
