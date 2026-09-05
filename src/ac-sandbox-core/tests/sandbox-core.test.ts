// ============================================================
// ac-sandbox-core + ac-text-budget：沙箱/bash 扫描/脱敏/token 截断
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSandboxResolver,
  createAgentSandboxCache,
  isPathUnder,
  agentSpaceRoots,
  isDeniedPath,
  BUILTIN_DENY_PATTERNS,
  bashCommandViolation,
  stripHeredocPayloads,
  makeSecretRedactor,
  redactSecretValue,
} from 'ac-sandbox-core';
import { estimateTokens, sanitizeSurrogates, safeTruncate, safeClipByTokens } from 'ac-text-budget';

const home = os.homedir().replace(/\\/g, '/');

// ---- 平台参数化路径夹具：解析器/扫描器用宿主 node:path 语义（win32 盘符
// 形态在 posix 是相对路径、反之亦然）——按平台喂对应形态，两侧语义等价：
// 「工作区根」「外部根」「授予根」都取平台真实绝对路径 ----
const IS_WIN = process.platform === 'win32';
/** 工作区根（win: 盘符形态；posix: 顶层目录形态） */
const WS_ROOT = IS_WIN ? 'C:/ws/root' : '/ac-test-ws/root';
/** 另一根（盘符跳转 / 越界目标） */
const OUT_ROOT = IS_WIN ? 'D:/other' : '/ac-other';
/** 授予根（allowedPaths / per-Agent grants） */
const GRANT_A = IS_WIN ? 'E:/granted' : '/ac-granted';
const GRANT_B = IS_WIN ? 'F:/second' : '/ac-second';
const GRANT_DATA = IS_WIN ? 'E:/data' : '/ac-data';
/** 系统敏感区（win: C:/Windows；posix: /etc） */
const SYSTEM_AREA = IS_WIN ? 'C:/Windows/win.ini' : '/etc/hosts';

describe('沙箱路径解析器', () => {
  it('相对路径按 workdir 解析；根内放行', () => {
    const r = createSandboxResolver({ workdir: WS_ROOT });
    expect(r.resolve('src/a.ts')).toBe(path.resolve(WS_ROOT, 'src/a.ts'));
    expect(r.resolve('.')).toBe(path.resolve(WS_ROOT));
  });

  it('越界抛错（含 ../ 逃逸与根外绝对路径）', () => {
    const r = createSandboxResolver({ workdir: WS_ROOT });
    expect(() => r.resolve('../outside.txt')).toThrow(/路径越界/);
    expect(() => r.resolve(path.join(OUT_ROOT, 'file.txt'))).toThrow(/路径越界/);
    expect(() => r.resolve(SYSTEM_AREA)).toThrow(/路径越界/);
  });

  it('allowedPaths 扩展允许根（相对按 workdir 解析）', () => {
    const r = createSandboxResolver({ workdir: WS_ROOT, allowedPaths: ['mount', GRANT_DATA] });
    expect(r.resolve('mount/f.txt')).toBe(path.resolve(WS_ROOT, 'mount/f.txt'));
    expect(r.resolve(path.join(GRANT_DATA, 'x.txt'))).toBe(path.resolve(GRANT_DATA, 'x.txt'));
    expect(() => r.resolve(path.join(OUT_ROOT, 'x.txt'))).toThrow(/路径越界/);
  });

  it('黑名单优先于 allow：内置模式 + 追加模式', () => {
    const r = createSandboxResolver({ workdir: WS_ROOT, denyPatterns: [`${WS_ROOT}/secret-dir`] });
    expect(() => r.resolve('.env')).toThrow(/敏感文件黑名单/);
    expect(() => r.resolve('certs/key.pem')).toThrow(/敏感文件黑名单/);
    expect(() => r.resolve('keys/id_rsa_test')).toThrow(/敏感文件黑名单/);
    expect(() => r.resolve('secret-dir/x.txt')).toThrow(/敏感文件黑名单/);
    expect(r.resolve('normal.txt')).toBe(path.resolve(WS_ROOT, 'normal.txt'));
  });

  it('isDeniedPath：~ 家目录展开 / ** 文件名模式（前后缀通配）', () => {
    expect(isDeniedPath(BUILTIN_DENY_PATTERNS, `${home}/.agentchat/credentials.json`)).toBe(true);
    expect(isDeniedPath(['**/*.pem'], 'C:/any/dir/server.pem')).toBe(true);
    expect(isDeniedPath(['**/id_rsa*'], '/home/u/.ssh/id_rsa.pub')).toBe(true);
    expect(isDeniedPath(['**/backup'], '/x/backup')).toBe(true);
    expect(isDeniedPath(BUILTIN_DENY_PATTERNS, `${home}/documents/file.txt`)).toBe(false);
  });
});

describe('per-Agent 沙箱解析缓存（createAgentSandboxCache）', () => {
  /** 行基准根（win: C:/ws；posix: /ac-test-ws） */
  const WS_BASE = IS_WIN ? 'C:/ws' : '/ac-test-ws';
  const AGENT_DIR = `${WS_BASE}/files/neko`;
  const ROW_MOUNT = IS_WIN ? 'C:/row-mount' : '/ac-row-mount';

  it('sandboxAllowedPaths 授予根并入允许根（与行配置并集）；基准覆盖行缺省', () => {
    const grants = new Map<string, string[]>([['neko', [GRANT_A]]]);
    const ws = {
      sandboxWorkdir: (id?: string) => (id === 'neko' ? AGENT_DIR : undefined),
      sandboxAllowedPaths: (id?: string) => grants.get(id ?? '') ?? [],
    };
    const sandboxOf = createAgentSandboxCache({ workdir: WS_BASE }, () => ws);

    // 授予根内绝对路径放行；授予外仍越界；基准（files/neko）照常解析相对路径
    expect(sandboxOf({ agentId: 'neko' }).resolve(path.join(GRANT_A, 'x.txt'))).toBe(path.resolve(GRANT_A, 'x.txt'));
    expect(() => sandboxOf({ agentId: 'neko' }).resolve(path.join(OUT_ROOT, 'x.txt'))).toThrow(/路径越界/);
    expect(sandboxOf({ agentId: 'neko' }).resolve('a.txt')).toBe(path.resolve(AGENT_DIR, 'a.txt'));
    // workspace 面无该 Agent → 行缺省基准
    expect(sandboxOf({ agentId: 'mochi' }).resolve('a.txt')).toBe(path.resolve(WS_BASE, 'a.txt'));

    // 授予变化 → 缓存按 基准×允许根 分键，不串旧解析器
    grants.set('neko', [GRANT_B]);
    expect(() => sandboxOf({ agentId: 'neko' }).resolve(path.join(GRANT_A, 'x.txt'))).toThrow(/路径越界/);
    expect(sandboxOf({ agentId: 'neko' }).resolve(path.join(GRANT_B, 'y.txt'))).toBe(path.resolve(GRANT_B, 'y.txt'));

    // 行配置 allowedPaths 与授予并集（双源共存）
    const both = createAgentSandboxCache(
      { workdir: WS_BASE, allowedPaths: [ROW_MOUNT] },
      () => ws,
    );
    const nekoBoth = both({ agentId: 'neko' }); // 基准 files/neko；行配置 ROW_MOUNT ∪ 授予 GRANT_B
    expect(nekoBoth.resolve(path.join(ROW_MOUNT, 'f.txt'))).toBe(path.resolve(ROW_MOUNT, 'f.txt'));
    expect(nekoBoth.resolve(path.join(GRANT_B, 'y.txt'))).toBe(path.resolve(GRANT_B, 'y.txt'));
    expect(nekoBoth.resolve('a.txt')).toBe(path.resolve(AGENT_DIR, 'a.txt'));
  });

  it('源未实现 sandboxAllowedPaths（可选面）→ 无附加授予根，行为与旧版一致', () => {
    const legacy = createAgentSandboxCache(
      { workdir: WS_BASE },
      () => ({ sandboxWorkdir: () => undefined }),
    );
    expect(() => legacy({ agentId: 'x' }).resolve(path.join(GRANT_A, 'x.txt'))).toThrow(/路径越界/);
    expect(legacy({ agentId: 'x' }).resolve('a.txt')).toBe(path.resolve(WS_BASE, 'a.txt'));
  });

  it('conversationId 透传：会话挂载工作区根随 sandboxAllowedPaths(agentId, cid) 授予；同 Agent 挂/未挂分桶不串', () => {
    /** 会话 → 挂载工作区根（singles 语义的结构面模拟） */
    const attached = new Map<string, string>([['sid-a', GRANT_A]]);
    const ws = {
      sandboxWorkdir: (id?: string) => (id === 'neko' ? AGENT_DIR : undefined),
      sandboxAllowedPaths: (id?: string, cid?: string) => (cid ? attached.get(cid) ? [attached.get(cid)!] : [] : []),
    };
    const sandboxOf = createAgentSandboxCache({ workdir: WS_BASE }, () => ws);

    // 挂载工作区的会话：工作区内绝对路径放行（ToolCall.conversationId 透传）
    expect(sandboxOf({ agentId: 'neko', conversationId: 'sid-a' }).resolve(path.join(GRANT_A, 'src', 'main.ts')))
      .toBe(path.resolve(GRANT_A, 'src', 'main.ts'));
    // 同一 Agent 的未挂会话：同一路径越界（缓存按授予集分桶，不串旧解析器）
    expect(() => sandboxOf({ agentId: 'neko', conversationId: 'sid-b' }).resolve(path.join(GRANT_A, 'x.txt'))).toThrow(/路径越界/);
    // 无会话键（1v1/群/直连）：与既有行为一致
    expect(() => sandboxOf({ agentId: 'neko' }).resolve(path.join(GRANT_A, 'x.txt'))).toThrow(/路径越界/);
    // 相对路径仍锚 Agent 专用空间基准
    expect(sandboxOf({ agentId: 'neko', conversationId: 'sid-a' }).resolve('a.txt')).toBe(path.resolve(AGENT_DIR, 'a.txt'));
  });

  it('agentSpaceRoots 写侧对齐读侧：基准分叉时专用空间并根（绝对路径可达）；相等/无身份不扩面', () => {
    const custom = {
      sandboxWorkdir: (id?: string) => (id === 'neko' ? ROW_MOUNT : undefined),
      agentWorkdir: (id?: string) => (id === 'neko' ? AGENT_DIR : undefined),
    };
    const sandboxOf = createAgentSandboxCache({ workdir: WS_BASE }, () => custom);
    // 基准 = 挂载目录；专用空间 files/neko 自动并入允许根（绝对路径放行）
    expect(sandboxOf({ agentId: 'neko' }).resolve(path.join(AGENT_DIR, 'memory', 'neko~user.md')))
      .toBe(path.resolve(AGENT_DIR, 'memory', 'neko~user.md'));
    // 相对路径仍锚沙箱基准（挂载目录），授予外仍越界
    expect(sandboxOf({ agentId: 'neko' }).resolve('rel.txt')).toBe(path.resolve(ROW_MOUNT, 'rel.txt'));
    expect(() => sandboxOf({ agentId: 'neko' }).resolve(path.join(OUT_ROOT, 'x.txt'))).toThrow(/路径越界/);
    // 黑名单仍优先于并根（专用空间内敏感文件照拦）
    expect(() => sandboxOf({ agentId: 'neko' }).resolve(path.join(AGENT_DIR, '.env'))).toThrow(/敏感文件黑名单/);

    // 基准与专用空间相等（常规/预设 Agent）→ 不扩面（缓存键与旧版同形）
    const aligned = createAgentSandboxCache({ workdir: WS_BASE }, () => ({
      sandboxWorkdir: () => AGENT_DIR,
      agentWorkdir: () => AGENT_DIR,
    }));
    expect(aligned({ agentId: 'neko' }).resolve('a.txt')).toBe(path.resolve(AGENT_DIR, 'a.txt'));
    expect(() => aligned({ agentId: 'neko' }).resolve(path.join(OUT_ROOT, 'x.txt'))).toThrow(/路径越界/);

    // 基准不可知（sandboxWorkdir undefined——未知/虚拟端）→ 不并根（fail-closed）
    const ghost = createAgentSandboxCache({ workdir: WS_BASE }, () => custom);
    expect(() => ghost({ agentId: 'mochi' }).resolve(path.join(GRANT_A, 'x.txt'))).toThrow(/路径越界/);

    // 纯函数口径：相等 → []；分叉 → [dir]；未实现面/无身份 → []
    expect(agentSpaceRoots(custom, 'neko', ROW_MOUNT)).toEqual([AGENT_DIR]);
    expect(agentSpaceRoots(custom, 'neko', AGENT_DIR)).toEqual([]);
    expect(agentSpaceRoots(custom, 'mochi', ROW_MOUNT)).toEqual([]);
    expect(agentSpaceRoots(undefined, 'neko', ROW_MOUNT)).toEqual([]);
    expect(agentSpaceRoots(custom, undefined, ROW_MOUNT)).toEqual([]);
    expect(agentSpaceRoots({ agentWorkdir: undefined }, 'neko', ROW_MOUNT)).toEqual([]);
  });
});

// ---- 包含判定：平台大小写惯例 + 身份回退（2026-11 反馈：同一文件的
// 绝对路径词形——大小写变体/8.3/junction——被词法前缀误判越界，表现为
// 「绝对路径访问自己工作区也被拦，连读都拦」而相对路径恒过）----
describe('包含判定：平台大小写惯例 + 身份回退（别名词形同文件放行）', () => {
  it('isPathUnder 旗标语义：大小写折叠 / 根自身 / 兄弟前缀不误放', () => {
    // 词形按宿主分隔符（生产输入恒经 path.resolve——paths/bash-scan 同一前提）
    const j = (...seg: string[]): string => path.join(...seg);
    // win32 惯例（caseSensitive=false）：大小写变体是同一文件
    expect(isPathUnder(j('/WS/Root/a.txt'), j('/ws/root'), false)).toBe(true);
    expect(isPathUnder(j('/WS/ROOT'), j('/ws/root'), false)).toBe(true);
    // posix 惯例（caseSensitive=true）：大小写即不同路径
    expect(isPathUnder(j('/WS/Root/a.txt'), j('/ws/root'), true)).toBe(false);
    expect(isPathUnder(j('/ws/root/a.txt'), j('/ws/root'), true)).toBe(true);
    // 兄弟前缀（/a/b-c 不在 /a/b 之下）与根自身
    expect(isPathUnder(j('/a/b-c/x'), j('/a/b'), false)).toBe(false);
    expect(isPathUnder(j('/a/b'), j('/a/b'), true)).toBe(true);
  });

  it('resolve：别名词形（junction/symlink 指进工作区）词法失配、身份回退放行；别名指向根外仍拦', ({ skip }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sbx-'));
    try {
      const ws = path.join(dir, 'ws');
      fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'x');
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(outside);
      const alias = path.join(dir, 'alias');
      const aliasOut = path.join(dir, 'alias-out');
      try {
        fs.symlinkSync(ws, alias, IS_WIN ? 'junction' : 'dir');
        fs.symlinkSync(outside, aliasOut, IS_WIN ? 'junction' : 'dir');
      } catch {
        skip('当前环境不支持 symlink/junction');
        return;
      }
      const r = createSandboxResolver({ workdir: ws });
      // 存在文件与新建文件（最近存在祖先之下的缺失尾段）都可经别名访问
      expect(r.resolve(path.join(alias, 'sub', 'a.txt'))).toBe(path.join(alias, 'sub', 'a.txt'));
      expect(r.resolve(path.join(alias, 'new.txt'))).toBe(path.join(alias, 'new.txt'));
      // 身份在根外 ≠ 放行（回退按真实落点判，不是见别名就放）
      expect(() => r.resolve(path.join(aliasOut, 'x.txt'))).toThrow(/路径越界/);
      // 词法真越界不受回退影响
      expect(() => r.resolve(path.join(OUT_ROOT, 'x.txt'))).toThrow(/路径越界/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // win32 文件系统大小写不敏感：同一文件的大小写变体不得因词法失配被拦
  (IS_WIN ? it : it.skip)('win32：同文件大小写变体（全大写/全小写）放行；大小写混淆不是根外通行证', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sbx-case-'));
    try {
      const ws = path.join(dir, 'WsRoot');
      fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
      const r = createSandboxResolver({ workdir: ws });
      // resolve 返回所给词形（大小写不敏感文件系统按此可开同一文件）
      const upper = path.join(ws.toUpperCase(), 'sub', 'a.ts');
      const lower = path.join(ws.toLowerCase(), 'sub', 'a.ts');
      expect(r.resolve(upper)).toBe(upper);
      expect(r.resolve(lower)).toBe(lower);
      // 兄弟目录（大小写变体名）仍是根外——身份回退按真实落点判
      expect(() => r.resolve(path.join(dir.toUpperCase(), 'wsroot-other', 'a.ts'))).toThrow(/路径越界/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bash 扫描同源：别名词形命令放行；根外绝对路径照拦', ({ skip }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-sbx-bash-'));
    try {
      const ws = path.join(dir, 'ws');
      fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
      const alias = path.join(dir, 'alias');
      try {
        fs.symlinkSync(ws, alias, IS_WIN ? 'junction' : 'dir');
      } catch {
        skip('当前环境不支持 symlink/junction');
        return;
      }
      const opts = { roots: [ws], cwd: ws };
      expect(bashCommandViolation(`Get-Content ${path.join(alias, 'sub', 'a.txt')}`, opts)).toBeNull();
      if (IS_WIN) {
        // 大小写变体走词法快路径（win32 折叠，无需命中文件系统）
        expect(bashCommandViolation(`Get-Content ${path.join(ws.toUpperCase(), 'a.txt')}`, opts)).toBeNull();
      }
      expect(bashCommandViolation('cat /etc/passwd', opts)).toMatch(/Unix 绝对路径/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bash 命令扫描（heredoc 剥离 + 段级启发式）', () => {
  const roots = [WS_ROOT];
  const opts = { roots, cwd: WS_ROOT };

  it('根外绝对路径越界拦截；白名单内放行', () => {
    // 盘符形态仅在 win32 是绝对路径（posix 下是相对路径→按根内放行，语义
    // 等价物 = 根外 Unix 绝对路径）；白名单内形态两侧均放行
    if (IS_WIN) {
      expect(bashCommandViolation('Get-Content C:\\Windows\\win.ini', opts)).toMatch(/绝对路径/);
    } else {
      expect(bashCommandViolation('cat /ac-other/x.txt', opts)).toMatch(/Unix 绝对路径/);
    }
    expect(bashCommandViolation('cat C:/ws/root/a.txt', opts)).toBeNull();
    expect(bashCommandViolation(`cat ${WS_ROOT}/a.txt`, opts)).toBeNull();
  });

  it('URL scheme 不误判（https:// 里的 s://）', () => {
    expect(bashCommandViolation('curl https://example.com/api | head -5', opts)).toBeNull();
  });

  it('Unix 绝对路径拦截；白名单内放行', () => {
    expect(bashCommandViolation('cat /etc/passwd', opts)).toMatch(/Unix 绝对路径/);
  });

  it('Windows 开关参数豁免（2026-09-02 反馈：dir /b、date /t 被误判 Unix 绝对路径）；已知 Unix 目录不豁免', () => {
    // Windows 原生命令的开关：单段短 token，不是路径
    expect(bashCommandViolation('echo "bash 工具测试 OK" && dir /b', opts)).toBeNull();
    expect(bashCommandViolation('date /t', opts)).toBeNull();
    expect(bashCommandViolation('taskkill /PID 1234 /F', opts)).toBeNull();
    expect(bashCommandViolation('Get-ChildItem /Force', opts)).toBeNull();
    // 多段路径与已知 Unix 顶层目录仍拦截
    expect(bashCommandViolation('cat /etc/passwd', opts)).toMatch(/Unix 绝对路径/);
    expect(bashCommandViolation('cat /tmp/x', opts)).toMatch(/Unix 绝对路径/);
    expect(bashCommandViolation('ls /usr', opts)).toMatch(/Unix 绝对路径/);
    // 白名单内的真实 Unix 绝对路径照常放行
    expect(bashCommandViolation('cat C:/ws/root//a.txt', opts)).toBeNull();
  });

  it('cd 越界与 ../ 引用拦截', () => {
    expect(bashCommandViolation('cd .. && ls', opts)).toMatch(/cd 到/);
    expect(bashCommandViolation('cat ../outside.txt', opts)).toMatch(/\.\./);
    // git diff a..b 的 token 内 .. 不误判
    expect(bashCommandViolation('git diff HEAD..main', opts)).toBeNull();
  });

  it('拒绝消息点名越界路径（不泛化成「绝对路径都被拦」）', () => {
    // 用户实录（2026-11）：一条命令混两个绝对路径——根内一段 + 根外一段，
    // 整条被拦（fail-closed 正确），但消息必须点名越界的那条，让 Agent
    // 能只移除越界部分重试，而不是得出「绝对路径都被拦」
    if (IS_WIN) {
      const inRoot = 'Get-Content "C:\\ws\\root\\files\\a.md" -TotalCount 3';
      const outRoot = 'Get-ChildItem "C:\\ws\\other\\"';
      const v = bashCommandViolation(`${inRoot}; ${outRoot}`, opts);
      expect(v).toMatch(/允许范围外的绝对路径（C:\/ws\/other\/）/);
      expect(v).not.toContain('C:/ws/root');
      // 根内绝对路径单独执行放行（绝对形态本身 ≠ 被拦）
      expect(bashCommandViolation(inRoot, opts)).toBeNull();
    } else {
      const v = bashCommandViolation('cat /ac-other/x.txt', opts);
      expect(v).toMatch(/允许范围外的 Unix 绝对路径（\/ac-other\/x\.txt）/);
      expect(bashCommandViolation('cat /ac-test-ws/root/a.txt', opts)).toBeNull();
    }
  });

  it('heredoc 载荷剥离：载荷内正则/路径样例不误判；闭定界符后命令仍受检', () => {
    const ok = "cat > check.mjs <<'EOF'\nconst re = /const\\s+/g; // 正则字面量\nEOF\nnode check.mjs";
    expect(bashCommandViolation(ok, opts)).toBeNull();
    const bad = "cat > check.mjs <<'EOF'\ncode\nEOF\ncat /etc/passwd";
    expect(bashCommandViolation(bad, opts)).toMatch(/Unix 绝对路径/);
  });

  it('位移运算 a << b 不被当作 heredoc 剥离', () => {
    // `a << b ;` 后随命令——<< 后是 b 空格，构成 heredoc 开标记?
    // 规则要求 <<X 后随空白/重定向/EOL——`<< b` 满足，但闭定界符 `b` 须独占一行，
    // 匹配失败 → 保留原文 → 其后路径仍被扫描
    const cmd = 'echo $((1 << 4)); cat /etc/passwd';
    expect(bashCommandViolation(cmd, opts)).toMatch(/Unix 绝对路径/);
  });

  it('stripHeredocPayloads：PS here-string 剥离', () => {
    const out = stripHeredocPayloads("@'\nconst re = /const\\s+/g;\n'@ | Set-Content f.ps1");
    expect(out).toContain('<heredoc-payload>');
    expect(out).toContain('| Set-Content f.ps1');
  });
});

describe('输出脱敏', () => {
  it('精确值替换（过短跳过）+ sk- 模式 + 赋值模式保留前缀（不吞尾引号）', () => {
    const redact = makeSecretRedactor(['supersecretvalue123']);
    expect(redact('key is supersecretvalue123 here')).toBe('key is *** here');
    expect(redact('sk-abcdefghij0123456789abcdefghij')).toBe('***');
    expect(redact('api_key = "abcdef0123456789abcdef"')).toBe('api_key =***"'); // 值掩码，尾引号保留
    expect(redact('token: Zm9vYmFyMTIzNDU2Nzg5')).toBe('token:***');
    expect(redact('short abc')).toBe('short abc'); // 无命中
  });

  it('redactSecretValue：递归对象/数组脱敏；非字符串原样', () => {
    const redact = makeSecretRedactor(['hunter2hunter2']);
    const v = redactSecretValue(
      { items: ['has hunter2hunter2 inside'], nested: { key: 'sk-abcdefghij0123456789abc' }, n: 42 },
      redact,
    );
    expect(v).toMatchObject({ items: ['has *** inside'], nested: { key: '***' }, n: 42 });
    expect(redactSecretValue(7, redact)).toBe(7);
  });
});

describe('token 预算与安全截断', () => {
  it('estimateTokens：CJK 0.6 / 其他 0.3', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('中文')).toBe(2); // 0.6*2=1.2 → ceil 2
    expect(estimateTokens('abcd')).toBe(2); // 0.3*4=1.2 → ceil 2
  });

  it('safeTruncate：不切代理对', () => {
    const text = 'a😀b'; // a + 😀(2 units) + b = 4 units
    expect(safeTruncate(text, 4)).toBe('a😀b');
    expect(safeTruncate(text, 3)).toBe('a😀'); // 切点落在对之后 → 完整保留
    expect(safeTruncate(text, 2)).toBe('a'); // 切点落在高/低代理之间 → 退一格
    expect(safeTruncate(text, 1)).toBe('a');
    expect(safeTruncate('', 3)).toBe('');
  });

  it('sanitizeSurrogates：孤立代理替换 U+FFFD', () => {
    expect(sanitizeSurrogates('a\u{1F600}b')).toBe('a\u{1F600}b'); // 完整对保留
    expect(sanitizeSurrogates('a\uD800b')).toBe('a\uFFFDb'); // 孤立高代理 → U+FFFD
    expect(sanitizeSurrogates('a\uDC00b')).toBe('a\uFFFDb'); // 孤立低代理 → U+FFFD
  });

  it('safeClipByTokens：预算内原样；超预算加省略号；keepTail/keepHead', () => {
    expect(safeClipByTokens('short', 100, false)).toBe('short');
    const head = safeClipByTokens('a'.repeat(100), 10, false);
    expect(head.endsWith('…')).toBe(true);
    expect(head.length).toBeLessThanOrEqual(35);
    const tail = safeClipByTokens('a'.repeat(100), 10, true);
    expect(tail.startsWith('…')).toBe(true);
    // 代理对完整（emoji 不被切半）
    const emoji = '😀'.repeat(50);
    const clipped = safeClipByTokens(emoji, 5, false);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.slice(0, -1)).not.toContain('\uFFFD');
  });
});
