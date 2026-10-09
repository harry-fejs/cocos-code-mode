import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { assertIJson, canonicalizeToBytes, IJson } from "./canonical-json";
import { CcpError } from "./errors";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJsonAtomic } from "./durable-file";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SnapshotOutcomeSchema = z.object({ attempted: z.boolean(), completed: z.boolean(), error: z.string().max(1024).optional() }).strict();
const JournalSchema = z.object({
  schemaVersion: z.literal(2),
  decisionDigest: z.string().regex(DIGEST_PATTERN),
  requestId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(128),
  state: z.enum(["prepared", "started", "completed", "outcome-unknown"]),
  preparedAtMs: z.number().int().positive().safe(),
  startedAtMs: z.number().int().positive().safe().optional(),
  completedAtMs: z.number().int().positive().safe().optional(),
  attemptedCommandIds: z.array(z.string().min(1).max(128)).max(100),
  completedCommandIds: z.array(z.string().min(1).max(128)).max(100),
  failingCommandId: z.string().min(1).max(128).optional(),
  causalCode: z.string().min(1).max(64).optional(),
  cause: z.string().max(1024).optional(),
  snapshot: SnapshotOutcomeSchema,
  result: z.unknown().optional(),
}).strict();

export interface JournalSnapshotOutcome {
  attempted: boolean;
  completed: boolean;
  error?: string;
}

export interface MutationJournalRecord {
  schemaVersion: 2;
  decisionDigest: string;
  requestId: string;
  idempotencyKey: string;
  state: "prepared" | "started" | "completed" | "outcome-unknown";
  preparedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  attemptedCommandIds: string[];
  completedCommandIds: string[];
  failingCommandId?: string;
  causalCode?: string;
  cause?: string;
  snapshot: JournalSnapshotOutcome;
  result?: IJson;
}

export interface JournalOutcomeEvidence {
  attemptedCommandIds: readonly string[];
  completedCommandIds: readonly string[];
  failingCommandId?: string;
  causalCode?: string;
  cause?: string;
  snapshot: JournalSnapshotOutcome;
}

export type JournalAdmission =
  | { action: "execute"; record: MutationJournalRecord }
  | { action: "return-completed"; record: MutationJournalRecord; result: IJson };

export class MutationJournal {
  constructor(
    readonly root = join(homedir(), ".ccp", "journal-v2"),
    private readonly resultMaxBytes = 512 * 1024,
  ) {
    ensurePrivateDirectory(root);
  }

  prepare(decisionDigest: string, requestId: string, idempotencyKey: string, nowMs = Date.now()): JournalAdmission {
    const path = this.recordPath(decisionDigest);
    const existing = this.read(path);
    if (existing) {
      if (existing.requestId !== requestId || existing.idempotencyKey !== idempotencyKey) {
        throw new CcpError("CCP_IDEMPOTENCY_CONFLICT", "Journal decision digest is bound to a different request.");
      }
      if (existing.state === "completed") {
        if (existing.result === undefined) throw new CcpError("CCP_INTERNAL", "Completed effect journal has no stored result.");
        return { action: "return-completed", record: existing, result: existing.result };
      }
      if (existing.state === "started" || existing.state === "outcome-unknown") {
        throw new CcpError("CCP_OUTCOME_UNKNOWN", "A previous effect may have begun and cannot be automatically retried.", {
          requestId,
          attemptedCommandIds: existing.attemptedCommandIds.join(","),
          completedCommandIds: existing.completedCommandIds.join(","),
          failingCommandId: existing.failingCommandId ?? "",
          causalCode: existing.causalCode ?? "",
          snapshotAttempted: existing.snapshot.attempted,
          snapshotCompleted: existing.snapshot.completed,
        });
      }
      return { action: "execute", record: existing };
    }

    const record: MutationJournalRecord = {
      schemaVersion: 2,
      decisionDigest,
      requestId,
      idempotencyKey,
      state: "prepared",
      preparedAtMs: nowMs,
      attemptedCommandIds: [],
      completedCommandIds: [],
      snapshot: { attempted: false, completed: false },
    };
    writePrivateJsonAtomic(path, record);
    return { action: "execute", record };
  }

  markStarted(decisionDigest: string, commandId?: string, nowMs = Date.now()): MutationJournalRecord {
    const path = this.recordPath(decisionDigest);
    const existing = this.read(path);
    if (!existing || existing.state !== "prepared") {
      if (existing?.state === "started" || existing?.state === "outcome-unknown") throw new CcpError("CCP_OUTCOME_UNKNOWN", "Effect journal is already in an ambiguous state.");
      throw new CcpError("CCP_INTERNAL", "Effect journal was not prepared before execution.");
    }
    const started: MutationJournalRecord = {
      ...existing,
      state: "started",
      startedAtMs: nowMs,
      attemptedCommandIds: commandId ? [commandId] : [],
    };
    writePrivateJsonAtomic(path, started);
    return started;
  }

  markCompleted(decisionDigest: string, result: unknown, evidence?: JournalOutcomeEvidence, nowMs = Date.now()): MutationJournalRecord {
    assertIJson(result);
    const resultBytes = canonicalizeToBytes(result);
    if (resultBytes.byteLength > this.resultMaxBytes) {
      throw new CcpError("CCP_RESULT_TOO_LARGE", "Effect result exceeds the durable journal limit.", { maxBytes: this.resultMaxBytes });
    }
    const path = this.recordPath(decisionDigest);
    const existing = this.read(path);
    if (!existing || existing.state !== "started") throw new CcpError("CCP_INTERNAL", "Effect journal was not started before completion.");
    const completed: MutationJournalRecord = {
      ...existing,
      state: "completed",
      completedAtMs: nowMs,
      result,
      attemptedCommandIds: [...(evidence?.attemptedCommandIds ?? existing.attemptedCommandIds)],
      completedCommandIds: [...(evidence?.completedCommandIds ?? existing.completedCommandIds)],
      snapshot: evidence?.snapshot ?? existing.snapshot,
    };
    writePrivateJsonAtomic(path, completed);
    return completed;
  }

  markOutcomeUnknown(decisionDigest: string, evidence: JournalOutcomeEvidence, nowMs = Date.now()): MutationJournalRecord {
    const path = this.recordPath(decisionDigest);
    const existing = this.read(path);
    if (!existing || (existing.state !== "started" && existing.state !== "outcome-unknown")) {
      throw new CcpError("CCP_INTERNAL", "Effect journal was not started before recording ambiguity.");
    }
    const ambiguous: MutationJournalRecord = {
      ...existing,
      state: "outcome-unknown",
      completedAtMs: nowMs,
      attemptedCommandIds: [...evidence.attemptedCommandIds],
      completedCommandIds: [...evidence.completedCommandIds],
      failingCommandId: evidence.failingCommandId,
      causalCode: evidence.causalCode,
      cause: evidence.cause?.slice(0, 1024),
      snapshot: evidence.snapshot,
    };
    writePrivateJsonAtomic(path, ambiguous);
    return ambiguous;
  }

  private recordPath(decisionDigest: string): string {
    if (!DIGEST_PATTERN.test(decisionDigest)) throw new TypeError("invalid decision digest");
    return join(this.root, `${decisionDigest}.json`);
  }

  private read(path: string): MutationJournalRecord | undefined {
    const value = readPrivateJson(path, this.resultMaxBytes + 32 * 1024);
    if (value === undefined) return undefined;
    const parsed = JournalSchema.parse(value);
    if (parsed.result !== undefined) assertIJson(parsed.result);
    return parsed as MutationJournalRecord;
  }
}
