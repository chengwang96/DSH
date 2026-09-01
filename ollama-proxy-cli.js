'use strict';

/**
 * Ollama Cloud 多账号故障转移代理 —— 独立运行入口（不依赖桌面应用）。
 *
 * 用法：
 *   node ollama-proxy-cli.js [--port 8788] [--config <path>]
 *
 * 默认配置文件：~/.dsh/ollama-proxy.json
 * 管理端点（127.0.0.1）：
 *   GET  /__ollama/state    查看状态与每个账号 Key 的用量
 *   POST /__ollama/rotate   手动切换下一个账号
 *   POST /__ollama/reload   重新加载配置文件
 */

const os = require('node:os');
const path = require('node:path');
const { startOllamaProxy } = require('./ollama-proxy.js');

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const args = process.argv.slice(2);
const portArg = argValue(args, '--port');
const configArg = argValue(args, '--config');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const configPath = configArg || path.join(dshHome, 'ollama-proxy.json');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (process.env.OLLAMA_PROXY_SILENT !== '1') console.log(line);
};

log(`config: ${configPath}`);

const proxy = startOllamaProxy({ configPath, log });
const state = proxy.getState();
log(`listening on ${proxy.url} (${state.keys.length} key(s), active #${state.activeIndex + 1})`);
log(`state endpoint: curl http://127.0.0.1:${state.port}/__ollama/state`);

process.on('SIGINT', () => { proxy.stop(); process.exit(0); });
process.on('SIGTERM', () => { proxy.stop(); process.exit(0); });
