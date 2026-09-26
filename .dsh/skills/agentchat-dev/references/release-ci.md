# 发版与 CI 推送

> 读条件：发版、打 tag、推 CI、push 被卡、改 `.github/workflows/` 时。
> 事实源：`src/docs/release-ci-postmortem.md` 及续篇（翻车复盘全集）。

核心教训：历史发版从未首发 tag 全绿。翻车集中在三类边界，每类都要有「本地可复现的等价验证」：

| 边界 | 偏差 |
|---|---|
| 平台 | Windows dev ↔ Linux/macOS CI |
| 形态 | 源码 dev ↔ bundle 发布（「dev 能跑」≠「bundle 能跑」） |
| 环境 | 本地残留 node_modules ↔ CI 干净安装（残留会掩盖干净安装才暴露的问题） |

## 发版流程（严格按序）

1. **版本同步**：根 `package.json` 与 `desktop/package.json` 两处 version 一致（desktop 工作流非 tag 触发时从后者取）；CHANGELOG 的 `[Unreleased]` 改为版本段。
2. **本地预检**（与 CI 同序五步：install --frozen-lockfile → check:deps → build:frontend → test → build:bundle；任一步失败本地拦下，不浪费 CI 轮次）：
   ```powershell
   pnpm release:preflight          # 快档：用现有 node_modules
   pnpm release:preflight --clean  # 干净档：删全部 node_modules 全新安装——发版前必跑一次
   pnpm release:preflight --wsl    # Linux 真环境档：大小写敏感问题唯一拦截面
   ```
3. **打 tag 推送**（tag 即触发 npm + 桌面双工作流）：`git tag vX.Y.Z` → `git push origin main vX.Y.Z`。
4. **双绿才算发布完成**：npm 与桌面（含 manifest 收尾 job：sha256 校验 + 分发清单）双绿才对外宣布。双工作流同 tag 并行，一绿一红时 npm 可能已发旧版，须立即处理。
5. **失败重跑**：修复提交后 `git tag -f` + `git push -f` 重打 tag（旧 run 留 failure 记录是已接受副作用）。

## push 被持续 reset：TLS 指纹定向拦截（最易误判）

**先定位再处理**：用不同 TLS 栈对照测试——Node 与 curl 各试同一目标。Node 通而 git 死 = 按 ClientHello 指纹定向拦截 git 流量，不是网络不通。两者解法完全不同，误判浪费大量时间。

解法按优先级：

1. **本地中继**（已固化 `scripts/git-github-relay.cjs`）：git 明文 HTTP 连中继，中继用 Node TLS 握手 GitHub，凭据自动经 git credential fill 注入。
   ```powershell
   node scripts/git-github-relay.cjs 34567                          # 窗口 1：起中继（auth ready 即成）
   git push http://127.0.0.1:34567/nefevcore/AgentChat.git main     # 窗口 2：经中继推
   git push http://127.0.0.1:34567/nefevcore/AgentChat.git -f vX.Y.Z
   ```
2. **SSH 通道** ssh.github.com:443：加公钥一次性操作，长期最稳。
3. **不要在原通路反复重试**：每次 git 命令新建 TLS 连接，单连接存活率低，撞概率空窗无意义。

## 改 workflow 之后（首发翻车高发区）

- yaml 用 js-yaml 严格 load 预检——宽松 lint 拦不住缩进错位（曾致 steps 序列断裂、启动即挂）。
- 全部 run: 块逐个 `bash -n` 语法验证（git-bash 提供 bash）。
- windows 腿多行 run 必须 `shell: bash`（缺省 pwsh 会把 bash 语法当 PS 解析，直接崩）。
- 引号嵌套：`node -p` 外双内单；远端落盘 + scp 拉回取代多层引号拼接。
- 文件名含空格时，比对用 `grep -F` 全名匹配（awk 列比较遇空格截断，恒不匹配、误报缺失）。

## CI 失败时的日志获取

- 失败步骤自动转存下载服务器 `/ci-logs/<run_id>/<leg>.log`，匿名可读（artifact 匿名 API 403 的破解）；构建诊断 artifact 失败时自动上传。
- 慢机假阳性：CI 并发挤压下测试超时 ≠ 逻辑问题——资源敏感用例显式放宽超时再判。

## 已固化的护栏（别重复造，坏了先修它）

| 护栏 | 位置 |
|---|---|
| 发版预检三档 | `scripts/release-preflight.mjs` |
| push 中继（TLS 指纹拦截） | `scripts/git-github-relay.cjs` |
| 依赖卫生门禁（声明 / 深路径 / 循环 / 跨域 / 相位；规则见脚本头注释） | `scripts/check:deps.mjs` |
| sha256 发布闸 + staging 原子换入（异常包绝不进下载面） | desktop.yml 收尾 job |
| 失败日志转存（匿名可读） | 两 workflow 的 failure 步骤 |

## 三条原则

- **门禁越严，越要在本地预检同题跑一遍**——收紧阵痛期会重犯同类错。
- **CI 绿 ≠ 发布质量好**——门禁覆盖不到的面（bundle 行为 / 更新链路）要专门对账。
- **推送不可达 ≠ 工作没做完**——推送与状态查询分开管理，通道受阻走中继 / SSH，不在原通路耗着。
