// ============================================================
// @agentchat/shell —— bashCommandViolation 命令级沙箱测试
//
// 回归（2026-08-19 修复）：URL scheme 不是盘符路径——旧正则 [A-Za-z]:[\\/]
// 会把 https:// 里的 s:// 误判成 S: 盘（http://→P:、ftp://→P: 同理），
// 导致 curl https://… 整条命令被沙箱拦截。
//   · 放行：含 URL 的命令 / 工作区相对路径 / 白名单内绝对路径
//   · 拦截：白名单外盘符路径 / Unix 绝对路径 / cd .. 越界 / ../ 引用
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bashCommandViolation } from '@agentchat/shell';

let wsRoot = '';

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-shell-'));
  process.env.AGENTCHAT_WORKSPACE = wsRoot;
});

afterAll(() => {
  delete process.env.AGENTCHAT_WORKSPACE;
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

describe('bashCommandViolation：URL scheme 不误判为盘符（回归）', () => {
  it('用户实报命令：curl https://unpkg.com/... 不再被拦截为 S: 盘', () => {
    const cmd = 'curl.exe -sI --max-time 10 https://unpkg.com/three@0.160.0/build/three.module.js | Select-Object -First 5';
    expect(bashCommandViolation(cmd, [wsRoot])).toBeNull();
  });

  it('http:// ftp:// wss:// 均放行（旧逻辑分别误判 P:/P:/P:）', () => {
    expect(bashCommandViolation('Invoke-WebRequest http://localhost:3080/api/health', [wsRoot])).toBeNull();
    expect(bashCommandViolation('curl ftp://mirror.example.com/pub/data.tar.gz', [wsRoot])).toBeNull();
    expect(bashCommandViolation("node -e \"fetch('wss://example.com/socket')\"", [wsRoot])).toBeNull();
  });

  it('带端口 / userinfo / 多级路径的 URL 放行', () => {
    expect(bashCommandViolation('curl https://user:pass@example.com:8443/a/b?x=1', [wsRoot])).toBeNull();
    expect(bashCommandViolation('curl http://127.0.0.1:3080/health', [wsRoot])).toBeNull();
    expect(bashCommandViolation('git clone https://github.com/nefevcore/agentchat.git', [wsRoot])).toBeNull();
  });

  it('URL 与真实盘符路径混排时只报真实盘符', () => {
    const v = bashCommandViolation('curl https://example.com/x -o C:/Windows/temp/out.bin', [wsRoot]);
    expect(v).toMatch(/绝对路径（C:）/);
  });
});

describe('bashCommandViolation：越界路径仍拦截', () => {
  it('白名单外盘符绝对路径（反斜杠 / 正斜杠两种写法）', () => {
    expect(bashCommandViolation('Get-Content C:\\Windows\\win.ini', [wsRoot])).toMatch(/绝对路径（C:）/);
    expect(bashCommandViolation('type C:/Windows/win.ini', [wsRoot])).toMatch(/绝对路径（C:）/);
    expect(bashCommandViolation('robocopy src D:/out /mir', [wsRoot])).toMatch(/绝对路径（D:）/);
  });

  it('段首 / 引号内的盘符路径仍被识别', () => {
    expect(bashCommandViolation('C:/Windows/win.ini', [wsRoot])).toMatch(/绝对路径/);
    expect(bashCommandViolation('Get-Content "C:\\Windows\\win.ini"', [wsRoot])).toMatch(/绝对路径/);
  });

  it('Unix 绝对路径 / cd .. / ../ 引用', () => {
    expect(bashCommandViolation('cat /etc/passwd', [wsRoot])).toMatch(/Unix 绝对路径/);
    expect(bashCommandViolation('cd ..', [wsRoot])).toMatch(/cd 到/);
    expect(bashCommandViolation('type ../outside.txt', [wsRoot])).toMatch(/\.\./);
  });

  it('白名单内绝对路径与普通相对路径命令放行', () => {
    // 白名单根自身（Windows 盘符形态 / Unix 绝对形态都按 resolve 判定）
    expect(bashCommandViolation(`Get-Content ${wsRoot}\\file.txt`, [wsRoot])).toBeNull();
    expect(bashCommandViolation(`cat ${wsRoot}/file.txt`, [wsRoot])).toBeNull();
    expect(bashCommandViolation('pnpm vitest run src/shell', [wsRoot])).toBeNull();
  });
});

describe('bashCommandViolation：here-string / heredoc 载荷不误判（回归）', () => {
  it('用户实报命令：GLSL 检查脚本（含 JS 正则 /const\\s+/）经 @\'…\'@ | Set-Content 写盘不再被误拦', () => {
    // 旧逻辑：反斜杠归一化把 /const\\s+/ 变成 /const/s+，「 /const/」命中 Unix 绝对路径启发式 → 整条误拦
    const cmd = [
      "@'",
      "import glslangModule from '@webgpu/glslang';",
      "import fs from 'node:fs';",
      "const files = ['js/ocean.js', 'js/sky.js', 'js/creatures.js'];",
      "const glslang = await glslangModule();",
      'let ok = 0, bad = 0;',
      'for (const f of files) {',
      "  const src = fs.readFileSync(f, 'utf8');",
      '  const re = /const\\s+([A-Z_0-9]+)\\s*=\\s*\\/\\*\\s*glsl\\s*\\*\\/`([\\s\\S]*?)`;/g;',
      '  let m;',
      '  while ((m = re.exec(src)) !== null) {',
      "    console.log('OK  ', f, m[1]);",
      '  }',
      '}',
      "console.log(`${ok} passed, ${bad} failed`);",
      "'@ | Set-Content -Encoding UTF8 test-glsl.mjs; node test-glsl.mjs",
    ].join('\n');
    expect(bashCommandViolation(cmd, [wsRoot])).toBeNull();
  });

  it('here-string 载荷含真实路径样式文本也放行（数据非命令）', () => {
    const withDrive = "@'\nconst p = `C:/Windows/win.ini`; // 样例\n'@ | Set-Content sample.mjs";
    expect(bashCommandViolation(withDrive, [wsRoot])).toBeNull();
    const withUnix = "@'\n# 文档：cat /etc/passwd 示例\n'@ | Set-Content doc.md";
    expect(bashCommandViolation(withUnix, [wsRoot])).toBeNull();
  });

  it('双引号 here-string（@"…"@）同样剥离', () => {
    const cmd = '@"\nconst re = /const\\s+/g;\n"@ | Set-Content x.mjs';
    expect(bashCommandViolation(cmd, [wsRoot])).toBeNull();
  });

  it('载荷之后的真实命令仍受检（写盘目标/后续命令不放松）', () => {
    const driveCmd = "@'\npayload\n'@ | Set-Content x.mjs; Get-Content C:\\Windows\\win.ini";
    expect(bashCommandViolation(driveCmd, [wsRoot])).toMatch(/绝对路径（C:）/);
    const unixCmd = "@'\npayload\n'@ | Set-Content x.mjs; cat /etc/passwd";
    expect(bashCommandViolation(unixCmd, [wsRoot])).toMatch(/Unix 绝对路径/);
    // 载荷外（闭标记同行之后）的绝对路径写盘目标照拦
    const writeOut = "@'\npayload\n'@ | Set-Content D:/outside/x.mjs";
    expect(bashCommandViolation(writeOut, [wsRoot])).toMatch(/绝对路径（D:）/);
  });

  it('bash heredoc（<<\'EOF\'）载荷同样剥离；闭定界符后的命令受检', () => {
    const cmd = "cat > check.mjs <<'EOF'\nconst re = /const\\s+/g; // 正则字面量\nEOF\nnode check.mjs";
    expect(bashCommandViolation(cmd, [wsRoot])).toBeNull();
    const bad = "cat > check.mjs <<'EOF'\ncode\nEOF\ncat /etc/passwd";
    expect(bashCommandViolation(bad, [wsRoot])).toMatch(/Unix 绝对路径/);
  });

  it('位移运算 a << b 不被当作 heredoc 剥离（其后的真实路径仍被拦）', () => {
    // `<< b` 后随 `;`（非空白/重定向/EOL）→ 不构成 heredoc 开标记 → 命令照常扫描
    const cmd = 'node -e "const x = a << b" ; cat /etc/passwd';
    expect(bashCommandViolation(cmd, [wsRoot])).toMatch(/Unix 绝对路径/);
  });
});
