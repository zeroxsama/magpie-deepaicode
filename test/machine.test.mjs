import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  derivedAccountUuid,
  formatUuid,
  machineFingerprint,
  newMachineUuid,
  parseUuid,
  sha256Hex,
} from "../src/machine.mjs";
import {
  ensureAccountMachineId,
  machineStorePath,
  readAccountMachineIds,
  resetMachineStoreCache,
} from "../src/machine-store.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tempStore(name = "machines.json") {
  const dir = mkdtempSync(join(tmpdir(), "deepaicode-machine-"));
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("sha256Hex：稳定小写 64 位（不改输入大小写）", () => {
  const upper = sha256Hex("ABC");
  const lower = sha256Hex("abc");
  assert.match(upper, /^[0-9a-f]{64}$/);
  assert.match(lower, /^[0-9a-f]{64}$/);
  assert.notEqual(upper, lower);
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
});

test("machineFingerprint：先小写去空白再 sha256；空值返回空串", () => {
  const fp = machineFingerprint("  AABBCCDD-1122-3344-5566-77889900AABB ");
  assert.equal(fp, sha256Hex("aabbccdd-1122-3344-5566-77889900aabb"));
  assert.equal(machineFingerprint(""), "");
  assert.equal(machineFingerprint(null), "");
});

test("parseUuid：提取并过滤固件占位值", () => {
  assert.equal(parseUuid("UUID: ABCDEF01-2345-6789-ABCD-EF0123456789"), "abcdef01-2345-6789-abcd-ef0123456789");
  assert.equal(parseUuid("00000000-0000-0000-0000-000000000000"), "");
  assert.equal(parseUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"), "");
  assert.equal(parseUuid("nothing here"), "");
});

test("newMachineUuid / formatUuid：合法 UUID v4，每次不同", () => {
  const a = newMachineUuid();
  const b = newMachineUuid();
  assert.match(a, UUID_V4);
  assert.match(b, UUID_V4);
  assert.notEqual(a, b);

  const bytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  assert.equal(formatUuid(bytes), "00112233-4455-6677-8899-aabbccddeeff");
});

test("derivedAccountUuid：同一账号稳定，不同账号不同", () => {
  const a = derivedAccountUuid("deepai:aaa");
  assert.match(a, UUID_V4);
  assert.equal(a, derivedAccountUuid("deepai:aaa"));
  assert.notEqual(a, derivedAccountUuid("deepai:bbb"));
});

test("ensureAccountMachineId：首次生成并落盘，重启后复用", () => {
  const store = tempStore();
  resetMachineStoreCache();
  try {
    const first = ensureAccountMachineId("deepai:aaa", { storePath: store.path });
    assert.match(first, UUID_V4);

    // 模拟进程重启：清缓存后再读同一个文件
    resetMachineStoreCache();
    const again = ensureAccountMachineId("deepai:aaa", { storePath: store.path });
    assert.equal(again, first);

    const saved = JSON.parse(readFileSync(store.path, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.machines["deepai:aaa"], first);
  } finally {
    resetMachineStoreCache();
    store.cleanup();
  }
});

test("ensureAccountMachineId：每个号各自一份，互不相同", () => {
  const store = tempStore();
  resetMachineStoreCache();
  try {
    const a = ensureAccountMachineId("deepai:aaa", { storePath: store.path });
    const b = ensureAccountMachineId("deepai:bbb", { storePath: store.path });
    assert.match(a, UUID_V4);
    assert.match(b, UUID_V4);
    assert.notEqual(a, b);
    assert.deepEqual(readAccountMachineIds({ storePath: store.path }), {
      "deepai:aaa": a,
      "deepai:bbb": b,
    });
  } finally {
    resetMachineStoreCache();
    store.cleanup();
  }
});

test("ensureAccountMachineId：metadata 里的 machineId 优先并落盘", () => {
  const store = tempStore();
  resetMachineStoreCache();
  const fixed = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    const id = ensureAccountMachineId("deepai:meta", {
      metadataId: fixed,
      storePath: store.path,
    });
    assert.equal(id, fixed);
    resetMachineStoreCache();
    assert.equal(
      ensureAccountMachineId("deepai:meta", { storePath: store.path }),
      fixed,
      "重启后仍取落盘值",
    );
  } finally {
    resetMachineStoreCache();
    store.cleanup();
  }
});

test("ensureAccountMachineId：落盘失败时退回按账号派生（重启不变）", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepaicode-machine-"));
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x", "utf8");
  const path = join(blocker, "machines.json"); // 父路径是文件 → 无法创建目录
  resetMachineStoreCache();
  try {
    const first = ensureAccountMachineId("deepai:readonly", { storePath: path });
    assert.match(first, UUID_V4);
    assert.equal(first, derivedAccountUuid("deepai:readonly"));

    resetMachineStoreCache();
    assert.equal(
      ensureAccountMachineId("deepai:readonly", { storePath: path }),
      first,
      "同一账号在只读环境下仍得到同一个指纹",
    );
  } finally {
    resetMachineStoreCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machineStorePath：显式 > MAGPIE_DEEPAICODE_HOME > ~/.magpie-deepaicode", () => {
  assert.equal(machineStorePath({ explicit: "C:\\tmp\\m.json" }), "C:\\tmp\\m.json");
  assert.equal(
    machineStorePath({ env: { MAGPIE_DEEPAICODE_HOME: "/var/lib/magpie" }, home: "/home/a" }),
    join("/var/lib/magpie", "machines.json"),
  );
  assert.equal(
    machineStorePath({ env: {}, home: "/home/a" }),
    join("/home/a", ".magpie-deepaicode", "machines.json"),
  );
});
