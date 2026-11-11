# 三份设计文档人工验证清单（发起会话视角）

> 性质：验证清单——三条主线（system 层监护 / 盘面会合 / host-revive 恢复边）的人工走查步骤与观察点。
> 状态：现行 · 2026-11-02 活体采样成文（随 cr-857~863 设计批）· cr-1008 2026-11-11 整理批归位校正（三处失效路径按现行代码修：见一之 4、C1-2/C1-3、C4）。
> 读者：需要人工复核 supervisor / 盘面会合 / 恢复链路行为的人（改动监护或投递面后走一遍）。
> 用途：从「发起会话的用户」角度人工走一遍三条主线——supervisor system 层监护
> （supervisor-service-plan.md，已落位 docs/design/assembly/）、盘面会合 subagent 通信
> （docs/design/session/subagent-disk-rendezvous.md）、
> host-revive 恢复边（supervisor-service-plan §三）。观察点数值全部取自源码与
> 2026-11-02 活体采样（心跳 2s touch / 配方盘面 5 份 / 让路宽限 10s / 失联阈值 2 拍）。
> 前置：仓库根执行；数据根 = workspace/home。⚠️ = 杀进程步骤，杀错会连坐宿主。

## 一、验证前置

1. `pnpm dev` 在跑（3830 有监听）。若没跑：`pnpm dev`（supervised 形态）。
2. `Get-Process AgentChat` 应多个进程（supervisor + host + shells）。
3. 记宿主 pid：`Get-NetTCPConnection -LocalPort 3830 -State Listen | % { $_.OwningProcess }`。
4. 记 supervisor pid：`Get-Content .runtime/runtime.json`（仓库根 `.runtime/` 目录本体——supervisor 单写者锁与 pid 记录；数据根侧另有 `workspace/home/.runtime/system-heartbeat` 心跳面，两文件两个坐标，见 `apps/system/supervisor.mjs` 头注）。
5. webui http://localhost:3830 可开。

## 二、system 层监护（supervisor-service-plan.md）

### B1 配方盘面（§五.1）

| # | 操作 | 期望 |
|---|---|---|
| B1-1 | `Get-Content workspace/home/.runtime/recipes/host.json` | id:host / residency:resident / policy:crash / owner:supervisor / mode:authoritative，boot 指向 bin/AgentChat.exe --data-root ... --port 3830 |
| B1-2 | `Get-ChildItem workspace/home/.runtime/recipes` | host + 各活壳配方（形如 shell%3A__creator__.json） |
| B1-3 | webui 对任一 Agent 执行 restart_shell → 重看 B1-2 该壳配方 | writtenAt 更新（新代覆写） |

### B2 system 心跳面（§五.2）

| # | 操作 | 期望 |
|---|---|---|
| B2-1 | `$f = Get-Item workspace/home/.runtime/system-heartbeat; $f.LastWriteTime.ToString('HH:mm:ss.fff')` → 等 5s → 再执行 | mtime 每约 2 秒推进（2s touch 周期） |
| B2-2 | supervisor 死后（见 B4-4）再看该文件 | mtime 冻结不再更新 |

### B3 双实例仲裁（§零.5）

| # | 操作 | 期望 |
|---|---|---|
| B3-1 | 另开终端再跑 `pnpm dev` | 第二实例因锁仲裁退出，不产生双宿主（第一个 dev 环境无恙） |

### B4 监护权威与恢复执行分离（§三）

| # | 操作 | 期望 |
|---|---|---|
| B4-1 | ⚠️ 杀宿主：`Stop-Process -Id <hostPid> -Force`（3830 监听者；勿杀 supervisor） | 数秒内 3830 重新监听（新 pid）——supervisor 崩溃退避重拉 |
| B4-2 | webui 刷新 | 旧会话列表还在（盘面持久），点开可续聊 |
| B4-3 | ⚠️ 杀 supervisor：`Stop-Process -Id <supPid> -Force` | 宿主/壳无恙；心跳停更（B2-2）；system 层缺席 |
| B4-4 | B4-3 之后（supervisor 已死）再杀宿主（同 B4-1） | 活壳 host-revive 拉起宿主：失联确认（约 2 拍探测×2s）+ 宽限（system 缺席无宽限）+ 1.5s 退避基档拉起 |
| B4-5 | B4-4 期间连续观察 3830 | 邮局失联 → 宿主被拉回、webui 恢复 |
| B4-6 | `Get-Content workspace/home/.runtime/host-stopped` | 硬杀无停机戳 → 复活；Ctrl+C 优雅停机有戳 → 壳 stand down 不复活（停机语义） |
| B4-7 | 恢复现场：`pnpm dev` 重启（supervisor 回岗） | 心跳恢复 touch、配方盘面照旧 |

### B5 dev:fg 逃生门（§六.2）

1. 停掉 dev 全家（杀 supervisor 或 Ctrl+C dev 窗口）。
2. `pnpm dev:fg`（前台直跑，无 supervisor）。
3. ⚠️ 杀宿主 → 期望：活壳承担恢复（同 B4-4——system 缺席，恢复职责即时生效）。
4. 验证完 Ctrl+C 停 dev:fg（注意 Ctrl+C 是优雅停机，会写停机戳），重启 `pnpm dev`。

### B6 退出码 42 快路（§三）

webui 或壳内 restart_host → 期望：宿主 ~1.5s 回来（42=有意换代固定重拉，不计熔断），webui 短暂断连即恢复。

## 三、盘面会合（subagent-disk-rendezvous.md）

### C1 会话与信箱面

| # | 操作 | 期望 |
|---|---|---|
| C1-1 | webui 选 Agent 发消息开新会话 | 正常收答 |
| C1-2 | `Get-ChildItem workspace/home/agents/<id>/sessions | Sort-Object LastWriteTime -Desc | Select-Object -First 3` | 最新会话目录（uuid 命名）出现 |
| C1-3 | `Get-ChildItem workspace/home/agents/<id> -Recurse -Depth 2 | Select-Object FullName` | activation.lock（含 transportHint socket 地址）在场 |

### C2 subagent 投递换轨（cr-862）

| # | 操作 | 期望 |
|---|---|---|
| C2-1 | 会话中派 subagent（「派个子 Agent 调研 X」） | 子卡片出现、任务完成终稿回收 |
| C2-2 | `Get-ChildItem workspace/home/agents/<parent>/children/<child> -Recurse -Depth 2` | 子壳目录：activation.lock + sessions/<uuid>/ 盘面 |
| C2-3 | 子任务完成后看父会话 messages.jsonl 尾部 | 终稿行（subagent settlement 行）在场 |
| C2-4 | 同会话再派第二个 subagent | 投递、回执全链无报错（活体直投 / 陈锁落 inbox 双通道无感） |

### C3 子域提问双通道（cr-863）

| # | 操作 | 期望 |
|---|---|---|
| C3-1 | 让 subagent 提问（如「需要我回答什么？」） | 父收到「子 Agent 提问」卡片（notifyChildAsk 单源） |
| C3-2 | 父回答后 | 子继续执行 |
| C3-3 | ⚠️ 换代断根验证（S2）：父壳 restart_shell → 子再 ask | 新父壳仍收到提问卡（reconcile 对活锁子重建 watch） |

### C4 hostless 冒烟（§四.2）

hostless 已有 e2e 覆盖（apps/host/tests/e2e-subagent.test.ts 无宿主直 spawn）。人工冒烟可选：终端直跑壳进程（以 apps/shell/boot.ts 实际 CLI 参数为准），与另一壳互发信——观察点：无宿主也互达（锁直投/inbox 落盘）。

## 四、验证后收尾

1. 恢复常态：`pnpm dev` 在跑、3830 监听、webui 可用、心跳 touch 中。
2. 异常先记现象（截图/命令输出）再恢复现场。

---

> 本清单由 AI 依三份设计文档 + 源码 + 2026-11-02 活体采样生成；数值以源码为准；
> 清单与实际不符时以实际为准并回填文档。