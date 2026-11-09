# Changelog

## 0.3.0 — 2026-11-09

每账号独立机器指纹（参考 [DeepAICode2API](https://github.com/2951461586/DeepAICode2API)
的账号池做法），并移除真实设备指纹逻辑：

- **每个账号一个随机 UUID v4**（等同参考实现的 `NewMachineUUID()`）：登录 / 首次请求时
  生成，请求头 `X-DeepAI-Code-Machine` 发它的 sha256；不同账号指纹互不相同，各自领取
  每日免费 Theos。
- **持久化**：原始 UUID 写入 `~/.magpie-deepaicode/machines.json`（POSIX 0600，
  可用 `machineStore` 改路径），同时写进 `auth.metadata.machineId`；同一账号重启、
  重登都复用同一个值，不会重新"抽奖"。
- **存量账号自动补齐**：没有 `machineId` 的旧账号在首次请求时生成并落盘（只补空值，
  不覆盖已有值），等同参考实现的 `assign_machine`。升级后每个存量号会换一次指纹；
  若当天碰到上游"签到重启次数超限"403，插件按既有逻辑锁定 6 小时，次日自动恢复。
- **移除真实设备指纹**：删除 SMBIOS UUID / `MachineGuid` / IOPlatformUUID /
  `/etc/machine-id` 探测、`DEEPAI_MACHINE_ID` 覆盖与 `machineMode` 选项；
  现在不存在 device 模式，所有账号一律使用独立 UUID。
- **落盘失败兜底**：只读文件系统 / 无 home 权限时退回按账号稳定派生（重启不变）。
- 登录验活（`/theos`）与后续推理 / 额度 / 签到使用同一个账号指纹。
- 测试 63 → 72（UUID v4、落盘复用、账号互异、metadata 优先、只读兜底）。

## 0.2.3 — 2026-11-08

- 额度查询缓存时长上调：成功与错误均 **10 分钟**（0.2.2 为 60s/5min——magpie 面板
  最短 5 秒一刷，10 分钟上限把 `/theos` 的频率压到最低，面板想要零请求可设"关闭"）。
- 0.2.2 已在 npm 标记 deprecated（安装时会提示升级到本版）。

## 0.2.2 — 2026-11-08

降低对上游 `/theos` 的请求频率，并把"当日签到上限"从红色报错改成中性展示：

- **额度查询进程内缓存**：成功结果 60s、其他错误 5 分钟内直接复用
  （magpie 面板刷新很频繁，之前每次刷新都打一次上游）。
- **"签到次数超限"（403）长锁定**：命中 `restarted its check-in too many times`
  后 6 小时内**完全不再请求** `/theos`（额度与签到共用一把锁），面板改显示
  "今日签到次数已达上游上限，额度窗口明日恢复"——不再是红色报错。
- 签到真正领到（`claimed`）时清除额度缓存，下一次额度查询立即反映新额度。
- 测试 61 → 63（缓存命中、403 锁定展示与签到跳过）。

## 0.2.1 — 2026-11-08

上游于 2026-11-07 起对请求做“客户端形状”校验，旧版插件全线 426/400（issue #1/#2）。
本版按两次外部甄别（[#3](https://github.com/aqiu817/magpie-deepaicode/pull/3) mun0602、
[#5](https://github.com/aqiu817/magpie-deepaicode/pull/5) Kling0012，感谢！）合并修复，
并经本机甄别实验定案（2026-11-08 实测）：

- **显式 `User-Agent: magpie-deepaicode/<version>`**（所有直连请求）：Node 宿主的
  undici fetch 默认发 `user-agent: node`，上游 WAF 对 /chat/completions 直接
  `400 "This request is not one DeepAI Code sends."`；Bun 宿主 / curl 不受影响，
  显式 UA 对两者都无害。
- **车道默认改为 `laneVersion: "auto"`**：`/models` 免鉴权且对车道值做白名单校验
  （实测 `2`/`4` → 200，`5` → 426），插件按 `["4","5","6","8","12","3","2"]` 顺序
  探测取第一个受理值并进程内缓存——上游再升车道时自动跟进，无需发版。
  显式值（如 `"4"`）原样生效、不探测。默认值即上游当前要求的 **lane 4**。
- **`X-DeepAI-Code-Instance`**：每进程随机 32 hex（同桌面端），所有直连请求携带。
- **请求体整形**：chat/completions 的 `messages` 首条必须是 `system`/`developer`、
  `/responses` 必须带非空 `instructions`，缺失时插件自动补一条最简
  `"You are a coding agent."`，不改已有内容。
- 换码（`/desktop_auth/exchange/`）超时 20s → 45s（弱网/代理链路下上游偶尔超过 20s）。
- 兜底模型快照 14 → **18**（新增 `glyph-cluster`、`gemini-4-argon`、`muse-spark-1.3`、
  `muse-wonder`；`claude-opus-5-5`/`claude-fable-5-1`/`gpt-6-astra` 的 maxTokens
  调整为 64000/64000/128000），快照日期 2026-11-08。
- 测试 54 → 61（UA/实例头、车道探测缓存与退回、请求体整形分支）。

升级提示：直接更新插件即可，无需改任何选项；已登录账号保持登录状态。

## 0.2.0 — 2026-11-07

按 magpie 社区收录要求（PR #805 审查意见）做出的重要变更：


- **移除本机网关（DeepAICode2API）模式**：登录项与 `showGatewayLogin` / `gatewayUrl` /
  `gatewayKey` / `gatewayAdmin` 选项、池级额度（`/admin/api/accounts` 聚合）与池签到
  （`/admin/api/checkin`）全部删除；`src/gateway.mjs`、`scripts/mock-gateway.mjs` 移除。
  插件只保留直连上游一种模式。自己账号的三路登录（浏览器 / 桌面端凭据 / API Key）不变。
- **修复 debug 日志泄密**：`debug: true` 时登录过程只记录"哪些字段有值"（字段名），
  绝不打印 Key / 管理密码等内容；新增回归测试。
- 登录不再在 metadata 里保存 `machineMode` / `machineId`。
- 403（`/theos` 验活）文案改为"登录已失效"（原误用"缺少 Key"）。
- 文档同步：README（中/英）、PROTOCOL.md 移除网关章节；测试 75 → 54（网关用例移除）。

升级提示：0.1.x 的网关账号需要在 magpie 里重新以三路方式之一登录；已登录的直连账号


## 0.1.1 — 2026-11-06

- 登录方式重排：**浏览器登录（推荐）→ 读取本机凭据 → 粘贴 API Key**。
- "本机 DeepAICode2API"登录方式**默认隐藏**，用 `showGatewayLogin: true` 打开（排在最后）。
- 默认模式改为 `direct`；`config` 钩子声明的供应商 `api` 随之指向直连基地址。
- 新增 `icon.svg`（供仓库 / 社区 registry 引用）；npm 包版本升到 0.1.1。

## 0.1.0 — 2026-11-06

首个版本，双模式供应商插件。

- 供应商 `deepaicode`，模型写作 `deepaicode/<model>`；目录动态拉取，2026-11-06 快照兜底（14 个模型）。
- **gateway 模式（默认）**：本机 DeepAICode2API；`/health` 免鉴权发现；可选网关 Key 与管理密码；池级额度聚合；`/admin/api/checkin` 签到。
- **direct 模式**：`api.deepai.org`；四种登录中的三种（桌面端凭据 / 粘贴 Key / 浏览器 + localhost 回调）；每账号独立机器指纹（`uuidv5(sha256(key))`，可切 `device`）。
- 错误语义：`409 session_busy` → 429（`Retry-After` 夹 30s）；`403 email_unverified` → `X-Magpie-Sign-In: expired`；`426` 不标记账号；`302` 不跟随 → 401；网关池空 503 → 429。
- 模型映射：`theosPerRequest == "0"` → `free: true`；premier → `rate`；`gpt-6-astra` 带模型级 `provider.npm` 覆盖（Responses）。
- 会话粘性：`chat.headers` 注入 `X-Session-Affinity`。
- 工具：`scripts/probe.mjs`（脱敏取证）、`scripts/mock-gateway.mjs`（离线网关）、69 个单测。

首版曾列为待验证的项（除最后两项外均已完成，见下）：

- 有可用 DeepAI 账号时的 chat/streaming、工具调用、图片输入；
- `reasoning` 字段是否需要补写 `reasoning_content`；
- magpie 对"模型级 npm 覆盖"的支持（`gpt-6-astra`）；
- 浏览器登录 `desktop_auth` 的 `state`/`port` 校验细节。

### 真机回归结果（2026-11-06 晚，已在 0.1.0 上补测）

真实账号（桌面端已登录）+ 本地编译的参考网关，逐项结果：

| 项目 | 结果 |
|---|---|
| 网关模式登录 / 目录 / 额度 / 签到 | ✅ 14 模型；池 1/1；`剩 200 / 200 theos`；checkin `done` |
| 直连模式登录（读桌面端凭据） | ✅ 账号名已脱敏；`剩 200 / 200 theos` |
| chat（网关 / 直连） | ✅ 21,037 ms（冷启动）/ 686 ms |
| 流式 | ✅ SSE 4 chunk + `[DONE]` |
| 工具调用 | ✅ `finish_reason: tool_calls`，参数正确 |
| 图片输入 | ✅ 200，模型正确描述颜色 |
| 模型级 npm 覆盖 | ✅ `gpt-6-astra` → `@ai-sdk/openai`，Responses 通道走通（mock） |
| 管理接口无密码 + 回环 | ✅ 可读；插件已改为"先试再降级" |
| 上游思维链字段 | ✅ 实测为 `reasoning`（无 `reasoning_content`）；magpie 侧是否展示待观察 |

仍未验证：magpie 是否把 `reasoning` 渲染给 Agent；浏览器登录的真实回调细节。
