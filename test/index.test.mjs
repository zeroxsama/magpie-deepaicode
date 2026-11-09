// 入口冒烟测试：magpie 会按 main 直接加载 index.mjs，
// 这里把“入口能否被导入、钩子形状是否正确”纳入单测，避免相对路径这类低级故障。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeepAICodePlugin, _internal, resolveOptions } from "../index.mjs";

const MACHINE_STORE = join(mkdtempSync(join(tmpdir(), "deepaicode-index-store-")), "machines.json");

test("入口可导入，且只导出插件函数 + _internal", () => {
  assert.equal(typeof DeepAICodePlugin, "function");
  assert.equal(typeof _internal, "object");
  for (const value of Object.values(_internal)) {
    assert.ok(["function", "string", "number", "object"].includes(typeof value));
  }
});

test("插件返回的钩子形状", async () => {
  const hooks = await DeepAICodePlugin({ magpie: { options: {} } }, {});
  assert.deepEqual(
    Object.keys(hooks).sort(),
    ["auth", "chat.headers", "config", "provider"].sort(),
  );
  assert.equal(hooks.auth.provider, "deepaicode");
  assert.equal(hooks.auth.methods.length, 3);
  assert.equal(typeof hooks.auth.loader, "function");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.auth.checkin, "function");
  assert.equal(hooks.provider.id, "deepaicode");
  assert.equal(typeof hooks.provider.models, "function");
});

test("config 钩子：不覆盖已有供应商，且默认模型齐全", async () => {
  const hooks = await DeepAICodePlugin({ magpie: { options: {} } }, {});
  const cfg = { provider: { deepaicode: { name: "Custom" } } };
  await hooks.config(cfg);
  assert.equal(cfg.provider.deepaicode.name, "Custom", "??= 不应覆盖用户配置");

  const fresh = {};
  await hooks.config(fresh);
  assert.equal(fresh.provider.deepaicode.name, "DeepAI Code");
  assert.equal(fresh.provider.deepaicode.npm, "@ai-sdk/openai-compatible");
  assert.equal(fresh.provider.deepaicode.api, "https://api.deepai.org/deepai_code");
  assert.equal(fresh.provider.deepaicode.models["glm-5.3-flash"].provider, undefined);
  assert.equal(Object.keys(fresh.provider.deepaicode.models).length, 18);
  assert.equal(fresh.provider.deepaicode.models["gpt-6-astra"].provider.npm, "@ai-sdk/openai");
});

test("chat.headers：只给本供应商加会话粘性", async () => {
  const hooks = await DeepAICodePlugin({ magpie: { options: {} } }, {});
  const output = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "deepaicode" }, sessionID: "s-1" }, output);
  assert.equal(output.headers["X-Session-Affinity"], "s-1");

  const other = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "openai" }, sessionID: "s-1" }, other);
  assert.deepEqual(other.headers, {});
});

test("usage：成功结果进程内缓存，重复调用不打上游", async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith("/theos")) {
      return new Response(JSON.stringify({ enabled: true, balance: "200.00000", granted: "200.00000" }), { status: 200 });
    }
    return new Response(JSON.stringify({ plan: "Free", credits_remaining: 0 }), { status: 200 });
  };
  try {
    const hooks = await DeepAICodePlugin({ magpie: { options: { laneVersion: "4", machineStore: MACHINE_STORE } } }, {});
    const getAuth = async () => ({ type: "api", key: "k", accountId: "acc-ok", metadata: { mode: "direct" } });
    const a = await hooks.auth.usage(getAuth);
    const b = await hooks.auth.usage(getAuth);
    assert.equal(calls, 2, "首次 2 个请求（theos + summary），第二次走缓存");
    assert.equal(a.windows[0].limit, 200);
    assert.deepEqual(a, b);
  } finally {
    globalThis.fetch = real;
  }
});

test("usage：403 签到上限 → 中性展示 + 进程内长缓存，不再打上游", async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { message: "DeepAI Code has restarted its check-in too many times today. Try again tomorrow." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const hooks = await DeepAICodePlugin({ magpie: { options: { laneVersion: "4", machineStore: MACHINE_STORE } } }, {});
    const getAuth = async () => ({ type: "api", key: "k", accountId: "acc-locked", metadata: { mode: "direct" } });
    const a = await hooks.auth.usage(getAuth);
    const b = await hooks.auth.usage(getAuth);
    assert.equal(calls, 2, "锁定后不再重复请求（首次 theos + summary 各一）");
    assert.equal(a.error, undefined, "不应显示红色报错");
    assert.match(a.windows[0].display, /明日恢复/);
    assert.deepEqual(a, b);
    // checkin 也走同一把锁
    const c = await hooks.auth.checkin(getAuth);
    assert.equal(calls, 2, "锁定期间 checkin 不发请求");
    assert.equal(c.outcome, "ineligible");
    assert.match(c.message, /明日自动恢复/);
  } finally {
    globalThis.fetch = real;
  }
});

test("resolveOptions：magpie options 与显式参数合并、类型收敛", () => {
  const opts = resolveOptions(
    { magpie: { options: { laneVersion: " 3 ", baseOrigin: " https://api.deepai.org/ " } } },
    { lang: "en" },
  );
  assert.equal(opts.laneVersion, "3");
  assert.equal(opts.baseOrigin, "https://api.deepai.org/", "尾斜杠由 resolveAccountSettings 归一");
  assert.equal(opts.lang, "en");
  const defaults = resolveOptions({}, {});
  assert.equal(defaults.baseOrigin, "https://api.deepai.org");
  assert.equal(defaults.laneVersion, "auto");
  assert.equal(defaults.machineStore, "");
  assert.equal(defaults.debug, false);
});
