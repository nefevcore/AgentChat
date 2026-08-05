// ============================================================
// Agents API —— GET /api/agents, GET/POST /api/agents/:agentId/config
// ============================================================

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { AgentRegistry } from '@routing/registry';
import { AgentRouter } from '@routing/router';
import { configService } from '@services/config-service';
import { AgentService, TimerEntry } from '@services/index';
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
  const agentsDir = configService.getGlobalConfig().agentsDir;
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

// ── AgentService（核心逻辑收回 src/services）──
// 原 buildGlobalBase/saveAgentConfig/writeMDFile/createLLM/hotReloadAgent
// 已移至 src/services/agent-service.ts（v0.5.0 P3 服务化）

export function createAgentsRouter(registry: AgentRegistry, agentService?: AgentService, agentRouter?: AgentRouter): Router {
  const router = Router();
  // 供闭包安全收窄：服务注册表注入的 agentService 在 bootstrap 恒存在
  const svc = agentService;
  if (!svc) {
    throw new Error('[Agents API] AgentService 未初始化（服务注册表缺少 agentService）');
  }
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
        const userDir = path.resolve(configService.getGlobalConfig().agentsDir, 'user');
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
      ? path.resolve(configService.getGlobalConfig().agentsDir, 'user')
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
      ? path.resolve(configService.getGlobalConfig().agentsDir, 'user')
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

    const agentsDir = configService.getGlobalConfig().agentsDir;
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

      // 热加载新 Agent 到运行时（对齐 bootstrap 流程，逻辑在 AgentService）
      if (svc && agentRouter) {
        try {
          svc.createAgentRuntime(agentDir, agentRouter);
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
      const sessionsDir = path.join(configService.getGlobalConfig().sessionsDir, agentId);
      if (fs.existsSync(sessionsDir)) {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
      }

      // 删除凭据
      const configPath = path.join(agentDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.llm?.provider) {
          configService.setAgentCredential(agentId, config.llm.provider, '');
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

      // 2. 合并：全局基础 + Agent 差异 → 有效配置（含凭据回填，AgentService 统一逻辑）
      const effectiveConfig = svc.getEffectiveConfig(agentId, agentDiff);

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
      config?: Record<string, unknown>; sysContent?: string; agentContent?: string;
    };
    const agentDir = findAgentDir(agentId);
    if (!agentDir) return void res.status(404).json({ error: `Agent "${agentId}" 不存在` });

    try {
      if (config) {
        svc.saveAgentConfig(agentId, agentDir, config);
        svc.hotReloadAgent(agentId, agentDir);
      }
      if (sysContent !== undefined) svc.writeMDFile(agentDir, 'SYSTEM.md', sysContent);
      if (agentContent !== undefined) svc.writeMDFile(agentDir, 'AGENT.md', agentContent);
      res.json({ success: true, agentId, message: '配置已保存并热重载' });
    } catch (err: any) {
      res.status(500).json({ error: `保存配置失败: ${err.message}` });
    }
  });

  router.get('/:agentId/timer', (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    res.json({ entries: svc.getAgentTimers(agentId) });
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
      svc.saveAgentTimers(agentId, entries);
      res.json({ success: true, entries: svc.getAgentTimers(agentId) });
    } catch (err: any) {
      res.status(500).json({ error: `保存定时配置失败: ${err.message}` });
    }
  });

  return router;
}
