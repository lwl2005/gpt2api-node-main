import db from '../config/database.js';
import bcrypt from 'bcrypt';

export class User {
  static findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  static async create(username, password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
      username,
      hashedPassword
    );
    return result.lastInsertRowid;
  }

  static async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      hashedPassword,
      id
    );
  }

  static async verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }
}

export class ApiKey {
  static getAll() {
    return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
  }

  static getAllMasked() {
    return this.getAll().map(k => ({
      ...k,
      key: k.key.substring(0, 7) + '...' + k.key.substring(k.key.length - 4)
    }));
  }

  static findById(id) {
    return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  }

  static findByKey(key) {
    return db.prepare('SELECT * FROM api_keys WHERE key = ? AND is_active = 1').get(key);
  }

  static create(key, name, options = {}) {
    const result = db.prepare(`
      INSERT INTO api_keys (key, name, rate_limit, daily_limit, monthly_limit, max_tokens, expires_at, allowed_models, allowed_ips, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key, name,
      options.rate_limit || 0,
      options.daily_limit || 0,
      options.monthly_limit || 0,
      options.max_tokens || 0,
      options.expires_at || null,
      options.allowed_models || null,
      options.allowed_ips || null,
      options.remark || null
    );
    return result.lastInsertRowid;
  }

  static delete(id) {
    db.prepare('DELETE FROM api_logs WHERE api_key_id = ?').run(id);
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  static batchDelete(ids) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM api_logs WHERE api_key_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM api_keys WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  }

  static batchToggle(ids, isActive) {
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`UPDATE api_keys SET is_active = ? WHERE id IN (${placeholders})`).run(isActive ? 1 : 0, ...ids);
    return result.changes;
  }

  static updateName(id, name) {
    db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(name, id);
  }

  static updateUsage(id) {
    db.prepare('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  static toggleActive(id, isActive) {
    db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  }

  static regenerateKey(id, newKey) {
    db.prepare('UPDATE api_keys SET key = ? WHERE id = ?').run(newKey, id);
  }

  static updateSettings(id, settings) {
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(settings)) {
      if (['rate_limit', 'daily_limit', 'monthly_limit', 'max_tokens', 'expires_at', 'allowed_models', 'allowed_ips', 'remark', 'name'].includes(k)) {
        fields.push(`${k} = ?`);
        values.push(v === '' || v === undefined ? null : v);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  static getDailyUsage(id) {
    const today = new Date().toISOString().split('T')[0];
    const r = db.prepare(`SELECT COUNT(*) as count FROM api_logs WHERE api_key_id = ? AND created_at >= ?`).get(id, today + 'T00:00:00');
    return r?.count || 0;
  }

  static getMonthlyUsage(id) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const r = db.prepare(`SELECT COUNT(*) as count FROM api_logs WHERE api_key_id = ? AND created_at >= ?`).get(id, monthStart);
    return r?.count || 0;
  }

  static getTotalTokensConsumed(id) {
    const r = db.prepare(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM api_logs WHERE api_key_id = ?`).get(id);
    return r?.total || 0;
  }

  static getKeyStats(id) {
    const stats = db.prepare(`
      SELECT COUNT(*) as total_requests,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success_requests,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as failed_requests,
             COALESCE(AVG(CASE WHEN response_time > 0 THEN response_time END), 0) as avg_response_time,
             COALESCE(SUM(input_tokens), 0) as total_input_tokens,
             COALESCE(SUM(output_tokens), 0) as total_output_tokens,
             COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM api_logs WHERE api_key_id = ?
    `).get(id);

    const today = new Date().toISOString().split('T')[0];
    const todayStats = db.prepare(`
      SELECT COUNT(*) as requests,
             COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_logs WHERE api_key_id = ? AND created_at >= ?
    `).get(id, today + 'T00:00:00');

    const recentModels = db.prepare(`
      SELECT model, COUNT(*) as count
      FROM api_logs WHERE api_key_id = ? AND model IS NOT NULL
      GROUP BY model ORDER BY count DESC LIMIT 5
    `).all(id);

    return { ...stats, today: todayStats, recentModels };
  }

  static getAllWithStats() {
    return db.prepare(`
      SELECT k.*,
             COALESCE(s.total_requests, 0) as log_total_requests,
             COALESCE(s.success_requests, 0) as log_success_requests,
             COALESCE(s.total_tokens, 0) as total_tokens_consumed,
             COALESCE(s.today_requests, 0) as today_requests,
             COALESCE(s.today_tokens, 0) as today_tokens
      FROM api_keys k
      LEFT JOIN (
        SELECT api_key_id,
               COUNT(*) as total_requests,
               SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success_requests,
               COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
               SUM(CASE WHEN created_at >= date('now') THEN 1 ELSE 0 END) as today_requests,
               COALESCE(SUM(CASE WHEN created_at >= date('now') THEN input_tokens + output_tokens ELSE 0 END), 0) as today_tokens
        FROM api_logs GROUP BY api_key_id
      ) s ON s.api_key_id = k.id
      ORDER BY k.created_at DESC
    `).all();
  }
}

export class Token {
  static getAll() {
    return db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all();
  }

  static getActive() {
    return db.prepare('SELECT * FROM tokens WHERE is_active = 1').all();
  }

  static getDisabled() {
    return db.prepare('SELECT * FROM tokens WHERE is_active = 0').all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
  }

  static findByAccessToken(accessToken) {
    return db.prepare('SELECT id, name, email FROM tokens WHERE access_token = ?').get(accessToken);
  }

  static findByRefreshToken(refreshToken) {
    return db.prepare('SELECT id, name, email FROM tokens WHERE refresh_token = ?').get(refreshToken);
  }

  static getAllAccessTokens() {
    return new Set(db.prepare('SELECT access_token FROM tokens').all().map(r => r.access_token));
  }

  static create(data) {
    const result = db.prepare(`
      INSERT INTO tokens (name, email, account_id, access_token, refresh_token, id_token, expired_at, last_refresh_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name || null,
      data.email || null,
      data.account_id || null,
      data.access_token,
      data.refresh_token,
      data.id_token || null,
      data.expired_at || null,
      data.last_refresh_at || new Date().toISOString()
    );
    return result.lastInsertRowid;
  }

  static update(id, data) {
    db.prepare(`
      UPDATE tokens
      SET access_token = ?, refresh_token = ?, id_token = ?, expired_at = ?, last_refresh_at = ?
      WHERE id = ?
    `).run(
      data.access_token,
      data.refresh_token,
      data.id_token || null,
      data.expired_at || null,
      new Date().toISOString(),
      id
    );
  }

  static delete(id) {
    // 先删除相关的 api_logs 记录
    db.prepare('DELETE FROM api_logs WHERE token_id = ?').run(id);
    // 再删除 token
    db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  }

  static toggleActive(id, isActive) {
    db.prepare('UPDATE tokens SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  }

  static updateUsage(id, success = true) {
    if (success) {
      db.prepare(`
        UPDATE tokens
        SET total_requests = total_requests + 1,
            success_requests = success_requests + 1,
            last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    } else {
      db.prepare(`
        UPDATE tokens
        SET total_requests = total_requests + 1,
            failed_requests = failed_requests + 1,
            last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    }
  }

  static updateQuota(id, quota) {
    db.prepare(`
      UPDATE tokens
      SET quota_total = ?,
          quota_used = ?,
          quota_remaining = ?,
          last_quota_check = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      quota.total || 0,
      quota.used || 0,
      quota.remaining || 0,
      id
    );
  }

  static updateHealthStatus(id, status, message = '') {
    db.prepare(`
      UPDATE tokens
      SET health_status = ?, health_message = ?, last_health_check = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, message, id);
  }

  static getRealTokenUsage(id) {
    return db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
             COALESCE(SUM(output_tokens), 0) as output_tokens,
             COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM api_logs
      WHERE token_id = ? AND status_code >= 200 AND status_code < 300
    `).get(id);
  }

  static getHealthSummary() {
    return {
      healthy: db.prepare("SELECT COUNT(*) as c FROM tokens WHERE health_status = 'healthy' AND is_active = 1").get().c,
      unhealthy: db.prepare("SELECT COUNT(*) as c FROM tokens WHERE health_status = 'unhealthy' AND is_active = 1").get().c,
      disabled: db.prepare("SELECT COUNT(*) as c FROM tokens WHERE is_active = 0").get().c,
      unknown: db.prepare("SELECT COUNT(*) as c FROM tokens WHERE (health_status = 'unknown' OR health_status IS NULL) AND is_active = 1").get().c,
      total: db.prepare("SELECT COUNT(*) as c FROM tokens").get().c
    };
  }
}

export class ApiLog {
  static create(data) {
    db.prepare(`
      INSERT INTO api_logs (api_key_id, token_id, model, endpoint, status_code, response_time, error_message, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.api_key_id || null,
      data.token_id || null,
      data.model || null,
      data.endpoint || null,
      data.status_code || null,
      data.response_time || null,
      data.error_message || null,
      data.input_tokens || 0,
      data.output_tokens || 0
    );
  }

  static getRecent(limit = 100) {
    return db.prepare('SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  static getStats() {
    return {
      total: db.prepare('SELECT COUNT(*) as count FROM api_logs').get().count,
      success: db.prepare('SELECT COUNT(*) as count FROM api_logs WHERE status_code >= 200 AND status_code < 300').get().count,
      error: db.prepare('SELECT COUNT(*) as count FROM api_logs WHERE status_code >= 400').get().count
    };
  }

  static getAvgResponseTime() {
    const row = db.prepare('SELECT AVG(response_time) as avg_time FROM api_logs WHERE response_time IS NOT NULL AND response_time > 0').get();
    return Math.round(row?.avg_time || 0);
  }

  static getStatsByModel() {
    return db.prepare(`
      SELECT model,
             COUNT(*) as total,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(CASE WHEN response_time > 0 THEN response_time END) as avg_response_time
      FROM api_logs
      WHERE model IS NOT NULL
      GROUP BY model
      ORDER BY total DESC
    `).all();
  }

  static getStatsByEndpoint() {
    return db.prepare(`
      SELECT endpoint,
             COUNT(*) as total,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(CASE WHEN response_time > 0 THEN response_time END) as avg_response_time
      FROM api_logs
      WHERE endpoint IS NOT NULL
      GROUP BY endpoint
      ORDER BY total DESC
    `).all();
  }

  static getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    return db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(CASE WHEN response_time > 0 THEN response_time END) as avg_response_time
      FROM api_logs
      WHERE created_at >= ?
    `).get(today + 'T00:00:00');
  }

  static getHourlyStats(hours = 24) {
    return db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', created_at) as hour,
             COUNT(*) as total,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY hour
      ORDER BY hour
    `).all(`-${hours} hours`);
  }

  static getTokenUsageStats() {
    const total = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) as total_input,
             COALESCE(SUM(output_tokens), 0) as total_output,
             COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM api_logs
      WHERE status_code >= 200 AND status_code < 300
    `).get();

    const today = new Date().toISOString().split('T')[0];
    const todayUsage = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) as total_input,
             COALESCE(SUM(output_tokens), 0) as total_output,
             COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
      FROM api_logs
      WHERE status_code >= 200 AND status_code < 300 AND created_at >= ?
    `).get(today + 'T00:00:00');

    const byModel = db.prepare(`
      SELECT model,
             COALESCE(SUM(input_tokens), 0) as input_tokens,
             COALESCE(SUM(output_tokens), 0) as output_tokens,
             COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
             COUNT(*) as request_count
      FROM api_logs
      WHERE model IS NOT NULL AND status_code >= 200 AND status_code < 300
      GROUP BY model
      ORDER BY total_tokens DESC
    `).all();

    return { total, today: todayUsage, byModel };
  }

  static getResponseTimePercentiles() {
    const rows = db.prepare(`
      SELECT response_time FROM api_logs
      WHERE response_time > 0 AND status_code >= 200 AND status_code < 300
      ORDER BY response_time ASC
    `).all();

    if (rows.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
    const vals = rows.map(r => r.response_time);
    return {
      p50: vals[Math.floor(vals.length * 0.5)] || 0,
      p95: vals[Math.floor(vals.length * 0.95)] || 0,
      p99: vals[Math.floor(vals.length * 0.99)] || 0,
      min: vals[0],
      max: vals[vals.length - 1]
    };
  }

  static getPeakRPM() {
    const row = db.prepare(`
      SELECT strftime('%Y-%m-%d %H:%M', created_at) as minute, COUNT(*) as cnt
      FROM api_logs
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY minute
      ORDER BY cnt DESC
      LIMIT 1
    `).get();
    return row ? { rpm: row.cnt, minute: row.minute } : { rpm: 0, minute: null };
  }

  static getTopApiKeys(limit = 5) {
    return db.prepare(`
      SELECT k.id, k.name, k.key,
             COUNT(l.id) as total_requests,
             SUM(CASE WHEN l.status_code >= 200 AND l.status_code < 300 THEN 1 ELSE 0 END) as success_requests,
             COALESCE(SUM(l.input_tokens + l.output_tokens), 0) as total_tokens
      FROM api_keys k
      LEFT JOIN api_logs l ON l.api_key_id = k.id
      GROUP BY k.id
      ORDER BY total_requests DESC
      LIMIT ?
    `).all(limit);
  }

  static getTokenPerformanceRanking(limit = 10) {
    return db.prepare(`
      SELECT t.id, t.name, t.email,
             COUNT(l.id) as total_requests,
             SUM(CASE WHEN l.status_code >= 200 AND l.status_code < 300 THEN 1 ELSE 0 END) as success_requests,
             COALESCE(AVG(CASE WHEN l.response_time > 0 THEN l.response_time END), 0) as avg_response_time,
             COALESCE(SUM(l.input_tokens + l.output_tokens), 0) as total_tokens
      FROM tokens t
      LEFT JOIN api_logs l ON l.token_id = t.id
      WHERE t.is_active = 1
      GROUP BY t.id
      ORDER BY total_requests DESC
      LIMIT ?
    `).all(limit);
  }

  static getSuccessErrorTrend(hours = 24) {
    return db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', created_at) as hour,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY hour
      ORDER BY hour
    `).all(`-${hours} hours`);
  }

  static getAnalyticsByRange(range = '24h') {
    const rangeSQL = range === '24h' ? '-24 hours' : range === '7d' ? '-7 days' : '-30 days';
    return db.prepare(`
      SELECT COUNT(*) as totalRequests,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as successRequests,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as failedRequests,
             COALESCE(AVG(CASE WHEN response_time > 0 THEN response_time END), 0) as avgResponseTime
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
    `).get(rangeSQL);
  }

  static getChartsByRange(range = '24h') {
    const isHourly = range === '24h';
    const rangeSQL = range === '24h' ? '-24 hours' : range === '7d' ? '-7 days' : '-30 days';
    const groupFmt = isHourly ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

    const trend = db.prepare(`
      SELECT strftime('${groupFmt}', created_at) as period,
             COUNT(*) as total,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY period
      ORDER BY period
    `).all(rangeSQL);

    const models = db.prepare(`
      SELECT model, COUNT(*) as count
      FROM api_logs
      WHERE model IS NOT NULL AND created_at >= datetime('now', ?)
      GROUP BY model
      ORDER BY count DESC
      LIMIT 8
    `).all(rangeSQL);

    const endpoints = db.prepare(`
      SELECT endpoint, COUNT(*) as count,
             SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             COALESCE(AVG(CASE WHEN response_time > 0 THEN response_time END), 0) as avg_time
      FROM api_logs
      WHERE endpoint IS NOT NULL AND created_at >= datetime('now', ?)
      GROUP BY endpoint
      ORDER BY count DESC
    `).all(rangeSQL);

    return { trend, models, endpoints };
  }

  static getLogsByRange(limit = 100, range = '24h') {
    const rangeSQL = range === '24h' ? '-24 hours' : range === '7d' ? '-7 days' : '-30 days';
    return db.prepare(`
      SELECT * FROM api_logs
      WHERE created_at >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(rangeSQL, limit);
  }

  static clearBefore(isoDate) {
    const result = db.prepare('DELETE FROM api_logs WHERE created_at < ?').run(isoDate);
    return result.changes;
  }

  static getLogStorageStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM api_logs').get();
    const oldest = db.prepare('SELECT MIN(created_at) as oldest FROM api_logs').get();
    const newest = db.prepare('SELECT MAX(created_at) as newest FROM api_logs').get();
    const today = db.prepare("SELECT COUNT(*) as count FROM api_logs WHERE created_at >= date('now')").get();
    const week = db.prepare("SELECT COUNT(*) as count FROM api_logs WHERE created_at >= date('now', '-7 days')").get();
    return {
      totalLogs: total?.count || 0,
      todayLogs: today?.count || 0,
      weekLogs: week?.count || 0,
      oldestLog: oldest?.oldest || null,
      newestLog: newest?.newest || null
    };
  }
}
