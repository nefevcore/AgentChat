# 块 E 迁移执行记录（L4：preview 整体切换 src）

> 执行日期：2026-08-15（续·九 → 块 E）
> 依据：`docs/everything-plugin-gap-plan.md` §3 第 1–4 步。

## 0. 迁移前冻结基线

- 备份（`backups/`，已被 `.gitignore` 排除，不含 node_modules/dist/.vite）：
  - `backups/preview-block-e-baseline/` —— preview 完整源码基线（627 文件）
  - `backups/src-main-block-e-baseline/` —— 旧 src 源码基线（306 文件，不含 node_modules/dist）
  - `backups/root-config-block-e-baseline/` —— 旧根 package/tsconfig/vitest/tests + git-status + git-diff patch
- 基线验证（preview 迁移前）：
  - `preview/pnpm typecheck`：0 错误 ✅
  - `preview/pnpm test`：**406/406 通过** ✅
  - `preview/packages/ui/webui/pnpm typecheck && pnpm build`：vue-tsc + tsc(plugin) 0 错误，vite build 成功 ✅

## 1. 目录映射

```text
preview/packages/<domain>/<pkg>/  → src/<domain>/<pkg>/
preview/vendor/<name>/             → src/vendor/<name>/
preview/cordis.yml                 → cordis.yml（HMR root: packages → src）
preview/pnpm-workspace.yaml        → pnpm-workspace.yaml（src/*/*）
preview/package.json               → 根 package.json（scripts/deps 同步）
preview/tsconfig.json              → 根 tsconfig.json（paths: packages → src）
preview/vitest.config.ts           → 根 vitest.config.ts（include: src/**/tests/**）
```

兼容垫片（唯一保留的旧 src 文件）：

```text
src/shared/types/index.ts   ← 旧 @shared/types 前端别名垫片；WebUI vite/tsconfig 继续指这里
```

## 2. 删除清单

- 旧 `src/` 全部源码（agents/app/core/plugins/server/services/shared/types 旧实现、ui/webui 旧源码、ui/webui_v1_archive、utils 等）——由 preview 包完全替换。
- 旧根 `tests/`（60 个旧架构测试，import 旧 src 路径）——功能已由 preview 各包 tests（406 用例）覆盖，按计划删除。
- `preview/` 临时双轨目录在验收通过后整体移除（先保留源码副本于 backups）。
- `package-lock.json`（pnpm workspace 迁移后不再使用 npm lock；`src/ui/webui/package-lock.json` 随旧 src 一起删除）。

## 3. 路径修正

- `cordis.yml`：HMR `root: ['packages']` → `['src']`。
- `tsconfig.json`：所有 `packages/<domain>/<pkg>` paths → `src/<domain>/<pkg>`；include/exclude 同步。
- `vitest.config.ts`：include `src/**/tests/**/*.test.ts`，删除旧 `tests/**`。
- `src/ui/webui/vite.config.ts` + `tsconfig.json`：`@shared` 从 `../../../../src/shared` → `../../shared`。
- `src/ui/webui/package.json` test script：`cd ../.. && pnpm vitest run packages/ui/webui/tests/...` → `cd ../../.. && pnpm vitest run src/ui/webui/tests/...`（或保留为根目录 filter 命令）。
- `src/host/server/src/webui-server.ts`：仓库根推导改为 `path.resolve(here, '../../..', 'ui', 'webui', 'dist')`（src/host/server/src → 仓库根）。
- `src/boot/boot/src/supervisor.ts`：入口不再存在 `src/app/index.ts`，改为 cordis Loader 启动方式（若保留脚本，指向 `node_modules/@agentchat/cordis/bin.js`）。

## 4. 验证判据（已全部通过 ✅）

| 项 | 命令/判据 | 结果 |
|---|---|---|
| 根全量 typecheck | `pnpm typecheck`（含全部 src 包 src+tests）0 错误 | ✅ 0 错误 |
| 根全量测试 | `pnpm test`：406/406 | ✅ **406/406** |
| 根构建 | `pnpm build`（pnpm -r build，WebUI vue-tsc + vite build） | ✅ 通过 |
| WebUI 独立校验 | `pnpm --filter @agentchat/webui typecheck` + `build` | ✅ 通过（build 含于根 build） |
| desktop 打包 | `cd desktop && npm run build`（Tauri nsis/msi） | ✅ NSIS + MSI 产出 |
| dev 冒烟 | 根 `pnpm dev`：Loader Ready + WebUI 3830 | ✅ Ready（冒烟后已停止） |

> desktop 打包网络说明：GitHub 直连下载 NSIS/WiX 会超时。本次先把 `nsis-3.11.zip`（SHA1 `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D`）与 `wix314-binaries.zip`（SHA256 `6AC824E1642D6F7277D0ED7EA09411A508F6116BA6FAE0AA5F2C7DAA2FF43D31`）经镜像下载后预置到 `%LOCALAPPDATA%\tauri\{NSIS,WixTools314}`，随后 `npm run build` 完整产出两个 bundle。后续机器如遇同样超时，可设 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` 或按上述方式预置缓存。
