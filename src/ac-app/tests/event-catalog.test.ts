// ============================================================
// ac-app/tests/event-catalog.test.ts —— M25 P1 目录锁定测试
//   · emit 事件末参永不为函数（agentGate 末参函数判定的前提锁定：
//     末参函数 = waterfall 启发式，emit 载荷带函数会误判）
//   · 全部 owning 包事件目录均已标注 @mode + @scope，且值域合法
//     （@mode ∈ DispatchMode 五值、@scope ∈ run|host——@scope 判定式 =
//     "这次分发发生在谁的执行里"；cr-19：曾漏网的 broadcast/session
//     非法值即红）
//   · 声明文件自动发现（cr-19）：手工 EVENT_FILES 清单曾漏 5 个文件
//     （session/remote-link/client-runtime/tag-registry 的 events.ts +
//     ac-restart 嵌 index.ts 声明）——漏网目录的标注漂移静默失守。
//     现改为扫描 src/ac-*/src（tests 除外）中含 declare module +
//     interface Events 的全部 .ts，新目录文件自动纳入锁定。
// 静态源码检查：owning 包的事件声明只有类型（声明合并不进运行时），
// 读源文本是唯一途径（与 events/listeners 的 _hooks 直读同款立场）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 发现全部事件声明文件：域包 src 目录下（tests 与 node_modules 除外），
 * 文本含 declare module '@agentchat/cordis' 且含 interface Events 的 .ts。
 * 返回相对 src 根的 POSIX 风格路径（events.ts 与嵌 service/index 声明）。
 * 注意：事件名正则锚定 domain/action 形（含斜杠），行包 license 头等无斜杠
 * 引号串不会被误判为事件签名。
 */
function discoverEventFiles(): string[] {
  const out: string[] = [];
  const domains = fs
    .readdirSync(PREVIEW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('ac-'));
  for (const domain of domains) {
    const srcDir = path.join(PREVIEW_DIR, domain.name, 'src');
    if (!fs.existsSync(srcDir)) continue;
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (ent.name === 'tests' || ent.name === 'node_modules') continue;
          walk(path.join(dir, ent.name));
        } else if (ent.name.endsWith('.ts')) {
          const text = fs.readFileSync(path.join(dir, ent.name), 'utf-8');
          if (
            text.includes("declare module '@agentchat/cordis'") &&
            text.includes('interface Events')
          ) {
            out.push(
              path
                .relative(PREVIEW_DIR, path.join(dir, ent.name))
                .split(path.sep)
                .join('/'),
            );
          }
        }
      }
    };
    walk(srcDir);
  }
  return out.sort();
}

const EVENT_FILES = discoverEventFiles();

interface EventDecl {
  file: string;
  name: string;
  mode?: string;
  scope?: string;
  /** 括号深度平衡提取的参数列表原文（顶层逗号未拆分） */
  params: string;
}

/** 解析一个文件中的事件声明（JSDoc 块 + 事件名签名） */
function parseEvents(file: string): EventDecl[] {
  const text = fs.readFileSync(path.join(PREVIEW_DIR, file), 'utf-8');
  const out: EventDecl[] = [];
  // JSDoc 块后跟事件签名（跨行；签名以 ): 收尾）
  const re = /\/\*\*([\s\S]*?)\*\/\s*\n?\s*'([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)'\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const doc = m[1];
    const name = m[2];
    const modeMatch = /@mode\s+([a-z]+)/.exec(doc);
    const scopeMatch = /@scope\s+(run|host)\b/.exec(doc);
    // 参数列表：从签名 ( 起做括号配平，取到匹配的 ) 为止
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
    out.push({ file, name, mode: modeMatch?.[1], scope: scopeMatch?.[1], params });
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
  it('声明文件自动发现：含全部曾漏网文件（canary），数量下限合理', () => {
    // canary：cr-19 前手工清单漏掉的 5 个文件——扫描逻辑自身坏掉即红
    const previouslyMissed = [
      'ac-client-runtime/src/events.ts',
      'ac-remote-link/src/events.ts',
      'ac-restart/src/index.ts',
      'ac-session/src/events.ts',
      'ac-tag-registry/src/events.ts',
    ];
    expect(EVENT_FILES).toEqual(expect.arrayContaining(previouslyMissed));
    expect(EVENT_FILES.length).toBeGreaterThanOrEqual(23);
    expect(allEvents.length).toBeGreaterThanOrEqual(27);
  });

  it('全部事件已标注 @mode + @scope（新事件漏标即红）', () => {
    const missing = allEvents.filter((e) => !e.mode || !e.scope);
    expect(
      missing.map((e) => e.file + ': ' + e.name + '（mode=' + (e.mode ?? '?') + ' scope=' + (e.scope ?? '?') + '）'),
    ).toEqual([]);
  });

  it('@mode ∈ 五种分发模式、@scope ∈ run|host（非法值即红）', () => {
    const MODES = ['emit', 'waterfall', 'parallel', 'serial', 'bail'];
    const offenders = allEvents.filter(
      (e) => !MODES.includes(e.mode!) || (e.scope !== 'run' && e.scope !== 'host'),
    );
    expect(
      offenders.map((e) => e.file + ': ' + e.name + '（mode=' + e.mode + ' scope=' + e.scope + '）'),
    ).toEqual([]);
  });

  it('已知 run 域事件清单对齐（判定式口径）', () => {
    const runEvents = allEvents.filter((e) => e.scope === 'run').map((e) => e.name).sort();
    expect(runEvents).toEqual([
      'conversation/before-start',
      'conversation/queue-changed',
      'conversation/steered',
      'llm/before-chat',
      'llm/chat-error',
      'llm/delta',
      'llm/delta-end',
      'llm/delta-start',
      'loop/after-run',
      'loop/after-step',
      'loop/before-run',
      'loop/before-run-first',
      'loop/before-run-last',
      'loop/before-step',
      'loop/run-idle',
      'loop/run-started',
      'loop/step-started',
      'loop/steer-dropped',
      'loop/transform-run',
      'loop/transform-step',
      'router/before-deliver',
      'router/message-received',
      'router/reply-completed',
      'session/context-injected',
      'tool/after-execute',
      'tool/before-execute',
      'tool/progress',
      'tool/started',
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
      if (fnLike) offenders.push(e.file + ': ' + e.name + '（末参 ' + last + '）');
    }
    expect(offenders).toEqual([]);
  });

  it('waterfall 事件末参为 next 函数（对照锚——形态正确性）', () => {
    const waterfalls = allEvents.filter((e) => e.mode === 'waterfall');
    expect(waterfalls.length).toBeGreaterThanOrEqual(5);
    for (const e of waterfalls) {
      const params = splitParams(e.params.replace(/\s+/g, ' '));
      const last = params[params.length - 1] ?? '';
      expect(last, e.file + ': ' + e.name).toMatch(/=>|\bFunction\b/);
    }
  });
});
