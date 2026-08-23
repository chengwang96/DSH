# DeepSeek Harness 桌面应用（Windows x64）

把本机已安装的 DeepSeek Harness（`dsh web`）打包成双击即可启动的桌面应用。

## 产物

位于 `dist/`：

| 文件 | 说明 |
|---|---|
| `DeepSeek Harness 0.1.0.exe` | **便携版（推荐直接使用）**，免安装，双击即用 |
| `DeepSeek Harness Setup 0.1.0.exe` | NSIS 安装器，可安装到指定目录并创建开始菜单/桌面快捷方式 |
| `dist/win-unpacked/` | 免安装目录版（解压即用），运行其中的 `DeepSeek Harness.exe` |

## 工作原理

- 主进程（`main.js`）启动后自动探测本机的 `node.exe` 和 `@deepseek-ai/dsh` 入口：
  - `node.exe`：优先 `C:\Program Files\nodejs\node.exe`，其次 PATH；
  - dsh 入口：优先全局 npm 安装，其次 `%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js`（npx 缓存，按修改时间取最新）。
- 探测到后 spawn `node dsh/lib/bin.js web --host 127.0.0.1 --port <port>`，后端默认从 `3000` 起，端口被占用时自动顺延（3001、3002…）。
- 根路径 `/` 返回 200（含 `window.__DSH_BOOT__` 注入）视为就绪，随后加载该 URL。
- 复用 `$DSH_HOME`（默认 `~/.dsh`），凭据和会话与命令行 `dsh` 完全共享。

## 首次启动 API Key 引导

应用首次启动（且 `~/.dsh/.credentials.yaml` 尚不存在）时，会弹出引导页让你选择 provider 并填写 API Key，写入：

- `~/.dsh/.credentials.yaml` —— 凭据（`KEY: value` 扁平映射）
- `~/.dsh/settings.yaml` —— `agent-default-model` 与 `llm-pi-ai.providers.<id>.apiKeyEnv` 指向对应环境变量

之后即可在 GUI 的 Models 页进一步管理（dsh 自带热加载）。

> 也可以点「跳过」留空，之后随时在 harness 的 Models 页面配置。

## 设置页面

点击菜单 **DeepSeek Harness → 设置…**（快捷键 `Ctrl+,`）打开独立设置窗口，可手动指定：

| 字段 | 说明 |
|---|---|
| **dsh 入口（bin.js）** | `@deepseek-ai/dsh/lib/bin.js` 的完整路径；留空则自动探测（全局 npm → npx 缓存） |
| **Node.js（node.exe）** | 运行 dsh 的 Node 可执行文件；留空则自动探测 |
| **端口** | 后端监听端口（默认 3000，被占用自动顺延） |
| **DSH_HOME** | dsh 家目录（凭据/会话/配置），默认 `~/.dsh` |

每个路径字段旁有「浏览…」按钮（原生文件选择框），以及「测试连接」按钮（实际运行 `node bin.js --version` 验证）。点「保存并重启」后会自动停止旧后端、用新路径/端口重新拉起。

> 当 dsh 入口来自 npx 缓存（哈希目录，可能被 npm 清理），或应用启动失败时，会显示报错页 —— 直接点报错页上的「打开设置」填入固定路径即可恢复。

## 本地开发 / 重新打包

```powershell
cd C:\Users\45846\Documents\DSH-Desktop
npm install                 # 首次
npm run dev                 # 直接跑 electron（开发模式）
npm run pack                # 只生成 win-unpacked 目录
npm run dist                # 生成 nsis 安装器 + portable 便携版
```

## 已知限制

1. **依赖本机已有 node + dsh**：方案按「调用本机已装的 dsh」实现，因此目标机器需有 Node.js 且能解析到 `@deepseek-ai/dsh`（全局安装或 npx 缓存）。若需完全离线/无依赖，需改用「捆绑完整 dsh 运行时」方案（打包 node_modules，体积约 +1GB）。→ 可通过**设置页面**手动指定固定路径规避 npx 缓存不稳定的问题。
2. **未做代码签名**：本地打包无签名，Windows SmartScreen 可能提示「未知发布者」，点「仍要运行」即可。
3. **仅 Windows x64**：native 依赖（koffi/sharp/node-pty 等）按平台预编译，跨平台需另行打包。
4. **npx 缓存路径不稳定**：dsh 入口若来自 npx 缓存（哈希目录），可能被 npm 清理。→ 在「设置」里用 `dshBin` 指到固定路径即可彻底规避。
