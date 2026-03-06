const DEFAULT_WINDOW_MS = 60000;
function getDefaultMaxRequests() { return parseInt(process.env.RATE_LIMIT_RPM || '60'); }

class RateLimiter {
  constructor() {
    this.windows = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  check(key, maxRequests, windowMs = DEFAULT_WINDOW_MS) {
    if (!maxRequests) maxRequests = getDefaultMaxRequests();
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!this.windows.has(key)) {
      this.windows.set(key, []);
    }

    const timestamps = this.windows.get(key).filter(t => t > windowStart);
    this.windows.set(key, timestamps);

    if (timestamps.length >= maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter, limit: maxRequests };
    }

    timestamps.push(now);
    return { allowed: true, remaining: maxRequests - timestamps.length, retryAfter: 0, limit: maxRequests };
  }

  cleanup() {
    const now = Date.now();
    const cutoff = now - DEFAULT_WINDOW_MS * 2;
    for (const [key, timestamps] of this.windows.entries()) {
      const valid = timestamps.filter(t => t > cutoff);
      if (valid.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, valid);
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }
}

const limiter = new RateLimiter();

export function rateLimitMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '') || req.ip;
  const perKeyLimit = req.apiKey?.rate_limit;
  const effectiveLimit = (perKeyLimit && perKeyLimit > 0) ? perKeyLimit : getDefaultMaxRequests();
  const result = limiter.check(apiKey, effectiveLimit);

  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);

  if (!result.allowed) {
    res.setHeader('Retry-After', result.retryAfter);
    return res.status(429).json({
      error: {
        message: `请求过于频繁，请 ${result.retryAfter} 秒后重试 (限额: ${effectiveLimit} RPM)`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded'
      }
    });
  }

  next();
}

export default limiter;
