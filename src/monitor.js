import axios from 'axios';
import { Token } from './models/index.js';
import TokenManager from './tokenManager.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const CODEX_CLIENT_VERSION = '0.101.0';

class MonitorService {
  constructor() {
    this.running = false;

    // 活跃 Token 检测定时器
    this.activeCheckId = null;
    // 已封停 Token 复测定时器
    this.recoveryCheckId = null;

    // 可配置的间隔（毫秒）
    this.activeCheckInterval = parseInt(process.env.MONITOR_INTERVAL || '14400000');   // 默认4小时
    this.recoveryCheckInterval = parseInt(process.env.RECOVERY_INTERVAL || '21600000'); // 默认6小时
    this.refreshBuffer = parseInt(process.env.REFRESH_BUFFER || '600000');             // 过期前10分钟刷新
    this.maxConsecutiveFailures = parseInt(process.env.MAX_FAILURES || '2');

    // 每个 token 的失败计数
    this.failureCounts = new Map();
    // 临时排除（代理请求失败后短时排除）
    this.tempDisabled = new Map();
    // 最近一次检测结果
    this.lastCheckResults = new Map();

    this.stats = {
      totalChecks: 0,
      lastActiveCheckTime: null,
      lastRecoveryCheckTime: null,
      upstreamStatus: 'unknown',
      tokensRefreshed: 0,
      tokensDisabled: 0,
      tokensRecovered: 0,
      lastApiTestResults: { tested: 0, passed: 0, failed: 0 }
    };
  }

  // ==================== 启动 / 停止 ====================

  start() {
    if (this.running) return;
    this.running = true;

    const activeMin = Math.round(this.activeCheckInterval / 60000);
    const recoveryMin = Math.round(this.recoveryCheckInterval / 60000);
    console.log(`✓ 监控服务已启动 (活跃检测: ${activeMin}分钟, 封停复测: ${recoveryMin}分钟)`);

    // 启动后延迟5分钟再做第一次检测（避免启动时并发大量请求）
    setTimeout(() => this.runActiveCheck(), 300000);
    this.activeCheckId = setInterval(() => this.runActiveCheck(), this.activeCheckInterval);
    this.recoveryCheckId = setInterval(() => this.runRecoveryCheck(), this.recoveryCheckInterval);
  }

  stop() {
    if (this.activeCheckId) { clearInterval(this.activeCheckId); this.activeCheckId = null; }
    if (this.recoveryCheckId) { clearInterval(this.recoveryCheckId); this.recoveryCheckId = null; }
    this.running = false;
    console.log('⏹ 监控服务已停止');
  }

  restart() {
    this.stop();
    this.start();
  }

  updateIntervals(activeMs, recoveryMs) {
    if (activeMs && activeMs >= 60000) this.activeCheckInterval = activeMs;
    if (recoveryMs && recoveryMs >= 60000) this.recoveryCheckInterval = recoveryMs;
    if (this.running) this.restart();
  }

  // ==================== 活跃 Token 定期检测 ====================

  async runActiveCheck() {
    this.stats.totalChecks++;
    this.stats.lastActiveCheckTime = new Date().toISOString();

    try {
      await this.checkUpstream();
      if (this.stats.upstreamStatus === 'offline') {
        console.warn('⚠ 上游离线，跳过本轮 Token 检测');
        return;
      }
      await this.checkActiveTokens();
      this.cleanupTempDisabled();
    } catch (error) {
      console.error('活跃检测异常:', error.message);
    }
  }

  async checkUpstream() {
    try {
      await axios.get('https://chatgpt.com', {
        timeout: 15000,
        maxRedirects: 3,
        validateStatus: (status) => status < 500
      });
      this.stats.upstreamStatus = 'online';
    } catch {
      this.stats.upstreamStatus = 'offline';
      console.warn('⚠ 上游服务不可达');
    }
  }

  async checkActiveTokens() {
    const activeTokens = Token.getActive();
    let tested = 0, passed = 0, failed = 0;

    for (const token of activeTokens) {
      try {
        const result = await this.fullCheckToken(token);
        this.lastCheckResults.set(token.id, {
          time: new Date().toISOString(),
          ...result
        });
        tested++;

        if (result.status === 'ok' || result.status === 'refreshed') {
          this.failureCounts.set(token.id, 0);
          passed++;
          Token.updateHealthStatus(token.id, 'healthy', result.message);
        } else {
          failed++;
          const count = (this.failureCounts.get(token.id) || 0) + 1;
          this.failureCounts.set(token.id, count);
          Token.updateHealthStatus(token.id, 'unhealthy', result.message);

          if (count >= this.maxConsecutiveFailures) {
            this.disableToken(token.id, `连续${count}次检测失败: ${result.message}`);
          }
        }
      } catch (error) {
        console.error(`Token #${token.id} 检测异常:`, error.message);
      }
    }

    this.stats.lastApiTestResults = { tested, passed, failed };
    if (tested > 0) {
      console.log(`📋 活跃检测完成: ${tested} 测试, ${passed} 通过, ${failed} 失败`);
    }
  }

  /**
   * 对一个 Token 做全面检测：先检查过期/刷新，再做真实 API 调用
   */
  async fullCheckToken(token) {
    // 1. 检查过期状态，必要时刷新
    if (token.expired_at) {
      const expireTime = new Date(token.expired_at).getTime();
      const now = Date.now();

      if (expireTime < now) {
        const refreshResult = await this.tryRefreshToken(token, '已过期');
        if (refreshResult.status === 'failed') return refreshResult;
        // 刷新成功后 token 数据已更新，重新从数据库读取
        const refreshedToken = Token.findById(token.id);
        if (refreshedToken) token = refreshedToken;
      } else if (expireTime - now < this.refreshBuffer) {
        await this.tryRefreshToken(token, '即将过期');
        const refreshedToken = Token.findById(token.id);
        if (refreshedToken) token = refreshedToken;
      }
    }

    // 2. 真实 API 调用测试
    return await this.testTokenWithApi(token);
  }

  /**
   * 用轻量级请求真正测试 Token 是否可用
   */
  async testTokenWithApi(token) {
    try {
      const testRequest = {
        model: 'gpt-5.3-codex',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }]
        }],
        instructions: '',
        stream: true,
        store: false,
        max_tokens: 1
      };

      const response = await axios.post(
        `${CODEX_BASE_URL}/responses`,
        testRequest,
        {
          headers: {
            'Authorization': `Bearer ${token.access_token}`,
            'Content-Type': 'application/json',
            'User-Agent': CODEX_USER_AGENT,
            'Version': CODEX_CLIENT_VERSION,
            'Openai-Beta': 'responses=experimental',
          },
          responseType: 'stream',
          timeout: 30000
        }
      );

      // 只需要确认能建立连接并收到数据即可，立即关闭
      return await new Promise((resolve) => {
        let gotData = false;
        const timer = setTimeout(() => {
          response.data.destroy();
          resolve(gotData
            ? { status: 'ok', message: 'API 测试通过' }
            : { status: 'failed', message: 'API 测试超时无响应' }
          );
        }, 10000);

        response.data.on('data', () => {
          if (!gotData) {
            gotData = true;
            clearTimeout(timer);
            response.data.destroy();
            resolve({ status: 'ok', message: 'API 测试通过' });
          }
        });

        response.data.on('error', (err) => {
          clearTimeout(timer);
          resolve({ status: 'failed', message: `API 流错误: ${err.message}` });
        });

        response.data.on('end', () => {
          clearTimeout(timer);
          resolve(gotData
            ? { status: 'ok', message: 'API 测试通过' }
            : { status: 'failed', message: 'API 测试无数据返回' }
          );
        });
      });

    } catch (error) {
      const status = error.response?.status;
      let msg = error.message;

      if (status === 401 || status === 403) {
        msg = `认证失败 (HTTP ${status})`;
      } else if (status === 429) {
        // 429 表示限流，Token 本身是可用的
        return { status: 'ok', message: '被限流但 Token 有效 (429)' };
      } else if (status === 400) {
        // 400 可能是请求格式问题，Token 本身可能是好的
        return { status: 'ok', message: '请求格式警告但 Token 可用 (400)' };
      } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        msg = '连接超时';
      }

      return { status: 'failed', message: msg };
    }
  }

  // ==================== 已封停 Token 定期复测 ====================

  async runRecoveryCheck() {
    this.stats.lastRecoveryCheckTime = new Date().toISOString();

    try {
      if (this.stats.upstreamStatus === 'offline') {
        console.warn('⚠ 上游离线，跳过封停复测');
        return;
      }

      const disabledTokens = Token.getDisabled();
      if (disabledTokens.length === 0) return;

      console.log(`🔄 开始复测 ${disabledTokens.length} 个已封停 Token...`);
      let recovered = 0;

      for (const token of disabledTokens) {
        try {
          // 先尝试刷新过期的 Token
          if (token.expired_at) {
            const expireTime = new Date(token.expired_at).getTime();
            if (expireTime < Date.now() && token.refresh_token) {
              const refreshResult = await this.tryRefreshToken(token, '复测刷新');
              if (refreshResult.status === 'failed') {
                this.lastCheckResults.set(token.id, {
                  time: new Date().toISOString(),
                  status: 'failed',
                  message: `复测刷新失败: ${refreshResult.message}`
                });
                Token.updateHealthStatus(token.id, 'disabled', `复测刷新失败: ${refreshResult.message}`);
                continue;
              }
              // 刷新成功，重新读取
              const refreshedToken = Token.findById(token.id);
              if (refreshedToken) Object.assign(token, refreshedToken);
            }
          }

          // 真实 API 测试
          const result = await this.testTokenWithApi(token);

          if (result.status === 'ok') {
            this.recoverToken(token.id);
            recovered++;
            this.lastCheckResults.set(token.id, {
              time: new Date().toISOString(),
              status: 'recovered',
              message: '复测通过，已自动恢复'
            });
          } else {
            this.lastCheckResults.set(token.id, {
              time: new Date().toISOString(),
              status: 'still_disabled',
              message: `复测仍然失败: ${result.message}`
            });
            Token.updateHealthStatus(token.id, 'disabled', `复测失败: ${result.message}`);
          }
        } catch (error) {
          console.error(`Token #${token.id} 复测异常:`, error.message);
        }
      }

      if (recovered > 0) {
        console.log(`✓ 复测完成: ${recovered}/${disabledTokens.length} 个 Token 已恢复`);
      } else {
        console.log(`📋 复测完成: 0/${disabledTokens.length} 个 Token 恢复`);
      }
    } catch (error) {
      console.error('封停复测异常:', error.message);
    }
  }

  // ==================== Token 操作 ====================

  async tryRefreshToken(token, reason) {
    if (!token.refresh_token) {
      return { status: 'failed', message: `${reason}且无 refresh_token` };
    }
    try {
      const manager = new TokenManager(null);
      manager.tokenData = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        id_token: token.id_token,
        expired_at: token.expired_at,
        last_refresh_at: token.last_refresh_at
      };
      const newData = await manager.refreshTokenOnly();
      Token.update(token.id, {
        access_token: newData.access_token,
        refresh_token: newData.refresh_token,
        id_token: newData.id_token,
        expired_at: newData.expired_at
      });
      this.stats.tokensRefreshed++;
      console.log(`✓ Token #${token.id} 刷新成功 (${reason})`);
      return { status: 'refreshed', message: `${reason}，已刷新` };
    } catch (error) {
      return { status: 'failed', message: `${reason}，刷新失败: ${error.message}` };
    }
  }

  disableToken(tokenId, reason) {
    Token.toggleActive(tokenId, false);
    Token.updateHealthStatus(tokenId, 'disabled', reason);
    this.failureCounts.set(tokenId, 0);
    this.stats.tokensDisabled++;
    console.warn(`⛔ Token #${tokenId} 已自动封停: ${reason}`);
  }

  recoverToken(tokenId) {
    Token.toggleActive(tokenId, true);
    Token.updateHealthStatus(tokenId, 'healthy', '复测通过，已恢复');
    this.failureCounts.set(tokenId, 0);
    this.stats.tokensRecovered++;
    console.log(`✅ Token #${tokenId} 已自动恢复`);
  }

  /**
   * 手动测试单个 Token
   */
  async manualTestToken(tokenId) {
    const token = Token.findById(tokenId);
    if (!token) return { status: 'error', message: 'Token 不存在' };

    const result = await this.fullCheckToken(token);
    this.lastCheckResults.set(tokenId, {
      time: new Date().toISOString(),
      ...result
    });

    if (result.status === 'ok' || result.status === 'refreshed') {
      Token.updateHealthStatus(tokenId, 'healthy', result.message);
      if (!token.is_active) {
        this.recoverToken(tokenId);
        return { ...result, recovered: true };
      }
    } else {
      Token.updateHealthStatus(tokenId, 'unhealthy', result.message);
    }

    return result;
  }

  // ==================== 临时排除（代理请求级别，叠加延长） ====================

  tempDisableToken(tokenId, durationMs = 60000) {
    const now = Date.now();
    const existing = this.tempDisabled.get(tokenId);
    if (existing && existing.until > now) {
      // 已在排除期内：叠加延长（最多 5 分钟）
      const newUntil = Math.min(existing.until + Math.floor(durationMs * 0.5), now + 300000);
      existing.until = newUntil;
      existing.hits++;
    } else {
      this.tempDisabled.set(tokenId, { until: now + durationMs, hits: 1 });
    }
  }

  isTempDisabled(tokenId) {
    const entry = this.tempDisabled.get(tokenId);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.tempDisabled.delete(tokenId);
      return false;
    }
    return true;
  }

  getTempDisableInfo(tokenId) {
    const entry = this.tempDisabled.get(tokenId);
    if (!entry) return null;
    const remaining = entry.until - Date.now();
    if (remaining <= 0) { this.tempDisabled.delete(tokenId); return null; }
    return { remaining, hits: entry.hits };
  }

  cleanupTempDisabled() {
    const now = Date.now();
    for (const [id, entry] of this.tempDisabled.entries()) {
      if (now > entry.until) this.tempDisabled.delete(id);
    }
  }

  // ==================== 状态报告 ====================

  getStatus() {
    const activeTokens = Token.getActive();
    const disabledTokens = Token.getDisabled();

    const activeHealth = activeTokens.map(t => ({
      id: t.id,
      name: t.name || t.email || `Token #${t.id}`,
      healthStatus: t.health_status || 'unknown',
      healthMessage: t.health_message || '',
      lastCheck: this.lastCheckResults.get(t.id) || null,
      failureCount: this.failureCounts.get(t.id) || 0,
      tempDisabled: this.isTempDisabled(t.id)
    }));

    const disabledHealth = disabledTokens.map(t => ({
      id: t.id,
      name: t.name || t.email || `Token #${t.id}`,
      healthStatus: t.health_status || 'disabled',
      healthMessage: t.health_message || '',
      lastCheck: this.lastCheckResults.get(t.id) || null
    }));

    return {
      running: this.running,
      intervals: {
        activeCheck: this.activeCheckInterval,
        activeCheckMinutes: Math.round(this.activeCheckInterval / 60000),
        recoveryCheck: this.recoveryCheckInterval,
        recoveryCheckMinutes: Math.round(this.recoveryCheckInterval / 60000)
      },
      ...this.stats,
      activeTokens: activeHealth,
      disabledTokens: disabledHealth
    };
  }
}

const monitor = new MonitorService();
export default monitor;
