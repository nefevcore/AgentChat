# @agentchat/backup
> 包路径 `src/svc/backup` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
数据备份运行库（纯函数库，非 cordis 插件）。`createBackup()` 将整个工作区打包为 zip：自动备份按 7 天最小间隔（`weekly` 轮转）执行，到期才真正打包；手工触发可用 `force` 跳过间隔检查。备份输出到项目根 `backups/`（gitignore 排除），保留最近 `BACKUP_KEEP` 份（默认 4 份），超出部分循环删除。

## 目录（关键源文件 + 一句话）

| 文件 | 职责 |
| --- | --- |
| `src/svc/backup/src/index.ts` | `createBackup`/`listBackups`/`backupDue` 全量实现（adm-zip 压缩 + 轮转清理） |
| `tests/backup.test.ts` | createBackup/listBackups/backupDue 单测 |

## 插件行

无插件行。作为 L4 可调能力由 `@agentchat/timer` 服务行（`__backup_all__` 定时任务）与 `@agentchat/server` HTTP 路由（`POST /api/backup`）直接 import 使用。

## 提供的能力

| 导出 | 签名/默认值 | 说明 |
| --- | --- | --- |
| `BACKUP_KEEP` | `4` | 保留最近 N 份，循环覆盖 |
| `BACKUP_INTERVAL_MS` | `7 * 24 * 60 * 60 * 1000` | 自动备份最小间隔（7 天） |
| `BACKUP_DIR` | `'backups'` | 备份目录名 |
| `backupRootDir()` | `path.resolve(process.cwd(), BACKUP_DIR)` | 备份目录绝对路径（项目根/backups） |
| `listBackups()` | `Array<{ file: string; size: number; createdAt: string }>` | 列出 `*.zip`，按文件名倒序（最新在前） |
| `backupDue()` | `boolean` | 无备份或最新备份距现在 ≥ 7 天返回 `true` |
| `createBackup(opts?)` | `{ file, size, backups, skipped? }` | 执行一次完整备份，见下 |

`createBackup({ force = false })` 流程：

1. 非 `force` 且 `backupDue() === false` → 返回 `{ file:'', size:0, backups: listBackups(), skipped:true }`。
2. `workspaceRoot()` 不存在则抛错。
3. 备份文件名：`backup-<ISO 前 19 位，冒号点改 `-`>.zip`（如 `backup-2026-08-05T07-50-00.zip`）。
4. 递归收集工作区全部文件（不排除 archive——全量备份），排除目录 `node_modules/.git/dist/.cache/_tmp`，排除文件 `.DS_Store/Thumbs.db`；用 `adm-zip` 写入 zip。
5. 写完后 `listBackups()`，删除 `backups.slice(BACKUP_KEEP)` 之外的旧文件。
6. 返回 `{ file, size, backups: listBackups() }`。

## 关键契约 / API

```ts
export const BACKUP_KEEP = 4;
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const BACKUP_DIR = 'backups';
export function backupRootDir(): string;
export function listBackups(): Array<{ file: string; size: number; createdAt: string }>;
export function backupDue(): boolean;
export function createBackup(opts?: { force?: boolean }): {
  file: string;
  size: number;
  backups: Array<{ file: string; size: number; createdAt: string }>;
  skipped?: boolean;
};
```

## 配置
无独立配置命名空间。备份位置固定为 `<cwd>/backups`（不随 `workspaceDir` 移动）；备份内容为 `workspaceRoot()`（`AGENTCHAT_WORKSPACE` 可覆盖）下的全部数据。保留份数由常量 `BACKUP_KEEP=4` 决定，自动间隔由常量 `BACKUP_INTERVAL_MS`（7 天）决定，源码中未提供配置项覆盖。

## 与其他插件的关系
- 依赖：`@agentchat/util`（logger）、`adm-zip`（压缩）、`@agentchat/toolkit`（`workspaceRoot`）。
- 使用方：
  - `@agentchat/timer`：`service-plugin.ts` 在 `TimerManager` 中注入 `backupAll: () => createBackup()`，供定时特殊 hint `__backup_all__` 触发（不走 LLM）。
  - `@agentchat/server`：`api/backup.ts` 提供 `GET /api/backup`（列表）与 `POST /api/backup`（`createBackup({ force:true })` 手工触发）。
  - `@agentchat/boot`：package.json 声明依赖（装配/定时链路）。

## 测试
package.json：`test: vitest run`。测试文件 `tests/backup.test.ts` 覆盖：createBackup 打包工作区并列出、weekly 到期判断（非强制跳过/强制执行）、轮转保留份数、工作区不存在抛错。

## 相关文档
固定链接：[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
