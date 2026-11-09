import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERSION } from "../src/constants.mjs";
import { createLoader, guardResponse, normalizeIncomingUrl, shapeRequestBody } from "../src/fetch.mjs";
import { machineFingerprint } from "../src/machine.mjs";
import { resolveAccountSettings } from "../src/modes.mjs";

const CHAT = "/chat/completions";
const FAKE_KEY = "fake-deepai-key-0001";
const OTHER_KEY = "bbbbbbbb-2222-4333-8444-555555555555";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MACHINE_STORE = join(mkdtempSync(join(tmpdir(), "deepaicode-fetch-store-")), "machines.json");

function directAuth(options = {}) {
  return { type: "api", key: FAKE_KEY, metadata: { mode: "direct", ...options } };
}

// 测试里显式给 lane，避免触发 auto 探测；机器指纹写到临时文件，不碰真实 home
const LANE_OPTS = { laneVersion: "4", machineStore: MACHINE_STORE };

test("normalizeIncomingUrl：直连模式归一到 /deepai_code/{chat,responses}", () => {
  const settings = resolveAccountSettings(directAuth(), { baseOrigin: "https://api.deepai.org", ...LANE_OPTS });
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/deepai_code" + CHAT, settings),
    "https://api.deepai.org/deepai_code" + CHAT,
  );
  // 重复的 /deepai_code（不同版本拼接行为不同的保险丝）
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/deepai_code/deepai_code" + CHAT, settings),
    "https://api.deepai.org/deepai_code" + CHAT,
  );
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/responses?beta=1", settings),
    "https://api.deepai.org/deepai_code/responses?beta=1",
  );
});

test("createLoader：直连头含 UA / Api-Key / 车道 / 实例 id / 机器指纹", () => {
  const direct = createLoader(directAuth(), { ...LANE_OPTS });
  assert.equal(direct.baseURL, "https://api.deepai.org/deepai_code");
  assert.equal(direct.apiKey, undefined);
  assert.equal(direct.headers["Api-Key"], directAuth().key);
  assert.equal(direct.headers["X-DeepAI-Code-Theos"], "4");
  assert.equal(direct.headers["User-Agent"], `magpie-deepaicode/${VERSION}`);
  assert.match(direct.headers["X-DeepAI-Code-Instance"], /^[0-9a-f]{32}$/);
  assert.ok(direct.headers["X-DeepAI-Code-Machine"]);
  assert.equal(direct.headers.Authorization, undefined);
});

test("createLoader：每个账号独立机器指纹，同账号稳定", () => {
  const a1 = resolveAccountSettings(directAuth(), LANE_OPTS);
  const a2 = resolveAccountSettings(directAuth(), LANE_OPTS);
  const b = resolveAccountSettings({ ...directAuth(), key: OTHER_KEY }, LANE_OPTS);

  assert.match(a1.machineId, UUID_V4);
  assert.equal(a1.machineFp, a2.machineFp, "同一账号必须稳定");
  assert.notEqual(a1.machineFp, b.machineFp, "不同账号必须不同");
  assert.equal(a1.machineFp, machineFingerprint(a1.machineId));

  const loaderA = createLoader(directAuth(), LANE_OPTS);
  const loaderB = createLoader({ ...directAuth(), key: OTHER_KEY }, LANE_OPTS);
  assert.equal(loaderA.headers["X-DeepAI-Code-Machine"], a1.machineFp);
  assert.equal(loaderB.headers["X-DeepAI-Code-Machine"], b.machineFp);
});

test("loader.fetch：直连注入 Api-Key / 车道 / 机器指纹", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers };
      return new Response("{}", { status: 200 });
    },
  });
  await loader.fetch("https://api.deepai.org/deepai_code/responses", { method: "POST" });
  assert.equal(captured.url, "https://api.deepai.org/deepai_code/responses");
  assert.equal(captured.headers.get("api-key"), directAuth().key);
  assert.equal(captured.headers.get("x-deepai-code-theos"), "4");
  assert.equal(captured.headers.get("authorization"), null);
  assert.ok(captured.headers.get("x-deepai-code-machine"));
});

test("loader.fetch：目标 URL 一律从配置基地址重建（凭据不发往外域）", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { baseOrigin: "https://api.deepai.org", ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers, redirect: init.redirect };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await loader.fetch("https://evil.example.com/v1" + CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(captured.url, "https://api.deepai.org/deepai_code" + CHAT);
  assert.equal(captured.headers.get("api-key"), directAuth().key);
  assert.equal(captured.redirect, "error");
});

test("loader.fetch：messages 缺 system 时自动补最简 system", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, body: init.body };
      return new Response("{}", { status: 200 });
    },
  });
  const body = JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
  await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST", body });

  const sent = JSON.parse(captured.body);
  assert.equal(sent.messages[0].role, "system");
  assert.ok(sent.messages[0].content.length > 0);
  assert.equal(sent.messages[1].role, "user");
  assert.equal(sent.messages[1].content, "hi");
});

test("loader.fetch：已有 system 时原样透传", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { body: init.body };
      return new Response("{}", { status: 200 });
    },
  });
  const body = JSON.stringify({ messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] });
  await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST", body });
  assert.equal(captured.body, body, "不应改动请求体");
});

test("shapeRequestBody：chat / responses / 非 JSON 的分支", () => {
  // chat 缺 system → 补
  const chat = shapeRequestBody(
    "https://x/deepai_code" + CHAT,
    JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  );
  const chatParsed = JSON.parse(chat);
  assert.equal(chatParsed.messages[0].role, "system");
  assert.equal(chatParsed.messages[1].content, "hi");

  // developer 开头也算合格
  assert.equal(
    shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [{ role: "developer", content: "x" }] })),
    null,
  );
  // 已有 system → 不动
  assert.equal(
    shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [{ role: "system", content: "x" }] })),
    null,
  );
  // 空 messages → 不动（上游的校验对象是“有内容的首条”）
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [] })), null);
  // responses 缺 instructions → 补
  const resp = shapeRequestBody("https://x/deepai_code/responses", JSON.stringify({ model: "gpt-6-astra", input: [] }));
  assert.ok(JSON.parse(resp).instructions.length > 0);
  // responses 已有 instructions → 不动
  assert.equal(
    shapeRequestBody("https://x/deepai_code/responses", JSON.stringify({ instructions: "x" })),
    null,
  );
  // 非 JSON / 非 POST 体 → 不动
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, "not-json"), null);
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, ""), null);
});

test("guardResponse：409 session_busy → 429，Retry-After 夹到 30s", async () => {
  const res = await guardResponse(
    new Response('{"error":{"code":"session_busy"}}', {
      status: 409,
      headers: { "content-type": "application/json", "retry-after": "120" },
    }),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.match(await res.text(), /session_busy/);
});

test("guardResponse：403 email_unverified 标记登录失效", async () => {
  const res = await guardResponse(
    new Response('{"error":{"code":"email_unverified"}}', {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});

test("loader.fetch：302（redirect:error）→ 401 且文案可读", async () => {
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed: unexpected redirect");
    },
  });
  const res = await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST" });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error.message.length > 0);
});
