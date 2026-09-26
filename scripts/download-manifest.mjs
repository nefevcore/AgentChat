// ============================================================
// scripts/download-manifest.mjs —— 下载面版本清单的生成与校验（M3.5）
//
// 方案 §4.6：manifest.json = [{ platform, version, versionCode, url, sha256, size }]，
// **同一份文件进两处**——服务器 /downloads/manifest.json（数据源）+ git 仓库
// （信任锚）。HTTP 无证书完整性，故「git 存哈希、服务器存字节」：客户端从可信
// 来源取清单、从服务器取字节，落地前按清单 sha256 校验——MITM 换掉服务器上的
// 字节也过不了校验。
//
// 用法：
//   node scripts/download-manifest.mjs add <文件> --platform android --version 1.0.1 \
//        --version-code 2 --base-url https://example.com/downloads [--out manifest.json]
//   node scripts/download-manifest.mjs check <文件> --manifest manifest.json
//         用清单里的 sha256 校验本地文件（发布前自检：进服务器的字节与进 git 的
//         哈希必须对得上）
//
// 设计要点：
//   · **纯确定性**——只读字节算 sha256/size，不依赖构建系统；CI 与本地同一条路径；
//   · 同 platform+versionCode 视为同一版本：重复 add 覆盖（幂等，CI 重跑安全）；
//   · url 由 base-url + 目录约定拼出（方案：/downloads/<platform>/<file>）；
//   · 输出按键排序、缩进 2——便于 git diff 阅读（人工审计哈希变更）。
// ============================================================
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

/** 已支持的平台（方案 §4.6 分发链：Win / Android 两端） */
const PLATFORMS = ['android', 'win', 'mac', 'linux'];

function argOf(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(flag + ' 缺值');
  return v;
}

function readManifest(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('manifest 必须是数组');
  return parsed;
}

function writeManifest(path, entries) {
  // 排序：platform → versionCode 降序（新的在前，人读友好）
  const sorted = [...entries].sort((a, b) =>
    a.platform === b.platform
      ? (b.versionCode ?? 0) - (a.versionCode ?? 0)
      : a.platform.localeCompare(b.platform));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
  return sorted;
}

function sha256Of(file) {
  const buf = readFileSync(file);
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength };
}

function cmdAdd(args) {
  const file = args[0];
  if (!file) throw new Error('add 需要文件路径');
  if (!existsSync(file)) throw new Error('文件不存在: ' + file);
  const platform = argOf(args, '--platform');
  if (!platform || !PLATFORMS.includes(platform)) {
    throw new Error('--platform 必填且须为 ' + PLATFORMS.join('/'));
  }
  const version = argOf(args, '--version');
  if (!version) throw new Error('--version 必填（如 1.0.1）');
  // versionCode 供 Android 比对（versionName 字符串比较不可靠）；缺省由 version 派生
  const versionCode = Number(argOf(args, '--version-code', version.split('.').reduce(
    (acc, p) => acc * 1000 + (Number(p) || 0), 0)));
  const baseUrl = argOf(args, '--base-url', '');
  const out = argOf(args, '--out', 'manifest.json');

  const { sha256, size } = sha256Of(file);
  const name = basename(file);
  const url = baseUrl
    ? baseUrl.replace(/\/+$/, '') + '/' + platform + '/' + name
    : name;

  const entries = readManifest(out).filter(
    (e) => !(e.platform === platform && e.versionCode === versionCode));
  entries.push({ platform, version, versionCode, url, sha256, size });
  const sorted = writeManifest(out, entries);

  console.log('[manifest] ' + platform + ' ' + version + ' (code ' + versionCode + ')');
  console.log('[manifest] sha256=' + sha256);
  console.log('[manifest] size=' + size + ' (' + (size / 1048576).toFixed(2) + ' MB)');
  console.log('[manifest] ' + out + ' 现有 ' + sorted.length + ' 条');
}

function cmdCheck(args) {
  const file = args[0];
  if (!file) throw new Error('check 需要文件路径');
  const manifestPath = argOf(args, '--manifest', 'manifest.json');
  const entries = readManifest(manifestPath);
  const name = basename(file);
  const { sha256, size } = sha256Of(file);
  const hit = entries.find((e) => e.url && e.url.endsWith(name));
  if (!hit) {
    console.error('[manifest] 清单里没有 ' + name + '——无法校验');
    process.exit(1);
  }
  const ok = hit.sha256 === sha256 && hit.size === size;
  console.log('[manifest] ' + name + ' ' + (ok ? '校验通过' : '校验失败'));
  if (!ok) {
    console.error('  清单: sha256=' + hit.sha256 + ' size=' + hit.size);
    console.error('  实际: sha256=' + sha256 + ' size=' + size);
  }
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);
try {
  if (sub === 'add') cmdAdd(rest);
  else if (sub === 'check') cmdCheck(rest);
  else {
    console.error('用法: download-manifest.mjs <add|check> <文件> [选项]');
    process.exit(2);
  }
} catch (err) {
  console.error('[manifest] ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

