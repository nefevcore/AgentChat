// ============================================================
// ac-permission-gate/src/index.ts —— 权限门行（cr-1066 批1）
//
// 模型（permission-gate-plan §一/§二——工具作者只做风险分析，环境做
// 风险处理）：
//   def.risk?(args) → 建议 allow/ask/deny（throw 按 ask——fail-closed）；
//   无 risk 声明 + needPermission:true ≡ risk:() => 'ask'（存量等价映射）；
//   两者皆无 = 门视野外（零开销放行）。
// 决策序（门行为规格；cr-1079 语义修订）：
//   0 无 needPermission 且无 risk          → 放行
//   1 不可信（origin 简化版：注册方非 packages/ 官方行）→ 建议 := 'ask'（覆盖）
//   2 建议 := def.risk?.(args) ?? (needPermission ? 'ask' : 'allow')
//   3 建议 deny → 拒绝（工具自愿收紧，不可被设置放宽）
//   4 建议 allow → 直通（可信工具已自审——信任的收益）
//   5 建议 ask：s := 设置链（会话键 approval〔仅有人会话〕> Agent settings
//     ['permission-gate'].onAsk > 全局 config settings['permission-gate'].onAsk
//     > 缺省 'deny'）；s=allow 放行
//     （含无人桶——运营者预授权，问不出的问题不问）/ s=deny 拒绝 / s=ask →
//     无人桶（humanPresentOf === false：self/agent~agent/g~member——问人
//     不可达）→ 拒（D7 fail-closed：仅压「要弹卡」这一格，预授权层照常
//     生效）；有人桶 → durableInteraction approval 审批卡 → 批准
//     （call/run）→ 变异 call.access='full-access' 放行 / 拒绝·超时 → 拒。
// run 级批准缓存：Map<runId>，loop/before-run 清（批准一次本轮 ask 全免）。
// 门缺席 = dontAsk 化（D9：沙箱边界轴照拦——workdir/命令级扫描在工具内）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { LoopRunCall, LoopRunResult } from 'ac-agent-loop';
import type { ToolCall, ToolExecution, ToolResult } from 'ac-tools';
import { humanPresentOf } from 'ac-agents';
import type { JsonValue, DurableInteraction } from 'ac-durable-interaction';
import { approvalNeedText } from './notice.ts';

export const name = 'ac-permission-gate';

export interface PermissionGateRowOptions {
  /**
   * 插件 risk 授予查询（cr-1074 批3 D11 精确信任面）：fiber 名 → 该插件
   * 的 permissions 授予快照是否含 'risk'。缺席 = 查无（fail-closed——
   * 所有非官方 fiber 恒不可信）。boot 装配时注入（读 plugins/registry.json
   * ——宿主安装器代写的授予快照单源）。
   */
  riskGranted?: (owner: string) => boolean;
}

export const inject = ['tools', 'durableInteraction'];

/** 设置链合成值 */
type OnAsk = 'allow' | 'ask' | 'deny';

/** approval answer 形状（前端 ApprovalBar respondApproval 同源：approved=true 携 scope） */
interface ApprovalAnswer { approved?: boolean; scope?: unknown }

export function apply(ctx: Context, options: PermissionGateRowOptions = {}) {
  // run 级批准缓存：runId → true（scope=run 的批准面；before-run 清）
  const runApproved = new Set<string>();

  /**
   * 信任面（cr-1074 批3 精确版）：官方行（ac- 前缀 fiber 名 / 官方特例
   * 行）随宿主分发恒可信；动态插件查 D11 risk 授予（permissions 第 6 词
   * 人审快照）。装载边界硬闸（plugin-guard）已保证动态插件 fiber 名钉死
   * manifest.name 且不落官方命名空间——前缀臂不会再被冒名顶替（cr-1073
   * 伪造向量闭合）。
   */
  function trusted(owner: string): boolean {
    if (owner.startsWith('ac-') || owner === 'shell-tools-gate') return true;
    return options.riskGranted?.(owner) === true;
  }

  /**
   * 设置链合成（cr-1079 四层）：会话键 approval（convSettings——第一层）>
   * Agent settings ['permission-gate'].onAsk（settingsOf——第二层）>
   * 全局 config settings['permission-gate'].onAsk（第三层）> 缺省 'deny'
   * （第四层，fail-closed）。非法值回落下一层（回落方向——非 'allow'）。
   */
  function onAskOf(call: ToolCall): OnAsk {
    // 第一层：会话键（壳 = ConvSettingsShim 只读 get；宿主 = 服务 get）。
    // 仅有人会话参与本层（用户裁决 cr-1079 续记）：会话键是用户偏好载体，
    // 无人桶（self / agent~agent / g~member）无用户偏好可言——若读入残留
    // 值会压住 Agent 设置，造成「Agent 配置未生效」的诡异排查面。
    if (call.conversationId !== undefined && humanPresentOf(call.conversationId)) {
      const convSettings = ctx.get('convSettings', false) as
        | { get(id: string): Record<string, string> }
        | undefined;
      const v = convSettings?.get(String(call.conversationId)).approval;
      if (v === 'allow' || v === 'ask' || v === 'deny') return v;
    }
    // 第二层：Agent settings（settingsOf 两层合成——同 shell-tools limitsOf 形态）
    const agents = ctx.get('agents', false) as
      | { settingsOf?(id: string | undefined, name?: string): unknown }
      | undefined;
    const s = agents?.settingsOf?.(call.agentId, 'permission-gate') as
      | { onAsk?: unknown }
      | undefined;
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      const v = s.onAsk;
      if (v === 'allow' || v === 'ask' || v === 'deny') return v;
    }
    // 第三层：全局层（config.json settings['permission-gate'].onAsk——与
    // Agent 侧 agents/<id>/permission-gate.json 同键命名空间）。此处直读
    // 而非依赖 settingsOf：壳侧 AgentsShim.settingsOf 只取 Agent 差异层
    // （全局层传 undefined），全局设置必须门行自读才在两侧同效。
    const config = ctx.get('config', false) as
      | { get<T>(key: string, fallback?: T): T | undefined }
      | undefined;
    const g = config?.get<unknown>('settings.permission-gate.onAsk');
    if (g === 'allow' || g === 'ask' || g === 'deny') return g;
    return 'deny'; // 第四层：缺省恒拒（fail-closed）
  }

  /**
   * 有人桶审批：open approval 卡（payload {tool,args,need} 对齐前端
   * pickApproval）→ 事件 + 轮询双保险等待 → 批准（scope run 记缓存）/
   * 拒绝 / 超时 / closed。close 兜底：等待面退出即终态（answered 未消费
   * 不会复活——防壳重启后悬置审批卡）。
   */
  async function askApproval(call: ToolCall): Promise<{ approved: boolean; scopeRun: boolean }> {
    const key = call.conversationId ?? call.agentId ?? 'gate';
    const record = ctx.durableInteraction.open({
      key,
      kind: 'approval',
      payload: {
        tool: call.name,
        args: call.args ?? {},
        need: approvalNeedText(call.name, call.args ?? {}),
      } as unknown as JsonValue,
      ...(call.toolCallId !== undefined ? { correlationId: call.toolCallId } : {}),
      ...(call.agentId !== undefined ? { owner: call.agentId } : {}),
    });
    return await new Promise((resolve) => {
      let done = false;
      const finish = (v: { approved: boolean; scopeRun: boolean }) => {
        if (done) return;
        done = true;
        clearInterval(poller);
        dispose();
        resolve(v);
      };
      const observe = (r: DurableInteraction) => {
        if (r.id !== record.id) return;
        if (r.state === 'answered') {
          const a = r.answer as ApprovalAnswer | null;
          finish({ approved: a?.approved === true, scopeRun: a?.scope === 'run' });
        } else if (r.state === 'closed') {
          finish({ approved: false, scopeRun: false });
        }
      };
      const dispose = () => {
        disposeReplied();
        disposeClosed();
      };
      const disposeReplied = ctx.on('durable-interaction/replied', observe);
      const disposeClosed = ctx.on('durable-interaction/closed', observe);
      const poller = setInterval(() => {
        const cur = ctx.durableInteraction.get(record.id);
        if (cur && cur.state !== 'pending') observe(cur);
      }, 150);
    });
  }

  // run 级批准缓存清理：run 边界（gate 同款形态——loop/before-run）
  ctx.on('loop/before-run', (_call: LoopRunCall, next: () => Promise<LoopRunResult>) => {
    runApproved.clear();
    return next();
  }, { description: '权限门：run 边界批准缓存失效' });

  // ---- 主门（tool/before-execute——决策序 0-5） ----
  ctx.on('tool/before-execute', async (execution: ToolExecution, next: () => Promise<ToolResult>) => {
    const def = ctx.tools.getWithOwner(execution.call.name);
    // 决策序 0：门视野外（无声明面）——零开销放行
    if (def === undefined || (def.risk === undefined && def.needPermission !== true)) {
      return next();
    }
    const call = execution.call;
    // 决策序 1：信任面——不可信建议恒 'ask'（覆盖，risk 恒 allow 不直通）
    const advice: 'allow' | 'ask' | 'deny' = trusted(def.owner)
      ? rawAdvice(def, call.args ?? {})
      : 'ask';
    // 决策序 3/4：deny 直效（不可放宽）；allow 直通
    if (advice === 'deny') {
      return veto(execution, `工具 ${call.name} 自评风险 deny（自愿收紧）——权限门拒绝（设置不可放宽）。`);
    }
    if (advice === 'allow') return next();
    // 决策序 5：ask → 设置链先行（预授权在无人桶同样生效——问不出的
    // 问题不问，cr-1079 D7 修订：无人桶只压「要弹卡」这一格）
    const s = onAskOf(call);
    if (s === 'allow') return next();
    if (s === 'deny') {
      return veto(execution, `工具 ${call.name} 的审批请求已被设置拒绝（approval=deny——会话键/Agent 设置/全局 config 任一层或缺省）。`);
    }
    // s = ask 且无人桶（humanPresentOf：self/agent~agent/g~member——问人
    // 不可达）→ fail-closed 拒（判定在设置链后——预授权层 allow 已放行）
    if (!humanPresentOf(call.conversationId)) {
      return veto(execution, `工具 ${call.name} 需要审批，但本会话无人类参与（机制/Agent 间/群会话）——问人不可达且未预授权（会话键/Agent 设置/全局 config 任一层设 allow 可解锁），fail-closed 拒绝。`);
    }
    // s = ask：run 级缓存 → 审批卡
    // 缓存命中 = 本 run 已获人批准——与首批准同权注入 full-access（否则
    // base 档免问调用仍撞工具内沙箱墙，比首调用更严，违背「本轮全免」）
    if (call.runId !== undefined && runApproved.has(call.runId)) {
      execution.call = { ...call, access: 'full-access' };
      return next();
    }
    const decision = await askApproval(call);
    if (!decision.approved) {
      return veto(execution, `工具 ${call.name} 的审批请求未获批准（拒绝/超时）——操作已取消。`);
    }
    if (decision.scopeRun && call.runId !== undefined) runApproved.add(call.runId);
    // 人审批 = 单次按 full 执行（ToolCall.access 合法来源第 3 处——契约
    // 承诺的审批注入位；否则 base 档审批通过后仍撞工具内沙箱墙）
    execution.call = { ...call, access: 'full-access' };
    return next();
  }, { description: '权限门：needPermission/risk 决策序（ask 上抛设置链+审批卡）' });

  /** 建议求值：risk 函数 throw 按 ask（fail-closed）；缺函数按等价映射 */
  function rawAdvice(def: { risk?: (args: Record<string, unknown>) => 'allow' | 'ask' | 'deny'; needPermission?: boolean }, args: Record<string, unknown>): 'allow' | 'ask' | 'deny' {
    if (def.risk === undefined) return def.needPermission === true ? 'ask' : 'allow';
    try {
      return def.risk(args);
    } catch {
      return 'ask'; // risk throw → ask（fail-closed 方向）
    }
  }
}

/** veto（不调 next——工具不执行） */
function veto(execution: ToolExecution, reason: string): ToolResult {
  return { ok: false, error: reason, output: { tool: execution.call.name, vetoedBy: 'permission-gate' } };
}
