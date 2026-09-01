# DSH 接入 Ollama 云端模型 · 配置经验总结

> 适用场景：本机装好了 Ollama 和 DeepSeek Harness（DSH），想把 Ollama 里的 **cloud 云端托管模型** 接入 DSH，在多台设备上复刻同一套配置。
> 更新日期：2026-08-25 · Ollama 0.32.15 · DSH 0.1.0-rc.7

---

## 1. 原理速览

- Ollama 的 `:cloud` 模型是**指针模型**：本地只有 manifest + config（几 KB），真正的推理在 `https://ollama.com` 云端完成。本地磁盘不占权重空间，`ollama pull` 秒下。
- 本地 Ollama 守护进程对外照常提供 **OpenAI 兼容接口**：`http://127.0.0.1:11434/v1`，DSH 只连这个地址，云端路由由 Ollama 自己处理。
- DSH 侧通过 `llm-pi-ai.providers` 增加一个 **`ollama` 路由**，把云端模型挂进模型选择器，热加载生效、无需重启。

## 2. 涉及文件（DSH 家目录，默认 `~/.dsh`）

| 文件 | 作用 |
|---|---|
| `settings.yaml` | 新增 `llm-pi-ai.providers.ollama` 路由与模型列表（以及可选的 `opencode-go` 路由、`agent-default-model`） |
| `.credentials.yaml` | 新增占位凭据 `OLLAMA_API_KEY`（Ollama 本地端点无鉴权，但 DSH 的 pi-ai 适配器要求 keyless 端点必须挂一个占位引用）；以及可选的真实凭据 `OPENCODE_GO_API_KEY` |
| `opencode-proxy.json` | （本仓库代理功能用）多 Key 轮换池与用量统计，**不要提交进仓库** |

## 3. 完整配置（可直接照抄）

### `settings.yaml` 追加内容

```yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama (cloud)
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      models:
        - id: "kimi-k3:cloud"
          name: Kimi K3 (cloud)
          contextWindow: 1048576
          input: [text, image]
          reasoningEfforts: false
        - id: "gpt-oss:120b-cloud"
          name: GPT-OSS 120B (cloud)
          contextWindow: 131072
          reasoningEfforts: false
        - id: "deepseek-v4-pro:cloud"
          name: DeepSeek V4 Pro (cloud)
          contextWindow: 1048576
          reasoningEfforts:
            off:
            high: high
            max: high
        - id: "deepseek-v4-flash:cloud"
          name: DeepSeek V4 Flash (cloud)
          contextWindow: 1048576
          reasoningEfforts:
            off:
            high: high
            max: high
        - id: "glm-5.2:cloud"
          name: GLM-5.2 (cloud)
          contextWindow: 1000000
          reasoningEfforts: false
```

### `.credentials.yaml` 追加一行

```yaml
OLLAMA_API_KEY: ollama
```

> 值 `ollama` 只是占位符（任意合法字符串均可），Ollama 会忽略 `Authorization` 头。

## 4. 关键经验一：为什么有的模型开思考、有的不开

pi-ai 对**推理模型**（reasoning）会把 DSH 的系统提示词以 `developer` 角色发送；对**非推理模型**以 `system` 角色发送。
而 Ollama 的 OpenAI 兼容端点对 `developer` 角色的支持**因模型而异**：

| 模型 | 遵守 system | 遵守 developer | DSH 配置 |
|---|---|---|---|
| `deepseek-v4-pro:cloud` | ✅ | ✅ | 开思考（off/high/max） |
| `deepseek-v4-flash:cloud` | ✅ | ✅ | 开思考（off/high/max） |
| `kimi-k3:cloud` | ✅ | ❌ 静默忽略 | 关思考（`reasoningEfforts: false`） |
| `gpt-oss:120b-cloud` | ✅ | ❌ 静默忽略 | 关思考（`reasoningEfforts: false`） |
| `glm-5.2:cloud` | ✅ | ❌ 静默忽略 | 关思考（`reasoningEfforts: false`） |

- **忽略 developer 角色 = 系统提示词整个丢失**，agent 会退化成没有指令的裸模型，所以必须配 `reasoningEfforts: false`（走 system 角色）。
- 关思考 ≠ 不思考：模型内部照常思考，思考过程仍会在 DSH 界面显示，只是没有"思考强度"选择器。
- **新模型接入前一定要实测角色行为**，不能想当然。

## 5. 关键经验二：角色行为测试方法

对每个模型跑两组"口令测试"，看回复是否听话：

```powershell
# system 角色是否生效（期望回复 SYSOK）
$b = @{ model='模型名'; messages=@(@{role='system';content='Reply with the single word SYSOK and nothing else.'},@{role='user';content='hi'}); max_tokens=400; stream=$false } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:11434/v1/chat/completions' -Method Post -Body $b -ContentType 'application/json'

# developer 角色是否生效（期望回复 DEVOK）
$b = @{ model='模型名'; messages=@(@{role='developer';content='Reply with the single word DEVOK and nothing else.'},@{role='user';content='hi'}); max_tokens=400; stream=$false } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:11434/v1/chat/completions' -Method Post -Body $b -ContentType 'application/json'
```

坑：思考型模型测试时 **max_tokens 要给足（≥400）**，否则 token 全被思考阶段吃掉，回复为空，容易误判为"不生效"。

## 6. 关键经验三：找可用的 cloud 模型名

1. **看 ollama.com 云端目录**（返回全部 cloud 模型，19 个左右）：
   ```powershell
   Invoke-RestMethod -Uri 'https://ollama.com/api/tags?q=deepseek' -Headers @{ Accept='application/json' }
   ```
   注意：`q=` 参数基本不过滤，返回的是全量目录；结果里的 `name` 带日期（如 `deepseek-v4-pro:0813`）只是**版本标识，不是可拉取 tag**。

2. **查注册表确认真实 tag**（不带伪造的 ollama User-Agent，否则 401）：
   ```powershell
   $h = @{ Accept='application/vnd.docker.distribution.manifest.v2+json' }
   Invoke-WebRequest -Uri 'https://registry.ollama.ai/v2/library/deepseek-v4-pro/manifests/cloud' -Headers $h
   # 200 + layers=[]  → 云端指针模型，可 ollama pull deepseek-v4-pro:cloud
   # 404 → 该 tag 不存在
   ```
   规律：**云端模型统一是 `<模型名>:cloud` 这个 tag**（如 `glm-5.2:cloud`、`kimi-k3:cloud`）。

3. **看模型规格**（上下文、参数量、能力）：取 manifest 里 `config.digest`，再拉 config blob：
   ```powershell
   $m = Invoke-WebRequest -Uri 'https://registry.ollama.ai/v2/library/deepseek-v4-pro/manifests/cloud' -Headers $h
   $digest = ($m.Content | ConvertFrom-Json).config.digest
   $b = Invoke-WebRequest -Uri "https://registry.ollama.ai/v2/library/deepseek-v4-pro/blobs/$digest" -Headers @{ Accept='application/vnd.docker.container.image.v1+json' }
   [System.Text.Encoding]::UTF8.GetString($b.Content)
   # 关注 context_length（→ 配置 contextWindow）、capabilities
   ```

4. **拉取**：`ollama pull <模型名>:cloud`（秒下，不占磁盘）。

## 7. 关键经验四：接入 DSH 的配置要点

- 路由字段名注意驼峰：`baseURL`、`apiKeyEnv`、`displayName`、`contextWindow`、`reasoningEfforts`。
- `api: openai-completions` + `baseURL: http://127.0.0.1:11434/v1`（本地端点，keyless）。
- `reasoningEfforts: false` = 非推理；开思考的写法（档位名 : 线上拼写，`off:` 空值表示"选了就不发参数"）：
  ```yaml
  reasoningEfforts:
    off:
    high: high
    max: high
  ```
  云端后端不一定认 `max`，稳妥做法是把 `max` 映射到后端确认支持的 `high`。
- **视觉模型必须显式声明 `input: [text, image]`**：DSH 在放行图片前查模型声明的输入模态（入口层和 pi-ai 适配器两道闸），解析顺序是 条目 `input` → pi-ai 内置目录 → 路由 `defaultInput`（默认 `[text]`）。pi-ai 内置目录**没有 ollama 路由**，所以 ollama 下不写 `input` 的模型一律被当成纯文本，GUI 直接拒发图片。只给实际支持视觉的模型声明，虚报会在上游端点报错。
  - 实测方法（以 kimi-k3:cloud 为例）：`POST http://127.0.0.1:11434/v1/chat/completions`，message content 用 `image_url`（`data:image/png;base64,...`）+ 文本提问；能正确答出图中内容即可声明。
  - 已实测判定（Ollama 云端，带图提问，图内含随机 6 位验证码）：**支持** `kimi-k3:cloud`；**不支持** `gpt-oss:120b-cloud`、`deepseek-v4-pro:cloud`、`deepseek-v4-flash:cloud`、`glm-5.2:cloud`（端点均明确返回 `400 this model does not support image input`）。同日另实测 opencode-go 目录：`qwen3.7-max`、`mimo-v2.5-pro`、`hy3`、两个 deepseek-v4、`glm-5.1` 也不收图；目录内 `kimi-k2.6 / k2.7-code / k3`、`minimax-m3`、`qwen3.6-plus / 3.7-plus`、`mimo-v2.5`、`grok-4.5` 已自带 `text+image` 声明，开箱即用。
- `contextWindow` 按模型 config blob 里的 `context_length` 填（deepseek 1M=1048576，glm-5.2 1M=1000000，gpt-oss 128K=131072）。

## 8. 验证与热加载

1. **schema 校验**（可选但推荐）：用 DSH 自带的 schema 跑一遍，能提前发现拼写/结构错误。
2. **看后端是否热加载**（DSH 会监听 settings.yaml 变更，无需重启）：
   ```powershell
   $body = @{ type='client-request'; rpcId=[guid]::NewGuid().ToString(); method='llm.models'; payload=@{} } | ConvertTo-Json -Depth 5
   $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/llm.models' -Method Post -Body $body -ContentType 'application/json'
   $r.result.value.groups | Where-Object { $_.id -eq 'ollama' } | ConvertTo-Json -Depth 8
   $r.result.value.failures   # 应为空
   ```
   端口按实际 dsh web 端口（3000 起）。配置若非法，DSH 会保留上一次的合法配置并告警，模型不出现即说明配置被拒。
3. 之后在 GUI 的 Models 页/模型选择器里就能看到 "Ollama (cloud)" 分组并选用。

## 9. 其他设备复刻清单

- [ ] 安装 Ollama（≥0.32，支持 cloud 模型）并确保 `ollama` 守护进程在跑
- [ ] `ollama pull deepseek-v4-pro:cloud`、`ollama pull deepseek-v4-flash:cloud`、`ollama pull glm-5.2:cloud`（按需，可选 `kimi-k3:cloud`、`gpt-oss:120b-cloud`、`glm-5.1:cloud`）
- [ ] 新模型先跑第 5 节的 developer 角色测试，决定开/关思考
- [ ] 把第 3 节两段配置写入该设备的 `~/.dsh/settings.yaml` 和 `.credentials.yaml`（桌面版/命令行版 DSH 共用同一份 `~/.dsh`）
- [ ] 用第 8 节命令验证后端热加载成功
- [ ] GUI 模型选择器确认模型可用
- [ ] 如需 opencode-go：在 `.credentials.yaml` 写入 `OPENCODE_GO_API_KEY`，并在 `providers` 下声明 `opencode-go` 路由（见第 11 节）；注意 `.credentials.yaml` 不要提交进仓库
- [ ] 如需多 Key 轮换：桌面应用设置窗口填 Key 列表（或跑 `node opencode-proxy-cli.js` + 手动写 `baseURL`，见第 12 节）；`opencode-proxy.json` 同样不要提交进仓库

## 10. 已知坑与备忘

1. 注册表请求带 `User-Agent: ollama/...` 会 401；直接用浏览器式请求即可。
2. `ollama.com/api/tags` 里 `size=0`、`file_type=""` 的条目（如 glm-5.2 当初）不代表不能用——实测运行正常，以实际测试为准。
3. 云端模型请求会走公网到 ollama.com，注意网络与账号（如需 `ollama signin`）。
4. 本机 32GB 内存跑不动这些模型的本地权重——cloud 指针模式正是为此设计的，本地不落权重。

## 11. 配置 opencode-go（OpenCode Zen Go 网关）

`opencode-go` 是 pi-ai **内置的目录路由**（OpenCode Zen Go，端点 `https://opencode.ai/zen/go`），
支持 anthropic-messages / openai-completions / openai-responses 三种协议，模型目录由 pi-ai 自带
（qwen3.7-max / qwen3.7-plus、minimax-m3、deepseek-v4-pro / deepseek-v4-flash、glm-5.x、
kimi-k2.6 / k2.7-code / k3、grok-4.5、hy3、mimo 等）。

### 11.1 最小配置（两步）

1. `.credentials.yaml` 加一行：

   ```yaml
   OPENCODE_GO_API_KEY: <你的 OpenCode Zen Go API Key>
   ```

   Key 在 opencode.ai 注册并开通 Zen Go 套餐后从控制台获取。
   **凭据名可以自定**（DSH 通过名字引用，不要求与 pi-ai 默认环境变量 `OPENCODE_API_KEY` 一致），
   只要 settings 里的 `apiKeyEnv` 与它一致即可。

2. `settings.yaml` 的 `llm-pi-ai.providers` 下声明：

   ```yaml
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
   ```

   目录路由**不需要写** `api`、`baseURL`、`models` —— 端点、协议、模型目录全部沿用 pi-ai 内置目录，
   缺省字段即继承目录默认值。这一点与第 3 节的 ollama 路由（手写路由，必须写全）正好相反。

### 11.2 设为默认模型（可选）

```yaml
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-pro
  reasoningEffort: max
```

`model` 填目录里的任意模型 id（如 `qwen3.7-max`、`glm-5.2`、`kimi-k3`），
思考档位以 Models 页该模型实际显示的为准（不同模型可选的 off/low/high/max 不同）。

### 11.3 目录路由的注意点

- 目录路由一旦写了 `models:` 列表，就会**整体替换**内置目录（只保留列表里的模型，没列出的全部消失）；
  只想微调个别模型（改上下文、改思考档位）请用 `modelOverrides`，按模型 id 逐个覆盖。
- 也可用 `baseURL` 覆盖目录默认端点（例如指向代理），其余字段同理按需覆盖。
- 换设备复刻时：凭据名 + 两处引用一致即可，配置本身不含密钥。

## 12. OpenCode 多 Key 故障转移代理（本项目自带功能）

仓库内置一个本地代理（`proxy.js` + `opencode-proxy-cli.js`），把多把 OpenCode API Key
组成轮换池：某把 Key 配额耗尽时**自动切换下一把并重放同一请求**，并**按 Key 统计用量**
（请求数 / 输入 token / 输出 token）。桌面应用（`main.js`）已内置集成；不用桌面应用的
设备可单独跑 CLI。

### 12.1 原理与注意点

- Key 池存在 `~/.dsh/opencode-proxy.json`（**不要提交进仓库**），格式：
  ```json
  { "enabled": true, "port": 8787, "keys": ["sk-第一把", "sk-第二把"],
    "activeIndex": 0, "usage": [ { "requests": 0, "inputTokens": 0,
    "outputTokens": 0, "quotaFailures": 0, "lastUsedAt": null } ] }
  ```
- 触发轮换的错误：HTTP **401 / 402 / 429**，以及 403 且响应含 quota/limit/plan 等文案；
  其他错误（400/404 等）原样透传，不轮换。
- DSH 的 `opencode-go` 路由通过 `baseURL: http://127.0.0.1:8787` 指向代理（桌面应用
  自动写入/移除这一行；CLI 用户手动写）。
- 代理会把出站 JSON 中的 `messages[].role: "developer"` 改写为 `"system"`——因为 baseURL
  改到本机后，pi-ai 的兼容性自动检测会启用 developer 角色，而 OpenCode 端点会**静默忽略**
  developer 角色（实测）。这一改写保住了系统提示词。
- 路径分发：`/v1/messages*` → OpenCode 的 Anthropic 协议端点；其余 → OpenAI 协议端点。
- 用量统计是**本地统计**（代理按 Key 累计），不是官方余额——OpenCode 与 Ollama 官方
  目前都没有余额/额度查询接口（见第 13 节）。

### 12.2 桌面应用方式（推荐）

> 注意区分两套设置：本功能在**桌面应用的原生设置窗口**（菜单 DeepSeek Harness →
> 设置…，或 `Ctrl+,`）里；DSH 网页界面自己的 Settings/Models 页不包含这些内容。

1. 桌面应用 → 菜单 **DeepSeek Harness → 设置…** → 找到「OpenCode 多 Key 代理」区块：
   - 勾选启用、填端口（默认 8787）、**每行一把 Key** 填进文本框；
   - 点「保存代理配置」，下方表格即显示每把 Key 的用量与当前使用中的 Key（●）；
   - 「立即切换下一把 Key」手动轮换，「刷新用量」拉取最新统计。
2. 保存后代理立即生效，DSH 的 `opencode-go` 路由会自动指向代理（settings.yaml 热加载）。
3. 应用退出时自动停代理；下次启动自动拉起。

### 12.3 独立 CLI 方式（不用桌面应用的设备）

```powershell
node opencode-proxy-cli.js            # 默认端口 8787，配置 ~/.dsh/opencode-proxy.json
node opencode-proxy-cli.js --port 8790 --config <路径>
```

然后在 `settings.yaml` 手动给 `opencode-go` 加一行（CLI 不会代写）：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      baseURL: http://127.0.0.1:8787
```

管理端点（仅 127.0.0.1 可访问）：

```powershell
curl http://127.0.0.1:8787/__proxy/state    # GET  状态与每把 Key 用量
curl -X POST http://127.0.0.1:8787/__proxy/rotate  # 手动切换下一把
curl -X POST http://127.0.0.1:8787/__proxy/reload  # 重新加载配置文件
```

### 12.4 验证方法

- 状态接口：`GET /__proxy/state` 应返回 `activeIndex` 与每把 Key 的 `requests/quotaFailures`。
- 轮换验证：把一把假 Key 放在第 1 位、真 Key 放在第 2 位，发一个请求 → 应成功返回，
  且 state 中 `activeIndex=1`、假 Key 的 `quotaFailures=1`。
- 角色改写验证：发一个带 `developer` 角色指令（"只回复 DEVOK"）的请求 → 应回复 DEVOK
  （证明 developer 被改写为 system 并被模型执行）。

## 13. 余额/额度查询现状（2026-08 调研结论）

**OpenCode Zen/Go 与 Ollama Cloud 官方都没有余额/额度查询接口**，相关功能请求仍在开放中：
OpenCode（[#10448](https://github.com/anomalyco/opencode/issues/10448)、
[#18648](https://github.com/anomalyco/opencode/issues/18648)），
Ollama（[#12532](https://github.com/ollama/ollama/issues/12532)、
[#15663](https://github.com/ollama/ollama/issues/15663)）。
社区方案一律靠浏览器 Cookie 抓网页 dashboard（如
[ollama-usage](https://github.com/florian-croiset/ollama-usage) 抓 `ollama.com/settings`），
脆弱且未必符合 ToS。本项目因此对这两个服务采用**本地用量统计**
（第 12 节的代理统计 + DSH 自带 token-meter 的会话统计），官方出接口后再接入真实余额。

**例外：DeepSeek 官方 API 有标准余额接口**，桌面应用已内置显示：

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```

返回示例：

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "137.30",
      "granted_balance": "0.00", "topped_up_balance": "137.30" }
  ]
}
```

在桌面应用「设置 → DeepSeek 官方 API 余额」点「刷新余额」即可查看（凭据自动取自
`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`）。命令行直接查：

```powershell
curl -H "Authorization: Bearer <你的 DEEPSEEK_API_KEY>" https://api.deepseek.com/user/balance
```

## 14. Ollama Cloud 多账号自动轮询（本项目自带功能）

ollama.com 现在提供 **API Key**（每个订阅账号一个）和 **OpenAI 兼容端点**
`https://ollama.com/v1/chat/completions`（实测支持 `developer` 角色、`reasoning` 字段、
SSE 流式）。因此多账号轮询不再需要切换本地 ollama 应用的设备密钥对，而是像 opencode
一样走本地故障转移代理。

### 14.1 原理

- 仓库内置 `ollama-proxy.js`（核心）+ `ollama-proxy-cli.js`（独立运行入口）。
- Key 池存在 `~/.dsh/ollama-proxy.json`（**不要提交进仓库**），每个账号一把 Key：
  ```json
  { "enabled": true, "port": 8788, "keys": ["<账号1 key>", "<账号2 key>", "<账号3 key>"],
    "activeIndex": 0, "usage": [ { "requests": 0, "inputTokens": 0,
    "outputTokens": 0, "quotaFailures": 0, "lastUsedAt": null, "lastError": null } ] }
  ```
- 代理直连 `https://ollama.com/v1`，**不需要本地 ollama 守护进程**；某账号额度耗尽
  （401/402/429，或 403 + 配额文案）时自动切换下一账号并重放请求。
- DSH 的 `ollama` 路由 `baseURL` 由桌面应用自动指向 `http://127.0.0.1:8788`（停用时
  自动改回本地守护进程 `http://127.0.0.1:11434/v1`）。

### 14.2 桌面应用方式（推荐）

1. 桌面应用 → 菜单 **DeepSeek Harness → 设置…** → 「Ollama Cloud 多账号代理」区块：
   - 勾选启用、填端口（默认 8788）、**每行一个账号的 API Key**；
   - 点「保存代理配置」，下方表格显示每个账号的用量、配额失败次数、最近错误与当前账号（●）；
   - 「立即切换下一账号」手动轮换，「刷新用量」拉取最新统计。
2. 保存后代理立即生效，DSH 的 `ollama` 路由自动指向代理（settings.yaml 热加载）。

### 14.3 独立 CLI 方式（不用桌面应用的设备）

```powershell
node ollama-proxy-cli.js            # 默认端口 8788，配置 ~/.dsh/ollama-proxy.json
node ollama-proxy-cli.js --port 8790 --config <路径>
```

然后在 `settings.yaml` 手动把 `ollama` 路由的 `baseURL` 改成 `http://127.0.0.1:8788`。

管理端点（仅 127.0.0.1）：

```powershell
curl http://127.0.0.1:8788/__ollama/state    # GET  状态与每个账号用量
curl -X POST http://127.0.0.1:8788/__ollama/rotate  # 手动切换下一账号
curl -X POST http://127.0.0.1:8788/__ollama/reload  # 重新加载配置
```

### 14.4 验证方法

- 状态接口：`GET /__ollama/state` 应返回 `activeIndex` 与每个账号的 `requests/quotaFailures`。
- 轮换验证：把一把假 Key 放第 1 位、真 Key 放第 2 位，发一个请求 → 应成功返回，
  且 state 中 `activeIndex=1`、假 Key 的 `quotaFailures=1`、`lastError.status=401`。

> 注：仓库里另有 `ollama-switch-account.ps1`（基于设备密钥对切换本地 ollama 应用账号），
> 在改用 API Key 代理后已非必需，仅当你还需要切换本地 ollama 应用本身（如
> `ollama launch` 集成）时使用。
