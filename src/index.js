import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { initDatabase } from './config/database.js';
import { Token, ApiLog } from './models/index.js';
import TokenManager from './tokenManager.js';
import ProxyHandler from './proxyHandler.js';
import { authenticateApiKey, authenticateAdmin } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import monitor from './monitor.js';

import authRoutes from './routes/auth.js';
import apiKeysRoutes from './routes/apiKeys.js';
import tokensRoutes from './routes/tokens.js';
import statsRoutes from './routes/stats.js';
import settingsRoutes from './routes/settings.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MODELS_FILE = process.env.MODELS_FILE || './models.json';
function getMaxRetries() { return parseInt(process.env.MAX_RETRIES || '3'); }
const startTime = Date.now();

initDatabase();

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'gpt2api-node-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0, etag: false, lastModified: false }));

let modelsList = [];
try {
  const modelsData = await fs.readFile(MODELS_FILE, 'utf-8');
  modelsList = JSON.parse(modelsData);
  console.log(`✓ 加载了 ${modelsList.length} 个模型`);
} catch (err) {
  console.warn('⚠ 无法加载模型列表，使用默认列表');
  modelsList = [
    { id: 'gpt-5.3-codex', object: 'model', created: 1770307200, owned_by: 'openai' },
    { id: 'gpt-5.2-codex', object: 'model', created: 1765440000, owned_by: 'openai' }
  ];
}

// ==================== Token 管理器池（高并发优化：缓存 + 并发上限 + 智能选择） ====================
const tokenManagers = new Map();
let currentTokenIndex = 0;
let loadBalanceStrategy = process.env.LOAD_BALANCE_STRATEGY || 'round-robin';

const MAX_CONCURRENT_PER_TOKEN = 1;

const tokenConcurrency = new Map();
const tokenRecentErrors = new Map();
const TOKEN_ERROR_WINDOW = 120000;

let _activeTokensCache = null;
let _activeTokensCacheTime = 0;
const ACTIVE_TOKENS_CACHE_TTL = 3000;

function getCachedActiveTokens() {
  const now = Date.now();
  if (!_activeTokensCache || now - _activeTokensCacheTime > ACTIVE_TOKENS_CACHE_TTL) {
    _activeTokensCache = Token.getActive();
    _activeTokensCacheTime = now;
  }
  return _activeTokensCache;
}

export function invalidateTokenManager(tokenId) {
  tokenManagers.delete(tokenId);
  _activeTokensCache = null;
}

export function invalidateAllTokenManagers() {
  tokenManagers.clear();
  _activeTokensCache = null;
}

function createTokenManager(token) {
  const manager = new TokenManager(null);
  manager.tokenData = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    id_token: token.id_token,
    account_id: token.account_id,
    email: token.email,
    expired_at: token.expired_at,
    last_refresh_at: token.last_refresh_at,
    type: 'codex'
  };
  manager.dbTokenId = token.id;
  return manager;
}

function acquireToken(tokenId) {
  tokenConcurrency.set(tokenId, (tokenConcurrency.get(tokenId) || 0) + 1);
}

function releaseToken(tokenId) {
  const c = tokenConcurrency.get(tokenId) || 0;
  if (c <= 1) tokenConcurrency.delete(tokenId);
  else tokenConcurrency.set(tokenId, c - 1);
}

function recordTokenError(tokenId) {
  const now = Date.now();
  let errors = tokenRecentErrors.get(tokenId) || [];
  errors.push(now);
  errors = errors.filter(t => now - t < TOKEN_ERROR_WINDOW);
  tokenRecentErrors.set(tokenId, errors);
}

function getTokenErrorCount(tokenId) {
  const now = Date.now();
  const errors = tokenRecentErrors.get(tokenId) || [];
  return errors.filter(t => now - t < TOKEN_ERROR_WINDOW).length;
}

function scoreToken(token) {
  const concurrency = tokenConcurrency.get(token.id) || 0;
  const recentErrors = getTokenErrorCount(token.id);
  const healthPenalty = token.health_status === 'unhealthy' ? 50 : 0;
  return concurrency * 10 + recentErrors * 20 + healthPenalty + (token.failed_requests || 0) * 0.01;
}

function getAvailableTokenManager(excludeIds = []) {
  const allActive = getCachedActiveTokens();

  let activeTokens = allActive.filter(t =>
    !excludeIds.includes(t.id) &&
    !monitor.isTempDisabled(t.id) &&
    (tokenConcurrency.get(t.id) || 0) < MAX_CONCURRENT_PER_TOKEN
  );

  if (activeTokens.length === 0) {
    activeTokens = allActive.filter(t =>
      !excludeIds.includes(t.id) && !monitor.isTempDisabled(t.id)
    );
  }

  if (activeTokens.length === 0) {
    throw new Error('没有可用的 Token 账户');
  }

  let token;
  const strategy = process.env.LOAD_BALANCE_STRATEGY || loadBalanceStrategy;

  switch (strategy) {
    case 'random':
      token = activeTokens[Math.floor(Math.random() * activeTokens.length)];
      break;

    case 'least-used':
      token = activeTokens.reduce((best, current) =>
        scoreToken(current) < scoreToken(best) ? current : best
      );
      break;

    case 'round-robin':
    default: {
      const startIdx = currentTokenIndex % activeTokens.length;
      currentTokenIndex++;
      const poolSize = Math.min(activeTokens.length, 8);
      const candidates = [];
      for (let i = 0; i < poolSize; i++) {
        candidates.push(activeTokens[(startIdx + i) % activeTokens.length]);
      }
      candidates.sort((a, b) => scoreToken(a) - scoreToken(b));
      const topN = Math.min(3, candidates.length);
      token = candidates[Math.floor(Math.random() * topN)];
      break;
    }
  }

  if (!tokenManagers.has(token.id)) {
    const manager = createTokenManager(token);
    tokenManagers.set(token.id, { manager, tokenId: token.id });
  } else {
    const cached = tokenManagers.get(token.id);
    if (cached.manager.tokenData.access_token !== token.access_token) {
      const manager = createTokenManager(token);
      tokenManagers.set(token.id, { manager, tokenId: token.id });
    }
  }

  return tokenManagers.get(token.id);
}

// ==================== 通用代理执行器（高并发优化：快速故障转移+并发控制+异步日志） ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let globalInFlight = 0;

function classifyError(errStatus, error) {
  const code = error?.code || '';
  if (code === 'ECONNREFUSED') return { retryable: false, severity: 'connRefused', disableDuration: 0, retryDelay: 0 };
  if (errStatus === 400) return { retryable: false, severity: 'client', disableDuration: 0, retryDelay: 0 };
  if (errStatus === 401) return { retryable: true, severity: 'auth', disableDuration: 300000, retryDelay: 0 };
  if (errStatus === 403) return { retryable: true, severity: 'forbidden', disableDuration: 300000, retryDelay: 0 };
  if (errStatus === 429) return { retryable: true, severity: 'rateLimit', disableDuration: 60000, retryDelay: 300 };
  if (errStatus === 502 || errStatus === 503) return { retryable: true, severity: 'upstream', disableDuration: 15000, retryDelay: 0 };
  if (errStatus === 504 || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return { retryable: true, severity: 'timeout', disableDuration: 0, retryDelay: 0 };
  }
  if (errStatus >= 500) return { retryable: true, severity: 'server', disableDuration: 15000, retryDelay: 0 };
  return { retryable: true, severity: 'unknown', disableDuration: 10000, retryDelay: 0 };
}

function logAsync(data) {
  setImmediate(() => {
    try { ApiLog.create(data); } catch {}
  });
}

async function executeWithRetry(req, res, endpoint, handler) {
  const apiKeyId = req.apiKey?.id || null;
  const triedTokenIds = new Set();
  let lastError = null;
  let totalAttempts = 0;

  const activeTokens = getCachedActiveTokens();
  const availableCount = activeTokens.filter(t => !monitor.isTempDisabled(t.id)).length;
  const maxAttempts = Math.min(Math.max(availableCount, getMaxRetries(), 8), 30);

  globalInFlight++;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (res.headersSent) break;

      const requestStart = Date.now();
      let tokenId = null;
      totalAttempts++;

      let excludeList = [...triedTokenIds];
      let tokenSlot;
      try {
        tokenSlot = getAvailableTokenManager(excludeList);
      } catch {
        if (triedTokenIds.size > 0) {
          triedTokenIds.clear();
          try { tokenSlot = getAvailableTokenManager([]); } catch {}
        }
        if (!tokenSlot) {
          await sleep(200);
          try { tokenSlot = getAvailableTokenManager([]); } catch { break; }
        }
      }

      if (!tokenSlot) break;

      const { manager, tokenId: tid } = tokenSlot;
      tokenId = tid;
      triedTokenIds.add(tokenId);
      acquireToken(tokenId);

      try {
        const proxyHandler = new ProxyHandler(manager);
        const result = await handler(proxyHandler, req, res);

        const responseTime = Date.now() - requestStart;
        const usage = result?.usage || {};

        if (tokenId) Token.updateUsage(tokenId, true);
        logAsync({
          api_key_id: apiKeyId, token_id: tokenId,
          model: req.body.model || 'unknown', endpoint,
          status_code: 200, response_time: responseTime, error_message: null,
          input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0
        });
        return;

      } catch (error) {
        const responseTime = Date.now() - requestStart;
        lastError = error;

        const errStatus = error.response?.status || 500;
        let errDetail = error.message;
        if (error.response?.data) {
          try {
            const d = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
            errDetail += ' | ' + d.substring(0, 200);
          } catch {}
        }

        const classification = classifyError(errStatus, error);

        if (attempt < 3 || attempt % 5 === 0) {
          console.warn(`[${endpoint}] #${tokenId} 失败 ${attempt+1}/${maxAttempts} HTTP ${errStatus} [${classification.severity}]: ${errDetail.substring(0, 150)}`);
        }

        if (tokenId) {
          Token.updateUsage(tokenId, false);
          recordTokenError(tokenId);
          if (classification.disableDuration > 0) {
            monitor.tempDisableToken(tokenId, classification.disableDuration);
          }
          if (classification.severity === 'auth' || classification.severity === 'forbidden') {
            Token.updateHealthStatus(tokenId, 'unhealthy', `HTTP ${errStatus}: ${error.message.substring(0, 100)}`);
          }
        }

        logAsync({
          api_key_id: apiKeyId, token_id: tokenId,
          model: req.body.model || 'unknown', endpoint,
          status_code: errStatus, response_time: responseTime,
          error_message: error.message?.substring(0, 500),
          input_tokens: 0, output_tokens: 0
        });

        if (!classification.retryable) break;

        if (classification.retryDelay > 0) {
          const jitter = Math.floor(Math.random() * 200);
          await sleep(classification.retryDelay + jitter);
        }

      } finally {
        if (tokenId) releaseToken(tokenId);
      }
    }

    if (!res.headersSent) {
      const finalStatus = lastError?.response?.status || 502;
      res.status(finalStatus).json({
        error: {
          message: lastError?.message || '所有 Token 均请求失败',
          type: 'proxy_error',
          code: finalStatus === 429 ? 'rate_limit_exceeded' : 'upstream_error',
          attempts: totalAttempts,
          tried_tokens: triedTokenIds.size
        }
      });
    }
  } finally {
    globalInFlight--;
  }
}

// ==================== 管理后台路由 ====================
app.use('/admin/auth', authRoutes);
app.use('/admin/api-keys', apiKeysRoutes);
app.use('/admin/tokens', tokensRoutes);
app.use('/admin/stats', statsRoutes);
app.use('/admin/settings', settingsRoutes);

// ==================== 监控管理接口 ====================

app.get('/admin/monitor', authenticateAdmin, (req, res) => {
  res.json(monitor.getStatus());
});

app.post('/admin/monitor/start', authenticateAdmin, (req, res) => {
  monitor.start();
  res.json({ success: true, message: '监控服务已启动' });
});

app.post('/admin/monitor/stop', authenticateAdmin, (req, res) => {
  monitor.stop();
  res.json({ success: true, message: '监控服务已停止' });
});

// 立即执行一次活跃 Token 检测
app.post('/admin/monitor/check-now', authenticateAdmin, async (req, res) => {
  try {
    await monitor.runActiveCheck();
    res.json({ success: true, message: '活跃检测已完成', results: monitor.stats.lastApiTestResults });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 立即执行一次封停复测
app.post('/admin/monitor/recovery-now', authenticateAdmin, async (req, res) => {
  try {
    await monitor.runRecoveryCheck();
    res.json({ success: true, message: '封停复测已完成' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 手动测试单个 Token
app.post('/admin/monitor/test-token/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await monitor.manualTestToken(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Token 健康摘要
app.get('/admin/monitor/health-summary', authenticateAdmin, (req, res) => {
  res.json(Token.getHealthSummary());
});

app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ==================== 代理接口（需要 API Key + 速率限制） ====================

app.post('/v1/chat/completions', authenticateApiKey, rateLimitMiddleware, async (req, res) => {
  await executeWithRetry(req, res, '/v1/chat/completions', async (proxy, req, res) => {
    if (req.body.stream === true) {
      return await proxy.handleStreamRequest(req, res);
    } else {
      return await proxy.handleNonStreamRequest(req, res);
    }
  });
});

app.post('/v1/responses', authenticateApiKey, rateLimitMiddleware, async (req, res) => {
  await executeWithRetry(req, res, '/v1/responses', async (proxy, req, res) => {
    if (req.body.stream !== false) {
      return await proxy.handleResponsesStreamRequest(req, res);
    } else {
      return await proxy.handleResponsesNonStreamRequest(req, res);
    }
  });
});

app.post('/v1/completions', authenticateApiKey, rateLimitMiddleware, async (req, res) => {
  await executeWithRetry(req, res, '/v1/completions', async (proxy, req, res) => {
    if (req.body.stream === true) {
      return await proxy.handleCompletionsStreamRequest(req, res);
    } else {
      return await proxy.handleCompletionsNonStreamRequest(req, res);
    }
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: modelsList
  });
});

app.get('/v1/models/:modelId', (req, res) => {
  const modelInfo = modelsList.find(m => m.id === req.params.modelId);
  if (modelInfo) {
    res.json(modelInfo);
  } else {
    res.status(404).json({
      error: {
        message: `Model '${req.params.modelId}' not found`,
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    });
  }
});

// 增强型健康检查
app.get('/health', (req, res) => {
  const activeTokens = Token.getActive();
  const allTokens = Token.getAll();
  const logStats = ApiLog.getStats();
  const avgResponseTime = ApiLog.getAvgResponseTime();
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  const healthSummary = Token.getHealthSummary();

  res.json({
    status: activeTokens.length > 0 ? 'healthy' : 'degraded',
    uptime,
    version: '3.0.0',
    tokens: {
      active: activeTokens.length,
      total: allTokens.length,
      health: healthSummary
    },
    requests: logStats,
    avgResponseTime,
    rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '60'),
    loadBalanceStrategy: process.env.LOAD_BALANCE_STRATEGY || loadBalanceStrategy,
    monitor: {
      running: monitor.running,
      upstreamStatus: monitor.stats.upstreamStatus,
      lastActiveCheck: monitor.stats.lastActiveCheckTime,
      lastRecoveryCheck: monitor.stats.lastRecoveryCheckTime,
      tokensDisabled: monitor.stats.tokensDisabled,
      tokensRecovered: monitor.stats.tokensRecovered,
      intervals: {
        activeCheckMinutes: Math.round(monitor.activeCheckInterval / 60000),
        recoveryCheckMinutes: Math.round(monitor.recoveryCheckInterval / 60000)
      }
    },
    concurrency: {
      trackedTokens: tokenConcurrency.size,
      totalInFlight: globalInFlight,
      perTokenInFlight: Array.from(tokenConcurrency.values()).reduce((s, v) => s + v, 0),
      maxConcurrentPerToken: MAX_CONCURRENT_PER_TOKEN,
      maxRetries: Math.min(Math.max(activeTokens.length, getMaxRetries(), 8), 30),
      failoverDelay: '0ms (instant)',
      rateLimitDelay: '300-500ms'
    },
    endpoints: [
      'POST /v1/chat/completions',
      'POST /v1/responses',
      'POST /v1/completions',
      'GET  /v1/models',
      'GET  /v1/models/:id'
    ]
  });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    error: {
      message: err.message || '内部服务器错误',
      type: 'server_error'
    }
  });
});

// 启动服务器
app.listen(PORT, () => {
  const activeTokens = Token.getActive();
  const allTokens = Token.getAll();
  const strategyNames = {
    'round-robin': '轮询',
    'random': '随机',
    'least-used': '最少使用'
  };

  const activeCheckMin = Math.round(monitor.activeCheckInterval / 60000);
  const recoveryCheckMin = Math.round(monitor.recoveryCheckInterval / 60000);

  console.log('=================================');
  console.log('🚀 GPT2API Node v3.0 管理系统已启动');
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`⚖️  账号总数: ${allTokens.length} | 负载均衡: ${strategyNames[loadBalanceStrategy] || loadBalanceStrategy}`);
  console.log(`🔑 活跃账号: ${activeTokens.length} 个`);
  console.log(`🔄 最大重试: ${getMaxRetries()} 次`);
  console.log(`🛡️  速率限制: ${process.env.RATE_LIMIT_RPM || 60} RPM`);
  console.log(`🔍 活跃检测: 每 ${activeCheckMin} 分钟 | 封停复测: 每 ${recoveryCheckMin} 分钟`);
  console.log('=================================');
  console.log(`\n管理后台: http://localhost:${PORT}/admin`);
  console.log(`API 接口:`);
  console.log(`  POST /v1/chat/completions  (Chat Completions)`);
  console.log(`  POST /v1/responses         (Responses API)`);
  console.log(`  POST /v1/completions       (Legacy Completions)`);
  console.log(`  GET  /v1/models            (模型列表)`);
  console.log(`  GET  /v1/models/:id        (模型详情)`);
  console.log(`  GET  /health               (增强型健康检查)`);
  console.log(`\n监控接口 (需登录):`);
  console.log(`  GET  /admin/monitor              (监控状态)`);
  console.log(`  POST /admin/monitor/start        (启动监控)`);
  console.log(`  POST /admin/monitor/stop         (停止监控)`);
  console.log(`  POST /admin/monitor/check-now    (立即检测活跃Token)`);
  console.log(`  POST /admin/monitor/recovery-now (立即复测封停Token)`);
  console.log(`  POST /admin/monitor/test-token/:id (手动测试单个Token)`);
  console.log(`  GET  /admin/monitor/health-summary (健康摘要)`);
  console.log(`  GET  /admin/settings              (所有设置)`);
  console.log(`  POST /admin/settings/monitor       (修改监控间隔)`);

  monitor.start();

  console.log(`\n首次使用请运行: npm run init-db`);
  console.log(`默认账户: admin / admin123\n`);
});
