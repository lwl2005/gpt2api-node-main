import axios from 'axios';
import http from 'http';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';

const DEFAULT_UPSTREAM_MODEL = 'gpt-5.3-codex';
function getRequestTimeout() { return parseInt(process.env.REQUEST_TIMEOUT || '90000'); }
function getStreamTimeout() { return parseInt(process.env.STREAM_TIMEOUT || '120000'); }
function getCollectTimeout() { return Math.min(getRequestTimeout(), 60000); }

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, maxFreeSockets: 50, keepAliveMsecs: 60000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, maxFreeSockets: 50, keepAliveMsecs: 60000 });

let _proxyAgent = null;
let _lastProxyUrl = null;
function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return null;
  if (proxyUrl !== _lastProxyUrl) {
    _proxyAgent = new HttpsProxyAgent(proxyUrl);
    _lastProxyUrl = proxyUrl;
    console.log(`[Proxy] 使用代理: ${proxyUrl}`);
  }
  return _proxyAgent;
}

const MODEL_MAP = {
  'gpt-5.4':            'gpt-5.3-codex',
  'gpt-5.3':            'gpt-5.3-codex',
  'gpt-5.3-codex':      'gpt-5.3-codex',
  'gpt-5.2':            'gpt-5.2-codex',
  'gpt-5.2-codex':      'gpt-5.2-codex',
  'gpt-5.1':            'gpt-5.1-codex',
  'gpt-5.1-codex':      'gpt-5.1-codex',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max':  'gpt-5.1-codex-max',
  'gpt-5':              'gpt-5-codex',
  'gpt-5-codex':        'gpt-5-codex',
  'gpt-5-codex-mini':   'gpt-5-codex-mini',
};

class ProxyHandler {
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
  }

  static resolveModel(clientModel) {
    if (!clientModel) return DEFAULT_UPSTREAM_MODEL;
    const mapped = MODEL_MAP[clientModel];
    if (mapped) return mapped;
    if (clientModel.includes('-codex')) return clientModel;
    return clientModel + '-codex';
  }

  generateSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  _buildHeaders(accessToken) {
    return {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': CODEX_USER_AGENT,
      'Version': CODEX_CLIENT_VERSION,
      'Openai-Beta': 'responses=experimental',
      'Session_id': this.generateSessionId(),
      'Accept': 'text/event-stream'
    };
  }

  async _postStream(codexRequest, accessToken, timeoutMs) {
    if (!timeoutMs) timeoutMs = getRequestTimeout();
    codexRequest.stream = true;
    codexRequest.store = false;

    const controller = new AbortController();
    const connectTimeout = parseInt(process.env.CONNECT_TIMEOUT || '15000');
    const connectTimer = setTimeout(() => controller.abort(), connectTimeout);

    try {
      const proxy = getProxyAgent();
      const response = await axios.post(`${CODEX_BASE_URL}/responses`, codexRequest, {
        headers: this._buildHeaders(accessToken),
        responseType: 'stream',
        timeout: timeoutMs,
        signal: controller.signal,
        httpAgent: proxy || keepAliveHttpAgent,
        httpsAgent: proxy || keepAliveHttpsAgent,
        proxy: false,
        maxRedirects: 3
      });
      clearTimeout(connectTimer);
      return response;
    } catch (err) {
      clearTimeout(connectTimer);
      if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
        const connErr = new Error(`上游连接超时 (${connectTimeout/1000}s)`);
        connErr.code = 'ECONNABORTED';
        throw connErr;
      }
      throw err;
    }
  }

  /**
   * 从流中收集完整响应，带超时保护和增量内容回退
   */
  _collectStreamResponse(stream) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let completed = null;
      let contentParts = [];
      let functionCalls = [];
      let currentFnCall = null;
      let responseId = null;
      let responseModel = null;
      let lastDataTime = Date.now();
      const debugEventTypes = [];

      const DATA_STALL_TIMEOUT = 20000;

      const checkStall = () => {
        if (Date.now() - lastDataTime > DATA_STALL_TIMEOUT) {
          stream.destroy();
          if (completed) {
            if (functionCalls.length > 0) completed._functionCalls = functionCalls;
            resolve(completed);
          } else if (contentParts.length > 0 || functionCalls.length > 0) {
            const fb = this._buildFallbackResponse(contentParts, responseId, responseModel);
            if (functionCalls.length > 0) fb._functionCalls = functionCalls;
            resolve(fb);
          } else {
            reject(new Error(`上游数据中断 (${DATA_STALL_TIMEOUT/1000}s 无新数据)`));
          }
          return;
        }
      };
      const stallInterval = setInterval(checkStall, 5000);

      const collectTimeout = getCollectTimeout();
      const timeout = setTimeout(() => {
        clearInterval(stallInterval);
        stream.destroy();
        if (completed) {
          if (functionCalls.length > 0) completed._functionCalls = functionCalls;
          resolve(completed);
        } else if (contentParts.length > 0 || functionCalls.length > 0) {
          const fb = this._buildFallbackResponse(contentParts, responseId, responseModel);
          if (functionCalls.length > 0) fb._functionCalls = functionCalls;
          resolve(fb);
        } else {
          reject(new Error(`流收集超时 (${collectTimeout/1000}s)，未收到任何有效数据`));
        }
      }, collectTimeout);

      stream.on('data', (chunk) => {
        lastDataTime = Date.now();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type && debugEventTypes.length < 30) debugEventTypes.push(parsed.type);
            if (parsed.type === 'response.completed') {
              completed = parsed;
            } else if (parsed.type === 'response.output_text.delta' && parsed.delta) {
              contentParts.push(parsed.delta);
            } else if (parsed.type === 'response.reasoning_summary_text.delta' && parsed.delta) {
              contentParts.push(parsed.delta);
            } else if (parsed.type === 'response.created') {
              responseId = parsed.response?.id;
              responseModel = parsed.response?.model;
            } else if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
              currentFnCall = { call_id: parsed.item.call_id, name: parsed.item.name, arguments: '' };
            } else if (parsed.type === 'response.function_call_arguments.delta' && currentFnCall) {
              currentFnCall.arguments += parsed.delta || '';
            } else if (parsed.type === 'response.function_call_arguments.done' && currentFnCall) {
              functionCalls.push({ ...currentFnCall });
              currentFnCall = null;
            } else if (parsed.type === 'error' || parsed.type === 'response.failed' || parsed.error) {
              stream.destroy();
              clearTimeout(timeout);
              clearInterval(stallInterval);
              reject(new Error(`上游错误: ${parsed.error?.message || parsed.message || 'unknown'}`));
              return;
            }
          } catch {}
        }
      });

      stream.on('end', () => {
        clearTimeout(timeout);
        clearInterval(stallInterval);
        if (buffer.trim().startsWith('data:')) {
          const data = buffer.trim().slice(5).trim();
          try {
            const parsed = JSON.parse(data);
            if (parsed.type) debugEventTypes.push(parsed.type);
            if (parsed.type === 'response.completed') completed = parsed;
            else if (parsed.type === 'response.output_text.delta' && parsed.delta) contentParts.push(parsed.delta);
            else if (parsed.type === 'response.function_call_arguments.delta' && currentFnCall) currentFnCall.arguments += parsed.delta || '';
            else if (parsed.type === 'response.function_call_arguments.done' && currentFnCall) { functionCalls.push({ ...currentFnCall }); currentFnCall = null; }
          } catch {}
        }

        if (contentParts.length === 0 && functionCalls.length === 0 && !completed) {
          console.warn(`[Collect Debug] 空响应, events: [${debugEventTypes.join(', ')}]`);
        }

        if (completed) {
          if (functionCalls.length > 0) completed._functionCalls = functionCalls;
          resolve(completed);
        } else if (contentParts.length > 0 || functionCalls.length > 0) {
          const fallback = this._buildFallbackResponse(contentParts, responseId, responseModel);
          if (functionCalls.length > 0) fallback._functionCalls = functionCalls;
          resolve(fallback);
        } else {
          resolve(null);
        }
      });

      stream.on('error', (err) => {
        clearTimeout(timeout);
        clearInterval(stallInterval);
        if (completed) {
          resolve(completed);
        } else if (contentParts.length > 0) {
          resolve(this._buildFallbackResponse(contentParts, responseId, responseModel));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * 当没收到 response.completed 但已收到部分内容时，构建回退响应
   */
  _buildFallbackResponse(contentParts, responseId, responseModel) {
    const content = contentParts.join('');
    return {
      type: 'response.completed',
      response: {
        id: responseId || 'resp-fallback-' + Date.now(),
        model: responseModel || DEFAULT_UPSTREAM_MODEL,
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }]
        }],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      }
    };
  }

  // ==================== 请求转换 ====================

  transformRequest(openaiRequest) {
    const { model, messages, stream_options, ...rest } = openaiRequest;

    let instructions = '';
    const userMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const content = Array.isArray(msg.content)
          ? msg.content.map(c => c.text || c).join('\n')
          : msg.content;
        instructions += (instructions ? '\n' : '') + content;
      } else {
        userMessages.push(msg);
      }
    }

    const input = [];
    for (const msg of userMessages) {
      if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
        const parts = [];
        if (msg.content) parts.push({ type: 'output_text', text: msg.content });
        input.push({ type: 'message', role: 'assistant', content: parts.length > 0 ? parts : [{ type: 'output_text', text: '' }] });
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments || ''
          });
        }
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      } else {
        const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
        input.push({
          type: 'message',
          role: msg.role,
          content: Array.isArray(msg.content)
            ? msg.content.map(c => {
                if (c.type === 'text') return { type: contentType, text: c.text || c };
                if (c.type === 'image_url') return { type: 'input_image', image_url: c.image_url?.url || c.image_url };
                return c;
              })
            : [{ type: contentType, text: msg.content || '' }]
        });
      }
    }

    const codexRequest = {
      model: ProxyHandler.resolveModel(model),
      input,
      instructions: instructions || '',
      stream: true,
      store: false
    };

    if (rest.temperature !== undefined) codexRequest.temperature = rest.temperature;
    if (rest.max_tokens !== undefined) codexRequest.max_output_tokens = rest.max_tokens;
    if (rest.max_completion_tokens !== undefined) codexRequest.max_output_tokens = rest.max_completion_tokens;
    if (rest.top_p !== undefined) codexRequest.top_p = rest.top_p;

    if (rest.tools && Array.isArray(rest.tools)) {
      codexRequest.tools = rest.tools.map(tool => {
        if (tool.type === 'function' && tool.function) {
          return {
            type: 'function',
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: tool.function.parameters || {}
          };
        }
        return tool;
      });
      if (rest.tool_choice) codexRequest.tool_choice = rest.tool_choice;
    }

    return codexRequest;
  }

  transformCompletionsRequest(completionsRequest) {
    const { model, prompt, ...rest } = completionsRequest;
    const promptText = Array.isArray(prompt) ? prompt.join('\n') : prompt;

    const codexRequest = {
      model: ProxyHandler.resolveModel(model),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptText }] }],
      instructions: '',
      stream: true,
      store: false
    };

    if (rest.temperature !== undefined) codexRequest.temperature = rest.temperature;
    if (rest.max_tokens !== undefined) codexRequest.max_tokens = rest.max_tokens;
    if (rest.top_p !== undefined) codexRequest.top_p = rest.top_p;

    return codexRequest;
  }

  // ==================== 响应转换 ====================

  transformResponse(codexResponse, model, isStream = false, state = {}) {
    if (isStream) {
      const line = codexResponse.toString().trim();
      if (!line.startsWith('data:')) return null;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return 'data: [DONE]\n\n';

      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'response.created') {
          state.responseId = parsed.response?.id;
          state.createdAt = parsed.response?.created_at || Math.floor(Date.now() / 1000);
          state.model = parsed.response?.model || model;
          return null;
        }

        if (parsed.type === 'error' || parsed.type === 'response.failed' || parsed.error) {
          state.upstreamError = parsed.error?.message || parsed.message || 'upstream error';
          return null;
        }

        const responseId = state.responseId || 'chatcmpl-' + Date.now();
        const createdAt = state.createdAt || Math.floor(Date.now() / 1000);
        const modelName = state.model || model;

        if (parsed.type === 'response.output_text.delta') {
          if (parsed.delta) {
            state.hasContent = true;
            return `data: ${JSON.stringify({
              id: responseId, object: 'chat.completion.chunk', created: createdAt, model: modelName,
              choices: [{ index: 0, delta: { role: 'assistant', content: parsed.delta }, finish_reason: null }]
            })}\n\n`;
          }
          return null;
        } else if (parsed.type === 'response.reasoning_summary_text.delta') {
          if (parsed.delta) {
            state.hasContent = true;
            return `data: ${JSON.stringify({
              id: responseId, object: 'chat.completion.chunk', created: createdAt, model: modelName,
              choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: parsed.delta }, finish_reason: null }]
            })}\n\n`;
          }
          return null;
        } else if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
          state.hasContent = true;
          state.toolCallIndex = (state.toolCallIndex ?? -1) + 1;
          state.finishReason = 'tool_calls';
          return `data: ${JSON.stringify({
            id: responseId, object: 'chat.completion.chunk', created: createdAt, model: modelName,
            choices: [{ index: 0, delta: {
              tool_calls: [{ index: state.toolCallIndex, id: parsed.item.call_id || `call_${Date.now()}`, type: 'function', function: { name: parsed.item.name, arguments: '' } }]
            }, finish_reason: null }]
          })}\n\n`;
        } else if (parsed.type === 'response.function_call_arguments.delta' && parsed.delta) {
          state.hasContent = true;
          return `data: ${JSON.stringify({
            id: responseId, object: 'chat.completion.chunk', created: createdAt, model: modelName,
            choices: [{ index: 0, delta: {
              tool_calls: [{ index: state.toolCallIndex ?? 0, function: { arguments: parsed.delta } }]
            }, finish_reason: null }]
          })}\n\n`;
        } else if (parsed.type === 'response.completed') {
          const usage = parsed.response?.usage || {};
          state.usage = {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
          };
          const respStatus = parsed.response?.status;
          if (respStatus && respStatus !== 'completed') {
            state.upstreamError = `response status: ${respStatus}`;
            return null;
          }
          const finishReason = state.finishReason || 'stop';
          return `data: ${JSON.stringify({
            id: responseId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 }
          })}\n\n`;
        }
      } catch { return null; }
      return null;
    } else {
      const parsed = typeof codexResponse === 'string' ? JSON.parse(codexResponse) : codexResponse;
      const response = parsed.response || {};
      const output = response.output || [];
      let content = '';
      const toolCalls = [];
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text') content += part.text || '';
          }
        } else if (item.type === 'function_call') {
          toolCalls.push({
            id: item.call_id || `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '' }
          });
        }
      }
      if (parsed._functionCalls?.length > 0 && toolCalls.length === 0) {
        for (const fc of parsed._functionCalls) {
          toolCalls.push({
            id: fc.call_id || `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: fc.name, arguments: fc.arguments || '' }
          });
        }
      }
      const usage = response.usage || {};
      const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      const message = { role: 'assistant', content: content || null };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      return {
        id: response.id || 'chatcmpl-' + Date.now(), object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 },
        _usage_raw: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 }
      };
    }
  }

  transformCompletionsResponse(codexResponse, model, isStream = false, state = {}) {
    if (isStream) {
      const line = codexResponse.toString().trim();
      if (!line.startsWith('data:')) return null;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return 'data: [DONE]\n\n';

      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'response.created') {
          state.responseId = parsed.response?.id;
          state.createdAt = parsed.response?.created_at || Math.floor(Date.now() / 1000);
          state.model = parsed.response?.model || model;
          return null;
        }
        const responseId = state.responseId || 'cmpl-' + Date.now();
        const createdAt = state.createdAt || Math.floor(Date.now() / 1000);
        const modelName = state.model || model;

        if (parsed.type === 'response.output_text.delta') {
          state.hasContent = true;
          return `data: ${JSON.stringify({
            id: responseId, object: 'text_completion', created: createdAt, model: modelName,
            choices: [{ text: parsed.delta || '', index: 0, finish_reason: null }]
          })}\n\n`;
        } else if (parsed.type === 'response.completed') {
          const usage = parsed.response?.usage || {};
          state.usage = {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
          };
          return `data: ${JSON.stringify({
            id: responseId, object: 'text_completion',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ text: '', index: 0, finish_reason: 'stop' }],
            usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 }
          })}\n\n`;
        }
      } catch { return null; }
      return null;
    } else {
      const parsed = typeof codexResponse === 'string' ? JSON.parse(codexResponse) : codexResponse;
      const response = parsed.response || {};
      const output = response.output || [];
      let text = '';
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text') text += part.text || '';
          }
        }
      }
      const usage = response.usage || {};
      return {
        id: response.id || 'cmpl-' + Date.now(), object: 'text_completion',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ text, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.total_tokens || 0 },
        _usage_raw: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 }
      };
    }
  }

  // ==================== Chat Completions ====================
  // 所有 handler 返回 { usage: { input_tokens, output_tokens } } 供调用者记录

  async handleStreamRequest(req, res) {
    const openaiRequest = req.body;
    const codexRequest = this.transformRequest(openaiRequest);
    const accessToken = await this.tokenManager.getValidToken();

    const response = await this._postStream(codexRequest, accessToken, getStreamTimeout());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    return new Promise((resolve, reject) => {
      let buffer = '';
      const state = {};
      let lastData = Date.now();
      let settled = false;
      const FIRST_BYTE_TIMEOUT = 15000;
      const STALL_TIMEOUT = 20000;

      const stallCheck = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - lastData;
        const limit = state.hasContent ? STALL_TIMEOUT : FIRST_BYTE_TIMEOUT;
        if (elapsed > limit) {
          settled = true;
          clearInterval(stallCheck);
          response.data.destroy();
          if (state.hasContent) {
            res.write('data: [DONE]\n\n');
            res.end();
            resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
          } else if (!res.headersSent) {
            reject(new Error(`上游无响应 (${limit/1000}s)`));
          } else {
            res.end();
            resolve({ usage: { input_tokens: 0, output_tokens: 0 } });
          }
        }
      }, 3000);

      const debugEvents = [];

      response.data.on('data', (chunk) => {
        lastData = Date.now();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:') && trimmed.length > 6) {
              const raw = trimmed.slice(5).trim();
              if (raw !== '[DONE]') {
                try {
                  const evt = JSON.parse(raw);
                  if (evt.type && debugEvents.length < 20) debugEvents.push(evt.type);
                } catch {}
              }
            }
            const transformed = this.transformResponse(line, openaiRequest.model, true, state);
            if (transformed) res.write(transformed);
          }
        }
      });

      response.data.on('end', () => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (buffer.trim()) {
          const transformed = this.transformResponse(buffer, openaiRequest.model, true, state);
          if (transformed) res.write(transformed);
        }
        if (state.upstreamError && !res.headersSent) {
          console.warn(`[Stream Debug] 上游错误, events: [${debugEvents.join(', ')}]`);
          reject(new Error(`上游错误: ${state.upstreamError}`));
          return;
        }
        if (!state.hasContent && !res.headersSent) {
          console.warn(`[Stream Debug] 空响应, events: [${debugEvents.join(', ')}]`);
          reject(new Error('上游返回空响应 (无内容)'));
          return;
        }
        if (state.hasContent) {
          res.write('data: [DONE]\n\n');
          res.end();
          resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
        } else {
          res.end();
          resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
        }
      });

      response.data.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (!res.headersSent) {
          reject(error);
        } else if (state.hasContent) {
          res.write('data: [DONE]\n\n');
          res.end();
          resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
        } else {
          res.end();
          resolve({ usage: { input_tokens: 0, output_tokens: 0 } });
        }
      });
    });
  }

  async handleNonStreamRequest(req, res) {
    const openaiRequest = req.body;
    const codexRequest = this.transformRequest(openaiRequest);
    const accessToken = await this.tokenManager.getValidToken();

    const response = await this._postStream(codexRequest, accessToken);
    const finalResponse = await this._collectStreamResponse(response.data);
    if (!finalResponse) throw new Error('未收到完整响应');

    const transformed = this.transformResponse(finalResponse, openaiRequest.model, false);
    const msg = transformed.choices?.[0]?.message;
    if (!msg?.content && !msg?.tool_calls?.length) {
      throw new Error('上游返回空响应 (无内容)');
    }
    res.json(transformed);
    return { usage: transformed._usage_raw || { input_tokens: 0, output_tokens: 0 } };
  }

  // ==================== Responses API 直通 ====================

  async handleResponsesStreamRequest(req, res) {
    const requestBody = { ...req.body, stream: true, store: false };
    const accessToken = await this.tokenManager.getValidToken();
    const response = await this._postStream(requestBody, accessToken, getStreamTimeout());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    return new Promise((resolve, reject) => {
      let usage = { input_tokens: 0, output_tokens: 0 };
      let lastData = Date.now();
      let settled = false;
      let hasData = false;
      const FIRST_BYTE_TIMEOUT = 15000;
      const STALL_TIMEOUT = 20000;

      const stallCheck = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - lastData;
        const limit = hasData ? STALL_TIMEOUT : FIRST_BYTE_TIMEOUT;
        if (elapsed > limit) {
          settled = true;
          clearInterval(stallCheck);
          response.data.destroy();
          if (!res.headersSent) reject(new Error(`上游无响应 (${limit/1000}s)`));
          else { res.end(); resolve({ usage }); }
        }
      }, 3000);

      response.data.on('data', (chunk) => {
        lastData = Date.now();
        hasData = true;
        const str = chunk.toString();
        try {
          const lines = str.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              if ((parsed.type === 'error' || parsed.type === 'response.failed' || parsed.error) && !res.headersSent) {
                settled = true;
                clearInterval(stallCheck);
                response.data.destroy();
                reject(new Error(`上游错误: ${parsed.error?.message || parsed.message || 'unknown'}`));
                return;
              }
              if (parsed.type === 'response.completed' && parsed.response?.usage) {
                usage = { input_tokens: parsed.response.usage.input_tokens || 0, output_tokens: parsed.response.usage.output_tokens || 0 };
              }
            } catch {}
          }
        } catch {}
        if (!settled) res.write(chunk);
      });
      response.data.on('end', () => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (!hasData && !res.headersSent) {
          reject(new Error('上游返回空响应'));
          return;
        }
        res.end();
        resolve({ usage });
      });
      response.data.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (!res.headersSent) reject(error);
        else { res.end(); resolve({ usage }); }
      });
    });
  }

  async handleResponsesNonStreamRequest(req, res) {
    const requestBody = { ...req.body, stream: true, store: false };
    const accessToken = await this.tokenManager.getValidToken();
    const response = await this._postStream(requestBody, accessToken);
    const finalResponse = await this._collectStreamResponse(response.data);
    if (!finalResponse) throw new Error('未收到完整响应');

    const respData = finalResponse.response || finalResponse;
    res.json(respData);
    const usage = respData.usage || finalResponse.response?.usage || {};
    return { usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 } };
  }

  // ==================== Legacy Completions ====================

  async handleCompletionsStreamRequest(req, res) {
    const codexRequest = this.transformCompletionsRequest(req.body);
    const accessToken = await this.tokenManager.getValidToken();
    const response = await this._postStream(codexRequest, accessToken, getStreamTimeout());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    return new Promise((resolve, reject) => {
      let buffer = '';
      const state = {};
      let lastData = Date.now();
      let settled = false;
      const FIRST_BYTE_TIMEOUT = 15000;
      const STALL_TIMEOUT = 20000;

      const stallCheck = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - lastData;
        const limit = state.hasContent ? STALL_TIMEOUT : FIRST_BYTE_TIMEOUT;
        if (elapsed > limit) {
          settled = true;
          clearInterval(stallCheck);
          response.data.destroy();
          if (state.hasContent) {
            res.write('data: [DONE]\n\n');
            res.end();
            resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
          } else if (!res.headersSent) {
            reject(new Error(`上游无响应 (${limit/1000}s)`));
          } else {
            res.end();
            resolve({ usage: { input_tokens: 0, output_tokens: 0 } });
          }
        }
      }, 3000);

      response.data.on('data', (chunk) => {
        lastData = Date.now();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            const transformed = this.transformCompletionsResponse(line, req.body.model, true, state);
            if (transformed) res.write(transformed);
          }
        }
      });

      response.data.on('end', () => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (buffer.trim()) {
          const transformed = this.transformCompletionsResponse(buffer, req.body.model, true, state);
          if (transformed) res.write(transformed);
        }
        if (!state.hasContent && !res.headersSent) {
          reject(new Error('上游返回空响应 (无内容)'));
          return;
        }
        if (state.hasContent) {
          res.write('data: [DONE]\n\n');
        }
        res.end();
        resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
      });

      response.data.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (!res.headersSent) reject(error);
        else {
          if (state.hasContent) res.write('data: [DONE]\n\n');
          res.end();
          resolve({ usage: state.usage || { input_tokens: 0, output_tokens: 0 } });
        }
      });
    });
  }

  async handleCompletionsNonStreamRequest(req, res) {
    const codexRequest = this.transformCompletionsRequest(req.body);
    const accessToken = await this.tokenManager.getValidToken();
    const response = await this._postStream(codexRequest, accessToken);
    const finalResponse = await this._collectStreamResponse(response.data);
    if (!finalResponse) throw new Error('未收到完整响应');

    const transformed = this.transformCompletionsResponse(finalResponse, req.body.model, false);
    if (!transformed.choices?.[0]?.text) {
      throw new Error('上游返回空响应 (无内容)');
    }
    res.json(transformed);
    return { usage: transformed._usage_raw || { input_tokens: 0, output_tokens: 0 } };
  }
}

export default ProxyHandler;
