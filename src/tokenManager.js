import fs from 'fs/promises';
import axios from 'axios';
import httpsProxyAgent from 'https-proxy-agent';

const { HttpsProxyAgent } = httpsProxyAgent;

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;

class TokenManager {
  constructor(tokenFilePath) {
    this.tokenFilePath = tokenFilePath;
    this.tokenData = null;
    this.dbTokenId = null; // 关联的数据库 Token ID
  }

  async loadToken() {
    if (!this.tokenFilePath) {
      if (this.tokenData) return this.tokenData;
      throw new Error('无 token 文件路径且无内存 token 数据');
    }
    try {
      const data = await fs.readFile(this.tokenFilePath, 'utf-8');
      this.tokenData = JSON.parse(data);
      return this.tokenData;
    } catch (error) {
      throw new Error(`加载 token 文件失败: ${error.message}`);
    }
  }

  async saveToken(tokenData) {
    this.tokenData = tokenData;
    if (this.tokenFilePath) {
      try {
        await fs.writeFile(this.tokenFilePath, JSON.stringify(tokenData, null, 2), 'utf-8');
      } catch (error) {
        console.error(`保存 token 文件失败: ${error.message}`);
      }
    }
  }

  isTokenExpired() {
    if (!this.tokenData || !this.tokenData.expired_at) return true;
    const expireTime = new Date(this.tokenData.expired_at).getTime();
    return expireTime - Date.now() < 5 * 60 * 1000;
  }

  _buildRefreshConfig() {
    const config = {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      timeout: 30000
    };
    if (PROXY_URL) {
      config.httpsAgent = new HttpsProxyAgent(PROXY_URL);
    }
    return config;
  }

  async _doRefresh() {
    if (!this.tokenData?.refresh_token) {
      throw new Error('没有可用的 refresh_token');
    }

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: this.tokenData.refresh_token,
      scope: 'openid profile email'
    });

    const response = await axios.post(TOKEN_URL, params.toString(), this._buildRefreshConfig());
    const { access_token, refresh_token, id_token, expires_in } = response.data;

    return {
      ...this.tokenData,
      access_token,
      refresh_token: refresh_token || this.tokenData.refresh_token,
      id_token: id_token || this.tokenData.id_token,
      expired_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      last_refresh_at: new Date().toISOString()
    };
  }

  /**
   * 刷新并保存到文件（原有逻辑）
   */
  async refreshToken() {
    try {
      const newTokenData = await this._doRefresh();
      await this.saveToken(newTokenData);
      return newTokenData;
    } catch (error) {
      const errorMsg = error.response?.data || error.message;
      throw new Error(`Token 刷新失败: ${JSON.stringify(errorMsg)}`);
    }
  }

  /**
   * 仅刷新并返回新数据（不写文件，供监控服务和路由使用）
   */
  async refreshTokenOnly() {
    try {
      const newTokenData = await this._doRefresh();
      this.tokenData = newTokenData;
      return newTokenData;
    } catch (error) {
      const errorMsg = error.response?.data || error.message;
      throw new Error(`Token 刷新失败: ${JSON.stringify(errorMsg)}`);
    }
  }

  async getValidToken() {
    if (!this.tokenData) {
      await this.loadToken();
    }
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }
    return this.tokenData.access_token;
  }

  getTokenInfo() {
    return {
      email: this.tokenData?.email,
      account_id: this.tokenData?.account_id,
      expired_at: this.tokenData?.expired_at,
      type: this.tokenData?.type
    };
  }
}

export default TokenManager;
