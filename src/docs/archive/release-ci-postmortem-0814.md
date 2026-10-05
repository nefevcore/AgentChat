
# 0.8.14 发版全程实录（2026-09-24/25——23 轮 CI 的教训集）

> 本文是 release-ci-postmortem.md 的续篇/实操录。0.8.14 把主档 §2 的所有边界类型
> 全部踩了一遍并新增多个类型。按「产物传输架构」的演进为主线索记录。

## A. 架构一：三腿 scp 直推 downloads（0.8.13 及以前）

稳定但慢：境外 runner 到境内服务器约 5Mbps，macOS 腿 400MB 串行 scp，三腿累计 40+ 分钟。

## B. 架构二：Releases draft 中转 + 服务器反向拉取（第 7~18 轮）——已退役

方向反转的设想（runner 到 Releases 走 GitHub 内网秒传；服务器到 GitHub 方向带宽好）
实证三重不可解之坑：

1. **三腿并发 getOrCreate 各建各的 draft**——拉取时只找到一个 draft（4 资产而非 9）。
   修法：聚合该 tag 全部 draft 资产按名去重。能修，但预示状态复杂度。
2. **服务器拉取触发 QoS 断流（致命）**——境内到境外连续大流量（实测约 550MB 阈值）
   触发运营商级断流持续数分钟，期间任何重试无效。单文件 curl 重试 5 次不够；
   限速 3MB/s 没躲过；整段重试 3 次仍在断流窗口内。物理层不可解。
3. **跨 run 删 draft 竞态**——拉完即删（GitHub 零残留）在 tag 反复重打的排障模式下必撞：
   上一轮 manifest 删 draft 时，下一轮 macOS 腿（打包数分钟）正持旧 release id 上传，
   404 三连败（转存日志实证 POST uploads 404）。

辅助教训：管道（cmd 竖线 while）的循环体在子 shell 里，return 1 被吞——拉取全败却
「成功」换入空目录顶掉 7 文件旧目录。bash 经典坑；改 process substitution + 换入前
拉齐数防御。

## C. 架构三：三腿 scp 直推 staging + 服务器本地原子换入（第 19 轮起，现行）

```
三腿构建（--publish never）
  → scp 直推 /var/www/agentchat/staging/<ver>/（并行，不进 nginx 下载面）
  → manifest job：staging 文件数 ≥5 校验
  → 服务器本地原子换入 downloads（旧目录挪 .old 再替换，任一时刻下载面完整）
  → 读回校验（sha256 闸：服务器字节 vs CI 基准 artifact）
  → gen-manifest --keep 3 重算
```

时长 = 最慢腿（macOS 约 15-20 分钟），接受；换「曾验证稳定」的确定性。

## D. 0.8.14 全部翻车点速查表（23 轮完整清单）

| 轮 | 症状 | 根因 | 类型 |
|---|---|---|---|
| 1-3 | check:deps R4 / vite 解析 uplot css | webui 冗余声明；uplot 改 peer 供给 | 环境边界 |
| 4-5 | vite 解析 uplot css 仍挂 | 包内真实文件名 uPlot.min.css（大写 P），Windows/macOS 不敏感恒绿、Linux 必挂；用户提议用服务器 Linux 环境取证定位 | 平台边界 |
| 5 | sha-baseline artifact 空 | /tmp 路径语义分裂：git-bash 映射 TEMP、upload-artifact 当 C:\tmp | 平台边界 |
| 5-6 | npm publish E401 | setup-node 的 registry-url 写空 _authToken，OIDC 走 legacy 认证必 401 | 认知盲区 |
| 6 | npm 仍失败 | node 24.21 自带 npm 10.9.9 低于 11.5（OIDC 最低要求）；0.8.13 成功纯属小版本巧合——显式升级 npm@11 钉死 | 版本漂移 |
| 7-11 | windows 腿打包连挂 | 多行 bash 脚本缺 shell: bash，windows 缺省 pwsh，set -o pipefail 被 Set-Variable 解析即崩；前四轮无日志（崩在 tee 前），touch+EB-EXIT 标记加固后现形 | 平台边界 |
| 8 | eb 配置校验失败 | draft 不是 GithubOptions 合法键（additionalProperties:false），正确键 releaseType:draft——对着 scheme.json 核实 | 文档核实 |
| 9-10 | eb 上传 draft 失败 | desktop/package.json 缺 repository 字段（GitHub publisher 定位必需；generic 时代不需要） | 配置依赖 |
| 12-13 | 服务器拉取断流 | QoS（见 B.2） | 网络物理层 |
| 15 | macOS 上传 404 | 跨 run 删 draft 竞态（见 B.3） | 并发时序 |
| 16-17 | 拉取成功但目录空 | 管道子 shell 吞 return（见 B 辅助教训） | bash 语义 |
| 19 | line 40 unexpected EOF | 三层双引号嵌套（node -p "require..." 在 "$(...)" 内）——外双内单改写；REMOTE_SUMS 改远端落盘+scp 拉回 | bash 语法 |
| 20 | exe 缺失（误报） | 文件名含空格（AgentChat Setup 0.8.14.exe）在 awk 列比较下第二列只取到 AgentChat——grep -F 全名匹配 | bash 语义 |
| 22 | workflow 秒挂（jobs=0） | 步骤头缩进多 4 空格致 steps 序列断裂；yaml-lint 宽松没拦住、js-yaml 严格加载当场报错——预检升级双检 | 工具链 |

## E. 新增工具/流程（全部已固化入库）

1. **pnpm release:preflight**——CI 同序五步本地预检；--clean 干净安装档；--wsl Linux
   真环境档（WSL Ubuntu 24.04 + node 22 + pnpm 12.4.1，大小写敏感已验证）。脚本
   scripts/release-preflight.mjs。
2. **workflow 双重预检**——改 .github/workflows 后必跑：js-yaml 严格加载（结构断言）+
   抽取全部 run 脚本逐个 bash -n。22 轮缩进错、19 轮引号错都能本地拦下。
3. **CI 失败日志转存服务器**——/ci-logs/<run_id>/<step>.log（nginx 匿名直出），破解
   Actions job 日志匿名 API 403 的死局。eb/npm/读回校验三处已挂 tee。
4. **GitHub 推送中继**——scripts/git-github-relay.cjs（git 的 openssl TLS 指纹被定向
   reset 时经 Node TLS 中继推送；主档 2.6 节详述定位法）。
5. **gen-manifest --keep N**——版本保留裁剪（每版约 600MB，keep 3 封顶 1.8GB），随发版
   自动同步服务器脚本。
6. **服务器 Linux 验证机**（备用）——可临时装 pnpm 复现 Linux 侧问题，但 2 核 1.7G
   跑构建会压垮 sshd（实测），优先 WSL 档。

## F. 仍开放的事项

- npm trusted publishing 的 registry-url 教训适用所有 OIDC 场景（publish.yml 注释保留）。
- draft 通道退役但基础设施（ci-logs 转存/nginx 路由）保留——再想试「GitHub 零占用」
  分发时，先读 B 节三重坑。
