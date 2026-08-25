'use strict';

/**
 * OpenCode Go/Zen 本地故障转移代理（核心模块，供桌面应用与 CLI 共用）。
 *
 * - 把多个 OpenCode API Key 组成一个轮换池：请求遇 401/402/429（或 403 + 配额文案）
 *   时自动切换到下一把 Key 并重放同一请求，对上游客户端（DSH）完全透明。
 * - 按 Key 统计请求数与输入/输出 token（流式请求从 SSE 末尾的 usage 块读取）。
 * - 改写出站 JSON 中 `messages[].role: "developer"` 为 `"system"`，因为 DSH 把
 *   baseURL 指向本代理后，pi-ai 的兼容性自动检测会启用 developer 角色，而
 *   OpenCode 端点会静默忽略 developer 角色（实测），改写可保住系统提示词。
 * - 路径分发：`/v1/messages*` → https://opencode.ai/zen/go（Anthropic 协议），
 *   其余 → https://opencode.ai/zen/go/v1（OpenAI 协议，去掉多余的 /v1 前缀）。
 * - 管理端点（仅 127.0.0.1）：GET /__proxy/state、POST /__proxy/rotate、
 *   POST /__proxy/reload。
 *
 * 配置文件（默认 ~/.dsh/opencode-proxy.json）：
 *   { "enabled": true, "port": 8787, "keys": ["sk-..."], "activeIndex": 0,
 *     "usage": [ { "requests": 0, "inputTokens": 0, "outputTokens": 0,
 *                  "quotaFailures": 0, "lastUsedAt": null } ] }
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const DEFAULT_PORT = 8787;
const UPSTREAM_ANTHROPIC = 'https://opencode.ai/zen/go';
const UPSTREAM_OPENAI = 'https://opencode.ai/zen/go/v1';

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function defaultConfig(port) {
  return { enabled: true, port: port || DEFAULT_PORT, keys: [], activeIndex: 0, usage: [] };
}

function normalizeUsage(u) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    quotaFailures: 0,
    lastUsedAt: null,
    ...(u && typeof u === 'object' ? u : {}),
  };
}

function loadConfig(configPath, fallbackPort) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cfg = { ...defaultConfig(fallbackPort), ...raw };
    cfg.keys = (Array.isArray(cfg.keys) ? cfg.keys : [])
      .map((k) => String(k).trim())
      .filter(Boolean);
    cfg.port = Number(cfg.port) || fallbackPort || DEFAULT_PORT;
    cfg.activeIndex = Number.isInteger(cfg.activeIndex) ? cfg.activeIndex : 0;
    if (cfg.keys.length === 0 || cfg.activeIndex < 0 || cfg.activeIndex >= cfg.keys.length) {
      cfg.activeIndex = 0;
    }
    const prevUsage = Array.isArray(cfg.usage) ? cfg.usage : [];
    cfg.usage = cfg.keys.map((_k, i) => normalizeUsage(prevUsage[i]));
    return cfg;
  } catch (_err) {
    return defaultConfig(fallbackPort);
  }
}

function maskKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  if (s.startsWith('sk-')) {
    return s.length <= 12 ? 'sk-***' : `${s.slice(0, 7)}…${s.slice(-4)}`;
  }
  return s.length <= 6 ? '******' : `${s.slice(0, 2)}…${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// 请求处理辅助
// ---------------------------------------------------------------------------
function isQuotaFailure(status, text) {
  if (status === 401 || status === 402 || status === 429) return true;
  if (status === 403 && /quota|limit|plan|entitle|subscription|exceed/i.test(String(text || ''))) return true;
  return false;
}

function isStreamRequest(bodyBuf) {
  try {
    const obj = JSON.parse(bodyBuf.toString('utf8'));
    return obj && obj.stream === true;
  } catch (_err) {
    return false;
  }
}

/** developer 角色 → system（OpenCode 端点静默忽略 developer 角色）。 */
function transformBody(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return bodyBuf;
  try {
    const obj = JSON.parse(bodyBuf.toString('utf8'));
    let changed = false;
    if (obj && Array.isArray(obj.messages)) {
      for (const m of obj.messages) {
        if (m && typeof m === 'object' && m.role === 'developer') {
          m.role = 'system';
          changed = true;
        }
      }
    }
    return changed ? Buffer.from(JSON.stringify(obj), 'utf8') : bodyBuf;
  } catch (_err) {
    return bodyBuf;
  }
}

function upstreamTarget(pathname) {
  if (pathname.startsWith('/v1/messages')) {
    return { base: UPSTREAM_ANTHROPIC, path: pathname };
  }
  const p = pathname.replace(/^\/v1(?=\/)/, '');
  return { base: UPSTREAM_OPENAI, path: p || '/chat/completions' };
}

function buildUpstreamHeaders(req, key) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lower = k.toLowerCase();
    if (['host', 'connection', 'authorization', 'x-api-key', 'content-length', 'accept-encoding', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade'].includes(lower)) continue;
    headers[k] = v;
  }
  headers.authorization = `Bearer ${key}`;
  // 强制明文传输：SSE 用量扫描需要未压缩的响应。
  headers['accept-encoding'] = 'identity';
  return headers;
}

function writeBufferedResponse(res, result) {
  const headers = {};
  for (const [k, v] of Object.entries(result.headers || {})) {
    const lower = k.toLowerCase();
    if (['transfer-encoding', 'connection', 'keep-alive', 'content-length', 'proxy-connection'].includes(lower)) continue;
    headers[k] = v;
  }
  const body = result.body || Buffer.alloc(0);
  headers['content-length'] = Buffer.byteLength(body);
  res.writeHead(result.status || 502, headers);
  res.end(body);
}

function parseUsageFromJson(bodyBuf) {
  try {
    const obj = JSON.parse(bodyBuf.toString('utf8'));
    const u = obj && obj.usage;
    if (!u) return null;
    const input = u.prompt_tokens ?? u.input_tokens ?? 0;
    const output = u.completion_tokens ?? u.output_tokens ?? 0;
    return { inputTokens: Number(input) || 0, outputTokens: Number(output) || 0 };
  } catch (_err) {
    return null;
  }
}

/** 从 SSE 数据流中抓取最后的 usage 块（choices:[] + usage）。 */
class SseUsageScanner {
  constructor() {
    this.buffer = '';
    this.lastUsage = null;
  }
  feed(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (obj && obj.usage && typeof obj.usage === 'object') {
          const input = obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? 0;
          const output = obj.usage.completion_tokens ?? obj.usage.output_tokens ?? 0;
          this.lastUsage = { inputTokens: Number(input) || 0, outputTokens: Number(output) || 0 };
        }
      } catch (_err) {
        // 非 JSON 行，忽略
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 单次上游转发
// ---------------------------------------------------------------------------
function forwardOnce(state, keyIndex, req, bodyBuf, streamMode, clientRes, log) {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url, 'http://localhost');
    const target = upstreamTarget(url.pathname);
    const upstreamUrl = new URL(target.base);
    const headers = buildUpstreamHeaders(req, state.keys[keyIndex]);
    if (target.path.startsWith('/v1/messages')) {
      // OpenCode 的 Anthropic 协议端点按 x-api-key 鉴权
      headers['x-api-key'] = state.keys[keyIndex];
    }
    headers['content-length'] = Buffer.byteLength(bodyBuf);

    const upstreamReq = https.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        method: req.method,
        path: `${upstreamUrl.pathname.replace(/\/+$/, '')}${target.path}`,
        headers,
      },
      (ures) => {
        const status = ures.statusCode || 502;
        if (streamMode && status < 400) {
          // 流式成功：逐块透传 + SSE 用量扫描
          const outHeaders = {};
          for (const [k, v] of Object.entries(ures.headers || {})) {
            const lower = k.toLowerCase();
            if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection'].includes(lower)) continue;
            outHeaders[k] = v;
          }
          clientRes.writeHead(status, outHeaders);
          const scanner = new SseUsageScanner();
          ures.on('data', (chunk) => {
            scanner.feed(chunk);
            clientRes.write(chunk);
          });
          ures.on('end', () => {
            clientRes.end();
            resolve({ ok: true, streamed: true, usage: scanner.lastUsage });
          });
          ures.on('error', (err) => {
            clientRes.destroy(err);
            resolve({ ok: true, streamed: true, usage: scanner.lastUsage, aborted: true });
          });
        } else {
          // 缓冲响应（错误或非流式）：需要读 body 判断配额错误 / 统计用量
          const chunks = [];
          ures.on('data', (c) => chunks.push(c));
          ures.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf8');
            const usage = status < 400 && !streamMode ? parseUsageFromJson(body) : null;
            resolve({ ok: status < 400, streamed: false, status, headers: ures.headers, body, bodyText: text.slice(0, 4000), usage });
          });
          ures.on('error', (err) => reject(err));
        }
      },
    );
    upstreamReq.on('error', (err) => reject(err));
    upstreamReq.end(bodyBuf);
  });
}

// ---------------------------------------------------------------------------
// 服务器主体
// ---------------------------------------------------------------------------
function startOpenCodeProxy({ configPath, log = () => {} }) {
  const initial = loadConfig(configPath, DEFAULT_PORT);
  const state = {
    configPath,
    enabled: initial.enabled !== false,
    port: initial.port,
    keys: initial.keys,
    activeIndex: initial.activeIndex,
    usage: initial.usage,
    startedAt: Date.now(),
  };

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const doc = {
          enabled: state.enabled,
          port: state.port,
          keys: state.keys,
          activeIndex: state.activeIndex,
          usage: state.usage,
        };
        fs.mkdirSync(require('node:path').dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(doc, null, 2), 'utf8');
      } catch (err) {
        log(`save failed: ${err && err.message}`);
      }
    }, 300);
  }

  function publicState() {
    return {
      ok: true,
      running: !bindError,
      bindError: bindError ? bindError.message : null,
      port: state.port,
      enabled: state.enabled,
      activeIndex: state.activeIndex,
      startedAt: state.startedAt,
      keys: state.keys.map(maskKey),
      usage: state.usage.map((u) => ({ ...u })),
    };
  }

  function recordUsage(keyIndex, usage) {
    const slot = state.usage[keyIndex];
    if (!slot) return;
    slot.requests += 1;
    if (usage) {
      slot.inputTokens += usage.inputTokens || 0;
      slot.outputTokens += usage.outputTokens || 0;
    }
    slot.lastUsedAt = Date.now();
    scheduleSave();
  }

  function respondJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }

  async function handleModelRequest(req, res, bodyBuf) {
    if (state.keys.length === 0) {
      respondJson(res, 502, { error: { message: 'opencode proxy: no API keys configured' } });
      return;
    }
    const streamMode = isStreamRequest(bodyBuf);
    const outBody = transformBody(bodyBuf);
    const start = state.activeIndex;
    const tried = new Set();
    let lastFailure = null;

    for (let i = 0; i < state.keys.length; i += 1) {
      const idx = (start + i) % state.keys.length;
      if (tried.has(idx)) break;
      tried.add(idx);
      let result;
      try {
        result = await forwardOnce(state, idx, req, outBody, streamMode, res, log);
      } catch (err) {
        log(`key #${idx} (${maskKey(state.keys[idx])}) transport error: ${err && err.message}`);
        lastFailure = { streamed: false, status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: { message: `upstream error: ${err && err.message}` } })) };
        continue;
      }

      if (result.ok) {
        if (idx !== state.activeIndex) {
          log(`switched active key to #${idx} (${maskKey(state.keys[idx])})`);
          state.activeIndex = idx;
          scheduleSave();
        }
        recordUsage(idx, result.usage);
        if (!result.streamed && !result.aborted) writeBufferedResponse(res, result);
        return;
      }

      const text = result.bodyText || '';
      if (isQuotaFailure(result.status, text)) {
        log(`key #${idx} (${maskKey(state.keys[idx])}) rejected (HTTP ${result.status}): ${text.slice(0, 200) || '(no body)'}`);
        state.usage[idx].quotaFailures += 1;
        state.usage[idx].lastUsedAt = Date.now();
        scheduleSave();
        lastFailure = result;
        continue;
      }
      // 非配额类失败（如 400/404）：直接透传，不轮换
      writeBufferedResponse(res, result);
      return;
    }

    if (lastFailure) {
      log('all keys failed, returning last upstream error');
      writeBufferedResponse(res, lastFailure);
    } else {
      respondJson(res, 502, { error: { message: 'opencode proxy: no usable key' } });
    }
  }

  let bindError = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/__proxy/state' && req.method === 'GET') {
      respondJson(res, 200, publicState());
      return;
    }
    if (pathname === '/__proxy/rotate' && req.method === 'POST') {
      if (state.keys.length > 1) {
        state.activeIndex = (state.activeIndex + 1) % state.keys.length;
        scheduleSave();
        log(`manual rotate → key #${state.activeIndex} (${maskKey(state.keys[state.activeIndex])})`);
      }
      respondJson(res, 200, publicState());
      return;
    }
    if (pathname === '/__proxy/reload' && req.method === 'POST') {
      const fresh = loadConfig(configPath, state.port);
      state.enabled = fresh.enabled !== false;
      state.keys = fresh.keys;
      state.activeIndex = fresh.activeIndex;
      state.usage = fresh.usage;
      log(`reloaded config: ${state.keys.length} key(s)`);
      respondJson(res, 200, publicState());
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy();
        res.writeHead(413).end('payload too large');
      }
    });
    req.on('end', () => {
      void handleModelRequest(req, res, Buffer.concat(chunks)).catch((err) => {
        log(`handler error: ${err && err.stack}`);
        if (!res.headersSent) respondJson(res, 500, { error: { message: String(err && err.message || err) } });
        else res.destroy();
      });
    });
    req.on('error', () => {});
  });

  server.listen(state.port, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${state.port}`);
  });
  // 端口被占等异步错误只记录、不抛出：桌面应用不能因此崩溃。
  server.on('error', (err) => {
    bindError = err;
    log(`server error: ${err && err.message}`);
  });

  return {
    getState: publicState,
    rotate() {
      if (state.keys.length > 1) {
        state.activeIndex = (state.activeIndex + 1) % state.keys.length;
        scheduleSave();
        log(`manual rotate → key #${state.activeIndex} (${maskKey(state.keys[state.activeIndex])})`);
      }
      return publicState();
    },
    reload() {
      const fresh = loadConfig(configPath, state.port);
      state.enabled = fresh.enabled !== false;
      state.keys = fresh.keys;
      state.activeIndex = fresh.activeIndex;
      state.usage = fresh.usage;
      return publicState();
    },
    stop() {
      try {
        if (saveTimer) clearTimeout(saveTimer);
        server.close();
      } catch (_err) {
        // ignore
      }
    },
    get url() {
      return `http://127.0.0.1:${state.port}`;
    },
  };
}

module.exports = { startOpenCodeProxy, loadConfig, maskKey, DEFAULT_PORT };
