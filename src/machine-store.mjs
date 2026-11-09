// 每账号机器指纹（原始 UUID）的持久化。
//
// 参考实现 DeepAICode2API：
//   - 注册时给每个账号生成 NewMachineUUID()，随账号记录保存；
//   - 请求头 X-DeepAI-Code-Machine = sha256(小写原始 UUID)；
//   - 上游按 (机器指纹, 账号) 每天发一次免费 Theos，共用指纹时只有第一个号能领。
//
// 插件没有账号数据库，所以用一个小 JSON 文件保存映射：
//
//   {"version":1,"machines":{"deepai:4f2c…":"1b4e28ba-2fa1-4d3b-a3f5-ef19b7a3c9a2"}}
//
// 位置优先级：
//   1. options.machineStore（测试 / 多实例隔离）
//   2. $MAGPIE_DEEPAICODE_HOME/machines.json
//   3. ~/.magpie-deepaicode/machines.json
//
// 写盘用临时文件 + rename；读不出来或目录只读时退回 derivedAccountUuid()，
// 保证同一账号不会每次启动都换指纹。

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { derivedAccountUuid, newMachineUuid, parseUuid } from "./machine.mjs";

const STORE_VERSION = 1;
const STORE_MODE = 0o600;

/** path → { machines: Map<accountId, uuid> } */
const cache = new Map();

/** 解析机器指纹存储文件路径。 */
export function machineStorePath({ explicit = "", env = process.env, home = homedir() } = {}) {
  const value = String(explicit ?? "").trim();
  if (value) return value;
  const dir = String(env?.MAGPIE_DEEPAICODE_HOME ?? "").trim();
  return join(dir || join(home, ".magpie-deepaicode"), "machines.json");
}

function readStoreFile(path) {
  const machines = new Map();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const src = data?.machines;
    if (src && typeof src === "object" && !Array.isArray(src)) {
      for (const [accountId, raw] of Object.entries(src)) {
        const key = String(accountId ?? "").trim();
        const id = parseUuid(raw);
        if (key && id) machines.set(key, id);
      }
    }
  } catch {
    // 文件不存在 / 损坏：按空表处理，下一次写入时重建
  }
  return machines;
}

function loadStore(path) {
  const hit = cache.get(path);
  if (hit) return hit;
  const entry = { machines: readStoreFile(path) };
  cache.set(path, entry);
  return entry;
}

function saveStore(path, entry, forceAccount = "") {
  // 先合并磁盘上的现有条目（另一个插件进程可能刚写过）：
  // 同名以磁盘为准（先写者赢）；forceAccount 用于 metadata 明确指定值的账号，
  // 那个值必须覆盖旧文件。
  const merged = readStoreFile(path);
  for (const [accountId, id] of entry.machines) {
    if (accountId === forceAccount || !merged.has(accountId)) merged.set(accountId, id);
  }
  entry.machines = merged;

  const payload = {
    version: STORE_VERSION,
    machines: Object.fromEntries(
      [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(tmp, "w", STORE_MODE);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, path);
    } catch {
      // Windows 上目标存在时偶发 EPERM：删掉再换名
      try {
        unlinkSync(path);
      } catch {
        // 目标本来就不存在
      }
      renameSync(tmp, path);
    }
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件没建出来
    }
    return false;
  }
}

/**
 * 取账号的机器标识原始值（UUID）；没有就生成并保存。
 *
 * @param {string} accountId 稳定账号 id（插件里是 `deepai:<key hash>`）
 * @param {object} [options]
 * @param {string} [options.metadataId] 登录时写进 auth.metadata 的 machineId（优先）
 * @param {string} [options.storePath] 显式存储文件
 * @param {boolean} [options.persist] false 时只生成不落盘（测试用）
 */
export function ensureAccountMachineId(accountId, {
  metadataId = "",
  storePath = "",
  persist = true,
  env = process.env,
  home = homedir(),
} = {}) {
  const account = String(accountId ?? "").trim();
  if (!account) return newMachineUuid();

  const fromMetadata = parseUuid(metadataId);
  const path = storePath || machineStorePath({ env, home });
  const entry = loadStore(path);
  const stored = entry.machines.get(account) ?? "";
  const chosen = fromMetadata || stored || newMachineUuid();

  if (stored !== chosen) {
    entry.machines.set(account, chosen);
    if (persist && !saveStore(path, entry, fromMetadata ? account : "")) {
      // 落盘失败：新生成的指纹改为按账号派生，保证重启后仍是同一个值。
      if (!fromMetadata && !stored) {
        const fallback = derivedAccountUuid(account);
        entry.machines.set(account, fallback);
        return fallback;
      }
    }
  }

  return entry.machines.get(account) ?? chosen;
}

/** 读出全部账号映射（诊断 / 脚本用）。 */
export function readAccountMachineIds({ storePath = "", env = process.env, home = homedir() } = {}) {
  const path = storePath || machineStorePath({ env, home });
  return Object.fromEntries(loadStore(path).machines);
}

/** 清空进程内缓存（测试 / 手工改文件后重读）。 */
export function resetMachineStoreCache() {
  cache.clear();
}

/** 存储文件路径与版本，供 _internal / 文档引用。 */
export const MACHINE_STORE_VERSION = STORE_VERSION;
