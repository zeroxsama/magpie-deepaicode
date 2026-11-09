// 推理请求链路：loader 的 fetch。
//
// magpie 的网关已经把任意 Agent 协议转成了 Chat Completions / Responses，
// 并决定基地址（loader.baseURL）。插件要做的只有五件事：
//   1. 注入上游要求的头（UA / Api-Key / Theos 车道 / 实例 id / 机器指纹）；
//   2. 把路径归一到目标端点（不依赖 magpie 拼接行为的“保险丝”）；
//   3. 整形请求体（上游校验“请求必须像桌面端发出的”，缺 system/instructions 时补最简值）；
//   4. 错误语义映射（409 → 429、403 email_unverified → 标记登录失效、302 → 401）；
//   5. 原样流式透传（不缓冲，不改内容）。

import {
  DEFAULT_LANE_VERSION,
  HEADER_AFFINITY,
  HEADER_LANE,
  HEADER_MACHINE,
  RETRY_AFTER_CAP_S,
  SHAPE_SYSTEM_MESSAGE,
} from "./constants.mjs";
import { directBase, directHeaders, resolveLaneVersion } from "./direct.mjs";
import { t, resolveLang } from "./i18n.mjs";
import { resolveAccountSettings } from "./modes.mjs";

const CHAT_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";

/** 目标基地址（magpie 会拼 /chat/completions 或 /responses，但我们自己重写）。 */
export function loaderTargets(settings) {
  return { baseURL: directBase(settings.origin), chatSuffix: CHAT_SUFFIX, responsesSuffix: RESPONSES_SUFFIX };
}

/**
 * 把 magpie 给的 URL 归一到目标端点。
 *
 * magpie 传给插件时通常已是 {baseURL}/chat/completions；但不同版本/不同 npm 包
 * 的拼接方式不一定一致（也可能重复带 /deepai_code）。这里只认路径尾巴：
 *   .../responses  → Responses 端点
 *   其它           → Chat Completions 端点
 * 查询串原样保留（例如 ?alt=sse）。
 */
export function normalizeIncomingUrl(input, settings) {
  const raw = typeof input === "string" ? input : input?.url ?? String(input ?? "");
  let pathname = "";
  let search = "";
  try {
    const url = new URL(raw);
    pathname = url.pathname;
    search = url.search;
  } catch {
    pathname = raw;
  }
  const suffix = /\/responses\s*$/i.test(pathname) ? RESPONSES_SUFFIX : CHAT_SUFFIX;
  const base = loaderTargets(settings).baseURL;
  return `${base}${suffix}${search}`;
}

/** 每个请求要带的头（其余交给 magpie 的 init.headers）。 */
export function modeHeaders(settings) {
  return directHeaders({
    key: settings.key,
    machineFp: settings.machineFp,
    laneVersion: settings.laneVersion === "auto" ? DEFAULT_LANE_VERSION : settings.laneVersion,
  });
}

/**
 * 上游 2026-11-07 起校验“请求必须是 DeepAI Code 发出的样子”：
 * chat/completions 的 messages 首条必须是 system（或 developer），
 * responses 必须带非空 instructions；缺失时上游回
 * 400 "This request is not one DeepAI Code sends."。
 * 只在缺的时候补一条最简 system / instructions，不改已有内容。
 * 返回重写后的 JSON 字符串；没动返回 null。
 */
export function shapeRequestBody(target, body) {
  if (typeof body !== "string" || body.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let changed = false;
  if (target.endsWith(CHAT_SUFFIX) && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    const first = parsed.messages[0];
    const role = first && typeof first === "object" ? String(first.role ?? "") : "";
    if (role !== "system" && role !== "developer") {
      parsed.messages = [{ role: "system", content: SHAPE_SYSTEM_MESSAGE }, ...parsed.messages];
      changed = true;
    }
  } else if (target.endsWith(RESPONSES_SUFFIX)) {
    if (typeof parsed.instructions !== "string" || parsed.instructions.trim() === "") {
      parsed.instructions = SHAPE_SYSTEM_MESSAGE;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

function clampRetryAfter(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const secs = Number(String(raw).trim());
  if (!Number.isFinite(secs) || secs <= 0) return;
  if (secs > RETRY_AFTER_CAP_S) headers.set("retry-after", String(RETRY_AFTER_CAP_S));
}

/** 重建响应：改状态/加头时必须去掉与会话体相关的长度与编码头。 */
function rebuildResponse(res, { status = res.status, body = null, extraHeaders = {} } = {}) {
  const headers = new Headers(res.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  clampRetryAfter(headers);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(body, { status, statusText: res.statusText || "", headers });
}

function jsonError(status, message, type = "invalid_request_error") {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 错误语义映射（见 PROTOCOL.md）。
 * 只在非 2xx 时调用；2xx 一律原样返回（流式体不碰）。
 */
export async function guardResponse(res) {
  // 容量拒绝：magpie 只对 429/5xx 做账号故障转移，409（session_busy）会直接落到 agent。
  if (res.status === 409) {
    const body = await res.text();
    return rebuildResponse(res, { status: 429, body });
  }

  if (res.status === 403) {
    const body = await res.text();
    const unverified = /email_unverified|邮箱未验证/i.test(body);
    return rebuildResponse(res, {
      body,
      extraHeaders: unverified ? { "X-Magpie-Sign-In": "expired" } : {},
    });
  }

  return res;
}

/**
 * 构造 loader。
 *
 * 本函数只做“准备”，真正的请求在 loader.fetch 里发。
 * 所有请求的 URL 都从配置的基地址重建，凭据只可能发往配置的上游。
 */
export function createLoader(auth, options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const settings = resolveAccountSettings(auth, options);
  const targets = loaderTargets(settings);
  const headers = modeHeaders(settings);
  const lang = resolveLang(options);
  // laneVersion: "auto" 时这里会发起探测（每 origin 进程内一次）；显式值直接兑现
  const laneP = resolveLaneVersion(settings.origin, { explicit: settings.laneVersion, fetchImpl, machineFp: settings.machineFp });

  const loader = {
    baseURL: targets.baseURL,
    // 直连上游只认 Api-Key 头，这里不设置 apiKey，避免多带一个 Authorization。
    headers,
    async fetch(input, init = {}) {
      // URL 一律从配置的基地址重建：magpie 传进来的主机/路径只用来判断
      // 是 chat 还是 responses，凭据永远不会被发往别的主机。
      const target = normalizeIncomingUrl(input, settings);
      const lane = await laneP;

      const merged = new Headers(init?.headers ?? {});
      for (const [key, value] of Object.entries(headers)) merged.set(key, value);
      merged.set(HEADER_LANE, lane);
      if (settings.machineFp) {
        merged.set(HEADER_MACHINE, settings.machineFp);
      }

      // 上游校验请求形状：缺 system / instructions 时补最简值
      const shaped = shapeRequestBody(target, init?.body);
      const outgoing = shaped === null ? init : { ...init, body: shaped };

      let res;
      try {
        res = await fetchImpl(target, {
          ...outgoing,
          headers: merged,
          redirect: "error", // 无效 Key 会 302 到登录页：绝不跟随
        });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        const msg = String(err?.message ?? err);
        if (/redirect/i.test(msg)) return jsonError(401, t(lang, "errRedirect"));
        throw err; // 交给 magpie 的故障转移
      }

      return guardResponse(res);
    },
  };

  return loader;
}

/** chat.headers 钩子用：给请求带上会话粘性。 */
export function sessionAffinityHeaders(sessionId) {
  const value = String(sessionId ?? "").trim();
  return value ? { [HEADER_AFFINITY]: value } : {};
}
