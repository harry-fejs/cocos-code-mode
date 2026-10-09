import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CcpError } from "./errors.ts";

export type ReplayFailureClass = "planner" | "validator" | "signer" | "persist" | "internal";

export interface ReplayReservationInput {
  deviceId: string;
  relayInstanceId: string;
  idempotencyKey: string;
  requestDigest: string;
  nonce: string;
  sequence: number;
  nowMs: number;
  leaseExpiresAtMs: number;
  expiresAtMs: number;
}

export type ReplayAdmission =
  | { kind: "duplicate"; responseBody: Buffer }
  | { kind: "reserved"; id: number; owner: string };

type ExistingRow = {
  id: number;
  request_digest: string;
  state: "reserved" | "completed" | "failed";
  reservation_owner: string;
  lease_expires_at_ms: number;
  response_body: Buffer | null;
  response_hash: string | null;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalRequestDigest(payload: Uint8Array): string {
  return sha256(payload);
}

export class ReplayStore {
  private readonly reserveTransaction: (input: ReplayReservationInput) => ReplayAdmission;

  constructor(private readonly db: Database.Database) {
    this.reserveTransaction = db.transaction((input: ReplayReservationInput): ReplayAdmission => {
      const existing = db.prepare(`
        SELECT id, request_digest, state, reservation_owner, lease_expires_at_ms,
               response_body, response_hash
        FROM request_idempotency
        WHERE device_id = ? AND idempotency_key = ?
      `).get(input.deviceId, input.idempotencyKey) as ExistingRow | undefined;

      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new CcpError("CCP_IDEMPOTENCY_CONFLICT", "Idempotency key was used for different request bytes.");
        }
        if (existing.state === "completed") {
          if (!existing.response_body || !existing.response_hash
            || sha256(existing.response_body) !== existing.response_hash) {
            throw new CcpError("CCP_INTERNAL", "Stored idempotent response failed its integrity check.");
          }
          return { kind: "duplicate", responseBody: Buffer.from(existing.response_body) };
        }
        if (existing.state === "reserved" && existing.lease_expires_at_ms > input.nowMs) {
          throw new CcpError("CCP_BUSY", "The exact request is already being processed.");
        }

        const owner = randomUUID();
        const reclaimed = db.prepare(`
          UPDATE request_idempotency
          SET state = 'reserved',
              reservation_owner = @owner,
              lease_expires_at_ms = @leaseExpiresAtMs,
              expires_at_ms = MAX(expires_at_ms, @expiresAtMs),
              failure_class = NULL,
              failed_at_ms = NULL
          WHERE id = @id
            AND request_digest = @requestDigest
            AND (
              state = 'failed'
              OR (state = 'reserved' AND lease_expires_at_ms <= @nowMs)
            )
        `).run({
          id: existing.id,
          requestDigest: input.requestDigest,
          owner,
          nowMs: input.nowMs,
          leaseExpiresAtMs: input.leaseExpiresAtMs,
          expiresAtMs: input.expiresAtMs,
        });
        if (reclaimed.changes !== 1) {
          throw new CcpError("CCP_BUSY", "The exact request reservation changed before it could be reclaimed.");
        }
        return { kind: "reserved", id: existing.id, owner };
      }

      const cursor = db.prepare(`
        SELECT last_sequence FROM relay_cursor WHERE device_id = ? AND relay_instance_id = ?
      `).get(input.deviceId, input.relayInstanceId) as { last_sequence: number } | undefined;
      if (cursor && input.sequence <= cursor.last_sequence) {
        throw new CcpError("CCP_REPLAY", "Relay sequence did not advance.", { lastSequence: cursor.last_sequence });
      }

      const nonce = db.prepare(`
        SELECT 1 AS found FROM request_idempotency
        WHERE device_id = ? AND relay_instance_id = ? AND nonce = ?
      `).get(input.deviceId, input.relayInstanceId, input.nonce) as { found: number } | undefined;
      if (nonce) throw new CcpError("CCP_REPLAY", "Request nonce was already admitted.");

      const owner = randomUUID();
      const inserted = db.prepare(`
        INSERT INTO request_idempotency(
          device_id, relay_instance_id, idempotency_key, request_digest, nonce, sequence,
          state, reservation_owner, created_at_ms, lease_expires_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
      `).run(
        input.deviceId, input.relayInstanceId, input.idempotencyKey, input.requestDigest,
        input.nonce, input.sequence, owner, input.nowMs, input.leaseExpiresAtMs,
        input.expiresAtMs,
      );
      db.prepare(`
        INSERT INTO relay_cursor(device_id, relay_instance_id, last_sequence, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id, relay_instance_id) DO UPDATE SET
          last_sequence = MAX(relay_cursor.last_sequence, excluded.last_sequence),
          updated_at_ms = excluded.updated_at_ms
      `).run(input.deviceId, input.relayInstanceId, input.sequence, input.nowMs);
      return { kind: "reserved", id: Number(inserted.lastInsertRowid), owner };
    });
  }

  reserve(input: ReplayReservationInput): ReplayAdmission {
    if (input.leaseExpiresAtMs <= input.nowMs || input.expiresAtMs < input.leaseExpiresAtMs) {
      throw new CcpError("CCP_INTERNAL", "Replay reservation received invalid lease bounds.");
    }
    try {
      return this.reserveTransaction(input);
    } catch (error) {
      if (error instanceof CcpError) throw error;
      if (error instanceof Error && error.message.includes("request_idempotency.device_id")) {
        throw new CcpError("CCP_REPLAY", "Request replay constraint rejected the request.");
      }
      throw error;
    }
  }

  complete(id: number, owner: string, responseBody: Uint8Array, nowMs: number): void {
    const body = Buffer.from(responseBody);
    const result = this.db.prepare(`
      UPDATE request_idempotency
      SET state = 'completed',
          response_body = ?,
          response_hash = ?,
          completed_at_ms = ?,
          lease_expires_at_ms = ?
      WHERE id = ?
        AND reservation_owner = ?
        AND state = 'reserved'
        AND lease_expires_at_ms > ?
    `).run(body, sha256(body), nowMs, nowMs, id, owner, nowMs);
    if (result.changes !== 1) {
      throw new CcpError("CCP_INTERNAL", "Could not durably complete the active request reservation.");
    }
  }

  fail(id: number, owner: string, failureClass: ReplayFailureClass, nowMs: number): boolean {
    const result = this.db.prepare(`
      UPDATE request_idempotency
      SET state = 'failed',
          failure_class = ?,
          failed_at_ms = ?,
          lease_expires_at_ms = ?
      WHERE id = ? AND reservation_owner = ? AND state = 'reserved'
    `).run(failureClass, nowMs, nowMs, id, owner);
    return result.changes === 1;
  }
}
