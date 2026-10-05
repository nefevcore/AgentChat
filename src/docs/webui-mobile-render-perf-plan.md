# 移动端渲染性能优化方案（webui-mobile-render-perf-plan）

> 立项 cr-258（2026-10-05）。前置事实：cr-257 已解决链路带宽瓶颈（HTTP 桥双向 gzip，
> 大载荷提速 40-50%）——本文件处理剩下的另一半：**WebView 本地渲染**。基线数据来自
> 2026-10-05 真机实测（Redmi K20 / Android 11 / WebView Chrome 122 / debug 构建，CDP 直采）。

## 一、实测基线（问题画像）

| 指标 | 数值 | 采集方式 |
|---|---|---|
| 空闲帧率 | **23 fps**（rAF 间隔 33/50/67ms 抖动） | rAF 时间戳序列 4s 直方图 |
| 空闲长任务 | 每秒 ~10 次 52ms long task | PerformanceObserver(longtask) 12s |
| CPU 占用 | 主线程 (program) 100%（无 JS 热点） | CDP Profiler 5ms 采样 4s |
| DOM 规模 | 1925 元素（会话页空闲态） | document.querySelectorAll('*') |
| DOM 变更率 | **0 次 / 10s**（空闲） | MutationObserver 10s 窗口 |
| 活跃动画 | 2 个（StarAvatar run-spin 主+副流光） | document.getAnimations() |
| JS 堆 | 18MB | performance.memory |

关键判定链：

1. DOM 变更率 0 → **空闲期烧 CPU 的不是 Vue 响应式**（无数据更新驱动重渲染）；
2. CPU profile 全在 (program)（原生帧）→ **不是 JS 执行**；
3. 暂停全部 CSS 动画（animation-play-state:paused 注入）fps 不变 → 主嫌疑不是动画本身，
   但注意该实验的局限：paused 仍保留合成层与 paint 产物，**不能排除动画引发的层合成/光栅开销**；
4. fps 23 + 52ms 周期长任务 + rAF 33/50/67 交替 → 符合**软件光栅化掉帧**特征（老 WebView 对
   SVG transform / 渐变 / 合成层动画的加速不完整，光栅在主线程外仍占满 GPU 光栅线程，
   帧节拍被打到 20-30fps）。

结论：**根因是老 WebView 的渲染管线对当前页面形态（多层 SVG 动画 + 长文档流 + 多合成层）
加速不足**，属设备级天花板与页面形态的叠加。优化方向不是「修 bug」而是「降形态复杂度」。

## 二、优化项清单（按 ROI 排序）

### P1 StarAvatar 运行光环降级（小改，预计收益大）

现状：`webui-kit/src/star/StarAvatar.vue` —— running 时 SVG `<g class="run-spin">` 主流光
（渐变 stroke 弧 + transform 旋转）+ 副流光双弧错相旋转。**运动是功能语义**（Agent 正在回复），
不可静止降级——但形态可以降：

- **方案 A（推荐）：窄屏降级为呼吸透明度动画**——opacity 动画不触发 transform/光栅，
  合成开销低一个量级；「流转」语义弱化为「呼吸」，功能可辨。
  落点：`@media (max-width: 768px)` 分支换 keyframes（opacity 0.4↔1），复用现有 reduce 豁免结构。
- 方案 B（保守）：副流光（run-spin--sub）窄屏裁撤——双弧变单弧，光栅面积减半。可与 A 叠加。
- 验证口径：真机 CDP 采 rAF 直方图，目标窄屏空闲 fps ≥ 50。

### P2 消息列表真虚拟滚动（中改，收益中大）

现状：`TranscriptList.vue` 已有**首载分帧 + renderFrom 窗口化**（首帧只挂最近条目，16ms 分帧
补挂），但**上翻即全量补挂**（scheduleRefill 分帧补完所有历史）——大会话（千余条）上翻浏览时
DOM 全量在文档流，长文档流本身就是老 WebView 的重负载（即使无变更，层合成/滚动手感都受累）。

- 方案：引入真窗口化（虚拟滚动）。候选形态：
  - 自研轻量版：容器固定高度 + translateY 偏移 + 窗口内 v-for（与现有 useChatShell 的
    滚动对账机制兼容性需验证——程序滚动对账 expectedScrollTop 逻辑与虚拟列表的
    scroll anchoring 可能互相干扰，这是最大风险点）；
  - 成熟库（vue-virtual-scroller / virtua）：代价是引入依赖 + 与 useChatShell 的
    「贴底吸收流式增量」「上翻即停跟随」语义对接成本。
  - **裁决建议**：先 A/B 自研窗口化原型（不上依赖），流式跟随语义全保留；原型不过关再议库。
- 约束：TurnDisplayItem 高度不定（消息/工具卡/代码块异构）→ 定高虚拟化不可行，
  须动态测量窗口化；reveal() 定位（cr-230）需适配「窗口外条目先挂载再定位」的现有语义。

### P3 流式 delta 渲染合帧（小改，收益中）

现状：核心端 LlmDeltaBatcher 30ms 微批（cr-85）已把帧量降一个数量级；但前端消费侧
（chatStore → items → Vue patch）每批帧直接驱动响应式更新，**60Hz 渲染节拍内多批到达
时同一消息组件可能一帧内 patch 多次**。

- 方案：前端消费侧加 rAF 合帧——delta 批帧先入缓冲，rAF 帧首统一 flush 一次进响应式。
  落点：chatStore 的 delta 处理入口（或在 useTurnDisplayItems 与 store 之间加一层）。
- 风险：多 16ms 级延迟（不可感知）；注意与 streamingTailLen 滚动跟随信号的时序一致性。

### P4 减层与合成面收敛（小改，收益小但稳）

- 滚动按钮 Tooltip、Transition 包裹的浮动元素等常驻层——排查 will-change/transform
  滥用造成的层爆炸（CDP Layers 面板真机侧不可直接用，可经 Tracing 走查）；
- `backdrop-filter` 类效果（若有）在老 WebView 极贵，窄屏裁撤。

### P5 首屏包体与解析（中改，收益中；2026-10-05 修订）

实测修正（真机 CDP resource entries，105 个 JS 中 104 个缓存命中、仅 5KB 走网络）：

- katex 255KB + texmath 262KB **已是条件加载**（useMarkdown MATH_HINT 正则命中公式才
  ensureKatex——纯文本会话零成本），原计划的「改条件加载」已完成，无剩余动作；
- ConversationView 352KB / markdown 102KB / vue 115KB 走 immutable 长缓存，**日常打开
  App 零流量**（cr-101 变体B + cr-82 重协商生效）；
- 剩余痛点只在**webui 更新后的首次打开**：内容哈希文件名全变 → ~350KB(gzip) 一次性过
  公网管道——cr-257 桥 gzip 已把该场景从 ~1MB 明文压到 ~350KB，仍有秒级等待；且该场景
  曾出现 65s 离群值（三层压缩链嫌疑，见遗留项）；
- 可选优化：更新后的首次拉取做**关键路径优先**（index/main/vue 先行，会话页 chunk
  延后预取），或 webui 发版时附带「预热清单」让 App 空闲时后台预拉。

## 三、分期与验证阶梯

| 期 | 内容 | 验证 |
|---|---|---|
 Phase① | P1 光环降级 + P3 delta 合帧（都是小改） | 真机 CDP：空闲 fps ≥ 50；流式期 fps 与丢帧数 |
 Phase② | P2 虚拟滚动原型（自研 A/B） | 大会话（≥500 条）上翻/跳转/流式跟随三场景回归 + 手感走查 |
 Phase③ | P4 减层 + P5 条件加载 | Tracing 走查层计数；冷启首开耗时 |

每期收尾过验证阶梯（webui 改动：typecheck + webui:typecheck + 定向 lint；行为改动加包内测试）。

## 四、不做的事

- **不改 useChatShell 的滚动手感语义**（缓动/对账/贴底吸收是打磨过的产品语义，虚拟滚动
  必须适配它们，而不是反过来）；
- **不为老设备做双端分叉的组件实现**——一律媒体查询/运行时探测的渐进降级，桌面端零改动；
- 不追新 WebView 专属 API（View Transitions 等）——K20 的 Chrome 122 不支持则不采用。

## 五、测量工具沉淀（复用口径）

本文件全部基线来自 CDP 直采（debug 构建 WebView 已开 setWebContentsDebuggingEnabled），
探针脚本沉淀于 `.dsh/tmp/wv-*.mjs`（帧率直方图 / longtask / CPU profile / RPC 计时），
分期实施时同口径复测对比。正式化时可将探针收编为 `scripts/perf-probe/`。