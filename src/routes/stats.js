import express from 'express';
import { ApiLog, ApiKey, Token } from '../models/index.js';
import { authenticateAdmin } from '../middleware/auth.js';
import db from '../config/database.js';

const router = express.Router();

router.use(authenticateAdmin);

// 获取总览统计
router.get('/', (req, res) => {
  try {
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();
    const activeTokens = tokens.filter(t => t.is_active);
    
    const totalRequests = tokens.reduce((sum, t) => sum + (t.total_requests || 0), 0);
    const successRequests = tokens.reduce((sum, t) => sum + (t.success_requests || 0), 0);
    const failedRequests = tokens.reduce((sum, t) => sum + (t.failed_requests || 0), 0);
    const todayStats = ApiLog.getTodayStats();
    const avgResponseTime = ApiLog.getAvgResponseTime();
    
    res.json({
      apiKeys: apiKeys.length,
      tokens: activeTokens.length,
      totalTokens: tokens.length,
      todayRequests: todayStats?.total || 0,
      todaySuccess: todayStats?.success || 0,
      todayErrors: todayStats?.errors || 0,
      todayAvgResponseTime: Math.round(todayStats?.avg_response_time || 0),
      successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 100,
      totalRequests,
      successRequests,
      failedRequests,
      avgResponseTime
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 获取数据分析统计（按时间范围过滤）
router.get('/analytics', (req, res) => {
  try {
    const range = req.query.range || '24h';
    const stats = ApiLog.getAnalyticsByRange(range);

    res.json({
      totalRequests: stats.totalRequests || 0,
      successRequests: stats.successRequests || 0,
      failedRequests: stats.failedRequests || 0,
      avgResponseTime: Math.round(stats.avgResponseTime || 0)
    });
  } catch (error) {
    console.error('获取分析统计失败:', error);
    res.status(500).json({ error: '获取分析统计失败' });
  }
});

// 获取图表数据（基于 SQL 聚合）
router.get('/charts', (req, res) => {
  try {
    const range = req.query.range || '24h';
    const data = ApiLog.getChartsByRange(range);

    const trendLabels = data.trend.map(t => {
      if (range === '24h') {
        const hour = t.period.split(' ')[1];
        return hour || t.period;
      }
      return t.period.split(' ')[0].slice(5);
    });
    const trendData = data.trend.map(t => t.total);
    const trendSuccess = data.trend.map(t => t.success);
    const trendErrors = data.trend.map(t => t.errors);

    const modelLabels = data.models.length > 0 ? data.models.map(m => m.model) : ['暂无数据'];
    const modelData = data.models.length > 0 ? data.models.map(m => m.count) : [1];

    res.json({
      trendLabels,
      trendData,
      trendSuccess,
      trendErrors,
      modelLabels,
      modelData,
      endpoints: data.endpoints
    });
  } catch (error) {
    console.error('获取图表数据失败:', error);
    res.status(500).json({ error: '获取图表数据失败' });
  }
});

// 获取账号统计
router.get('/accounts', (req, res) => {
  try {
    const tokens = Token.getAll();
    
    const accountStats = tokens.map(token => {
      const avgTime = db.prepare(
        'SELECT AVG(response_time) as avg_time FROM api_logs WHERE token_id = ? AND response_time > 0'
      ).get(token.id);

      return {
        id: token.id,
        name: token.name || token.email || token.account_id || 'Unknown',
        requests: token.total_requests || 0,
        successRate: token.total_requests > 0 
          ? Math.round(((token.success_requests || 0) / token.total_requests) * 100) 
          : 100,
        failedRequests: token.failed_requests || 0,
        avgResponseTime: Math.round(avgTime?.avg_time || 0),
        lastUsed: token.last_used_at,
        isActive: !!token.is_active,
        expiredAt: token.expired_at
      };
    });
    
    res.json(accountStats);
  } catch (error) {
    console.error('获取账号统计失败:', error);
    res.status(500).json({ error: '获取账号统计失败' });
  }
});

// 获取最近的日志（按时间范围过滤）
router.get('/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const range = req.query.range || '24h';
    
    const logs = ApiLog.getLogsByRange(limit, range);
    
    const apiKeys = ApiKey.getAll();
    const apiKeyMap = {};
    apiKeys.forEach(key => {
      apiKeyMap[key.id] = key.name || `Key #${key.id}`;
    });
    
    const formattedLogs = logs.map(log => ({
      ...log,
      api_key_name: log.api_key_id ? (apiKeyMap[log.api_key_id] || `Key #${log.api_key_id}`) : '-',
      response_time: log.response_time || 0
    }));
    
    res.json(formattedLogs);
  } catch (error) {
    console.error('获取日志失败:', error);
    res.status(500).json({ error: '获取日志失败' });
  }
});

// 获取最近活动记录
router.get('/recent-activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const activities = [];
    
    const logs = ApiLog.getRecent(20);
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();
    
    const apiKeyMap = {};
    apiKeys.forEach(key => {
      apiKeyMap[key.id] = key.name || `Key #${key.id}`;
    });
    
    logs.forEach(log => {
      const isSuccess = log.status_code >= 200 && log.status_code < 300;
      activities.push({
        type: isSuccess ? 'api_success' : 'api_error',
        icon: isSuccess ? 'fa-check-circle' : 'fa-exclamation-circle',
        color: isSuccess ? 'text-green-600' : 'text-red-600',
        title: isSuccess ? 'API 请求成功' : 'API 请求失败',
        description: `${apiKeyMap[log.api_key_id] || 'Unknown'} 调用 ${log.model || 'Unknown'} 模型`,
        time: log.created_at
      });
    });
    
    apiKeys.slice(-5).forEach(key => {
      activities.push({
        type: 'api_key_created',
        icon: 'fa-key',
        color: 'text-blue-600',
        title: 'API Key 创建',
        description: `创建了新的 API Key: ${key.name || 'Unnamed'}`,
        time: key.created_at
      });
    });
    
    tokens.slice(-5).forEach(token => {
      activities.push({
        type: 'token_added',
        icon: 'fa-user-plus',
        color: 'text-purple-600',
        title: 'Token 添加',
        description: `添加了新账号: ${token.name || token.email || 'Unnamed'}`,
        time: token.created_at
      });
    });
    
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    const recentActivities = activities.slice(0, limit);
    
    res.json(recentActivities);
  } catch (error) {
    console.error('获取最近活动失败:', error);
    res.status(500).json({ error: '获取最近活动失败' });
  }
});

// Token 消耗统计
router.get('/token-usage', (req, res) => {
  try {
    const usage = ApiLog.getTokenUsageStats();
    res.json(usage);
  } catch (error) {
    console.error('获取 Token 消耗统计失败:', error);
    res.status(500).json({ error: '获取 Token 消耗统计失败' });
  }
});

// 高级统计 (Peak RPM, P95, Token排名, Key排名, 成功失败趋势)
router.get('/advanced', (req, res) => {
  try {
    const peakRPM = ApiLog.getPeakRPM();
    const percentiles = ApiLog.getResponseTimePercentiles();
    const topKeys = ApiLog.getTopApiKeys(5);
    const tokenRanking = ApiLog.getTokenPerformanceRanking(10);
    const successErrorTrend = ApiLog.getSuccessErrorTrend(24);

    const topKeysMasked = topKeys.map(k => ({
      ...k,
      key: k.key ? k.key.substring(0, 7) + '...' + k.key.substring(k.key.length - 4) : '-'
    }));

    res.json({
      peakRPM,
      percentiles,
      topKeys: topKeysMasked,
      tokenRanking,
      successErrorTrend
    });
  } catch (error) {
    console.error('获取高级统计失败:', error);
    res.status(500).json({ error: '获取高级统计失败' });
  }
});

export default router;
