// 常量与兜底数据。
//
// 上游事实来源：DeepAI Code 桌面端 / api.deepai.org 的实际行为，
// 网络实测见 PROTOCOL.md。这里只放“实现要照抄”的常量，不放逻辑。

import { randomBytes } from "node:crypto";

export const PROVIDER = "deepaicode";
export const VERSION = "0.3.0";

/**
 * 插件自己的 UA，所有直连请求显式携带。
 * 2026-11-07 起上游对 `user-agent: node`（Node 宿主 undici fetch 的默认值）在
 * /chat/completions 上直接 400；用插件自己的 UA，不冒充桌面端。
 */
export const USER_AGENT = `magpie-deepaicode/${VERSION}`;

/** 直连上游默认地址。 */
export const DEFAULT_BASE_ORIGIN = "https://api.deepai.org";
/** 直连模式在 origin 下的路径前缀。 */
export const DIRECT_MODEL_BASE = "/deepai_code";

/** Theos 计费车道版本；上游不认会回 426。2026-11-07 起桌面端使用 "4"（lane 2 仍被受理）。 */
export const DEFAULT_LANE_VERSION = "4";
/**
 * 车道自动探测序列（laneVersion: "auto" 时按序试 /models，取第一个 200 的值）：
 * 当前已知值在前（1 个请求即可定案），之后从高到低覆盖未来升级，再回落旧值。
 */
export const LANE_PROBE_SEQUENCE = ["4", "5", "6", "8", "12", "3", "2"];

export const HEADER_KEY = "Api-Key";
export const HEADER_LANE = "X-DeepAI-Code-Theos";
/** 每进程随机实例 id（同桌面端 DEEPAI_LANE_HEADERS 的生成方式）。 */
export const HEADER_INSTANCE = "X-DeepAI-Code-Instance";
export const HEADER_MACHINE = "X-DeepAI-Code-Machine";
export const HEADER_AFFINITY = "X-Session-Affinity";

/** 每插件进程一个随机实例 id（32 hex）。 */
export const INSTANCE_ID = randomBytes(16).toString("hex");

/** 请求体整形时补写的最简 system / instructions（上游校验“请求必须像桌面端发出的”）。 */
export const SHAPE_SYSTEM_MESSAGE = "You are a coding agent.";

/** 桌面端凭据文件名（按优先级）。 */
export const CREDENTIAL_FILES = ["deepai-account.bin", "deepai-account-user-managed.bin"];
/** 相对 base 目录的 secrets 候选。 */
export const SECRET_SUBDIRS = [["userdata", "secrets"], ["secrets"], ["dev", "secrets"]];

export const CATALOG_TTL_MS = 60_000;
/** Retry-After 的夹取上限（秒），与上游行为对齐。 */
export const RETRY_AFTER_CAP_S = 30;
/** 非流式 JSON 响应体的读取上限。 */
export const MAX_JSON_BYTES = 1 << 20;

/** 额度查询缓存：成功结果 10 分钟内直接复用——magpie 面板最短 5 秒一刷，
 * 额度又是每日发放的数据，没必要跟随面板频率打 /theos（那正是触发上游
 * "签到重启次数超限" 403 的原因）。 */
export const USAGE_TTL_OK_MS = 600_000;
/** 其他错误（网络等）10 分钟内不重试。 */
export const USAGE_TTL_ERR_MS = 600_000;
/**
 * "签到重启次数超限"（403）的锁定时长：上游明确说当天不再发放，
 * 6 小时内完全不请求 /theos（额度与签到都走这把锁），之后允许重试一次。
 */
export const CHECKIN_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 上游模型目录不可用时的兜底快照（2026-11-08 实测，18 个）。
 * 只用于“没登录 / 目录请求失败”时仍然有模型可选；正常路径永远以动态目录为准。
 */
export const FALLBACK_MODELS = [
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "mimo-2.6-flash", name: "MiMo 2.6 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "solar-mini-4", name: "Solar Mini 4", reasoning: true, input: ["text"], contextWindow: 524288, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000, premier: false, theosPerRequest: "0" },
  { id: "mimo-2.6-pro", name: "MiMo 2.6 Pro", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "crouton-alpha", name: "Crouton Alpha", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "glyph-cluster", name: "Glyph Cluster", reasoning: true, input: ["text"], contextWindow: 256000, maxTokens: 131072, premier: false, theosPerRequest: "0" },
  { id: "deepai-cyber", name: "DeepAI Cyber", reasoning: true, input: ["text"], contextWindow: 65536, maxTokens: 8192, premier: false, theosPerRequest: "0" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000, premier: true, theosPerRequest: "10" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: true, theosPerRequest: "10" },
  { id: "glm-5.3", name: "GLM 5.3", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 131072, premier: true, theosPerRequest: "3" },
  { id: "kimi-k3", name: "Kimi K3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: true, theosPerRequest: "3" },
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: true, theosPerRequest: "6" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000, premier: true, theosPerRequest: "15" },
  { id: "muse-wonder", name: "Muse Wonder", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072, premier: true, theosPerRequest: "15" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000, premier: true, theosPerRequest: "25" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000, premier: true, theosPerRequest: "50", api: "openai-responses" },
];

/** 模型目录快照的采集日期（写进 PROTOCOL.md / README，避免被当成实时数据）。 */
export const FALLBACK_SNAPSHOT_DATE = "2026-11-08";

export const DEFAULT_OPTIONS = {
  baseOrigin: DEFAULT_BASE_ORIGIN,
  /** "auto"：按 LANE_PROBE_SEQUENCE 探测 /models（免鉴权）取当前受理值并进程内缓存；显式值原样生效 */
  laneVersion: "auto",
  /** 每账号机器指纹存储文件；留空 = $MAGPIE_DEEPAICODE_HOME/machines.json 或 ~/.magpie-deepaicode/machines.json */
  machineStore: "",
  /** 界面语言：zh | en */
  lang: "zh",
  /** 桌面端凭据目录（留空自动探测） */
  secretDir: "",
  /** 调试日志（只记录字段名，不记录值） */
  debug: false,
};
