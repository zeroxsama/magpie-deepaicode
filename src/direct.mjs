// 直连模式：api.deepai.org 的额度与登录换码。
//
// 请求头要点（源码级，见 PROTOCOL.md）：
//   User-Agent                 ← 必须显式带（上游 WAF 拦 "user-agent: node"）
//   Api-Key                    ← 鉴权走这个头，不是 Authorization
//   X-DeepAI-Code-Theos        ← 计费车道版本，当前 "4"，不对会 426
//   X-DeepAI-Code-Instance     ← 每进程随机 32 hex（同桌面端）
//   X-DeepAI-Code-Machine      ← sha256(小写原始 UUID)，每日免费额度的分配键
//
// 额外坑：无效 Key 会 302 到登录页 → 所有请求都要 redirect: "error"。

import { fetchJson, HttpError } from "./http.mjs";
import {
  DEFAULT_BASE_ORIGIN,
  DEFAULT_LANE_VERSION,
  HEADER_INSTANCE,
  HEADER_KEY,
  HEADER_LANE,
  HEADER_MACHINE,
  INSTANCE_ID,
  LANE_PROBE_SEQUENCE,
  USER_AGENT,
} from "./constants.mjs";
import { machineFingerprint, newMachineUuid } from "./machine.mjs";
import { parseResetTime, trimSlash } from "./util.mjs";

export function directOrigin(origin) {
  return trimSlash(origin || DEFAULT_BASE_ORIGIN);
}

/** 直连模式的基地址：magpie 会再拼 /chat/completions 或 /responses。 */
export function directBase(origin) {
  return `${directOrigin(origin)}/deepai_code`;
}

/** 上游请求头（不伪造桌面端 UA，也不带 Authorization）。 */
export function directHeaders({ key = "", machineFp = "", laneVersion = DEFAULT_LANE_VERSION } = {}) {
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (INSTANCE_ID) headers[HEADER_INSTANCE] = INSTANCE_ID;
  if (key) headers[HEADER_KEY] = String(key);
  headers[HEADER_LANE] = String(laneVersion || DEFAULT_LANE_VERSION);
  if (machineFp) headers[HEADER_MACHINE] = String(machineFp);
  return headers;
}

/**
 * 车道版本解析（laneVersion: "auto" 时探测 /models，免鉴权、无签到副作用）。
 *
 * 显式值原样返回、不探测；auto 按 LANE_PROBE_SEQUENCE 依次试，取第一个 200 的值，
 * 每个 origin 进程内只探测一次（缓存 Promise）。探测失败（网络抖动等）退回默认车道，
 * 让真正的业务请求再去暴露问题。
 *
 * machineFp 可选：调用方有账号指纹时传进来，/models 与业务请求保持一致；
 * 不传时用进程内随机指纹（单测 / 独立调用），不读取真实设备标识。
 */
const laneCache = new Map();
const PROBE_MACHINE_FP = machineFingerprint(newMachineUuid());

export function resolveLaneVersion(origin, { explicit, fetchImpl, machineFp = "" } = {}) {
  const value = String(explicit ?? "auto").trim();
  if (value && value.toLowerCase() !== "auto") return Promise.resolve(value);

  const key = directOrigin(origin);
  if (!laneCache.has(key)) {
    laneCache.set(key, probeLane(key, fetchImpl, machineFp));
  }
  return laneCache.get(key);
}

async function probeLane(origin, fetchImpl, machineFp = "") {
  const fp = String(machineFp ?? "").trim() || PROBE_MACHINE_FP;
  for (const lane of LANE_PROBE_SEQUENCE) {
    try {
      await getDirectModels(origin, { machineFp: fp, laneVersion: lane, fetchImpl });
      return lane;
    } catch (err) {
      if (err instanceof HttpError && err.status === 426) continue;
      return DEFAULT_LANE_VERSION;
    }
  }
  return DEFAULT_LANE_VERSION;
}

/** GET /deepai_code/models（免鉴权；只需要车道头与机器指纹）。 */
export async function getDirectModels(
  origin,
  { machineFp = "", laneVersion = DEFAULT_LANE_VERSION, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {},
) {
  return fetchJson(`${directBase(origin)}/models`, {
    fetchImpl,
    headers: directHeaders({ machineFp, laneVersion }),
    timeoutMs,
  });
}

/** GET /deepai_code/theos → 账号的免费额度/余额（balance/granted 是字符串）。 */
export async function getTheos(
  origin,
  { key, machineFp = "", laneVersion = DEFAULT_LANE_VERSION, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {},
) {
  return fetchJson(`${directBase(origin)}/theos`, {
    fetchImpl,
    headers: directHeaders({ key, machineFp, laneVersion }),
    timeoutMs,
  });
}

/** GET /get_usage_summary（根路径，不在 /deepai_code 下）。 */
export async function getUsageSummary(
  origin,
  { key, machineFp = "", laneVersion = DEFAULT_LANE_VERSION, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {},
) {
  const headers = directHeaders({ key, machineFp, laneVersion });
  // 参考实现查用量时用 UA "DeepAI-Code"；我们保持自己的可辨识 UA，避免冒充桌面端。
  return fetchJson(`${directOrigin(origin)}/get_usage_summary`, { fetchImpl, headers, timeoutMs });
}

/** 归一化 /theos 响应。 */
export function normalizeAllowance(payload = {}) {
  return {
    enabled: Boolean(payload?.enabled),
    balance: String(payload?.balance ?? ""),
    granted: String(payload?.granted ?? ""),
    refreshAt: parseResetTime(payload?.refresh_at),
    rawRefreshAt: payload?.refresh_at ?? "",
    laneVersion: payload?.lane_version ?? null,
  };
}

/**
 * 用桌面端登录回调里的 code 换 API Key。
 * 响应：{api_key, username, is_pro}。
 */
export async function exchangeCode(
  origin,
  code,
  { fetchImpl = globalThis.fetch, timeoutMs = 45_000 } = {},
) {
  const value = String(code ?? "").trim();
  if (!value) throw new Error("empty-code");
  const payload = await fetchJson(`${directBase(origin)}/desktop_auth/exchange/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: { code: value },
    fetchImpl,
    timeoutMs,
  });
  const apiKey = String(payload?.api_key ?? "").trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error("invalid-exchange-response");
  return {
    apiKey,
    username: String(payload?.username ?? "").trim(),
    isPro: Boolean(payload?.is_pro),
  };
}
