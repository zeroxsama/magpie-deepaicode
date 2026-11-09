import test from "node:test";
import assert from "node:assert/strict";

import {
  directBase,
  directHeaders,
  exchangeCode,
  getDirectModels,
  getTheos,
  normalizeAllowance,
  resolveLaneVersion,
} from "../src/direct.mjs";
import { DEFAULT_LANE_VERSION, VERSION } from "../src/constants.mjs";
import { buildDirectCheckin, buildDirectUsage } from "../src/usage.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("directBase / directHeaders：显式 UA、Api-Key 而不是 Authorization", () => {
  assert.equal(directBase("https://api.deepai.org/"), "https://api.deepai.org/deepai_code");
  const headers = directHeaders({ key: "k", machineFp: "fp", laneVersion: "4" });
  assert.equal(headers["User-Agent"], `magpie-deepaicode/${VERSION}`);
  assert.equal(headers["Api-Key"], "k");
  assert.equal(headers["X-DeepAI-Code-Theos"], "4");
  assert.match(headers["X-DeepAI-Code-Instance"], /^[0-9a-f]{32}$/);
  assert.equal(headers["X-DeepAI-Code-Machine"], "fp");
  assert.equal(headers.Authorization, undefined);
  // 同一进程内实例 id 稳定
  assert.equal(directHeaders({})["X-DeepAI-Code-Instance"], headers["X-DeepAI-Code-Instance"]);
});

test("resolveLaneVersion：显式值直接返回、不探测", async () => {
  let called = 0;
  const lane = await resolveLaneVersion("https://lane-explicit.test", {
    explicit: "4",
    fetchImpl: async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(lane, "4");
  assert.equal(called, 0);
});

test("resolveLaneVersion：auto 按序列探测并缓存（同 origin 只探一次）", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers["X-DeepAI-Code-Theos"]);
    // lane 4 拒绝、lane 5 受理 —— 模拟上游升级
    if (init.headers["X-DeepAI-Code-Theos"] === "5") {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    return new Response('{"error":{"code":"lane_version_unsupported"}}', { status: 426 });
  };
  const origin = "https://lane-auto.test";
  assert.equal(await resolveLaneVersion(origin, { fetchImpl }), "5");
  assert.equal(await resolveLaneVersion(origin, { fetchImpl }), "5", "第二次应命中缓存");
  assert.deepEqual(seen, ["4", "5"]);
});

test("resolveLaneVersion：machineFp 透传给 /models", async () => {
  let captured = "";
  const lane = await resolveLaneVersion("https://lane-fp.test", {
    machineFp: "account-fp",
    fetchImpl: async (url, init) => {
      captured = init.headers["X-DeepAI-Code-Machine"];
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    },
  });
  assert.equal(lane, "4");
  assert.equal(captured, "account-fp");
});

test("resolveLaneVersion：探测网络错误时退回默认车道", async () => {
  const lane = await resolveLaneVersion("https://lane-error.test", {
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(lane, DEFAULT_LANE_VERSION);
});

test("resolveLaneVersion：序列耗尽仍 426 时退回默认车道", async () => {
  const lane = await resolveLaneVersion("https://lane-all426.test", {
    fetchImpl: async () => new Response('{"error":{"code":"lane_version_unsupported"}}', { status: 426 }),
  });
  assert.equal(lane, DEFAULT_LANE_VERSION);
});

test("getDirectModels：免鉴权，只带车道与机器指纹", async () => {
  let captured = null;
  await getDirectModels("https://api.deepai.org", {
    machineFp: "fp",
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers };
      return jsonResponse({ models: [] });
    },
  });
  assert.equal(captured.url, "https://api.deepai.org/deepai_code/models");
  assert.equal(captured.headers["Api-Key"], undefined);
  assert.equal(captured.headers["X-DeepAI-Code-Machine"], "fp");
});

test("getTheos：URL 与头正确", async () => {
  let captured = null;
  await getTheos("https://api.deepai.org", {
    key: "k",
    machineFp: "fp",
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers };
      return jsonResponse({ enabled: true, balance: "200.00000", granted: "200.00000" });
    },
  });
  assert.equal(captured.url, "https://api.deepai.org/deepai_code/theos");
  assert.equal(captured.headers["Api-Key"], "k");
});

test("normalizeAllowance：字符串数值与 refresh_at 归一化", () => {
  const a = normalizeAllowance({ enabled: true, balance: "200.00000", granted: "200.00000", refresh_at: "2026-11-07T04:03:03Z" });
  assert.equal(a.balance, "200.00000");
  assert.equal(a.granted, "200.00000");
  assert.equal(a.refreshAt, "2026-11-07T04:03:03.000Z");
  assert.equal(a.rawRefreshAt, "2026-11-07T04:03:03Z");

  const b = normalizeAllowance({ enabled: false, balance: "0", granted: "0", refresh_at: 1794000000 });
  assert.equal(b.refreshAt, new Date(1794000000 * 1000).toISOString());
  assert.equal(b.enabled, false);
});

test("buildDirectUsage：正常额度 / 未发放", () => {
  const usage = buildDirectUsage({
    allowance: normalizeAllowance({ enabled: true, balance: "200.00000", granted: "200.00000", refresh_at: "2026-11-07T04:03:03Z" }),
    summary: { plan: "Free", credits_remaining: 12.4 },
    username: "ada",
  });
  assert.equal(usage.plan, "Free");
  assert.equal(usage.user, "ada");
  // amount 是“已用量”（granted - balance），不是剩余：200/200 即已用 0
  assert.equal(usage.windows[0].amount, 0);
  assert.equal(usage.windows[0].limit, 200);
  assert.ok(usage.balance.includes("12.4"));

  const pending = buildDirectUsage({
    allowance: normalizeAllowance({ enabled: true, balance: "0.00000", granted: "0.00000" }),
    summary: null,
  });
  assert.equal(pending.windows[0].amount, undefined);
  assert.equal(pending.windows[0].limit, undefined);

  // 额度用完：已用 = 总额度
  const spent = buildDirectUsage({
    allowance: normalizeAllowance({ enabled: true, balance: "0.00000", granted: "200.00000" }),
    summary: null,
  });
  assert.equal(spent.windows[0].amount, 200);
  assert.equal(spent.windows[0].limit, 200);
});

test("buildDirectCheckin：四分支", () => {
  const base = { enabled: true, balance: "200", granted: "200", rawRefreshAt: "2026-11-07T04:03:03Z" };
  assert.equal(buildDirectCheckin({ allowance: base, prevRefreshAt: "" }).outcome, "claimed");
  assert.equal(buildDirectCheckin({ allowance: base, prevRefreshAt: "2026-11-07T04:03:03Z" }).outcome, "done");
  assert.equal(
    buildDirectCheckin({ allowance: base, prevRefreshAt: "2026-11-06T04:03:03Z" }).outcome,
    "claimed",
  );
  assert.equal(
    buildDirectCheckin({ allowance: { ...base, granted: "0" } }).outcome,
    "failed",
  );
  assert.equal(
    buildDirectCheckin({ allowance: { ...base, enabled: false } }).outcome,
    "ineligible",
  );
  assert.equal(buildDirectCheckin({ allowance: null }).outcome, "failed");
});

test("exchangeCode：成功与坏响应", async () => {
  let captured = null;
  const cred = await exchangeCode("https://api.deepai.org", "abc", {
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return jsonResponse({ api_key: "fake-deepai-key-0001", username: "ada", is_pro: false });
    },
  });
  assert.equal(captured.url, "https://api.deepai.org/deepai_code/desktop_auth/exchange/");
  assert.deepEqual(captured.body, { code: "abc" });
  assert.equal(cred.username, "ada");

  await assert.rejects(
    exchangeCode("https://api.deepai.org", "abc", { fetchImpl: async () => jsonResponse({}) }),
    /invalid-exchange-response/,
  );
  await assert.rejects(exchangeCode("https://api.deepai.org", "  ", { fetchImpl: async () => jsonResponse({}) }), /empty-code/);
});
