# run_code 遗留问题与优化立项（2026-11-19 下午会话沉淀）

> 数据源：DX 五连修 + lib 增强的完整开发会话，含一次 **worker 改坏致
> run_code 全通道死锁事故**。本文只记遗留问题与立项方向；已落地内容见
> CHANGELOG 与 run-code-usage-profile-2026-09-20.md 上午批次。

## 事故实录（背景——两个立项的由来）

**形态**：多步 edit 改 worker.ts（lib 改名 libMethods 落盘 → 插入 Proxy 回填
绑定未落盘）。中间态落盘后 main() 里 fn(tools, lib, log) 引用悬空——每个新
worker 引导即 ReferenceError，连空程序 1; 都炸。run_code 是工具面单点，坏态
无自愈路径；subagent/job/ask_questions 逃生通道全部经 run_code，同死。最终
靠用户手工贴入恢复。

**连锁因素**（环环相扣，缺一不断链）：
1. 负载文件多步 edit 非事务——改名与回填分离的瞬间即坏窗口，被打断即坏态落盘；
2. 09-20 ②号擦除 DX 税变形再实证——嵌套模板串在传输层被转义破坏，edit 反复
   失败迫使走「代码进 lib 函数体」旁路；
3. 旁路程序自身踩 lib 闭包陷阱（引用外围 lib）——恰是当时正在修的坑；
4. 逃生通道（subagent/job 等）全依赖 run_code 本身——单点无备份。

## 立项 ①：run_code worker 防退化护栏（高优先——结构性根治）——已落地

> 2026-12 落地形态（与原方向差异）：回退目标不依赖 bundle（dev 检出不存在）——
> 改为「上次成功引导的源码快照」（内存 + tmpdir 磁盘，裁决：tmpdir 可接受）。
> 候选链 dev → 内存快照 → 磁盘快照（git HEAD 第四候选裁剪——非所有用户装
> git）；协议版本闸（PROTOCOL_VERSION ready 互认）防陈旧快照错配；spawn
> 前 strip 快速路径 + 10s 握手超时。降级 run 附 output.bootDegraded 告警。
> 详见 CHANGELOG Unreleased。dev 坏态全链路（真改坏 worker.ts）留手动验收。

- **缺口**：dev 形态 worker.ts 引导失败（ReferenceError/语法错）无回退路径，
  全工具面停摆。worker.mjs 双入口机制现成（dev .ts / bundle .mjs），缺的是
  回退逻辑。
- **方向**：主线程 spawn dev worker 后设引导握手超时/首个错误即回退上一份
  已知良好 bundle（构建产物 + 引导探针消息）；或启动时对 worker.ts 做
  stripTypeScriptTypes 试擦除 + 语法校验，失败即用 bundle 并告警。
- **成本估计**：中（握手协议已有 ready/init 骨架可挂；bundle 时效性需约定——
  构建时快照 vs 回退时告警降级）。
- **验收形态**：手动把 worker.ts 改坏（删一行），run_code 调用自动回退
  bundle 并在结果里告警「dev worker 引导失败，已降级」，工具面不停摆。

## 立项 ②：模板串转义税（09-20 ②号复活——观察项升回该修项）——已落地（部分）

> 已落地 = 方向二（SDK 投影 DEFAULT_GUIDANCE 字符串书写纪律行）+ 方向一轻量版
> （worker 擦除失败错误附针对性修复提示 hintSyntaxRecovery），见 CHANGELOG
> Unreleased。方向三（edit 引用外部文件片段）未做，维持观察。

- **实证**：本会话三次 edit/程序失败均源于内嵌模板串/含引号文案在传输层被
  转义破坏（Expected ',', got 'ident' 形态同 09-20）；被迫绕路的代价最终
  放大成事故。
- **方向**（任一即可，按成本选）：
  - worker 预检错误带行列 + 最近 token + 修复建议（09-20 原案）；
  - SDK 投影加显式转义示例（DEFAULT_GUIDANCE 一行）；
  - 或 edit 工具的 old_string/new_string 允许引用「外部文件片段」路径，复杂
    编辑不走 run_code 程序体内嵌字符串。

## 立项 ③：会话级 lib 注册表自愈（低优先——半结构化观察）——已落地

> 2026-12 落地（方向一 + 方向二变体）：resolve() 无参 = 纯静态清单摘要
> （裁决：未指定执行函数则不予任何执行——不再全量求值）；坏条目不跳过
> 而包裹——调用期 ReferenceError 改写为可读错误（指向 define 闭包陷阱）+
> libRotted 随 done 带出，主线程从会话级 store 剔除（被吞掉的异常也剔）。
> 详见 CHANGELOG Unreleased。

- **形态**：坏条目（引用外围变量的闭包形态）落库后，resolve() 无参全量求值
  会炸；且坏条目会随会话级 store 跨 run 持续注入。本次事故的误诊阶段曾把
  它当成 run_code 死锁根因（后证明是 worker 损坏，但该形态独立存在）。
- **方向**：resolve() 无参调用改为惰性求值（返回源码摘要而非全量求值对象）；
  或注入时跳过 define 期告警过的条目并标注 skipped（调用点给出可读错误）。

## 已落地对照（详表见 CHANGELOG 2026-11-19 两条）

| 项 | 状态 |
|---|---|
| Ⓑ edit 行尾归一化 + CR 双写治理 + 失配诊断 | 已落地（edit-core +6 测试） |
| Ⓐ pwsh/bash failure_class 分类 | 已落地（shell +3 测试） |
| Ⓒ grep 转义建议 | 已落地（fs-search +2 测试） |
| 追记Ⓐ lib.define 非源码即时诊断 | 已落地 |
| 追记Ⓑ load_skill 注入型语义标注 | 已落地 |
| lib 直调糖（Proxy 同通道） | 已落地（+3 测试） |
| lib 自由变量告警（词法扫描，告警不拒绝） | 已落地（+2 测试） |
| 立项 ②（方向一轻量版 + 方向二） | 已落地（projection 9/9 + run-code 集成 50/50） |
| 立项 ①（引导链 + 快照回退 + 协议版本闸） | 已落地（run-code 集成 62/62） |
| 立项 ③（无参清单纯静态 + 坏条目 rot 剔除） | 已落地（含既有断言语义更新） |
