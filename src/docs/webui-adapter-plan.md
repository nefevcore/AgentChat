# WebUI 适配器方案（src UI 保真迁移 → 契约换血）

> 2026-08-23 定稿，同日执行完毕。状态：**✅ 全部完成——阶段〇归档
> （archive/webui-native-m16）+ 阶段一保真迁移（同源拷贝 + 防腐层 +
> 三层锁测试）+ 阶段二六梯契约换血收口（usage/system → settings →
> agents/groups 名册 → singles/workspaces/文件面 → 运行跟踪 →
> 聊天面）；适配器 A 已整体退役，UI 直连 preview 协议（wire 传输 +
> src/api/ 模块 + stores 换血），"适配器先行"纪律解除**。
> 细目见 preview/README.md "WebUI 接线与前端本体" 节 + 执行期作战
> 笔记 docs/webui-adapter-notes.md。
> 决策背景：用户裁定目标为"完全复现 src 轨道界面，无缝切换"。五轮复刻
> 对齐（M17 五块、M18 七轮）实证该路线在"像素级复现"目标下不收敛——
> 每修一层又浮出一层细节差。本方案改为**同源路线**：UI 代码即 src 代码，
> 差异只存在于数据面，用防腐层（Anti-Corruption Layer / Ports &
> Adapters）把它隔离成一次性债务。

---

## 〇、架构模型（为什么这样做）

```
前端UI  ──依赖──▶  UI契约（Port，UI 拥有）      "我需要什么"
                        ▲
                   适配器（Adapter）             唯一的新代码；运行时插件
                        │ 实现                    （无人依赖它，可整体替换）
                        ▼
                   后端契约                      preview RPC + 事件目录
                        │ 暴露                    （wire/rpc-methods.ts +
                        ▼                         wire/events.ts，已稳定）
                   后端能力                      ac-* 各域服务
```

四条纪律（本方案的存在理由）：

1. **契约归属消费方**：UI 契约由 UI 侧拥有演进；变更流向恒为
   "UI 需求变 → 契约升版 → 适配器跟实现"，后端变更止步于适配器。
2. **没人依赖适配器**：适配器是可替换插件；下次后端架构再变 = 重写
   适配器一个部件，UI 与契约不动。**债务从复利变线性。**
3. **锁测试是牙齿**：没有测试的契约只是文档。端口缝（adapter.test）
   与后端缝（e2e）各锁一道，双方不得单方面漂移。
4. **适配器先行**：后端新能力一律先在适配器暴露成契约词汇、UI 后接；
   禁止 UI 直接伸手到 preview 协议。

两条边界（防止过度期待）：

- **可解的**是表示层耦合（键格式、事件词汇、载荷形状）——契约层挡住。
- **不可解的**是域概念耦合（UI 理解"会话/轮/工具调用"）——那是产品
  本身。若域模型将来变化，任何架构都保不了 UI 不动；这是本质复杂度
  而非技术债。

---

## 一、现状盘点（开工前的事实基线）

### 已有资产（全部复用，零浪费）

| 资产 | 位置 | 状态 |
|---|---|---|
| src UI 本体 | `src/ui/webui`（234+ 文件） | 稳定，本次移植源 |
| 后端 RPC/事件面 | ac-web-api 60+ 方法、31 事件 | 就绪且比 M7 时更全 |
| singles/workspaces/upload 后端面 | ac-singles 域 + M17-E HTTP 面 | **M18-G 刚补齐**——恰是 src UI 要消费的 |
| 迁移数据 | `preview/data/`（15 Agent/21 会话/1 群/7 singles/8768 用量行） | 已验证，全程可用真数据测试 |
| 迁移脚本 | `preview/scripts/migrate-workspace.ts` | 幂等，可重跑 |
| 原生前端 | `preview/webui`（M16-M18-G 原生面） | 归档留用（见阶段〇） |

### 关键考古结论（M7 适配层已不可恢复）

- `preview/` 整目录 **从未提交 git**（untracked）；M16 删壳时 M7 适配器
  随壳丢弃。**适配层必须新写**，但蓝图完整保留：`docs/m7-webui-plan.md`
  （§二映射表 + §四 src 参考索引）+ README M7 节（dialogId 合成表）。
- src UI 的数据消费点**高度集中**（缝窄）：`core/events/contract.ts`
  （全部 26 型 WS 词汇）+ `core/api/endpoints/*`（~13 文件 REST 形状）+
  `services/websocket.ts` + `utils/feed.ts`（dialogId 键魔法）——
  组件层 200+ 文件不碰协议。**手术面 ≈ 16 个文件。**

### 数据面账本（适配器的真实工作量分级）

| 级别 | 面 |
|---|---|
| **直接映射**（后端已有） | agents 名册+头像、group 全套、session 历史分页+删消息+归档、usage 四维、timer、config 白名单、plugin 安装、system 版本/重启、upload、**singles 全套**、**workspaces CRUD+文件树**、interaction、runs 基础、tool-defs/system-prompt 调试预览 |
| **后端补最小推导**（可选增强） | runs 时间窗（消息 timestamp 分桶）、弦图 by_pair（退化 user↔agent + 群自环）、coverage |
| **真无面**（垫空/禁用态，标注显式降级） | 版本更新检查、插件市场、plugin schemas（可走 config 面近似）、pools CRUD（同左）、browse folder（已用手动路径降级） |

---

## 二、阶段〇：归档原生面

- `git checkout -b archive/webui-native-m16`（或等价分支）保存当前
  `preview/webui`——它是 **preview 词汇的参考实现**（conversations
  reducer、wire 流程、singles/矩阵/弦图组件），阶段二逐模块换端口时的
  对照物与搬运源。**不删。**
- 主分支移除 `preview/webui` 内容（保留 `dist` 托管路径占位）。
- README 记录 M16"原生重写"决策正式回滚：其动机（架构纯度）让位于
  "完全复现"目标——这是目标函数变化后的决策更新，非对错翻案。

## 三、阶段一：保真迁移（先锁住正确性）

**完成标准不是"页面能用"，是"契约被锁测试钉死"**——能用是状态，
锁住才是资产（M7 教训：能跑的适配层没被当资产，删壳时无声消失）。

### 步骤

1. **拷贝**：`src/ui/webui/src` 全量 → `preview/webui/`（组件/stores/
   composables/assets/ui 库零改动；vite/tsconfig/package.json 对齐
   preview 构建环境）。
2. **提取 UI 契约（Port A）**：`core/events/contract.ts` +
   `core/api/endpoints/*` + `utils/feed.ts` 键语义，加版本头
   (`@contract v1`)，标记为 OWNED 资产——改动必须过锁测试。
3. **新写适配器 A**（src 词汇 → preview 协议）：
   - WS 翻译：出站 `chat.send` 等 → preview RPC（rpc/call）；入站
     preview 事件帧 → 合成 src `chat.*` 契约 + dialogId 映射
     （直答=`chat~user~aid`、群=`group~gid~aid`、委托=`chat~agent~x`；
     映射表见 README M7 节，M16 适配层删除前的最后记载）。
   - REST 映射：`core/api/endpoints/*` 的 ~20 端点 → preview RPC 或
     已有 HTTP 端点；无面端点返回显式降级形状（入口在、点了空、
     tooltip 说明），不垫假数据。
   - 传输外壳：复用 preview 的连接管理（`wire/connection.ts` 的身份
     守卫/重连退避/积压队列/半开看门狗——src WebSocketClient 同款，
     可直接搬）。
4. **锁测试**：重建 `webui/tests/adapter.test.ts`（帧合成表：preview
   帧 → src 词汇逐型断言）+ 恢复 `ac-app/tests/webui-e2e.test.ts`
   契约面（真 WS 客户端全链路）。
5. **验收**：`pnpm preview:boot` + 浏览器对 `preview/data/` 真实数据
   全页面过一遍（名册/1v1/群/singles/工作区树/设置/用量/矩阵/上传/
   交互应答）；锁测试全绿；typecheck/build 通过。

### 已知硬伤顺手修（复刻路线考古所得，适配层必须正确处理）

- src `AgentInfo` 名字字段 → preview `AgentConfig.description` 的映射
  （原生面 `nameOf()` 曾因此全 UI 显示 id）。
- 头像 `.svg` 扩展（ac-agent-store 已支持，验证端到端）。
- timer entry 的 src（config 内嵌）→ preview（agentStore entry）形态差。

## 四、阶段二：契约换血（双轨过渡）

**核心修正：不是"更新契约再改适配器"，而是逐模块换端口。**
（原案"先改契约使适配器归零"会双向锁死：契约一动适配器必须同步改，
而旧 UI 还靠它活着——中间态断裂。）

```
阶段二开窗：  UI(src词汇) ─端口A─▶ 适配器A ──▶ preview
增量迁移：    UI新模块 ─端口B(preview词汇)────▶ preview   ← 直连，零适配
              UI旧模块 ─端口A─▶ 适配器A ──▶ preview      ← A/B 并存
每迁一块：    全页面回归（真数据）+ 锁测试
收口：        最后一块旧模块迁完 → 删适配器A + 端口A → 适配器整体退役
```

- **端口 B = preview 协议本身**（wire/rpc-methods.ts + wire/events.ts
  已是稳定契约），不新造适配器——这是适配器派的终局红利：债在收口日
  被**整体删除**，而非改写。
- **迁移序（按风险从低到高）**：settings/usage/system（纯拉取型）→
  agents/groups 名册 → singles/workspaces → 运行跟踪 → **聊天面最后**
  （feed turn 装配 / chat 发送中断仪式 / 竞态守卫最重，参考实现 =
  归档的原生面 reducer）。
- **视觉安全声明（替代"布局风格不变"的承诺）**：视觉签名不变
  （tokens/布局骨架/ui 组件库原样）；**行为等价以锁测试为准**——
  stores 含业务逻辑，换数据模型后渲染产物不可能逐像素等价，验收
  标准是测试绿 + 全页面人工回归清单，不是像素 diff。
- 收口后 README 记录"适配器退役"，并解除"适配器先行"纪律（不再有
  适配器，UI 直接消费 preview 契约）。

## 五、阶段三（可选、远期，不在本方案范围）

src UI 停更或被替换后，评估**生成派契约**（后端发 schema → 前端
codegen，零手写契约）。适用前提：届时若做全新 UI（可从 schema 长出），
迁移到该模式后手写契约与适配器均退役。**本方案期内不启动。**

## 六、验证与纪律（全阶段通用）

```bash
pnpm --filter ac-webui-app typecheck   # 前端 vue-tsc
pnpm preview:typecheck                 # 轨道 tsc
pnpm preview:test                      # 含 adapter.test + webui-e2e
pnpm --filter ac-webui-app build       # dist 由 ac-web-server 托管
pnpm preview:boot                      # 3830 + 真数据手测
```

- 组合根不动（阶段一/二零后端新行；可选增强项才动 ac-web-api）。
- 每阶段收尾更新 `preview/README.md` 与本文档状态行。
- 风险预案：src UI 若在迁移期上游演进 → 重拷文件级操作（便宜）；
  适配器按契约 diff 补翻译，锁测试保证不静默漂移。

---

## 附：决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 同源路线替代复刻路线 | 复刻在"像素级复现"目标下不收敛（五轮实证） |
| D2 | 适配器派而非生成派 | UI 不能重写（保真是目标），契约是既定事实只能适配 |
| D3 | 阶段一完成标准 = 锁测试而非"能用" | M7 教训：能跑的适配层没被当资产，无声消失 |
| D4 | 阶段二双轨过渡而非先改契约 | 避免双向锁死与中间态断裂；债被删除而非改写 |
| D5 | 视觉承诺 = 签名不变 + 行为以测试为准 | stores 含业务逻辑，逐像素等价承诺必破产 |
| D6 | 原生面归档不删 | 阶段二对照物 + preview 词汇参考实现 |
