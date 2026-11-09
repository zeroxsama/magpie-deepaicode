// 机器指纹。
//
//
// 指纹 = sha256(小写原始 UUID)；原始值不上传。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 固件占位 UUID：不能作为稳定标识。 */
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

function run(cmd, args, timeout = 12_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
  } catch {
    return "";
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** 探测真实设备标识（原始 UUID / machine-id 文本）。失败返回空串。 */
export function detectDeviceRaw({
  platform = process.platform,
  run: runImpl = run,
  read: readImpl = readText,
  env = process.env,
} = {}) {
  const override = String(env?.DEEPAI_MACHINE_ID ?? "").trim();
  if (override) return override;

  if (platform === "win32") {
    const fromWmi = parseUuid(
      runImpl("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
      ]),
    );
    if (fromWmi) return fromWmi;
    const reg = runImpl("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const m = String(reg).match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    return m ? m[1].toLowerCase() : "";
  }

  if (platform === "darwin") {
    const out = runImpl("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = String(out).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? parseUuid(m[1]) : "";
  }

  // linux / 其他 unix
  for (const path of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const raw = String(readImpl(path) ?? "").trim();
    if (!raw) continue;
    const uuid = parseUuid(raw);
    if (uuid) return uuid;
    return raw.toLowerCase();
  }
  return "";
}

export function resolveMachineFingerprint() {
  return machineFingerprint(detectDeviceRaw());
}
