# ISSUE-30 定时器 arm/fire 无日志：判据全靠事后反推（2026-11-23）

## 现象

timer 决定「何时投递」的过程完全不可观测。`state.json` 只落 `armedAt / firedCount /
lastFiredAt / nextAtCache` 四个结果字段，**不记录决策过程**；host 日志中 `[timers]`
关键词命中 **0 条**（同为该进程的 `[poller]`/`[groups]` 正常，是本次新出现的静默）。

后果：cr-1231 验收时，六道判据**全部是在补偿日志缺失**——每道都在从结果反推当时的决策。
反推过程中双方共犯 6 次同类错误。

## 证据：cr-1231 验收中每一步都在反推

| 判据 | 反推什么 | 若有日志 |
|---|---|---|
| 闸1 发生 | 投递到底发生了没有（比对 lf 与 firedCount） | fire 行直接可见 |
| 闸2 代际 | arm 时刻是哪个（须取 re-arm 的宿主 boot） | arm 行的 `now` 直接给出 |
| 闸3 鉴别力 | 消费判定是否触发（须自算 ngs(lf) 与 jitter 比） | arm 行的 `grid` + `consumed` |
| 闸4 判别 | 投后重算到哪（须自算两区间再比对） | arm 行的 `cand` |

## 建议日志格式（含验收中实际踩过坑的字段）

```
[timers] arm key=<owner>/<entryId> boot=<bootId> now=<ISOZ> anchor=<ISOZ>
        grid=<ISOZ> jitter=<n>min rand=<0.xxxx> cand=<ISOZ>
        lf=<ISOZ|null> armed=<ISOZ|首次武装> consumed=<bool> dev=<n>min
[timers] fire key=<owner>/<entryId> plannedAt=<ISOZ> firedAt=<ISOZ> lag=<n>ms result=<ok|fail>
```

### 每个字段为什么必须有（均有实证）

| 字段 | 缺失后果（今日实证） |
|---|---|
| `boot=<bootId>` | 踩过 pid 混淆：壳命令行含 `--host-boot <宿主boot.ts>`，按路径扫进程把 6 个壳全判成宿主；bootId 是唯一可靠代际标识 |
| `jitter` + `rand` | 只有 cand 是结果，**无法验算抽样是否真落在 [grid−J, grid+J]**，也无从复现 |
| `dev=<n>min` | 闸3 的命脉是 `|lf−grid| = 129.03 ≤ 135`，没有它必须自算 |
| `armed`（首次武装）vs `now`（本次 arm） | 我把持久化 `armedAt` 当成本次 arm 时刻，实际比这次 arm 早 23.5 小时，算出偏差 +2750min。两个都记，此混淆不可能再发生 |
| 时区（ISO 一律带 Z） | UTC/本地混淆是头号坑：`22:29:34.036Z` 被当本地时间，实际本地是次日 06:29:34 |
| `anchor=<ISOZ>` | ngs 的锚是「评估时刻当日 00:00」，跨日重置。因没记录锚而无法判断采样格是 06:00 还是 07:30 |
| `fire` 行 | 判「投了没投」还得翻 audit.jsonl；fire 行可直接看 plannedAt 与实际 firedAt 的 lag |

## 关键陷阱：两个「格」必须分别记录

cr-1231 验收中发现同一投递涉及**两个不同的格**，极易混淆（双方各踩一次）：

| 概念 | 算法 | 用途 |
|---|---|---|
| **采样格** | `ngs(arm 时刻)` | 决定本次 cand 落点 |
| **投后重算格** | `ngs(投递时刻)` | 决定下一格 / 消费判定 |

cr-1231 实例：采样格 = `ngs(11/22 23:44:09)` = **11/23 06:00**（跨日格）；
投后重算格 = `ngs(11/23 05:20:58)` = **07:30**。两者不同，只记一个必然误判。

## 影响与优先级

- **不是功能缺陷**（定时器本身工作正常），是**可观测性缺陷**
- 但让每一次 timer 故障排查都变成「从四个结果字段反推决策过程」
- 今日 cr-1231 单次验收即消耗双方各数小时，各自犯错 3 次以上

## 建议实施顺序

1. **先加 arm / fire 日志**（本 ISSUE）——改动小，收益立竿见影
2. **再做诊断 API**——若先做 API，会把上面这堆反推逻辑固化成代码，日志上线后全部作废

## 关联

- `cr/logs/timer-jitter-acceptance.md`（六道闸验收范式）——本 ISSUE 即其根因
- cr-1231（jitter 同刻度重投）——首个因此缺陷导致验收困难的实例
