// ==================== 工具函数 ====================

function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function getTimeAgo(ts) {
  if (!ts) return '';
  let t = new Date(ts);
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) t = new Date(ts + 'Z');
  const diff = Math.floor((Date.now() - t.getTime()) / 1000);
  if (diff < 0) return '刚刚';
  if (diff < 60) return diff + '秒前';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `${h}小时${m}分前` : `${h}小时前`;
  }
  if (diff < 604800) {
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    return h > 0 ? `${d}天${h}小时前` : `${d}天前`;
  }
  return t.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatFullTime(ts) {
  if (!ts) return '';
  let t = new Date(ts);
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) t = new Date(ts + 'Z');
  return t.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}时 ${m}分`;
  if (h > 0) return `${h}时 ${m}分`;
  return `${m}分`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板', 'success', 1500)).catch(() => toast('复制失败', 'error'));
}

function formatTokenCount(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatMs(ms) {
  if (!ms || ms === 0) return '0ms';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms) + 'ms';
}

// ==================== Toast 通知 ====================

function toast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const colors = {
    success: 'bg-emerald-500', error: 'bg-red-500', info: 'bg-blue-500', warning: 'bg-amber-500'
  };
  const icons = {
    success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle', warning: 'fa-triangle-exclamation'
  };
  const el = document.createElement('div');
  el.className = `toast flex items-center space-x-3 px-4 py-3.5 rounded-xl shadow-lg shadow-black/10 text-white text-[13px] font-medium ${colors[type]} min-w-[260px]`;
  el.innerHTML = `<i class="fas ${icons[type]} text-sm"></i><span class="flex-1">${escapeHtml(message)}</span><button onclick="this.parentElement.remove()" class="opacity-60 hover:opacity-100 transition"><i class="fas fa-xmark text-xs"></i></button>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(30px)'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ==================== 自定义确认弹窗 ====================

let confirmResolveCallback = null;

function showConfirm(title, text, btnText = '确认', btnColor = 'bg-red-500 hover:bg-red-600') {
  return new Promise(resolve => {
    confirmResolveCallback = resolve;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').textContent = text;
    const btn = document.getElementById('confirmBtn');
    btn.textContent = btnText;
    btn.className = `flex-1 px-4 py-2.5 ${btnColor} text-white rounded-xl transition text-sm font-medium`;
    document.getElementById('confirmModal').classList.remove('hidden');
  });
}

function confirmResolve(value) {
  document.getElementById('confirmModal').classList.add('hidden');
  if (confirmResolveCallback) { confirmResolveCallback(value); confirmResolveCallback = null; }
}

// ==================== 初始化 ====================

let currentPage = 'dashboard';
let autoRefreshTimer = null;
const serverStartTime = Date.now();

document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadDashboard();
  startAutoRefresh();
  startUptimeCounter();
});

async function checkAuth() {
  try {
    const r = await fetch('/admin/auth/check');
    if (!r.ok) window.location.href = '/admin/login.html';
  } catch { window.location.href = '/admin/login.html'; }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (currentPage === 'dashboard') loadDashboard();
    else if (currentPage === 'monitor') loadMonitor();
  }, 30000);
}

let uptimeSeconds = 0;
function startUptimeCounter() {
  fetch('/health').then(r => r.json()).then(d => {
    uptimeSeconds = d.uptime || 0;
    updateUptimeDisplay();
    setInterval(() => { uptimeSeconds++; updateUptimeDisplay(); }, 1000);
  }).catch(() => {});
}

function updateUptimeDisplay() {
  const el = document.getElementById('sidebarUptime');
  if (el) el.textContent = formatUptime(uptimeSeconds);
}

function refreshCurrentPage() {
  const map = {
    dashboard: loadDashboard, accounts: () => loadTokens(), apikeys: loadApiKeys,
    monitor: loadMonitor, analytics: loadAnalytics, settings: loadSettings
  };
  if (map[currentPage]) map[currentPage]();
  document.getElementById('lastRefreshTime').textContent = new Date().toLocaleTimeString('zh-CN') + ' 已刷新';
}

// ==================== 页面切换 ====================

function switchPage(event, page) {
  event.preventDefault();
  currentPage = page;
  
  document.querySelectorAll('.nav-item').forEach(i => { i.classList.remove('active'); i.classList.add('text-slate-400'); });
  event.currentTarget.classList.add('active');
  event.currentTarget.classList.remove('text-slate-400');

  ['dashboard', 'accounts', 'apikeys', 'monitor', 'analytics', 'settings'].forEach(p => {
    document.getElementById(p + 'Page').classList.add('hidden');
  });

  const titles = {
    dashboard: ['仪表盘', '系统概览和实时数据'],
    accounts: ['账号管理', 'Token 账户管理与额度监控'],
    apikeys: ['API Keys', 'API 密钥管理与分配'],
    monitor: ['健康监控', 'Token 自动检测与封停恢复'],
    analytics: ['数据分析', 'API 请求统计和趋势分析'],
    settings: ['系统设置', '监控配置与安全管理']
  };
  document.getElementById('pageTitle').textContent = titles[page][0];
  document.getElementById('pageDesc').textContent = titles[page][1];
  document.getElementById(page + 'Page').classList.remove('hidden');

  const loaders = {
    dashboard: loadDashboard, accounts: () => { loadTokens(); loadLoadBalanceStrategy(); },
    apikeys: loadApiKeys, monitor: loadMonitor, analytics: loadAnalytics, settings: loadSettings
  };
  if (loaders[page]) loaders[page]();
}

// ==================== Dashboard ====================

async function loadDashboard() {
  try {
    const [stats, health, monitorData, healthData, advanced] = await Promise.all([
      fetch('/admin/stats').then(r => r.json()),
      fetch('/admin/monitor/health-summary').then(r => r.json()),
      fetch('/admin/monitor').then(r => r.json()),
      fetch('/health').then(r => r.json()),
      fetch('/admin/stats/advanced').then(r => r.json()).catch(() => null)
    ]);

    animateNumber('tokensCount', stats.tokens || 0);
    animateNumber('apiKeysCount', stats.apiKeys || 0);
    animateNumber('todayRequests', stats.todayRequests || 0);
    document.getElementById('successRate').textContent = (stats.successRate || 100) + '%';
    document.getElementById('successRateBar').style.width = (stats.successRate || 100) + '%';
    document.getElementById('dashAvgTime').innerHTML = (stats.avgResponseTime || 0) + '<span class="text-sm font-medium text-slate-400">ms</span>';

    document.getElementById('healthyCount').textContent = health.healthy || 0;
    document.getElementById('unhealthyCount').textContent = health.unhealthy || 0;
    document.getElementById('disabledCount').textContent = health.disabled || 0;

    // 并发和重试信息
    const conc = healthData.concurrency || {};
    document.getElementById('dashInFlight').textContent = conc.totalInFlight || 0;
    document.getElementById('dashMaxRetries').textContent = '最大重试 ' + (conc.maxRetries || 8) + ' 次';
    document.getElementById('dashRetryInfo').textContent = '故障转移: ' + (conc.failoverDelay || '0ms');

    const navCount = document.getElementById('navTokenCount');
    if (navCount) navCount.textContent = stats.tokens || 0;
    const navAkCount = document.getElementById('navApiKeyCount');
    if (navAkCount) navAkCount.textContent = stats.apiKeys || 0;

    const upStatus = monitorData.upstreamStatus || 'unknown';
    const upEl = document.getElementById('dashUpstream');
    upEl.textContent = upStatus === 'online' ? '在线' : upStatus === 'offline' ? '离线' : '未知';
    upEl.className = `text-[11px] font-bold ${upStatus === 'online' ? 'text-emerald-500' : upStatus === 'offline' ? 'text-red-500' : 'text-slate-400'}`;

    const runEl = document.getElementById('dashMonitorRunning');
    runEl.textContent = monitorData.running ? '运行中' : '已停止';
    runEl.className = `text-[11px] font-bold ${monitorData.running ? 'text-emerald-500' : 'text-red-500'}`;

    document.getElementById('dashCheckInterval').textContent = (monitorData.intervals?.activeCheckMinutes || '--') + ' 分钟';
    document.getElementById('dashTotalDisabled').textContent = monitorData.tokensDisabled || 0;
    document.getElementById('dashTotalRecovered').textContent = monitorData.tokensRecovered || 0;

    document.getElementById('navMonitorDot').className = `w-2 h-2 rounded-full ml-auto ${monitorData.running ? 'bg-emerald-400 health-pulse' : 'bg-slate-500'}`;

    try {
      const tokenUsage = await fetch('/admin/stats/token-usage').then(r => r.json());
      const todayTokens = tokenUsage.today?.total_tokens || 0;
      document.getElementById('dashTodayTokens').textContent = formatTokenCount(todayTokens) + ' tokens';
    } catch {}

    // System info - FIX: 动态设置 RPM
    if (healthData.uptime) { uptimeSeconds = healthData.uptime; updateUptimeDisplay(); }
    document.getElementById('dashUptime').textContent = formatUptime(healthData.uptime);
    const strategyMap = { 'round-robin': '轮询', 'random': '随机', 'least-used': '最少使用' };
    document.getElementById('dashStrategy').textContent = strategyMap[healthData.loadBalanceStrategy] || healthData.loadBalanceStrategy || '--';
    document.getElementById('dashTotalReq').textContent = (healthData.requests?.total || 0).toLocaleString();

    // FIX: 动态更新 dashRateLimit
    const rpmSetting = parseInt(healthData.rateLimitRpm) || parseInt(process?.env?.RATE_LIMIT_RPM) || 60;
    document.getElementById('dashRateLimit').textContent = rpmSetting + ' RPM';

    // 今日错误
    document.getElementById('dashTodayErrors').textContent = stats.todayErrors || 0;

    // Advanced stats
    if (advanced) {
      document.getElementById('dashPeakRPM').textContent = advanced.peakRPM?.rpm || 0;

      const p = advanced.percentiles || {};
      document.getElementById('dashP50').textContent = formatMs(p.p50);
      document.getElementById('dashP95').textContent = formatMs(p.p95);
      document.getElementById('dashP99').textContent = formatMs(p.p99);

      renderDashTopKeys(advanced.topKeys || []);
      renderDashTokenRanking(advanced.tokenRanking || []);
    }
  } catch (e) { console.error('Dashboard load error:', e); }

  loadRecentActivity();
}

function renderDashTopKeys(keys) {
  const el = document.getElementById('dashTopKeys');
  if (!keys.length || !keys[0].total_requests) {
    el.innerHTML = '<div class="text-center py-4 text-[11px] text-slate-400"><i class="fas fa-inbox text-lg mb-1 block text-slate-300"></i>暂无数据</div>';
    return;
  }
  const maxReq = Math.max(...keys.map(k => k.total_requests), 1);
  el.innerHTML = keys.filter(k => k.total_requests > 0).slice(0, 5).map((k, i) => {
    const pct = Math.round((k.total_requests / maxReq) * 100);
    const medal = i === 0 ? 'text-amber-500' : i === 1 ? 'text-slate-400' : i === 2 ? 'text-amber-700' : 'text-slate-300';
    return `<div class="flex items-center space-x-2.5 p-2 rounded-xl hover:bg-slate-50 transition">
      <span class="text-[11px] font-extrabold ${medal} w-5 text-center">${i+1}</span>
      <div class="flex-1 min-w-0">
        <p class="text-[11px] font-semibold text-slate-700 truncate">${escapeHtml(k.name || '未命名')}</p>
        <div class="flex items-center mt-1">
          <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden mr-2">
            <div class="h-full bg-gradient-to-r from-amber-400 to-orange-500 rounded-full progress-bar" style="width:${pct}%"></div>
          </div>
          <span class="text-[10px] font-bold text-slate-500 whitespace-nowrap">${k.total_requests.toLocaleString()}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderDashTokenRanking(tokens) {
  const el = document.getElementById('dashTokenRanking');
  if (!tokens.length || !tokens[0].total_requests) {
    el.innerHTML = '<div class="text-center py-4 text-[11px] text-slate-400"><i class="fas fa-inbox text-lg mb-1 block text-slate-300"></i>暂无数据</div>';
    return;
  }
  el.innerHTML = tokens.filter(t => t.total_requests > 0).slice(0, 8).map((t, i) => {
    const sr = t.total_requests > 0 ? Math.round((t.success_requests / t.total_requests) * 100) : 100;
    const srColor = sr >= 95 ? 'text-emerald-500' : sr >= 80 ? 'text-amber-500' : 'text-red-500';
    return `<div class="flex items-center space-x-2.5 p-2 rounded-xl hover:bg-slate-50 transition">
      <span class="text-[11px] font-bold text-slate-300 w-5 text-center">${i+1}</span>
      <div class="flex-1 min-w-0">
        <p class="text-[11px] font-semibold text-slate-700 truncate">${escapeHtml(t.name || t.email || `Token #${t.id}`)}</p>
        <div class="flex items-center space-x-2 mt-0.5">
          <span class="text-[10px] text-slate-400">${t.total_requests} 次</span>
          <span class="text-[10px] font-bold ${srColor}">${sr}%</span>
          <span class="text-[10px] text-slate-400">${formatMs(t.avg_response_time)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const diff = target - current;
  const steps = 20;
  const stepSize = diff / steps;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    el.textContent = Math.round(current + stepSize * step);
    if (step >= steps) { el.textContent = target; clearInterval(timer); }
  }, 25);
}

async function loadRecentActivity() {
  try {
    const activities = await fetch('/admin/stats/recent-activity?limit=10').then(r => r.json());
    const container = document.getElementById('recentActivity');
    if (!activities.length) {
      container.innerHTML = '<div class="text-center py-8 text-slate-400 text-[11px]"><i class="fas fa-inbox text-2xl mb-2 block text-slate-300"></i>暂无活动</div>';
      return;
    }
    container.innerHTML = activities.map(a => `
      <div class="flex items-center space-x-3 py-2 px-3 rounded-xl hover:bg-slate-50 transition group">
        <div class="w-8 h-8 rounded-lg bg-slate-50 flex items-center justify-center flex-shrink-0 group-hover:bg-white transition">
          <i class="fas ${a.icon} ${a.color} text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-semibold text-slate-700 truncate">${escapeHtml(a.title)}</p>
          <p class="text-[10px] text-slate-400 truncate">${escapeHtml(a.description)}</p>
        </div>
        <span class="text-[10px] text-slate-300 flex-shrink-0 font-medium" title="${formatFullTime(a.time)}">${getTimeAgo(a.time)}</span>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

// ==================== Accounts (Tokens) ====================

let currentTokenPage = 1, tokenPageSize = 20, totalTokens = 0;
let selectedTokens = new Set();
let allTokensCache = [];

async function loadTokens(page = 1) {
  try {
    currentTokenPage = page;
    selectedTokens.clear();
    updateBatchDeleteButton();
    
    const result = await fetch(`/admin/tokens?page=${page}&limit=${tokenPageSize}`).then(r => r.json());
    const data = result.data || [];
    allTokensCache = data;
    const pagination = result.pagination || {};
    totalTokens = pagination.total || 0;
    
    document.getElementById('totalTokensCount').textContent = totalTokens + ' 个';
    renderTokenTable(data);
    updateTokenPagination(pagination.page, pagination.totalPages);
  } catch (e) { console.error('Load tokens error:', e); }
}

function renderTokenTable(data) {
    const tbody = document.getElementById('tokensTable');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-14 text-slate-400"><i class="fas fa-inbox text-3xl mb-3 block text-slate-300"></i><span class="text-sm">暂无 Token</span></td></tr>';
      return;
    }
    
  tbody.innerHTML = data.map(t => {
    const qt = t.quota_total || 0, qu = t.quota_used || 0, qr = t.quota_remaining || 0;
    const qp = qt > 0 ? Math.min(100, Math.round((qu / qt) * 100)) : 0;
    const barColor = qp > 80 ? 'bg-red-500' : qp > 50 ? 'bg-amber-400' : 'bg-emerald-500';
    const barBg = qp > 80 ? 'bg-red-100' : qp > 50 ? 'bg-amber-100' : 'bg-emerald-100';

    const hs = t.health_status || 'unknown';
    const healthBadge = {
      healthy: '<span class="tag bg-emerald-50 text-emerald-600"><i class="fas fa-circle text-[5px] mr-1"></i>健康</span>',
      unhealthy: '<span class="tag bg-amber-50 text-amber-600"><i class="fas fa-circle text-[5px] mr-1"></i>异常</span>',
      disabled: '<span class="tag bg-red-50 text-red-500"><i class="fas fa-circle text-[5px] mr-1"></i>封停</span>',
      unknown: '<span class="tag bg-slate-50 text-slate-400"><i class="fas fa-circle text-[5px] mr-1"></i>未检测</span>'
    }[hs] || '<span class="tag bg-slate-50 text-slate-400">未知</span>';

    const sr = t.total_requests > 0 ? Math.round((t.success_requests || 0) / t.total_requests * 100) : 100;

    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-3.5 px-4"><input type="checkbox" class="token-checkbox rounded border-slate-300" value="${t.id}" onchange="toggleTokenSelection(${t.id})" /></td>
      <td class="py-3.5 px-4">
        <p class="text-[13px] font-semibold text-slate-700">${escapeHtml(t.name || t.email || '-')}</p>
        <p class="text-[10px] text-slate-400 mt-0.5 font-medium">#${t.id} ${t.expired_at ? '· 过期 ' + new Date(t.expired_at).toLocaleDateString('zh-CN') : ''}</p>
        </td>
      <td class="py-3.5 px-4" style="min-width:170px;">
        ${qt > 0 ? `
          <div class="flex items-center justify-between text-[10px] mb-1.5">
            <span class="text-slate-500 font-medium">已用 ${qu.toLocaleString()}</span>
            <span class="font-bold ${qp > 80 ? 'text-red-500' : qp > 50 ? 'text-amber-500' : 'text-emerald-500'}">${qp}%</span>
          </div>
          <div class="w-full h-2 ${barBg} rounded-full overflow-hidden">
            <div class="h-full ${barColor} rounded-full progress-bar" style="width:${qp}%"></div>
          </div>
          <p class="text-[10px] text-slate-400 mt-1 font-medium">剩 ${qr.toLocaleString()} / ${qt.toLocaleString()}</p>
        ` : '<span class="text-[10px] text-slate-300 font-medium">未获取</span>'}
      </td>
      <td class="py-3.5 px-4">
        <div class="text-[11px] font-medium">
          <span class="text-slate-700 font-bold">${t.total_requests || 0}</span>
          <span class="text-slate-300 mx-0.5">/</span>
          <span class="text-emerald-500">${t.success_requests || 0}</span>
          <span class="text-slate-300 mx-0.5">/</span>
          <span class="text-red-400">${t.failed_requests || 0}</span>
        </div>
        <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1.5">
          <div class="h-full bg-emerald-400 rounded-full progress-bar" style="width:${sr}%"></div>
        </div>
        <p class="text-[10px] text-slate-400 mt-0.5 font-medium">${sr}% 成功率</p>
      </td>
      <td class="py-3.5 px-4">${healthBadge}</td>
      <td class="py-3.5 px-4">
        <span class="tag ${t.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}">
          ${t.is_active ? '启用' : '禁用'}
          </span>
        </td>
      <td class="py-3.5 px-4">
        <div class="flex items-center space-x-0.5">
          <button onclick="testSingleToken(${t.id})" class="p-1.5 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition" title="测试">
            <i class="fas fa-vial text-xs"></i>
          </button>
          <button onclick="refreshTokenQuota(${t.id})" class="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition" title="刷新额度">
            <i class="fas fa-sync-alt text-xs"></i>
          </button>
          <button onclick="toggleToken(${t.id}, ${t.is_active})" class="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition" title="${t.is_active ? '禁用' : '启用'}">
            <i class="fas fa-${t.is_active ? 'pause' : 'play'} text-xs"></i>
          </button>
          <button onclick="deleteToken(${t.id})" class="p-1.5 text-red-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition" title="删除">
            <i class="fas fa-trash text-xs"></i>
          </button>
        </div>
        </td>
    </tr>`;
    }).join('');
}

function handleTokenSearch() {
  const q = document.getElementById('tokenSearchInput').value.trim().toLowerCase();
  if (!q) { renderTokenTable(allTokensCache); return; }
  const filtered = allTokensCache.filter(t =>
    (t.name || '').toLowerCase().includes(q) ||
    (t.email || '').toLowerCase().includes(q) ||
    String(t.id).includes(q)
  );
  renderTokenTable(filtered);
}

function updateTokenPagination(page, totalPages) {
  const el = document.getElementById('tokenPagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  let html = `<div class="flex items-center justify-between">
    <span class="text-[11px] text-slate-400 font-medium">${totalTokens} 个账号 · 第 ${page}/${totalPages} 页</span>
    <div class="flex space-x-1.5">`;
  if (page > 1) html += `<button onclick="loadTokens(${page-1})" class="px-3.5 py-1.5 text-[11px] font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition">上一页</button>`;
  for (let i = Math.max(1, page-2); i <= Math.min(totalPages, page+2); i++) {
    html += `<button onclick="loadTokens(${i})" class="px-3 py-1.5 text-[11px] font-medium rounded-lg transition ${i === page ? 'bg-blue-500 text-white' : 'border border-slate-200 hover:bg-slate-50'}">${i}</button>`;
  }
  if (page < totalPages) html += `<button onclick="loadTokens(${page+1})" class="px-3.5 py-1.5 text-[11px] font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition">下一页</button>`;
  html += '</div></div>';
  el.innerHTML = html;
}

async function testSingleToken(id) {
  toast('正在测试 Token #' + id + '...', 'info');
  try {
    const data = await fetch(`/admin/monitor/test-token/${id}`, { method: 'POST' }).then(r => r.json());
    if (data.status === 'ok' || data.recovered) {
      toast(`Token #${id}: ${data.message}${data.recovered ? ' (已自动恢复)' : ''}`, 'success');
  } else {
      toast(`Token #${id}: ${data.message}`, 'error');
    }
    loadTokens(currentTokenPage);
  } catch (e) { toast('测试失败: ' + e.message, 'error'); }
}

async function refreshTokenQuota(id) {
  try {
    const data = await fetch(`/admin/tokens/${id}/quota`, { method: 'POST' }).then(r => r.json());
    if (data.success) { toast(`Token #${id} 额度已更新`, 'success'); loadTokens(currentTokenPage); }
    else toast('刷新失败: ' + (data.error || ''), 'error');
  } catch (e) { toast('刷新失败: ' + e.message, 'error'); }
}

async function refreshAllQuotas() {
  toast('正在刷新所有额度...', 'info');
  try {
    const data = await fetch('/admin/tokens/quota/refresh-all', { method: 'POST' }).then(r => r.json());
    toast(`完成: ${data.successCount || 0} 成功, ${data.failed || 0} 失败`, data.failed > 0 ? 'warning' : 'success');
    loadTokens(currentTokenPage);
  } catch (e) { toast('批量刷新失败', 'error'); }
}

async function toggleToken(id, active) {
  try {
    await fetch(`/admin/tokens/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !active }) });
    toast(active ? '已禁用' : '已启用', 'success');
    loadTokens(currentTokenPage);
  } catch (e) { toast('操作失败', 'error'); }
}

async function deleteToken(id) {
  const ok = await showConfirm('删除 Token', `确定删除 Token #${id}？此操作不可恢复。`, '删除', 'bg-red-500 hover:bg-red-600');
  if (!ok) return;
  try {
    await fetch(`/admin/tokens/${id}`, { method: 'DELETE' });
    toast('已删除', 'success');
    loadTokens(currentTokenPage);
  } catch (e) { toast('删除失败', 'error'); }
}

function exportTokens() {
  toast('正在导出...', 'info', 1500);
  fetch('/admin/tokens?page=1&limit=10000').then(r => r.json()).then(result => {
    const data = (result.data || []).map(t => ({
      id: t.id, name: t.name, email: t.email, is_active: t.is_active,
      health_status: t.health_status, total_requests: t.total_requests,
      success_requests: t.success_requests, failed_requests: t.failed_requests,
      quota_total: t.quota_total, quota_used: t.quota_used, quota_remaining: t.quota_remaining
    }));
    downloadJson(data, `tokens-export-${new Date().toISOString().slice(0,10)}.json`);
    toast('导出完成', 'success');
  }).catch(() => toast('导出失败', 'error'));
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ==================== Batch operations ====================

function toggleTokenSelection(id) {
  selectedTokens.has(id) ? selectedTokens.delete(id) : selectedTokens.add(id);
  updateBatchDeleteButton();
}

function toggleSelectAll() {
  const cb = document.getElementById('selectAllTokens');
  document.querySelectorAll('.token-checkbox').forEach(c => { c.checked = cb.checked; const id = parseInt(c.value); cb.checked ? selectedTokens.add(id) : selectedTokens.delete(id); });
  updateBatchDeleteButton();
}

function updateBatchDeleteButton() {
  const btn = document.getElementById('batchDeleteBtn');
  const cnt = document.getElementById('selectedCount');
  if (selectedTokens.size > 0) { btn.classList.remove('hidden'); cnt.textContent = selectedTokens.size; } else { btn.classList.add('hidden'); }
}

async function batchDeleteTokens() {
  const ok = await showConfirm('批量删除', `确定删除 ${selectedTokens.size} 个账号？此操作不可恢复。`, '全部删除', 'bg-red-500 hover:bg-red-600');
  if (!ok) return;
  try {
    const data = await fetch('/admin/tokens/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedTokens) }) }).then(r => r.json());
    toast(`删除完成: ${data.successCount || 0} 成功`, 'success');
    selectedTokens.clear();
    loadTokens(currentTokenPage);
  } catch (e) { toast('批量删除失败', 'error'); }
}

// ==================== API Keys ====================

let allApiKeysCache = [];
let selectedApiKeys = new Set();
let lastCreatedKey = '';
let lastRegenKey = '';

async function loadApiKeys() {
  try {
    const data = await fetch('/admin/api-keys').then(r => r.json());
    allApiKeysCache = data;
    selectedApiKeys.clear();
    updateApiKeyBatchButton();

    const total = data.length;
    const active = data.filter(k => k.is_active).length;
    const todayReqs = data.reduce((s, k) => s + (k.today_requests || 0), 0);
    const totalTokens = data.reduce((s, k) => s + (k.total_tokens_consumed || 0), 0);

    animateNumber('akTotalCount', total);
    animateNumber('akActiveCount', active);
    animateNumber('akTodayReqs', todayReqs);
    document.getElementById('akTotalTokens').textContent = formatTokenCount(totalTokens);
    document.getElementById('akListCount').textContent = total + ' 个';

    renderApiKeysTable(data);
  } catch (e) { console.error(e); }
}

function renderApiKeysTable(data) {
  const tbody = document.getElementById('apiKeysTable');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-14 text-slate-400"><i class="fas fa-key text-3xl mb-3 block text-slate-300"></i><span class="text-sm">暂无 API Key</span></td></tr>';
      return;
    }
  tbody.innerHTML = data.map(k => {
    const logTotal = k.log_total_requests || k.usage_count || 0;
    const logSuccess = k.log_success_requests || 0;
    const sr = logTotal > 0 ? Math.round(logSuccess / logTotal * 100) : 100;
    const todayReqs = k.today_requests || 0;
    const totalTokens = k.total_tokens_consumed || 0;

    const limits = [];
    if (k.rate_limit > 0) limits.push(`<span class="tag bg-blue-50 text-blue-600">${k.rate_limit} RPM</span>`);
    if (k.daily_limit > 0) limits.push(`<span class="tag bg-violet-50 text-violet-600">日 ${k.daily_limit}</span>`);
    if (k.monthly_limit > 0) limits.push(`<span class="tag bg-indigo-50 text-indigo-600">月 ${k.monthly_limit}</span>`);
    if (k.max_tokens > 0) limits.push(`<span class="tag bg-amber-50 text-amber-600">${formatTokenCount(k.max_tokens)} T</span>`);
    if (k.allowed_models) limits.push(`<span class="tag bg-cyan-50 text-cyan-600"><i class="fas fa-cube mr-0.5"></i>${k.allowed_models.split(',').length}</span>`);
    if (k.allowed_ips) limits.push(`<span class="tag bg-slate-100 text-slate-500"><i class="fas fa-shield mr-0.5"></i>IP</span>`);

    let expiresHtml = '';
    if (k.expires_at) {
      const exp = new Date(k.expires_at);
      const isExpired = exp.getTime() < Date.now();
      expiresHtml = `<span class="tag ${isExpired ? 'bg-red-50 text-red-500' : 'bg-orange-50 text-orange-500'}">${isExpired ? '已过期' : exp.toLocaleDateString('zh-CN')}</span>`;
    }

    const remarkHtml = k.remark ? `<p class="text-[10px] text-slate-400 mt-0.5 truncate max-w-[120px]" title="${escapeHtml(k.remark)}">${escapeHtml(k.remark)}</p>` : '';

    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-3.5 px-4"><input type="checkbox" class="ak-checkbox rounded border-slate-300" value="${k.id}" onchange="toggleApiKeySelection(${k.id})" /></td>
      <td class="py-3.5 px-4">
        <div class="flex items-center space-x-1.5 group">
          <div>
            <p class="text-[13px] font-semibold text-slate-700">${escapeHtml(k.name || '未命名')}</p>
            <p class="text-[10px] text-slate-400 mt-0.5 font-medium">#${k.id} · ${k.created_at ? new Date(k.created_at).toLocaleDateString('zh-CN') : '-'}</p>
            ${remarkHtml}
          </div>
          <button onclick="showEditApiKeyModal(${k.id})" class="p-1 text-slate-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition" title="编辑设置">
            <i class="fas fa-pen text-[9px]"></i>
          </button>
        </div>
      </td>
      <td class="py-3.5 px-4">
        <div class="flex items-center space-x-1.5">
          <code class="text-[10px] bg-slate-100 px-2.5 py-1 rounded-lg font-mono text-slate-500 tracking-wide">${escapeHtml(k.key)}</code>
          <button onclick="copyApiKeyById(${k.id})" class="p-1 text-slate-300 hover:text-blue-500 transition" title="复制完整密钥">
            <i class="fas fa-copy text-[10px]"></i>
          </button>
        </div>
      </td>
      <td class="py-3.5 px-4">
        <div class="text-[11px] font-medium">
          <span class="text-slate-700 font-bold">${logTotal.toLocaleString()}</span>
          <span class="text-slate-300 mx-0.5">/</span>
          <span class="text-emerald-500">${logSuccess.toLocaleString()}</span>
        </div>
        <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
          <div class="h-full bg-emerald-400 rounded-full progress-bar" style="width:${sr}%"></div>
        </div>
        <p class="text-[10px] text-slate-400 mt-0.5 font-medium">${sr}% · 今日 ${todayReqs} · ${formatTokenCount(totalTokens)} T</p>
      </td>
      <td class="py-3.5 px-4">
        <div class="flex flex-wrap gap-1">
          ${limits.length > 0 ? limits.join('') : '<span class="text-[10px] text-slate-300">无限制</span>'}
          ${expiresHtml}
        </div>
      </td>
      <td class="py-3.5 px-4 text-[11px] text-slate-400 font-medium">${k.last_used_at ? getTimeAgo(k.last_used_at) : '<span class="text-slate-300">未使用</span>'}</td>
      <td class="py-3.5 px-4">
        <span class="tag ${k.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}">${k.is_active ? '启用' : '禁用'}</span>
      </td>
      <td class="py-3.5 px-4">
        <div class="flex items-center space-x-0.5">
          <button onclick="showEditApiKeyModal(${k.id})" class="p-1.5 text-violet-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition" title="编辑限制">
            <i class="fas fa-sliders text-xs"></i>
          </button>
          <button onclick="regenerateApiKey(${k.id})" class="p-1.5 text-amber-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition" title="重新生成密钥">
            <i class="fas fa-rotate text-xs"></i>
          </button>
          <button onclick="toggleApiKey(${k.id}, ${k.is_active})" class="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition" title="${k.is_active ? '禁用' : '启用'}">
            <i class="fas fa-${k.is_active ? 'pause' : 'play'} text-xs"></i>
          </button>
          <button onclick="deleteApiKey(${k.id})" class="p-1.5 text-red-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition" title="删除">
            <i class="fas fa-trash text-xs"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function handleApiKeySearch() {
  const q = document.getElementById('apikeySearchInput').value.trim().toLowerCase();
  if (!q) { renderApiKeysTable(allApiKeysCache); return; }
  const filtered = allApiKeysCache.filter(k =>
    (k.name || '').toLowerCase().includes(q) ||
    (k.key || '').toLowerCase().includes(q) ||
    String(k.id).includes(q)
  );
  renderApiKeysTable(filtered);
}

function showCreateApiKeyModal() { document.getElementById('createApiKeyModal').classList.remove('hidden'); }

async function handleCreateApiKey(event) {
  event.preventDefault();
  try {
    const payload = {
      name: document.getElementById('apiKeyName').value,
      rate_limit: document.getElementById('akCreateRateLimit').value,
      daily_limit: document.getElementById('akCreateDailyLimit').value,
      monthly_limit: document.getElementById('akCreateMonthlyLimit').value,
      max_tokens: document.getElementById('akCreateMaxTokens').value,
      expires_at: document.getElementById('akCreateExpires').value || null,
      allowed_models: document.getElementById('akCreateModels').value || null,
      allowed_ips: document.getElementById('akCreateIPs').value || null,
      remark: document.getElementById('akCreateRemark').value || null
    };
    const data = await fetch('/admin/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
    closeModal('createApiKeyModal');
    ['apiKeyName', 'akCreateRateLimit', 'akCreateDailyLimit', 'akCreateMonthlyLimit', 'akCreateMaxTokens', 'akCreateExpires', 'akCreateModels', 'akCreateIPs', 'akCreateRemark'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = el.type === 'number' ? '0' : '';
    });

    lastCreatedKey = data.key;
    document.getElementById('newApiKeyDisplay').textContent = data.key;
    document.getElementById('apiKeySuccessModal').classList.remove('hidden');
    loadApiKeys();
  } catch (e) { toast('创建失败', 'error'); }
}

async function showEditApiKeyModal(id) {
  try {
    const detail = await fetch(`/admin/api-keys/${id}/detail`).then(r => r.json());
    document.getElementById('akEditId').value = id;
    document.getElementById('akEditName').value = detail.name || '';
    document.getElementById('akEditRateLimit').value = detail.rate_limit || 0;
    document.getElementById('akEditDailyLimit').value = detail.daily_limit || 0;
    document.getElementById('akEditMonthlyLimit').value = detail.monthly_limit || 0;
    document.getElementById('akEditMaxTokens').value = detail.max_tokens || 0;
    document.getElementById('akEditExpires').value = detail.expires_at ? detail.expires_at.substring(0, 16) : '';
    document.getElementById('akEditModels').value = detail.allowed_models || '';
    document.getElementById('akEditIPs').value = detail.allowed_ips || '';
    document.getElementById('akEditRemark').value = detail.remark || '';

    const usageEl = document.getElementById('akEditUsageInfo');
    const parts = [];
    parts.push(`<b>今日用量:</b> ${detail.current_daily_usage}${detail.daily_limit > 0 ? ' / ' + detail.daily_limit : ' (不限)'}`);
    parts.push(`<b>本月用量:</b> ${detail.current_monthly_usage}${detail.monthly_limit > 0 ? ' / ' + detail.monthly_limit : ' (不限)'}`);
    parts.push(`<b>Token 消耗:</b> ${formatTokenCount(detail.current_total_tokens)}${detail.max_tokens > 0 ? ' / ' + formatTokenCount(detail.max_tokens) : ' (不限)'}`);
    usageEl.innerHTML = parts.join('<br>');

    document.getElementById('editApiKeyModal').classList.remove('hidden');
  } catch (e) { toast('加载详情失败', 'error'); }
}

async function saveApiKeySettings() {
  const id = document.getElementById('akEditId').value;
  try {
    await fetch(`/admin/api-keys/${id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('akEditName').value,
        rate_limit: document.getElementById('akEditRateLimit').value,
        daily_limit: document.getElementById('akEditDailyLimit').value,
        monthly_limit: document.getElementById('akEditMonthlyLimit').value,
        max_tokens: document.getElementById('akEditMaxTokens').value,
        expires_at: document.getElementById('akEditExpires').value || null,
        allowed_models: document.getElementById('akEditModels').value || null,
        allowed_ips: document.getElementById('akEditIPs').value || null,
        remark: document.getElementById('akEditRemark').value || null
      })
    }).then(r => r.json());
    closeModal('editApiKeyModal');
    toast('设置已保存', 'success');
    loadApiKeys();
  } catch (e) { toast('保存失败', 'error'); }
}

function copyNewApiKey() { copyToClipboard(lastCreatedKey); }

async function copyApiKeyById(id) {
  try {
    const data = await fetch(`/admin/api-keys/${id}/reveal`).then(r => r.json());
    if (data.key) {
      copyToClipboard(data.key);
      toast('密钥已复制到剪贴板', 'success');
    } else {
      toast('获取密钥失败', 'error');
    }
  } catch (e) { toast('复制失败', 'error'); }
}
function copyRegenApiKey() { copyToClipboard(lastRegenKey); }

function showRenameApiKeyModal(id, currentName) {
  document.getElementById('renameApiKeyId').value = id;
  document.getElementById('renameApiKeyName').value = currentName;
  document.getElementById('renameApiKeyModal').classList.remove('hidden');
}

async function handleRenameApiKey(event) {
  event.preventDefault();
  const id = document.getElementById('renameApiKeyId').value;
  const name = document.getElementById('renameApiKeyName').value;
  try {
    await fetch(`/admin/api-keys/${id}/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    closeModal('renameApiKeyModal');
    toast('重命名成功', 'success');
    loadApiKeys();
  } catch (e) { toast('重命名失败', 'error'); }
}

async function regenerateApiKey(id) {
  const ok = await showConfirm('重新生成密钥', '重新生成后旧密钥将立即失效，使用旧密钥的客户端将无法访问。确定继续？', '重新生成', 'bg-amber-500 hover:bg-amber-600');
  if (!ok) return;
  try {
    const data = await fetch(`/admin/api-keys/${id}/regenerate`, { method: 'POST' }).then(r => r.json());
    if (data.success) {
      lastRegenKey = data.key;
      document.getElementById('regenApiKeyDisplay').textContent = data.key;
      document.getElementById('apiKeyRegenModal').classList.remove('hidden');
      loadApiKeys();
    } else {
      toast(data.error || '重新生成失败', 'error');
    }
  } catch (e) { toast('重新生成失败', 'error'); }
}

async function toggleApiKey(id, active) {
  try {
    await fetch(`/admin/api-keys/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !active }) });
    toast(active ? '已禁用' : '已启用', 'success');
    loadApiKeys();
  } catch (e) { toast('操作失败', 'error'); }
}

async function deleteApiKey(id) {
  const ok = await showConfirm('删除 API Key', '确定删除此 API Key？使用此 Key 的客户端将无法访问，相关日志也将被清除。', '删除', 'bg-red-500 hover:bg-red-600');
  if (!ok) return;
  try { await fetch(`/admin/api-keys/${id}`, { method: 'DELETE' }); loadApiKeys(); toast('已删除', 'success'); } catch (e) { toast('删除失败', 'error'); }
}

function toggleApiKeySelection(id) {
  selectedApiKeys.has(id) ? selectedApiKeys.delete(id) : selectedApiKeys.add(id);
  updateApiKeyBatchButton();
}

function toggleSelectAllApiKeys() {
  const cb = document.getElementById('selectAllApiKeys');
  document.querySelectorAll('.ak-checkbox').forEach(c => { c.checked = cb.checked; const id = parseInt(c.value); cb.checked ? selectedApiKeys.add(id) : selectedApiKeys.delete(id); });
  updateApiKeyBatchButton();
}

function updateApiKeyBatchButton() {
  const btn = document.getElementById('akBatchBtn');
  const cnt = document.getElementById('akSelectedCount');
  if (selectedApiKeys.size > 0) { btn.classList.remove('hidden'); cnt.textContent = selectedApiKeys.size; } else { btn.classList.add('hidden'); }
}

async function batchDeleteApiKeys() {
  const ok = await showConfirm('批量删除', `确定删除 ${selectedApiKeys.size} 个 API Key？此操作不可恢复。`, '全部删除', 'bg-red-500 hover:bg-red-600');
  if (!ok) return;
  try {
    const data = await fetch('/admin/api-keys/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: Array.from(selectedApiKeys) }) }).then(r => r.json());
    toast(`删除完成: ${data.deleted || 0} 个已删除`, 'success');
    selectedApiKeys.clear();
    loadApiKeys();
  } catch (e) { toast('批量删除失败', 'error'); }
}

function exportApiKeys() {
  toast('正在导出...', 'info', 1500);
  const data = allApiKeysCache.map(k => ({
    id: k.id, name: k.name, key: k.key, is_active: k.is_active,
    usage_count: k.usage_count, total_tokens_consumed: k.total_tokens_consumed,
    today_requests: k.today_requests, last_used_at: k.last_used_at, created_at: k.created_at
  }));
  downloadJson(data, `apikeys-export-${new Date().toISOString().slice(0,10)}.json`);
  toast('导出完成', 'success');
}

// ==================== Monitor ====================

let allMonitorTokensCache = [];

async function loadMonitor() {
  try {
    const [status, health] = await Promise.all([
      fetch('/admin/monitor').then(r => r.json()),
      fetch('/admin/monitor/health-summary').then(r => r.json())
    ]);

    animateNumber('monHealthy', health.healthy || 0);
    animateNumber('monUnhealthy', health.unhealthy || 0);
    animateNumber('monDisabled', health.disabled || 0);
    animateNumber('monUnknown', health.unknown || 0);
    animateNumber('monTotal', health.total || 0);

    allMonitorTokensCache = [...(status.activeTokens || []), ...(status.disabledTokens || [])];
    renderMonitorTable(allMonitorTokensCache);
  } catch (e) { console.error('Monitor load error:', e); }
}

function renderMonitorTable(tokens) {
  const tbody = document.getElementById('monitorTokenList');
  if (!tokens.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400"><i class="fas fa-shield-halved text-3xl mb-3 block text-slate-300"></i><span class="text-sm">暂无数据</span></td></tr>';
    return;
  }
  
  tbody.innerHTML = tokens.slice(0, 200).map(t => {
    const hs = t.healthStatus || 'unknown';
    const badge = {
      healthy: '<span class="tag bg-emerald-50 text-emerald-600"><i class="fas fa-check-circle text-[8px] mr-1"></i>健康</span>',
      unhealthy: '<span class="tag bg-amber-50 text-amber-600"><i class="fas fa-exclamation-triangle text-[8px] mr-1"></i>异常</span>',
      disabled: '<span class="tag bg-red-50 text-red-500"><i class="fas fa-ban text-[8px] mr-1"></i>封停</span>',
      unknown: '<span class="tag bg-slate-50 text-slate-400"><i class="fas fa-question-circle text-[8px] mr-1"></i>未检测</span>'
    }[hs] || '<span class="tag bg-slate-50 text-slate-400">未知</span>';

    const msg = t.healthMessage || t.lastCheck?.message || '';
    const lastCheck = t.lastCheck ? getTimeAgo(t.lastCheck.time) : '-';

    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-2.5 px-4 text-[11px] text-slate-400 font-medium">#${t.id}</td>
      <td class="py-2.5 px-4 text-[11px] font-semibold text-slate-600">${escapeHtml(t.name)}</td>
      <td class="py-2.5 px-4">${badge}</td>
      <td class="py-2.5 px-4 text-[10px] text-slate-400 max-w-[220px] truncate font-medium" title="${escapeHtml(msg)}">${escapeHtml(msg) || '-'}</td>
      <td class="py-2.5 px-4 text-[10px] text-slate-400 font-medium">${lastCheck}</td>
      <td class="py-2.5 px-4">
        <button onclick="testSingleToken(${t.id})" class="px-2.5 py-1 text-[10px] font-semibold text-blue-500 bg-blue-50 rounded-lg hover:bg-blue-100 transition">测试</button>
      </td>
    </tr>`;
  }).join('');
}

function handleMonitorSearch() {
  const q = document.getElementById('monitorSearchInput').value.trim().toLowerCase();
  if (!q) { renderMonitorTable(allMonitorTokensCache); return; }
  const filtered = allMonitorTokensCache.filter(t =>
    (t.name || '').toLowerCase().includes(q) || String(t.id).includes(q)
  );
  renderMonitorTable(filtered);
}

async function monitorAction(action) {
  const map = {
    'check-now': { url: '/admin/monitor/check-now', msg: '检测已完成' },
    'recovery-now': { url: '/admin/monitor/recovery-now', msg: '复测已完成' },
    'start': { url: '/admin/monitor/start', msg: '监控已启动' },
    'stop': { url: '/admin/monitor/stop', msg: '监控已停止' }
  };
  const cfg = map[action];
  toast('执行中...', 'info', 2000);
  try {
    await fetch(cfg.url, { method: 'POST' });
    toast(cfg.msg, 'success');
    loadMonitor();
    if (currentPage === 'dashboard') loadDashboard();
  } catch (e) { toast('操作失败: ' + e.message, 'error'); }
}

// ==================== Analytics ====================

let currentTimeRange = '24h';
let requestTrendChart = null, modelDistributionChart = null;
let allLogsCache = [];

function changeTimeRange(range) {
  currentTimeRange = range;
  document.querySelectorAll('.time-range-btn').forEach(b => { b.classList.remove('bg-blue-500', 'text-white'); b.classList.add('text-slate-500', 'hover:bg-slate-50'); });
  event.target.classList.add('bg-blue-500', 'text-white');
  event.target.classList.remove('text-slate-500', 'hover:bg-slate-50');
  loadAnalytics();
}

async function loadAnalytics() {
  try {
    const [stats, charts, logs, tokenUsage, advanced] = await Promise.all([
      fetch(`/admin/stats/analytics?range=${currentTimeRange}`).then(r => r.json()),
      fetch(`/admin/stats/charts?range=${currentTimeRange}`).then(r => r.json()),
      fetch(`/admin/stats/logs?limit=100&range=${currentTimeRange}`).then(r => r.json()),
      fetch('/admin/stats/token-usage').then(r => r.json()).catch(() => null),
      fetch('/admin/stats/advanced').then(r => r.json()).catch(() => null)
    ]);

    animateNumber('totalRequests', stats.totalRequests || 0);
    animateNumber('successRequests', stats.successRequests || 0);
    animateNumber('failedRequests', stats.failedRequests || 0);
    document.getElementById('avgResponseTime').innerHTML = (stats.avgResponseTime || 0) + '<span class="text-sm font-medium">ms</span>';

    // Token 消耗统计
    if (tokenUsage) {
      document.getElementById('totalTokensUsed').textContent = formatTokenCount(tokenUsage.total?.total_tokens || 0);
      document.getElementById('totalInputTokens').textContent = formatTokenCount(tokenUsage.total?.total_input || 0);
      document.getElementById('totalOutputTokens').textContent = formatTokenCount(tokenUsage.total?.total_output || 0);
      document.getElementById('todayTokensUsed').textContent = formatTokenCount(tokenUsage.today?.total_tokens || 0);
      document.getElementById('todayInputTokens').textContent = formatTokenCount(tokenUsage.today?.total_input || 0);
      document.getElementById('todayOutputTokens').textContent = formatTokenCount(tokenUsage.today?.total_output || 0);

      const modelUsageEl = document.getElementById('modelTokenUsage');
      const byModel = tokenUsage.byModel || [];
      if (byModel.length > 0) {
        const maxTokens = Math.max(...byModel.map(m => m.total_tokens), 1);
        modelUsageEl.innerHTML = byModel.slice(0, 8).map(m => {
          const pct = Math.round((m.total_tokens / maxTokens) * 100);
          return `<div class="flex items-center space-x-3">
            <span class="text-[10px] font-semibold text-slate-500 w-32 truncate">${escapeHtml(m.model)}</span>
            <div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-blue-400 to-indigo-500 rounded-full progress-bar" style="width:${pct}%"></div>
            </div>
            <span class="text-[10px] font-bold text-slate-600 w-24 text-right">${formatTokenCount(m.total_tokens)}</span>
            <span class="text-[10px] text-slate-400 w-16 text-right">${m.request_count} 次</span>
          </div>`;
        }).join('');
      } else {
        modelUsageEl.innerHTML = '<p class="text-[10px] text-slate-400">暂无消耗数据</p>';
      }
    }

    // Trend Chart - 成功/失败双线
    const tCtx = document.getElementById('requestTrendChart').getContext('2d');
    if (requestTrendChart) requestTrendChart.destroy();
    const successGradient = tCtx.createLinearGradient(0, 0, 0, 240);
    successGradient.addColorStop(0, 'rgba(16,185,129,0.15)');
    successGradient.addColorStop(1, 'rgba(16,185,129,0)');
    const errorGradient = tCtx.createLinearGradient(0, 0, 0, 240);
    errorGradient.addColorStop(0, 'rgba(239,68,68,0.15)');
    errorGradient.addColorStop(1, 'rgba(239,68,68,0)');

    requestTrendChart = new Chart(tCtx, {
      type: 'line',
      data: { labels: charts.trendLabels || [], datasets: [
        {
          label: '成功', data: charts.trendSuccess || charts.trendData || [],
          borderColor: '#10b981', backgroundColor: successGradient,
          tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: '#10b981', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2
        },
        {
          label: '失败', data: charts.trendErrors || [],
          borderColor: '#ef4444', backgroundColor: errorGradient,
          tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: '#ef4444', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2
        }
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { position: 'top', labels: { font: { size: 10, weight: 600 }, usePointStyle: true, pointStyleWidth: 8, padding: 12 } }, tooltip: { backgroundColor: '#1e293b', titleFont: { size: 11 }, bodyFont: { size: 12 }, padding: 10, cornerRadius: 8 } },
        scales: { y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.03)' }, ticks: { font: { size: 10 } } }, x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 12 } } }
      }
    });

    // Model Chart
    const mCtx = document.getElementById('modelDistributionChart').getContext('2d');
    if (modelDistributionChart) modelDistributionChart.destroy();
    modelDistributionChart = new Chart(mCtx, {
      type: 'doughnut',
      data: { labels: charts.modelLabels || [], datasets: [{ data: charts.modelData || [],
        backgroundColor: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16'],
        borderWidth: 0, hoverOffset: 6
      }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 11, weight: 500 }, padding: 14, usePointStyle: true, pointStyleWidth: 8 } }, tooltip: { backgroundColor: '#1e293b', padding: 10, cornerRadius: 8 } },
        cutout: '65%'
      }
    });

    // 端点统计
    renderEndpointStats(charts.endpoints || []);

    // 响应时间 P50/P95/P99
    if (advanced) {
      const p = advanced.percentiles || {};
      document.getElementById('analyticsP50').innerHTML = `${formatMs(p.p50)}`;
      document.getElementById('analyticsP95').innerHTML = `${formatMs(p.p95)}`;
      document.getElementById('analyticsP99').innerHTML = `${formatMs(p.p99)}`;
      document.getElementById('analyticsMin').innerHTML = `${formatMs(p.min)}`;

      renderAnalyticsTokenRanking(advanced.tokenRanking || []);
      renderAnalyticsKeyRanking(advanced.topKeys || []);
    }

    // Logs
    allLogsCache = logs;
    renderLogsTable(logs);
  } catch (e) { console.error('Analytics error:', e); }
}

function renderEndpointStats(endpoints) {
  const el = document.getElementById('endpointStats');
  if (!endpoints.length) {
    el.innerHTML = '<p class="text-[11px] text-slate-400 py-4 text-center">暂无端点数据</p>';
    return;
  }
  const maxCount = Math.max(...endpoints.map(e => e.count), 1);
  el.innerHTML = endpoints.map(ep => {
    const pct = Math.round((ep.count / maxCount) * 100);
    const sr = ep.count > 0 ? Math.round((ep.success / ep.count) * 100) : 100;
    const srColor = sr >= 95 ? 'text-emerald-500' : sr >= 80 ? 'text-amber-500' : 'text-red-500';
    return `<div class="p-3 bg-slate-50/80 rounded-xl">
      <div class="flex items-center justify-between mb-2">
        <code class="text-[10px] font-mono text-slate-600 font-semibold">${escapeHtml(ep.endpoint)}</code>
        <div class="flex items-center space-x-2">
          <span class="text-[10px] font-bold ${srColor}">${sr}%</span>
          <span class="text-[10px] text-slate-400">${formatMs(ep.avg_time)}</span>
          <span class="text-[10px] font-bold text-slate-600">${ep.count}</span>
        </div>
      </div>
      <div class="w-full h-1.5 bg-slate-200/60 rounded-full overflow-hidden">
        <div class="h-full bg-gradient-to-r from-cyan-400 to-blue-500 rounded-full progress-bar" style="width:${pct}%"></div>
      </div>
      <div class="flex items-center justify-between mt-1.5">
        <span class="text-[9px] text-emerald-500 font-medium">${ep.success} 成功</span>
        <span class="text-[9px] text-red-400 font-medium">${ep.errors} 失败</span>
      </div>
    </div>`;
  }).join('');
}

function renderAnalyticsTokenRanking(tokens) {
  const tbody = document.getElementById('analyticsTokenRanking');
  if (!tokens.length || !tokens[0].total_requests) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-[11px] text-slate-400">暂无数据</td></tr>';
      return;
  }
  tbody.innerHTML = tokens.filter(t => t.total_requests > 0).map((t, i) => {
    const sr = t.total_requests > 0 ? Math.round((t.success_requests / t.total_requests) * 100) : 100;
    const srColor = sr >= 95 ? 'text-emerald-500' : sr >= 80 ? 'text-amber-500' : 'text-red-500';
    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-2 px-3 text-[10px] font-bold text-slate-400">${i+1}</td>
      <td class="py-2 px-3 text-[11px] font-semibold text-slate-600 truncate max-w-[120px]">${escapeHtml(t.name || t.email || `#${t.id}`)}</td>
      <td class="py-2 px-3 text-[10px] font-bold text-slate-700">${t.total_requests.toLocaleString()}</td>
      <td class="py-2 px-3 text-[10px] font-bold ${srColor}">${sr}%</td>
      <td class="py-2 px-3 text-[10px] text-slate-500">${formatMs(t.avg_response_time)}</td>
      <td class="py-2 px-3 text-[10px] font-medium text-amber-600">${formatTokenCount(t.total_tokens)}</td>
    </tr>`;
  }).join('');
}

function renderAnalyticsKeyRanking(keys) {
  const tbody = document.getElementById('analyticsKeyRanking');
  if (!keys.length || !keys[0].total_requests) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-6 text-[11px] text-slate-400">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = keys.filter(k => k.total_requests > 0).map((k, i) => {
    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-2 px-3 text-[10px] font-bold text-slate-400">${i+1}</td>
      <td class="py-2 px-3 text-[11px] font-semibold text-slate-600 truncate max-w-[120px]">${escapeHtml(k.name || '未命名')}</td>
      <td class="py-2 px-3 text-[10px] font-bold text-slate-700">${k.total_requests.toLocaleString()}</td>
      <td class="py-2 px-3 text-[10px] text-emerald-500 font-bold">${(k.success_requests || 0).toLocaleString()}</td>
      <td class="py-2 px-3 text-[10px] font-medium text-amber-600">${formatTokenCount(k.total_tokens)}</td>
    </tr>`;
  }).join('');
}

function renderLogsTable(logs) {
  const ltbody = document.getElementById('logsTable');
  if (!logs.length) {
    ltbody.innerHTML = '<tr><td colspan="8" class="text-center py-12 text-slate-400"><i class="fas fa-chart-simple text-3xl mb-3 block text-slate-300"></i><span class="text-sm">暂无日志</span></td></tr>';
      return;
  }
  ltbody.innerHTML = logs.map(l => {
    const isOk = l.status_code >= 200 && l.status_code < 300;
    const inTk = l.input_tokens || 0;
    const outTk = l.output_tokens || 0;
    const totalTk = inTk + outTk;
    const errMsg = l.error_message || '';
    const errTruncated = errMsg.length > 40 ? errMsg.substring(0, 40) + '...' : errMsg;
    return `<tr class="hover:bg-blue-50/30 transition">
      <td class="py-2 px-4 text-[10px] text-slate-400 font-medium whitespace-nowrap">${new Date(l.created_at).toLocaleString('zh-CN')}</td>
      <td class="py-2 px-4 text-[10px] text-slate-500 font-medium">${l.api_key_name || '-'}</td>
      <td class="py-2 px-4"><span class="tag bg-slate-50 text-slate-600">${escapeHtml(l.model || '-')}</span></td>
      <td class="py-2 px-4 text-[10px] text-slate-400 font-mono font-medium">${escapeHtml(l.endpoint || '-')}</td>
      <td class="py-2 px-4"><span class="tag ${isOk ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}">${l.status_code}</span></td>
      <td class="py-2 px-4 text-[10px] font-medium ${totalTk > 0 ? 'text-amber-600' : 'text-slate-300'}">${totalTk > 0 ? formatTokenCount(totalTk) : '-'}</td>
      <td class="py-2 px-4 text-[10px] text-slate-400 font-medium">${l.response_time || '-'}ms</td>
      <td class="py-2 px-4 text-[10px] ${errMsg ? 'text-red-400' : 'text-slate-300'} font-medium max-w-[180px] truncate" title="${escapeHtml(errMsg)}">${errMsg ? escapeHtml(errTruncated) : '-'}</td>
    </tr>`;
  }).join('');
}

function handleLogSearch() {
  const q = document.getElementById('logSearchInput').value.trim().toLowerCase();
  if (!q) { renderLogsTable(allLogsCache); return; }
  const filtered = allLogsCache.filter(l =>
    (l.model || '').toLowerCase().includes(q) ||
    (l.api_key_name || '').toLowerCase().includes(q) ||
    (l.endpoint || '').toLowerCase().includes(q) ||
    (l.error_message || '').toLowerCase().includes(q) ||
    String(l.status_code).includes(q)
  );
  renderLogsTable(filtered);
}

function exportAnalytics() {
  toast('正在导出分析报告...', 'info', 1500);
  const data = allLogsCache.map(l => ({
    time: l.created_at, api_key: l.api_key_name, model: l.model,
    endpoint: l.endpoint, status: l.status_code, response_ms: l.response_time,
    input_tokens: l.input_tokens || 0, output_tokens: l.output_tokens || 0,
    error: l.error_message || null
  }));
  downloadJson(data, `analytics-${currentTimeRange}-${new Date().toISOString().slice(0,10)}.json`);
  toast('导出完成', 'success');
}

// ==================== Settings ====================

async function loadSettings() {
  try {
    const [allSettings, logStats] = await Promise.all([
      fetch('/admin/settings').then(r => r.json()),
      fetch('/admin/settings/log-stats').then(r => r.json()).catch(() => null)
    ]);

    document.getElementById('settingStrategy').value = allSettings.loadBalanceStrategy || 'round-robin';
    document.getElementById('settingRateLimit').value = allSettings.rateLimitRpm || 60;
    document.getElementById('settingMaxRetries').value = allSettings.maxRetries || 3;
    document.getElementById('settingReqTimeout').value = allSettings.requestTimeout || 90000;
    document.getElementById('settingStreamTimeout').value = allSettings.streamTimeout || 120000;

    const m = allSettings.monitor || {};
    document.getElementById('settingActiveCheck').value = m.activeCheckMinutes || 240;
    document.getElementById('settingRecoveryCheck').value = m.recoveryCheckMinutes || 360;
    document.getElementById('settingMaxFailures').value = m.maxConsecutiveFailures || 2;

    const sys = allSettings.system || {};
    document.getElementById('sysNodeVer').textContent = sys.nodeVersion || '--';
    document.getElementById('sysPlatform').textContent = (sys.platform || '--') + '/' + (sys.arch || '');
    document.getElementById('sysCPUs').textContent = sys.cpus || '--';
    document.getElementById('sysUptime').textContent = formatUptime(sys.uptime || 0);
    document.getElementById('sysProcessMem').textContent = (sys.processMemory || 0) + ' MB';
    document.getElementById('sysHeapMem').textContent = (sys.heapUsed || 0) + '/' + (sys.heapTotal || 0) + ' MB';
    document.getElementById('sysTotalMem').textContent = (sys.totalMemory || 0) + ' MB';
    document.getElementById('sysFreeMem').textContent = (sys.freeMemory || 0) + ' MB';

    if (logStats) {
      const el = document.getElementById('logStorageInfo');
      el.innerHTML = `<p><b>日志总数:</b> ${(logStats.totalLogs || 0).toLocaleString()}</p>
        <p><b>今日:</b> ${(logStats.todayLogs || 0).toLocaleString()} | <b>本周:</b> ${(logStats.weekLogs || 0).toLocaleString()}</p>
        <p><b>最早:</b> ${logStats.oldestLog ? new Date(logStats.oldestLog).toLocaleDateString('zh-CN') : '--'} | <b>最新:</b> ${logStats.newestLog ? new Date(logStats.newestLog).toLocaleString('zh-CN') : '--'}</p>`;
    }
  } catch (e) { console.error(e); }
}

async function saveSetting(type) {
  try {
    let url, body;
    switch (type) {
      case 'strategy':
        url = '/admin/settings/load-balance-strategy';
        body = { strategy: document.getElementById('settingStrategy').value };
        break;
      case 'rateLimit':
        url = '/admin/settings/rate-limit';
        body = { rpm: document.getElementById('settingRateLimit').value };
        break;
      case 'maxRetries':
        url = '/admin/settings/max-retries';
        body = { maxRetries: document.getElementById('settingMaxRetries').value };
        break;
      case 'timeouts':
        url = '/admin/settings/timeouts';
        body = {
          requestTimeout: document.getElementById('settingReqTimeout').value,
          streamTimeout: document.getElementById('settingStreamTimeout').value
        };
        break;
      default: return;
    }
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    toast(r.message || '已实时更新', 'success');
  } catch (e) { toast('保存失败', 'error'); }
}

async function saveMonitorSettings() {
  try {
    const body = {
      activeCheckMinutes: parseInt(document.getElementById('settingActiveCheck').value),
      recoveryCheckMinutes: parseInt(document.getElementById('settingRecoveryCheck').value),
      maxFailures: parseInt(document.getElementById('settingMaxFailures').value)
    };
    const r = await fetch('/admin/settings/monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    toast(r.message || '监控配置已保存', 'success');
  } catch (e) { toast('保存失败', 'error'); }
}

async function clearLogs() {
  const days = document.getElementById('logCleanDays').value;
  const ok = await showConfirm('清理日志', `确定清理 ${days} 天前的所有 API 日志？此操作不可逆。`, '确认清理', 'bg-red-500 hover:bg-red-600');
  if (!ok) return;
  try {
    const r = await fetch('/admin/settings/clear-logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) }).then(r => r.json());
    toast(`已清理 ${r.deleted || 0} 条日志`, 'success');
    loadSettings();
  } catch (e) { toast('清理失败', 'error'); }
}

async function clearTokenCache() {
  try {
    const r = await fetch('/admin/settings/clear-cache', { method: 'POST' }).then(r => r.json());
    toast(r.message || 'Token 缓存已清除', 'success');
  } catch (e) { toast('清除失败', 'error'); }
}

// ==================== Import / Create Token ====================

function showCreateTokenModal() { document.getElementById('createTokenModal').classList.remove('hidden'); }
function showImportTokenModal() {
  document.getElementById('importTokenModal').classList.remove('hidden');
  document.getElementById('tokenFileInput').addEventListener('change', handleFileSelect);
}
function closeImportModal() {
  closeModal('importTokenModal');
  document.getElementById('tokenFileInput').value = '';
  document.getElementById('tokenJsonContent').value = '';
  document.getElementById('importPreview').classList.add('hidden');
  document.getElementById('fileStatus').textContent = '';
  importData = null;
  importCheckResult = null;
}

async function handleFileSelect(event) {
  const files = event.target.files;
  if (!files?.length) return;
  let statusEl = document.getElementById('fileStatus');
  if (!statusEl) {
    const container = document.getElementById('tokenFileInput')?.parentElement;
    if (container) {
      statusEl = document.createElement('p');
      statusEl.id = 'fileStatus';
      statusEl.className = 'mt-1.5 text-[11px] text-slate-500';
      container.appendChild(statusEl);
    }
  }
  if (statusEl) statusEl.textContent = '正在读取文件...';
  let all = [];

  for (const f of Array.from(files)) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'zip') {
      try {
        statusEl.textContent = `正在解压 ${f.name}...`;
        const zip = await JSZip.loadAsync(f);
        let jsonCount = 0;
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir || !name.endsWith('.json')) continue;
          try {
            const text = await entry.async('text');
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) all = all.concat(parsed);
            else all.push(parsed);
            jsonCount++;
          } catch {}
        }
        statusEl.textContent = `${f.name}: 解压到 ${jsonCount} 个 JSON 文件`;
      } catch (e) {
        statusEl.textContent = `${f.name} 解压失败: ${e.message}`;
        toast(`ZIP 解压失败: ${e.message}`, 'error');
      }
    } else {
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) all = all.concat(parsed);
        else all.push(parsed);
      } catch {}
    }
  }

  if (all.length > 0) {
    document.getElementById('tokenJsonContent').value = JSON.stringify(all, null, 2);
    statusEl.textContent = `已读取 ${all.length} 条数据，点击"预览"查看详情`;
  } else {
    statusEl.textContent = '未找到有效的 JSON 数据';
  }
}

let importData = null;
let importCheckResult = null;

async function previewImport() {
  const content = document.getElementById('tokenJsonContent').value.trim();
  if (!content) { toast('请先选择文件或粘贴 JSON', 'warning'); return; }
  try {
    importData = JSON.parse(content);
    if (!Array.isArray(importData)) importData = [importData];

    const validData = importData.filter(t => t.access_token && t.refresh_token);
    const invalidInFile = importData.length - validData.length;
    importData = importData; // keep all for backend to report

    if (!validData.length && invalidInFile > 0) {
      toast(`全部 ${importData.length} 条均无效 (缺少必需字段)`, 'error');
      return;
    }
    if (!validData.length) { toast('未找到有效 token 数据', 'error'); return; }

    // 向后端查重
    try {
      importCheckResult = await fetch('/admin/tokens/check-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: importData })
      }).then(r => r.json());
    } catch {
      importCheckResult = null;
    }

    const items = importCheckResult?.items || [];
    const newCount = importCheckResult?.newCount || validData.length;
    const dupCount = importCheckResult?.duplicateCount || 0;
    const invCount = importCheckResult?.invalidCount || invalidInFile;

    const setEl = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
    setEl('importCount', validData.length);
    setEl('importNewCount', newCount + ' 新增');
    setEl('importDupCount', dupCount + ' 重复');
    setEl('importInvalidCount', invCount + ' 无效');

    const listEl = document.getElementById('importList');
    const displayItems = items.length > 0 ? items : importData.map((t, i) => ({
      index: i, name: t.name || t.email || 'Token', valid: !!(t.access_token && t.refresh_token), duplicate: false
    }));

    listEl.innerHTML = displayItems.slice(0, 50).map(item => {
      let icon, color;
      if (!item.valid) { icon = 'fa-times-circle'; color = 'text-red-400'; }
      else if (item.duplicate) { icon = 'fa-clone'; color = 'text-amber-500'; }
      else { icon = 'fa-check-circle'; color = 'text-emerald-400'; }
      const label = !item.valid ? ' (无效)' : item.duplicate ? ' (重复)' : '';
      return `<li class="flex items-center space-x-1.5">
        <i class="fas ${icon} ${color} text-[9px]"></i>
        <span class="${item.duplicate ? 'text-amber-600' : !item.valid ? 'text-red-500 line-through' : 'text-slate-600'}">${item.index + 1}. ${escapeHtml(item.name)}${label}</span>
      </li>`;
    }).join('');

    if (displayItems.length > 50) {
      listEl.innerHTML += `<li class="text-slate-400 text-center mt-1">... 还有 ${displayItems.length - 50} 条</li>`;
    }

    document.getElementById('importPreview').classList.remove('hidden');

    if (dupCount > 0) toast(`发现 ${dupCount} 个重复 Token`, 'warning');
  } catch (e) { toast('JSON 解析失败: ' + e.message, 'error'); }
}

async function handleImportTokens() {
  if (!importData?.length) { toast('请先预览', 'warning'); return; }
  const skipDup = document.getElementById('importSkipDup')?.checked ?? true;
  const updateDup = document.getElementById('importUpdateDup')?.checked ?? false;
  try {
    const data = await fetch('/admin/tokens/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: importData, skipDuplicates: skipDup, updateDuplicates: updateDup })
    }).then(r => r.json());
    const parts = [];
    if (data.successCount) parts.push(`新增 ${data.successCount}`);
    if (data.updatedCount) parts.push(`更新 ${data.updatedCount}`);
    if (data.skippedCount) parts.push(`跳过 ${data.skippedCount}`);
    if (data.failed) parts.push(`失败 ${data.failed}`);
    toast(parts.join(', ') || data.message, data.successCount > 0 || data.updatedCount > 0 ? 'success' : 'warning');
    closeImportModal();
    loadTokens();
  } catch (e) { toast('导入失败', 'error'); }
}

async function handleCreateToken(event) {
  event.preventDefault();
  try {
    await fetch('/admin/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('tokenName').value, access_token: document.getElementById('accessToken').value, refresh_token: document.getElementById('refreshToken').value }) });
    closeModal('createTokenModal');
    ['tokenName', 'accessToken', 'refreshToken'].forEach(id => document.getElementById(id).value = '');
    toast('Token 已添加', 'success');
    loadTokens();
  } catch (e) { toast('添加失败', 'error'); }
}

// ==================== Load Balance / Password ====================

async function loadLoadBalanceStrategy() {
  try {
    const d = await fetch('/admin/settings/load-balance-strategy').then(r => r.json());
    document.getElementById('loadBalanceStrategy').value = d.strategy;
  } catch {}
}

async function changeLoadBalanceStrategy() {
  const strategy = document.getElementById('loadBalanceStrategy').value;
  try {
    await fetch('/admin/settings/load-balance-strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy }) });
    toast('负载均衡策略已更新', 'success');
  } catch (e) { toast('更新失败', 'error'); }
}

function showChangePasswordModal() { document.getElementById('changePasswordModal').classList.remove('hidden'); }

async function handleChangePassword(event) {
  event.preventDefault();
  const np = document.getElementById('newPassword').value;
  if (np !== document.getElementById('confirmPassword').value) { toast('两次密码不一致', 'error'); return; }
  try {
    const r = await fetch('/admin/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: document.getElementById('currentPassword').value, newPassword: np }) });
    if (r.ok) { toast('密码已修改，请重新登录', 'success'); setTimeout(() => { window.location.href = '/admin/login.html'; }, 1500); }
    else { const d = await r.json(); toast(d.error || '修改失败', 'error'); }
  } catch (e) { toast('修改失败', 'error'); }
}

async function handleLogout() {
  const ok = await showConfirm('退出登录', '确定退出管理后台？', '退出', 'bg-slate-700 hover:bg-slate-800');
  if (!ok) return;
  try { await fetch('/admin/auth/logout', { method: 'POST' }); } catch {}
      window.location.href = '/admin/login.html';
}
