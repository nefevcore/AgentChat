// ============================================================
// unix-translate：Unix → PowerShell 翻译单测
//
// 覆盖三层：① 正确形状翻译产物精确断言；② fail-closed（语义无法
// 忠实表达的形状必须返回 null 原样透传——2026-09-16 审查：旧实现
// "静默丢弃、继续翻"造成 grep -v 反转丢失、tail -f 丢操作数静默空
// 成功、find 丢谓词扩大搜索范围）；③ 硬失败形状修正（cat -n、多目标
// 空格连接曾是 pwsh 位置参数绑定错误）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { translateUnixToPowerShell } from '../src/unix-translate.ts';

describe('translateUnixToPowerShell —— 正确形状', () => {
  it('ls 目标 + 重定向：2>&1 不进路径集，原样追加译文尾部', () => {
    const r = translateUnixToPowerShell('ls "src/foo" 2>&1');
    expect(r.translated).toBe(true);
    expect(r.command).toBe(`Get-ChildItem 'src/foo' 2>&1`);
  });

  it('2>/dev/null 归一为 PS 同形的 2>$null', () => {
    const r = translateUnixToPowerShell('ls src 2>/dev/null');
    expect(r.command).toBe(`Get-ChildItem 'src' 2>$null`);
  });

  it('rm/cp/mv 同款：重定向不进目标集', () => {
    expect(translateUnixToPowerShell('rm -rf dir 2>&1').command).toBe('Remove-Item -Recurse -Force \'dir\' 2>&1');
    expect(translateUnixToPowerShell('cp -r a b 2>&1').command).toBe('Copy-Item -Recurse \'a\' \'b\' 2>&1');
    expect(translateUnixToPowerShell('mv a b 2>&1').command).toBe('Move-Item \'a\' \'b\' 2>&1');
  });

  it('ls -la → Get-ChildItem -Force', () => {
    expect(translateUnixToPowerShell('ls -la').command).toBe('Get-ChildItem -Force');
  });

  it('sleep 3 && echo done：&& 分隔符原样保留', () => {
    expect(translateUnixToPowerShell('sleep 3 && echo done').command).toBe('Start-Sleep -Seconds 3&& echo done');
  });

  it('grep 单文件 + -n：Select-String 带行号输出', () => {
    const r = translateUnixToPowerShell('grep -n contract src/README.md');
    expect(r.translated).toBe(true);
    expect(r.command).toBe(
      `Select-String -Path 'src/README.md' -Pattern 'contract' -CaseSensitive | ForEach-Object { if ($_.LineNumber) { "$($_.LineNumber):$($_.Line)" } else { $_.Line } }`,
    );
  });

  it('grep -i -v：大小写与反转语义保留（-NotMatch / -CaseSensitive:$false）', () => {
    const r = translateUnixToPowerShell('grep -iv node_modules src/index.ts');
    expect(r.translated).toBe(true);
    expect(r.command).toBe(
      `Select-String -Path 'src/index.ts' -Pattern 'node_modules' -NotMatch -CaseSensitive:$false | ForEach-Object { $_.Line }`,
    );
  });

  it('grep -rn 递归：带文件名前缀输出', () => {
    const r = translateUnixToPowerShell('grep -rn foo src');
    expect(r.translated).toBe(true);
    expect(r.command).toBe(
      `Get-ChildItem -Path 'src' -Recurse -File | Select-String -Pattern 'foo' -CaseSensitive | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`,
    );
  });

  it('grep -h 多文件：显式去文件名前缀', () => {
    const r = translateUnixToPowerShell('grep -h pattern a.txt b.txt');
    expect(r.command).toBe(
      `Select-String -Path 'a.txt','b.txt' -Pattern 'pattern' -CaseSensitive | ForEach-Object { $_.Line }`,
    );
  });

  it('cat 多文件：数组绑定', () => {
    expect(translateUnixToPowerShell('cat a.txt b.txt').command).toBe(`Get-Content 'a.txt','b.txt'`);
  });

  it('head/tail -n N file：Get-Content -TotalCount/-Tail', () => {
    expect(translateUnixToPowerShell('head -n 20 src/a.ts').command).toBe(`Get-Content 'src/a.ts' -TotalCount 20`);
    expect(translateUnixToPowerShell('tail -n 5 app.log').command).toBe(`Get-Content 'app.log' -Tail 5`);
    expect(translateUnixToPowerShell('tail -3 list.txt').command).toBe(`Get-Content 'list.txt' -Tail 3`);
  });

  it('head/tail 管道形（无文件）：Select-Object', () => {
    expect(translateUnixToPowerShell('head -5').command).toBe('Select-Object -First 5');
    expect(translateUnixToPowerShell('tail').command).toBe('Select-Object -Last 10');
  });

  it('wc -l 文件：Measure-Object -Line', () => {
    expect(translateUnixToPowerShell('wc -l src/a.ts').command).toBe(`(Get-Content 'src/a.ts' | Measure-Object -Line).Lines`);
  });

  it('wc -c 单文件：Get-Item Length（真实字节）', () => {
    expect(translateUnixToPowerShell('wc -c src/a.ts').command).toBe(`(Get-Item 'src/a.ts').Length`);
  });

  it('find 认识的谓词组合：-name + -type f + -maxdepth', () => {
    expect(translateUnixToPowerShell('find src -name "*.ts" -type f').command).toBe(
      `Get-ChildItem -Path 'src' -Recurse -File -Filter '*.ts'`,
    );
    expect(translateUnixToPowerShell('find . -maxdepth 1 -name "*.md"').command).toBe(
      `Get-ChildItem -Path '.' -Filter '*.md'`,
    );
  });

  it('mkdir -p 多目录：数组绑定 + -Force', () => {
    expect(translateUnixToPowerShell('mkdir -p a/b c/d').command).toBe(
      `New-Item -ItemType Directory -Force -Path 'a/b','c/d'`,
    );
  });

  it('touch 多文件：数组绑定', () => {
    expect(translateUnixToPowerShell('touch a.txt b.txt c.txt').command).toBe(
      `New-Item -ItemType File -Force -Path 'a.txt','b.txt','c.txt'`,
    );
  });

  it('rm 多目标：数组绑定（旧实现空格连接是 pwsh 绑定错误）', () => {
    expect(translateUnixToPowerShell('rm a b c').command).toBe(`Remove-Item 'a','b','c'`);
    expect(translateUnixToPowerShell('rm -f log1.log log2.log').command).toBe(`Remove-Item -Force 'log1.log','log2.log'`);
  });

  it('cp 多源单目标 / mv 多源单目标：数组绑定', () => {
    expect(translateUnixToPowerShell('cp a b c dst').command).toBe(`Copy-Item 'a','b','c' 'dst'`);
    expect(translateUnixToPowerShell('cp -r src1 src2 dst').command).toBe(`Copy-Item -Recurse 'src1','src2' 'dst'`);
    expect(translateUnixToPowerShell('mv a b dst').command).toBe(`Move-Item 'a','b' 'dst'`);
  });

  it('which 单/多命令', () => {
    expect(translateUnixToPowerShell('which node').command).toBe(`(Get-Command 'node' -ErrorAction SilentlyContinue).Source`);
    expect(translateUnixToPowerShell('which node pnpm').command).toBe(
      `(Get-Command 'node','pnpm' -ErrorAction SilentlyContinue).Source`,
    );
  });

  it('export 纯字面量值', () => {
    expect(translateUnixToPowerShell('export FOO="hello world"').command).toBe(`$env:FOO = 'hello world'`);
    expect(translateUnixToPowerShell('export BAR=42').command).toBe(`$env:BAR = '42'`);
  });

  it('ls 排序/格式 flag 不翻：-t/-S/-F 透传原文', () => {
    expect(translateUnixToPowerShell('ls -t').translated).toBe(false);
    expect(translateUnixToPowerShell('ls -S src').translated).toBe(false);
  });

  it('date 无参数 → Get-Date', () => {
    expect(translateUnixToPowerShell('date').command).toBe('Get-Date');
  });

  it('sleep 单位形：30s/5m', () => {
    expect(translateUnixToPowerShell('sleep 30s').command).toBe('Start-Sleep -Seconds 30');
    expect(translateUnixToPowerShell('sleep 5m').command).toBe('Start-Sleep -Minutes 5');
  });

  it('pwd → Get-Location', () => {
    expect(translateUnixToPowerShell('pwd').command).toBe('Get-Location');
  });

  it('附着重定向展开：ls > out.txt 不把目标当路径', () => {
    expect(translateUnixToPowerShell('ls > out.txt').command).toBe(`Get-ChildItem > out.txt`);
    expect(translateUnixToPowerShell('cat a.txt >> all.log').command).toBe(`Get-Content 'a.txt' >> all.log`);
  });
});

describe('translateUnixToPowerShell —— fail-closed（不可忠实翻译则整段透传）', () => {
  it('grep 语义不安全 flag：-l/-w/-E/-c 不翻（旧实现静默丢语义）', () => {
    expect(translateUnixToPowerShell('grep -l pattern src/').translated).toBe(false);
    expect(translateUnixToPowerShell('grep -w word file').translated).toBe(false);
    expect(translateUnixToPowerShell('grep -E "a|b" file').translated).toBe(false);
    expect(translateUnixToPowerShell('grep -c pattern file').translated).toBe(false);
  });

  it('grep 目录操作数（尾 /）非递归形：不翻（GNU grep 报错而译文会静默空结果）', () => {
    expect(translateUnixToPowerShell('grep -l pattern src/').translated).toBe(false);
    expect(translateUnixToPowerShell('grep pattern src/').translated).toBe(false);
  });

  it('grep --include 系：不翻（旧实现 --include 的 i 泄漏成 -i）', () => {
    expect(translateUnixToPowerShell('grep --include=*.ts -rn foo src').translated).toBe(false);
    expect(translateUnixToPowerShell('grep --exclude-dir=node_modules -rn foo src').translated).toBe(false);
  });

  it('head -c / tail -f：不翻（旧实现丢操作数静默空成功）', () => {
    expect(translateUnixToPowerShell('head -c 100 file.bin').translated).toBe(false);
    expect(translateUnixToPowerShell('tail -f app.log').translated).toBe(false);
  });

  it('cat -n：不翻（旧译文 Get-Content -n 是硬失败）', () => {
    expect(translateUnixToPowerShell('cat -n file.txt').translated).toBe(false);
  });

  it('wc -m/-L/长 flag：不翻', () => {
    expect(translateUnixToPowerShell('wc -m file').translated).toBe(false);
    expect(translateUnixToPowerShell('wc -L file').translated).toBe(false);
    expect(translateUnixToPowerShell('wc --lines file').translated).toBe(false);
  });

  it('cat f | wc -c：后段不翻（字节计数无忠实等价），前段照翻', () => {
    expect(translateUnixToPowerShell('cat f | wc -c').command).toBe(`Get-Content 'f'| wc -c`);
  });

  it('find 未识别谓词：-exec/-not/-path 不翻（旧实现静默丢谓词）', () => {
    expect(translateUnixToPowerShell('find . -name "*.ts" -exec rm {} \\;').translated).toBe(false);
    expect(translateUnixToPowerShell('find . -not -path "./node_modules/*" -name "*.ts"').translated).toBe(false);
    expect(translateUnixToPowerShell('find . -mtime -7').translated).toBe(false);
  });

  it('export 值含 Unix 变量展开：不翻（旧实现把字面量 $PATH 污染进环境）', () => {
    expect(translateUnixToPowerShell('export PATH="/new/bin:$PATH"').translated).toBe(false);
    expect(translateUnixToPowerShell('export FOO=${BAR}/x').translated).toBe(false);
  });

  it('rm/cp/mv 目标含 Unix 变量展开：不翻', () => {
    expect(translateUnixToPowerShell('rm -rf $BUILD_DIR').translated).toBe(false);
    expect(translateUnixToPowerShell('cp $SRC dst').translated).toBe(false);
  });

  it('date 带格式串：不翻（+%s 输出语义完全不同）', () => {
    expect(translateUnixToPowerShell('date +%s').translated).toBe(false);
    expect(translateUnixToPowerShell('date +%Y-%m-%d').translated).toBe(false);
  });

  it('段内命令替换/子 shell：整段不翻（嵌套层还有 Unix 命令）', () => {
    expect(translateUnixToPowerShell('echo "count: $(ls src | wc -l)"').translated).toBe(false);
    expect(translateUnixToPowerShell('echo `date`').translated).toBe(false);
  });

  it('mkdir/touch/rm/cp 未识别 flag：不翻', () => {
    expect(translateUnixToPowerShell('mkdir -m 755 dir').translated).toBe(false);
    expect(translateUnixToPowerShell('touch -t 202601010000 f').translated).toBe(false);
    expect(translateUnixToPowerShell('rm -i file').translated).toBe(false);
    expect(translateUnixToPowerShell('cp -p a b').translated).toBe(false);
  });

  it('which -a：不翻', () => {
    expect(translateUnixToPowerShell('which -a node').translated).toBe(false);
  });

  it('不认识的命令：透传', () => {
    expect(translateUnixToPowerShell('git status').translated).toBe(false);
    expect(translateUnixToPowerShell('pnpm test').translated).toBe(false);
  });

  it('部分翻译：多段命令只翻认识的段', () => {
    const r = translateUnixToPowerShell('cat -n f.txt; ls src');
    expect(r.translated).toBe(true);
    expect(r.command).toBe('cat -n f.txt;Get-ChildItem \'src\'');
  });
});
