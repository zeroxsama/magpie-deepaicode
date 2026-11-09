// 登录：三种方式（浏览器 + localhost 回调 / 桌面端凭据 / 粘贴 Key）。
//
// 关于 authorize(inputs)：inputs 里既可能有 prompts 的回答，也可能有 magpie
// 自己的 key 输入框内容。这里用 pickKey 兜住几种可能的字段名，取不到就按
// “没有输入 key”处理（桌面端凭据 / 浏览器登录本来就不需要用户填 key）。
//
// 调试日志只记录“哪些字段有值”，绝不打印字段内容（里面可能有 Key）。

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { DEFAULT_BASE_ORIGIN } from "./constants.mjs";
import { findDesktopCredentials } from "./credentials.mjs";
import { getTheos, exchangeCode, normalizeAllowance, resolveLaneVersion } from "./direct.mjs";
import { HttpError } from "./http.mjs";
import { resolveLang, t } from "./i18n.mjs";
import { machineFingerprint } from "./machine.mjs";
import { ensureAccountMachineId } from "./machine-store.mjs";
import { accountIdFor } from "./modes.mjs";
import { trimSlash } from "./util.mjs";

const VERIFY_TIMEOUT_MS = 15_000;
/** 浏览器登录等待回调的上限。 */
const CALLBACK_TIMEOUT_MS = 180_000;

function pickKey(inputs) {
  for (const name of ["key", "apiKey", "token", "secret", "api_key"]) {
    const value = inputs?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** debug 日志用：只列出有值的字段名，不泄露内容。 */
function inputShape(inputs) {
  const names = Object.entries(inputs ?? {})
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k]) => k);
  return names.length > 0 ? `fields present: ${names.join(", ")}` : "no input fields";
}

/**
 * 登录阶段确定账号身份与机器指纹。
 *
 * 与参考项目 DeepAICode2API 一致：先为这个号生成（或复用）随机机器 UUID，
 * 再用它的哈希去验活；登录成功后把原始 UUID 写进 auth.metadata.machineId。
 */
function loginMachine(options, key) {
  const accountId = accountIdFor({ key });
  const machineId = ensureAccountMachineId(accountId, { storePath: options.machineStore });
  return { accountId, machineId, machineFp: machineFingerprint(machineId) };
}

/** 直连模式的验活：/theos。只有鉴权类错误才判登录失败，网络抖动放行。 */
async function verifyDirectKey(origin, { key, machineFp, fetchImpl, lang, laneVersion }) {
  const lane = await resolveLaneVersion(origin, { explicit: laneVersion, fetchImpl, machineFp });
  try {
    const payload = await getTheos(origin, { key, machineFp, laneVersion: lane, fetchImpl, timeoutMs: VERIFY_TIMEOUT_MS });
    return { ok: true, allowance: normalizeAllowance(payload) };
  } catch (err) {
    if (err instanceof HttpError && [401, 403].includes(err.status)) {
      return { ok: false, error: t(lang, "errSignInExpired"), status: err.status };
    }
    // 426（车道版本）是插件选项问题，值得直接告诉用户
    if (err instanceof HttpError && err.status === 426) {
      return { ok: false, error: t(lang, "errLane"), status: 426 };
    }
    // 其它（超时 / 5xx / 网络）不拦登录：凭据留着，让请求阶段再暴露
    return { ok: true, transientError: String(err?.message ?? err) };
  }
}

function directSuccess({ cred, source, accountId, machineId = "" }) {
  return {
    type: "success",
    key: cred.apiKey,
    accountId,
    metadata: {
      mode: "direct",
      username: cred.username || "",
      source,
      ...(machineId ? { machineId } : {}),
    },
  };
}

/** ① 桌面端凭据（留空自动读取；也可以直接粘贴 Key）。 */
function desktopMethod({ options, lang, fetchImpl }) {
  return {
    type: "api",
    label: t(lang, "loginDesktop"),
    placeholder: "留空：自动读取 ~/.deepai-code/userdata/secrets/deepai-account.bin",
    prompts: [
      { type: "text", key: "dir", message: t(lang, "promptSecretDir"), placeholder: "~/.deepai-code" },
      { type: "password", key: "key", message: t(lang, "promptDesktopKey"), placeholder: "auto" },
    ],
    async authorize(inputs = {}) {
      if (options.debug) console.error(`[magpie-deepaicode] desktop ${inputShape(inputs)}`);

      let cred = null;
      const rawTyped = pickKey(inputs);
      const typedKey = /^(auto|read|读取)$/i.test(rawTyped) ? "" : rawTyped;

      if (typedKey) {
        cred = { apiKey: typedKey, username: "", isPro: false, path: "" };
      } else {
        const found = findDesktopCredentials({
          explicit: String(inputs.dir ?? "").trim() || String(options.secretDir ?? "").trim(),
        });
        if (!found.ok) {
          if (found.path) {
            return {
              type: "failed",
              error: t(lang, "errBadCredentials", { path: found.path, reason: found.reason }),
            };
          }
          return {
            type: "failed",
            error: t(lang, "errNoCredentials", { tried: found.tried.join(", ") }),
          };
        }
        cred = found.cred;
      }

      const machine = loginMachine(options, cred.apiKey);
      const verified = await verifyDirectKey(options.baseOrigin || DEFAULT_BASE_ORIGIN, {
        key: cred.apiKey,
        machineFp: machine.machineFp,
        fetchImpl,
        lang,
        laneVersion: options.laneVersion,
      });
      if (!verified.ok) return { type: "failed", error: verified.error };

      return directSuccess({
        cred,
        source: cred.path ? "desktop" : "manual",
        accountId: machine.accountId,
        machineId: machine.machineId,
      });
    },
  };
}

/** ② 粘贴 Key（显式提问，保证一定能拿到值）。 */
function pasteMethod({ options, lang, fetchImpl }) {
  return {
    type: "api",
    label: t(lang, "loginPaste"),
    placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    prompts: [
      { type: "password", key: "key", message: t(lang, "promptApiKey") },
      { type: "text", key: "username", message: t(lang, "promptUsername") },
    ],
    async authorize(inputs = {}) {
      if (options.debug) console.error(`[magpie-deepaicode] paste ${inputShape(inputs)}`);
      const key = pickKey(inputs);
      if (!key) return { type: "failed", error: t(lang, "errKeyMissing") };

      const machine = loginMachine(options, key);
      const verified = await verifyDirectKey(options.baseOrigin || DEFAULT_BASE_ORIGIN, {
        key,
        machineFp: machine.machineFp,
        fetchImpl,
        lang,
        laneVersion: options.laneVersion,
      });
      if (!verified.ok) return { type: "failed", error: verified.error };

      return directSuccess({
        cred: { apiKey: key, username: String(inputs.username ?? "").trim(), isPro: false },
        source: "manual",
        accountId: machine.accountId,
        machineId: machine.machineId,
      });
    },
  };
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f1115;color:#e8ecf4}
main{max-width:28rem;padding:2.5rem;border-radius:1rem;background:#171a21;box-shadow:0 10px 40px #0006}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{opacity:.8;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/**
 * 启动 localhost 回调服务（只监听 127.0.0.1，随机端口，一次性）。
 *
 * 注意：上游回调可能只带 code 不带 state，所以“有 state 就校验、没有就只认路径与端口”。
 */
export function startCallbackServer({ timeoutMs = CALLBACK_TIMEOUT_MS, signal, lang = "zh" } = {}) {
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex");
    const doneHtml = htmlPage(t(lang, "browserDoneTitle"), t(lang, "browserDoneBody"));
    const failHtml = htmlPage(t(lang, "browserFailedTitle"), "state mismatch");

    let settle = null;
    const codePromise = new Promise((res, rej) => {
      settle = { res, rej };
    });

    const server = createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${server.address()?.port ?? 0}`);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (url.pathname !== "/auth-callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      const gotState = url.searchParams.get("state") ?? "";
      if (gotState && gotState !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(failHtml);
        return;
      }
      const code = String(url.searchParams.get("code") ?? "").trim();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doneHtml);
      if (code) settle.res(code);
      else settle.rej(new Error("missing-code"));
    });

    const timer = setTimeout(() => settle.rej(new Error("timeout")), timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        // 已关闭
      }
    };

    signal?.addEventListener?.("abort", () => settle.rej(new Error("cancelled")));
    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        state,
        waitForCode: () => codePromise.finally(cleanup),
        close: cleanup,
      });
    });
  });
}

/** ③ 浏览器 + localhost 回调（复刻桌面端 desktop_auth；失败降级为粘贴 code）。 */
function browserMethod({ options, lang, fetchImpl }) {
  const origin = trimSlash(options.baseOrigin || DEFAULT_BASE_ORIGIN);
  const finish = async (code) => {
    try {
      const cred = await exchangeCode(origin, code, { fetchImpl });
      const machine = loginMachine(options, cred.apiKey);
      return directSuccess({
        cred,
        source: "browser",
        accountId: machine.accountId,
        machineId: machine.machineId,
      });
    } catch (err) {
      return { type: "failed", error: `换取 API Key 失败：${String(err?.message ?? err)}` };
    }
  };

  return {
    type: "oauth",
    label: t(lang, "loginBrowser"),
    async authorize(_inputs, { signal } = {}) {
      let server = null;
      try {
        server = await startCallbackServer({ signal, lang });
      } catch {
        server = null;
      }

      if (!server) {
        // 监听失败：退化成“粘贴回调里的 code”
        const state = randomBytes(8).toString("hex");
        return {
          url: `${origin}/deepai_code/desktop_auth/?state=${state}&port=0`,
          instructions: t(lang, "browserInstructions"),
          method: "code",
          async callback(code) {
            return finish(String(code ?? "").trim());
          },
        };
      }

      const loginUrl = `${origin}/deepai_code/desktop_auth/?state=${server.state}&port=${server.port}`;
      return {
        url: loginUrl,
        instructions: t(lang, "browserInstructions"),
        method: "auto",
        async callback() {
          try {
            const code = await server.waitForCode();
            return await finish(code);
          } catch (err) {
            return { type: "failed", error: `浏览器登录未完成：${String(err?.message ?? err)}` };
          } finally {
            server.close();
          }
        },
      };
    },
  };
}

/** 登录方式：浏览器（推荐）→ 桌面端凭据 → 粘贴 Key。 */
export function createMethods({ options = {}, deps = {} } = {}) {
  const lang = resolveLang(options);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return [
    browserMethod({ options, lang, fetchImpl }),
    desktopMethod({ options, lang, fetchImpl }),
    pasteMethod({ options, lang, fetchImpl }),
  ];
}

export { pickKey };
