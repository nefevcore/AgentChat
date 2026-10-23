// ============================================================
// restart.ts —— 安全重启行（cr-629）：restart_shell / restart_host 两工具
//
// 背景：Agent 自杀（杀宿主/杀壳）后即使被 supervisor/壳侧复活拉起，
// 会话也不续跑——在途信封已被 run 消费（不在 inbox）、机器队列在内存，
// 重启即蒸发。安全重启 = 把「自杀」变成可续跑的原语：
//   · restart_shell：中止在途 run（收束 interrupted 落 journal）→ 在途
//     信封回队 inbox durable（conversation 服务 restart 面）→ 本壳以
//     重启码 42 优雅退出 → 宿主 respawn（warden 42 = 有意重启，不计
//     崩溃熔断）→ 新壳 boot 恢复面（recoverPendingInbox）重投续跑。
//   · restart_host：信封请求宿主 graceful 重启（exit 42，拉起恒归活壳
//     —— D5 边 2 裁决，supervisor 仅快路兜底）——本壳与在途
//     run 不受影响（LLM 直连 provider），终稿回信经 postReply 断链重试
//     在宿主复活后送达；宿主侧 supervised 写停机戳防壳复活双宿主竞态。
// ============================================================
import type { Context, Plugin } from '@agentchat/cordis';
import type { ToolResult, ToolCall } from 'ac-tools';
import { issueRequestId, makeEnvelope, type Envelope } from 'ac-envelope-core';

/** 行配置（boot 装配参数） */
export interface RestartRowOptions {
  dataRoot: string;
  agentId: string;
  /** 邮局 ipc 地址（restart_host 的信封面；缺席 = CLI 直连形态 fail-loud） */
  postOfficeAddress?: string;
}

/** conversation 服务的安全重启面（preview ConversationService 结构子集） */
interface RestartFace {
  requestRestart(): boolean;
}

export function makeRestartRow(options: RestartRowOptions): Plugin {
  return {
    name: 'shell-restart-row',
    inject: ['tools'],
    apply(ctx: Context) {
      const conv = (): RestartFace | undefined =>
        ctx.get('conversation', false) as unknown as RestartFace | undefined;

      /** 惰性邮局连接（plugin-dev uplink 同款形态） */
      let uplink: { send(env: Envelope): Promise<unknown>; close(): void } | null = null;
      ctx.fiber.effect(() => () => { uplink?.close(); }, 'restart.uplink');

      const restartShellTool = {
        name: 'restart_shell',
        description:
          '安全重启本 Agent 的壳进程（保会话续跑）。流程：中止当前 run（已完成步骤全部落 journal 可见）→ 未消费完的消息回队落盘 → 壳优雅退出并由宿主自动重拉 → 重启后消息自动重投、会话继续。与直接杀进程的区别：不丢消息、不触发崩溃熔断。适用：怀疑壳内状态坏、行集更新需重载、验证重启链路。注意：重启后你会收到原消息的重投，从中断处继续即可，不要再次 restart_shell。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => {
          const face = conv();
          if (face === undefined || typeof face.requestRestart !== 'function') {
            return { ok: false, error: 'conversation 服务缺席或不支持安全重启——行集不含 conversation 行' };
          }
          const inFlight = face.requestRestart();
          return {
            ok: true,
            output: {
              restarting: true,
              inFlight,
              note: inFlight
                ? '已请求重启：当前 run 将以 interrupted 收束（已执行步骤保留），在途消息已回队；壳退出后由宿主重拉，重投的原消息到达后从中断处继续。'
                : '已请求重启：壳即将优雅退出，由宿主重拉。',
            },
          };
        },
      };

      const restartHostTool = {
        name: 'restart_host',
        description:
          '安全重启宿主进程（保壳保 run）。本壳与当前 run 不受影响（模型调用不经过宿主）；宿主优雅退出（退出码 42）后由活壳探测复活（常态路；supervisor 在场时为其快路），webui 短暂断连后恢复，run 终稿会在宿主恢复后送达。适用：宿主侧状态坏、行集/插件目录变更需宿主重载。与直接杀宿主的区别：终稿不丢、webui 自动恢复、无孤儿竞态。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_args: Record<string, unknown>, call: ToolCall): Promise<ToolResult> => {
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: 'CLI 直连形态无邮局——restart_host 不可用（宿主形态壳才可）' };
          }
          if (uplink === null) {
            const { IpcClient } = await import('ac-post-office');
            const client = new IpcClient();
            await client.connect(options.postOfficeAddress);
            uplink = { send: (e) => client.send(e), close: () => client.close() };
          }
          await uplink.send(makeEnvelope({
            uuid: call.conversationId ?? options.agentId,
            requestId: 'restart-host-' + issueRequestId(),
            sender: options.agentId,
            to: 'host',
            kind: 'message',
            budget: 0,
            payload: { restartHost: true, conversationId: call.conversationId ?? null },
          }));
          return {
            ok: true,
            output: {
              restarting: true,
              note: '重启请求已送达宿主：宿主将优雅退出重启（supervisor / 活壳负责拉回）。继续当前任务即可——webui 会短暂断连，终稿在宿主恢复后送达。',
            },
          };
        },
      };

      ctx.tools.register(restartShellTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(restartHostTool as Parameters<typeof ctx.tools.register>[0]);
    },
  };
}
