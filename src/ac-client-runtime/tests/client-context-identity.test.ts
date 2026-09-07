// ============================================================
// ac-client-runtime/tests/client-context-identity.test.ts —— D22 查重锁定
//
// 客户端 Context 类型身份裁决（M27 D22）的静态验收：
//   1. 客户端包（src/ac-client-*/src）**不 augment '@agentchat/cordis'**
//      （服务端 Context 的声明合并目标不混入客户端词汇）；
//   2. 客户端服务名（ClientContext 增强 + super(ctx, '…')）与服务端
//      占名（Context 增强 + super(ctx, '…')）交集为空——TS2717 撞型
//      的运行时名字面防线（S3 行包双半边同包后必然显形，提前锁定）。
//
// 静态源码扫描（与服务端 event-catalog 测试同款立场：声明合并零
// 运行时，读源文本是唯一途径）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_SRC = fileURLToPath(new URL('../../', import.meta.url)); // src/

function walk(dir: string, out: string[] = []): string[] {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 服务端包：src/<pkg>/src（排除客户端基建包与 webui 前端本体） */
function serverFiles(): string[] {
  const out: string[] = [];
  for (const pkg of fs.readdirSync(REPO_SRC, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    if (pkg.name.startsWith('ac-client-')) continue;
    if (pkg.name === 'webui' || pkg.name === 'docs' || pkg.name === 'templates' || pkg.name === 'scripts') continue;
    const src = path.join(REPO_SRC, pkg.name, 'src');
    if (fs.existsSync(src)) walk(src, out);
  }
  return out;
}

/** 客户端基建包（src 下各 ac-client- 前缀包的 src 目录） */
function clientFiles(): string[] {
  const out: string[] = [];
  for (const pkg of fs.readdirSync(REPO_SRC, { withFileTypes: true })) {
    if (!pkg.isDirectory() || !pkg.name.startsWith('ac-client-')) continue;
    const src = path.join(REPO_SRC, pkg.name, 'src');
    if (fs.existsSync(src)) walk(src, out);
  }
  return out;
}

/** 括号配平截取：自 `{` 起取到配平的 `}`（含），找不到返回 undefined */
function balancedBlock(text: string, from: number): string | undefined {
  const start = text.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return undefined;
}

/** 提取「declare module '<target>' { interface <name> { … } }」的顶层属性名 */
function augmentedProps(text: string, target: string, iface: string): Set<string> {
  const out = new Set<string>();
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp("declare module ['\"]" + esc + "['\"]\\s*\\{", 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = balancedBlock(text, m.index + m[0].length - 1);
    if (!body) continue;
    const ire = new RegExp(`interface ${iface}\\s*\\{`, 'g');
    let im: RegExpExecArray | null;
    while ((im = ire.exec(body)) !== null) {
      const ibody = balancedBlock(body, im.index + im[0].length - 1);
      if (!ibody) continue;
      for (const line of ibody.split('\n')) {
        const pm = /^\s+([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
        if (pm && !line.trim().startsWith('*') && !line.trim().startsWith('//')) out.add(pm[1]);
      }
    }
  }
  return out;
}

/** 提取 super(ctx, 'name') 的服务名 */
function serviceNames(text: string): Set<string> {
  const out = new Set<string>();
  const re = /super\(ctx,\s*'([A-Za-z_$][\w$]*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

describe('D22 · 客户端 Context 类型身份与查重', () => {
  const server = serverFiles();
  const client = clientFiles();

  it('扫描面非空（服务端与客户端包均存在）', () => {
    expect(server.length).toBeGreaterThan(20);
    expect(client.length).toBeGreaterThan(0);
  });

  it('客户端包不 augment "@agentchat/cordis" 的 Context 接口（服务类型身份纪律；Events 声明合并允许——名字键且撞名即编译期显形）', () => {
    const offenders = client.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return augmentedProps(text, '@agentchat/cordis', 'Context').size > 0;
    });
    expect(
      offenders.map((f) => path.relative(REPO_SRC, f)),
      '客户端服务只能合并到 ClientContext（ac-client-runtime/src/context.ts）——见 m27 D22',
    ).toEqual([]);
  });

  it('客户端服务名与服务端占名交集为空', () => {
    const serverNames = new Set<string>();
    for (const f of server) {
      const text = fs.readFileSync(f, 'utf8');
      for (const n of augmentedProps(text, '@agentchat/cordis', 'Context')) serverNames.add(n);
      for (const n of serviceNames(text)) serverNames.add(n);
    }
    const clientNames = new Set<string>();
    for (const f of client) {
      const text = fs.readFileSync(f, 'utf8');
      for (const n of augmentedProps(text, './context.ts', 'ClientContext')) clientNames.add(n);
      for (const n of serviceNames(text)) clientNames.add(n);
    }
    // 基线自检：两侧均扫描到名字（防止正则失灵造成假绿）
    expect(serverNames.size).toBeGreaterThan(20);
    expect(clientNames.size).toBeGreaterThanOrEqual(2);
    const clash = [...clientNames].filter((n) => serverNames.has(n));
    expect(
      clash,
      `客户端/服务端服务名撞名（TS2717 与 S3 双半边同包风险）：${clash.join(', ')}`,
    ).toEqual([]);
  });
});
