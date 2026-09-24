# 发布 CI 问题复盘（release-ci-postmortem）

> 2026-09-24 整理。统计口径：GitHub Actions 工作流 publish.yml（npm 发版）
> 与 desktop.yml（桌面安装包三腿构建 + 自托管分发），v0.8.0 起共 12 个版本、
> 20 次 publish run、17 次 desktop run。**没有一次发版是首发 tag 直接全绿的**。

## 一、总览：每个版本的首发结果

| 版本 | publish 首发 | desktop 首发 | 首发失败原因（修复后重跑结果） |
|---|---|---|---|
| v0.8.0–v0.8.2 | ✅×3 | —（当时无 desktop 流水线） | — |
| v0.8.3 | ❌ | — | （具体原因早于本档留存期，未记录） |
| v0.8.4 / v0.8.5 | ✅×2 | — | — |
| v0.8.6 | ❌→✅ | ❌→✅ | **CI Linux 门禁四连修**（见 §2.1） |
| v0.8.8 | ❌ | — | **测试并发超时**（见 §2.2） |
| v0.8.9 | ❌→✅ | — | 同 v0.8.8 残留（同因重跑过） |
| v0.8.10 | ❌→✅ | — | （依赖声明细类） |
| v0.8.11 | ✅ | ❌→✅ | **run_code bundle 形态回归**（见 §2.3） |
| v0.8.12 | ✅ | ✅ | 唯一首发双绿（但见 §2.6 的隐性返工） |
| v0.8.13 | ❌❌→✅ | ❌❌→✅ | **三连失败**：依赖卫生 R4 + electron-builder 空引用崩溃（见 §2.4） |
| v0.8.14 | ❌→重跑中 | ❌→重跑中 | **R4 再犯**（uplot 冗余声明）+ **干净安装暴露解析断链**（见 §2.5） |

## 二、失败模式分类（按根因）

### 2.1 平台差异盲区（v0.8.6——CI Linux 门禁四连修）
- **现象**：本机（Windows）全绿，CI（Linux）四个测试连挂。
- **根因**：`.gitignore` 无锚定 `data/` 规则误伤 `src/ac-bench/data/`（bfcl 样例
  ENOENT）；另有三处「Linux 分支的命令字符串从未在本机跑过」的平台分支。
- **教训（CHANGELOG 原话）**：涉平台分支的测试用例，本地需显式过一遍非常规分支。
- **修复**：de67b33a（CI Linux 门禁四连修）。

### 2.2 CI 慢机资源挤压（v0.8.8 / v0.8.9——测试超时假阴性）
- **现象**：全量测试在 CI 撑爆 15s 缺省超时；本地单跑 629ms、全量 550ms、乱序皆过。
- **根因**：CI 全量并发下慢机 import 面挤压（单用例 43s）——非逻辑问题。
- **修复**：217fe91e（双维隔离用例显式放宽超时 60s）。
- **教训**：资源敏感用例的超时预算要按 CI 慢机口径定，不按本地快机。

### 2.3 发布形态只在上传后暴露（v0.8.11——run_code bundle 回归）
- **现象**：桌面/发布形态（dist bundle）下程序化模式 run_code 全挂，报
  「worker 引导文件缺失」。与代码本身无关——是 1391f7a1 重写时误删 bundle 候选。
- **根因**：bundle 形态的引导链只有发布装配才会走到；本地 dev 检出永远测不到。
- **修复**：v0.8.12（候选链补回 bundle 候选 + 回归锁用例——esbuild 自包含产物作夹具）。
- **教训**：「dev 能跑」≠「bundle 能跑」。发布形态差异面要有本地可跑的等价测试。

### 2.4 依赖卫生门收紧的阵痛（v0.8.13——R4 + electron-builder 崩溃）
- **首发 ×2 连败**：
  1. `check:deps` R4 拦截（ac-conversation 无用声明）→ ca74ca91 修复；
  2. electron-builder 26 无 publish 配置时 `createUpdateInfoTasks` 空引用崩溃
     → 02a4fc70 修复。
- 第三次重跑双绿，但 0.8.13 的 dmg 上线后仍发现 macOS arm64「已损坏」问题
  （Gatekeeper/签名问题，见 0.8.14 CHANGELOG——非 CI 失败但同属发布质量问题）。

### 2.5 本地与 CI 安装面差异（v0.8.14——连续两个首发失败）
- **第一败：R4 再犯**。`check:deps` 的 R4「无用声明」扫描报
  `ac-webui-app → uplot`。本机曾有旧符号链接残留在检查时撑住了消费证据，
  CI 干净安装后暴露。（修复：0d35fb24 清冗余声明。）
- **第二败：vite 解析断链**。清掉声明后，`TokenUsage.vue` 的
  `import "uplot/dist/uplot.min.css"` 在 CI 干净安装下无法解析——跨包 bare import
  需要构建根（webui）自己的 node_modules 有真链接。（修复：8ab26d54 改 peer 供给
  模式：ac-client-ui-usage 声明 peerDependencies + devDependencies，webui 作宿主
  dependencies 供给——R4 经 peerProvisions 白名单放行，解析链有真实链接。）
- **教训**：两败同源——**本地 node_modules 的历史残留会掩盖干净安装才暴露的问题**。
  发版前本地验证必须包含「干净安装」一档（见 §4 预检清单）。

### 2.6 隐性返工（v0.8.12——首发绿但内容有问题）
- 首发 CI 双绿，但 0.8.11 的 run_code bundle 回归正是 0.8.12 修的——即 0.8.11
  发出去的版本带着已知严重缺陷；0.8.13 上线后桌面更新面又发现 electron-updater
  残留问题（feed 指向 GitHub Releases 永远拿不到新版本）。
- **教训**：CI 绿 ≠ 发布质量好。门禁覆盖不到的面（bundle 行为、更新链路）
  需要专门的对账手段（后来补的 sha256 发布闸、桌面更新桥测试就是这类）。

## 三、结构性观察

1. **失败集中在三类边界**：
   - 平台边界（Windows dev ↔ Linux/macOS CI）；
   - 形态边界（源码 dev ↔ bundle 发布）；
   - 环境边界（本地残留 node_modules ↔ CI 干净安装）。
   每类边界都缺「本地可复现的等价验证」，问题就只能在 CI 上首撞。

2. **收紧门禁的阵痛期会重犯同类错**：R4 扫描 2026-11 上 AST 化后，0.8.13 与
   0.8.14 连续两版在依赖卫生上翻车。门禁越严，越要在本地预检里同题跑一遍。

3. **tag 重打是当前的重跑机制**：修复提交后 `git tag -f vX && git push -f`。
   副作用是旧 run 留 failure 记录、npm 可能已发出旧版本（publish.yml 与
   desktop.yml 同 tag 并行触发，一个绿一个红时状态不一致）。

4. **网络是流程外的独立风险**：v0.8.14 发版过程中，本机到 GitHub 的 TLS 连接
   被间歇 reset（代理切换/网络波动），tag 与修复提交的推送多次靠重试窗口完成。
   推送不可达 ≠ 工作没做完——把推送与状态查询分开管理（后台重试循环）是有效的。

## 四、发版预检清单（本次整理的行动项）

发 tag 前在本地依次跑（全部绿再推）：

```powershell
pnpm install --no-frozen-lockfile   # 或 --frozen-lockfile 验证 lockfile 一致性
pnpm check:deps                     # R1-R7 依赖卫生（R4 是惯犯）
pnpm typecheck                      # tsc --noEmit
pnpm test:unit                      # 全量单元测试
pnpm build:frontend                 # webui 构建（跨包解析在此暴露）
pnpm build:bundle                   # 发布 bundle（bundle 形态差异面）
```

干净安装档（怀疑本地残留掩盖问题时）：删除 `node_modules` 与各包
`node_modules` 后从 lockfile 全新安装再跑上列检查。

tag 后观察：publish 与 desktop 双工作流齐绿才对外宣布版本；desktop 的
manifest 收尾 job（sha256 校验 + gen-manifest）过了才算下载面就绪。

## 五、后续可做（未立项，仅记录）

- **预检脚本化**：把 §4 清单做成 `pnpm release:preflight`，一条命令跑全档；
- **CI 预演工作流**：push 到 main 即跑与 tag 同路径的构建（不含上传/发布），
  让「CI 才能暴露的问题」在合并前暴露；
- **tag 重打状态对齐**：desktop.yml 的 manifest job 已有 sha256 闸，可再加
  「同 tag 重跑时先清服务器旧目录」防新旧产物混排。

