// ============================================================
// plugin-dev.ts —— 壳内插件开发行（cr-553；cr-866 语义化中断退役——
// 三件套改 execute 内即时执行，restart_shell/restart_host 同款即时
// 副作用形态）
//
// 与主线 ac-plugin-registry 的形态差（工具面随 owning 域住壳进程——
// R0a 判据 1「工具只能由壳内 agent-loop 执行」）：
//   · register_plugin = 会话级试跑：execute 内直接装载进本壳（cr-543
//     assemblePluginRow 同款 dynamic import），重启即失天然成立——零
//     宿主参与；装载完成后工具即在本壳注册面（run_code 投影面每调用
//     现算，程序化模式子调用即刻可测）；
//   · install_plugin = 定型驻留：安装态唯一写者 = 宿主 plugin-registry
//     行（A7/A10 装载 = 授权动作）→ execute 内直接发 plugin.request 服务帧
//     （plugin-request schema），回执 + 续跑信经邮局回投本会话；本壳
//     内同时立即会话级装载（保住「装好即可测试」主线产品语义）；
//   · unregister_plugin = 两档：缺省立即卸本壳会话级装载（dispose）；
//     removeFromLibrary=true = 永久卸载（服务帧请求宿主 uninstall + 本壳
//     dispose 同步）。
// 历史语义（cr-553 引入，cr-866 退役）：M11 语义化中断上报意图 →
// loop/after-run 收束检测 → 装载/回执/续跑——该通道在程序化模式断链
// （run_code 桥接不透传 interrupt）且即时执行更直白，随
// ToolResult.interrupt 通道整体移除。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, Plugin, Fiber } from '@agentchat/cordis';
import type { ToolResult, ToolCall } from 'ac-tools';
import { loadManifestFromDir } from 'ac-plugin-core';
import { pluginRowsOf } from 'ac-rowset-core';
import { guardPluginModule } from './plugin-guard.ts';

/** 行配置（boot 装配参数） */
export interface PluginDevRowOptions {
  dataRoot: string;
  agentId: string;
  /** 邮局 ipc 地址（install/uninstall 永久档的 plugin.request 服务帧面；缺席 = CLI 直连形态，永久档 fail-loud） */
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

/** 惰性邮局连接（cr-1175 批 2 迁服务帧 plugin.request——request 档要回执） */
interface Uplink {
  call(payload: unknown): Promise<unknown>;
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

      /** 惰性邮局连接（install/uninstall 永久档——plugin.request 服务帧） */
      const connect = async (): Promise<Uplink> => {
        if (uplink === null) {
          const { IpcClient } = await import('ac-envelope-core');
          const client = new IpcClient();
          await client.connect(options.postOfficeAddress!);
          uplink = {
            call: (p) => client.serviceCall('plugin.request', p),
            close: () => client.close(),
          };
        }
        return uplink;
      };

      /** 已装载插件的注册面工具名（回执提示用——注册面 fiber 归属反查，
       * cr-1022 批2：manifest rows 的 tools 声明词汇退役） */
      const sessionTools = (name: string): string[] => {
        const rec = sessionLoads.get(name);
        if (rec === undefined) return [];
        return ctx.tools.listWithOwner()
          .filter((t) => t.owner === rec.fiber.name)
          .map((t) => t.name);
      };

      /** 会话级装载（register/install 共用执行体——boot assemblePluginRow 同款链） */
      const loadSession = async (dir: string): Promise<{ name: string; tools: string[] }> => {
        const manifest = loadManifestFromDir(dir);
        if (sessionLoads.has(manifest.name)) {
          return { name: manifest.name, tools: sessionTools(manifest.name) }; // 已在装载中（迭代语义 = 先 unregister 再 register）
        }
        const entry = typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : 'index.ts';
        const entryUrl = pathToFileURL(path.join(dir, entry)).href + '?t=' + Date.now();
        const mod = (options.importModule !== undefined
          ? await options.importModule(entryUrl)
          : await import(entryUrl)) as unknown as Plugin;
        // 装载边界硬闸（cr-1074 批3）：官方命名空间冒充即拒载 + fiber 名
        // 钉死 manifest.name（owner 归属确定——权限门信任面稳定键）
        const fiber = ctx.plugin(guardPluginModule(mod, manifest.name));
        await fiber;
        // 行集条目现算（行 id 供指纹与目录合并口径——pluginRowsOf 单源）
        const rows = pluginRowsOf(manifest.name, dir, JSON.parse(
          fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'),
        ) as unknown).rows;
        sessionLoads.set(manifest.name, { name: manifest.name, fiber, rows });
        return { name: manifest.name, tools: sessionTools(manifest.name) };
      };

      /** 会话级卸载（dispose——cordis 自动回收行注册面） */
      const unloadSession = (name: string): boolean => {
        const rec = sessionLoads.get(name);
        if (rec === undefined) return false;
        sessionLoads.delete(name);
        void rec.fiber.dispose();
        return true;
      };

      // ---- 三工具（execute 内即时执行——restart_shell/restart_host 同款形态） ----
      const registerTool = {
        name: 'register_plugin',
        description:
          '临时试跑本地插件目录（会话级装载：装载进本壳进程，重启即失，不写入安装态）。目录须含 manifest.json，缺省约定在你的沙箱 files/<你的id>/ 下。调用后立即装载完成——插件工具即刻进入本壳注册面，程序化模式经 run_code 子调用立即可测；直调面由行集点名决定。与 install_plugin 的分工：本工具用于开发迭代中临时试跑；要永久驻留（重启后仍生效、所有新壳 boot 时装载）必须用 install_plugin。迭代方式 = 改代码 → unregister_plugin 后再 register_plugin（无热重载，同名已装载时再 register 幂等返回，不会重载新代码）。',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '插件目录（相对你的沙箱 files/<你的id>/ 或绝对路径，须含 manifest.json）' },
          },
          required: ['dir'],
        },
        execute: async (args: { dir: string }): Promise<ToolResult> => {
          const dir = resolveDir(args.dir);
          try {
            const { name, tools } = await loadSession(dir);
            return {
              ok: true,
              output: {
                loaded: name,
                tools,
                note: tools.length > 0
                  ? '已装载进本壳（会话级，重启即失）——工具 ' + tools.join('、') + ' 已在注册面，可直接调用测试。测试通过后用 install_plugin 永久安装（记得 bump version）。'
                  : '已装载（会话级，重启即失）——manifest rows 未声明工具或工具未进本壳注册面。测试通过后用 install_plugin 永久安装（记得 bump version）。',
              },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: '装载失败（' + dir + '）：' + msg + '。下一步：修复错误后重新 register_plugin；定型驻留改用 install_plugin 并 bump version。' };
          }
        },
      };

      const installTool = {
        name: 'install_plugin',
        description:
          '永久安装本地插件目录（安装态写入宿主插件库 + 插件行集条目物化，新壳 boot 时自动装载；本壳内立即会话级装载可直接测试）。目录须含 manifest.json，缺省约定在你的沙箱 files/<你的id>/ 下。迭代重装语义：同 name+version 且内容一致 → 幂等返回已装状态；有任何改动必须先 bump manifest.json 的 version 再重装。安装请求即时投递宿主受理，回执与续跑信稍后进入本会话（可直接开始测试本壳装载）。',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '插件目录（相对你的沙箱 files/<你的id>/ 或绝对路径，须含 manifest.json）' },
          },
          required: ['dir'],
        },
        execute: async (args: { dir: string }, call: ToolCall): Promise<ToolResult> => {
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: '本壳无邮局连接（CLI 直连形态）——永久安装需宿主在线。临时试跑请用 register_plugin。' };
          }
          const dir = resolveDir(args.dir);
          const conversationId = call.conversationId ?? options.agentId;
          try {
            const link = await connect();
            await link.call({ action: 'install', dir: args.dir, conversationId, agent: options.agentId });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: '安装请求投递失败（邮局不可达）：' + msg + '。宿主恢复后重试，或先用 register_plugin 会话级试跑。' };
          }
          // 宿主受理链的回执 + 续跑信经邮局回投本壳（conversation 驱动下一轮）。
          // 本壳立即会话级装载（装好即可测试——主线产品语义）：装载失败不阻断
          // 安装态写入（宿主半边独立完成），宿主回执携带修复方向。
          try {
            const { name, tools } = await loadSession(dir);
            return {
              ok: true,
              output: {
                installed: name,
                tools,
                note: '安装请求已投递宿主受理（回执与续跑信稍后进入本会话）。本壳已立即装载——工具 ' + tools.join('、') + ' 可直接调用测试。',
              },
            };
          } catch {
            return {
              ok: true,
              output: { note: '安装请求已投递宿主受理（回执与续跑信稍后进入本会话）。本壳立即装载失败——按宿主回执的修复方向处理后可 register_plugin 试跑。' },
            };
          }
        },
      };

      const unregisterTool = {
        name: 'unregister_plugin',
        description:
          '卸载插件：缺省立即卸载本壳会话级装载（插件工具即刻从注册面消失，安装态保留）；removeFromLibrary=true = 永久卸载（移出宿主插件库，旧版本目录进 .backup，本壳装载同步卸载，回执稍后进入本会话）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '插件名（manifest.name）' },
            removeFromLibrary: { type: 'boolean', description: '是否同时移出插件库 = 永久卸载进 .backup（缺省 false 仅卸载本壳会话级装载）' },
          },
          required: ['name'],
        },
        execute: async (args: { name: string; removeFromLibrary?: boolean }, call: ToolCall): Promise<ToolResult> => {
          if (args.removeFromLibrary !== true) {
            const done = unloadSession(args.name);
            return {
              ok: true,
              output: {
                unloaded: done,
                note: done
                  ? '已卸载 ' + args.name + ' 的会话级装载（安装态保留；要彻底移除用 removeFromLibrary: true）。'
                  : args.name + ' 未在会话级装载中（无需卸载）。安装态卸载请用 removeFromLibrary: true。',
              },
            };
          }
          if (options.postOfficeAddress === undefined) {
            return { ok: false, error: '本壳无邮局连接（CLI 直连形态）——永久卸载需宿主在线。' };
          }
          unloadSession(args.name); // 本壳装载同步卸（宿主行集条目剔除后新壳不再装载）
          const conversationId = call.conversationId ?? options.agentId;
          try {
            const link = await connect();
            await link.call({ action: 'uninstall', name: args.name, conversationId, agent: options.agentId });
            return {
              ok: true,
              output: { uninstalled: args.name, note: '永久卸载请求已投递宿主受理（回执与续跑信稍后进入本会话）；本壳装载已同步卸载。' },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, error: '永久卸载投递失败（邮局不可达）：' + msg + '。宿主恢复后重试。' };
          }
        },
      };

      ctx.tools.register(registerTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(installTool as Parameters<typeof ctx.tools.register>[0]);
      ctx.tools.register(unregisterTool as Parameters<typeof ctx.tools.register>[0]);
    },
  };
}
