'use strict';

/**
 * OpenCode 多 Key 故障转移代理 —— 独立运行入口（不依赖桌面应用）。
 *
 * 用法：
 *   node opencode-proxy-cli.js [--port 8787] [--config <path>]
 *
 * 默认配置文件：~/.dsh/opencode-proxy.json
 * 管理端点（127.0.0.1）：
 *   GET  /__proxy/state    查看状态与每把 Key 的用量
 *   POST /__proxy/rotate   手动切换下一把 Key
 *   POST /__proxy/reload   重新加载配置文件
 */

const os = require('node:os');
const path = require('node:path');
const { startOpenCodeProxy } = require('./proxy.js');

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const args = process.argv.slice(2);
const portArg = argValue(args, '--port');
const configArg = argValue(args, '--config');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const configPath = configArg || path.join(dshHome, 'opencode-proxy.json');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (process.env.OPCODE_PROXY_SILENT !== '1') console.log(line);
};

log(`config: ${configPath}`);

const proxy = startOpenCodeProxy({ configPath, log });
const state = proxy.getState();
log(`listening on ${proxy.url} (${state.keys.length} key(s), active #${state.activeIndex + 1})`);
log(`state endpoint: curl http://127.0.0.1:${state.port}/__proxy/state`);

process.on('SIGINT', () => {
  proxy.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  proxy.stop();
  process.exit(0);
});
