# 发布手册（npm → GitHub Actions 自动发版）

> 适用于 `@nefevcore/agentchat`。目标：**本地只管 bump 版本 + 打标签，其余全部 CI 自动完成**（安装 → 测试 → 构建 → OIDC 免密发布）。

---

## 现状（一次性配置均已完成）

| 项 | 状态 | 说明 |
|------|------|------|
| npm 账号 | `nefevcore`，2FA 已开启 | 手动发布走浏览器确认 |
| 包名 | `@nefevcore/agentchat` | ⚠️ 裸名 `agentchat` 被拒：与既有包 `agent-chat` 撞名（npm 防抢注规则：去连字符后同名即拒） |
| 首发 0.7.1 | ✅ 已手动发布 | Trusted Publishing 只能配置在**已存在**的包上，首发必须手动一次 |
| Trusted Publisher | ✅ 已配置 | npmjs.com → 包页面 → Settings → Trusted Publishing：`nefevcore / AgentChat / publish.yml` / environment 留空 |
| 发布工作流 | `.github/workflows/publish.yml` | 推送 `v*` 标签触发；`id-token: write` + Node 24（npm ≥ 11.5 支持 OIDC） |
| 构建脚本 | `pnpm build:bundle`（`scripts/build-bundle.mjs`） | 组装 `dist/`：WebUI 产物 + logo + esbuild 后端 bundle（自包含，零运行时依赖） |

## 日常发版流程

```bash
# 1. bump 版本 + 归档 CHANGELOG（[Unreleased] → [x.y.z] + 日期）
#    改 package.json 的 version 字段

# 2. 提交 + 打标签
git add package.json CHANGELOG.md
git commit -m "chore(release): v0.7.2"
git tag v0.7.2

# 3. 推送（main 与标签一起）
git push origin main v0.7.2
```

CI（Actions → `publish`）自动执行：`pnpm install --frozen-lockfile` → `pnpm test`（541 例）→ `pnpm build:frontend`（vite）→ `pnpm build:bundle`（dist/）→ `npm publish`（OIDC 换取短时令牌，**无需任何 npm token/2FA**）。

验证：

```bash
npm view @nefevcore/agentchat version   # 应输出新版本号
```

## 本地验证发布产物（可选，CI 已覆盖）

```bash
pnpm build:frontend   # 前端 → src/ui/webui/dist
pnpm build:bundle     # 组装 dist/（agentchat.mjs + 前端产物）
npm pack --dry-run    # 预览包内容
npm publish --dry-run
```

冒烟（真实用户视角）：

```bash
npm install -g @nefevcore/agentchat
agentchat --port=3902   # 浏览器开 http://localhost:3902
```

## 踩坑记录（2026-08-18 首发）

1. **包名撞名报 403**：`Package name too similar to existing package agent-chat`——npm 会把新包名去连字符后与存量包比对，相同即拒。此前同一操作先后报过 `EOTP`（2FA）、`E404`（granular token 未开 All packages / 未勾 bypass 2FA），都是被前置校验挡住没走到真正原因，排障时要有心理预期。
2. **Trusted Publishing 不能预注册**：包不存在时 `npmjs.com/package/<name>/access` 直接 404，**首发必须手动**（`npm publish`，终端会给出浏览器认证链接），发完再配 Trusted Publisher。
3. **granular token 两个坑**：「Packages and scopes」必须 **All packages + Read and write**（否则新包 PUT 直接 404）；要免 2FA 需勾选「Allow this token to bypass two-factor authentication」（该勾选框只在账号 2FA 已开启时出现）。
4. **npm 新界面 2FA 默认主推 Passkey**：验证器 App 的二维码入口可能藏在「use an authenticator app instead」小字里，或根本没有；Windows Hello（Passkey）即可。
5. **发布后 CDN 有 ~1 分钟传播延迟**：`npm view` 404 不代表失败，等一会再查。
6. **发布内容自包含**：bundle 已内联全部后端依赖（含 undici 等外部依赖与内置 cordis），`dependencies` 为空是**有意为之**；`dist/` 在 .gitignore 中，CI 每次重建，不要手工提交。
7. **bundle 内联了 esbuild 本体**（`src/plugins/plugins/src/registry.ts` 的插件 UI 发布期构建用到），属已知情况，仅影响包体积（~1MB），不影响功能。
