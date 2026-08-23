'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

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
// llm-pi-ai.providers.<id> uses apiKeyEnv. We reconstruct only these sections
// and leave everything else intact via a very simple line-based editor that
// understands the flat `llm-pi-ai:` ... `providers:` ... `    <id>:` nesting.
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

  // 2) llm-pi-ai.providers.<id>.apiKeyEnv — insert/refresh.
  // Minimal robust approach: rebuild the llm-pi-ai block if present, else append.
  if (hasTopLevelKey(text, 'llm-pi-ai')) {
    text = replaceYamlBlock(text, 'llm-pi-ai', [
      `llm-pi-ai:`,
      `  providers:`,
      `    ${providerId}:`,
      `      apiKeyEnv: ${apiKeyEnv}`,
    ]);
  } else {
    text = appendBlock(text, [
      `llm-pi-ai:`,
      `  providers:`,
      `    ${providerId}:`,
      `      apiKeyEnv: ${apiKeyEnv}`,
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

  const args = [runtime.dshBin, 'web', '--host', config.host, '--port', String(port)];
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
  });

  app.on('will-quit', () => {
    stopBackend();
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
          { role: 'togglefullscreen', label: '切换全屏' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
