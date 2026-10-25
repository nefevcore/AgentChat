# 交接：◐c 旧树退役批已收口（2026-10-25 深夜，cr-696）

> 下会话入口。先加载 agentchat-dev 技能，读 plan.md §5 尾部（cr-696 行）与本文。
> 上游：handoff-2026-10-25-b3.md（B3 完成态）+ design-plugin-client-channel.md §6/§7（迁出耦合 + 侦察数据）。

## 0. 一句话现状

**◐c 旧树退役批全落地入库并 push**（cr-696，commit f2d89cd2）：ac-client-ui-* 31 包迁 preview/packages + A 类 24 包删除（ac-webui/-extensions 改判 B 保留）+ ac-app/cordis.yml/dev:legacy 退役 + 类型墓碑 ac-retired-types + 涟漪全清。主线 typecheck 0 / test:unit 1750 全绿 / check:deps 绿（白名单 0）+ preview:typecheck 0 / preview:test 1131 全绿。旧树回滚线自此**物理消失**——新唯一事实源 = preview 树。

## 1. 本批结构（四子批）

1. **迁移**：31 包 git mv（保包名零改动）；preview tsconfig include 补 client 面（.vue shim 锚随迁）；catalog webui 行同步。
2. **退役**：A 类 24 包 + ac-app + cordis.yml + 脚本三件；根 devDeps 清 24。
3. **类型墓碑**：`src/ac-retired-types`（Context 7 服务占位 + Events 7 词——方法面按 B 类消费收敛，签名从 git HEAD 抽取）；B 类 type-only 清理 11 处。
4. **涟漪**：旧树语义测试 22 文件退役；死声明 110 条清；dep-cycles.yml 清零；md-preview-copy.js 迁 preview public（构建漏拷真缺陷）；三测试扫描根随迁。

## 2. 关键裁决（本批内定）

- **ac-webui / ac-webui-extensions 改判 B 类保留**：preview 24 个行测试深路径消费 `ac-webui/src/service.ts`（WebUiService boot graph 服务）+ slotCatalog 单源锚（ac-plugin-core 与 ui-settings 消费）——R6.1「改判」条款适用。
- **src/webui（ac-webui-app）暂留**：发布链（build:frontend → build:bundle → publish/desktop/mobile 三 CI）仍依赖它——**发布链换轨 = 发版前独立批**（preview 宿主 bundle 化 + CI 三 workflow 改造 + README 深层叙事重写）。不推 tag 不红。
- **B4 宿主树 ui 组终态清空**（design-plugin-client-channel §3）：前置已满足（通道包物理迁出完成），下会话可做——宿主 cordis 装配面撤 25 ui 行（46 行口径→21 cordis 行）。

## 3. 现场环境

- pnpm install 已重链全 workspace（44.6s 绿）；preview/apps/ui/dist 需重建（迁移后首次构建）。
- %TEMP% EPERM 与壳崩溃坑位同 handoff-2026-10-25-b3.md §3。

## 4. 下一步（优先序）

1. **B4 宿主树 ui 组终态清空**（前置已满足：31 包已在 preview/packages）；
2. 发布链换轨批（发版前必做：build:bundle 改 preview 宿主 + 三 CI workflow + src/webui 退役 + README 重写）；
3. 主题选择 UI 消费面（待产品诉求）；
4. 双占名回收（ac-credentials/ac-conversation/ac-webui-app——占位者 ac-credentials 已删但 preview 同名包改名属后续）。
