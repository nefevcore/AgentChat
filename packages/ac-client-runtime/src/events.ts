// ============================================================
// ac-client-runtime/src/events.ts —— 客户端事件目录（声明合并，零运行时）
//
// 事件词汇经 cordis Events 接口声明合并（谁 emit 谁声明；事件名按
// domain/action 命名约定防撞——与服务端事件目录同机制）。D22 裁决约束的
// 是【服务与 SlotMap】的声明合并目标（ClientContext / ac-client-slots，
// 防 Context 服务属性 TS2717 撞型）；事件是 Events 接口的名字键成员，
// 与服务端词汇同接口共存且撞名即编译期显形，无同型冲突面。
//
// 标注纪律与服务端事件目录一致（M25 P1）：@mode + @scope；
// 客户端事件分发的判定式恒为 host（浏览器运行时里没有「这次分发
// 发生在哪个 Agent 的执行里」的问题）。
// ============================================================
declare module '@agentchat/cordis' {
  interface Events {
    /**
     * slot 注册表变更通知：声明/注册/撤销之后由 SlotRegistry emit。
     * @mode emit
     * @scope host
     * 载荷：变更的 slot key。渲染面按 key 做细粒度失效（D14：key 级
     * 版本计数，非全局重渲染）；订阅者 = 渲染器/Outlet/声明账本调试面。
     */
    'slots/changed'(key: string): void;
    /**
     * 活动门控 bail（M27 D18-1）：视角/面板/页签注册项的权限咨询——
     * 宿主/权限面监听并返回真值即拒绝该活动项（无监听 = 放行；
     * 「默认拒绝」形态随权限面启用：入口一行禁用一切、由权限面放行）。
     * @mode bail
     * @scope host
     * 载荷：活动注册项 def（视角 Perspective 等——框架中立 unknown）。
     */
    'activity/perspective'(item: unknown): boolean | null;
  }
}

// 本文件是模块（非脚本）——declare module 才按【声明合并】而非
// 环境模块声明（后者会遮蔽真实模块）处理
export {};
