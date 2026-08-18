// ============================================================
// @agentchat/plugins 测试：market/tarball.ts —— 安全解包器
// fixture 在内存中手写 USTAR 头（不引第三方 tar 库，覆盖越界/逃逸/类型白名单）
// ============================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../src/market/tarball';

// ---- 测试用 USTAR 写入器 ----

interface TarEntry {
  name: string;
  content?: Buffer;
  type?: 'file' | 'dir' | 'symlink' | 'longname' | 'pax';
  linkname?: string;
}

function octal(size: number, length: number): string {
  return size.toString(8).padStart(length - 1, '0') + '\0';
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name.slice(0, 100), 0, 100, 'utf8');
  header.write('0000644\0' + '0000000\0' + '0000000\0', 100); // mode/uid/gid
  header.write(octal(entry.content?.length ?? 0, 12), 124);
  header.write(octal(0, 12), 136); // mtime
  header.write('        ', 148); // checksum 占位
  const typeflag = entry.type === 'dir' ? '5'
    : entry.type === 'symlink' ? '2'
    : entry.type === 'longname' ? 'L'
    : entry.type === 'pax' ? 'x'
    : '0';
  header.write(typeflag, 156, 1);
  if (entry.linkname) header.write(entry.linkname.slice(0, 100), 157, 100);
  header.write('ustar\0' + '00', 257); // magic + version
  // checksum：对 checksum 字段置空后的整个 header 求和
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    const content = entry.content ?? Buffer.alloc(0);
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024)); // 结束块
  return Buffer.concat(chunks);
}

function buildTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

// ---- 用例 ----

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-tarball-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** GitHub 形态：顶层 owner-repo-ref/ 目录 + plugin 文件 */
const GITHUB_ENTRIES: TarEntry[] = [
  { name: 'acme-hello-v1/', type: 'dir' },
  { name: 'acme-hello-v1/manifest.json', content: Buffer.from(JSON.stringify({ name: 'agentchat-hello', version: '1.0.0' })) },
  { name: 'acme-hello-v1/index.mjs', content: Buffer.from('export function apply() {}') },
  { name: 'acme-hello-v1/src/deep/util.ts', content: Buffer.from('export const x = 1;') },
];

describe('extractTarGz', () => {
  it('正常解包（stripComponents=1 剥 GitHub 顶层目录）', () => {
    const dest = path.join(tmpRoot, 'out');
    const result = extractTarGz(buildTarGz(GITHUB_ENTRIES), dest);
    expect(result.files).toBe(3);
    expect(fs.existsSync(path.join(dest, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'src/deep/util.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'index.mjs'), 'utf8')).toBe('export function apply() {}');
  });

  it('剥前缀后为空（纯顶层目录条目）→ 报错', () => {
    expect(() => extractTarGz(buildTarGz([{ name: 'only-root/', type: 'dir' }]), path.join(tmpRoot, 'x')))
      .toThrow(/没有可解条目/);
  });

  it('路径含 .. → 拒绝该条目（记入 skipped，不解出）', () => {
    const dest = path.join(tmpRoot, 'out');
    const result = extractTarGz(buildTarGz([
      { name: 'top/', type: 'dir' },
      { name: 'top/../../evil.txt', content: Buffer.from('nope') },
      { name: 'top/ok.txt', content: Buffer.from('ok') },
    ]), dest);
    expect(fs.existsSync(path.join(tmpRoot, 'evil.txt'))).toBe(false);
    expect(result.skipped.some((s) => s.includes('evil'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'ok.txt'), 'utf8')).toBe('ok');
  });

  it('符号链接条目被跳过（不落盘）', () => {
    const dest = path.join(tmpRoot, 'out');
    const result = extractTarGz(buildTarGz([
      { name: 'top/', type: 'dir' },
      { name: 'top/link', type: 'symlink', linkname: '/etc/passwd' },
      { name: 'top/real.txt', content: Buffer.from('r') },
    ]), dest);
    expect(fs.existsSync(path.join(dest, 'link'))).toBe(false);
    expect(result.skipped.length).toBe(1);
    expect(result.files).toBe(1);
  });

  it('绝对路径条目被拒绝', () => {
    const dest = path.join(tmpRoot, 'out');
    extractTarGz(buildTarGz([
      { name: 'top/', type: 'dir' },
      { name: '/etc/absolute.txt', content: Buffer.from('x') },
      { name: 'top/ok.txt', content: Buffer.from('ok') },
    ]), dest);
    expect(fs.existsSync(path.join(dest, 'ok.txt'))).toBe(true);
    // 绝对路径被 safeRelativePath 规整为 etc/absolute.txt？不——leading / 被 strip 后变相对
    // 这里明确断言：没有写到任何插件目录之外的怪异位置（dest 之外）
    expect(fs.existsSync(path.join(tmpRoot, 'etc')) || fs.existsSync('/etc/absolute.txt')).toBe(false);
  });

  it('单文件超限 → 抛错', () => {
    const big = Buffer.alloc(512); // 512 字节 × 超小上限
    expect(() => extractTarGz(
      buildTarGz([
        { name: 'top/', type: 'dir' },
        { name: 'top/big.bin', content: big },
      ]),
      path.join(tmpRoot, 'out'),
      { maxFileBytes: 256 },
    )).toThrow(/超单文件上限/);
  });

  it('内容截断 → 抛错', () => {
    const full = buildTar([
      { name: 'top/', type: 'dir' },
      { name: 'top/data.bin', content: Buffer.alloc(2048) },
    ]);
    const truncated = full.subarray(0, 512 + 512 + 256); // header + 声明 2048 只给 256
    expect(() => extractTarGz(gzipSync(truncated), path.join(tmpRoot, 'out')))
      .toThrow(/截断/);
  });

  it('GNU longname（typeflag L）长路径生效', () => {
    const longName = `top/${'a'.repeat(150)}.txt`;
    const archive = buildTar([
      { name: 'top/', type: 'dir' },
      { name: '././@LongLink', type: 'longname', content: Buffer.from(`${longName}\0`) },
      { name: 'placeholder-truncated-name', content: Buffer.from('long!') },
    ]);
    const dest = path.join(tmpRoot, 'out');
    const result = extractTarGz(gzipSync(archive), dest);
    expect(result.files).toBe(1);
    expect(fs.readFileSync(path.join(dest, `${'a'.repeat(150)}.txt`), 'utf8')).toBe('long!');
  });

  it('非 gzip 输入 → 报错', () => {
    expect(() => extractTarGz(Buffer.from('plain text'), path.join(tmpRoot, 'out')))
      .toThrow(/gzip/);
  });
});
