// ============================================================
// ac-sandbox-core + ac-text-budget：沙箱/bash 扫描/脱敏/token 截断
// ============================================================
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSandboxResolver,
  createAgentSandboxCache,
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
