// ============================================================
// tests/market-helpers.ts —— 测试共享：内存 USTAR 写入器 + mock 市场源
// ============================================================
import { gzipSync } from 'node:zlib';
import type { PluginManifest } from '@agentchat/agent-config';
import type { MarketEntry, MarketSource, ResolvedEntry } from '../src/market/source';

export interface TarEntry {
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
  header.write('0000644\0' + '0000000\0' + '0000000\0', 100);
  header.write(octal(entry.content?.length ?? 0, 12), 124);
  header.write(octal(0, 12), 136);
  header.write('        ', 148);
  const typeflag = entry.type === 'dir' ? '5'
    : entry.type === 'symlink' ? '2'
    : entry.type === 'longname' ? 'L'
    : entry.type === 'pax' ? 'x'
    : '0';
  header.write(typeflag, 156, 1);
  if (entry.linkname) header.write(entry.linkname.slice(0, 100), 157, 100);
  header.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

export function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    const content = entry.content ?? Buffer.alloc(0);
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export function buildTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

/** GitHub tarball 形态：顶层 owner-repo-ref/ 包住插件内容 */
export function buildPluginTarGz(
  manifest: Partial<PluginManifest> & { name: string; version: string },
  topDir = 'acme-hello-v1',
): Buffer {
  return buildTarGz([
    { name: `${topDir}/`, type: 'dir' },
    { name: `${topDir}/manifest.json`, content: Buffer.from(JSON.stringify({ entry: 'index.mjs', ...manifest })) },
    { name: `${topDir}/index.mjs`, content: Buffer.from('export function apply() {}\n') },
  ]);
}

/** 可编排的 mock 市场源（resolve/download 返回注入的 fixture） */
export class MockSource implements MarketSource {
  readonly id = 'github';
  searchResult: MarketEntry[] = [];
  searchError?: Error;
  resolved: ResolvedEntry[] = [];
  tarballs: Buffer[] = [];
  downloadedUrls: string[] = [];
  private searchCalls = 0;
  private resolveCalls = 0;

  async search(): Promise<MarketEntry[]> {
    this.searchCalls++;
    if (this.searchError) throw this.searchError;
    return this.searchResult;
  }

  async resolve(repo: string, ref?: string): Promise<ResolvedEntry> {
    const hit = this.resolved.find((r) => r.entry.repo === repo && (ref === undefined || r.entry.ref === ref));
    if (!hit) throw new Error(`mock: ${repo}${ref ? `#${ref}` : ''} 未编排`);
    this.resolveCalls++;
    return hit;
  }

  async download(url: string): Promise<Buffer> {
    this.downloadedUrls.push(url);
    const tarball = this.tarballs.shift();
    if (!tarball) throw new Error(`mock: 没有为 ${url} 编排 tarball`);
    return tarball;
  }

  get callCount(): { search: number; resolve: number } {
    return { search: this.searchCalls, resolve: this.resolveCalls };
  }
}
