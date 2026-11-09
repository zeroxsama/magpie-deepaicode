# 协议事实基线（PROTOCOL.md）

本文件记录插件实现所依赖的**上游契约**，以及每条结论的证据等级。
它替代"每次改动都去翻反编译源码"：实现有疑问时先看这里。

- 快照日期：**2026-11-06**（模型目录 2026-11-08 更新）；**2026-11-08**：适配上游车道协议变更（lane 4 / UA / Instance / 请求体校验，见 §1.2/§1.3）；**2026-11-09**：改为每账号机器指纹并移除真实设备探测（见 §1.2）
- 参考实现：[DeepAICode2API](https://github.com/2951461586/DeepAICode2API)（MIT）——上游协议的逆向结论最初来自它的 `internal/deepai/*`、`docs/recon.md`
- 插件规范：[magpie 插件开发指南](https://usemagpie.ai/docs/zh/plugins)

> **0.3.0 变更**：改为每账号机器指纹，并移除真实设备指纹逻辑。做法与参考实现的
> `NewMachineUUID()` 一致：每个号一个随机 UUID v4，落盘保存，请求时发它的 sha256。
> 每个账号因此各自领取每日免费额度；不再提供 device 模式。

> **0.2.0 变更（历史）**：移除本机网关（DeepAICode2API）模式与"每账号派生指纹"
> （`machineMode: "account"`）。0.3.0 按账号池用法恢复了后者，并彻底移除了
> 真实设备指纹与 device 模式。

> 文中原"网关"相关事实保留为历史记录（标注 0.1.x）。

证据等级：

| 标记 | 含义 |
|---|---|
| **实测** | 本机/本仓库真实发过请求并观察到的结果 |
| **源码级** | 与参考实现源码一致（行为可由其单测/README 佐证） |
| **推断** | 尚未验证，实现里已留降级路径 |

---

## 1. 上游（`api.deepai.org`）

### 1.1 端点

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| POST | `/deepai_code/chat/completions` | 推理（OpenAI chat 兼容，支持 tools / 图片） | `Api-Key` |
| POST | `/deepai_code/responses` | 推理（仅 `api=openai-responses` 的模型，如 `gpt-6-astra`） | `Api-Key` |
| GET | `/deepai_code/models` | 模型目录 | **免鉴权** |
| GET | `/deepai_code/theos` | 免费额度 / 余额 | `Api-Key` |
| GET | `/get_usage_summary` | 订阅与用量摘要（根路径） | `Api-Key` |
| GET | `/deepai_code/desktop_auth/?state=…&port=…` | 浏览器登录起点 | 无 |
| POST | `/deepai_code/desktop_auth/exchange/` | `{code}` → `{api_key, username, is_pro}` | 无 |

基础地址 `https://api.deepai.org`（插件选项 `baseOrigin` 可覆盖）。

### 1.2 请求头

| 头 | 值 | 作用 |
|---|---|---|
| `User-Agent` | `magpie-deepaicode/<version>`（**必须显式**） | 2026-11-07 起上游 WAF 对 `user-agent: node`（Node 宿主 undici fetch 默认值）在 /chat/completions 上 400；curl / Bun / Electron 自带 UA 不受影响，显式 UA 对所有宿主无害 |
| `Api-Key` | 账号 Key（UUID 形态 `8-4-4-4-12`） | **鉴权走这个头，不是 `Authorization`** |
| `X-DeepAI-Code-Theos` | `4`（插件默认 `"auto"` 自动探测） | 计费车道版本。白名单实测（2026-11-08）：`2`/`4` → 200，`5` → 426；错值 426。`/models` 免鉴权即可探测，插件按 `["4","5","6","8","12","3","2"]` 顺序取第一个受理值并进程内缓存 |
| `X-DeepAI-Code-Instance` | 每进程随机 32 hex（同桌面端 `DEEPAI_LANE_HEADERS` 生成方式） | 客户端实例标识；桌面端对齐项 |
| `X-DeepAI-Code-Machine` | `sha256(小写原始 UUID)` 十六进制 | 每日免费额度的分配键 |
| `X-Session-Affinity` | 任意会话 id | 会话粘性（body 的 `prompt_cache_key` 同效） |

**请求体形状（2026-11-07 起校验）**：chat/completions 的 `messages` 首条必须是
`system`/`developer`，`/responses` 必须带非空 `instructions`；缺失时上游回
`400 "This request is not one DeepAI Code sends."`（内容不检查）。插件在缺失时自动
补一条最简 `system` / `instructions`，不改已有内容。经桌面端本地中继回放验证与 UA
过滤相互独立（[#3](https://github.com/aqiu817/magpie-deepaicode/pull/3) 的证据）。

**机器指纹的策略（0.3.0）**：只使用参考项目 DeepAICode2API 的账号池逻辑——每个账号
一个随机 UUID v4（`NewMachineUUID()`），首次使用时生成并写入
`~/.magpie-deepaicode/machines.json`（`machineStore` 可改路径），登录时同时写进
`auth.metadata.machineId`。请求头发 `sha256(小写原始值)`，原始值不上传。同一账号重登、
重启都复用同一个 UUID；不同账号互不相同，因此各自领取每日额度（上游的分配键是
`(X-DeepAI-Code-Machine, 账号)`）。落盘失败时退回 `derivedAccountUuid(accountId)`
（按账号稳定派生，重启不变）。

插件**不读取真实设备标识**：SMBIOS UUID / `MachineGuid` / IOPlatformUUID /
`/etc/machine-id` 探测、`DEEPAI_MACHINE_ID` 覆盖与 device 模式均已移除。哈希方式与
参考实现一致（sha256(小写去空白原始值)）。

### 1.3 错误语义

| 状态 | body | 含义 | 插件处理 |
|---|---|---|---|
| `409` | `{"error":{"code":"session_busy"}}` + `Retry-After` | 容量拒绝 | **转 429**（`Retry-After` 夹到 30s），交给 magpie 换号 |
| `401` | — | 鉴权失败 | 原样 401（magpie 标记账号） |
| `403` + `email_unverified` | — | 邮箱未验证 | 原样 403 + `X-Magpie-Sign-In: expired` |
| `426` + `lane_version_unsupported` | — | 车道/指纹问题（车道值不在白名单，或 /models 缺机器指纹头） | 原样 426，不标记账号；`laneVersion: "auto"` 会自动跟进新车道 |
| `400` + `This request is not one DeepAI Code sends.` | — | 客户端形状校验：UA 为 `node`（WAF），或请求体缺 system/instructions | 0.2.1：显式 UA + 自动补最简 system/instructions |
| `403` + `restarted its check-in too many times today` | — | 当日 `/theos` 签到状态机重启次数超限（换指纹、反复登录、频繁轮询） | 次日重置自动恢复；聊天不受影响 |
| `400`（其它 body）/`404`/`422` | — | 请求本身的问题 | 原样透出 |
| `302` | 登录页 | 无效 Key | **不跟随**（`redirect: "error"`）→ 转 401 |
| `5xx` / 网络错误 | — | 抖动 | 原样 / 抛错，交给 magpie |

`Retry-After` 解析：秒数，>30 夹到 30。

### 1.4 桌面端凭据

```
base    : T3CODE_HOME → DEEPAI_CODE_HOME → ~/.deepai-code
secrets : <base>/userdata/secrets → <base>/secrets → <base>/dev/secrets
文件名  : deepai-account.bin（首选）→ deepai-account-user-managed.bin
内容    : {"apiKey":"…","username":"…","isPro":false}   // 明文 JSON
```

显式路径（目录 / stateDir / secrets 目录 / 文件本身）优先于自动探测。

### 1.5 额度

| 项 | 事实 | 等级 |
|---|---|---|
| 分配键 | `(X-DeepAI-Code-Machine, 账号)`，每天一次；同一指纹的多个账号只有第一个能领 | 源码级（参考实现 §6.9–6.13） |
| `/theos` 字段 | `{enabled, balance, granted, refresh_at, lane_version}`；`balance`/`granted` 是**字符串**，5 位小数 | 源码级 |
| 刷新时间 | `refresh_at` 为 ISO（例如次日 UTC 04:03） | 源码级 |
| 新账号首次 | 常见 `granted=0`，几分钟后才 200 | 源码级 |
| 单请求成本 | 约 `1.8e-6`，小额调用看不出余额下降 | 源码级 |

### 1.6 模型目录快照（2026-11-08 实测）

`GET /deepai_code/models` **免鉴权**（需车道头 + 机器指纹头），实测 HTTP 200，18 个模型，默认 `glm-5.3-flash`。
字段：`{id, name, reasoning, input[], contextWindow, maxTokens, premier, theosPerRequest, api?}`。

| id | 名称 | API | 免费 | 上下文 | 输入 | Theos/请求 |
|---|---|---|---|---|---|---|
| `glm-5.3-flash` | GLM 5.3 Flash | chat | ✅ | 1,048,576 | text,image | 0 |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | chat | ✅ | 1,048,576 | text,image | 0 |
| `mimo-2.6-flash` | MiMo 2.6 Flash | chat | ✅ | 1,048,576 | text,image | 0 |
| `solar-mini-4` | Solar Mini 4 | chat | ✅ | 524,288 | text | 0 |
| `gpt-6-luna` | GPT-6 Luna | chat | ✅ | 1,048,576 | text,image | 0 |
| `mimo-2.6-pro` | MiMo 2.6 Pro | chat | ✅ | 1,048,576 | text,image | 0 |
| `crouton-alpha` | Crouton Alpha | chat | ✅ | 1,048,576 | text,image | 0 |
| `glyph-cluster` | Glyph Cluster | chat | ✅ | 256,000 | text | 0 |
| `deepai-cyber` | DeepAI Cyber | chat | ✅ | 65,536 | text | 0 |
| `gpt-6.1-sol` | GPT-6.1 Sol | chat | ❌ | 1,048,576 | text,image | 10 |
| `gemini-4-argon` | Gemini 4 Argon | chat | ❌ | 1,048,576 | text,image | 10 |
| `glm-5.3` | GLM 5.3 | chat | ❌ | 1,048,576 | text | 3 |
| `kimi-k3` | Kimi K3 | chat | ❌ | 1,048,576 | text,image | 3 |
| `muse-spark-1.3` | Muse Spark 1.3 | chat | ❌ | 1,048,576 | text,image | 6 |
| `claude-opus-5-5` | Claude Opus 5.5 | chat | ❌ | 1,000,000 | text,image | 15 |
| `muse-wonder` | Muse Wonder | chat | ❌ | 1,048,576 | text,image | 15 |
| `claude-fable-5-1` | Claude Fable 5.1 | chat | ❌ | 1,000,000 | text,image | 25 |
| `gpt-6-astra` | GPT-6 Astra | **openai-responses** | ❌ | 1,048,576 | text,image | 50 |

### 1.7 已知坑

1. 思维链在 `reasoning` 字段（参考实现会再补一份 `reasoning_content`）；magpie 原生渲染该字段（§4 #8 已实测），**无需** SSE 补写。
2. `models` 响应的默认模型字段名是 `default`（不是 `default_model`）。
3. SSE 同一事件可能有多行 `data:`，按规范用 `\n` 拼接后再解析。
4. 无效 Key 会 302 跳登录页——所有请求必须禁止跟随重定向。
5. `prompt_cache_key`（body）与 `X-Session-Affinity`（头）都影响上游调度。
6. 上游对 `/models` 的车道值做白名单校验（`2`/`4` → 200，`5` → 426），且免鉴权、无签到副作用——插件默认 `laneVersion: "auto"` 利用这一点自动跟进未来升车道，无需发版。
7. 2026-11-07 的"lane 2 全线 426"观察是 `user-agent: node` 污染下的测量假象（[#5](https://github.com/aqiu817/magpie-deepaicode/pull/5) 定位）；排查这类协议问题时先固定 UA 再下结论。

---

## 2. 额度窗口的构造约定

magpie 的 `auth.usage` 约定：

- 厂商没给用量时**不要传 `used`**，也不要用 0 表示"不知道"；
- 有 `amount` + `limit` 时 magpie 自己算 `used = limit - amount`；
- `aside: true` 的窗口只展示、不参与路由；本插件默认 `aside: false`（余额优先参与路由）。

因此「今日 Theos」窗口只在 `granted > 0` 时给 `amount`（已用 = granted − balance）与 `limit`。

`rate` 与 `free` 的语义（magpie）：

- `free: true` 才算免费；`rate: 0` 表示"没给倍率"，不是免费；
- 上游 `theosPerRequest == "0"` → `free: true`；其它数值 → `rate`。

---

## 3. 验证状态（2026-11-06 真机实测）

| # | 项目 | 状态 | 结论 |
|---|---|---|---|
| 1 | 上游 SSE 思维链字段 | ✅ 实测 | `delta` 里有 `reasoning` 与 `reasoning_details`，**没有** `reasoning_content`；magpie 已确认原生透传渲染（见 #6） |
| 2 | 工具调用 | ✅ 实测 | `tool_choice: "required"` + `max_tokens: 512` → `finish_reason: "tool_calls"`、`get_weather` 参数正确；`max_tokens: 64` 时会被思维链吃光，属正常现象 |
| 3 | 图片输入 | ✅ 实测 | `image_url` + 1×1 PNG → 200，模型正确描述颜色 |
| 4 | 模型级 npm 覆盖（`gpt-6-astra`） | ✅ 实测 | `magpie plugin --json` 里该模型为 `npm: @ai-sdk/openai`；Responses 通道走通（mock） |
| 5 | `api` 方式必须有非空 Key | ✅ 实测 | magpie 要求提示里有一个非空 Key；插件用哨兵 `auto` 表示"自动读凭据"，见 README |
| 6 | **magpie 是否展示 `reasoning`** | ✅ 实测 | 2026-11-06 晚真实 Agent 会话（`deepseek-v4.1-flash`）：「思考 · 持续 4 秒」块正常渲染 → magpie 原生展示上游 `reasoning`；SSE 行级补写**不需要启用** |
| 7 | 浏览器登录 `desktop_auth` 的 `state`/`port` 规则 | ❓ 未验证 | 未做浏览器实登；`localhost` 回调与 code 降级已由单测覆盖 |
| 8 | 插件 fetch 的 URL 形状 | ✅ 实测 | magpie 拼成 `{baseURL}/chat/completions` 或 `{baseURL}/responses`；插件的路径重建与之兼容（重复 `/deepai_code` 也能纠正） |
| 9 | **2026-11-08 车道协议适配** | ✅ 实测 | lane 4 + Instance + system 整形 + 显式 UA → chat 200（真实账号单发验证）；models 200（18 模型，lane 2/4 均 200、5 → 426）；致谢 [#3](https://github.com/aqiu817/magpie-deepaicode/pull/3) 与 [#5](https://github.com/aqiu817/magpie-deepaicode/pull/5) 的甄别工作 |

## 4. 真机实测记录（2026-11-06）

本机环境：magpie 0.1.2863；DeepAI Code 桌面端已登录（账号名已脱敏）。
标"网关"的行是 0.1.x 时期经参考网关所测（0.2.0 已移除网关模式，保留作历史记录）。

| 动作 | 结果 |
|---|---|
| （0.1.x）网关启动 + 池级额度/签到 | `/health` 200；池 1/1；`剩 200 / 200 theos`；checkin `done` |
| 插件登录（直连模式，读桌面端凭据） | `✓ signed in`；`quota` 显示「free · <账号名已脱敏>」「剩 200 / 200 theos」 |
| `magpie provider test deepaicode glm-5.3-flash`（直连） | ✓ chat 686 ms（网关路径冷启动 21 s，历史记录） |
| 钩子级 smoke（流式） | 200 `text/event-stream`，4 个 chunk，见到 `[DONE]`；usage/checkin 正常 |
| 工具调用（直连上游） | `finish_reason: tool_calls`，参数 `{"city":"巴黎"}` |
| 图片输入（直连上游） | 200，模型回答「鲑鱼色（橙粉色/珊瑚色）」 |
| Agent 真实会话（`deepseek-v4.1-flash`，2026-11-06 晚） | 正常回复；「思考 · 持续 4 秒」块正常渲染 → magpie 原生展示 `reasoning`（§3 #6） |

**额度口径实测**：免费模型（`theosPerRequest: "0"`）的响应里 `cost` 为 0；200 Theos 是 premier 模型的额度，
所以本轮回测没有消耗 Theos。

**一个环境坑**：如果 shell 里设了 `HTTPS_PROXY`（本机 Clash `127.0.0.1:7897`），Node 的 `fetch` 默认不读代理，
探针脚本会超时；加 `NODE_USE_ENV_PROXY=1` 即可（Node 24+）。magpie 的 Bun 宿主读环境代理，所以
`provider test` 不受影响。

## 5. 尚未验证的项（实现已留降级路径）

| # | 未验证项 | 现有处理 | 验证方式 |
|---|---|---|---|
| 1 | 浏览器登录 `desktop_auth` 的 `state`/`port` 校验规则（上游是否接受任意回环端口、回调是否带 state） | 回调"有 state 就校验、没有就只认路径与一次性端口"；监听失败或超时降级为粘贴 `code` | 真机走一次浏览器登录 |
| 2 | `gpt-6-astra`（Responses 通道）的 reasoning 渲染 | chat.completions 通道已确认；Responses 通道未单独观察 | 用 `gpt-6-astra` 跑一次真实会话 |

---

## 6. 复现方法

```bash
# 1) 协议取证（脱敏，不写文件）
node scripts/probe.mjs --secret-dir ~/.deepai-code

# 2) 钩子级联调（直连上游，需要登录过桌面端或传 --key）
node scripts/smoke.mjs

# 3) 单元测试
npm test
```

关键取舍：插件对上游的**错误原话一律透传**，自己的文案只用于"该怎么处理"；因此上游变更时，agent 与日志里能看到原话，不会被插件吞掉。
