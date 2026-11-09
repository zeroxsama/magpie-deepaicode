// 账号设置解析：一个 magpie 账号 → 用哪个地址、哪份凭据、哪个机器指纹（直连上游）。

import { DEFAULT_BASE_ORIGIN } from "./constants.mjs";
import { machineFingerprint, sha256Hex } from "./machine.mjs";
import { ensureAccountMachineId } from "./machine-store.mjs";
import { trimSlash } from "./util.mjs";

/**
 * 解析一个账号的最终设置（直连上游）。
 *
 * 优先级：auth.metadata（登录时写入） > options（插件选项） > 默认值。
 *
 * 机器指纹只走参考项目 DeepAICode2API 的账号池逻辑：
 * 每个号一个随机 UUID，落盘保存；同一 Key 重登仍是同一个。
 */
export function resolveAccountSettings(auth, options = {}) {
  const metadata = auth?.metadata ?? {};

  const origin = trimSlash(options.baseOrigin || DEFAULT_BASE_ORIGIN);
  const key = String(auth?.key ?? "").trim();
  const laneVersion = String(metadata.laneVersion ?? options.laneVersion ?? "auto").trim() || "auto";
  const username = String(metadata.username ?? "").trim();

  const accountId = String(auth?.accountId ?? "").trim() || accountIdFor({ key });
  const machineId = ensureAccountMachineId(accountId, {
    metadataId: metadata.machineId,
    storePath: options.machineStore,
  });
  const machineFp = machineFingerprint(machineId);

  return { mode: "direct", origin, key, laneVersion, machineFp, machineId, accountId, username };
}

/** 稳定账号 id：同 Key 重登 = 替换而不是新增。 */
export function accountIdFor({ key = "" } = {}) {
  return `deepai:${sha256Hex(String(key ?? "")).slice(0, 16)}`;
}
