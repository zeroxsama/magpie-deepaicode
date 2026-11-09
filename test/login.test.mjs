import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMethods } from "../src/login.mjs";
import { createLoader } from "../src/fetch.mjs";
import { machineFingerprint } from "../src/machine.mjs";

const KEY = "fake-deepai-key-0001";
const KEY_B = "bbbbbbbb-2222-4333-8444-555555555555";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MACHINE_STORE = join(mkdtempSync(join(tmpdir(), "deepaicode-login-store-")), "machines.json");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("createMethods：三路（浏览器推荐在前）", () => {
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl: async () => json({}) } });
  assert.equal(methods.length, 3);
  assert.deepEqual(methods.map((m) => m.type), ["oauth", "api", "api"]);
  assert.match(methods[0].label, /推荐/);
  assert.match(methods[1].label, /凭据/);
  assert.match(methods[2].label, /Key/);
});

test("桌面端登录：读文件 + /theos 验活", async () => {
  const base = mkdtempSync(join(tmpdir(), "deepaicode-login-"));
  mkdirSync(join(base, "userdata", "secrets"), { recursive: true });
  writeFileSync(
    join(base, "userdata", "secrets", "deepai-account.bin"),
    JSON.stringify({ apiKey: KEY, username: "ada", isPro: false }),
    "utf8",
  );

  const old = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = base;
  try {
    let theosHeaders = null;
    const fetchImpl = async (url, init) => {
      if (url.endsWith("/theos")) {
        theosHeaders = init.headers;
        return json({ enabled: true, balance: "200.00000", granted: "200.00000" });
      }
      throw new Error(`unexpected ${url}`);
    };
    const methods = createMethods({ options: { lang: "zh", laneVersion: "4", machineStore: MACHINE_STORE }, deps: { fetchImpl } });
    const out = await methods[1].authorize({ dir: "", key: "", keyInputs: "" });
    assert.equal(out.type, "success");
    assert.equal(out.key, KEY);
    assert.equal(out.metadata.mode, "direct");
    assert.equal(out.metadata.source, "desktop");
    assert.equal(out.metadata.username, "ada");
    assert.match(out.metadata.machineId, UUID_V4, "登录时应为账号生成独立机器指纹");
    assert.equal(
      theosHeaders["X-DeepAI-Code-Machine"],
      machineFingerprint(out.metadata.machineId),
      "验活请求必须带该账号的指纹",
    );
    assert.match(out.accountId, /^deepai:/);
  } finally {
    if (old === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = old;
    rmSync(base, { recursive: true, force: true });
  }
});

test("桌面端登录：找不到凭据时列出尝试过的路径", async () => {
  const methods = createMethods({
    options: { lang: "zh", secretDir: "C:\\definitely-missing" },
    deps: { fetchImpl: async () => json({}) },
  });
  const out = await methods[1].authorize({ dir: "C:\\definitely-missing" });
  assert.equal(out.type, "failed");
  assert.match(out.error, /没有找到桌面端凭据/);
});

test("粘贴登录：缺 Key 失败；有 Key 成功", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/theos")) return json({ enabled: true, balance: "200", granted: "200" });
    throw new Error(`unexpected ${url}`);
  };
  const methods = createMethods({ options: { lang: "zh", laneVersion: "4", machineStore: MACHINE_STORE }, deps: { fetchImpl } });

  const missing = await methods[2].authorize({});
  assert.equal(missing.type, "failed");
  assert.match(missing.error, /缺少 DeepAI API Key/);

  const ok = await methods[2].authorize({ key: KEY, username: "ada" });
  assert.equal(ok.type, "success");
  assert.equal(ok.key, KEY);
  assert.equal(ok.metadata.username, "ada");
  assert.match(ok.metadata.machineId, UUID_V4);
});

test("每号机器指纹：同 Key 重登复用，不同 Key 各自一份", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/theos")) return json({ enabled: true, balance: "200", granted: "200" });
    throw new Error(`unexpected ${url}`);
  };
  const options = { lang: "zh", laneVersion: "4", machineStore: MACHINE_STORE };
  const first = await createMethods({ options, deps: { fetchImpl } })[2].authorize({ key: KEY, username: "ada" });
  const again = await createMethods({ options, deps: { fetchImpl } })[2].authorize({ key: KEY, username: "ada" });
  const other = await createMethods({ options, deps: { fetchImpl } })[2].authorize({ key: KEY_B, username: "bob" });

  assert.equal(first.metadata.machineId, again.metadata.machineId, "同一账号重登必须复用同一指纹");
  assert.notEqual(first.metadata.machineId, other.metadata.machineId, "不同账号必须不同指纹");
  assert.notEqual(first.accountId, other.accountId);
});

test("登录 → loader：/theos 与推理请求使用同一账号指纹", async () => {
  const options = { lang: "zh", laneVersion: "4", machineStore: MACHINE_STORE };
  let theosFp = "";
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/theos")) {
      theosFp = init.headers["X-DeepAI-Code-Machine"];
      return json({ enabled: true, balance: "200", granted: "200" });
    }
    throw new Error(`unexpected ${url}`);
  };
  const out = await createMethods({ options, deps: { fetchImpl } })[2].authorize({ key: KEY, username: "ada" });
  assert.equal(out.type, "success");
  assert.equal(theosFp, machineFingerprint(out.metadata.machineId));

  let chatFp = "";
  const loader = createLoader(
    { type: "api", key: out.key, accountId: out.accountId, metadata: out.metadata },
    options,
    {
      fetchImpl: async (url, init) => {
        chatFp = init.headers.get("x-deepai-code-machine");
        return new Response("{}", { status: 200 });
      },
    },
  );
  await loader.fetch("https://api.deepai.org/deepai_code/chat/completions", { method: "POST", body: "{}" });
  assert.equal(chatFp, theosFp, "验活与推理必须使用同一个指纹");
});

test("debug 日志只记字段名，绝不记录 Key 值", async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const fetchImpl = async (url) => {
      if (url.endsWith("/theos")) return json({ enabled: true, balance: "200", granted: "200" });
      throw new Error(`unexpected ${url}`);
    };
    const methods = createMethods({
      options: { lang: "zh", debug: true, laneVersion: "4", machineStore: MACHINE_STORE },
      deps: { fetchImpl },
    });
    await methods[2].authorize({ key: KEY, username: "ada" });
  } finally {
    console.error = original;
  }

  const all = lines.join("\n");
  assert.match(all, /fields present: .*key/);
  assert.ok(!all.includes(KEY), "日志不得包含 Key 明文");
});

test("浏览器登录：本地回调收到 code 后换 Key", async () => {
  const fetchImpl = async (url, init) => {
    if (url.includes("/desktop_auth/exchange/")) {
      assert.deepEqual(JSON.parse(init.body), { code: "the-code" });
      return json({ api_key: KEY, username: "ada", is_pro: false });
    }
    throw new Error(`unexpected ${url}`);
  };
  const methods = createMethods({ options: { lang: "zh", machineStore: MACHINE_STORE }, deps: { fetchImpl } });
  const method = methods[0];

  const authz = await method.authorize({}, {});
  assert.equal(authz.method, "auto");

  const loginUrl = new URL(authz.url);
  assert.equal(loginUrl.pathname, "/deepai_code/desktop_auth/");
  const state = loginUrl.searchParams.get("state");
  const port = Number(loginUrl.searchParams.get("port"));
  assert.ok(port > 0);
  assert.ok(state.length >= 16);

  const callback = await fetch(`http://127.0.0.1:${port}/auth-callback?code=the-code&state=${state}`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /登录完成|Signed in/);

  const out = await authz.callback();
  assert.equal(out.type, "success");
  assert.equal(out.key, KEY);
  assert.equal(out.metadata.source, "browser");
  assert.match(out.metadata.machineId, UUID_V4);
});

test("浏览器登录：state 不匹配时拒绝回调，取消后返回 failed", async () => {
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl: async () => json({}) } });
  const method = methods[0];
  const controller = new AbortController();
  const authz = await method.authorize({}, { signal: controller.signal });
  const loginUrl = new URL(authz.url);
  const port = Number(loginUrl.searchParams.get("port"));

  const callback = await fetch(`http://127.0.0.1:${port}/auth-callback?code=x&state=wrong`);
  assert.equal(callback.status, 400);

  controller.abort();
  const out = await authz.callback();
  assert.equal(out.type, "failed");
});
