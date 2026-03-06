import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import { authenticateAdmin } from '../middleware/auth.js';
import { ApiLog } from '../models/index.js';
import monitor from '../monitor.js';
import { invalidateAllTokenManagers } from '../index.js';

const router = express.Router();
router.use(authenticateAdmin);

const CONFIG_FILE = '.env';

async function updateEnvFile(key, value) {
  let content = '';
  try { content = await fs.readFile(CONFIG_FILE, 'utf-8'); } catch { content = ''; }
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(key + '=')) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  await fs.writeFile(CONFIG_FILE, lines.join('\n'), 'utf-8');
}

// ==================== 获取所有设置 ====================
router.get('/', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    loadBalanceStrategy: process.env.LOAD_BALANCE_STRATEGY || 'round-robin',
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '60'),
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '90000'),
    streamTimeout: parseInt(process.env.STREAM_TIMEOUT || '120000'),
    logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '30'),
    monitor: {
      running: monitor.running,
      activeCheckMinutes: Math.round(monitor.activeCheckInterval / 60000),
      recoveryCheckMinutes: Math.round(monitor.recoveryCheckInterval / 60000),
      maxConsecutiveFailures: monitor.maxConsecutiveFailures
    },
    system: {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      totalMemory: Math.round(os.totalmem() / 1024 / 1024),
      freeMemory: Math.round(os.freemem() / 1024 / 1024),
      processMemory: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      uptime: Math.floor(process.uptime()),
      cpus: os.cpus().length
    }
  });
});

// ==================== 负载均衡策略 ====================
router.get('/load-balance-strategy', (req, res) => {
  res.json({ strategy: process.env.LOAD_BALANCE_STRATEGY || 'round-robin' });
});

router.post('/load-balance-strategy', async (req, res) => {
  try {
    const { strategy } = req.body;
    if (!['round-robin', 'random', 'least-used'].includes(strategy)) {
      return res.status(400).json({ error: '无效的策略' });
    }
    await updateEnvFile('LOAD_BALANCE_STRATEGY', strategy);
    process.env.LOAD_BALANCE_STRATEGY = strategy;
    res.json({ success: true, message: '负载均衡策略已实时更新', strategy });
  } catch (error) {
    res.status(500).json({ error: '更新策略失败' });
  }
});

// ==================== 全局速率限制 (实时生效) ====================
router.post('/rate-limit', async (req, res) => {
  try {
    const { rpm } = req.body;
    const value = Math.max(1, parseInt(rpm) || 60);
    await updateEnvFile('RATE_LIMIT_RPM', value);
    process.env.RATE_LIMIT_RPM = String(value);
    res.json({ success: true, message: `速率限制已实时更新为 ${value} RPM`, rateLimitRpm: value });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ==================== 最大重试次数 (实时生效) ====================
router.post('/max-retries', async (req, res) => {
  try {
    const { maxRetries } = req.body;
    const value = Math.max(1, Math.min(parseInt(maxRetries) || 3, 50));
    await updateEnvFile('MAX_RETRIES', value);
    process.env.MAX_RETRIES = String(value);
    res.json({ success: true, message: `最大重试次数已实时更新为 ${value}`, maxRetries: value });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ==================== 请求超时 (实时生效) ====================
router.post('/timeouts', async (req, res) => {
  try {
    const { requestTimeout, streamTimeout } = req.body;
    if (requestTimeout !== undefined) {
      const v = Math.max(10000, parseInt(requestTimeout) || 90000);
      await updateEnvFile('REQUEST_TIMEOUT', v);
      process.env.REQUEST_TIMEOUT = String(v);
    }
    if (streamTimeout !== undefined) {
      const v = Math.max(30000, parseInt(streamTimeout) || 120000);
      await updateEnvFile('STREAM_TIMEOUT', v);
      process.env.STREAM_TIMEOUT = String(v);
    }
    res.json({ success: true, message: '超时设置已实时更新' });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ==================== 监控配置 ====================
router.get('/monitor', (req, res) => {
  res.json({
    activeCheckInterval: monitor.activeCheckInterval,
    activeCheckMinutes: Math.round(monitor.activeCheckInterval / 60000),
    recoveryCheckInterval: monitor.recoveryCheckInterval,
    recoveryCheckMinutes: Math.round(monitor.recoveryCheckInterval / 60000),
    maxConsecutiveFailures: monitor.maxConsecutiveFailures,
    running: monitor.running
  });
});

router.post('/monitor', async (req, res) => {
  try {
    const { activeCheckMinutes, recoveryCheckMinutes, maxFailures } = req.body;

    if (activeCheckMinutes !== undefined) {
      const ms = Math.max(1, parseInt(activeCheckMinutes)) * 60000;
      monitor.activeCheckInterval = ms;
      await updateEnvFile('MONITOR_INTERVAL', ms);
    }
    if (recoveryCheckMinutes !== undefined) {
      const ms = Math.max(1, parseInt(recoveryCheckMinutes)) * 60000;
      monitor.recoveryCheckInterval = ms;
      await updateEnvFile('RECOVERY_INTERVAL', ms);
    }
    if (maxFailures !== undefined) {
      const v = Math.max(1, parseInt(maxFailures));
      monitor.maxConsecutiveFailures = v;
      await updateEnvFile('MAX_FAILURES', v);
    }
    if (monitor.running) monitor.restart();

    res.json({
      success: true,
      message: '监控配置已实时更新' + (monitor.running ? ' (已重启)' : ''),
      activeCheckMinutes: Math.round(monitor.activeCheckInterval / 60000),
      recoveryCheckMinutes: Math.round(monitor.recoveryCheckInterval / 60000),
      maxConsecutiveFailures: monitor.maxConsecutiveFailures
    });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ==================== 日志管理 ====================
router.post('/clear-logs', (req, res) => {
  try {
    const { days } = req.body;
    const d = parseInt(days) || 30;
    const cutoff = new Date(Date.now() - d * 86400000).toISOString();
    const result = ApiLog.clearBefore(cutoff);
    res.json({ success: true, message: `已清理 ${d} 天前的日志`, deleted: result });
  } catch (error) {
    res.status(500).json({ error: '清理失败: ' + error.message });
  }
});

router.get('/log-stats', (req, res) => {
  try {
    const stats = ApiLog.getLogStorageStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: '获取失败' });
  }
});

// ==================== 缓存管理 ====================
router.post('/clear-cache', (req, res) => {
  try {
    invalidateAllTokenManagers();
    res.json({ success: true, message: 'Token 缓存已全部清除' });
  } catch (error) {
    res.status(500).json({ error: '清除失败' });
  }
});

export default router;
