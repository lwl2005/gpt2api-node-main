import express from 'express';
import { Token } from '../models/index.js';
import { authenticateAdmin } from '../middleware/auth.js';
import TokenManager from '../tokenManager.js';
import monitor from '../monitor.js';

const router = express.Router();

router.use(authenticateAdmin);

// 获取所有 Tokens（支持分页）
router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const allTokens = Token.getAll();
    const total = allTokens.length;
    const tokens = allTokens.slice(offset, offset + limit);
    
    // 隐藏敏感信息
    const maskedTokens = tokens.map(t => ({
      ...t,
      access_token: t.access_token ? '***' : null,
      refresh_token: t.refresh_token ? '***' : null,
      id_token: t.id_token ? '***' : null
    }));
    
    res.json({
      data: maskedTokens,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取 Tokens 失败:', error);
    res.status(500).json({ error: '获取 Tokens 失败' });
  }
});

// 创建 Token
router.post('/', async (req, res) => {
  try {
    const { name, access_token, refresh_token, id_token, email, account_id, expired_at, expired, last_refresh_at, last_refresh } = req.body;

    // 验证必需字段
    if (!access_token || !refresh_token) {
      return res.status(400).json({ error: 'access_token 和 refresh_token 是必需的' });
    }

    // 创建 Token 记录（支持旧字段名兼容）
    const id = Token.create({
      name: name || '未命名账户',
      email,
      account_id,
      access_token,
      refresh_token,
      id_token,
      expired_at: expired_at || expired || null,
      last_refresh_at: last_refresh_at || last_refresh || null
    });

    res.json({
      success: true,
      id,
      message: 'Token 添加成功'
    });
  } catch (error) {
    console.error('添加 Token 失败:', error);
    res.status(500).json({ error: '添加 Token 失败: ' + error.message });
  }
});

// 导入前查重检查
router.post('/check-duplicates', (req, res) => {
  try {
    const { tokens } = req.body;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: '请提供有效的 tokens 数组' });
    }

    const existingSet = Token.getAllAccessTokens();
    const results = tokens.map((t, i) => {
      const isDuplicate = t.access_token ? existingSet.has(t.access_token) : false;
      return {
        index: i,
        name: t.name || t.email || t.account_id || `Token ${i + 1}`,
        valid: !!(t.access_token && t.refresh_token),
        duplicate: isDuplicate
      };
    });

    const duplicateCount = results.filter(r => r.duplicate).length;
    const invalidCount = results.filter(r => !r.valid).length;
    const newCount = results.filter(r => r.valid && !r.duplicate).length;

    res.json({ total: tokens.length, newCount, duplicateCount, invalidCount, items: results });
  } catch (error) {
    res.status(500).json({ error: '查重失败: ' + error.message });
  }
});

// 批量导入 Tokens（含查重、可选跳过/覆盖）
router.post('/import', async (req, res) => {
  try {
    const { tokens, skipDuplicates = true, updateDuplicates = false } = req.body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: '请提供有效的 tokens 数组' });
    }

    const existingSet = Token.getAllAccessTokens();
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    const errors = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      try {
        if (!token.access_token || !token.refresh_token) {
          failedCount++;
          errors.push(`#${i + 1}: 缺少 access_token 或 refresh_token`);
          continue;
        }

        const isDuplicate = existingSet.has(token.access_token);

        if (isDuplicate) {
          if (updateDuplicates) {
            const existing = Token.findByAccessToken(token.access_token);
            if (existing) {
              Token.update(existing.id, {
                access_token: token.access_token,
                refresh_token: token.refresh_token,
                id_token: token.id_token || null,
                expired_at: token.expired_at || token.expired || null
              });
              updatedCount++;
              continue;
            }
          }
          if (skipDuplicates) {
            skippedCount++;
            continue;
          }
        }

        Token.create({
          name: token.name || token.email || token.account_id || `导入账户 ${i + 1}`,
          email: token.email,
          account_id: token.account_id,
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          id_token: token.id_token,
          expired_at: token.expired_at || token.expired || null,
          last_refresh_at: token.last_refresh_at || token.last_refresh || null
        });

        existingSet.add(token.access_token);
        successCount++;
      } catch (error) {
        failedCount++;
        errors.push(`#${i + 1}: ${error.message}`);
      }
    }

    res.json({
      success: successCount > 0 || updatedCount > 0,
      total: tokens.length,
      successCount,
      updatedCount,
      skippedCount,
      failed: failedCount,
      errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
      message: `导入完成：新增 ${successCount}，更新 ${updatedCount}，跳过重复 ${skippedCount}，失败 ${failedCount}`
    });
  } catch (error) {
    console.error('批量导入 Tokens 失败:', error);
    res.status(500).json({ error: '批量导入失败: ' + error.message });
  }
});

// 更新 Token
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
    Token.toggleActive(id, is_active);
    res.json({ success: true });
  } catch (error) {
    console.error('更新 Token 失败:', error);
    res.status(500).json({ error: '更新 Token 失败' });
  }
});

// 手动刷新 Token
router.post('/:id/refresh', async (req, res) => {
  try {
    const { id } = req.params;
    const token = Token.findById(id);

    if (!token) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    if (!token.refresh_token) {
      return res.status(400).json({ error: '该 Token 没有 refresh_token，无法刷新' });
    }

    const manager = new TokenManager(null);
    manager.tokenData = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      id_token: token.id_token,
      expired_at: token.expired_at,
      last_refresh_at: token.last_refresh_at
    };

    const newData = await manager.refreshTokenOnly();

    Token.update(id, {
      access_token: newData.access_token,
      refresh_token: newData.refresh_token,
      id_token: newData.id_token,
      expired_at: newData.expired_at
    });

    res.json({
      success: true,
      message: 'Token 刷新成功',
      expired_at: newData.expired_at
    });
  } catch (error) {
    console.error('刷新 Token 失败:', error);
    res.status(500).json({ error: `刷新 Token 失败: ${error.message}` });
  }
});

// 获取 Token 健康监控状态
router.get('/health', (req, res) => {
  try {
    res.json(monitor.getStatus());
  } catch (error) {
    console.error('获取监控状态失败:', error);
    res.status(500).json({ error: '获取监控状态失败' });
  }
});

// 批量刷新所有 Token
router.post('/refresh-all', async (req, res) => {
  try {
    const tokens = Token.getActive();
    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const token of tokens) {
      if (!token.refresh_token) {
        failedCount++;
        errors.push(`Token #${token.id}: 缺少 refresh_token`);
        continue;
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
        successCount++;
      } catch (error) {
        failedCount++;
        errors.push(`Token #${token.id}: ${error.message}`);
      }
    }

    res.json({
      success: true,
      total: tokens.length,
      refreshed: successCount,
      failed: failedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `批量刷新完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量刷新 Token 失败:', error);
    res.status(500).json({ error: '批量刷新失败: ' + error.message });
  }
});

// 删除 Token
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    Token.delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('删除 Token 失败:', error);
    res.status(500).json({ error: '删除 Token 失败' });
  }
});

// 批量删除 Tokens
router.post('/batch-delete', (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供有效的 ids 数组' });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      
      try {
        Token.delete(id);
        successCount++;
      } catch (error) {
        failedCount++;
        errors.push(`ID ${id}: ${error.message}`);
      }
    }

    res.json({
      success: successCount > 0,
      total: ids.length,
      successCount,
      failed: failedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `批量删除完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量删除 Tokens 失败:', error);
    res.status(500).json({ error: '批量删除失败: ' + error.message });
  }
});

// 刷新 Token 额度（使用真实 token 消耗数据）
router.post('/:id/quota', async (req, res) => {
  try {
    const { id } = req.params;
    const token = Token.findById(id);

    if (!token) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    let planType = 'free';
    let totalQuota = 50000;

    if (token.id_token) {
      try {
        const parts = token.id_token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          const authInfo = payload['https://api.openai.com/auth'];
          if (authInfo && authInfo.chatgpt_plan_type) {
            planType = authInfo.chatgpt_plan_type.toLowerCase();
            if (planType.includes('plus') || planType.includes('pro')) {
              totalQuota = 500000;
            } else if (planType.includes('team')) {
              totalQuota = 1000000;
            }
          }
        }
      } catch (e) {
        console.warn('解析 ID Token 失败:', e.message);
      }
    }

    const realUsage = Token.getRealTokenUsage(id);
    const realUsed = realUsage?.total_tokens || 0;
    const remaining = Math.max(0, totalQuota - realUsed);

    const failureRate = token.total_requests > 0
      ? (token.failed_requests || 0) / token.total_requests
      : 0;

    const quota = {
      total: totalQuota,
      used: realUsed,
      remaining: remaining,
      plan_type: planType,
      failure_rate: Math.round(failureRate * 100),
      input_tokens: realUsage?.input_tokens || 0,
      output_tokens: realUsage?.output_tokens || 0
    };

    Token.updateQuota(id, quota);

    res.json({
      success: true,
      quota,
      message: '额度已更新（基于真实 Token 消耗数据）'
    });
  } catch (error) {
    console.error('刷新额度失败:', error);
    res.status(500).json({ error: '刷新额度失败: ' + error.message });
  }
});

// 批量刷新所有 Token 额度（使用真实数据）
router.post('/quota/refresh-all', async (req, res) => {
  try {
    const tokens = Token.getAll();
    let successCount = 0;
    let failedCount = 0;

    for (const token of tokens) {
      try {
        let planType = 'free';
        let totalQuota = 50000;

        if (token.id_token) {
          try {
            const parts = token.id_token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
              const authInfo = payload['https://api.openai.com/auth'];
              if (authInfo && authInfo.chatgpt_plan_type) {
                planType = authInfo.chatgpt_plan_type.toLowerCase();
                if (planType.includes('plus') || planType.includes('pro')) {
                  totalQuota = 500000;
                } else if (planType.includes('team')) {
                  totalQuota = 1000000;
                }
              }
            }
          } catch (e) {}
        }

        const realUsage = Token.getRealTokenUsage(token.id);
        const realUsed = realUsage?.total_tokens || 0;
        const remaining = Math.max(0, totalQuota - realUsed);

        Token.updateQuota(token.id, { total: totalQuota, used: realUsed, remaining });
        successCount++;
      } catch (error) {
        console.error(`刷新 Token ${token.id} 额度失败:`, error);
        failedCount++;
      }
    }

    res.json({
      success: successCount > 0,
      total: tokens.length,
      successCount,
      failed: failedCount,
      message: `批量刷新完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量刷新额度失败:', error);
    res.status(500).json({ error: '批量刷新失败: ' + error.message });
  }
});

export default router;
