// ============================================================
// Agents API —— GET /api/agents, GET/POST /api/agents/:agentId/config
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { AgentRegistry } from '@routing/registry';
import { AgentRouter } from '@routing/router';
import { AgentLoader } from '@discovery/agent-loader';
import { getGlobalConfig } from '@core/config';
import { deepMerge, computeDiff } from '@core/config-diff';
import { getCredential, setCredential } from '@core/credential-store';
import { Agent } from '@core/agent';
import { DeepSeekChatLLM } from '@llm/deepseek';
import { OpenAIChatLLM } from '@llm/openai';
import { LLMConfig } from '@discovery/config-types';
import { timerManager } from '@core/timer-manager';
import type { TimerEntry } from '@core/types';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { logger } from '@utils/logger';

/** Multer 配置：内存存储，最大 5MB */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 PNG、JPG、WebP、SVG 格式'));
    }
  },
});

/**
 * 根据 agent_id 查找对应的配置目录。
 * 因为目录名可能与 agent_id 不一致（如目录 "coding" 对应 agent_id "coding_agent"），
 * 需要扫描所有子目录的 config.json 来匹配。
 */
function findAgentDir(agentId: string): string | null {
  const agentsDir = getGlobalConfig().agentsDir;
  if (!fs.existsSync(agentsDir)) return null;

  // 先尝试直接匹配目录名（常见情况）
  const directPath = path.join(agentsDir, agentId);
  if (fs.existsSync(path.join(directPath, 'config.json'))) {
    return directPath;
  }

  // 扫描所有子目录，检查 config.json 中的 agent_id
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const entry of entries) {
    const configPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.agent_id === agentId) {
        return path.join(agentsDir, entry.name);
      }
    } catch {
      // 跳过无法解析的 config.json
    }
  }

  return null;
}

/**
 * 解析 Agent 头像 URL。
 * 检查 agents/<dir>/avatar.png(.jpg/.webp) 是否存在，返回 api 路径。
 */
function resolveAvatar(agentId: string, agentDir: string | null): string | null {
  if (!agentDir) return null;
  const candidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
  for (const name of candidates) {
    if (fs.existsSync(path.join(agentDir, name))) {
      return `/api/agents/${encodeURIComponent(agentId)}/avatar`;
    }
  }
  return null;
}

export function createAgentsRouter(registry: AgentRegistry, loader?: AgentLoader, agentRouter?: AgentRouter): Router {
  const router = Router();

  /** GET /api/agents —— 获取所有 Agent 基本信息列表（含虚拟 Agent 如 user） */
  router.get('/', (_req: Request, res: Response) => {
    const ids = registry.listIds();
    const agents = ids.map((id: string) => {
      const isVirtual = registry.isVirtual(id);
      const agentDir = findAgentDir(id);
      const avatar = resolveAvatar(id, agentDir);
      return {
        id,
        name: registry.getAgentName(id),
        hasConfig: agentDir !== null,
        avatar,
        virtual: isVirtual,
      };
    });

    res.json({ agents });
  });

  /** GET /api/agents/:agentId/avatar —— 获取 Agent 头像 */
  router.get('/:agentId/avatar', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const agentDir = findAgentDir(agentId);
    if (!agentDir) {
      // 也尝试 user 虚拟 Agent
      if (agentId === 'user') {
        const userDir = path.resolve(getGlobalConfig().agentsDir, 'user');
        const candidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
        for (const name of candidates) {
          const p = path.join(userDir, name);
          if (fs.existsSync(p)) {
            res.sendFile(p);
            return;
          }
        }
      }
      res.status(204).end();
      return;
    }
    const candidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
    for (const name of candidates) {
      const p = path.resolve(agentDir, name);
      if (fs.existsSync(p)) {
        res.sendFile(p);
        return;
      }
    }
    res.status(204).end();
  });

  /** POST /api/agents/:agentId/avatar —— 上传 Agent 头像 */
  router.post('/:agentId/avatar', avatarUpload.single('file'), (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: '未上传文件' });
      return;
    }

    // 统一解析 agent 目录（user 有特殊 fallback）
    const agentDir = agentId === 'user'
      ? path.resolve(getGlobalConfig().agentsDir, 'user')
      : findAgentDir(agentId);

    if (!agentDir) {
      res.status(404).json({ error: `Agent "${agentId}" 不存在` });
      return;
    }

    // 确保目录存在
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
    }

    try {
      // 删除旧头像
      const oldCandidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
      for (const name of oldCandidates) {
        const oldPath = path.join(agentDir, name);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const avatarPath = path.join(agentDir, `avatar${ext}`);
      fs.writeFileSync(avatarPath, file.buffer);
      logger.info(`[Agents API] Agent "${agentId}" 头像已更新: avatar${ext} (${file.size} 字节)`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: `保存头像失败: ${err.message}` });
    }
  });

  /** multer 错误处理：将 multer 异常转换为 JSON 响应 */
  router.use('/:agentId/avatar', (err: any, _req: Request, res: Response, _next: any) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? '文件大小不能超过 5MB'
        : (err.message || '文件上传失败');
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: '未知上传错误' });
  });

  /** DELETE /api/agents/:agentId/avatar —— 删除 Agent 头像 */
  router.delete('/:agentId/avatar', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;

    const agentDir = agentId === 'user'
      ? path.resolve(getGlobalConfig().agentsDir, 'user')
      : findAgentDir(agentId);

    if (!agentDir) {
      res.status(404).json({ error: `Agent "${agentId}" 不存在` });
      return;
    }

    try {
      const candidates = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.jpeg', 'avatar.svg'];
      let deleted = false;
      for (const name of candidates) {
        const p = path.join(agentDir, name);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          deleted = true;
          logger.info(`[Agents API] Agent "${agentId}" 头像已删除: ${name}`);
        }
      }
      res.json({ success: true, deleted });
    } catch (err: any) {
      res.status(500).json({ error: `删除头像失败: ${err.message}` });
    }
  });

  /** POST /api/agents —— 创建新 Agent */
  router.post('/', (req: Request, res: Response) => {
    const { id, name, provider, llm } = req.body as { id?: string; name?: string; provider?: string; llm?: Record<string, unknown> };
    const rawId = (id || '').trim();

    // ID 为空时自动生成 UUID
    let agentId: string;
    const isAutoGenerated = !rawId;
    if (isAutoGenerated) {
      agentId = crypto.randomUUID();
    } else {
      agentId = rawId;
    }
    const displayName = (name || agentId).trim();

    // 仅对用户手动输入的 ID 做格式校验（UUID 已保证格式合法）
    if (!isAutoGenerated) {
      if (agentId.length > 512) {
        res.status(400).json({ error: 'Agent ID 长度不能超过 512' });
        return;
      }
      if (!/^[a-zA-Z0-9\-_]+$/.test(agentId)) {
        res.status(400).json({ error: 'Agent ID 只能包含字母、数字、连字符和下划线' });
        return;
      }
      if (agentId.toLowerCase() === '__global__') {
        res.status(400).json({ error: 'Agent ID 不能为 __global__（该名称已被系统保留）' });
        return;
      }
    }

    const agentsDir = getGlobalConfig().agentsDir;
    const agentDir = path.join(agentsDir, agentId);

    // 重复校验：检查目录是否已存在
    if (fs.existsSync(agentDir)) {
      res.status(409).json({ error: `Agent "${agentId}" 已存在` });
      return;
    }

    try {
      fs.mkdirSync(agentDir, { recursive: true });

      // LLM 配置：指定 provider 或 llm 则写入配置，否则不写（运行时继承全局配置）
      let llmConfig: Record<string, unknown> | undefined;
      if (provider) {
        llmConfig = { provider, ...(llm || {}) };
        if (!llmConfig.model) {
          llmConfig.model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-4o';
        }
      } else if (llm && Object.keys(llm).length > 0) {
        // 池引用模式：llm 包含 $ref + 池字段（如 provider, model 等）
        llmConfig = { ...llm };
      }

      const config: Record<string, unknown> = {
        agent_id: agentId,
        name: displayName,
        tools: ['read', 'write', 'edit', 'bash'],
        pre_hooks: ['agent-mcp', 'agent-prompt', 'agent-memory', 'agent-session'],
        post_hooks: ['agent-memory', 'agent-session'],
      };
      if (llmConfig) config.llm = llmConfig;

      fs.writeFileSync(
        path.join(agentDir, 'config.json'),
        JSON.stringify(config, null, 2) + '\n',
        'utf-8'
      );

      fs.writeFileSync(
        path.join(agentDir, 'AGENT.md'),
        `# ${displayName}\n\n`,
        'utf-8'
      );

      logger.info(`[Agents API] 已创建 Agent "${agentId}"`);

      // 热加载新 Agent 到运行时（对齐 bootstrap 流程）
      if (loader && agentRouter) {
        try {
          const loaded = loader.loadOne(agentDir);
          const agent = new Agent(loaded.config);
          agent.setEventBus(agentRouter);

          // LLM 配置：优先 Agent 自身，回退全局
          if (!loaded.llmConfig) {
            const gCfg = getGlobalConfig() as any;
            if (gCfg.llm?.provider) {
              loaded.llmConfig = { ...gCfg.llm } as LLMConfig;
              logger.info(`[Agents API] Agent "${agentId}" 使用全局 LLM 配置: ${loaded.llmConfig.provider}`);
            }
          }
          if (!loaded.llmConfig) {
            throw new Error(`Agent "${agentId}" 缺少 llm 配置，且全局配置中也没有默认值。`);
          }
          loaded.llmConfig.api_key = getCredential(agentId, loaded.llmConfig.provider ?? '')
            || getCredential('__global__', loaded.llmConfig.provider ?? '')
            || loaded.llmConfig.api_key;

          // 创建 LLM（对齐 bootstrap 的 createLLMFromConfig）
          logger.info(`[LLM Factory] ${loaded.llmConfig.provider}/${loaded.llmConfig.model ?? '(default)'}`);

          const apiKey = loaded.llmConfig.api_key ?? '';
          const llm = loaded.llmConfig.provider === 'deepseek'
            ? new DeepSeekChatLLM({
                apiKey,
                baseURL: loaded.llmConfig.base_url,
                model: loaded.llmConfig.model,
                temperature: loaded.llmConfig.temperature,
                maxTokens: loaded.llmConfig.max_tokens,
                topP: loaded.llmConfig.top_p,
                responseFormat: loaded.llmConfig.response_format,
                stop: loaded.llmConfig.stop,
                reasoningEffort: loaded.llmConfig.reasoning_effort,
                thinking: loaded.llmConfig.thinking,
                logprobs: loaded.llmConfig.logprobs,
                topLogprobs: loaded.llmConfig.top_logprobs,
                toolChoice: loaded.llmConfig.tool_choice,
              })
            : new OpenAIChatLLM({
                apiKey,
                baseURL: loaded.llmConfig.base_url,
                model: loaded.llmConfig.model,
                temperature: loaded.llmConfig.temperature,
                maxTokens: loaded.llmConfig.max_tokens,
                topP: loaded.llmConfig.top_p,
                responseFormat: loaded.llmConfig.response_format,
                stop: loaded.llmConfig.stop,
              });
          agent.setLLM(llm);

          // 注册工具
          if (loaded.tools.length > 0) agent.registerTools(loaded.tools);
          // 内置多 Agent 工具（由 plugin.json 的 autoInject 标记控制）
          for (const tool of loader.getAutoInjectTools()) {
            (agent as any).registerTool(tool);
          }
          // 全局拦截器
          for (const interceptor of loaded.interceptors) agent.useToolInterceptor(interceptor);
          // 钩子
          for (const hook of loaded.preHooks) agent.usePreHook(hook);
          for (const hook of loaded.postHooks) agent.usePostHook(hook);

          registry.register(agentId, agent);
          logger.info(`[Agents API] Agent "${agentId}" 已热加载到运行时`);
        } catch (loadErr: any) {
          logger.warn(`[Agents API] Agent "${agentId}" 热加载失败（需重启）: ${loadErr.message}`);
        }
      }

      res.json({ success: true, agentId, name: displayName });
    } catch (err: any) {
      res.status(500).json({ error: `创建 Agent 失败: ${err.message}` });
    }
  });

  /** DELETE /api/agents/:agentId —— 删除 Agent（永久） */
  router.delete('/:agentId', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const agentDir = findAgentDir(agentId);

    if (!agentDir) {
      res.status(404).json({ error: `Agent "${agentId}" 不存在` });
      return;
    }

    try {
      // 同时删除会话目录
      const sessionsDir = path.join(getGlobalConfig().sessionsDir, agentId);
      if (fs.existsSync(sessionsDir)) {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
      }

      // 删除凭据
      const configPath = path.join(agentDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.llm?.provider) {
          const { setCredential } = require('../../../src/core/credential-store');
          setCredential(agentId, config.llm.provider, '');
        }
      }

      // 从运行时取消注册
      registry.unregister(agentId);

      // 删除 Agent 目录
      fs.rmSync(agentDir, { recursive: true, force: true });
      logger.info(`[Agents API] 已永久删除 Agent "${agentId}"`);
      res.json({ success: true, agentId });
    } catch (err: any) {
      res.status(500).json({ error: `删除 Agent 失败: ${err.message}` });
    }
  });

  /** GET /api/agents/:agentId/config —— 获取 Agent 完整配置 */
  router.get('/:agentId/config', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const agentDir = findAgentDir(agentId);

    if (!agentDir) {
      res.status(404).json({ error: `Agent "${agentId}" 的配置文件不存在` });
      return;
    }

    const configPath = path.join(agentDir, 'config.json');
    try {
      // 1. 读取 Agent 差异配置（仅包含与全局不同的项）
      const agentDiff = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 2. 构建全局基准（排除 $ 内部字段、agent_id、name）
      const globalBase: Record<string, unknown> = {};
      const globalRaw = getGlobalConfig() as unknown as Record<string, unknown>;
      for (const key of Object.keys(globalRaw)) {
        if (!key.startsWith('$') && key !== 'namespaces') {
          globalBase[key] = globalRaw[key];
        }
      }
      // 展平 namespaces 到顶层（如 "extension.agent_session" → 顶层键）
      const namespaces = globalRaw.namespaces as Record<string, Record<string, unknown>> | undefined;
      if (namespaces) {
        for (const [nsKey, nsVal] of Object.entries(namespaces)) {
          globalBase[nsKey] = nsVal;
        }
      }

      // 3. 合并：全局基础 + Agent 差异 → 有效配置
      const effectiveConfig = deepMerge(globalBase, agentDiff);
      // 确保 agent_id 正确
      effectiveConfig.agent_id = agentId;

      // 剥离全局专属字段（这些字段属于 workspace/config.json，不应出现在 Agent 配置视图中）
      const GLOBAL_ONLY_KEYS = [
        'llmProviders', 'searchProviders',
        'workspaceDir', 'agentsDir', 'sessionsDir', 'groupsDir',
        'maxHops', 'messageQueryDefaultLimit',
      ];
      for (const key of GLOBAL_ONLY_KEYS) {
        delete effectiveConfig[key];
      }

      // 4. 从凭据存储回填 api_key（Agent 级优先，全局 fallback）
      const effLlm = effectiveConfig.llm as Record<string, unknown> | undefined;
      if (effLlm?.provider) {
        const key = getCredential(agentId, effLlm.provider as string)
          || getCredential('__global__', effLlm.provider as string);
        if (key) effLlm.api_key = key;
      }

      // 5. 读取 SYSTEM.md 和 AGENT.md
      const sysPath = path.join(agentDir, 'SYSTEM.md');
      const sysContent = fs.existsSync(sysPath) ? fs.readFileSync(sysPath, 'utf-8') : '';
      const agentPath = path.join(agentDir, 'AGENT.md');
      const agentContent = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf-8') : '';

      res.json({ agentId, config: effectiveConfig, sysContent, agentContent });
    } catch (err: any) {
      res.status(500).json({ error: `读取配置失败: ${err.message}` });
    }
  });

  /** POST /api/agents/:agentId/config —— 保存 Agent 完整配置 */
  router.post('/:agentId/config', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const { config, sysContent, agentContent } = req.body as {
      config?: Record<string, unknown>;
      sysContent?: string;
      agentContent?: string;
    };
    const agentDir = findAgentDir(agentId);

    if (!agentDir) {
      res.status(404).json({ error: `Agent "${agentId}" 的配置文件不存在` });
      return;
    }

    const configPath = path.join(agentDir, 'config.json');
    try {
      if (config) {
        // 读取旧配置，判断 llm 是否被移除
        let oldProvider: string | undefined;
        if (fs.existsSync(configPath)) {
          const old = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          oldProvider = old.llm?.provider as string | undefined;
        }

        // 提取 api_key 到凭据存储，config.json 中不保存
        const llm = config.llm as Record<string, unknown> | undefined;
        if (llm?.api_key !== undefined) {
          const provider = (llm.provider as string) || 'deepseek';
          setCredential(agentId, provider, (llm.api_key as string) || '');
          delete llm.api_key; // 不写入 config.json
        }

        // 切换到全局配置时，清除 Agent 级凭据（避免旧密钥残留）
        if (!llm && oldProvider) {
          setCredential(agentId, oldProvider, '');
          logger.info(`[Agents API] Agent "${agentId}" 已切换至全局配置，已清除 ${oldProvider} 凭据`);
        }

        // 构建全局基准（与 GET 逻辑一致）
        const globalBase: Record<string, unknown> = {};
        const globalRaw = getGlobalConfig() as unknown as Record<string, unknown>;
        for (const key of Object.keys(globalRaw)) {
          if (!key.startsWith('$') && key !== 'namespaces') {
            globalBase[key] = globalRaw[key];
          }
        }
        const ns = globalRaw.namespaces as Record<string, Record<string, unknown>> | undefined;
        if (ns) {
          for (const [nsKey, nsVal] of Object.entries(ns)) {
            globalBase[nsKey] = nsVal;
          }
        }

        // 剥离全局专属字段（防止前端误传导致 Agent 配置污染全局数据）
        // 这些字段仅属于 workspace/config.json，不应出现在 Agent 差异配置中
        const GLOBAL_ONLY_KEYS = [
          'llmProviders', 'searchProviders',
          'workspaceDir', 'agentsDir', 'sessionsDir', 'groupsDir',
          'maxHops', 'messageQueryDefaultLimit',
        ];
        for (const key of GLOBAL_ONLY_KEYS) {
          delete config[key];
        }

        // 计算差异：只保存与全局配置不同的项
        config.agent_id = agentId;
        const diff = computeDiff(config, globalBase);
        fs.writeFileSync(configPath, JSON.stringify(diff, null, 2) + '\n', 'utf-8');
        logger.info(`[Agents API] Agent "${agentId}" 差异配置已保存 (${Object.keys(diff).length} 项)`);

        // 热重载：从磁盘重新加载 Agent 配置、工具、扩展，并重建 LLM
        if (loader) {
          const agent = registry.getAgent(agentId);
          if (agent) {
            // 虚拟 Agent 无 LLM/工具，只需更新 config 引用
            if (registry.isVirtual(agentId)) {
              (agent as any).config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              logger.info(`[Agents API] VirtualAgent "${agentId}" config 已更新`);
            } else {
            const loaded = loader.loadOne(agentDir);
            (agent as any).reload(loaded);

            // 重新注入内置多 Agent 工具（reload 会清空 tools，需重新注入）
            for (const tool of loader.getAutoInjectTools()) {
              (agent as any).registerTool(tool);
            }

            // 重建 LLM（注入凭据存储中的 api_key）
            let llmCfg = loaded.llmConfig;
            if (!llmCfg) {
              // Agent 无独立 LLM 配置，继承全局配置
              const gCfg = getGlobalConfig() as any;
              if (gCfg.llm?.provider) {
                llmCfg = { ...gCfg.llm } as LLMConfig;
                logger.info(`[Agents API] Agent "${agentId}" 使用全局 LLM 配置: ${llmCfg.provider}`);
              }
            }
            if (llmCfg) {
              llmCfg = { ...llmCfg };
              llmCfg.api_key = getCredential(agentId, llmCfg.provider ?? '')
                || getCredential('__global__', llmCfg.provider ?? '')
                || llmCfg.api_key || '';
              logger.info(`[Agents API] 重建 LLM: ${llmCfg.provider}/${llmCfg.model}`);

              const apiKey3 = llmCfg.api_key ?? '';
              const llm = llmCfg.provider === 'deepseek'
                ? new DeepSeekChatLLM({
                    apiKey: apiKey3,
                    baseURL: llmCfg.base_url,
                    model: llmCfg.model,
                    temperature: llmCfg.temperature,
                    maxTokens: llmCfg.max_tokens,
                    topP: llmCfg.top_p,
                    responseFormat: llmCfg.response_format,
                    stop: llmCfg.stop,
                    reasoningEffort: llmCfg.reasoning_effort as any,
                    thinking: llmCfg.thinking,
                    logprobs: llmCfg.logprobs,
                    topLogprobs: llmCfg.top_logprobs,
                    toolChoice: llmCfg.tool_choice,
                  })
                : new OpenAIChatLLM({
                    apiKey: apiKey3,
                    baseURL: llmCfg.base_url,
                    model: llmCfg.model,
                    temperature: llmCfg.temperature,
                    maxTokens: llmCfg.max_tokens,
                    topP: llmCfg.top_p,
                    responseFormat: llmCfg.response_format,
                    stop: llmCfg.stop,
                  });
              (agent as any).setLLM(llm);
            }
            logger.info(`[Agents API] Agent "${agentId}" 已热重载`);
            }
          }
        }
      }

      if (sysContent !== undefined) {
        const sysPath = path.join(agentDir, 'SYSTEM.md');
        if (sysContent.trim()) {
          fs.writeFileSync(sysPath, sysContent, 'utf-8');
          logger.info(`[Agents API] Agent "${agentId}" SYSTEM.md 已更新`);
        } else if (fs.existsSync(sysPath)) {
          fs.unlinkSync(sysPath);
          logger.info(`[Agents API] Agent "${agentId}" SYSTEM.md 已删除`);
        }
      }

      if (agentContent !== undefined) {
        const agentMdPath = path.join(agentDir, 'AGENT.md');
        if (agentContent.trim()) {
          fs.writeFileSync(agentMdPath, agentContent, 'utf-8');
          logger.info(`[Agents API] Agent "${agentId}" AGENT.md 已更新`);
        } else if (fs.existsSync(agentMdPath)) {
          fs.unlinkSync(agentMdPath);
          logger.info(`[Agents API] Agent "${agentId}" AGENT.md 已删除`);
        }
      }

      res.json({ success: true, agentId, message: '配置已保存并热重载' });
    } catch (err: any) {
      res.status(500).json({ error: `保存配置失败: ${err.message}` });
    }
  });

  /** GET /api/agents/:agentId/timer —— 获取定时任务配置 */
  router.get('/:agentId/timer', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    res.json({ entries: timerManager.getEntries(agentId) });
  });

  /** POST /api/agents/:agentId/timer —— 保存定时任务配置 */
  router.post('/:agentId/timer', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const { entries } = req.body as { entries?: TimerEntry[] };
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: 'entries 必须是数组' });
      return;
    }
    try {
      timerManager.saveEntries(agentId, entries);
      res.json({ success: true, entries: timerManager.getEntries(agentId) });
    } catch (err: any) {
      res.status(500).json({ error: `保存定时配置失败: ${err.message}` });
    }
  });

  return router;
}
