// ============================================================
// plugin-dev.ts —— 壳内插件开发行（cr-553；8.9 前置余件②：creator
// 模板的插件装卸三件套 preview 形态）
//
// 与主线 ac-plugin-registry 的形态差（工具面随 owning 域住壳进程——
// R0a 判据 1「工具只能由壳内 agent-loop 执行」）：
//   · register_plugin = 会话级试跑：装载 = 壳进程内 ctx.plugin（cr-543
//     assemblePluginRow 同款 dynamic import），重启即失天然成立——
//     零宿主参与（主线「宿主进程装载」形态退役）；
//   · install_plugin = 定型驻留：安装态唯一写者 = 宿主 plugin-registry
//     行（A7/A10 装载 = 授权动作）→ 工具只上报意图（M11 语义化中断），
//     收束检测后经信封请求宿主受理（plugin-request schema），回执 +
//     续跑信驱动下一轮（主线 receiptAndRetrigger 语义）；本壳内另立即
//     会话级装载（保住「装好即可测试」主线产品语义）；
//   · unregister_plugin = 两档：缺省仅卸本壳会话级装载（dispose）；
//     removeFromLibrary=true = 永久卸载（信封请求宿主 uninstall + 本壳
//     dispose 同步）。
// 一轮 run 只收束于首个 toolInterrupt（一轮一件——L7 主线同义）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, Plugin, Fiber } from '@agentchat/cordis';
import type { ToolResult } from 'ac-tools';
import type { LoopRunRequest, LoopRunResult } from 'ac-agent-loop';
import { loadManifestFromDir } from 'ac-plugin-core';
import { issueRequestId, makePluginRequestEnvelope } from 'ac-envelope-core';
import type { Envelope } from 'ac-envelope-core';
import { pluginRowsOf } from 'ac-rowset-core';

/** 行配置（boot 装配参数） */
export interface PluginDevRowOptions {
  dataRoot: string;
  agentId: string;
  /** 邮局 ipc 地址（install/uninstall 永久档的信封面；缺席 = CLI 直连形态，永久档 fail-loud） */
  postOfficeAddress?: string;
  /** 入口装载面（真跑 = file URL 动态 import；测试替身注入——主线 registry importModule 同形） */
  importModule?: (url: string) => Promise<unknown>;
}

/** 会话级装载记录（重启即失——内存态） */
interface SessionLoad {
  name: string;
  fiber: Fiber;
  rows: ReturnType<typeof pluginRowsOf>['rows'];
}

/** 惰性邮局连接（postReply 同款形态——conversation.outbound 先例） */
interface Uplink {
  send(env: Envelope): Promise<unknown>;
  close(): void;
}

export function makePluginDevRow(options: PluginDevRowOptions): Plugin {
  return {
    name: 'shell-plugin-dev-row',
    inject: ['tools'],
    apply(ctx: Context) {
      const dataRoot = path.resolve(options.dataRoot);
      const sessionLoads = new Map<string, SessionLoad>();
      let uplink: Uplink | null = null;
      // 常驻连接随 fiber dispose 收割（conversation.outbound 同款）
      ctx.fiber.effect(() => () => { uplink?.close(); }, 'plugin-dev.uplink');

      /** 相对目录按调用方沙箱（files/<agentId>/）基准解析——主线 resolveDir 同语义 */
      const resolveDir = (dir: string): string =>
        path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(dataRoot, 'files', options.agentId, dir);

      /** 惰性邮局连接（install/uninstall 永久档） */
      const connect = async (): Promise<Uplink> => {
        if (uplink === null) {
          const { IpcClient } = await import('ac-post-office');
          const client = new IpcClient();
          await client.connect(options.postOfficeAddress!);
          uplink = {
            send: (e) => client.send(e),
            close: () => client.close(),
          };
        }
        return uplink;
      };

      /** 会话级装载（register 半边的执行体——boot assemblePluginRow 同款链） */
      const loadSession = async (dir: string): Promise<{ name: string }> => {
        const manifest = loadManifestFromDir(dir);
        if (sessionLoads.has(manifest.name)) {
          return { name: manifest.name }; // 已在装载中（迭代语义 = 先 unregister 再 register）
        }
        const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : 'index.ts';
        const entryUrl = pathToFileURL(path.join(dir, entry)).href + '?t=' + Date.now();
        const mod = (options.importModule !== undefined
          ? await options.importModule(entryUrl)
          : await import(entryUrl)) as unknown as Plugin;
        const fiber = ctx.plugin(mod);
        await fiber;
        // 行集条目现算（行 id 供指纹与目录合并口径——pluginRowsOf 单源）
        const rows = pluginRowsOf(manifest.name, dir, JSON.parse(
          fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'),
        ) as unknown).rows;
        sessionLoads.set(manifest.name, { name: manifest.name, fiber, rows });
        return { name: manifest.name };
      };

      /** 会话级卸载（dispose——cordis 自动回收行注册面） */
      const unloadSession = (name: string): boolean => {
        const rec = sessionLoads.get(name);
        if (rec === undefined) return false;
        sessionLoads.delete(name);
        void rec.fiber.dispose();
        return true;
      };

      // ---- 三工具（管理面：上报意图不执行——M11 语义化中断通道） ----
      const registerTool = {
        name: 'register_plugin',
        description:
          '临时试跑本地插件目录（会话级装载：TS 入口直接装载进本壳进程，重启即失；不写入安装态）。目录须含 manifest.json，缺省约定在你的沙箱 files/<你的id>/ 下。与 install_plugin 的分工：本工具用于开发迭代中临时试跑；要永久驻留（重启后仍生效、所有新壳 boot 时装载）必须用 install_plugin。迭代方式 = 改代码 → 再次 register_plugin（无热重载）。每轮对话只处理首个装载类中断（一轮只能装一件）。装载在本轮对话收束后执行，结果以回执进入当前会话并自动触发你的下一轮。',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '插件目录（相对你的沙箱 files/<你的id>/ 或绝对路径，须含 manifest.json）' },
          },
          required: ['dir'],
        },
        execute: async (args: { dir: string }): Promise<ToolResult> => ({
          ok: true,
          output: { dir: args.dir, note: '装载将在本轮对话收束后执行（会话级，重启即失；永久安装请用 install_plugin）' },
          interrupt: { type: 'register-plugin', dir: args.dir },
        }),
      };

      const installTool = {
        name: 'install_plugin',
        description:
          '永久安装本地插件目录（免审：安装态写入宿主插件库 + 插件行集条目物化，新壳 boot 时自动装载；本壳内立即会话级装载可直接测试）。目录须含 manifest.json，缺省约定在你的沙箱 files/<你的id>/ 下。迭代重装语义：同 name+version 且内容一致 → 幂等返回已装状态；有任何改动必须先 bump manifest.json 的 version 再重装。每轮对话只处理首个装载类中断（一轮只能装一件）。上报安装意图，本轮结束后执行，结果以回执进入当前会话并自动触发你的下一轮（可直接开始测试）。',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '插件目录（相对你的沙箱 files/<你的id>/ 或绝对路径，须含 manifest.json）' },
          },
          required: ['dir'],
        },
        execute: async (args: { dir: string }): Promise<ToolResult> => ({
          ok: true,
          output: { dir: args.dir, note: '安装将在本轮对话收束后执行（永久；临时试跑请用 register_plugin）' },
          interrupt: { type: 'install-plugin', dir: args.dir },
        }),
      };

      const unregisterTool = {
        name: 'unregister_plugin',
        description:
          '卸载插件（会话级装载直接卸载；removeFromLibrary=true 时 = 永久卸载：移出宿主插件库，旧版本目录进 .backup）。上报卸载意图，本轮结束后执行，结果以回执进入当前会话。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '插件名（manifest.name）' },
            removeFromLibrary: { type: 'boolean', description: '是否同时移出插件库 = 永久卸载进 .backup（缺省 false 仅卸载本壳会话级装载）' },
          },
          required: ['name'],
        },
        execute: async (args: { name: string; removeFromLibrary?: boolean }): Promise<ToolResult> =>
          args.removeFromLibrary === true
            ? {
              ok: true,
              output: { name: args.name, note: '永久卸载将在本轮对话收束后执行' },
              interrupt: { type: 'unregister-plugin', name: args.name, removeFromLibrary: true },
            }
            : {
              ok: true,
              output: { name: args.name, note: '卸载将在本轮对话收束后执行' },
              interrupt: { type: 'unregister-plugin', name: args.name },
            },
      };

      ctx.tools.register(registerTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(installTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(unregisterTool as Parameters<typeof ctx.tools.register>[0]);

      // ---- 收束检测（宿主半边的壳内形态——loop/after-run 消费 toolInterrupt） ----
      // 回执写账本（主线 writeReceipt 同义：owning 落盘口追加 assistant 行）。
      // 邮局缺席（CLI 直连）时 install/uninstall 永久档 fail-loud 回执，register 照常。
      ctx.on('loop/after-run', (request: Pick<LoopRunRequest, 'agent' | 'conversationId'>, result: LoopRunResult) => {
        if (result.finish !== 'interrupted') return;
        const ti = result.interruptReason?.toolInterrupt;
        if (ti === undefined) return;
        if (ti.type === 'register-plugin' && typeof ti.dir === 'string') {
          void consumeRegister(request, ti.dir);
        } else if (ti.type === 'install-plugin' && typeof ti.dir === 'string') {
          void consumeInstall(request, ti.dir);
        } else if (ti.type === 'unregister-plugin' && typeof ti.name === 'string') {
          void consumeUnregister(request, ti.name, ti.removeFromLibrary === true);
        }
      }, { description: '插件装卸意图收束检测 → 壳内执行（register）/ 信封请求宿主（install/uninstall 永久档）' });

      /** 回执落账（ledger 服务软取——行集无 ledger 行时降级日志） */
      const writeReceipt = async (request: Pick<LoopRunRequest, 'agent' | 'conversationId'>, text: string): Promise<void> => {
        const conversationId = request.conversationId;
        if (conversationId === undefined || request.agent === undefined) {
          ctx.logger.info('[plugin-dev] 回执（无会话上下文，仅日志）：' + text);
          return;
        }
        const ledger = ctx.get('ledger', false) as
          | { deliverRow(uuid: string, participants: string[], kind: string, row: Record<string, unknown>): Promise<unknown> }
          | undefined;
        if (ledger === undefined) {
          ctx.logger.info('[plugin-dev] ledger 服务缺席，回执仅日志：' + text);
          return;
        }
        try {
          await ledger.deliverRow(conversationId, [request.agent, 'host'], 'agent', {
            role: 'agent',
            content: text,
            agent_id: request.agent,
            requestId: 'receipt-' + issueRequestId(),
            uuid: conversationId,
          });
        } catch (err: unknown) {
          ctx.logger.warn('[plugin-dev] 回执落账失败：' + String(err));
        }
      };

      /** register 消费：壳内会话级装载 */
      const consumeRegister = async (request: Pick<LoopRunRequest, 'agent' | 'conversationId'>, dirInput: string): Promise<void> => {
        const dir = resolveDir(dirInput);
        try {
          const { name } = await loadSession(dir);
          await writeReceipt(request,
            '[plugin] register_plugin 已装载 ' + name + '（会话级，重启即失）。工具已注册进本壳，可直接调用测试。测试通过后用 install_plugin 永久安装（记得 bump version）。当前会话请继续测试。');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await writeReceipt(request,
            '[plugin] register_plugin 装载失败（' + dir + '）：' + msg + '。下一步：修复错误后重新 register_plugin；定型驻留改用 install_plugin 并 bump version。');
        }
      };

      /** install 消费：信封请求宿主受理 + 本壳内立即会话级装载 */
      const consumeInstall = async (request: Pick<LoopRunRequest, 'agent' | 'conversationId'>, dirInput: string): Promise<void> => {
        const dir = resolveDir(dirInput);
        if (options.postOfficeAddress === undefined) {
          await writeReceipt(request, '[plugin] install_plugin 失败：本壳无邮局连接（CLI 直连形态）——永久安装需宿主在线。临时试跑请用 register_plugin。');
          return;
        }
        const conversationId = request.conversationId ?? options.agentId;
        try {
          const link = await connect();
          await link.send(makePluginRequestEnvelope({
            uuid: conversationId,
            requestId: 'plugin-' + issueRequestId(),
            sender: options.agentId,
            payload: { action: 'install', dir: dirInput, conversationId },
          }));
          // 宿主受理链的回执 + 续跑信经邮局回投本壳（conversation 驱动下一轮）。
          // 本壳立即会话级装载（装好即可测试——主线产品语义）：装载失败不阻断
          // 安装态写入（宿主半边独立完成），回执由宿主续跑信携带修复方向。
          try {
            await loadSession(dir);
          } catch {
            /* 宿主回执线已覆盖失败文案 */
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await writeReceipt(request, '[plugin] install_plugin 投递失败（邮局不可达）：' + msg + '。宿主恢复后重试，或先用 register_plugin 会话级试跑。');
        }
      };

      /** unregister 消费：会话级 dispose ∨ 永久卸载信封 */
      const consumeUnregister = async (request: Pick<LoopRunRequest, 'agent' | 'conversationId'>, name: string, permanent: boolean): Promise<void> => {
        if (!permanent) {
          const done = unloadSession(name);
          await writeReceipt(request, done
            ? '[plugin] 已卸载 ' + name + ' 的会话级装载（安装态保留；要彻底移除用 removeFromLibrary: true）。当前会话请继续。'
            : '[plugin] ' + name + ' 未在会话级装载中（无需卸载）。安装态卸载请用 removeFromLibrary: true。');
          return;
        }
        if (options.postOfficeAddress === undefined) {
          await writeReceipt(request, '[plugin] 永久卸载失败：本壳无邮局连接（CLI 直连形态）——永久卸载需宿主在线。');
          return;
        }
        unloadSession(name); // 本壳装载同步卸（宿主行集条目剔除后新壳不再装载）
        const conversationId = request.conversationId ?? options.agentId;
        try {
          const link = await connect();
          await link.send(makePluginRequestEnvelope({
            uuid: conversationId,
            requestId: 'plugin-' + issueRequestId(),
            sender: options.agentId,
            payload: { action: 'uninstall', name, conversationId },
          }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await writeReceipt(request, '[plugin] 永久卸载投递失败（邮局不可达）：' + msg + '。宿主恢复后重试。');
        }
      };
    },
  };
}
