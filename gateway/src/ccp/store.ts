import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getCacheBaseDir } from "../cache-paths.ts";
import { applyCcBridgeMigrations } from "./migrations.ts";

export type DeviceStatus = "pending" | "approved" | "revoked";
export type OperationClass = "read" | "mutation" | "capture" | "control";

export interface DeviceRecord {
  id: string;
  keyId: string;
  memberId: string;
  publicKeySpki: Buffer;
  fingerprint: string;
  label: string;
  status: DeviceStatus;
}

export interface ProjectRecord {
  id: string;
  displayLabel: string;
  status: "active" | "disabled";
}

export interface GrantRecord {
  id: string;
  memberId: string | null;
  deviceId: string | null;
  projectId: string | null;
  toolId: string | null;
  operationClass: OperationClass;
  expiresAtMs: number | null;
  status: "active" | "disabled" | "revoked";
}

export interface OperationPolicyRecord {
  toolId: string;
  contractVersion: number;
  enabled: boolean;
  contractHash: string;
  minimumRelayBuild: string | null;
  blockedRelayBuilds: readonly string[];
  creatorRange: string;
  requiredConsentVersion: string | null;
  revision: number;
}

export interface ReleaseTargetRecord {
  sequence: number;
  version: string;
  packageHash: string;
  targetPayloadHash: string;
  compatibility: { protocol: { min: number; max: number }; creator: string; os: string[]; arch: string[] };
  status: "active" | "superseded" | "revoked";
  createdAtMs: number;
}

export interface RolloutPolicyRecord {
  sequence: number;
  targetHash: string;
  channel: string;
  ring: "1" | "3" | "10";
  percentage: number;
  minimumBuild: string | null;
  blockedBuilds: readonly string[];
  rollbackTargetHash: string | null;
  expiresAtMs: number;
  createdAtMs: number;
}

export type CanaryRing = "1" | "3" | "10";

export interface CanaryHealthRecord {
  targetHash: string;
  packageHash: string;
  deviceId: string;
  probeId: string;
  observedAtMs: number;
  ring: CanaryRing;
  healthy: boolean;
}

export interface RolloutStateRecord {
  channel: string;
  targetHash: string;
  packageHash: string;
  ring: CanaryRing;
  policySequence: number;
  updatedAtMs: number;
}

type DeviceRow = {
  id: string; key_id: string; member_id: string; public_key_spki: Buffer;
  fingerprint: string; label: string; status: DeviceStatus;
};
type ProjectRow = { id: string; display_label: string; status: ProjectRecord["status"] };
type GrantRow = {
  id: string; member_id: string | null; device_id: string | null; project_id: string | null;
  tool_id: string | null; operation_class: OperationClass; expires_at_ms: number | null; status: GrantRecord["status"];
};
type PolicyRow = {
  tool_id: string; contract_version: number; enabled: number; contract_hash: string;
  minimum_relay_build: string | null; blocked_relay_builds_json: string; creator_range: string;
  required_consent_version: string | null; revision: number;
};

function parseStringArray(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("invalid string-array JSON in CCP store");
  }
  return parsed;
}

export class CcBridgeStore {
  readonly db: Database.Database;

  constructor(file = process.env.CCP_DB_PATH || path.join(getCacheBaseDir(), "ccp.db")) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    applyCcBridgeMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  getDeviceByKeyId(keyId: string): DeviceRecord | null {
    const row = this.db.prepare(`
      SELECT id, key_id, member_id, public_key_spki, fingerprint, label, status
      FROM device WHERE key_id = ?
    `).get(keyId) as DeviceRow | undefined;
    return row ? {
      id: row.id, keyId: row.key_id, memberId: row.member_id,
      publicKeySpki: row.public_key_spki, fingerprint: row.fingerprint,
      label: row.label, status: row.status,
    } : null;
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT id, display_label, status FROM project WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? { id: row.id, displayLabel: row.display_label, status: row.status } : null;
  }

  getOperationPolicy(toolId: string, contractVersion: number): OperationPolicyRecord | null {
    const row = this.db.prepare(`
      SELECT tool_id, contract_version, enabled, contract_hash, minimum_relay_build,
             blocked_relay_builds_json, creator_range, required_consent_version, revision
      FROM operation_policy WHERE tool_id = ? AND contract_version = ?
    `).get(toolId, contractVersion) as PolicyRow | undefined;
    return row ? {
      toolId: row.tool_id, contractVersion: row.contract_version, enabled: row.enabled === 1,
      contractHash: row.contract_hash, minimumRelayBuild: row.minimum_relay_build,
      blockedRelayBuilds: parseStringArray(row.blocked_relay_builds_json),
      creatorRange: row.creator_range, requiredConsentVersion: row.required_consent_version,
      revision: row.revision,
    } : null;
  }

  findActiveGrants(input: {
    memberId: string;
    deviceId: string;
    projectId: string;
    toolId: string;
    operationClass: OperationClass;
    nowMs: number;
  }): GrantRecord[] {
    const rows = this.db.prepare(`
      SELECT id, member_id, device_id, project_id, tool_id, operation_class, expires_at_ms, status
      FROM grant_record
      WHERE status = 'active'
        AND (expires_at_ms IS NULL OR expires_at_ms > @nowMs)
        AND (member_id IS NULL OR member_id = @memberId)
        AND (device_id IS NULL OR device_id = @deviceId)
        AND (project_id IS NULL OR project_id = @projectId)
        AND (tool_id IS NULL OR tool_id = @toolId)
        AND operation_class = @operationClass
    `).all(input) as GrantRow[];
    return rows.map((row) => ({
      id: row.id, memberId: row.member_id, deviceId: row.device_id,
      projectId: row.project_id, toolId: row.tool_id, operationClass: row.operation_class,
      expiresAtMs: row.expires_at_ms, status: row.status,
    }));
  }

  markDeviceSeen(deviceId: string, nowMs: number): void {
    this.db.prepare("UPDATE device SET last_seen_at_ms = ? WHERE id = ? AND status = 'approved'")
      .run(nowMs, deviceId);
  }

  insertDevice(record: DeviceRecord, nowMs = Date.now()): void {
    this.db.prepare(`
      INSERT INTO device(id, key_id, member_id, public_key_spki, fingerprint, label, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.keyId, record.memberId, record.publicKeySpki, record.fingerprint, record.label, record.status, nowMs);
  }

  insertEnrollmentChallenge(record: {
    challengeId: string;
    challengeHash: string;
    memberId: string;
    label: string;
    expiresAtMs: number;
  }, nowMs = Date.now()): void {
    this.db.prepare(`
      INSERT INTO enrollment_challenge(
        challenge_id, challenge_hash, member_id, label, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.challengeId, record.challengeHash, record.memberId, record.label,
      nowMs, record.expiresAtMs,
    );
  }

  enrollDeviceWithChallenge(input: {
    challengeId: string;
    challengeHash: string;
    challengeExpiresAtMs: number;
    device: DeviceRecord;
    nowMs: number;
  }): boolean {
    const enroll = this.db.transaction(() => {
      const consumed = this.db.prepare(`
        UPDATE enrollment_challenge
        SET consumed_at_ms = @nowMs
        WHERE challenge_id = @challengeId
          AND challenge_hash = @challengeHash
          AND member_id = @memberId
          AND label = @label
          AND expires_at_ms = @challengeExpiresAtMs
          AND expires_at_ms > @nowMs
          AND consumed_at_ms IS NULL
      `).run({
        challengeId: input.challengeId,
        challengeHash: input.challengeHash,
        challengeExpiresAtMs: input.challengeExpiresAtMs,
        memberId: input.device.memberId,
        label: input.device.label,
        nowMs: input.nowMs,
      });
      if (consumed.changes !== 1) return false;
      this.insertDevice(input.device, input.nowMs);
      return true;
    });
    return enroll();
  }

  insertProject(record: ProjectRecord, nowMs = Date.now()): void {
    this.db.prepare("INSERT INTO project(id, display_label, status, created_at_ms) VALUES (?, ?, ?, ?)")
      .run(record.id, record.displayLabel, record.status, nowMs);
  }

  insertGrant(record: GrantRecord, nowMs = Date.now()): void {
    this.db.prepare(`
      INSERT INTO grant_record(id, member_id, device_id, project_id, tool_id, operation_class, expires_at_ms, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.memberId, record.deviceId, record.projectId, record.toolId, record.operationClass, record.expiresAtMs, record.status, nowMs);
  }

  insertOperationPolicy(record: OperationPolicyRecord): void {
    this.db.prepare(`
      INSERT INTO operation_policy(
        tool_id, contract_version, enabled, contract_hash, minimum_relay_build,
        blocked_relay_builds_json, creator_range, required_consent_version, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.toolId, record.contractVersion, record.enabled ? 1 : 0, record.contractHash,
      record.minimumRelayBuild, JSON.stringify(record.blockedRelayBuilds), record.creatorRange,
      record.requiredConsentVersion, record.revision,
    );
  }

  approveDevice(deviceId: string, nowMs = Date.now()): boolean {
    return this.db.prepare("UPDATE device SET status = 'approved', last_seen_at_ms = ? WHERE id = ? AND status = 'pending'")
      .run(nowMs, deviceId).changes === 1;
  }

  revokeDevice(deviceId: string, nowMs = Date.now()): boolean {
    return this.db.prepare("UPDATE device SET status = 'revoked', revoked_at_ms = ? WHERE id = ? AND status != 'revoked'")
      .run(nowMs, deviceId).changes === 1;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db.prepare("SELECT id, key_id, member_id, public_key_spki, fingerprint, label, status FROM device ORDER BY created_at_ms DESC").all() as DeviceRow[];
    return rows.map((row) => ({
      id: row.id, keyId: row.key_id, memberId: row.member_id, publicKeySpki: row.public_key_spki,
      fingerprint: row.fingerprint, label: row.label, status: row.status,
    }));
  }

  listGrants(): GrantRecord[] {
    const rows = this.db.prepare("SELECT id, member_id, device_id, project_id, tool_id, operation_class, expires_at_ms, status FROM grant_record ORDER BY created_at_ms DESC").all() as GrantRow[];
    return rows.map((row) => ({
      id: row.id, memberId: row.member_id, deviceId: row.device_id, projectId: row.project_id,
      toolId: row.tool_id, operationClass: row.operation_class, expiresAtMs: row.expires_at_ms, status: row.status,
    }));
  }

  revokeGrant(grantId: string, nowMs = Date.now()): boolean {
    return this.db.prepare("UPDATE grant_record SET status = 'revoked' WHERE id = ? AND status != 'revoked'").run(grantId).changes === 1;
  }

  latestReleaseTargetSequence(): number {
    const row = this.db.prepare("SELECT MAX(sequence) AS seq FROM release_target").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  insertReleaseTarget(record: Omit<ReleaseTargetRecord, "createdAtMs"> & { createdAtMs?: number }, nowMs = Date.now()): number {
    const result = this.db.prepare(`
      INSERT INTO release_target(sequence, version, package_hash, target_payload_hash, compatibility_json, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.sequence, record.version, record.packageHash, record.targetPayloadHash, JSON.stringify(record.compatibility), record.status, record.createdAtMs ?? nowMs);
    return Number(result.lastInsertRowid);
  }

  getReleaseTargetByHash(packageHash: string): ReleaseTargetRecord | null {
    return this.readReleaseTarget("package_hash", packageHash);
  }

  getReleaseTargetByPayloadHash(targetPayloadHash: string): ReleaseTargetRecord | null {
    return this.readReleaseTarget("target_payload_hash", targetPayloadHash);
  }

  private readReleaseTarget(column: "package_hash" | "target_payload_hash", hash: string): ReleaseTargetRecord | null {
    const row = this.db.prepare(`SELECT sequence, version, package_hash, target_payload_hash, compatibility_json, status, created_at_ms FROM release_target WHERE ${column} = ?`)
      .get(hash) as { sequence: number; version: string; package_hash: string; target_payload_hash: string; compatibility_json: string; status: ReleaseTargetRecord["status"]; created_at_ms: number } | undefined;
    if (!row) return null;
    return { sequence: row.sequence, version: row.version, packageHash: row.package_hash, targetPayloadHash: row.target_payload_hash, compatibility: JSON.parse(row.compatibility_json), status: row.status, createdAtMs: row.created_at_ms };
  }

  listReleaseTargets(): ReleaseTargetRecord[] {
    const rows = this.db.prepare("SELECT sequence, version, package_hash, target_payload_hash, compatibility_json, status, created_at_ms FROM release_target ORDER BY sequence DESC")
      .all() as { sequence: number; version: string; package_hash: string; target_payload_hash: string; compatibility_json: string; status: ReleaseTargetRecord["status"]; created_at_ms: number }[];
    return rows.map((row) => ({ sequence: row.sequence, version: row.version, packageHash: row.package_hash, targetPayloadHash: row.target_payload_hash, compatibility: JSON.parse(row.compatibility_json), status: row.status, createdAtMs: row.created_at_ms }));
  }

  latestRolloutPolicySequence(): number {
    const row = this.db.prepare("SELECT MAX(sequence) AS seq FROM rollout_policy").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  insertRolloutPolicy(record: Omit<RolloutPolicyRecord, "createdAtMs"> & { createdAtMs?: number }, nowMs = Date.now()): number {
    const result = this.db.prepare(`
      INSERT INTO rollout_policy(sequence, target_hash, channel, ring, percentage, minimum_build, blocked_builds_json, rollback_target_hash, expires_at_ms, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.sequence, record.targetHash, record.channel, record.ring, record.percentage, record.minimumBuild, JSON.stringify(record.blockedBuilds), record.rollbackTargetHash, record.expiresAtMs, record.createdAtMs ?? nowMs);
    return Number(result.lastInsertRowid);
  }

  listRolloutPolicies(): RolloutPolicyRecord[] {
    const rows = this.db.prepare("SELECT sequence, target_hash, channel, ring, percentage, minimum_build, blocked_builds_json, rollback_target_hash, expires_at_ms, created_at_ms FROM rollout_policy ORDER BY sequence DESC")
      .all() as { sequence: number; target_hash: string; channel: string; ring: RolloutPolicyRecord["ring"]; percentage: number; minimum_build: string | null; blocked_builds_json: string; rollback_target_hash: string | null; expires_at_ms: number; created_at_ms: number }[];
    return rows.map((row) => ({ sequence: row.sequence, targetHash: row.target_hash, channel: row.channel, ring: row.ring, percentage: row.percentage, minimumBuild: row.minimum_build, blockedBuilds: JSON.parse(row.blocked_builds_json), rollbackTargetHash: row.rollback_target_hash, expiresAtMs: row.expires_at_ms, createdAtMs: row.created_at_ms }));
  }

  recordCanaryHealth(record: CanaryHealthRecord): void {
    this.db.prepare(`
      INSERT INTO canary_health(
        target_hash, package_hash, device_id, probe_id, observed_at_ms, ring, healthy
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.targetHash, record.packageHash, record.deviceId, record.probeId,
      record.observedAtMs, record.ring, record.healthy ? 1 : 0,
    );
  }

  getCanaryHealth(input: {
    targetHash: string;
    packageHash: string;
    ring: CanaryRing;
    sinceMs?: number;
  }): CanaryHealthRecord[] {
    const rows = this.db.prepare(`
      SELECT target_hash, package_hash, device_id, probe_id, observed_at_ms, ring, healthy
      FROM canary_health
      WHERE target_hash = @targetHash
        AND package_hash = @packageHash
        AND ring = @ring
        AND observed_at_ms >= @sinceMs
      ORDER BY observed_at_ms ASC, device_id ASC, probe_id ASC
    `).all({ ...input, sinceMs: input.sinceMs ?? 0 }) as Array<{
      target_hash: string;
      package_hash: string;
      device_id: string;
      probe_id: string;
      observed_at_ms: number;
      ring: CanaryRing;
      healthy: number;
    }>;
    return rows.map((row) => ({
      targetHash: row.target_hash,
      packageHash: row.package_hash,
      deviceId: row.device_id,
      probeId: row.probe_id,
      observedAtMs: row.observed_at_ms,
      ring: row.ring,
      healthy: row.healthy === 1,
    }));
  }

  getRolloutState(channel: string): RolloutStateRecord | null {
    const row = this.db.prepare(`
      SELECT channel, target_hash, package_hash, ring, policy_sequence, updated_at_ms
      FROM rollout_state WHERE channel = ?
    `).get(channel) as {
      channel: string;
      target_hash: string;
      package_hash: string;
      ring: CanaryRing;
      policy_sequence: number;
      updated_at_ms: number;
    } | undefined;
    return row ? {
      channel: row.channel,
      targetHash: row.target_hash,
      packageHash: row.package_hash,
      ring: row.ring,
      policySequence: row.policy_sequence,
      updatedAtMs: row.updated_at_ms,
    } : null;
  }

  setRolloutState(record: RolloutStateRecord): boolean {
    const result = this.db.prepare(`
      INSERT INTO rollout_state(
        channel, target_hash, package_hash, ring, policy_sequence, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel) DO UPDATE SET
        target_hash = excluded.target_hash,
        package_hash = excluded.package_hash,
        ring = excluded.ring,
        policy_sequence = excluded.policy_sequence,
        updated_at_ms = excluded.updated_at_ms
      WHERE excluded.policy_sequence > rollout_state.policy_sequence
    `).run(
      record.channel, record.targetHash, record.packageHash, record.ring,
      record.policySequence, record.updatedAtMs,
    );
    return result.changes === 1;
  }

  counts(): { activeDevices: number; replayRows: number } {
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM device WHERE status = 'approved'")
      .get() as { count: number };
    const replay = this.db.prepare("SELECT COUNT(*) AS count FROM request_idempotency").get() as { count: number };
    return { activeDevices: active.count, replayRows: replay.count };
  }

  cleanupExpired(nowMs: number, limit = 500): number {
    return this.db.prepare(`
      DELETE FROM request_idempotency WHERE id IN (
        SELECT id FROM request_idempotency WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT ?
      )
    `).run(nowMs, limit).changes;
  }
}
