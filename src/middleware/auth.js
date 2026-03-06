import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User, ApiKey } from '../models/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

export function authenticateJWT(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

export function authenticateAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey) {
    return res.status(401).json({
      error: { message: 'API key required', type: 'authentication_error' }
    });
  }

  const keyData = ApiKey.findByKey(apiKey);
  if (!keyData) {
    return res.status(403).json({
      error: { message: 'Invalid API key', type: 'authentication_error' }
    });
  }

  // 过期检查
  if (keyData.expires_at) {
    const expiresAt = new Date(keyData.expires_at).getTime();
    if (Date.now() > expiresAt) {
      return res.status(403).json({
        error: { message: 'API key has expired', type: 'authentication_error', code: 'key_expired' }
      });
    }
  }

  // IP 白名单检查
  if (keyData.allowed_ips) {
    const clientIp = (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');
    const allowedList = keyData.allowed_ips.split(',').map(s => s.trim()).filter(Boolean);
    if (allowedList.length > 0 && !allowedList.includes(clientIp) && !allowedList.includes('*')) {
      return res.status(403).json({
        error: { message: 'IP not allowed for this API key', type: 'authentication_error', code: 'ip_restricted' }
      });
    }
  }

  // 模型限制检查
  if (keyData.allowed_models && req.body?.model) {
    const allowedModels = keyData.allowed_models.split(',').map(s => s.trim()).filter(Boolean);
    if (allowedModels.length > 0 && !allowedModels.includes(req.body.model) && !allowedModels.includes('*')) {
      return res.status(403).json({
        error: { message: `Model '${req.body.model}' is not allowed for this API key`, type: 'authentication_error', code: 'model_restricted' }
      });
    }
  }

  // 每日请求上限检查
  if (keyData.daily_limit > 0) {
    const dailyUsage = ApiKey.getDailyUsage(keyData.id);
    if (dailyUsage >= keyData.daily_limit) {
      return res.status(429).json({
        error: { message: `Daily request limit (${keyData.daily_limit}) exceeded`, type: 'rate_limit_error', code: 'daily_limit_exceeded' }
      });
    }
  }

  // 月度请求上限检查
  if (keyData.monthly_limit > 0) {
    const monthlyUsage = ApiKey.getMonthlyUsage(keyData.id);
    if (monthlyUsage >= keyData.monthly_limit) {
      return res.status(429).json({
        error: { message: `Monthly request limit (${keyData.monthly_limit}) exceeded`, type: 'rate_limit_error', code: 'monthly_limit_exceeded' }
      });
    }
  }

  // Token 消耗上限检查
  if (keyData.max_tokens > 0) {
    const totalTokens = ApiKey.getTotalTokensConsumed(keyData.id);
    if (totalTokens >= keyData.max_tokens) {
      return res.status(429).json({
        error: { message: `Token consumption limit (${keyData.max_tokens}) exceeded`, type: 'rate_limit_error', code: 'token_limit_exceeded' }
      });
    }
  }

  ApiKey.updateUsage(keyData.id);
  req.apiKey = keyData;
  next();
}

/**
 * 登录防暴力破解
 */
export function checkLoginAttempts(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  if (loginAttempts.has(ip)) {
    const record = loginAttempts.get(ip);
    record.attempts = record.attempts.filter(t => now - t < LOGIN_WINDOW_MS);

    if (record.attempts.length >= MAX_LOGIN_ATTEMPTS) {
      const retryAfter = Math.ceil((record.attempts[0] + LOGIN_WINDOW_MS - now) / 1000);
      return res.status(429).json({
        error: `登录尝试过于频繁，请 ${retryAfter} 秒后重试`
      });
    }
  }
  next();
}

export function recordLoginAttempt(ip) {
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { attempts: [] });
  }
  loginAttempts.get(ip).attempts.push(Date.now());
}

export function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function generateApiKey() {
  const bytes = crypto.randomBytes(24);
  return 'sk-' + bytes.toString('base64url');
}
