// ============================================================
// ac-webui-extensions —— 第三方 UI 插件声明词汇表（纯数据面）
//
// M30 D7：服务端 slot 注册表（ctx.uiExtensions——BUILTIN_SLOTS 白名单
// + declareSlot/register/install 超时守护）退役。退役依据：生产链路
// 零消费——第三方 UI 实际链路 = manifest.ui → ctx.webui.addEntry
// （ac-plugin-registry）→ 浏览器 /api/ui/extensions → bridge install
// （浏览器侧自持 15s 超时，webui core/extensions/host.ts）→ SlotRegistry
// 注册 + assertDeclarableSlot 账本派生校验（ac-client-ui-settings/
// client/slotCatalog.ts——公开子集由浏览器声明账本 public 标记派生）。
//
// 本包现职责 = LEGACY_SLOT_CATALOG 永久别名归一目录的单源锚点：
//   · ac-plugin-core 安装期词汇校验（UI_SLOT_IDS 镜像，同源约定）；
//   · 浏览器校验面 re-export（ac-client-ui-settings/client/slotCatalog.ts
//     维持旧路径）。
// 纯库形态：零 cordis 依赖、不进 cordis.yml/TREE、无 agentchat
// plugin 标记（插件目录内置组判据——纯库不加，fail-closed）。
// ============================================================

// 纯数据面出口（M28 P3/T9 自 ac-client-ui-settings 迁入；M30 D7 起
// 为本包唯一职责）
export * from './slotCatalog.ts';
