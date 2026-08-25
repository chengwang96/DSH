'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { startOpenCodeProxy, DEFAULT_PORT: PROXY_DEFAULT_PORT } = require('./proxy.js');

const APP_NAME = 'DeepSeek Harness';
const STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_PORT = 3000;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}
function logPath() {
  return path.join(logDir(), 'dsh-desktop.log');
}
let logStream = null;
function log(message) {
  try {
    if (!logStream) {
      fs.mkdirSync(logDir(), { recursive: true });
      logStream = fs.createWriteStream(logPath(), { flags: 'a' });
      logStream.write(`\n=== ${APP_NAME} desktop start ${new Date().toISOString()} ===\n`);
    }
    logStream.write(`[${new Date().toISOString()}] ${message}\n`);
  } catch (_err) {
    // Never let logging break startup.
  }
}

// ---------------------------------------------------------------------------
// Config (stored in the app's own userData, NOT in ~/.dsh which dsh itself owns)
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function defaultConfig() {
  return {
    dshBin: '',             // explicit path to @deepseek-ai/dsh/lib/bin.js (optional)
    nodeExe: '',            // explicit node.exe (optional)
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    dshHome: DSH_HOME,      // pass through as DSH_HOME env to the backend
    firstRunComplete: false, // set true after onboarding
  };
}

function loadConfig() {
  const defaults = defaultConfig();
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (_err) {
    return defaults;
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// OpenCode multi-key failover proxy (in-process, binds 127.0.0.1)
// ---------------------------------------------------------------------------
// Key pool lives in ~/.dsh/opencode-proxy.json so it is shared with the CLI
// runner and is NOT part of the repo.
function proxyConfigPath() {
  return path.join(DSH_HOME, 'opencode-proxy.json');
}

function readProxyConfig() {
  try {
    const raw = fs.readFileSync(proxyConfigPath(), 'utf8');
    const cfg = JSON.parse(raw);
    cfg.keys = (Array.isArray(cfg.keys) ? cfg.keys : []).map((k) => String(k).trim()).filter(Boolean);
    return cfg;
  } catch (_err) {
    return { enabled: true, port: PROXY_DEFAULT_PORT, keys: [], activeIndex: 0, usage: [] };
  }
}

function writeProxyConfig({ enabled, port, keys }) {
  const prev = readProxyConfig();
  const next = {
    enabled: enabled !== false,
    port: Number(port) || PROXY_DEFAULT_PORT,
    keys,
    activeIndex: 0,
    // 按位置保留用量统计：key 列表增删时尽量不丢已有计数
    usage: keys.map((_k, i) => (prev.usage && prev.usage[i]) || { requests: 0, inputTokens: 0, outputTokens: 0, quotaFailures: 0, lastUsedAt: null }),
  };
  fs.mkdirSync(path.dirname(proxyConfigPath()), { recursive: true });
  fs.writeFileSync(proxyConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

let proxyHandle = null;

function proxyActive() {
  const cfg = readProxyConfig();
  return cfg.enabled !== false && cfg.keys.length > 0;
}

function startProxy() {
  stopProxy();
  const cfg = readProxyConfig();
  if (cfg.enabled === false || cfg.keys.length === 0) {
    log('proxy: not started (disabled or no keys)');
    return;
  }
  try {
    proxyHandle = startOpenCodeProxy({
      configPath: proxyConfigPath(),
      log: (msg) => log(`[proxy] ${msg}`),
    });
    log(`proxy: listening on http://127.0.0.1:${proxyHandle.getState().port}`);
    syncProxyBaseUrl(true);
  } catch (err) {
    log(`proxy: start failed: ${err && err.message}`);
    proxyHandle = null;
  }
}

function stopProxy() {
  if (proxyHandle) {
    try { proxyHandle.stop(); } catch (_err) { /* ignore */ }
    proxyHandle = null;
  }
}

// Keep settings.yaml's opencode-go route pointing at the local proxy while it
// is active (and remove the override when it is not), so a stale baseURL can
// never strand the provider. Only the `baseURL:` line inside the opencode-go
// sub-block is added/removed; every other field stays untouched. The dsh
// backend hot-reloads this change.
function syncProxyBaseUrl(active) {
  try {
    const settingsFile = path.join(DSH_HOME, 'settings.yaml');
    const existing = readText(settingsFile) || '';
    const lines = existing.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^    opencode-go:\s*$/.test(l));
    if (idx < 0) return;
    let end = idx;
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '' || /^\s{6,}\S/.test(lines[i])) end = i;
      else break;
    }
    const block = lines.slice(idx + 1, end + 1).filter((l) => !/^\s{6}baseURL:\s*/.test(l));
    if (active) {
      const port = readProxyConfig().port || PROXY_DEFAULT_PORT;
      const apiIdx = block.findIndex((l) => /^\s{6}apiKeyEnv:\s*/.test(l));
      const baseLine = `      baseURL: http://127.0.0.1:${port}`;
      block.splice(apiIdx >= 0 ? apiIdx + 1 : 0, 0, baseLine);
    }
    const next = [...lines.slice(0, idx), '    opencode-go:', ...block, ...lines.slice(end + 1)].join('\n');
    if (next !== existing) {
      fs.writeFileSync(settingsFile, next, 'utf8');
      log(`proxy: settings.yaml opencode-go baseURL ${active ? '→ 127.0.0.1:' + readProxyConfig().port : 'removed'}`);
    }
  } catch (err) {
    log(`proxy: sync settings.yaml failed: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------------------
// YAML helpers for ~/.dsh/.credentials.yaml and settings.yaml
// ---------------------------------------------------------------------------
// The user opted for "configure API key on first launch". We write into the
// *shared* DSH_HOME so the same credential works for CLI use too. We use a
// minimal, ordered-preserving approach that does not depend on a YAML package:
// we only ever touch the simple top-level key structure these two files use.
function yamlEscape(value) {
  const s = String(value);
  // Keys/values here are plain strings; quote if ambiguous.
  if (/[\r\n:#"']/.test(s) || s !== s.trim() || s === '') {
    return JSON.stringify(s);
  }
  return s;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return null;
  }
}

// YAML-encode a plain-string scalar for a `key: value` line.
// Credential values here are API keys (alphanumeric + dashes), so plain output
// is safe; we still guard the handful of characters that would break a scalar.
function yamlScalar(value) {
  const s = String(value);
  if (/[\r\n:#]/.test(s) || s !== s.trim() || s === '') {
    return JSON.stringify(s);
  }
  return s;
}

// Set (or delete, when value is null/empty) a single top-level scalar key in a
// flat YAML file, preserving other lines and their order. The dsh credential
// document rejects empty-string values outright, so an empty value removes the
// key instead of blanking it.
function setYamlScalar(filePath, key, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readText(filePath) || '';
  const lines = existing.split(/\r?\n/);
  const keyLine = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  const deleting = value === null || value === undefined || String(value) === '';
  const out = [];
  for (const line of lines) {
    if (keyLine.test(line)) {
      if (!deleting) out.push(`${key}: ${yamlScalar(value)}`);
      // deleting: drop the line entirely
    } else {
      out.push(line);
    }
  }
  if (!deleting && !keyLineEmitted(out, key)) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(`${key}: ${yamlScalar(value)}`);
  }
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
}

function keyLineEmitted(lines, key) {
  const keyLine = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  return lines.some((l) => keyLine.test(l));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read a flat `KEY: value` entry from ~/.dsh/.credentials.yaml (no YAML parser
// needed for this shape; strips surrounding quotes).
function readCredential(name) {
  try {
    const text = readText(path.join(DSH_HOME, '.credentials.yaml')) || '';
    const match = text.match(new RegExp(`^${escapeRegExp(name)}:\\s*(.+)$`, 'm'));
    if (!match) return '';
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  } catch (_err) {
    return '';
  }
}

// DeepSeek 官方余额接口：GET https://api.deepseek.com/user/balance
function fetchDeepSeekBalance(apiKey) {
  return new Promise((resolve) => {
    const req = https.get('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try {
            resolve({ ok: true, data: JSON.parse(body) });
          } catch (_err) {
            resolve({ ok: false, error: '余额接口返回的数据无法解析' });
          }
        } else if (res.statusCode === 401) {
          resolve({ ok: false, error: 'API Key 无效（HTTP 401）' });
        } else if (res.statusCode === 402) {
          resolve({ ok: false, error: '账户余额不足或不可用（HTTP 402）' });
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('查询超时')); });
    req.on('error', (err) => resolve({ ok: false, error: `请求失败：${err && err.message || err}` }));
  });
}

// Write the credentials key -> env var mapping and the model/provider settings.
// The harness resolves `llm-pi-ai.providers.<id>.apiKeyEnv` to the env var in
// .credentials.yaml. We support two provider families:
//   - deepseek            -> DEEPSEEK_API_KEY
//   - opencode-go (llm-pi-ai) -> OPENCODE_GO_API_KEY
function applyCredentials(provider, apiKey) {
  const credentialsFile = path.join(DSH_HOME, '.credentials.yaml');
  const settingsFile = path.join(DSH_HOME, 'settings.yaml');

  let envKey;
  let settingsProviderId;
  switch (String(provider || '').toLowerCase()) {
    case 'deepseek':
      envKey = 'DEEPSEEK_API_KEY';
      settingsProviderId = 'deepseek';
      break;
    case 'opencode':
    case 'opencode-go':
    case 'pi-ai':
      envKey = 'OPENCODE_GO_API_KEY';
      settingsProviderId = 'opencode-go';
      break;
    default:
      // Treat unknown provider as a pi-ai compatible endpoint keyed by env var.
      envKey = provider ? String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY' : 'DEEPSEEK_API_KEY';
      settingsProviderId = 'opencode-go';
  }

  const trimmed = apiKey ? apiKey.trim() : '';
  const mask = trimmed ? (trimmed.startsWith('sk-') ? `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}` : '****') : '(empty)';
  log(`Writing credential env ${envKey} (${mask}) and provider settings to DSH_HOME=${DSH_HOME}`);

  // An empty key removes the entry (the credential document rejects empty values).
  setYamlScalar(credentialsFile, envKey, trimmed || null);

  // Update settings.yaml nested blocks without a YAML library: rewrite the
  // `agent-default-model` and `llm-pi-ai.providers` sections to the minimal form
  // the harness expects (mirroring the observed settings.yaml shape).
  const model = provider === 'deepseek' ? defaultDeepseekModel(settingsFile) : 'deepseek-v4-pro';
  updateSettingsForProvider(settingsFile, settingsProviderId, envKey, model);

  return { envKey, settingsProviderId };
}

function defaultDeepseekModel(_settingsFile) {
  return process.env.DSH_DEFAULT_MODEL || 'deepseek-chat';
}

// Rewrite settings.yaml so agent-default-model points at the given provider and
// llm-pi-ai.providers.<id> uses apiKeyEnv. Only the agent-default-model block
// and the single provider sub-block are touched; every other provider block
// (e.g. a user-added ollama route) stays intact. When the multi-key proxy is
// active, the opencode-go route also gets a baseURL override to the proxy.
function updateSettingsForProvider(settingsFile, providerId, apiKeyEnv, model) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const existing = readText(settingsFile) || '';
  let text = existing;

  // 1) agent-default-model block.
  text = replaceYamlBlock(text, 'agent-default-model', [
    `agent-default-model:`,
    `  provider: ${providerId}`,
    `  model: ${model}`,
  ]);

  // 2) llm-pi-ai.providers.<id> — insert/refresh only this provider's block.
  const providerLines = () => {
    const out = [`      apiKeyEnv: ${apiKeyEnv}`];
    if (providerId === 'opencode-go' && proxyActive()) {
      const port = readProxyConfig().port || PROXY_DEFAULT_PORT;
      out.push(`      baseURL: http://127.0.0.1:${port}`);
    }
    return out;
  };
  if (hasTopLevelKey(text, 'llm-pi-ai')) {
    text = upsertProviderSubBlock(text, providerId, providerLines);
  } else {
    text = appendBlock(text, [
      `llm-pi-ai:`,
      `  providers:`,
      `    ${providerId}:`,
      ...providerLines(),
    ]);
  }

  // Persist permission default too, matching the observed settings.yaml.
  if (!hasTopLevelKey(text, 'permission')) {
    text = appendBlock(text, [
      `permission:`,
      `  defaultPreset: danger-full-access`,
    ]);
  }

  fs.writeFileSync(settingsFile, text, 'utf8');
}

function hasTopLevelKey(text, key) {
  return new RegExp(`^${escapeRegExp(key)}:\\s*$`, 'm').test(text);
}

// Replace a top-level block (key: followed by indented children) with new lines.
function replaceYamlBlock(text, key, newLines) {
  const marker = new RegExp(`^${escapeRegExp(key)}:\\s*$`, 'm');
  const match = marker.exec(text);
  if (!match) {
    return appendBlock(text, newLines);
  }
  const start = match.index;
  const lines = text.split(/\r?\n/);
  const lineIdx = lines.findIndex((l) => marker.test(l));
  // Find the block end: next line that is NOT indented and NOT blank, after lineIdx.
  let endIdx = lineIdx;
  for (let i = lineIdx + 1; i < lines.length; i++) {
    if (/^\s/.test(lines[i])) {
      endIdx = i;
    } else if (lines[i].trim() === '') {
      // blank line inside or after block — keep extending until a top-level key
      continue;
    } else {
      break;
    }
  }
  const before = lines.slice(0, lineIdx);
  const after = lines.slice(endIdx + 1);
  return [...before, ...newLines, ...after].join('\n') + (after.length ? '' : '\n');
}

function appendBlock(text, newLines) {
  const trimmed = text.replace(/\s+$/, '');
  const base = trimmed.length ? trimmed + '\n' : '';
  return base + newLines.join('\n') + '\n';
}

// Insert-or-replace ONE provider sub-block (`    <id>:` at indent 4 plus its
// indent-6 children) inside the existing `llm-pi-ai.providers` section,
// leaving sibling provider blocks (e.g. ollama) untouched. Returns the new
// text, or the original text when the section does not exist yet.
function upsertProviderSubBlock(text, providerId, makeLines) {
  const lines = text.split(/\r?\n/);
  const providerRe = new RegExp(`^    ${escapeRegExp(providerId)}:\\s*$`);
  const idx = lines.findIndex((l) => providerRe.test(l));
  if (idx >= 0) {
    // Replace the existing sub-block: it ends at the first following line that
    // is neither blank nor indented >= 6 spaces.
    let end = idx;
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '' || /^\s{6,}\S/.test(lines[i])) end = i;
      else break;
    }
    const next = [...lines.slice(0, idx), `    ${providerId}:`, ...makeLines(), ...lines.slice(end + 1)];
    return next.join('\n');
  }
  // Append after `  providers:` under the existing `llm-pi-ai:` block.
  const piIdx = lines.findIndex((l) => /^llm-pi-ai:\s*$/.test(l));
  if (piIdx < 0) return text;
  const provIdx = lines.findIndex((l, i) => i > piIdx && /^  providers:\s*$/.test(l));
  if (provIdx < 0) return text;
  const insertAt = provIdx + 1;
  const next = [...lines.slice(0, insertAt), `    ${providerId}:`, ...makeLines(), ...lines.slice(insertAt)];
  return next.join('\n');
}

function isFirstRun() {
  const config = loadConfig();
  if (config.firstRunComplete) return false;
  // Also treat "credentials already present" as non-first-run so the app is
  // usable without re-entering keys on a fresh userData.
  return !fs.existsSync(path.join(DSH_HOME, '.credentials.yaml'));
}

// ---------------------------------------------------------------------------
// dsh detection
// ---------------------------------------------------------------------------
function nodeCandidates() {
  const explicit = loadConfig().nodeExe;
  const out = [];
  if (explicit) out.push(explicit);
  out.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  out.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'));
  // Anything on PATH.
  const pathEntry = (process.env.PATH || '').split(path.delimiter).map((p) => path.join(p, 'node.exe'));
  out.push(...pathEntry);
  return out.filter(Boolean);
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || null;
}

function dshBinCandidates() {
  const explicit = loadConfig().dshBin;
  const out = [];
  if (explicit) out.push(explicit);

  const scopes = [
    // Global npm install
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    // npx caches (most recent first) — this is where the current harness lives
    ...npxDshLocations(),
    // Local project installs that might exist
  ];
  out.push(...scopes);
  return out.filter(Boolean);
}

function npxDshLocations() {
  const cacheRoot = process.env.NPM_CONFIG_CACHE || path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
  const npxRoot = path.join(cacheRoot, '_npx');
  const results = [];
  try {
    if (!fs.existsSync(npxRoot)) return results;
    const dirs = fs.readdirSync(npxRoot).map((d) => path.join(npxRoot, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    // Sort by mtime descending so newest harness wins.
    dirs.sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
    for (const d of dirs) {
      if (fs.existsSync(d)) results.push(d);
    }
  } catch (_err) {
    // ignore
  }
  return results;
}

function detectNode() {
  return firstExisting(nodeCandidates());
}

function detectDshBin() {
  const found = firstExisting(dshBinCandidates());
  return found;
}

function detectRuntime() {
  const nodeExe = detectNode();
  const dshBin = detectDshBin();
  log(`detected node=${nodeExe || '(none)'} dshBin=${dshBin || '(none)'}`);
  return { nodeExe, dshBin };
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
let backendProcess = null;
let backendUrl = '';

function requestPageStatus(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

async function portIsFree(host, port) {
  return (await requestPageStatus(`http://${host}:${port}/`, 800)) === 0;
}

async function pickPort(config) {
  const base = Number(config.port) || DEFAULT_PORT;
  for (let offset = 0; offset < 40; offset += 1) {
    const port = base + offset;
    if (await portIsFree(config.host, port)) return port;
  }
  return base; // give up and let the backend try anyway
}

async function waitForBackend(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestPageStatus(url, 1500);
    if (status === 200) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function stopBackend() {
  const proc = backendProcess;
  backendProcess = null;
  if (proc && !proc.killed) {
    try { proc.kill(); } catch (_err) {}
  }
}

async function startBackend() {
  const config = loadConfig();
  const runtime = detectRuntime();
  if (!runtime.nodeExe) throw new Error('Node.js was not found. Install Node.js or set nodeExe in desktop-config.json.');
  if (!runtime.dshBin) throw new Error('The dsh harness was not found. Install @deepseek-ai/dsh or set dshBin in desktop-config.json.');

  const port = await pickPort(config);
  backendUrl = `http://${config.host}:${port}`;

  const args = [runtime.dshBin, 'web', '--host', config.host, '--port', String(port), '--no-open'];
  const env = { ...process.env, DSH_HOME: config.dshHome || DSH_HOME };

  log(`spawning node="${runtime.nodeExe}" args="${args.join(' ')}" DSH_HOME=${env.DSH_HOME}`);
  backendProcess = spawn(runtime.nodeExe, args, {
    cwd: path.dirname(runtime.dshBin),
    env,
    windowsHide: true,
  });

  let outputTail = '';
  const capture = (streamName, chunk) => {
    const text = chunk.toString();
    const clean = text.trimEnd();
    if (clean) log(`[backend ${streamName}] ${clean}`);
    outputTail = `${outputTail}${text}`.slice(-8000);
  };
  backendProcess.stdout.on('data', (c) => capture('stdout', c));
  backendProcess.stderr.on('data', (c) => capture('stderr', c));

  const exited = new Promise((_resolve, reject) => {
    backendProcess.once('error', (err) => reject(new Error(`Failed to start dsh web: ${err.message || err}`)));
    backendProcess.once('exit', (code, signal) => {
      log(`backend exited code=${code} signal=${signal || ''}`);
      backendProcess = null;
      reject(new Error([`dsh web exited before ready (code=${code}, signal=${signal || 'none'}).`, outputTail.trim()].filter(Boolean).join('\n\n')));
    });
  });

  const ready = await Promise.race([waitForBackend(backendUrl, STARTUP_TIMEOUT_MS), exited]);
  if (!ready) {
    stopBackend();
    throw new Error(`dsh web did not become ready at ${backendUrl} within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }
  return { url: backendUrl };
}

// ---------------------------------------------------------------------------
// Window helpers / UI
// ---------------------------------------------------------------------------
let mainWindow = null;

function welcomeHtml(config) {
  const dark = nativeTheme.shouldUseDarkColors;
  const providers = [
    { id: 'deepseek', label: 'DeepSeek (DeepSeek API)' },
    { id: 'opencode-go', label: 'Opencode Go (llm-pi-ai)' },
  ];
  const options = providers.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME} — 首次配置</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; font-family: "Segoe UI","Microsoft YaHei UI",Arial,sans-serif; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:${dark ? '#0e141c' : '#eef4f6'}; color:${dark ? '#d7e0ea' : '#162638'}; }
  main { width:min(560px, calc(100vw - 48px)); background:${dark ? '#171f2a' : '#fff'}; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; border-radius:16px; padding:28px; box-shadow:0 16px 48px rgba(20,40,60,.12); }
  h1 { margin:0 0 14px; font-size:22px; }
  p.sub { margin:0 0 22px; color:${dark ? '#8da0b4' : '#637484'}; font-size:14px; line-height:1.7; }
  label { display:block; font-size:13px; font-weight:600; margin:16px 0 6px; }
  input,select { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; background:${dark ? '#111923' : '#fbfdfd'}; color:inherit; font-size:14px; }
  #status { min-height:20px; margin:14px 0 0; font-size:13px; color:${dark ? '#7bc7ff' : '#0a6370'}; }
  #status.err { color:#e5484d; }
  .actions { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; padding:11px 14px; border-radius:10px; border:1px solid transparent; font-size:14px; font-weight:600; cursor:pointer; }
  #save { background:#0f7f91; color:#fff; }
  #save:hover { background:#0d6f80; }
  #save:disabled { opacity:.5; cursor:default; }
  #skip { background:transparent; border-color:${dark ? '#2b3a4b' : '#d7e4e7'}; color:${dark ? '#d7e0ea' : '#162638'}; }
  code { word-break:break-all; font-size:12px; color:${dark ? '#8da0b4' : '#637484'}; }
</style>
</head>
<body>
<main>
  <h1>配置 DeepSeek Harness</h1>
  <p class="sub">在首次使用前，请提供 API 凭据。凭据将写入 <code>${escapeHtml(config.dshHome || DSH_HOME)}</code>，供本应用与 dsh 命令行共用。</p>
  <label for="provider">Provider</label>
  <select id="provider">${options}</select>
  <label for="apiKey">API Key</label>
  <input id="apiKey" type="password" placeholder="sk-…" autocomplete="off">
  <div id="status"></div>
  <div class="actions">
    <button id="skip" type="button">跳过（稍后设置）</button>
    <button id="save" type="button">保存并继续</button>
  </div>
</main>
<script>
  const statusEl = document.getElementById('status');
  function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.className = err ? 'err' : ''; }
  document.getElementById('save').addEventListener('click', async () => {
    const provider = document.getElementById('provider').value;
    const apiKey = document.getElementById('apiKey').value.trim();
    setStatus('正在保存…');
    try {
      const res = await window.dshDesktop.saveCredentials({ provider, apiKey });
      if (res && res.ok) { setStatus('已保存，正在启动…'); await window.dshDesktop.finishOnboarding(); }
      else { setStatus((res && res.error) || '保存失败', true); }
    } catch (e) { setStatus(String(e && e.message || e), true); }
  });
  document.getElementById('skip').addEventListener('click', async () => {
    setStatus('已跳过，继续…');
    await window.dshDesktop.finishOnboarding();
  });
</script>
</body>
</html>`;
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function errorHtml(err, backendUrlInfo) {
  const dark = nativeTheme.shouldUseDarkColors;
  const message = escapeHtml(String(err && (err.stack || err.message) ? (err.stack || err.message) : err));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME} 启动失败</title><style>
  body{margin:0;min-height:100vh;padding:40px;box-sizing:border-box;font-family:"Segoe UI","Microsoft YaHei UI",Arial,sans-serif;color-scheme:${dark?'dark':'light'};background:${dark?'#0e141c':'#eef4f6'};color:${dark?'#d7e0ea':'#162638'};}
  main{max-width:860px;margin:0 auto;background:${dark?'#171f2a':'#fff'};border:1px solid ${dark?'#2b3a4b':'#d7e4e7'};border-radius:16px;padding:24px;}
  h1{margin:0 0 12px;font-size:22px;} pre{overflow:auto;white-space:pre-wrap;padding:14px;border-radius:12px;background:${dark?'#111923':'#f3f7f8'};border:1px solid ${dark?'#2b3a4b':'#d7e4e7'};font-size:12px;}
  .actions{display:flex;gap:10px;margin-top:16px;}
  button{padding:10px 16px;border-radius:9px;border:1px solid ${dark?'#2b3a4b':'#d7e4e7'};background:${dark?'#1f2a37':'#f3f7f8'};color:inherit;font-size:14px;font-weight:600;cursor:pointer;}
  button.primary{background:#0f7f91;border-color:#0f7f91;color:#fff;}
  </style></head><body><main><h1>${APP_NAME} 启动失败</h1><pre>${message}</pre>
  <div class="actions"><button class="primary" id="openSettings">打开设置</button><button id="retry">重试</button></div>
  </main>
  <script>
  document.getElementById('openSettings').addEventListener('click', () => window.dshDesktop.openSettingsWindow());
  document.getElementById('retry').addEventListener('click', () => window.dshDesktop.applySettings());
  </script>
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------
let settingsWindow = null;

function settingsHtml() {
  const config = loadConfig();
  const dark = nativeTheme.shouldUseDarkColors;
  const detected = detectRuntime();
  const curNode = config.nodeExe || detected.nodeExe || '';
  const curDsh = config.dshBin || detected.dshBin || '';
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>设置 — ${APP_NAME}</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; font-family:"Segoe UI","Microsoft YaHei UI",Arial,sans-serif; }
  body { margin:0; min-height:100vh; background:${dark ? '#0e141c' : '#eef4f6'}; color:${dark ? '#d7e0ea' : '#162638'}; }
  main { max-width:720px; margin:0 auto; padding:28px 24px 48px; }
  h1 { margin:0 0 6px; font-size:22px; }
  p.sub { margin:0 0 24px; color:${dark ? '#8da0b4' : '#637484'}; font-size:13px; line-height:1.7; }
  section { background:${dark ? '#171f2a' : '#fff'}; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; border-radius:14px; padding:20px; margin-bottom:16px; }
  section h2 { margin:0 0 4px; font-size:15px; }
  section p.hint { margin:0 0 16px; color:${dark ? '#8da0b4' : '#637484'}; font-size:12.5px; line-height:1.6; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  .row { display:flex; gap:8px; align-items:center; }
  .row input { flex:1; }
  input { width:100%; box-sizing:border-box; padding:9px 11px; border-radius:9px; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; background:${dark ? '#111923' : '#fbfdfd'}; color:inherit; font-size:13px; }
  textarea { width:100%; box-sizing:border-box; padding:9px 11px; border-radius:9px; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; background:${dark ? '#111923' : '#fbfdfd'}; color:inherit; font-size:12px; font-family:Consolas,monospace; resize:vertical; }
  label.check { display:flex; align-items:center; gap:8px; margin:12px 0 6px; }
  label.check input { width:auto; margin:0; }
  .usage-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:10px; }
  .usage-table th, .usage-table td { padding:5px 8px; border-bottom:1px solid ${dark ? '#2b3a4b' : '#e3edef'}; text-align:right; white-space:nowrap; }
  .usage-table th:first-child, .usage-table td:first-child { text-align:left; }
  .usage-table .active { color:#30a46c; font-weight:600; }
  #proxyStatus { min-height:18px; margin-top:10px; font-size:13px; }
  #proxyStatus.ok { color:#30a46c; }
  #proxyStatus.err { color:#e5484d; }
  button { padding:8px 14px; border-radius:9px; border:1px solid ${dark ? '#2b3a4b' : '#d7e4e7'}; background:${dark ? '#1f2a37' : '#f3f7f8'}; color:inherit; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
  button.primary { background:#0f7f91; border-color:#0f7f91; color:#fff; }
  button.primary:hover { background:#0d6f80; }
  .detected { margin-top:6px; font-size:12px; color:${dark ? '#7bc7ff' : '#0a6370'}; word-break:break-all; }
  .detected.bad { color:#e5484d; }
  #runtimeStatus { min-height:18px; margin-top:12px; font-size:13px; }
  #runtimeStatus.ok { color:#30a46c; }
  #runtimeStatus.err { color:#e5484d; }
  #runtimeStatus .mono { font-family:Consolas,monospace; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .actions { display:flex; gap:10px; margin-top:8px; position:sticky; bottom:0; padding:12px 0; }
  .actions button { flex:1; padding:12px; }
  #saveStatus { min-height:18px; margin-top:12px; font-size:13px; }
  #saveStatus.ok { color:#30a46c; }
  #saveStatus.err { color:#e5484d; }
</style>
</head>
<body>
<main>
  <h1>设置</h1>
  <p class="sub">手动指定 dsh 与 Node.js 的位置，或自定义后端端口与 DSH_HOME。留空则使用自动探测结果。</p>

  <section>
    <h2>dsh 入口（bin.js）</h2>
    <p class="hint">指向 <code>@deepseek-ai/dsh/lib/bin.js</code> 的完整路径。通常是 npm 全局安装或 npx 缓存目录下的该文件。</p>
    <div class="row">
      <input id="dshBin" type="text" placeholder="留空 = 自动探测" value="${escapeHtml(config.dshBin || '')}">
      <button id="pickDsh" type="button">浏览…</button>
    </div>
    <div class="detected ${curDsh ? '' : 'bad'}">${curDsh ? `检测到：${escapeHtml(curDsh)}` : '未检测到（请手动指定）'}</div>
  </section>

  <section>
    <h2>Node.js 可执行文件（node.exe）</h2>
    <p class="hint">用于运行 dsh 的 Node.js 运行时，一般是 <code>node.exe</code>。</p>
    <div class="row">
      <input id="nodeExe" type="text" placeholder="留空 = 自动探测" value="${escapeHtml(config.nodeExe || '')}">
      <button id="pickNode" type="button">浏览…</button>
    </div>
    <div class="detected ${curNode ? '' : 'bad'}">${curNode ? `检测到：${escapeHtml(curNode)}` : '未检测到（请手动指定）'}</div>
  </section>

  <section>
    <h2>后端服务</h2>
    <label for="port">端口</label>
    <input id="port" type="number" min="0" max="65535" value="${escapeHtml(String(config.port ?? DEFAULT_PORT))}" placeholder="3000">
    <label for="dshHome">DSH_HOME</label>
    <input id="dshHome" type="text" value="${escapeHtml(config.dshHome || DSH_HOME)}" placeholder="${escapeHtml(DSH_HOME)}">
    <p class="hint">DSH_HOME 是 dsh 的家目录（凭据、会话、配置），默认 <code>${escapeHtml(DSH_HOME)}</code>。</p>
  </section>

  <section>
    <h2>OpenCode 多 Key 代理（故障转移）</h2>
    <p class="hint">把多把 OpenCode API Key 放进轮换池，某把 Key 配额耗尽（401/402/429）时自动切换下一把并重试同一请求。DSH 的 <code>opencode-go</code> 路由会自动指向本机代理；用量按 Key 分别统计（请求数 / 输入 token / 输出 token）。Key 仅保存在本机 DSH_HOME，不会进入项目仓库。</p>
    <label class="check"><input id="proxyEnabled" type="checkbox"> 启用本地代理</label>
    <label for="proxyPort">代理端口</label>
    <input id="proxyPort" type="number" min="1024" max="65535" placeholder="8787">
    <label for="proxyKeys">API Key 列表（每行一把，按顺序轮换）</label>
    <textarea id="proxyKeys" rows="4" placeholder="sk-…（每行一把）" spellcheck="false"></textarea>
    <div class="row" style="margin-top:10px">
      <button id="proxySave" type="button">保存代理配置</button>
      <button id="proxyRotate" type="button">立即切换下一把 Key</button>
      <button id="proxyRefresh" type="button">刷新用量</button>
    </div>
    <div id="proxyUsage"></div>
    <div id="proxyStatus"></div>
  </section>

  <section>
    <h2>DeepSeek 官方 API 余额</h2>
    <p class="hint">调用 DeepSeek 官方余额接口（<code>api.deepseek.com/user/balance</code>），凭据取自 <code>.credentials.yaml</code> 里的 <code>DEEPSEEK_API_KEY</code>。</p>
    <div class="row">
      <button id="dsBalanceRefresh" type="button">刷新余额</button>
    </div>
    <div id="dsBalance"></div>
  </section>

  <div class="actions">
    <button id="test" type="button">测试连接</button>
    <button id="save" class="primary" type="button">保存并重启</button>
  </div>
  <div id="runtimeStatus"></div>
  <div id="saveStatus"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  function setRuntimeStatus(msg, cls) { const el = $('runtimeStatus'); el.textContent = msg || ''; el.className = cls || ''; }
  function setSaveStatus(msg, cls) { const el = $('saveStatus'); el.textContent = msg || ''; el.className = cls || ''; }

  $('pickDsh').addEventListener('click', async () => {
    const res = await window.dshDesktop.pickFile({ kind: 'dsh', title: '选择 bin.js' });
    if (res && res.path) $('dshBin').value = res.path;
  });
  $('pickNode').addEventListener('click', async () => {
    const res = await window.dshDesktop.pickFile({ kind: 'node', title: '选择 node.exe' });
    if (res && res.path) $('nodeExe').value = res.path;
  });

  function collect() {
    return {
      dshBin: $('dshBin').value.trim(),
      nodeExe: $('nodeExe').value.trim(),
      port: Number($('port').value) || 3000,
      dshHome: $('dshHome').value.trim(),
    };
  }

  $('test').addEventListener('click', async () => {
    setRuntimeStatus('正在测试…');
    const res = await window.dshDesktop.testRuntime(collect());
    if (res && res.ok) setRuntimeStatus('连接正常：\\n' + res.detail, 'ok');
    else setRuntimeStatus('测试失败：\\n' + (res && res.error || '未知错误'), 'err');
  });

  $('save').addEventListener('click', async () => {
    setSaveStatus('正在保存…');
    const res = await window.dshDesktop.saveSettings(collect());
    if (res && res.ok) {
      setSaveStatus('已保存，正在重启…');
      await window.dshDesktop.applySettings();
    } else {
      setSaveStatus((res && res.error) || '保存失败', 'err');
    }
  });

  // ---- OpenCode 多 Key 代理 ----
  function maskKey(k) {
    if (!k) return '';
    if (k.startsWith('sk-')) return k.length <= 12 ? 'sk-***' : k.slice(0, 7) + '…' + k.slice(-4);
    return k.length <= 6 ? '******' : k.slice(0, 2) + '…' + k.slice(-2);
  }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }
  function setProxyStatus(msg, cls) { const el = $('proxyStatus'); el.textContent = msg || ''; el.className = cls || ''; }
  function renderProxy(state) {
    if (!state) return;
    $('proxyEnabled').checked = state.enabled !== false;
    $('proxyPort').value = state.port || 8787;
    $('proxyKeys').value = (state.keys || []).join('\\n');
    const usage = state.usage || [];
    if (!usage.length) { $('proxyUsage').innerHTML = ''; return; }
    const rows = usage.map((u, i) => {
      const active = i === state.activeIndex ? ' class="active"' : '';
      const last = u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleTimeString() : '—';
      return '<tr' + active + '><td>' + (active ? '● ' : '○ ') + maskKey((state.keys || [])[i]) + '</td>' +
        '<td>' + (u.requests || 0) + ' 次</td>' +
        '<td>入 ' + fmtTokens(u.inputTokens) + '</td>' +
        '<td>出 ' + fmtTokens(u.outputTokens) + '</td>' +
        '<td>失败 ' + (u.quotaFailures || 0) + '</td>' +
        '<td>' + last + '</td></tr>';
    }).join('');
    $('proxyUsage').innerHTML =
      '<table class="usage-table"><thead><tr><th>Key（● = 当前）</th><th>请求</th><th>输入</th><th>输出</th><th>配额失败</th><th>最近使用</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }
  async function loadProxy() {
    const res = await window.dshDesktop.proxyGetState();
    if (res && res.ok) {
      renderProxy(res);
      setProxyStatus(res.running ? '代理运行中：' + res.url : '代理未运行' + (res.enabled !== false ? '（无 Key 或未启用）' : '（已停用）'), res.running ? 'ok' : '');
    } else {
      setProxyStatus((res && res.error) || '读取代理状态失败', 'err');
    }
  }
  $('proxySave').addEventListener('click', async () => {
    setProxyStatus('正在保存…');
    const keys = $('proxyKeys').value.split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
    const res = await window.dshDesktop.proxySaveConfig({
      enabled: $('proxyEnabled').checked,
      port: Number($('proxyPort').value) || 8787,
      keys,
    });
    if (res && res.ok) {
      renderProxy(res.state);
      setProxyStatus(res.state.running ? '已保存，代理运行中：' + res.state.url : '已保存，代理已停用', res.state.running ? 'ok' : '');
    } else {
      setProxyStatus((res && res.error) || '保存失败', 'err');
    }
  });
  $('proxyRotate').addEventListener('click', async () => {
    const res = await window.dshDesktop.proxyRotate();
    if (res && res.ok) { renderProxy(res.state); setProxyStatus('已切换到下一把 Key', 'ok'); }
    else setProxyStatus((res && res.error) || '切换失败', 'err');
  });
  $('proxyRefresh').addEventListener('click', async () => {
    await loadProxy();
    setProxyStatus('已刷新', 'ok');
  });
  void loadProxy();

  // ---- DeepSeek 官方余额 ----
  async function loadBalance() {
    const el = $('dsBalance');
    el.innerHTML = '<span style="color:' + (${dark} ? '#8da0b4' : '#637484') + '">查询中…</span>';
    const res = await window.dshDesktop.deepseekBalance();
    if (!res || !res.ok) {
      el.innerHTML = '<span style="color:#e5484d">' + ((res && res.error) || '查询失败') + '</span>';
      return;
    }
    const d = res.data || {};
    const rows = (d.balance_infos || []).map((b) =>
      '<tr><td>' + (b.currency || '') + '</td>' +
      '<td>' + (b.total_balance ?? '') + '</td>' +
      '<td>' + (b.topped_up_balance ?? '') + '</td>' +
      '<td>' + (b.granted_balance ?? '') + '</td></tr>'
    ).join('');
    el.innerHTML =
      (d.is_available ? '<span style="color:#30a46c">● 账户可用</span>' : '<span style="color:#e5484d">● 账户不可用</span>') +
      '<table class="usage-table"><thead><tr><th>币种</th><th>总余额</th><th>充值余额</th><th>赠送余额</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }
  $('dsBalanceRefresh').addEventListener('click', loadBalance);
  void loadBalance();
</script>
</body>
</html>`;
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 560,
    minHeight: 600,
    title: `设置 — ${APP_NAME}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e141c' : '#eef4f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(settingsHtml()));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e141c' : '#eef4f6',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') { void shell.openExternal(u.href); }
    } catch (_e) {}
    return { action: 'deny' };
  });

  return mainWindow;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.handle('dsh:save-credentials', (_event, payload) => {
    try {
      const { provider, apiKey } = payload || {};
      const result = applyCredentials(provider || 'deepseek', apiKey || '');
      return { ok: true, ...result };
    } catch (err) {
      log(`save-credentials failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:finish-onboarding', () => {
    saveConfig({ firstRunComplete: true });
    // Kick the real backend load.
    void bootToGui().catch((err) => { log(`boot failed: ${err && err.stack || err}`); });
    return { ok: true };
  });

  ipcMain.handle('dsh:get-state', () => {
    return {
      config: loadConfig(),
      dshHome: DSH_HOME,
      backendUrl,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
    };
  });

  ipcMain.handle('dsh:open-logs', () => {
    return shell.openPath(logDir());
  });

  ipcMain.handle('dsh:open-settings-window', () => {
    openSettingsWindow();
    return { ok: true };
  });

  ipcMain.handle('dsh:zoom-by-wheel', (_event, direction) => {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (wc) {
      const level = wc.getZoomLevel() + (direction > 0 ? 0.5 : -0.5);
      wc.setZoomLevel(level);
    }
    return { ok: true };
  });

  ipcMain.handle('dsh:get-settings', () => {
    const config = loadConfig();
    const detected = detectRuntime();
    return {
      config,
      detected,
      dshHome: DSH_HOME,
    };
  });

  ipcMain.handle('dsh:save-settings', (_event, payload) => {
    try {
      const patch = {};
      if (payload && typeof payload === 'object') {
        if (typeof payload.dshBin === 'string') patch.dshBin = payload.dshBin.trim();
        if (typeof payload.nodeExe === 'string') patch.nodeExe = payload.nodeExe.trim();
        if (payload.port !== undefined && payload.port !== null && payload.port !== '') {
          const port = Number(payload.port);
          if (Number.isInteger(port) && port >= 0 && port <= 65535) patch.port = port;
        }
        if (typeof payload.dshHome === 'string' && payload.dshHome.trim()) patch.dshHome = payload.dshHome.trim();
      }
      const saved = saveConfig(patch);
      log(`settings saved: ${JSON.stringify(patch)}`);
      return { ok: true, config: saved };
    } catch (err) {
      log(`save-settings failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---- OpenCode multi-key proxy -----------------------------------------
  ipcMain.handle('dsh:proxy-get-state', () => {
    const cfg = readProxyConfig();
    const live = proxyHandle ? proxyHandle.getState() : null;
    return {
      ok: true,
      running: Boolean(live),
      url: live ? live.url : `http://127.0.0.1:${cfg.port || PROXY_DEFAULT_PORT}`,
      enabled: cfg.enabled !== false,
      port: cfg.port || PROXY_DEFAULT_PORT,
      keys: cfg.keys,
      activeIndex: live ? live.activeIndex : cfg.activeIndex,
      usage: live ? live.usage : cfg.usage,
      configPath: proxyConfigPath(),
    };
  });

  ipcMain.handle('dsh:proxy-save-config', (_event, payload) => {
    try {
      const enabled = payload && payload.enabled !== undefined ? payload.enabled !== false : true;
      const port = Number(payload && payload.port) || PROXY_DEFAULT_PORT;
      const keys = Array.isArray(payload && payload.keys)
        ? payload.keys.map((k) => String(k).trim()).filter(Boolean)
        : [];
      writeProxyConfig({ enabled, port, keys });
      startProxy(); // restarts (or stops) the in-process server with the new config
      return { ok: true, state: ipcMainStateProxy() };
    } catch (err) {
      log(`proxy-save-config failed: ${err && err.message}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('dsh:proxy-rotate', () => {
    try {
      const live = proxyHandle ? proxyHandle.rotate() : null;
      return { ok: true, state: live || ipcMainStateProxy() };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---- DeepSeek 官方余额 ------------------------------------------------
  ipcMain.handle('dsh:deepseek-balance', async () => {
    const key = readCredential('DEEPSEEK_API_KEY');
    if (!key) {
      return { ok: false, error: '未在 .credentials.yaml 中找到 DEEPSEEK_API_KEY' };
    }
    return await fetchDeepSeekBalance(key);
  });

  function ipcMainStateProxy() {
    const cfg = readProxyConfig();
    return {
      running: Boolean(proxyHandle),
      url: `http://127.0.0.1:${cfg.port || PROXY_DEFAULT_PORT}`,
      enabled: cfg.enabled !== false,
      port: cfg.port || PROXY_DEFAULT_PORT,
      keys: cfg.keys,
      activeIndex: cfg.activeIndex,
      usage: cfg.usage,
    };
  }

  // Native file picker. `kind` filters the visible file extensions.
  ipcMain.handle('dsh:pick-file', async (_event, payload) => {
    const kind = payload && payload.kind;
    const filters = (() => {
      if (kind === 'dsh') return [{ name: 'dsh bin.js', extensions: ['js'] }, { name: '所有文件', extensions: ['*'] }];
      if (kind === 'node') return [{ name: 'node.exe', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }];
      return [{ name: '所有文件', extensions: ['*'] }];
    })();
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
    const options = {
      properties: ['openFile'],
      title: payload && payload.title ? payload.title : '选择文件',
      filters,
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] || '' };
  });

  // Test that the given (or detected) node + dsh actually run.
  ipcMain.handle('dsh:test-runtime', async (_event, payload) => {
    try {
      const config = loadConfig();
      const nodeExe = (payload && payload.nodeExe) ? payload.nodeExe : (config.nodeExe || detectNode());
      const dshBin = (payload && payload.dshBin) ? payload.dshBin : (config.dshBin || detectDshBin());
      if (!nodeExe || !fs.existsSync(nodeExe)) {
        return { ok: false, error: `Node.js 未找到：${nodeExe || '(空)'}` };
      }
      if (!dshBin || !fs.existsSync(dshBin)) {
        return { ok: false, error: `dsh bin.js 未找到：${dshBin || '(空)'}` };
      }
      const result = spawnSync(nodeExe, [dshBin, '--version'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      if (result.error) {
        return { ok: false, error: `无法运行 node：${result.error.message}` };
      }
      if (result.status !== 0) {
        return { ok: false, error: `dsh --version 退出码 ${result.status}：${(result.stderr || result.stdout || '').trim()}` };
      }
      const version = (result.stdout || '').trim();
      return {
        ok: true,
        detail: `node=${nodeExe}\ndsh=${dshBin}\n版本=${version || '(unknown)'}`,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // After saving settings, restart the backend with the new paths/port.
  ipcMain.handle('dsh:apply-settings', async () => {
    try {
      stopBackend();
      // Close the settings window and reload the main window against a fresh backend.
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
      await bootToGui();
      return { ok: true };
    } catch (err) {
      log(`apply-settings failed: ${err && err.stack || err}`);
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  app.whenReady().then(() => {
    setMenu();
    startProxy();
    const window = createMainWindow();

    if (isFirstRun()) {
      const config = loadConfig();
      log('first run: showing onboarding');
      window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(welcomeHtml(config)));
    } else {
      void bootToGui().catch((err) => {
        log(`boot failed: ${err && err.stack || err}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml(err, backendUrl)));
        }
      });
    }
  });

  app.on('window-all-closed', () => {
    // Always quit on all platforms for this single-window app.
    app.quit();
  });

  app.on('before-quit', () => {
    stopBackend();
    stopProxy();
  });

  app.on('will-quit', () => {
    stopBackend();
    stopProxy();
  });

  let bootInFlight = false;
  async function bootToGui() {
    if (bootInFlight) return;
    bootInFlight = true;
    try {
      const { url } = await startBackend();
      log(`backend ready at ${url}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(url);
      }
    } finally {
      bootInFlight = false;
    }
  }

  function setMenu() {
    const template = [
      {
        label: APP_NAME,
        submenu: [
          { label: '关于', click: () => dialog.showMessageBox({ type: 'info', title: `关于 ${APP_NAME}`, message: APP_NAME, detail: `版本 ${app.getVersion()}\n后端：${backendUrl || '未启动'}` }) },
          { type: 'separator' },
          { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
          { label: '重新配置 API 凭据…', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(welcomeHtml(loadConfig()))); } },
          { type: 'separator' },
          { label: '打开日志目录', click: () => shell.openPath(logDir()) },
          { type: 'separator' },
          { label: '退出', role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { type: 'separator' },
          { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+=' },
          { role: 'zoomOut', label: '缩小', accelerator: 'CmdOrCtrl+-' },
          { role: 'resetZoom', label: '实际大小', accelerator: 'CmdOrCtrl+0' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '切换全屏' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
