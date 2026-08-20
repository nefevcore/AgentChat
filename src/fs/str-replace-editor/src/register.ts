import type { ToolsService } from '@agentchat/tools';
import { makeStrReplaceEditorTool } from './tool';

/** 注册字符串替换编辑器工具（owner = cordis 插件 name，presets 过滤依据） */
export function registerStrReplaceEditorTool(tools: ToolsService, owner: string): void {
  tools.registerFactory(owner, (config) => [makeStrReplaceEditorTool(config)]);
}
