import express from 'express';
import { ApiKey } from '../models/index.js';
import { authenticateAdmin, generateApiKey } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticateAdmin);

// 获取所有 API Keys（含统计数据，遮蔽敏感信息）
router.get('/', (req, res) => {
  try {
    const keys = ApiKey.getAllWithStats().map(k => ({
      ...k,
      key: k.key.substring(0, 7) + '...' + k.key.substring(k.key.length - 4)
    }));
    res.json(keys);
  } catch (error) {
    console.error('获取 API Keys 失败:', error);
    res.status(500).json({ error: '获取 API Keys 失败' });
  }
});

// 获取完整密钥（管理员复制用）
router.get('/:id/reveal', (req, res) => {
  try {
    const key = ApiKey.findById(req.params.id);
    if (!key) return res.status(404).json({ error: 'API Key 不存在' });
    res.json({ key: key.key });
  } catch (error) {
    res.status(500).json({ error: '获取密钥失败' });
  }
});

// 获取单个 API Key 详细统计
router.get('/:id/stats', (req, res) => {
  try {
    const { id } = req.params;
    const key = ApiKey.findById(id);
    if (!key) return res.status(404).json({ error: 'API Key 不存在' });

    const stats = ApiKey.getKeyStats(id);
    res.json(stats);
  } catch (error) {
    console.error('获取 API Key 统计失败:', error);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 创建新的 API Key
router.post('/', (req, res) => {
  try {
    const { name, rate_limit, daily_limit, monthly_limit, max_tokens, expires_at, allowed_models, allowed_ips, remark } = req.body;
    const key = generateApiKey();

    const id = ApiKey.create(key, name || '未命名', {
      rate_limit: parseInt(rate_limit) || 0,
      daily_limit: parseInt(daily_limit) || 0,
      monthly_limit: parseInt(monthly_limit) || 0,
      max_tokens: parseInt(max_tokens) || 0,
      expires_at: expires_at || null,
      allowed_models: allowed_models || null,
      allowed_ips: allowed_ips || null,
      remark: remark || null
    });

    res.json({
      success: true,
      id,
      key,
      name: name || '未命名',
      message: '请保存此 API Key，之后将无法再次查看完整密钥'
    });
  } catch (error) {
    console.error('创建 API Key 失败:', error);
    res.status(500).json({ error: '创建 API Key 失败' });
  }
});

// 重命名 API Key
router.put('/:id/rename', (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: '名称不能为空' });
    }

    const key = ApiKey.findById(id);
    if (!key) return res.status(404).json({ error: 'API Key 不存在' });

    ApiKey.updateName(id, name.trim());
    res.json({ success: true, message: '重命名成功' });
  } catch (error) {
    console.error('重命名 API Key 失败:', error);
    res.status(500).json({ error: '重命名失败' });
  }
});

// 更新 API Key 限制设置
router.put('/:id/settings', (req, res) => {
  try {
    const { id } = req.params;
    const key = ApiKey.findById(id);
    if (!key) return res.status(404).json({ error: 'API Key 不存在' });

    const { name, rate_limit, daily_limit, monthly_limit, max_tokens, expires_at, allowed_models, allowed_ips, remark } = req.body;
    ApiKey.updateSettings(id, {
      name: name !== undefined ? name : undefined,
      rate_limit: rate_limit !== undefined ? (parseInt(rate_limit) || 0) : undefined,
      daily_limit: daily_limit !== undefined ? (parseInt(daily_limit) || 0) : undefined,
      monthly_limit: monthly_limit !== undefined ? (parseInt(monthly_limit) || 0) : undefined,
      max_tokens: max_tokens !== undefined ? (parseInt(max_tokens) || 0) : undefined,
      expires_at: expires_at !== undefined ? (expires_at || null) : undefined,
      allowed_models: allowed_models !== undefined ? (allowed_models || null) : undefined,
      allowed_ips: allowed_ips !== undefined ? (allowed_ips || null) : undefined,
      remark: remark !== undefined ? (remark || null) : undefined
    });
    res.json({ success: true, message: '设置已更新' });
  } catch (error) {
    console.error('更新 API Key 设置失败:', error);
    res.status(500).json({ error: '更新设置失败' });
  }
});

// 获取单个 API Key 完整信息（管理员用，含完整 key 以外的所有字段）
router.get('/:id/detail', (req, res) => {
  try {
    const key = ApiKey.findById(req.params.id);
    if (!key) return res.status(404).json({ error: 'API Key 不存在' });
    const dailyUsage = ApiKey.getDailyUsage(key.id);
    const monthlyUsage = ApiKey.getMonthlyUsage(key.id);
    const totalTokens = ApiKey.getTotalTokensConsumed(key.id);
    res.json({
      ...key,
      key: key.key.substring(0, 7) + '...' + key.key.substring(key.key.length - 4),
      current_daily_usage: dailyUsage,
      current_monthly_usage: monthlyUsage,
      current_total_tokens: totalTokens
    });
  } catch (error) {
    res.status(500).json({ error: '获取详情失败' });
  }
});

// 重新生成 API Key
router.post('/:id/regenerate', (req, res) => {
  try {
    const { id } = req.params;
    const existing = ApiKey.findById(id);
    if (!existing) return res.status(404).json({ error: 'API Key 不存在' });

    const newKey = generateApiKey();
    ApiKey.regenerateKey(id, newKey);

    res.json({
      success: true,
      key: newKey,
      message: '密钥已重新生成，请保存新密钥'
    });
  } catch (error) {
    console.error('重新生成 API Key 失败:', error);
    res.status(500).json({ error: '重新生成失败' });
  }
});

// 更新 API Key 状态
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    ApiKey.toggleActive(id, is_active);
    res.json({ success: true });
  } catch (error) {
    console.error('更新 API Key 失败:', error);
    res.status(500).json({ error: '更新 API Key 失败' });
  }
});

// 删除 API Key
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    ApiKey.delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('删除 API Key 失败:', error);
    res.status(500).json({ error: '删除 API Key 失败' });
  }
});

// 批量删除 API Keys
router.post('/batch-delete', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供有效的 ids 数组' });
    }

    const deleted = ApiKey.batchDelete(ids);
    res.json({
      success: true,
      deleted,
      message: `批量删除完成：已删除 ${deleted} 个`
    });
  } catch (error) {
    console.error('批量删除 API Keys 失败:', error);
    res.status(500).json({ error: '批量删除失败' });
  }
});

// 批量启用/禁用 API Keys
router.post('/batch-toggle', (req, res) => {
  try {
    const { ids, is_active } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供有效的 ids 数组' });
    }

    const updated = ApiKey.batchToggle(ids, is_active);
    res.json({
      success: true,
      updated,
      message: `批量操作完成：已${is_active ? '启用' : '禁用'} ${updated} 个`
    });
  } catch (error) {
    console.error('批量操作 API Keys 失败:', error);
    res.status(500).json({ error: '批量操作失败' });
  }
});

export default router;
