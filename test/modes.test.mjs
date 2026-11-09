import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineFingerprint } from "../src/machine.mjs";
import { accountIdFor, resolveAccountSettings } from "../src/modes.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORE = join(mkdtempSync(join(tmpdir(), "deepaicode-modes-")), "machines.json");

function auth(overrides = {}) {
  return {
    type: "api",
    key: "fake-deepai-key-0001",
    accountId: "deepai:modes-a",
    metadata: { mode: "direct" },
    ...overrides,
  };
}

test("resolveAccountSettings：每个账号生成独立指纹，账号 id 缺省时由 Key 派生", () => {
  const a = resolveAccountSettings(auth(), { machineStore: STORE, laneVersion: "4" });
  assert.match(a.machineId, UUID_V4);
  assert.equal(a.machineFp, machineFingerprint(a.machineId));
  assert.equal(a.accountId, "deepai:modes-a");

  const derived = resolveAccountSettings(auth({ accountId: undefined }), {
    machineStore: STORE,
    laneVersion: "4",
  });
  assert.equal(derived.accountId, accountIdFor({ key: "fake-deepai-key-0001" }));
  assert.match(derived.machineId, UUID_V4);
});

test("resolveAccountSettings：metadata.machineId 优先并落盘", () => {
  const fixed = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const a = resolveAccountSettings(auth({ metadata: { mode: "direct", machineId: fixed } }), {
    machineStore: STORE,
    laneVersion: "4",
  });
  assert.equal(a.machineId, fixed);
  assert.equal(a.machineFp, machineFingerprint(fixed));
});
