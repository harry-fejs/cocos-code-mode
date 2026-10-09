import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";

function temporaryDatabasePath(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "ccp-store-recovery-"));
  return { directory, file: join(directory, "ccp.db") };
}

const reservation = {
  deviceId: "00000000-0000-4000-8000-000000000002",
  relayInstanceId: "00000000-0000-4000-8000-000000000004",
  idempotencyKey: "stable-local-retry-key",
  requestDigest: "a".repeat(64),
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  sequence: 7,
  nowMs: 100,
  leaseExpiresAtMs: 200,
  expiresAtMs: 10_000,
};

describe("CCP durable replay recovery", () => {
  it("reclaims only the same digest after an expired lease and restart", () => {
    const location = temporaryDatabasePath();
    let store = new CcBridgeStore(location.file);
    try {
      const first = new ReplayStore(store.db).reserve(reservation);
      expect(first.kind).toBe("reserved");
      store.close();

      store = new CcBridgeStore(location.file);
      const restarted = new ReplayStore(store.db);
      expect(() => restarted.reserve({
        ...reservation,
        requestDigest: "b".repeat(64),
        nowMs: 201,
        leaseExpiresAtMs: 301,
      })).toThrow(/different request bytes/);

      const reclaimed = restarted.reserve({
        ...reservation,
        nowMs: 201,
        leaseExpiresAtMs: 301,
      });
      expect(reclaimed).toMatchObject({ kind: "reserved", id: 1 });
      if (reclaimed.kind !== "reserved") throw new Error("expected reclaimed reservation");
      restarted.complete(reclaimed.id, reclaimed.owner, Buffer.from("signed-response"), 202);

      const completed = restarted.reserve({
        ...reservation,
        nowMs: 203,
        leaseExpiresAtMs: 303,
      });
      expect(completed.kind).toBe("duplicate");
      if (completed.kind !== "duplicate") throw new Error("expected completed duplicate");
      expect(completed.responseBody.equals(Buffer.from("signed-response"))).toBe(true);
      expect(store.db.prepare(
        "SELECT state, sequence FROM request_idempotency",
      ).get()).toMatchObject({ state: "completed", sequence: 7 });
      expect(store.db.prepare(
        "SELECT last_sequence FROM relay_cursor",
      ).get()).toMatchObject({ last_sequence: 7 });
    } finally {
      store.close();
      rmSync(location.directory, { recursive: true, force: true });
    }
  });

  it("reclaims a durably failed reservation without rolling back its cursor", () => {
    const location = temporaryDatabasePath();
    let store = new CcBridgeStore(location.file);
    try {
      const replay = new ReplayStore(store.db);
      const admitted = replay.reserve(reservation);
      if (admitted.kind !== "reserved") throw new Error("expected initial reservation");
      expect(replay.fail(admitted.id, admitted.owner, "planner", 101)).toBe(true);
      store.close();

      store = new CcBridgeStore(location.file);
      const restarted = new ReplayStore(store.db);
      const reclaimed = restarted.reserve({
        ...reservation,
        nowMs: 102,
        leaseExpiresAtMs: 202,
      });
      expect(reclaimed).toMatchObject({ kind: "reserved", id: admitted.id });
      expect(store.db.prepare(
        "SELECT state, failure_class FROM request_idempotency",
      ).get()).toMatchObject({ state: "reserved", failure_class: null });
      expect(() => restarted.reserve({
        ...reservation,
        idempotencyKey: "different-key",
        nonce: "BBBBBBBBBBBBBBBBBBBBBB",
        nowMs: 103,
        leaseExpiresAtMs: 203,
      })).toThrow(/sequence did not advance/);
    } finally {
      store.close();
      rmSync(location.directory, { recursive: true, force: true });
    }
  });
});

describe("CCP rollout store migration", () => {
  it("preserves existing rollout high-water state and records probe health durably", () => {
    const location = temporaryDatabasePath();
    const legacy = new Database(location.file);
    legacy.exec(`
      CREATE TABLE ccp_migration(version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
      INSERT INTO ccp_migration VALUES (1, 1), (2, 2);

      CREATE TABLE relay_cursor(
        device_id TEXT NOT NULL, relay_instance_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(device_id, relay_instance_id)
      );
      CREATE TABLE request_idempotency(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        relay_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'completed')),
        reservation_owner TEXT NOT NULL,
        response_body BLOB,
        response_hash TEXT,
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE(device_id, idempotency_key),
        UNIQUE(device_id, relay_instance_id, nonce)
      );
      CREATE TABLE release_target(
        sequence INTEGER PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        package_hash TEXT NOT NULL UNIQUE,
        compatibility_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        target_payload_hash TEXT UNIQUE
      );
      CREATE TABLE rollout_policy(
        sequence INTEGER PRIMARY KEY,
        target_hash TEXT NOT NULL,
        channel TEXT NOT NULL,
        ring TEXT NOT NULL,
        percentage INTEGER NOT NULL,
        minimum_build TEXT,
        blocked_builds_json TEXT NOT NULL,
        rollback_target_hash TEXT,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO release_target VALUES (
        7, '2.0.0', '${"c".repeat(64)}', '{}', 'active', 50, '${"d".repeat(64)}'
      );
      INSERT INTO rollout_policy VALUES (
        9, '${"d".repeat(64)}', 'stable', '3', 30, NULL, '[]', NULL, 9999, 60
      );
    `);
    legacy.close();

    const store = new CcBridgeStore(location.file);
    try {
      expect(store.latestReleaseTargetSequence()).toBe(7);
      expect(store.latestRolloutPolicySequence()).toBe(9);
      expect(store.getRolloutState("stable")).toEqual({
        channel: "stable",
        targetHash: "d".repeat(64),
        packageHash: "c".repeat(64),
        ring: "3",
        policySequence: 9,
        updatedAtMs: 60,
      });

      store.recordCanaryHealth({
        targetHash: "d".repeat(64),
        packageHash: "c".repeat(64),
        deviceId: "device-1",
        probeId: "protected-read-v1",
        observedAtMs: 70,
        ring: "3",
        healthy: true,
      });
      expect(store.getCanaryHealth({
        targetHash: "d".repeat(64),
        packageHash: "c".repeat(64),
        ring: "3",
        sinceMs: 61,
      })).toHaveLength(1);
      expect(store.setRolloutState({
        channel: "stable",
        targetHash: "d".repeat(64),
        packageHash: "c".repeat(64),
        ring: "10",
        policySequence: 10,
        updatedAtMs: 80,
      })).toBe(true);
      expect(store.setRolloutState({
        channel: "stable",
        targetHash: "d".repeat(64),
        packageHash: "c".repeat(64),
        ring: "3",
        policySequence: 9,
        updatedAtMs: 90,
      })).toBe(false);
      expect(store.getRolloutState("stable")?.policySequence).toBe(10);
    } finally {
      store.close();
      rmSync(location.directory, { recursive: true, force: true });
    }
  });
});
