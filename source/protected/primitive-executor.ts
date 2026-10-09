import { CcpError } from "./errors";
import { canonicalizeToBytes, type IJson } from "./canonical-json";
import { ExecutionEnvelope, ExecutionEnvelopeSchema, PrimitiveCommand, primitiveCommandSemantics } from "./primitive-contract";
import type { ProtectedRequest } from "./protocol";
import {
  preflightReferencedInputBytes, registerCommandHandle, resolveCommand,
  type HandleTable,
} from "./value-resolver";

export interface PrimitiveAdapters {
  invoke(command: PrimitiveCommand): Promise<unknown>;
  snapshot(mode: ExecutionEnvelope["transaction"]["snapshot"]): Promise<void>;
  recheckPreconditions(envelope: ExecutionEnvelope): Promise<void>;
  readIpcCount?: () => number;
}

export interface SnapshotOutcome {
  attempted: boolean;
  completed: boolean;
  error?: string;
}

export interface PrimitiveExecution {
  commandResults: Map<string, unknown>;
  handles: HandleTable;
  attemptedCommandIds: string[];
  executedCommandIds: string[];
  attemptedCommandId?: string;
  failingCommandId?: string;
  causalCode?: string;
  snapshotTaken: boolean;
  snapshotOutcome: SnapshotOutcome;
  ipcCount: number;
  referencedInputBytes: number;
}

export interface ExecutionOptions {
  publicConstants?: IJson;
  deadlineAtMs?: number;
  now?: () => number;
  onEffectAttempt?: (commandId: string) => void;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function causeCode(error: unknown): string {
  if (error instanceof CcpError) return error.body.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 64);
  return "CREATOR_IPC_REJECTED";
}

function deadlineError(afterEffectAttempt: boolean, details: Record<string, null | boolean | number | string>): CcpError {
  return new CcpError(
    afterEffectAttempt ? "CCP_OUTCOME_UNKNOWN" : "CCP_EXPIRED",
    afterEffectAttempt ? "The signed deadline elapsed after an effect may have begun." : "The signed deadline elapsed before an effect began.",
    details,
  );
}

async function beforeDeadline<T>(
  work: () => Promise<T>,
  deadlineAtMs: number,
  afterEffectAttempt: boolean,
  details: Record<string, null | boolean | number | string>,
  now: () => number,
): Promise<T> {
  const remaining = deadlineAtMs - now();
  if (remaining <= 0) throw deadlineError(afterEffectAttempt, details);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError(afterEffectAttempt, details)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertOutputBound(result: unknown, maxBytes: number, commandId: string): void {
  let bytes: number;
  try { bytes = canonicalizeToBytes(result).byteLength; }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Creator returned a non-canonical command result.", { commandId }); }
  if (bytes > maxBytes) throw new CcpError("CCP_RESULT_TOO_LARGE", "Creator command result exceeds the signed output limit.", { commandId, actualBytes: bytes, maxBytes });
}

export async function executeEnvelope(
  envelopeInput: unknown,
  adapters: PrimitiveAdapters,
  request: ProtectedRequest,
  options: ExecutionOptions = {},
): Promise<PrimitiveExecution> {
  let envelope: ExecutionEnvelope;
  try { envelope = ExecutionEnvelopeSchema.parse(envelopeInput); }
  catch { throw new CcpError("CCP_CONTRACT_MISMATCH", "Gateway envelope violates the finite primitive ABI."); }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAtMs = Math.min(options.deadlineAtMs ?? Number.MAX_SAFE_INTEGER, startedAt + envelope.limits.timeoutMs);
  if (deadlineAtMs <= startedAt) throw deadlineError(false, { phase: "preflight" });
  const publicConstants = options.publicConstants ?? {};
  const referencedInputBytes = preflightReferencedInputBytes(envelope, request, publicConstants);
  const commandResults = new Map<string, unknown>();
  const handles: HandleTable = new Map();
  const attemptedCommandIds: string[] = [];
  const executedCommandIds: string[] = [];
  const snapshotOutcome: SnapshotOutcome = { attempted: false, completed: false };
  let ipcCount = 0;

  // Resolve all request/observation/constants and prove handle ordering before any Creator IPC.
  const preflightHandles: HandleTable = new Map();
  for (const command of envelope.commands) {
    const placeholderHandles: HandleTable = new Map(preflightHandles);
    for (const handle of command.usesHandles) {
      if (!placeholderHandles.has(handle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Command references a handle that is not produced earlier.", { handle, commandId: command.commandId });
    }
    resolveCommand(command, request, publicConstants, placeholderHandles);
    if (command.createsHandle) {
      if (preflightHandles.has(command.createsHandle)) throw new CcpError("CCP_VALUE_PROVENANCE_INVALID", "Envelope creates a duplicate handle.", { handle: command.createsHandle });
      const semantics = primitiveCommandSemantics(command);
      const kind = command.op === "scene.addComponent" ? "component" : command.op.startsWith("asset.") ? "asset" : "node";
      preflightHandles.set(command.createsHandle, { id: `preflight:${command.createsHandle}`, type: `preflight:${semantics.createsHandle}`, kind });
    }
  }

  if (envelope.effect !== "none") {
    await beforeDeadline(() => adapters.recheckPreconditions(envelope), deadlineAtMs, false, { phase: "precondition" }, now);
  }

  for (const command of envelope.commands) {
    const resolved = resolveCommand(command, request, publicConstants, handles);
    primitiveCommandSemantics(resolved);
    if (envelope.effect !== "none" && attemptedCommandIds.length === 0) options.onEffectAttempt?.(command.commandId);
    attemptedCommandIds.push(command.commandId);
    const effectMayHaveBegun = envelope.effect !== "none";
    const expectedIpc = primitiveCommandSemantics(resolved).ipcCount;
    try {
      const ipcBefore = adapters.readIpcCount?.();
      const result = await beforeDeadline(
        () => adapters.invoke(resolved), deadlineAtMs, effectMayHaveBegun,
        { phase: "command", attemptedCommandId: command.commandId, attemptedCount: attemptedCommandIds.length, completedCount: executedCommandIds.length },
        now,
      );
      const actualIpc = ipcBefore === undefined || adapters.readIpcCount === undefined
        ? expectedIpc
        : adapters.readIpcCount() - ipcBefore;
      if (actualIpc !== expectedIpc) {
        throw new CcpError("CCP_CONTRACT_MISMATCH", "Creator adapter IPC count differs from the signed primitive contract.", {
          commandId: command.commandId, expected: expectedIpc, actual: actualIpc,
        });
      }
      ipcCount += actualIpc;
      if (ipcCount > envelope.limits.ipcCount) throw new CcpError("CCP_LIMIT_EXCEEDED", "Creator IPC count exceeds the signed limit.", { actual: ipcCount, max: envelope.limits.ipcCount });
      assertOutputBound(result, envelope.limits.outputBytes, command.commandId);
      registerCommandHandle(handles, resolved, result);
      commandResults.set(command.commandId, result);
      executedCommandIds.push(command.commandId);
    } catch (error) {
      let snapshotError: string | undefined;
      if (envelope.transaction.snapshot === "once-after-partial-failure") {
        snapshotOutcome.attempted = true;
        try {
          await beforeDeadline(() => adapters.snapshot(envelope.transaction.snapshot), deadlineAtMs, true, { phase: "snapshot", attemptedCommandId: command.commandId }, now);
          snapshotOutcome.completed = true;
          ipcCount += 1;
        } catch (snapshotFailure) {
          snapshotError = causeMessage(snapshotFailure);
          snapshotOutcome.error = snapshotError;
        }
      }
      const details = {
        attemptedCommandId: command.commandId,
        failingCommandId: command.commandId,
        attemptedCommandIds: attemptedCommandIds.join(","),
        executedCommandIds: executedCommandIds.join(","),
        causalCode: causeCode(error),
        cause: causeMessage(error).slice(0, 512),
        snapshotAttempted: snapshotOutcome.attempted,
        snapshotCompleted: snapshotOutcome.completed,
        ...(snapshotError ? { snapshotError: snapshotError.slice(0, 512) } : {}),
      };
      if (envelope.effect !== "none") throw new CcpError("CCP_OUTCOME_UNKNOWN", "Creator effect may have begun but did not durably complete.", details);
      if (error instanceof CcpError) throw error;
      throw new CcpError("CCP_PARTIAL_EXECUTION", "Primitive read execution stopped.", details);
    }
  }

  if (envelope.transaction.snapshot === "once-after-success") {
    snapshotOutcome.attempted = true;
    try {
      await beforeDeadline(() => adapters.snapshot(envelope.transaction.snapshot), deadlineAtMs, true, { phase: "snapshot", completedCount: executedCommandIds.length }, now);
      snapshotOutcome.completed = true;
      ipcCount += 1;
    } catch (error) {
      snapshotOutcome.error = causeMessage(error);
      throw new CcpError("CCP_OUTCOME_UNKNOWN", "Effect commands completed but the snapshot outcome is unknown.", {
        attemptedCommandIds: attemptedCommandIds.join(","),
        executedCommandIds: executedCommandIds.join(","),
        causalCode: causeCode(error),
        cause: causeMessage(error).slice(0, 512),
        snapshotAttempted: true,
        snapshotCompleted: false,
      });
    }
  }
  if (ipcCount !== envelope.limits.ipcCount) {
    throw new CcpError(envelope.effect === "none" ? "CCP_CONTRACT_MISMATCH" : "CCP_OUTCOME_UNKNOWN", "Actual Creator IPC count differs from the signed finite envelope.", { actual: ipcCount, expected: envelope.limits.ipcCount });
  }
  return {
    commandResults, handles, attemptedCommandIds, executedCommandIds,
    attemptedCommandId: attemptedCommandIds[attemptedCommandIds.length - 1],
    snapshotTaken: snapshotOutcome.completed,
    snapshotOutcome, ipcCount, referencedInputBytes,
  };
}
