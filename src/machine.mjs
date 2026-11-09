// 机器指纹。
//
// 指纹 = sha256(小写原始 UUID)；原始值不上传。
//
// 只保留参考项目 DeepAICode2API 的账号池做法：
//   - 每个账号一个随机 UUID v4（NewMachineUUID），按账号落盘保存
//     （见 machine-store.mjs）；
//   - 请求头 X-DeepAI-Code-Machine = sha256(小写原始 UUID)。
//
// 不读取、不伪造真实设备标识（SMBIOS UUID / MachineGuid / IOPlatformUUID /
// machine-id 等逻辑已移除）。

import { createHash, randomBytes } from "node:crypto";

/** 历史遗留的占位 UUID：不能作为账号指纹。 */
const PLACEHOLDER_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** 上游要求的指纹形态：sha256(小写去空白的原始值)；空串返回空串。 */
export function machineFingerprint(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "";
  return sha256Hex(v);
}

/** 从任意文本中提取第一个非占位 UUID。 */
export function parseUuid(text) {
  const m = String(text ?? "").match(UUID_RE);
  if (!m) return "";
  const v = m[0].toLowerCase();
  return PLACEHOLDER_UUIDS.has(v) ? "" : v;
}

/** 把 16 字节格式化为 8-4-4-4-12。 */
export function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 生成一个新的随机 UUID（v4）。
 *
 * 参考实现 DeepAICode2API 的同名函数：每个账号分配一个独立机器指纹，
 * 上游才会按 (机器指纹, 账号) 分别发放每日免费额度。
 */
export function newMachineUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  return formatUuid(b);
}

/**
 * 由账号 id 稳定派生一个 UUID 形态的机器标识。
 *
 * 只在落盘失败（只读文件系统 / 无 home 权限）时兜底：
 * 同一账号永远得到同一个值，不会每次重启都换指纹。
 */
export function derivedAccountUuid(accountId) {
  const digest = createHash("sha256")
    .update(`magpie-deepaicode:machine:${String(accountId ?? "")}`, "utf8")
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return formatUuid(b);
}
